// Run: node --test tests/gl-cf-client.test.mjs          (no packages needed)
// Checks gl-cf-client.js: the exact JSON sent for the query shapes the switched Grandlab pages use, the
// customer SMS login (supabase-js style and the PWA's direct /auth/v1 calls), anonymous (public) reads,
// client-side embeds, realtime polling, storage, and — automatically — EVERY supabase-js call and every
// direct REST fetch found in the wired pages. fetch is mocked; nothing goes on the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ---------- fake browser bits ---------- */
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};
const warnings = [];
console.warn = (...a) => { warnings.push(a.join(' ')); };

const require = createRequire(import.meta.url);
const GLCF = require('../gl-cf-client.js');

const API = 'https://api.test';
const SB = 'https://db.grandlab.com.my';
const ANON = 'anon.key.jwt';
let calls = [];
let replies = [];   // queue of {status, json, headers}
function reply(json, status = 200, headers = {}) { replies.push({ status, json, headers }); }
function mockFetch(url, init) {
  let body;
  if (typeof init.body === 'string') { try { body = JSON.parse(init.body); } catch { body = init.body; } } else body = init.body;
  calls.push({ url, init, body });
  const r = replies.shift() || { status: 200, json: { data: [], error: null, count: null }, headers: {} };
  const h = Object.fromEntries(Object.entries(r.headers).map(([k, v]) => [k.toLowerCase(), v]));
  return Promise.resolve({
    ok: r.status >= 200 && r.status < 300, status: r.status, statusText: r.status === 200 ? 'OK' : 'ERR',
    headers: { get: (k) => (k.toLowerCase() in h ? h[k.toLowerCase()] : null) },
    json: () => (r.json === undefined ? Promise.reject(new Error('no body')) : Promise.resolve(r.json)),
    blob: () => Promise.resolve(r.blob),
  });
}
function fresh(o = {}) {
  calls = []; replies = []; warnings.length = 0; store.clear();
  return GLCF.createClient(Object.assign({ apiBase: API, fetch: mockFetch, sessionCacheMs: 0 }, o));
}
function signedIn(o) { const c = fresh(o); store.set((o && o.storageKey) || 'gl_ba_token', 'tok.sig'); return c; }
const dbBody = () => { assert.equal(calls.length, 1, 'one request'); assert.equal(calls[0].url, API + '/gl/api/db'); return calls[0].body; };
const BA_USER = { id: '9684de35-a49c-4630-b02b-a1deb8d52e6f', email: '60123456789@phone.grandlab.invalid', name: '+60123456789', phoneNumber: '+60123456789', phoneNumberVerified: true, emailVerified: false, role: 'customer', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-11-21T00:00:00.000Z' };
const SESS = { token: 'raw', expiresAt: '2026-12-21T00:00:00.000Z', userId: BA_USER.id };

/* =================== switch + phone normalisation =================== */
test('switch: off by default, ?backend=cf turns on, ?backend=sb turns off (key gl_backend)', () => {
  store.clear();
  assert.equal(GLCF.enabled(), false);
  assert.equal(GLCF.applyUrlSwitch('?x=1'), false);
  assert.equal(GLCF.applyUrlSwitch('?backend=cf'), true);
  assert.equal(store.get('gl_backend'), 'cf');
  assert.equal(GLCF.applyUrlSwitch('?a=1&backend=sb'), false);
  assert.equal(store.has('gl_backend'), false);
  assert.equal(GLCF.applyUrlSwitch('?backend=cfx'), false);
  assert.equal(store.has('gp_backend'), false, 'never touches the Grandpride switch');
});
test('normalizePhone: Malaysian numbers -> +60…', () => {
  const n = GLCF.normalizePhone;
  assert.equal(n('0123456789'), '+60123456789');
  assert.equal(n('012-345 6789'), '+60123456789');
  assert.equal(n('01112345678'), '+601112345678');
  assert.equal(n('60123456789'), '+60123456789');
  assert.equal(n('123456789'), '+60123456789');
  assert.equal(n('+60 12-345 6789'), '+60123456789');
  assert.equal(n('+60123456789'), '+60123456789');   // what index.html sends ("+60"+local)
  assert.equal(n('+6591234567'), '+6591234567');     // kept; the server refuses non-+60
  assert.equal(n(''), '');
});

/* =================== customer SMS login (supabase-js style) =================== */
test('phone OTP: signInWithOtp({phone}) -> /gl/auth/phone-number/send-otp with +60 number, no token', async () => {
  const sb = fresh();
  reply({ message: 'code sent' });
  const r = await sb.auth.signInWithOtp({ phone: '012-345 6789' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, API + '/gl/auth/phone-number/send-otp');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(calls[0].body, { phoneNumber: '+60123456789' });
  assert.equal(calls[0].init.headers.Authorization, undefined);
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(r.error, null);
  assert.deepEqual(r.data, { user: null, session: null, messageId: null });
});
test('phone OTP: send-otp errors come back as AuthApiError (429 rate limit / 400 not +60)', async () => {
  const sb = fresh();
  reply({ code: 'TOO_MANY_REQUESTS', message: 'Too many requests' }, 429);
  let r = await sb.auth.signInWithOtp({ phone: '0123456789' });
  assert.equal(r.error.status, 429);
  assert.equal(r.error.message, 'Too many requests');
  reply({ code: 'INVALID_PHONE_NUMBER', message: 'Invalid phone number' }, 400);
  r = await sb.auth.signInWithOtp({ phone: '+6591234567' });
  assert.equal(r.error.code, 'INVALID_PHONE_NUMBER');
});
test('phone OTP: WhatsApp channel is not supported (no request)', async () => {
  const sb = fresh();
  const r = await sb.auth.signInWithOtp({ phone: '0123456789', options: { channel: 'whatsapp' } });
  assert.equal(calls.length, 0);
  assert.equal(r.error.code, 'CF_UNSUPPORTED');
});
test('phone OTP: verifyOtp({phone,token,type:sms}) -> /phone-number/verify, keeps set-auth-token, returns a session', async () => {
  const sb = fresh();
  const events = [];
  sb.auth.onAuthStateChange((e) => events.push(e));
  await new Promise((r) => setTimeout(r, 5));
  reply({ status: true, token: 'raw', user: BA_USER }, 200, { 'set-auth-token': 'raw.SIGNED' });
  reply({ session: SESS, user: BA_USER });
  const r = await sb.auth.verifyOtp({ phone: '0123456789', token: ' 123456 ', type: 'sms' });
  assert.equal(calls[0].url, API + '/gl/auth/phone-number/verify');
  assert.deepEqual(calls[0].body, { phoneNumber: '+60123456789', code: '123456' });
  assert.equal(calls[1].url, API + '/gl/auth/get-session');
  assert.equal(calls[1].init.headers.Authorization, 'Bearer raw.SIGNED');
  assert.equal(store.get('gl_ba_token'), 'raw.SIGNED');
  assert.equal(r.error, null);
  assert.equal(r.data.session.access_token, 'raw.SIGNED');
  assert.equal(r.data.session.expires_at, Math.floor(Date.parse(SESS.expiresAt) / 1000));
  assert.equal(r.data.user.id, BA_USER.id, 'same UUID as Supabase');
  assert.equal(r.data.user.phone, '60123456789', 'digits only, like Supabase');
  assert.equal(r.data.user.email, '', 'placeholder email hidden, like a Supabase phone user');
  assert.equal(r.data.user.app_metadata.provider, 'phone');
  assert.ok(events.includes('SIGNED_IN'));
});
test('phone OTP: wrong code -> error, no token stored', async () => {
  const sb = fresh();
  reply({ code: 'INVALID_OTP', message: 'Invalid OTP' }, 400);
  const r = await sb.auth.verifyOtp({ phone: '+60123456789', token: '000000', type: 'sms' });
  assert.equal(r.error.code, 'INVALID_OTP');
  assert.equal(r.data.session, null);
  assert.equal(store.has('gl_ba_token'), false);
});
test('phone OTP: verify answered without set-auth-token (CORS not exposing it) -> clear error', async () => {
  const sb = fresh();
  reply({ status: true, token: 'raw', user: BA_USER });
  const r = await sb.auth.verifyOtp({ phone: '+60123456789', token: '123456', type: 'sms' });
  assert.equal(r.error.code, 'no_token');
  assert.equal(store.has('gl_ba_token'), false);
});
test('phone OTP: own storage key for the customer app (gl_ba_token_cust) leaves the staff token alone', async () => {
  const sb = fresh({ storageKey: 'gl_ba_token_cust' });
  store.set('gl_ba_token', 'staff.token');
  reply({ status: true, token: 'raw', user: BA_USER }, 200, { 'set-auth-token': 'cust.SIGNED' });
  reply({ session: SESS, user: BA_USER });
  await sb.auth.verifyOtp({ phone: '0123456789', token: '123456', type: 'sms' });
  assert.equal(store.get('gl_ba_token_cust'), 'cust.SIGNED');
  assert.equal(store.get('gl_ba_token'), 'staff.token');
});

/* =================== staff login (reception) =================== */
test('staff: signInWithPassword -> /gl/auth/sign-in/email, token in gl_ba_token (never gl_auth)', async () => {
  const sb = fresh();
  store.set('gl_auth', '{"old":"supabase session"}');
  reply({ token: 'raw', user: { id: 'u1', email: 'admin@grandpride.com', name: 'Reception', role: 'staff' } }, 200, { 'set-auth-token': 'staff.SIGNED' });
  const r = await sb.auth.signInWithPassword({ email: ' Admin@GrandPride.com ', password: 'pw' });
  assert.equal(calls[0].url, API + '/gl/auth/sign-in/email');
  assert.deepEqual(calls[0].body, { email: 'admin@grandpride.com', password: 'pw' });
  assert.equal(store.get('gl_ba_token'), 'staff.SIGNED');
  assert.equal(store.get('gl_auth'), '{"old":"supabase session"}', 'old Supabase login untouched');
  assert.equal(r.data.session.user.email, 'admin@grandpride.com');
  assert.equal(r.data.user.app_metadata.provider, 'email');
});
test('staff: getSession / signOut', async () => {
  const sb = signedIn();
  reply({ session: SESS, user: { id: 'u1', email: 'admin@grandpride.com', name: 'R' } });
  const s = await sb.auth.getSession();
  assert.equal(calls[0].url, API + '/gl/auth/get-session');
  assert.equal(s.data.session.user.email, 'admin@grandpride.com');
  reply({ success: true });
  await sb.auth.signOut();
  assert.equal(calls[1].url, API + '/gl/auth/sign-out');
  assert.equal(store.has('gl_ba_token'), false);
});
test('staff: 401 from /api/db clears the token and fires SIGNED_OUT', async () => {
  const sb = signedIn();
  const ev = [];
  sb.auth.onAuthStateChange((e) => ev.push(e));
  reply({ error: 'unauthenticated' }, 401);
  const r = await sb.from('gl_jobs').select('*');
  assert.equal(r.error.code, '401');
  assert.equal(store.has('gl_ba_token'), false);
  assert.ok(ev.includes('SIGNED_OUT'));
});

/* =================== exact JSON for shapes from the wired pages =================== */
const shapes = [
  // gl-claim
  ['gl-claim users count', (sb) => sb.from('gl_claim_users').select('id', { count: 'exact', head: true }),
    { table: 'gl_claim_users', op: 'select', columns: 'id', count: 'exact', head: true }],
  ['gl-claim batch no  like', (sb) => sb.from('gl_claim_batches').select('id', { count: 'exact', head: true }).like('batch_no', 'CLM-2611-%'),
    { table: 'gl_claim_batches', op: 'select', columns: 'id', filters: [['batch_no', 'like', 'CLM-2611-%']], count: 'exact', head: true }],
  ['gl-claim insert batch .select().single()', (sb) => sb.from('gl_claim_batches').insert({ batch_no: 'CLM-1', total: 12.5 }).select().single(),
    { table: 'gl_claim_batches', op: 'insert', columns: '*', values: { batch_no: 'CLM-1', total: 12.5 }, single: true, returning: true }],
  ['gl-claim submit items .update().in()', (sb) => sb.from('gl_claim_items').update({ status: 'submitted', batch_id: 7 }).in('id', [1, 2]),
    { table: 'gl_claim_items', op: 'update', filters: [['id', 'in', [1, 2]]], values: { status: 'submitted', batch_id: 7 } }],
  ['gl-claim report range', (sb) => sb.from('gl_claim_items').select('*').eq('status', 'submitted').gte('spent_on', '2026-11-01').lt('spent_on', '2026-12-01').order('spent_on'),
    { table: 'gl_claim_items', op: 'select', columns: '*', filters: [['status', 'eq', 'submitted'], ['spent_on', 'gte', '2026-11-01'], ['spent_on', 'lt', '2026-12-01']], order: [['spent_on', { ascending: true, nullsFirst: false }]] }],
  // gl-marketing / gl-mkt-calendar / gl-ads
  ['gl-marketing month counts upsert, composite onConflict', (sb) => sb.from('gl_month_counts').upsert([{ ym: '2026-11', bucket: 'fb', n: 3 }], { onConflict: 'ym,bucket' }),
    { table: 'gl_month_counts', op: 'upsert', values: [{ ym: '2026-11', bucket: 'fb', n: 3 }], onConflict: 'ym,bucket' }],
  ['gl-marketing ad imports upsert (3-col onConflict, spaces removed)', (sb) => sb.from('gl_ad_imports').upsert([], { onConflict: 'campaign_name, period_start, period_end' }),
    { table: 'gl_ad_imports', op: 'upsert', values: [], onConflict: 'campaign_name,period_start,period_end' }],
  ['gl-marketing jobs 5000', (sb) => sb.from('gl_jobs').select('created_at,is_returning,referral_by_name,lead_source,cust_type').order('created_at', { ascending: false }).limit(5000),
    { table: 'gl_jobs', op: 'select', columns: 'created_at,is_returning,referral_by_name,lead_source,cust_type', order: [['created_at', { ascending: false, nullsFirst: true }]], limit: 5000 }],
  ['gl-mkt-calendar upsert', (sb) => sb.from('gl_mkt_tasks').upsert({ ym: '2026-11', task_key: 'a', done: true }, { onConflict: 'ym,task_key' }),
    { table: 'gl_mkt_tasks', op: 'upsert', values: { ym: '2026-11', task_key: 'a', done: true }, onConflict: 'ym,task_key' }],
  ['gl-ads WA msgs  not(ad_id is null)', (sb) => sb.from('gl_wa_msg').select('chat_jid,ad_id').eq('direction', 'in').not('ad_id', 'is', null).gte('wa_ts', '2026-11-01T00:00:00+08:00').limit(5000),
    { table: 'gl_wa_msg', op: 'select', columns: 'chat_jid,ad_id', filters: [['direction', 'eq', 'in'], ['ad_id', 'not.is', null], ['wa_ts', 'gte', '2026-11-01T00:00:00+08:00']], limit: 5000 }],
  // gl-hub-v3
  ['gl-hub-v3 bookings today count', (sb) => sb.from('gl_bookings').select('id', { count: 'exact', head: true }).gte('scheduled_at', 'a').lt('scheduled_at', 'b').in('status', ['pending', 'confirmed', 'in_progress']),
    { table: 'gl_bookings', op: 'select', columns: 'id', filters: [['scheduled_at', 'gte', 'a'], ['scheduled_at', 'lt', 'b'], ['status', 'in', ['pending', 'confirmed', 'in_progress']]], count: 'exact', head: true }],
  ['gl-hub-v3 overdue reminders  is(null)', (sb) => sb.from('gl_service_records').select('id', { count: 'exact', head: true }).lt('next_due', '2026-11-21').is('wa_remind_1_at', null),
    { table: 'gl_service_records', op: 'select', columns: 'id', filters: [['next_due', 'lt', '2026-11-21'], ['wa_remind_1_at', 'is', null]], count: 'exact', head: true }],
  // gl-platescan / gl-jobcard / appointment
  ['gl-platescan history  or(owner_id.eq, vehicle_label.ilike)', (sb) => sb.from('gl_service_records').select('id,service_date,service_name,remark,invoice_url,owner_id,vehicle_label').or('owner_id.eq.w1,vehicle_label.ilike.WXX1234').order('service_date', { ascending: false }).limit(50),
    { table: 'gl_service_records', op: 'select', columns: 'id,service_date,service_name,remark,invoice_url,owner_id,vehicle_label', or: 'owner_id.eq.w1,vehicle_label.ilike.WXX1234', order: [['service_date', { ascending: false, nullsFirst: true }]], limit: 50 }],
  ['gl-platescan delete record .select()', (sb) => sb.from('gl_service_records').delete().eq('id', 5).select(),
    { table: 'gl_service_records', op: 'delete', columns: '*', filters: [['id', 'eq', 5]], returning: true }],
  ['gl-platescan walk-in insert .select(id).maybeSingle()', (sb) => sb.from('gl_walkin').insert({ plate: 'W1' }).select('id').maybeSingle(),
    { table: 'gl_walkin', op: 'insert', columns: 'id', values: { plate: 'W1' }, maybeSingle: true, returning: true }],
  ['gl-jobcard board config upsert, no onConflict', (sb) => sb.from('gl_board_config').upsert({ id: 1, staff_list: ['a'] }),
    { table: 'gl_board_config', op: 'upsert', values: { id: 1, staff_list: ['a'] } }],
  ['gl-jobcard car model lookup  not(type is null)', (sb) => sb.from('gl_car_models').select('name,type').eq('active', true).not('type', 'is', null).ilike('name', 'myvi%').limit(400),
    { table: 'gl_car_models', op: 'select', columns: 'name,type', filters: [['active', 'eq', true], ['type', 'not.is', null], ['name', 'ilike', 'myvi%']], limit: 400 }],
  ['gl-jobcard clear no-show by plate', (sb) => sb.from('gl_jobs').update({ no_show: false, no_show_at: null, no_show_reminded_at: null }).ilike('plate', 'W1').eq('no_show', true),
    { table: 'gl_jobs', op: 'update', filters: [['plate', 'ilike', 'W1'], ['no_show', 'eq', true]], values: { no_show: false, no_show_at: null, no_show_reminded_at: null } }],
  ['gl-staff-appointment profile by phone  or(phone.eq.+60…, phone.eq.60…)', (sb) => sb.from('gl_profiles').select('id,name,phone').or('phone.eq.+60123456789,phone.eq.60123456789').limit(1).maybeSingle(),
    { table: 'gl_profiles', op: 'select', columns: 'id,name,phone', or: 'phone.eq.+60123456789,phone.eq.60123456789', limit: 1, maybeSingle: true }],
  // gl-customers
  ['gl-customers rpc list', (sb) => sb.rpc('gl_customer_list', { p_q: 'ali', p_limit: 30, p_offset: 0 }), null],
  ['gl-customers walk-in rename  update().in(id, row_ids)', (sb) => sb.from('gl_walkin').update({ name: 'Ali' }).in('id', ['a', 'b']),
    { table: 'gl_walkin', op: 'update', filters: [['id', 'in', ['a', 'b']]], values: { name: 'Ali' } }],
  // grandlab-pos-v2
  ['pos unkeyed SQL count  or(is.null,is.null)', (sb) => sb.from('gl_payments').select('id', { count: 'exact', head: true }).eq('voided', false).or('sql_invoice_no.is.null,sql_payment_no.is.null'),
    { table: 'gl_payments', op: 'select', columns: 'id', filters: [['voided', 'eq', false]], or: 'sql_invoice_no.is.null,sql_payment_no.is.null', count: 'exact', head: true }],
  ['pos void  update().eq().select(id,voided)', (sb) => sb.from('gl_payments').update({ voided: true }).eq('id', 9).select('id,voided'),
    { table: 'gl_payments', op: 'update', columns: 'id,voided', filters: [['id', 'eq', 9]], values: { voided: true }, returning: true }],
  ['pos search  or(name.ilike,phone.ilike,plate.ilike)', (sb) => sb.from('gl_walkin').select('id,name,phone,plate,model,sqlacc_code').or('name.ilike.%ali%,phone.ilike.%ali%,plate.ilike.%ali%').limit(6),
    { table: 'gl_walkin', op: 'select', columns: 'id,name,phone,plate,model,sqlacc_code', or: 'name.ilike.%ali%,phone.ilike.%ali%,plate.ilike.%ali%', limit: 6 }],
  ['pos membership products  not(grants_tier is null)', (sb) => sb.from('gl_services').select('name,grants_tier').not('grants_tier', 'is', null).eq('active', true),
    { table: 'gl_services', op: 'select', columns: 'name,grants_tier', filters: [['grants_tier', 'not.is', null], ['active', 'eq', true]] }],
];
for (const [name, run, want] of shapes) {
  test('shape: ' + name, async () => {
    const sb = signedIn();
    const r = await run(sb);
    assert.equal(calls.length, 1, 'one request');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer tok.sig');
    if (want) assert.deepEqual(calls[0].body, want);
    else { assert.equal(calls[0].url, API + '/gl/api/rpc/gl_customer_list'); assert.deepEqual(calls[0].body, { p_q: 'ali', p_limit: 30, p_offset: 0 }); }
    assert.equal(r.error, null);
  });
}
test('pos: .then(r=>r).catch(...) chains still send one request', async () => {
  const sb = signedIn();
  reply({ data: [{ amount: 5 }], error: null, count: null });
  const r = await sb.from('gl_unpaid').select('amount').then((x) => x).catch(() => ({ data: [] }));
  assert.equal(calls.length, 1);
  assert.deepEqual(r.data, [{ amount: 5 }]);
});

/* =================== client-side embeds (platescan, jobcard, appointment) =================== */
test('embed: gl_vehicles + gl_profiles(...)  -> object, 2 requests', async () => {
  const sb = signedIn();
  reply({ data: { id: 'v1', make: 'Perodua', model: 'Myvi', plate: 'W1', owner_id: 'p1' }, error: null });
  reply({ data: [{ id: 'p1', name: 'Ali', phone: '6012', email: 'a@x', tier: 'gold' }], error: null });
  const r = await sb.from('gl_vehicles').select('id,make,model,plate,owner_id, gl_profiles(id,name,phone,email,tier)').ilike('plate', 'W1').limit(1).maybeSingle();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].body, { table: 'gl_vehicles', op: 'select', columns: 'id,make,model,plate,owner_id', filters: [['plate', 'ilike', 'W1']], limit: 1, maybeSingle: true });
  assert.deepEqual(calls[1].body, { table: 'gl_profiles', op: 'select', columns: 'id,name,phone,email,tier', filters: [['id', 'in', ['p1']]] });
  assert.deepEqual(r.data, { id: 'v1', make: 'Perodua', model: 'Myvi', plate: 'W1', owner_id: 'p1', gl_profiles: { id: 'p1', name: 'Ali', phone: '6012', email: 'a@x', tier: 'gold' } });
});
test('embed: gl_profiles + gl_vehicles(...) -> array; join columns added then removed', async () => {
  const sb = signedIn();
  reply({ data: [{ phone: '6012', id: 'p1' }, { phone: '6013', id: 'p2' }], error: null });
  reply({ data: [{ id: 'v1', plate: 'W1', owner_id: 'p1' }, { id: 'v2', plate: 'W2', owner_id: 'p1' }], error: null });
  // gl_staff-appointment: 'id, gl_vehicles(id,plate)'  (owner_id not asked for -> added for the join, removed after)
  const r = await sb.from('gl_profiles').select('phone, gl_vehicles(id,plate)').ilike('phone', '%123');
  assert.deepEqual(calls[0].body.columns, 'phone,id');
  assert.deepEqual(calls[1].body, { table: 'gl_vehicles', op: 'select', columns: 'id,plate,owner_id', filters: [['owner_id', 'in', ['p1', 'p2']]] });
  assert.deepEqual(r.data, [{ phone: '6012', gl_vehicles: [{ id: 'v1', plate: 'W1' }, { id: 'v2', plate: 'W2' }] }, { phone: '6013', gl_vehicles: [] }]);
});
test('embed: no base rows -> no 2nd request; maybeSingle null stays null', async () => {
  const sb = signedIn();
  reply({ data: null, error: null });
  const r = await sb.from('gl_vehicles').select('id,owner_id, gl_profiles(id,name)').ilike('plate', 'X').limit(1).maybeSingle();
  assert.equal(calls.length, 1);
  assert.equal(r.data, null);
});
test('embed: error in the 2nd request is returned (data null)', async () => {
  const sb = signedIn();
  reply({ data: [{ id: 'p1' }], error: null });
  reply({ data: null, error: { message: 'permission denied', code: '42501' } });
  const r = await sb.from('gl_profiles').select('id, gl_vehicles(id)').eq('id', 'p1');
  assert.equal(r.data, null);
  assert.equal(r.error.code, '42501');
});
test('embed: unknown relation / nested / alias / !inner -> CF_UNSUPPORTED, no request', async () => {
  const sb = signedIn();
  for (const cols of ['id, gl_jobs(id)', 'id, gl_vehicles(id, gl_profiles(id))', 'a:id', 'id, gl_vehicles!inner(id)']) {
    calls = [];
    const r = await sb.from('gl_profiles').select(cols);
    assert.equal(calls.length, 0, cols);
    assert.equal(r.error.code, 'CF_UNSUPPORTED', cols);
  }
  calls = [];
  const w = await sb.from('gl_vehicles').insert({}).select('id, gl_profiles(id)');
  assert.equal(calls.length, 0);
  assert.equal(w.error.code, 'CF_UNSUPPORTED', 'embed after a write');
});

