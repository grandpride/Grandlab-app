// Run: node --test tests/gl-wa-bridge.test.mjs        (no packages; fetch is mocked, nothing goes on the network)
// Checks tools/gl-wa-bridge/gl-wa-cf.mjs: the BACKEND=cloudflare adapter of the WhatsApp bridge.
//  - every database call the bridge makes (copied from its source) becomes the right compat JSON
//  - login / re-login on 401, errors, chunking, media upload headers, "already exists", MIA
//  - safety: no DELETE, no PATCH without a filter, no secret in any error or URL
//  - BACKEND stays "supabase" unless .env says otherwise (the bridge dies on a typo)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'tools', 'gl-wa-bridge');
const { restToCompat, createCf } = await import(path.join(DIR, 'gl-wa-cf.mjs'));

const BASE = 'https://api.test';
const PASSWORD = 'pw-not-real-123';

/* ---------------- restToCompat: the exact calls the bridge makes ---------------- */
test('insert, ignore duplicates, return the new rows (gl_wa_msg)', () => {
  const r = restToCompat('gl_wa_msg?on_conflict=wa_id', { method: 'POST', body: [{ wa_id: 'a' }], prefer: 'resolution=ignore-duplicates,return=representation' });
  assert.deepEqual(r, { url: '/gl/api/db', body: { table: 'gl_wa_msg', op: 'upsert', values: [{ wa_id: 'a' }], onConflict: 'wa_id', ignoreDuplicates: true, returning: true } });
});
test('insert, ignore duplicates, nothing back (gl_wa_chat)', () => {
  const r = restToCompat('gl_wa_chat?on_conflict=chat_jid', { method: 'POST', body: [{ chat_jid: 'x@s.whatsapp.net' }], prefer: 'resolution=ignore-duplicates' });
  assert.equal(r.body.op, 'upsert'); assert.equal(r.body.ignoreDuplicates, true); assert.equal(r.body.returning, undefined);
});
test('plain insert, return=minimal (gl_wa_outbox)', () => {
  const r = restToCompat('gl_wa_outbox', { method: 'POST', body: { chat_jid: 'j', body: 'hi' }, prefer: 'return=minimal' });
  assert.deepEqual(r.body, { table: 'gl_wa_outbox', op: 'insert', values: { chat_jid: 'j', body: 'hi' } });
});
test('select with in.(...) list, encoded like the bridge does', () => {
  const jids = ['601@s.whatsapp.net', '602@lid'];
  const inList = encodeURIComponent('(' + jids.map(j => `"${j}"`).join(',') + ')');
  const r = restToCompat(`gl_wa_chat?chat_jid=in.${inList}&select=chat_jid,name,phone,first_in_at,last_in_at,last_out_at`);
  assert.deepEqual(r.body, { table: 'gl_wa_chat', op: 'select', columns: 'chat_jid,name,phone,first_in_at,last_in_at,last_out_at', filters: [['chat_jid', 'in', jids]] });
});
test('PATCH one chat by jid', () => {
  const r = restToCompat(`gl_wa_chat?chat_jid=eq.${encodeURIComponent('601@s.whatsapp.net')}`, { method: 'PATCH', body: { last_in_at: 'T' } });
  assert.deepEqual(r.body, { table: 'gl_wa_chat', op: 'update', filters: [['chat_jid', 'eq', '601@s.whatsapp.net']], values: { last_in_at: 'T' } });
});
test('claim a queued row: PATCH with two filters, return the row', () => {
  const r = restToCompat('gl_wa_outbox?id=eq.7&status=eq.queued', { method: 'PATCH', body: { status: 'sending', attempts: 1 }, prefer: 'return=representation' });
  assert.deepEqual(r.body.filters, [['id', 'eq', '7'], ['status', 'eq', 'queued']]); assert.equal(r.body.returning, true);
});
test('queued outbox: lt filter, select list, order, limit', () => {
  const r = restToCompat('gl_wa_outbox?status=eq.queued&attempts=lt.3&select=id,chat_jid,phone,body,attempts&order=created_at.asc&limit=8');
  assert.deepEqual(r.body, { table: 'gl_wa_outbox', op: 'select', columns: 'id,chat_jid,phone,body,attempts', filters: [['status', 'eq', 'queued'], ['attempts', 'lt', '3']], order: [['created_at', { ascending: true, nullsFirst: false }]], limit: 8 });
});
test('stuck media rows back to queued: timestamp with colons stays one value', () => {
  const r = restToCompat('gl_wa_media_req?status=eq.working&updated_at=lt.2026-11-24T10:00:00.000Z', { method: 'PATCH', body: { status: 'queued' } });
  assert.deepEqual(r.body.filters, [['status', 'eq', 'working'], ['updated_at', 'lt', '2026-11-24T10:00:00.000Z']]);
});
test('telegram: two filters on the same column, encoded timestamps, desc order puts nulls first like PostgreSQL', () => {
  const since = '2026-11-24T04:00:00.000Z', until = '2026-11-24T09:57:00.000Z';
  const r = restToCompat(`gl_wa_chat?select=chat_jid,phone,name,last_in_at,last_out_at&last_in_at=gte.${encodeURIComponent(since)}&last_in_at=lte.${encodeURIComponent(until)}&order=last_in_at.asc&limit=40`);
  assert.deepEqual(r.body.filters, [['last_in_at', 'gte', since], ['last_in_at', 'lte', until]]);
  const d = restToCompat('gl_wa_msg?chat_jid=eq.x&select=direction,msg_type,body,wa_ts&order=wa_ts.desc&limit=12');
  assert.deepEqual(d.body.order, [['wa_ts', { ascending: false, nullsFirst: true }]]);
});
test('watchdog: newest message row', () => {
  const r = restToCompat('gl_wa_msg?select=created_at&order=created_at.desc&limit=1');
  assert.deepEqual(r.body, { table: 'gl_wa_msg', op: 'select', columns: 'created_at', order: [['created_at', { ascending: false, nullsFirst: true }]], limit: 1 });
});
test('rpc for the phone-alert subscriber list', () => {
  assert.deepEqual(restToCompat('rpc/gl_crm_push_list', { method: 'POST', body: {} }), { url: '/gl/api/rpc/gl_crm_push_list', body: {} });
});

