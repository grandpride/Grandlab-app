#!/usr/bin/env node
/*
  gl-wa-bridge — takes WhatsApp messages out of wacli and puts them into the
  Grandlab database, so gl-crm.html shows live conversations.

  It does NOT send anything and it does NOT change WhatsApp. It reads what
  wacli has already synced and writes it to gl_wa_chat / gl_wa_msg.

      node gl-wa-bridge.mjs probe      show what wacli actually returns (run this first)
      node gl-wa-bridge.mjs backfill   import history once, then stop
      node gl-wa-bridge.mjs run        keep importing every POLL_SECONDS

  Settings come from a .env file beside this script. See .env.example.
  Nothing secret is written to the screen or to any log.
*/

import { spawnSync, spawn } from 'node:child_process';
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createTelegram } from './gl-wa-telegram.mjs';
import { createWatchdog } from './gl-wa-watchdog.mjs';
import { createPush } from './gl-wa-push.mjs';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/* ---------- settings ---------- */

function loadEnv() {
  const f = join(HERE, '.env');
  if (!existsSync(f)) die('No .env file. Copy .env.example to .env and fill it in.');
  const out = {};
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}
const ENV = loadEnv();
const SUPABASE_URL = (ENV.SUPABASE_URL || '').replace(/\/+$/, '');
const ANON  = ENV.SUPABASE_ANON || '';
const EMAIL = ENV.GL_EMAIL || '';
const PASS  = ENV.GL_PASSWORD || '';
const WACLI = ENV.WACLI || 'wacli';
const ACCOUNT = ENV.WACLI_ACCOUNT || '';
const POLL  = Math.max(10, Number(ENV.POLL_SECONDS || 30));
const BATCH = Math.max(1, Number(ENV.BATCH_LIMIT || 300));

for (const [k, v] of Object.entries({ SUPABASE_URL, SUPABASE_ANON: ANON, GL_EMAIL: EMAIL, GL_PASSWORD: PASS }))
  if (!v) die(`Missing ${k} in .env`);

function die(msg) { console.error('\n  ' + msg + '\n'); try{ logLine('STOPPED: '+msg); }catch(e){} process.exit(1); }

/* Also written to bridge-log.txt so a problem can be looked at afterwards
   instead of only existing in a console window somebody has closed. */
const LOGFILE = join(HERE, 'bridge-log.txt');
function logLine(s) {
  const line = new Date().toISOString().replace('T',' ').slice(0,19) + '  ' + s;
  try { appendFileSync(LOGFILE, line + '\n'); } catch (e) {}
}
const log = (...a) => {
  const s = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ');
  console.log(new Date().toLocaleTimeString('en-GB'), s);
  logLine(s);
};

/* ---------- wacli ---------- */