/* =================== realtime -> polling (gl-jobcard jobs-rt) =================== */
test('realtime: postgres_changes callback is polled while subscribed; unsubscribe stops it', async () => {
  const sb = fresh({ realtimePollMs: 20 });
  let n = 0; let payload = null; let status = null;
  const ch = sb.channel('jobs-rt').on('postgres_changes', { event: '*', schema: 'public', table: 'gl_jobs' }, (p) => { n++; payload = p; }).subscribe((s) => { status = s; });
  await new Promise((r) => setTimeout(r, 75));
  assert.ok(n >= 2, 'called ' + n + ' times');
  assert.equal(status, 'SUBSCRIBED');
  assert.equal(payload.table, 'gl_jobs');
  assert.equal(payload.cf_poll, true);
  assert.equal(calls.length, 0, 'the channel itself sends nothing (the page reloads its own list)');
  await sb.removeChannel(ch);
  const m = n;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(n, m);
});
test('realtime: realtimePollMs 0 -> inert stub, CHANNEL_ERROR status, warning', async () => {
  const sb = fresh();
  let n = 0; let status = null;
  sb.channel('x').on('postgres_changes', {}, () => n++).subscribe((s) => { status = s; });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(n, 0);
  assert.equal(status, 'CHANNEL_ERROR');
});