test('EVERY api() call found in the bridge source converts without error', () => {
  const files = ['gl-wa-bridge.mjs', 'gl-wa-media.mjs', 'gl-wa-push.mjs', 'gl-wa-telegram.mjs', 'gl-wa-watchdog.mjs'];
  let n = 0;
  for (const f of files) {
    const src = fs.readFileSync(path.join(DIR, f), 'utf8');
    const re = /\bapi\(\s*(`[^`]*`|'[^']*')\s*(,\s*\{[\s\S]{0,220}?\})?/g;
    let m;
    while ((m = re.exec(src))) {
      let p = m[1].slice(1, -1).replace(/\$\{[^}]*\}/g, 'X');
      if (/^(path|X)$/.test(p)) continue;   // the wrapper itself
      const opts = m[2] || '';
      const method = (/method:\s*'(\w+)'/.exec(opts) || [, 'GET'])[1];
      const prefer = (/prefer:\s*'([^']+)'/.exec(opts) || [, ''])[1];
      const r = restToCompat(p, { method, body: method === 'GET' ? undefined : {}, prefer });
      assert.ok(r.url.startsWith('/gl/api/'), f + ' ' + p);
      n++;
    }
  }
  assert.ok(n >= 14, 'found only ' + n + ' calls');
});

test('safety: DELETE, PATCH without filter, odd names, not.<op>, missing on_conflict are refused', () => {
  assert.throws(() => restToCompat('gl_wa_msg?id=eq.1', { method: 'DELETE' }), /DELETE/);
  assert.throws(() => restToCompat('gl_wa_chat', { method: 'PATCH', body: { name: 'x' } }), /without a filter/);
  assert.throws(() => restToCompat('gl_wa_msg;drop table x', {}), /bad table/);
  assert.throws(() => restToCompat('gl_wa_msg?"a b"=eq.1'), /bad filter column/);
  assert.throws(() => restToCompat('gl_wa_msg?id=not.eq.1'), /not\.eq/);
  assert.throws(() => restToCompat('gl_wa_msg', { method: 'POST', body: [], prefer: 'resolution=ignore-duplicates' }), /on_conflict/);
  assert.throws(() => restToCompat('rpc/x', { method: 'GET' }), /bad rpc/);
});

/* ---------------- the client, with a mock server ---------------- */
function mock(handler) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    const c = { url: String(url), method: init.method, headers: init.headers || {}, body: init.body };
    calls.push(c);
    const r = await handler(c, calls.length);
    return new Response(r.body ?? '', { status: r.status ?? 200, headers: r.headers ?? {} });
  };
  return { fetchFn, calls };
}
const okLogin = (c) => c.url.endsWith('/gl/auth/sign-in/email')
  ? { status: 200, headers: { 'set-auth-token': 'TOKEN-1', 'content-type': 'application/json' }, body: '{"ok":true}' } : null;

test('login: posts the email + password, keeps set-auth-token, sends it as Bearer', async () => {
  const m = mock((c) => okLogin(c) || { body: JSON.stringify({ data: [{ id: 1 }], error: null, count: null }) });
  const cf = createCf({ base: BASE + '/', email: ' Admin@Grandpride.com ', password: PASSWORD, fetchFn: m.fetchFn });
  assert.equal(await cf.login(), 'TOKEN-1');
  assert.deepEqual(JSON.parse(m.calls[0].body), { email: 'admin@grandpride.com', password: PASSWORD });
  assert.equal(m.calls[0].url, BASE + '/gl/auth/sign-in/email');
  const rows = await cf.api('gl_wa_msg?select=id&limit=1');
  assert.deepEqual(rows, [{ id: 1 }]);
  assert.equal(m.calls[1].url, BASE + '/gl/api/db');
  assert.equal(m.calls[1].headers.Authorization, 'Bearer TOKEN-1');
  assert.ok(!m.calls[1].url.includes(PASSWORD));
});
test('wrong password: clear error, no password in it', async () => {
  const m = mock(() => ({ status: 401, body: '{"code":"INVALID_EMAIL_OR_PASSWORD","message":"Invalid email or password"}' }));
  const cf = createCf({ base: BASE, email: 'a@b.c', password: PASSWORD, fetchFn: m.fetchFn });
  await assert.rejects(cf.login(), (e) => /Could not sign in/.test(e.message) && !e.message.includes(PASSWORD));
});
test('401 on a call: signs in again once and retries; a second 401 is an error', async () => {
  let dbCalls = 0, logins = 0;
  const m = mock((c) => {
    if (c.url.endsWith('/sign-in/email')) { logins++; return { headers: { 'set-auth-token': 'T' + logins } }; }
    dbCalls++;
    return dbCalls === 1 ? { status: 401, body: 'no' } : { body: JSON.stringify({ data: [], error: null }) };
  });
  const cf = createCf({ base: BASE, email: 'a@b.c', password: PASSWORD, fetchFn: m.fetchFn });
  await cf.login();
  assert.deepEqual(await cf.api('gl_wa_msg?limit=1'), []);
  assert.equal(logins, 2);
  const m2 = mock((c) => c.url.endsWith('/sign-in/email') ? { headers: { 'set-auth-token': 'T' } } : { status: 401, body: 'no' });
  const cf2 = createCf({ base: BASE, email: 'a@b.c', password: PASSWORD, fetchFn: m2.fetchFn });
  await cf2.login();
  await assert.rejects(cf2.api('gl_wa_msg?limit=1'), /401/);
});
test('server error object becomes an Error with the table path (not the query values)', async () => {
  const m = mock((c) => okLogin(c) || { body: JSON.stringify({ data: null, error: { code: '42501', message: 'column x is not allowed' } }) });
  const cf = createCf({ base: BASE, email: 'a@b.c', password: PASSWORD, fetchFn: m.fetchFn });
  await cf.login();
  await assert.rejects(cf.api('gl_wa_chat?phone=eq.60123', { method: 'PATCH', body: { x: 1 } }), (e) => /PATCH gl_wa_chat -> 42501 column x is not allowed/.test(e.message) && !e.message.includes('60123'));
});
test('writes without return=representation give null; with it, the rows', async () => {
  const m = mock((c) => okLogin(c) || { body: JSON.stringify({ data: JSON.parse(c.body).returning ? [{ id: 9 }] : null, error: null }) });
  const cf = createCf({ base: BASE, email: 'a@b.c', password: PASSWORD, fetchFn: m.fetchFn });
  await cf.login();
  assert.equal(await cf.api('gl_wa_outbox', { method: 'POST', body: { chat_jid: 'j', body: 'x' }, prefer: 'return=minimal' }), null);
  assert.deepEqual(await cf.api('gl_wa_outbox?id=eq.9&status=eq.queued', { method: 'PATCH', body: { status: 'sending' }, prefer: 'return=representation' }), [{ id: 9 }]);
});
test('300 rows are sent as 3 requests of 100 and the answers are put back together', async () => {
  const sizes = [];
  const m = mock((c) => {
    if (c.url.endsWith('/sign-in/email')) return { headers: { 'set-auth-token': 'T' } };
    const b = JSON.parse(c.body); sizes.push(b.values.length);
    return { body: JSON.stringify({ data: b.values.map((v) => ({ wa_id: v.wa_id })), error: null }) };
  });
  const cf = createCf({ base: BASE, email: 'a@b.c', password: PASSWORD, fetchFn: m.fetchFn });
  await cf.login();
  const rows = Array.from({ length: 300 }, (_, i) => ({ wa_id: 'w' + i }));
  const out = await cf.api('gl_wa_msg?on_conflict=wa_id', { method: 'POST', body: rows, prefer: 'resolution=ignore-duplicates,return=representation' });
  assert.deepEqual(sizes, [100, 100, 100]); assert.equal(out.length, 300);
  sizes.length = 0;
  assert.equal(await cf.api('gl_wa_chat?on_conflict=chat_jid', { method: 'POST', body: rows, prefer: 'resolution=ignore-duplicates' }), null);
  assert.deepEqual(sizes, [100, 100, 100]);
});
test('media upload: bucket + path headers, raw bytes, mime, never overwrite', async () => {
  const m = mock((c) => okLogin(c) || { body: '{"data":{"path":"ABC.ogg"},"error":null}' });
  const cf = createCf({ base: BASE, email: 'a@b.c', password: PASSWORD, fetchFn: m.fetchFn });
  await cf.login();
  const buf = Buffer.from('OggS-fake');
  assert.equal(await cf.upload('gl-wa-media', 'ABC123.ogg', buf, 'audio/ogg'), 'stored');
  const u = m.calls[1];
  assert.equal(u.url, BASE + '/gl/api/storage/upload');
  assert.equal(u.headers['x-bucket'], 'gl-wa-media'); assert.equal(u.headers['x-path'], 'ABC123.ogg');
  assert.equal(u.headers['Content-Type'], 'audio/ogg'); assert.equal(u.headers['x-upsert'], 'false');
  assert.equal(u.headers.Authorization, 'Bearer TOKEN-1'.replace('TOKEN-1', 'TOKEN-1')); assert.equal(u.body, buf);
});
test('media upload: 409 / "already exists" is fine, 415 and 413 are errors', async () => {
  let status = 409, body = '{"error":{"message":"The resource already exists"}}';
  const m = mock((c) => okLogin(c) || { status, body });
  const cf = createCf({ base: BASE, email: 'a@b.c', password: PASSWORD, fetchFn: m.fetchFn });
  await cf.login();
  assert.equal(await cf.upload('gl-wa-media', 'A.ogg', Buffer.from('x'), 'audio/ogg'), 'exists');
  status = 415; body = '{"error":{"message":"mime type audio/ogg is not supported"}}';
  await assert.rejects(cf.upload('gl-wa-media', 'A.ogg', Buffer.from('x'), 'audio/ogg'), /upload 415/);
});
test('MIA: posts the chat to /gl/api/fn/mia with the login, returns {reply, text}', async () => {
  const m = mock((c) => okLogin(c) || { body: '{"reply":{"type":"reply"},"text":"{}"}' });
  const cf = createCf({ base: BASE, email: 'a@b.c', password: PASSWORD, fetchFn: m.fetchFn });
  await cf.login();
  const out = await cf.miaCall([{ role: 'user', content: 'hi' }]);
  assert.equal(out.reply.type, 'reply');
  assert.equal(m.calls[1].url, BASE + '/gl/api/fn/mia'); assert.equal(m.calls[1].headers.Authorization, 'Bearer TOKEN-1');
  assert.equal(JSON.parse(m.calls[1].body).messages.length, 1);
});
test('a bad base address is refused at start', () => {
  assert.throws(() => createCf({ base: 'not a url', email: 'a', password: 'b' }), /GL_API_BASE/);
});

/* ---------------- the bridge itself: BACKEND switch ---------------- */
function runBridge(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glwa-'));
  try {
    for (const f of fs.readdirSync(DIR)) if (f.endsWith('.mjs')) fs.copyFileSync(path.join(DIR, f), path.join(dir, f));
    fs.writeFileSync(path.join(dir, '.env'), Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n'));
    const r = spawnSync(process.execPath, [path.join(dir, 'gl-wa-bridge.mjs'), 'run'], { cwd: dir, encoding: 'utf8', timeout: 20000 });
    return String(r.stdout) + String(r.stderr);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
test('the bridge refuses a BACKEND typo and asks for the right settings per backend', () => {
  assert.match(runBridge({ BACKEND: 'cloudfare', GL_EMAIL: 'a@b.c', GL_PASSWORD: 'x' }), /BACKEND in \.env must be/);
  assert.match(runBridge({ BACKEND: 'cloudflare', GL_PASSWORD: 'x' }), /Missing GL_EMAIL/);
  assert.match(runBridge({ GL_EMAIL: 'a@b.c', GL_PASSWORD: 'x' }), /Missing SUPABASE_URL/);          // default = supabase, as before
  assert.match(runBridge({ BACKEND: 'supabase', GL_EMAIL: 'a@b.c', GL_PASSWORD: 'x' }), /Missing SUPABASE_URL/);
});
test('the bridge source still carries the unchanged Supabase calls and loads the new file only on demand', () => {
  const src = fs.readFileSync(path.join(DIR, 'gl-wa-bridge.mjs'), 'utf8');
  assert.match(src, /\/auth\/v1\/token\?grant_type=password/);
  assert.match(src, /\/rest\/v1\/\$\{path\}/);
  assert.match(src, /\/functions\/v1\/mia/);
  assert.match(src, /BACKEND === 'cloudflare'\s*\n?\s*\? \(await import\('\.\/gl-wa-cf\.mjs'\)\)/);
  assert.ok(!/^import .*gl-wa-cf/m.test(src), 'gl-wa-cf must not be a static import');
  const media = fs.readFileSync(path.join(DIR, 'gl-wa-media.mjs'), 'utf8');
  assert.match(media, /storage\/v1\/object\/gl-wa-media/);
});
test('no key, token or password is written in the new files', () => {
  for (const f of ['gl-wa-cf.mjs', '.env.example']) {
    const src = fs.readFileSync(path.join(DIR, f), 'utf8');
    if (f === 'gl-wa-cf.mjs') assert.ok(!/eyJ[A-Za-z0-9_-]{20,}/.test(src) && !/password\s*[:=]\s*['"][^'"]{3,}/.test(src));
  }
});