function wacli(args) {
  const full = (ACCOUNT ? ['--account', ACCOUNT] : []).concat(args);
  // wacli puts the data on stdout and its progress notes on stderr, including
  // the "repeat with --cursor ..." line used for paging. Both are needed, so
  // spawnSync rather than execFileSync, which only hands back stdout.
  const r = spawnSync(WACLI, full, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  if (r.error) {
    if (r.error.code === 'ENOENT')
      die(`Could not run "${WACLI}". Install wacli, or set WACLI in .env to its full path.`);
    die('Could not run wacli: ' + r.error.message);
  }
  if (r.status !== 0)
    die('wacli failed:\n  ' + String(r.stderr || '').trim().split('\n').slice(0, 6).join('\n  '));
  return { stdout: r.stdout || '', stderr: r.stderr || '' };
}

/* Returns { rows, cursor }. The cursor is only announced on stderr, so it is
   read back out of there rather than from the JSON envelope. */
function listMessages(limit, cursor) {
  const args = ['--json', 'messages', 'list', '--limit', String(limit)];
  if (cursor) args.push('--cursor', cursor);
  const { stdout, stderr } = wacli(args);
  let j;
  try { j = JSON.parse(stdout); }
  catch { die('wacli did not return JSON. Run "node gl-wa-bridge.mjs probe" and send Claude the output.'); }
  if (j && j.success === false)
    die('wacli reported an error: ' + JSON.stringify(j.error || '').slice(0, 300));
  const arr = j?.data?.messages ?? j?.messages ?? j?.data ?? j;
  if (!Array.isArray(arr))
    die('Could not find the message list in wacli output. Run "probe" and send Claude the output.');
  const m = /--cursor\s+(\S+)/.exec(stderr || '');
  return { rows: arr, cursor: m ? m[1] : null };
}

/* ---------- turning a wacli message into a Grandlab row ----------
   wacli's exact field names are not published, so each value is looked up
   under the names it plausibly uses. "probe" prints the real shape so this
   can be pinned down exactly rather than left guessing.                     */

const pick = (o, ...keys) => {
  for (const k of keys) {
    const v = k.split('.').reduce((x, p) => (x == null ? x : x[p]), o);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
};

function toIso(v) {
  if (v == null) return null;
  if (typeof v === 'number') return new Date(v > 1e12 ? v : v * 1000).toISOString();
  const d = new Date(v);
  return isNaN(d) ? null : d.toISOString();
}

function normalise(m) {
  // Confirmed against real wacli v0.26.1 output (probe, 23 Nov 2026): the keys
  // are PascalCase. Lower-case variants are kept as a fallback in case a later
  // version renames them.
  const waId = pick(m, 'MsgID', 'id', 'message_id', 'key.id');
  const jid  = pick(m, 'ChatJID', 'chat_jid', 'jid', 'key.remoteJid');
  if (!waId || !jid) return null;

  const jidStr = String(jid);
  // 1:1 customer chats only. Groups, channels and status broadcasts are not leads.
  if (!/@s\.whatsapp\.net$|@lid$/.test(jidStr)) return null;

  const fromMe = !!(pick(m, 'FromMe', 'from_me', 'key.fromMe') ?? false);

  /* Text is the message. MediaCaption is the caption on a photo or document.
     DisplayText is a UI placeholder — for a plain media message it is the
     literal "(message)", which is noise, so it is only used when it says
     something real. */
  const display = String(pick(m, 'DisplayText') ?? '').trim();
  const body = String(
    pick(m, 'Text', 'text', 'MediaCaption', 'caption', 'body') ??
    (display && display !== '(message)' ? display : '') ?? ''
  );

  // MediaType is "" for a normal text message.
  const media = String(pick(m, 'MediaType', 'type', 'msg_type') ?? '').toLowerCase();
  const type = ['image', 'video', 'audio', 'document', 'sticker'].includes(media) ? media : 'text';

  const ts = toIso(pick(m, 'Timestamp', 'timestamp', 'wa_ts')) || new Date().toISOString();

  /* ChatName, never SenderName. On a message the shop sent, SenderName is the
     shop's own WhatsApp name, and using it would rename the customer's chat to
     "Grandlab Detailing By Grandpride".

     When the number is not saved in the phone's contacts, ChatName comes back
     as the JID itself ("60142890081@s.whatsapp.net"). That is not a name, and
     because a chat's name is only ever filled in when blank, storing it would
     leave that rubbish on the card permanently. Leave it empty instead — the
     board falls back to the phone number, and a real name lands later if the
     contact is saved or the number matches a Grandlab customer. */
  const rawName = pick(m, 'ChatName', 'chat_name', 'PushName', 'push_name');
  const nameStr = rawName == null ? '' : String(rawName).trim();
  const name = (!nameStr || nameStr.includes('@') || /^\+?\d[\d\s-]*$/.test(nameStr))
    ? null : nameStr;

  return {
    wa_id: String(waId),
    chat_jid: jidStr,
    phone: jidStr.split('@')[0].replace(/[^0-9]/g, '') || null,
    name: name ? String(name) : null,
    direction: fromMe ? 'out' : 'in',
    sent_by: fromMe ? 'phone' : 'customer',
    msg_type: type,
    body,
    wa_ts: ts
  };
}

/* ---------- Supabase ---------- */

let TOKEN = null;
async function login() {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASS })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token)
    die('Could not sign in to Grandlab: ' + (j.error_description || j.msg || j.error || r.status) +
        '\n  Check GL_EMAIL and GL_PASSWORD in .env.');
  TOKEN = j.access_token;
}