/* =================== edge functions =================== */
test('functions.invoke (gl-ads meta-sync) -> CF_UNSUPPORTED, no request', async () => {
  const sb = signedIn();
  const r = await sb.functions.invoke('meta-sync', { body: { force: true } });
  assert.equal(calls.length, 0);
  assert.equal(r.error.code, 'CF_UNSUPPORTED');
});

/* =================== storage (gl-claim receipts, bucket gl-claims) =================== */
test('storage: upload -> /gl/api/storage/upload; getPublicUrl = signed URL that survives "?v=" cache-busters', async () => {
  const sb = signedIn();
  const signedUrl = API + '/gl/files/gl/storage/gl-claims/u1/a.jpg?exp=1800000000&sig=abcdef';
  reply({ data: { path: 'u1/a.jpg', fullPath: 'gl-claims/u1/a.jpg', signedUrl }, error: null });
  const blob = { size: 1234, type: 'image/jpeg' };
  const up = await sb.storage.from('gl-claims').upload('u1/a.jpg', blob, { contentType: 'image/jpeg', upsert: false });
  assert.equal(calls[0].url, API + '/gl/api/storage/upload');
  assert.equal(calls[0].init.headers['x-bucket'], 'gl-claims');
  assert.equal(calls[0].init.headers['x-path'], 'u1%2Fa.jpg');
  assert.equal(calls[0].init.headers['x-upsert'], 'false');
  assert.equal(calls[0].init.body, blob);
  assert.deepEqual(up.data, { path: 'u1/a.jpg', fullPath: 'gl-claims/u1/a.jpg' });
  const pub = sb.storage.from('gl-claims').getPublicUrl('u1/a.jpg').data.publicUrl;
  assert.ok(pub.startsWith(signedUrl));
  const busted = new URL(pub + '?v=' + 123);                 // gl-claim: getPublicUrl(path).data.publicUrl + "?v=" + Date.now()
  assert.equal(busted.searchParams.get('sig'), 'abcdef');
  assert.equal(busted.searchParams.get('exp'), '1800000000');
});
test('storage: remove -> /gl/api/storage/remove', async () => {
  const sb = signedIn();
  reply({ data: [{ name: 'u1/a.jpg' }], error: null });
  await sb.storage.from('gl-claims').remove(['u1/a.jpg', '/u1/a_t.jpg']);
  assert.equal(calls[0].url, API + '/gl/api/storage/remove');
  assert.deepEqual(calls[0].body, { bucket: 'gl-claims', paths: ['u1/a.jpg', 'u1/a_t.jpg'] });
});
test('storage: getPublicUrl before upload -> unsigned /gl/files/gl/storage/… URL + background /sign', async () => {
  const sb = signedIn();
  const u = sb.storage.from('gl-claims').getPublicUrl('batch/CLM 1.pdf').data.publicUrl;
  assert.equal(u, API + '/gl/files/gl/storage/gl-claims/batch/CLM%201.pdf');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls[0].url, API + '/gl/api/storage/sign');
});
test('storage: old Grandlab storage links -> gl/storage keys (public and non-public object URLs)', () => {
  const t = JSON.stringify({ a: SB + '/storage/v1/object/gl-review-proofs/u1/x%20y.png', b: SB + '/storage/v1/object/public/gl-images/p.jpg', c: 'x ' + SB + '/storage/v1/object/gl-images/p.jpg', d: SB + '/storage/v1/object/sign/gl-images/p.jpg' });
  const o = JSON.parse(GLCF.storageUrlsToKeys(t));
  assert.equal(o.a, 'gl/storage/gl-review-proofs/u1/x y.png');
  assert.equal(o.b, 'gl/storage/gl-images/p.jpg');
  assert.equal(o.c, 'x ' + SB + '/storage/v1/object/gl-images/p.jpg', 'only whole string values');
  assert.equal(o.d, SB + '/storage/v1/object/sign/gl-images/p.jpg', 'signed links untouched');
});

