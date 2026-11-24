// Run: node --test tests/gl-gp-read.test.mjs          (no packages needed)
// Checks gl-gp-read.js (Grandpride read-only data via gl-api GET /gl/gpread/:view) with a fake browser and a mocked fetch:
// which token it sends on each backend setting, the {data,error} shapes the pages rely on, every failure mode, the
// fail-open switch, and (over the real page files) that every page edit is in place and nothing talks to the old gateway.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'gl-gp-read.js'), 'utf8');
const API = 'https://gl-api.jimmykuek94.workers.dev';

/* a fresh fake window per test: localStorage, fetch (records + replies), optional GLCF_PAGE */
function env(opts = {}) {
  const store = new Map(Object.entries(opts.ls || {}));
  const calls = [];
  const win = {
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    fetch: (url, init) => { calls.push({ url, init }); return opts.fetch ? opts.fetch(url, init) : Promise.resolve(res(200, { data: null, error: null })); },
    AbortController, clearTimeout,
    setTimeout: opts.fastTimers ? (f) => setTimeout(f, 20) : setTimeout, // fastTimers: the 8 s timeout fires after 20 ms
  };
  if (opts.cfToken !== undefined) win.GLCF_PAGE = { client: { auth: { token: () => opts.cfToken } } };
  win.window = win;
  vm.runInNewContext(SRC, win);
  // results are copied into this realm (objects made inside vm have another prototype, which deepStrictEqual rejects)
  const j = (x) => JSON.parse(JSON.stringify(x));
  const GLGP = { GUARD_FAIL_OPEN: win.GLGP.GUARD_FAIL_OPEN };
  for (const k of ['me', 'staffApps', 'tower']) GLGP[k] = (...a) => win.GLGP[k](...a).then(j);
  return { GLGP, calls, win };
}
const res = (status, json) => ({ ok: status >= 200 && status < 300, status, json: () => (json === undefined ? Promise.reject(new Error('not json')) : Promise.resolve(json)) });
const sbSession = (t) => JSON.stringify({ access_token: t, refresh_token: 'r', user: { email: 'a@b.c' } });

test('switch "sb": token comes from the Grandlab Supabase session (gl_auth), URL is /gl/gpread/me', async () => {
  const { GLGP, calls } = env({ ls: { gl_auth: sbSession('SB.JWT') } });
  await GLGP.me();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, API + '/gl/gpread/me');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer SB.JWT');
  assert.equal(calls[0].init.method, undefined, 'plain GET, no body');
  assert.equal(calls[0].init.body, undefined);
});

test('switch "cf": token comes from the Cloudflare login (GLCF_PAGE), not from gl_auth', async () => {
  const { GLGP, calls } = env({ cfToken: 'BA.TOKEN', ls: { gl_auth: sbSession('SB.JWT') } });
  await GLGP.staffApps();
  assert.equal(calls[0].url, API + '/gl/gpread/staff-apps');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer BA.TOKEN');
});

test('switch "cf" but no Cloudflare token yet: falls back to gl_auth; an explicit token wins over both', async () => {
  let e = env({ cfToken: null, ls: { gl_auth: sbSession('SB.JWT') } });
  await e.GLGP.me(); assert.equal(e.calls[0].init.headers.Authorization, 'Bearer SB.JWT');
  e = env({ cfToken: 'BA.TOKEN', ls: { gl_auth: sbSession('SB.JWT') } });
  await e.GLGP.me('GUARD.TOKEN'); assert.equal(e.calls[0].init.headers.Authorization, 'Bearer GUARD.TOKEN');
});

test('no token anywhere: answers 401 shape and makes NO request', async () => {
  for (const ls of [{}, { gl_auth: 'not json' }, { gl_auth: '{"x":1}' }, { gl_auth: 'null' }]) {
    const { GLGP, calls } = env({ ls });
    assert.deepEqual(await GLGP.me(), { data: null, error: { code: '401', message: 'Not signed in' } });
    assert.deepEqual((await GLGP.tower()).staff, { data: null, error: { code: '401', message: 'Not signed in' } });
    assert.equal(calls.length, 0);
  }
});

test('gl_api_base override (same key as gl-cf-client.js) moves the base URL', async () => {
  const { GLGP, calls } = env({ ls: { gl_auth: sbSession('T'), gl_api_base: 'http://localhost:8787/' } });
  await GLGP.me();
  assert.equal(calls[0].url, 'http://localhost:8787/gl/gpread/me');
});