async function api(path, { method = 'GET', body, prefer } = {}, retry = true) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: ANON,
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  if (r.status === 401 && retry) { await login(); return api(path, { method, body, prefer }, false); }
  const txt = await r.text();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${txt.slice(0, 300)}`);
  return txt ? JSON.parse(txt) : null;
}

/* ---------- the actual work ---------- */

async function push(rows) {
  if (!rows.length) return { msgs: 0, chats: 0 };

  // messages: wa_id is unique, so duplicates are simply ignored. Safe to re-run.
  const msgRows = rows.map(r => ({
    wa_id: r.wa_id, chat_jid: r.chat_jid, phone: r.phone, name: r.name,
    direction: r.direction, sent_by: r.sent_by, msg_type: r.msg_type,
    body: r.body, wa_ts: r.wa_ts
  }));
  const inserted = await api('gl_wa_msg?on_conflict=wa_id', {
    method: 'POST', body: msgRows,
    prefer: 'resolution=ignore-duplicates,return=representation'
  });
  const newCount = Array.isArray(inserted) ? inserted.length : 0;
  try { await PUSHER.onNew(inserted); } catch (e) { /* phone alerts must never stop the import */ }

  // one summary per chat from this batch
  const byChat = new Map();
  for (const r of rows) {
    const c = byChat.get(r.chat_jid) || { chat_jid: r.chat_jid, phone: r.phone, name: null, lastIn: null, lastOut: null, firstIn: null };
    if (r.name && !c.name) c.name = r.name;
    if (r.direction === 'in') {
      if (!c.lastIn  || r.wa_ts > c.lastIn)  c.lastIn = r.wa_ts;
      if (!c.firstIn || r.wa_ts < c.firstIn) c.firstIn = r.wa_ts;
    } else if (!c.lastOut || r.wa_ts > c.lastOut) c.lastOut = r.wa_ts;
    byChat.set(r.chat_jid, c);
  }

  // create any chat that is new. status defaults to 'talking' in the database,
  // and existing rows are left alone so stage / status / remark survive.
  await api('gl_wa_chat?on_conflict=chat_jid', {
    method: 'POST',
    body: [...byChat.values()].map(c => ({
      chat_jid: c.chat_jid, phone: c.phone, name: c.name,
      first_in_at: c.firstIn, last_in_at: c.lastIn, last_out_at: c.lastOut
    })),
    prefer: 'resolution=ignore-duplicates'
  });

  // then move only the fields that should move, and only forwards
  const jids = [...byChat.keys()];
  const inList = encodeURIComponent('(' + jids.map(j => `"${j}"`).join(',') + ')');
  const existing = await api(
    `gl_wa_chat?chat_jid=in.${inList}` +
    `&select=chat_jid,name,phone,first_in_at,last_in_at,last_out_at`
  );
  let touched = 0;
  for (const cur of existing || []) {
    const c = byChat.get(cur.chat_jid); if (!c) continue;
    const patch = {};
    if (c.lastIn  && (!cur.last_in_at  || c.lastIn  > cur.last_in_at))  patch.last_in_at  = c.lastIn;
    if (c.lastOut && (!cur.last_out_at || c.lastOut > cur.last_out_at)) patch.last_out_at = c.lastOut;
    if (c.firstIn && (!cur.first_in_at || c.firstIn < cur.first_in_at)) patch.first_in_at = c.firstIn;
    if (c.name && !cur.name) patch.name = c.name;        // never overwrite a name already there
    if (c.phone && !cur.phone) patch.phone = c.phone;
    if (!Object.keys(patch).length) continue;
    patch.updated_at = new Date().toISOString();
    await api(`gl_wa_chat?chat_jid=eq.${encodeURIComponent(cur.chat_jid)}`, { method: 'PATCH', body: patch });
    touched++;
  }
  return { msgs: newCount, chats: touched };
}

/* wacli always returns the most recent messages, so without a watermark every
   cycle would re-send the same few hundred rows. Keep a 5 minute overlap so a
   message that arrives slightly out of order is still picked up. */
let WATERMARK = null;
const OVERLAP_MS = 5 * 60 * 1000;

async function cycle(useWatermark) {
  const { rows: raw } = listMessages(BATCH);
  let rows = raw.map(normalise).filter(Boolean);
  const newest = rows.reduce((m, r) => (!m || r.wa_ts > m ? r.wa_ts : m), null);

  if (useWatermark && WATERMARK) {
    const cutoff = new Date(new Date(WATERMARK).getTime() - OVERLAP_MS).toISOString();
    rows = rows.filter(r => r.wa_ts > cutoff);
  }
  if (!rows.length) { if (newest) WATERMARK = newest; return { msgs: 0, chats: 0, seen: raw.length }; }

  const { msgs, chats } = await push(rows);
  if (newest && (!WATERMARK || newest > WATERMARK)) WATERMARK = newest;
  return { msgs, chats, seen: raw.length };
}

/* Backfill walks the whole local archive page by page, so the board starts
   with the real history rather than only the most recent few hundred. */
async function backfillAll() {
  let cursor = null, page = 0, seen = 0, msgs = 0, chats = 0;
  const MAX_PAGES = Number(ENV.MAX_PAGES || 200);
  for (;;) {
    const r = listMessages(BATCH, cursor);
    page++; seen += r.rows.length;
    const rows = r.rows.map(normalise).filter(Boolean);
    if (rows.length) {
      const got = await push(rows);
      msgs += got.msgs; chats += got.chats;
    }
    log(`page ${page}: read ${r.rows.length}, kept ${rows.length}, ${msgs} new so far`);
    if (!r.cursor || !r.rows.length) break;
    if (page >= MAX_PAGES) { log(`stopping at ${MAX_PAGES} pages — raise MAX_PAGES in .env to go further`); break; }
    cursor = r.cursor;
  }
  return { msgs, chats, seen, pages: page };
}

/* ---------- keeping wacli's local store fresh ----------

   This is the part that is easy to miss. "wacli auth" syncs once at pairing;
   after that the local store only moves forward while something is running
   "wacli sync --follow". This bridge reads that store, so without a live sync
   it happily reports "nothing new" forever while messages pile up on the
   phone. So the bridge runs the sync itself, as a child process, and brings
   it back if it dies.                                                        */

let SYNC = null, syncRestarts = 0;

function startSync() {
  if (SYNC) return;
  const args = (ACCOUNT ? ['--account', ACCOUNT] : []).concat(['sync', '--follow']);
  try {
    SYNC = spawn(WACLI, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    log('could not start the WhatsApp sync: ' + (e.message || e));
    SYNC = null;
    return;
  }
  log('WhatsApp sync started (keeps the local copy up to date)');

  const note = buf => {
    const t = String(buf).trim();
    if (t) logLine('sync: ' + t.split('\n').slice(-2).join(' | ').slice(0, 300));
  };
  SYNC.stdout.on('data', note);
  SYNC.stderr.on('data', note);

  SYNC.on('exit', code => {
    SYNC = null; syncRestarts++;
    log(`WhatsApp sync stopped (code ${code}). Restarting in 10s…`);
    if (syncRestarts > 50) { log('sync keeps dying — check "wacli auth" is still paired'); return; }
    setTimeout(startSync, 10000);
  });
}

function stopSync() { if (SYNC) { try { SYNC.kill(); } catch (e) {} SYNC = null; } }

/* ---------- sending replies ----------

   The board queues a reply in gl_wa_outbox; this sends it. Deliberately
   narrow, because this is the only part of the system that can make the
   shop's number say anything:

   - the database already refuses a row whose chat does not exist, so a reply
     can only ever go to somebody who messaged first. No cold outreach, which
     is the behaviour that gets numbers banned.
   - SEND_ENABLED must be on in .env. Off by default, so the bridge keeps
     working exactly as before until it is deliberately turned on.
   - a small number per cycle, spaced out, so it can never look like a blast.
   - a row is claimed before sending, so two bridges cannot send it twice.

   This is also why there is no "send to a phone number" path anywhere in
   here: the only thing it can do is answer an existing conversation.        */

const SEND_ENABLED = /^(1|true|yes|on)$/i.test(String(ENV.SEND_ENABLED || ''));
const SEND_MAX_PER_CYCLE = Math.max(1, Number(ENV.SEND_MAX_PER_CYCLE || 8));
const SEND_GAP_MS = Math.max(1000, Number(ENV.SEND_GAP_SECONDS || 4) * 1000);
const SEND_MAX_ATTEMPTS = 3;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function sendQueued() {
  if (!SEND_ENABLED) return { sent: 0, failed: 0 };

  const queued = await api(
    `gl_wa_outbox?status=eq.queued&attempts=lt.${SEND_MAX_ATTEMPTS}` +
    `&select=id,chat_jid,phone,body,attempts&order=created_at.asc&limit=${SEND_MAX_PER_CYCLE}`
  );
  if (!queued || !queued.length) return { sent: 0, failed: 0 };

  let sent = 0, failed = 0;
  for (const row of queued) {
    // claim it: only one bridge can move a row out of 'queued'
    const claimed = await api(
      `gl_wa_outbox?id=eq.${row.id}&status=eq.queued`,
      { method: 'PATCH',
        body: { status: 'sending', attempts: (row.attempts || 0) + 1 },
        prefer: 'return=representation' }
    );
    if (!Array.isArray(claimed) || !claimed.length) continue;   // someone else took it

    try {
      const to = row.chat_jid || row.phone;
      if (!to) throw new Error('no recipient on the row');
      // throwing, not die(): one bad message must never stop the bridge
      const r = spawnSync(WACLI, (ACCOUNT ? ['--account', ACCOUNT] : [])
        .concat(['send', 'text', '--to', String(to), '--message', String(row.body)]),
        { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      if (r.error) throw new Error(r.error.message);
      if (r.status !== 0) throw new Error(String(r.stderr || 'wacli exited ' + r.status).trim().split('\n')[0]);
      await api(`gl_wa_outbox?id=eq.${row.id}`, {
        method: 'PATCH', body: { status: 'sent', sent_at: new Date().toISOString(), error: null }
      });
      sent++;
      log(`sent to ${row.phone || row.chat_jid}`);
    } catch (e) {
      const msg = String(e && e.message || e).slice(0, 400);
      const done = (row.attempts || 0) + 1 >= SEND_MAX_ATTEMPTS;
      await api(`gl_wa_outbox?id=eq.${row.id}`, {
        method: 'PATCH', body: { status: done ? 'failed' : 'queued', error: msg }
      });
      failed++;
      log(`could not send to ${row.phone || row.chat_jid}: ${msg}`);
    }
    await sleep(SEND_GAP_MS);
  }
  return { sent, failed };
}

/* ---------- MIA + Telegram cards (off unless TELEGRAM_TOKEN is set) ----------
   Asks the same MIA function the CRM uses. Nothing here can send: approved
   drafts go through gl_wa_outbox and sendQueued() above, with all its limits. */

async function miaCall(messages, retry = true) {
  const r = await fetch(`${SUPABASE_URL}/functions/v1/mia`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON, Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ mode: 'coach', messages, stage: 'auto' }),
    signal: AbortSignal.timeout(90000)
  });
  if (r.status === 401 && retry) { await login(); return miaCall(messages, false); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || ('MIA request failed (' + r.status + ')'));
  return j;
}
const TG = createTelegram({
  env: ENV, api, log, miaCall,
  stateFile: join(HERE, 'telegram-state.json'),
  crmUrl: ENV.CRM_URL || 'https://app.grandlab.com.my/gl-crm.html'
});

/* quiet-bridge alert (Telegram). Read-only, wrapped, can never stop the import loop */
const WD = createWatchdog({
  env: ENV, api, log,
  stateFile: join(HERE, 'wa-watchdog-state.json'),
  tgStateFile: join(HERE, 'telegram-state.json')
});

const PUSHER = createPush({ env: ENV, api, log });

/* ---------- commands ---------- */

const cmd = (process.argv[2] || 'run').toLowerCase();

if (cmd === 'probe') {
  // Print exactly what wacli gives back, so the field mapping above can be
  // confirmed instead of assumed. Message text is cut short on purpose.
  const { stdout, stderr } = wacli(['--json', 'messages', 'list', '--limit', '5']);
  let j; try { j = JSON.parse(stdout); } catch { console.log(String(stdout).slice(0, 4000)); process.exit(0); }
  const arr = j?.data?.messages ?? j?.messages ?? j?.data ?? j;
  const list = Array.isArray(arr) ? arr : [];
  console.log('\nTop-level keys:', Object.keys(j || {}).join(', ') || '(none)');
  console.log('More pages available:', /--cursor\s+\S+/.test(stderr || '') ? 'yes' : 'no');
  console.log('\nFirst messages as wacli returns them:\n');
  console.log(JSON.stringify(list.slice(0, 2), (k, v) =>
    typeof v === 'string' && v.length > 120 ? v.slice(0, 120) + '…' : v, 2));
  console.log('\nHow this bridge reads them:\n');
  console.log(JSON.stringify(list.slice(0, 4).map(normalise), null, 2));
  const ok = list.map(normalise).filter(Boolean).length;
  console.log(`\nMapped ${ok} of ${list.length} (groups and status broadcasts are skipped on purpose).`);
  console.log(ok ? 'Mapping looks good.\n' : 'Nothing mapped — send this to Claude.\n');
  process.exit(0);
}

if (!['run', 'backfill'].includes(cmd)) die(`Unknown command "${cmd}". Use probe, backfill or run.`);

await login();
log('signed in to Grandlab');

if (cmd === 'backfill') {
  /* A one-shot sync, but never an open-ended one. Some versions of wacli keep
     running here, and a backfill that hangs forever looks identical to a
     broken install. If it has not finished in time, carry on and import what
     is already in the local store - "run" keeps a live sync going anyway, so
     nothing is lost by not waiting. */
  const SYNC_WAIT = Math.max(15, Number(ENV.SYNC_TIMEOUT_SECONDS || 90));
  log(`syncing from WhatsApp first (up to ${SYNC_WAIT}s)…`);
  const sy = spawnSync(WACLI, (ACCOUNT ? ['--account', ACCOUNT] : []).concat(['sync']),
                       { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
                         timeout: SYNC_WAIT * 1000, killSignal: 'SIGKILL' });
  if (sy.error && sy.error.code === 'ETIMEDOUT')
    log('sync still running after the wait — importing what is here already; the live sync in "run" will catch the rest');
  else if (sy.status !== 0)
    log('sync warning: ' + String(sy.stderr || '').trim().split('\n')[0]);
  else
    log('sync done');
  const r = await backfillAll();
  log(`finished: ${r.pages} page(s), ${r.seen} messages read → ${r.msgs} new, ${r.chats} chats updated`);
  log('done. Open the CRM board to see them.');
  process.exit(0);
}

startSync();
TG.start();
process.on('SIGINT', () => { stopSync(); log('stopped by user'); process.exit(0); });
log(`watching — checking every ${POLL}s. Leave this window open. Ctrl+C to stop.`);
log(SEND_ENABLED
  ? `replies from the CRM board are ON (max ${SEND_MAX_PER_CYCLE} per cycle, ${SEND_GAP_MS/1000}s apart)`
  : 'replies from the CRM board are OFF — set SEND_ENABLED=1 in .env to turn them on');
let fails = 0;
for (;;) {
  try {
    const r = await cycle(true);
    if (r.msgs || r.chats) log(`${r.msgs} new message(s), ${r.chats} chat(s) updated`);
    await sendQueued();
    fails = 0;
    // Telegram trouble is logged and ignored: it must never stop the WhatsApp import
    try { await TG.tick(); } catch (e) { log('telegram check failed:', (e.message || e).toString().slice(0, 160)); }
    try { await WD.tick(); } catch (e) { /* never stops the import */ }
  } catch (e) {
    fails++;
    log('problem:', (e.message || e).toString().slice(0, 200));
    if (fails >= 10) { log('too many failures in a row — stopping so it is noticed.'); process.exit(1); }
  }
  await new Promise(r => setTimeout(r, POLL * 1000));
}