/* =================== customer PWA: direct /auth/v1 + /rest/v1 (handleSupabaseFetch) =================== */
const anonH = { apikey: ANON, Authorization: 'Bearer ' + ANON };
const userH = (t) => ({ apikey: ANON, Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' });
async function rest(client, url, init) { const r = await GLCF.handleSupabaseFetch(client, url, init || {}); return { r, json: r.status === 204 ? null : await r.json().catch(() => null) }; }
function cust() { return fresh({ storageKey: 'gl_ba_token_cust' }); }

test('PWA: POST /auth/v1/otp {phone} -> send-otp; 200 {} like Supabase', async () => {
  const c = cust();
  reply({ message: 'ok' });
  const { r, json } = await rest(c, SB + '/auth/v1/otp', { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: ANON }, body: JSON.stringify({ phone: '+60123456789' }) });
  assert.equal(calls[0].url, API + '/gl/auth/phone-number/send-otp');
  assert.deepEqual(calls[0].body, { phoneNumber: '+60123456789' });
  assert.equal(r.status, 200);
  assert.deepEqual(json, {});
});
test('PWA: POST /auth/v1/otp failure -> not ok (the page shows its own error)', async () => {
  const c = cust();
  reply({ message: 'Too many requests' }, 429);
  const { r, json } = await rest(c, SB + '/auth/v1/otp', { method: 'POST', headers: { apikey: ANON }, body: JSON.stringify({ phone: '+60123456789' }) });
  assert.equal(r.ok, false);
  assert.equal(r.status, 429);
  assert.equal(json.error_description, 'Too many requests');
});
test('PWA: POST /auth/v1/verify -> Supabase-shaped session (access_token, refresh_token, expires_at, user.id, user.phone, _cf)', async () => {
  const c = cust();
  reply({ status: true, token: 'raw', user: BA_USER }, 200, { 'set-auth-token': 'cust.SIGNED' });
  reply({ session: SESS, user: BA_USER });
  const { r, json } = await rest(c, SB + '/auth/v1/verify', { method: 'POST', headers: { apikey: ANON }, body: JSON.stringify({ phone: '+60123456789', token: '123456', type: 'sms' }) });
  assert.equal(r.status, 200);
  assert.deepEqual(calls[0].body, { phoneNumber: '+60123456789', code: '123456' });
  assert.equal(json.access_token, 'cust.SIGNED');
  assert.equal(json.refresh_token, 'cust.SIGNED');
  assert.equal(json.token_type, 'bearer');
  assert.equal(json.expires_at, Math.floor(Date.parse(SESS.expiresAt) / 1000));
  assert.ok(json.expires_in > 0);
  assert.equal(json.user.id, BA_USER.id);
  assert.equal(json.user.phone, '60123456789');   // index.html: '+'+SESSION.user.phone
  assert.equal(json._cf, true);
  assert.equal(store.get('gl_ba_token_cust'), 'cust.SIGNED');
});
test('PWA: POST /auth/v1/verify wrong code -> not ok (page: "That code didn\'t match")', async () => {
  const c = cust();
  reply({ code: 'INVALID_OTP', message: 'Invalid OTP' }, 400);
  const { r } = await rest(c, SB + '/auth/v1/verify', { method: 'POST', headers: { apikey: ANON }, body: JSON.stringify({ phone: '+60123456789', token: '1', type: 'sms' }) });
  assert.equal(r.ok, false);
  assert.equal(store.has('gl_ba_token_cust'), false);
});
test('PWA: refresh_token grant -> session still alive (same token) / dead -> 400 invalid refresh token', async () => {
  const c = cust();
  store.set('gl_ba_token_cust', 'cust.SIGNED');
  reply({ session: SESS, user: BA_USER });
  let x = await rest(c, SB + '/auth/v1/token?grant_type=refresh_token', { method: 'POST', headers: { apikey: ANON }, body: JSON.stringify({ refresh_token: 'cust.SIGNED' }) });
  assert.equal(calls[0].url, API + '/gl/auth/get-session');
  assert.equal(x.r.status, 200);
  assert.equal(x.json.access_token, 'cust.SIGNED');
  assert.equal(x.json.user.id, BA_USER.id);
  reply({ message: 'unauthorized' }, 401);
  x = await rest(c, SB + '/auth/v1/token?grant_type=refresh_token', { method: 'POST', headers: { apikey: ANON }, body: JSON.stringify({ refresh_token: 'cust.SIGNED' }) });
  assert.equal(x.r.status, 400);
  assert.equal(store.has('gl_ba_token_cust'), false);
});
test('PWA: password grant (hidden test login) -> /sign-in/email then session', async () => {
  const c = cust();
  reply({ token: 'raw', user: { id: 'u9', email: 't@x.com', name: 'T' } }, 200, { 'set-auth-token': 't.SIGNED' });
  reply({ session: SESS, user: { id: 'u9', email: 't@x.com', name: 'T' } });
  const { r, json } = await rest(c, SB + '/auth/v1/token?grant_type=password', { method: 'POST', headers: { apikey: ANON }, body: JSON.stringify({ email: 't@x.com', password: 'p' }) });
  assert.equal(calls[0].url, API + '/gl/auth/sign-in/email');
  assert.equal(r.status, 200);
  assert.equal(json.access_token, 't.SIGNED');
  assert.equal(json.user.email, 't@x.com');
});
test('PWA: unknown /auth/v1 call -> 400 CF_UNSUPPORTED, no request', async () => {
  const c = cust();
  const { r, json } = await rest(c, SB + '/auth/v1/signup', { method: 'POST', headers: { apikey: ANON }, body: '{}' });
  assert.equal(calls.length, 0);
  assert.equal(r.status, 400);
  assert.equal(json.code, 'CF_UNSUPPORTED');
});
test('PWA: anon read (Bearer = apikey) -> /gl/public/db with NO token, even when a customer is signed in', async () => {
  const c = cust();
  store.set('gl_ba_token_cust', 'cust.SIGNED');
  reply({ data: [{ id: 1 }], error: null });
  const { r, json } = await rest(c, SB + '/rest/v1/gl_services?select=*&active=eq.true&order=sort_order.asc', { headers: anonH });
  assert.equal(calls[0].url, API + '/gl/public/db');
  assert.equal(calls[0].init.headers.Authorization, undefined);
  assert.deepEqual(calls[0].body, { table: 'gl_services', op: 'select', columns: '*', filters: [['active', 'eq', 'true']], order: [['sort_order', { ascending: true, nullsFirst: false }]] });
  assert.equal(r.status, 200);
  assert.deepEqual(json, [{ id: 1 }]);
});
test('PWA: user read (Bearer = user token) -> /gl/api/db with the customer token', async () => {
  const c = cust();
  store.set('gl_ba_token_cust', 'cust.SIGNED');
  reply({ data: [], error: null });
  await rest(c, SB + '/rest/v1/gl_profiles?select=*&id=eq.' + BA_USER.id, { headers: userH('cust.SIGNED') });
  assert.equal(calls[0].url, API + '/gl/api/db');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer cust.SIGNED');
  assert.deepEqual(calls[0].body, { table: 'gl_profiles', op: 'select', columns: '*', filters: [['id', 'eq', BA_USER.id]] });
});
test('PWA: saveProfile upsert (merge-duplicates,return=representation) -> upsert + returning, 201 rows', async () => {
  const c = cust();
  store.set('gl_ba_token_cust', 'cust.SIGNED');
  reply({ data: [{ id: 'u', name: 'Ali' }], error: null });
  const { r, json } = await rest(c, SB + '/rest/v1/gl_profiles', { method: 'POST', headers: Object.assign(userH('cust.SIGNED'), { Prefer: 'resolution=merge-duplicates,return=representation' }), body: JSON.stringify({ id: 'u', name: 'Ali' }) });
  assert.deepEqual(calls[0].body, { table: 'gl_profiles', op: 'upsert', columns: '*', values: { id: 'u', name: 'Ali' }, returning: true });
  assert.equal(r.status, 201);
  assert.deepEqual(json, [{ id: 'u', name: 'Ali' }]);
});
test('PWA: check-in upsert ?on_conflict=owner_id', async () => {
  const c = cust(); store.set('gl_ba_token_cust', 't');
  await rest(c, SB + '/rest/v1/gl_checkins?on_conflict=owner_id', { method: 'POST', headers: Object.assign(userH('t'), { Prefer: 'resolution=merge-duplicates,return=representation' }), body: '{"owner_id":"u","days":1}' });
  assert.deepEqual(calls[0].body, { table: 'gl_checkins', op: 'upsert', columns: '*', values: { owner_id: 'u', days: 1 }, onConflict: 'owner_id', returning: true });
});
test('PWA: rpc with the user token -> /gl/api/rpc; anon rpc -> /gl/public/rpc', async () => {
  const c = cust(); store.set('gl_ba_token_cust', 't');
  reply({ data: { claimed: 1 }, error: null });
  let x = await rest(c, SB + '/rest/v1/rpc/gl_app_claim_pending', { method: 'POST', headers: userH('t'), body: '{}' });
  assert.equal(calls[0].url, API + '/gl/api/rpc/gl_app_claim_pending');
  assert.deepEqual(x.json, { claimed: 1 });
  x = await rest(c, SB + '/rest/v1/rpc/gl_app_spin_status', { method: 'POST', headers: anonH, body: '{"p_x":1}' });
  assert.equal(calls[1].url, API + '/gl/public/rpc/gl_app_spin_status');
  assert.equal(calls[1].init.headers.Authorization, undefined);
});
test('PWA: review-proof upload -> storage upload, and the saved old-style link becomes a gl/storage key', async () => {
  const c = cust(); store.set('gl_ba_token_cust', 't');
  reply({ data: { path: 'u/t_1_a.png', fullPath: 'gl-review-proofs/u/t_1_a.png', signedUrl: API + '/gl/files/x?exp=1&sig=2' }, error: null });
  const file = { size: 10, type: 'image/png' };
  const up = await rest(c, SB + '/storage/v1/object/gl-review-proofs/u/t_1_a.png', { method: 'POST', headers: userH('t'), body: file });
  assert.equal(calls[0].url, API + '/gl/api/storage/upload');
  assert.equal(calls[0].init.headers['x-bucket'], 'gl-review-proofs');
  assert.equal(up.r.status, 200);
  assert.deepEqual(up.json, { Key: 'gl-review-proofs/u/t_1_a.png' });
  await rest(c, SB + '/rest/v1/gl_spin_review_proofs', { method: 'POST', headers: Object.assign(userH('t'), { Prefer: 'return=minimal' }), body: JSON.stringify({ owner_id: 'u', image_url: SB + '/storage/v1/object/gl-review-proofs/u/t_1_a.png' }) });
  assert.deepEqual(calls[1].body, { table: 'gl_spin_review_proofs', op: 'insert', values: { owner_id: 'u', image_url: 'gl/storage/gl-review-proofs/u/t_1_a.png' } });
});
test('PWA: delete vehicle -> 204; patch mystery draw with representation -> 200 rows', async () => {
  const c = cust(); store.set('gl_ba_token_cust', 't');
  let x = await rest(c, SB + '/rest/v1/gl_vehicles?id=eq.v1', { method: 'DELETE', headers: userH('t') });
  assert.deepEqual(calls[0].body, { table: 'gl_vehicles', op: 'delete', filters: [['id', 'eq', 'v1']] });
  assert.equal(x.r.status, 204);
  reply({ data: [{ id: 'm1' }], error: null });
  x = await rest(c, SB + '/rest/v1/gl_mystery_draws?id=eq.m1', { method: 'PATCH', headers: Object.assign(userH('t'), { Prefer: 'return=representation' }), body: '{"used":true}' });
  assert.equal(x.r.status, 200);
  assert.deepEqual(x.json, [{ id: 'm1' }]);
});
test('PWA: /functions/v1/* is left to the page glue (returns null)', () => {
  const c = cust();
  assert.equal(GLCF.handleSupabaseFetch(c, SB + '/functions/v1/doku/create', { method: 'POST', body: '{}' }), null);
});
test('isAnonRequest', () => {
  assert.equal(GLCF.isAnonRequest({ headers: anonH }), true);
  assert.equal(GLCF.isAnonRequest({ headers: { apikey: ANON } }), true);
  assert.equal(GLCF.isAnonRequest({ headers: userH('x') }), false);
  assert.equal(GLCF.isAnonRequest({}), false);
});

/* =================== EVERY call in the wired pages =================== */
// supabase-js pages: each sb./gl. chain is evaluated against the client with every free variable replaced by a
// placeholder, and must produce a supported request (exceptions listed in EXPECTED_UNSUPPORTED).
const SBJS_PAGES = ['gl-claim.html', 'gl-marketing.html', 'gl-ads.html', 'gl-mkt-calendar.html', 'gl-hub-v3.html', 'gl-platescan.html',
  'gl-jobcard.html', 'gl-staff-appointment-FINAL.html', 'gl-customers.html', 'grandlab-pos-v2.html'];
const EXPECTED_UNSUPPORTED = ["gl-ads.html: sb.functions.invoke('meta-sync',{body:{force:true}})"];

function chainAt(src, i) {
  let j = i, depth = 0, inStr = null;
  while (j < src.length) {
    const c = src[j];
    if (inStr) { if (c === '\\') { j += 2; continue; } if (c === inStr) inStr = null; j++; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; j++; continue; }
    if (c === '(' || c === '[' || c === '{') { depth++; j++; continue; }
    if (c === ')' || c === ']' || c === '}') { if (depth === 0) break; depth--; j++; continue; }
    if (depth === 0) {
      if (c === ';' || c === ',') break;
      if (/\s/.test(c)) { let k = j; while (k < src.length && /\s/.test(src[k])) k++; if (src[k] === '.') { j = k; continue; } break; }
      if (!/[\w$.?]/.test(c)) break;
    }
    j++;
  }
  return src.slice(i, j);
}
function extractChains(file) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const re = /\b(sb|gl)\s*\.\s*(from|rpc|storage|channel|auth|functions|removeChannel|schema)\b/g;
  const out = []; let m;
  while ((m = re.exec(src))) { if (/[\w$.]$/.test(src.slice(0, m.index))) continue; out.push(chainAt(src, m.index)); }
  return out;
}
const PASS = new Set(['sb', 'gl', 'undefined', 'NaN', 'Infinity', 'Object', 'Array', 'Math', 'Date', 'JSON', 'String', 'Number', 'Boolean', 'Set', 'Map',
  'Promise', 'encodeURIComponent', 'parseInt', 'parseFloat', 'isNaN', 'console', 'RegExp', 'Error']);