test('me: returns the server JSON as is ({data:{username,name,apps}, error:null})', async () => {
  const body = { data: { username: 'mixed', name: 'Mixed', apps: ['tower'] }, master: false, error: null };
  const { GLGP } = env({ ls: { gl_auth: sbSession('T') }, fetch: () => Promise.resolve(res(200, body)) });
  assert.deepEqual(await GLGP.me(), body);
});

test('me: "not in the staff list" is data:null WITHOUT error (this is the only answer that may block)', async () => {
  const { GLGP } = env({ ls: { gl_auth: sbSession('T') }, fetch: () => Promise.resolve(res(200, { data: null, master: false, error: null })) });
  const r = await GLGP.me();
  assert.equal(r.error, null); assert.equal(r.data, null);
});

test('network error -> {data:null,error:{code:"NET"}} (never throws)', async () => {
  const { GLGP } = env({ ls: { gl_auth: sbSession('T') }, fetch: () => Promise.reject(new Error('Failed to fetch')) });
  const r = await GLGP.me();
  assert.equal(r.data, null); assert.equal(r.error.code, 'NET'); assert.match(r.error.message, /Failed to fetch/);
  assert.equal((await GLGP.staffApps()).error.code, 'NET');
});

test('server errors: 401/403/500 with JSON keep their error; non-JSON body gets an HTTP error', async () => {
  for (const [st, j, code] of [[401, { data: null, error: { code: '401', message: 'Not signed in' } }, '401'], [403, { data: null, error: { code: '42501', message: 'No access' } }, '42501'], [500, { data: null, error: { code: '500', message: 'could not read' } }, '500']]) {
    const { GLGP } = env({ ls: { gl_auth: sbSession('T') }, fetch: () => Promise.resolve(res(st, j)) });
    const r = await GLGP.me(); assert.equal(r.data, null); assert.equal(r.error.code, code);
  }
  let e = env({ ls: { gl_auth: sbSession('T') }, fetch: () => Promise.resolve(res(502, undefined)) });
  assert.deepEqual(await e.GLGP.me(), { data: null, error: { code: '502', message: 'HTTP 502' } });
  e = env({ ls: { gl_auth: sbSession('T') }, fetch: () => Promise.resolve(res(500, {})) });
  assert.equal((await e.GLGP.me()).error.code, '500', 'an error status with an empty JSON body still counts as an error');
});

test('a hung server is cut off (timeout) and reported as a NET error', async () => {
  const hang = (u, init) => new Promise((ok, no) => init.signal.addEventListener('abort', () => no(new Error('aborted'))));
  const e = env({ ls: { gl_auth: sbSession('T') }, fetch: hang, fastTimers: true });
  const t0 = Date.now(); const r = await e.GLGP.me();
  assert.equal(r.error.code, 'NET'); assert.match(r.error.message, /aborted/); assert.ok(Date.now() - t0 < 2000);
});

test('tower(): ONE request, split into three supabase-style results', async () => {
  const body = { staff: [{ username: 'a', name: 'A', company: 'Grandlab', title: 'x', is_chauffeur: false, chauffeur_status: 'ready' }], attendance: [{ username: 'a', rec: { amIn: '09:00' } }], fleet: [{ plate: 'W1', model: 'M', status: 's', car_type: 't', colour: 'c' }], error: null };
  const { GLGP, calls } = env({ ls: { gl_auth: sbSession('T') }, fetch: () => Promise.resolve(res(200, body)) });
  const t = await GLGP.tower();
  assert.equal(calls.length, 1); assert.equal(calls[0].url, API + '/gl/gpread/tower');
  assert.deepEqual(t.staff, { data: body.staff, error: null });
  assert.deepEqual(t.attendance, { data: body.attendance, error: null });
  assert.deepEqual(t.fleet, { data: body.fleet, error: null });
});

test('tower() on any failure: all three have .error and data:null (the page then falls back to gl_team)', async () => {
  for (const fetch of [() => Promise.resolve(res(403, { data: null, error: { code: '42501', message: 'No access' } })), () => Promise.reject(new Error('down')), () => Promise.resolve(res(500, undefined))]) {
    const { GLGP } = env({ ls: { gl_auth: sbSession('T') }, fetch });
    const t = await GLGP.tower();
    for (const k of ['staff', 'attendance', 'fleet']) { assert.ok(t[k].error, k + ' error'); assert.equal(t[k].data, null); }
  }
});

