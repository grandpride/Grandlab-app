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

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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

function die(msg) { console.error('\n  ' + msg + '\n'); process.exit(1); }
const log = (...a) => console.log(new Date().toLocaleTimeString('en-GB'), ...a);

/* ---------- wacli ---------- */

function wacli(args) {
  const full = (ACCOUNT ? ['--account', ACCOUNT] : []).concat(args);
  try {
    return execFileSync(WACLI, full, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    const err = (e.stderr || e.message || '').toString().trim();
    if (/ENOENT/.test(err) || e.code === 'ENOENT')
      die(`Could not run "${WACLI}". Install wacli, or set WACLI in .env to its full path.`);
    die('wacli failed:\n  ' + err.split('\n').slice(0, 6).join('\n  '));
  }
}

function listMessages(limit) {
  const raw = wacli(['--json', 'messages', 'list', '--limit', String(limit)]);
  let j;
  try { j = JSON.parse(raw); }
  catch { die('wacli did not return JSON. Run "node gl-wa-bridge.mjs probe" and send Claude the output.'); }
  // documented envelope is { data: { messages: [...] } }, but accept the obvious variants
  const arr = j?.data?.messages ?? j?.messages ?? j?.data ?? j;
  if (!Array.isArray(arr))
    die('Could not find the message list in wacli output. Run "probe" and send Claude the output.');
  return arr;
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
  const waId = pick(m, 'id', 'ID', 'message_id', 'messageId', 'key.id');
  const jid  = pick(m, 'chat_jid', 'chatJid', 'chat', 'chat.jid', 'jid', 'key.remoteJid', 'conversation');
  if (!waId || !jid) return null;

  const jidStr = String(jid);
  // 1:1 customer chats only. Groups, channels and status broadcasts are not leads.
  if (!/@s\.whatsapp\.net$|@lid$/.test(jidStr)) return null;

  const fromMe = !!(pick(m, 'from_me', 'fromMe', 'is_from_me', 'key.fromMe') ?? false);
  const body = String(
    pick(m, 'text', 'Text', 'body', 'message', 'caption', 'MediaCaption', 'content') ?? ''
  );
  const type = String(pick(m, 'type', 'msg_type', 'messageType', 'kind') ?? 'text').toLowerCase();
  const ts = toIso(pick(m, 'timestamp', 'ts', 'wa_ts', 'sent_at', 'time', 'date')) || new Date().toISOString();
  const name = pick(m, 'push_name', 'pushName', 'sender_name', 'senderName', 'chat_name', 'chatName', 'name', 'contact.name');

  return {
    wa_id: String(waId),
    chat_jid: jidStr,
    phone: jidStr.split('@')[0].replace(/[^0-9]/g, '') || null,
    name: name ? String(name) : null,
    direction: fromMe ? 'out' : 'in',
    sent_by: fromMe ? 'phone' : 'customer',
    msg_type: ['text', 'image', 'video', 'audio', 'document', 'sticker'].includes(type) ? type : 'text',
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
  const raw = listMessages(BATCH);
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

/* ---------- commands ---------- */

const cmd = (process.argv[2] || 'run').toLowerCase();

if (cmd === 'probe') {
  // Print exactly what wacli gives back, so the field mapping above can be
  // confirmed instead of assumed. Message text is cut short on purpose.
  const raw = wacli(['--json', 'messages', 'list', '--limit', '3']);
  let j; try { j = JSON.parse(raw); } catch { console.log(raw.slice(0, 4000)); process.exit(0); }
  const arr = j?.data?.messages ?? j?.messages ?? j?.data ?? j;
  const sample = Array.isArray(arr) ? arr.slice(0, 2) : arr;
  console.log('\nTop-level keys:', Object.keys(j || {}).join(', ') || '(none)');
  console.log('\nFirst messages as wacli returns them:\n');
  console.log(JSON.stringify(sample, (k, v) =>
    typeof v === 'string' && v.length > 120 ? v.slice(0, 120) + '…' : v, 2));
  console.log('\nHow this bridge reads them:\n');
  console.log(JSON.stringify((Array.isArray(arr) ? arr.slice(0, 2) : []).map(normalise), null, 2));
  console.log('\nSend the above to Claude to pin the mapping down exactly.\n');
  process.exit(0);
}

if (!['run', 'backfill'].includes(cmd)) die(`Unknown command "${cmd}". Use probe, backfill or run.`);

await login();
log('signed in to Grandlab');

if (cmd === 'backfill') {
  const r = await cycle(false);
  log(`read ${r.seen} messages from wacli → ${r.msgs} new, ${r.chats} chats updated`);
  log('done. Open the CRM board to see them.');
  process.exit(0);
}

log(`watching — checking every ${POLL}s. Leave this window open. Ctrl+C to stop.`);
let fails = 0;
for (;;) {
  try {
    const r = await cycle(true);
    if (r.msgs || r.chats) log(`${r.msgs} new message(s), ${r.chats} chat(s) updated`);
    fails = 0;
  } catch (e) {
    fails++;
    log('problem:', (e.message || e).toString().slice(0, 200));
    if (fails >= 10) { log('too many failures in a row — stopping so it is noticed.'); process.exit(1); }
  }
  await new Promise(r => setTimeout(r, POLL * 1000));
}