function magic() {
  const f = function () {};
  const p = new Proxy(f, {
    get(t, k) {
      if (k === Symbol.toPrimitive) return () => 'x';
      if (k === Symbol.iterator) return function* () { yield 'x'; };
      if (k === 'then') return undefined;
      if (k === 'toString' || k === 'valueOf' || k === 'trim' || k === 'toUpperCase' || k === 'toLowerCase') return () => 'x';
      if (k === 'length') return 1;
      if (k === 'map' || k === 'filter') return () => ['x'];
      return p;
    },
    apply() { return p; }, construct() { return p; },
    has() { return true; },
  });
  return p;
}
function evalChain(chain, client) {
  const M = magic();
  const scope = new Proxy({}, { has: (t, k) => typeof k === 'string' && !PASS.has(k), get: (t, k) => (k === Symbol.unscopables ? undefined : M), set: () => true });
  // eslint-disable-next-line no-new-func
  return new Function('sb', 'gl', '__s', 'with(__s){ return (' + chain + '); }')(client, client, scope);
}
test('every supabase-js call in the 10 wired staff pages builds a supported request', async () => {
  const unsupported = [];
  let total = 0;
  for (const file of SBJS_PAGES) {
    for (const chain of extractChains(file)) {
      total++;
      const sb = signedIn({ realtimePollMs: 0 });
      let v;
      try { v = evalChain(chain, sb); } catch (e) { assert.fail(file + ': could not evaluate ' + chain + '\n' + e.stack); }
      let r = null;
      if (v && typeof v.then === 'function') r = await Promise.resolve(v).catch((e) => ({ error: { message: String(e) } }));
      const label = file + ': ' + chain.replace(/\s+/g, '');
      const cfErr = (r && r.error && r.error.code === 'CF_UNSUPPORTED') || warnings.some((w) => /not supported/.test(w) && !/realtime|getPublicUrl before upload/.test(w));
      if (cfErr) { unsupported.push(label); continue; }
      for (const c of calls) {
        assert.ok(c.url.startsWith(API + '/gl/'), label + ' -> ' + c.url);
        if (c.url === API + '/gl/api/db') {
          assert.ok(['select', 'insert', 'update', 'upsert', 'delete'].includes(c.body.op), label);
          assert.match(c.body.table, /^gl_[a-z0-9_]+$/, label);
          for (const f of c.body.filters || []) assert.ok(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'in', 'is', 'not.is'].includes(f[1]), label + ' op ' + f[1]);
          if (c.body.columns) assert.doesNotMatch(c.body.columns, /[()!]/, label);
        }
      }
    }
  }
  const norm = (s) => s.replace(/\s+/g, '');
  assert.deepEqual(unsupported.map(norm).sort(), EXPECTED_UNSUPPORTED.map(norm).sort(), 'unsupported calls changed');
  assert.ok(total > 300, 'found ' + total + ' calls');
  console.log('[gl-cf-client test] ' + total + ' supabase-js calls in ' + SBJS_PAGES.length + ' pages checked; not supported: ' + unsupported.join(' | '));
});
test('the page-call checker itself catches unsupported shapes (negative control)', async () => {
  for (const chain of ["sb.from('gl_jobs').select('*').contains('tags',['a'])", "sb.from('gl_jobs').select('id, gl_walkin(id)')", "sb.from('gl_jobs').select('*').or('a.eq.1').or('b.eq.2')", "sb.from('gl_jobs').select('*').not('a','eq',1)"]) {
    const sb = signedIn();
    const r = await evalChain(chain, sb);
    assert.equal(r.error && r.error.code, 'CF_UNSUPPORTED', chain);
    assert.equal(calls.length, 0, chain);
  }
});