test('GUARD_FAIL_OPEN is exported and true (decision: a failed check lets people in)', () => {
  assert.equal(env().GLGP.GUARD_FAIL_OPEN, true);
  assert.equal((SRC.match(/var GUARD_FAIL_OPEN = (true|false);/g) || []).length, 1, 'exactly one place to flip');
});

/* ---------- the real pages ---------- */
const GUARD_PAGES = ['gl-academy', 'gl-agents', 'gl-commission-centre', 'gl-commission', 'gl-daily', 'gl-inspect', 'gl-jobcard', 'gl-ladder', 'gl-platescan', 'gl-qc-addon', 'gl-qc', 'gl-statement', 'gl-tower-lite', 'gl-tower'];
const HUB_PAGES = ['gl-hub', 'gl-hub-v3'];
const page = (n) => fs.readFileSync(path.join(ROOT, n + '.html'), 'utf8');

test('every one of the 16 pages: loads gl-gp-read.js once, right after gl-backend-config.js, and has no request to the old gateway left', () => {
  for (const n of GUARD_PAGES.concat(HUB_PAGES)) {
    const s = page(n);
    assert.equal(s.split('<script src="gl-gp-read.js"></script>').length - 1, 1, n + ': script tag');
    assert.ok(s.includes('<script src="gl-backend-config.js"></script>\n<script src="gl-gp-read.js"></script>'), n + ': order');
    assert.ok(!/gp\.from\(/.test(s), n + ': still has gp.from(');
    assert.ok(!/gp\.from\('gp_/.test(s), n + ': gp_ read left');
  }
});

test('the 14 access guards: read via GLGP.me(session token), fail-open line sits right before the deny line', () => {
  for (const n of GUARD_PAGES) {
    const s = page(n);
    assert.equal((s.match(/var r = await GLGP\.me\(s\.data\.session\.access_token\);/g) || []).length, 1, n + ': guard read');
    assert.match(s, /if\(r\.error&&GLGP\.GUARD_FAIL_OPEN\) return;[^\n]*\n\s*if\(r\.error\|\|!r\.data\)\{ deny\('This login is not in the staff list/, n + ': fail-open then deny');
    assert.match(s, /var MASTER=\['admin@grandpride\.com'\]|var MASTER ?= ?\['admin@grandpride\.com'\]/, n + ': master short-cut kept');
    assert.ok(s.indexOf("if(MASTER.indexOf(email)") < s.indexOf('GLGP.me('), n + ': MASTER returns before any call');
  }
});

test('hubs keep "show everything" when the check fails (no fail-open flag needed there)', () => {
  assert.match(page('gl-hub'), /var r=await GLGP\.me\(\);\s*\n\s*if\(r\.error\|\|!r\.data\)return;/);
  assert.match(page('gl-hub-v3'), /const r=await GLGP\.me\(\);\s*\n\s*if\(r\.error\|\|!r\.data\) return;/);
});

test('tower pages: one GLGP.tower() call feeds the three result slots in the same order as before', () => {
  for (const n of ['gl-tower', 'gl-tower-lite']) {
    const s = page(n);
    assert.equal((s.match(/GLGP\.tower\(\)/g) || []).length, 1);
    const i = s.indexOf('gpT.then(function(t){return t.staff})');
    assert.ok(i > 0 && s.indexOf('gpT.then(function(t){return t.attendance})') > i && s.indexOf('gpT.then(function(t){return t.fleet})') > i, n + ': order');
    assert.ok(s.indexOf('var gpT=GLGP.tower();') < s.indexOf('var q=await Promise.all(['), n + ': started before the Promise.all');
  }
});

test('academy: staff sync and "who am I" use the new calls', () => {
  const s = page('gl-academy');
  assert.ok(s.includes('const r=await GLGP.staffApps();') && s.includes('const r=await GLGP.me();'));
});

test('no page outside these 16 reads the old gateway; only the dead GP_URL constants may remain (they make no request)', () => {
  for (const f of fs.readdirSync(ROOT).filter((x) => x.endsWith('.html'))) {
    const s = page(f.replace(/\.html$/, ''));
    const withGp = /gpdb\.grandlab\.com\.my/.test(s);
    if (withGp) assert.ok(GUARD_PAGES.concat(HUB_PAGES).includes(f.replace(/\.html$/, '')), f + ' mentions the old gateway but is not one of the 16');
  }
});