// index.html: every fetch() to ${SUPA_URL}/rest|storage must be translated (not CF_UNSUPPORTED)
function extractFetches(file) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const re = /fetch\(/g; let m; const out = [];
  while ((m = re.exec(src))) {
    let i = m.index + 6, d = 1, s = null;
    for (; i < src.length && d > 0; i++) { const c = src[i]; if (s) { if (c === '\\') { i++; continue; } if (c === s) s = null; continue; } if (c === '"' || c === "'" || c === '`') { s = c; continue; } if (c === '(') d++; else if (c === ')') d--; }
    const call = src.slice(m.index, i);
    const um = /^fetch\(\s*`\$\{SUPA_URL\}([^`]*)`/.exec(call);
    if (!um) continue;
    out.push({ path: um[1], method: (/method\s*:\s*["'](\w+)["']/.exec(call) || [])[1] || 'GET', prefer: (/Prefer\s*:\s*["']([^"']+)["']/.exec(call) || [])[1] || '', user: /authHeaders\(\)/.test(call), call });
  }
  return out;
}
test('every direct Supabase REST call in index.html is translated (rest + rpc + storage)', async () => {
  const list = extractFetches('index.html').filter((f) => !f.path.startsWith('/auth/v1/'));
  assert.ok(list.length >= 55, 'found ' + list.length);
  for (const f of list) {
    const c = cust(); store.set('gl_ba_token_cust', 'cust.SIGNED');
    const url = SB + f.path.replace(/\$\{[^}]*\}/g, 'x1');
    const headers = Object.assign(f.user ? userH('cust.SIGNED') : Object.assign({}, anonH), f.prefer ? { Prefer: f.prefer } : {});
    const init = { method: f.method, headers };
    if (f.method !== 'GET' && f.method !== 'DELETE') init.body = f.path.startsWith('/storage/') ? { size: 5, type: 'image/png' } : '{"a":1}';
    if (f.path.startsWith('/storage/')) reply({ data: { path: 'x1', signedUrl: API + '/f?exp=1&sig=2' }, error: null });
    const r = await GLCF.handleSupabaseFetch(c, url, init);
    const label = f.method + ' ' + f.path;
    assert.ok(r, label);
    assert.notEqual(r.status, 400, label + ' -> ' + (await r.text()));
    assert.equal(calls.length, 1, label);
    const want = f.path.startsWith('/storage/') ? '/gl/api/storage/upload' : f.path.startsWith('/rest/v1/rpc/') ? (f.user ? '/gl/api/rpc/' : '/gl/public/rpc/') : (f.user ? '/gl/api/db' : '/gl/public/db');
    assert.ok(calls[0].url.startsWith(API + want), label + ' -> ' + calls[0].url);
  }
});
test('index.html auth calls are exactly the ones translated (otp, verify, token refresh/password)', () => {
  const auth = extractFetches('index.html').filter((f) => f.path.startsWith('/auth/v1/')).map((f) => f.method + ' ' + f.path).sort();
  assert.deepEqual(auth, ['POST /auth/v1/otp', 'POST /auth/v1/token?grant_type=password', 'POST /auth/v1/token?grant_type=refresh_token', 'POST /auth/v1/verify']);
});
