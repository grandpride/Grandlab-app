// Run: node tests/gl-switch.playwright.cjs <dir with the UNCHANGED pages>
// Headless Chromium (playwright, preinstalled). Nothing reaches the internet: every external request is aborted,
// supabase-js is replaced by a local stub (same "var supabase=" shape as the real bundle), the new API is mocked.
//
// A. Switch OFF: every changed page, unchanged copy vs this copy, must give IDENTICAL console messages, page errors,
//    requested URLs, localStorage and page text (Date and Math.random are frozen so runs are comparable), and must
//    never request gl-cf-client.js / gl-cf-page.js. Modes: all external blocked / supabase-js stub signed in;
//    plain URL and ?backend=sb; index.html also with a saved customer login.
//    The only extra request allowed with the switch off is the new go-live setting file gl-backend-config.js.
// B. Switch ON (?backend=cf), mocked Worker: pages talk to /gl/api/* with the Bearer token and never to Supabase,
//    the Grandpride gp_staff check still uses supabase-js, realtime polls, the customer PWA logs in by SMS code,
//    keeps the old login aside and gets it back with ?backend=sb, DOKU payment goes to /gl/api/fn/doku/create.
//    EVERY switched page: loads with no Supabase request; guest pages read /gl/public/* without a token; staff pages
//    without a login of their own offer a sign-in; edge functions go to /gl/api/fn/*.
// C. Go-live setting (gl-backend-config.js replaced by the mock server): one module flipped to "cf" moves only its
//    pages (no ?backend=cf, no tag), ?backend=sb is a remembered fallback, ?backend=auto follows the setting again.
'use strict';
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const NEW = path.resolve(__dirname, '..');
const ORIG = path.resolve(process.argv[2] || '');
if (!process.argv[2] || !fs.existsSync(path.join(ORIG, 'index.html'))) { console.error('usage: node tests/gl-switch.playwright.cjs <dir with unchanged pages>'); process.exit(2); }

// every page that carries the switch (found by its gl-backend-config.js tag) -> its module + cfg flags
const PAGE_INFO = {};
for (const f of fs.readdirSync(NEW).filter((x) => /\.html$/.test(x)).concat(['GLboard/gl-board.html'])) {
  const src = fs.readFileSync(path.join(NEW, f), 'utf8');
  if (!/gl-backend-config\.js/.test(src)) continue;
  const m = /var M='(\w+)'/.exec(src); const c = /GLCF_PAGE_CFG=\{([^}]*)\}/.exec(src);
  PAGE_INFO[f] = { module: m[1], public: /public:true/.test(c[1]), hubLogin: /hubLogin:true/.test(c[1]), customer: /customer:true/.test(c[1]) };
}
const PAGES = Object.keys(PAGE_INFO).sort().filter((x) => !process.env.PW_ONLY || process.env.PW_ONLY.split(',').includes(x));
const CONCURRENCY = Number(process.env.PW_CONCURRENCY || 6);
async function pool(items, n, fn) { const out = new Array(items.length); let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } })); return out; }
const API = 'https://gl-api.jimmykuek94.workers.dev';
const SUPA = 'https://db.grandlab.com.my';
const SBJS = /^https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@2/;
const FIXED = new Date('2026-11-21T10:00:00+08:00');

/* supabase-js stand-in. "var supabase=" like the real UMD bundle (a non-configurable global). */
const STUB = `var supabase=(function(){
  function res(){ return {data:[],error:null,count:0,status:200,statusText:'OK'}; }
  function chain(){ var p=new Proxy(function(){},{get:function(t,k){
      if(k==='then') return function(a,b){ return Promise.resolve(res()).then(a,b); };
      if(k==='catch') return function(b){ return Promise.resolve(res()).catch(b); };
      if(k==='finally') return function(f){ return Promise.resolve(res()).finally(f); };
      return p; }, apply:function(){ return p; }}); return p; }
  function createClient(url){
    (window.__sbCalls=window.__sbCalls||[]).push(String(url));
    var signed = !!window.__stubSignedIn;
    var session = signed ? {access_token:'sb',user:{id:'9684de35-a49c-4630-b02b-a1deb8d52e6f',email:'admin@grandpride.com'}} : null;
    return { _stub:true,
      auth:{ getSession:function(){return Promise.resolve({data:{session:session},error:null});},
             getUser:function(){return Promise.resolve({data:{user:session&&session.user},error:null});},
             signInWithPassword:function(){return Promise.resolve({data:{},error:{message:'stub'}});},
             signOut:function(){return Promise.resolve({error:null});},
             onAuthStateChange:function(){return {data:{subscription:{unsubscribe:function(){}}}};} },
      from:function(){return chain();}, rpc:function(){return chain();},
      storage:{from:function(){return {upload:function(){return Promise.resolve({data:null,error:{message:'stub'}});},
        getPublicUrl:function(p){return {data:{publicUrl:'stub://'+p}};}, remove:function(){return Promise.resolve({data:[],error:null});}};}},
      channel:function(){ var c={on:function(){return c;},subscribe:function(){return c;},unsubscribe:function(){return Promise.resolve('ok');}}; return c; },
      removeChannel:function(){return Promise.resolve('ok');},
      functions:{invoke:function(){return Promise.resolve({data:null,error:{message:'stub'}});}} };
  }
  return {createClient:createClient};
})();`;

function serve(dir) {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.png': 'image/png', '.json': 'application/json', '.pdf': 'application/pdf' };
  return new Promise((resolve) => {
    const s = http.createServer((q, r) => {
      let p = decodeURIComponent(new URL(q.url, 'http://x').pathname);
      if (p.endsWith('/')) p += 'index.html';
      const f = path.join(dir, p);
      if (!f.startsWith(dir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); r.end('not found'); return; }
      r.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(f).pipe(r);
    });
    s.listen(0, '127.0.0.1', () => resolve({ server: s, base: 'http://127.0.0.1:' + s.address().port }));
  });
}

/* three.js stand-in for gl-tower's 3D view (CDN blocked here): every export is a do-anything proxy, so the page's
   own start() (login check, data, realtime) runs. Names = every THREE.X used by the page. */
const THREE_NAMES = [...new Set((fs.readFileSync(path.join(NEW, 'gl-tower.html'), 'utf8').match(/THREE\.([A-Za-z0-9_]+)/g) || []).map((x) => x.slice(6)))];
const ANY = `const H={get(t,k){if(k==='domElement')return t.__el||(t.__el=document.createElement('div'));if(k===Symbol.toPrimitive)return()=>0;if(k==='then')return undefined;if(k==='length')return 0;if(k===Symbol.iterator)return function*(){};if(!(k in t))t[k]=new Proxy(function(){},H);return t[k]},set(t,k,v){t[k]=v;return true},apply(){return new Proxy(function(){},H)},construct(){return new Proxy(function(){},H)}};const U=new Proxy(function(){},H);`;
const THREE_STUB = ANY + THREE_NAMES.map((n) => 'export const ' + n + '=U;').join('');
const THREE_ADDON_STUB = ANY + 'export const OrbitControls=U,CSS2DRenderer=U,CSS2DObject=U,mergeGeometries=U;';
async function newCtx(browser, opts) {
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  await ctx.addInitScript((o) => {
    let s = 42; Math.random = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
    if (o.signedIn) window.__stubSignedIn = true;
    if (o.seed && !sessionStorage.getItem('__seeded')) { sessionStorage.setItem('__seeded', '1'); for (const k in o.seed) localStorage.setItem(k, o.seed[k]); }
  }, { signedIn: !!opts.signedIn, seed: opts.seed || null });
  return ctx;
}

/* ---------------- A. switch OFF parity ---------------- */
async function record(browser, base, page, query, mode, seed) {
  const ctx = await newCtx(browser, { signedIn: mode === 'stub', seed });
  const p = await ctx.newPage();
  await p.clock.setFixedTime(FIXED);
  const norm = (s) => String(s).split(base).join('ORIGIN');
  const rec = { console: [], errors: [], requests: [] };
  p.on('console', (m) => rec.console.push(m.type() + ': ' + norm(m.text())));
  p.on('pageerror', (e) => rec.errors.push(norm(e.message)));
  p.on('request', (r) => rec.requests.push(r.method() + ' ' + norm(r.url())));
  await ctx.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith(base)) return route.continue();
    if (mode === 'stub' && SBJS.test(u)) return route.fulfill({ status: 200, contentType: 'application/javascript', body: STUB });
    return route.abort();
  });
  try { await p.goto(base + '/' + page + query, { waitUntil: 'load', timeout: 30000 }); } catch (e) { rec.errors.push('goto: ' + e.message.split('\n')[0]); }
  await p.waitForTimeout(2500);
  rec.localStorage = await p.evaluate(() => { const o = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); o[k] = localStorage.getItem(k); } return o; }).catch((e) => ({ __error: e.message }));
  rec.text = norm(await p.evaluate(() => (document.body ? document.body.innerText : '')).catch((e) => 'ERR ' + e.message));
  rec.sbCalls = await p.evaluate(() => window.__sbCalls || []).catch(() => []);
  await ctx.close();
  const media = /\.(mp4|mp3|webm|ogg)(\?|$)/i;
  rec.requests = rec.requests.filter((x, i, a) => !media.test(x) || a.indexOf(x) === i);
  rec.config = rec.requests.filter((x) => /\/gl-backend-config\.js$/.test(x));
  rec.requests = rec.requests.filter((x) => !/\/gl-backend-config\.js$/.test(x));
  rec.requests = rec.requests.filter((x) => !/\/gl-gp-read\.js$/.test(x));   // Grandpride read helper (tests/gl-gp-read.*): one static file, no data request while no token / MASTER
  rec.console.sort(); rec.errors.sort(); rec.requests.sort();
  return rec;
}

function diff(a, b) {
  const out = [];
  for (const k of ['console', 'errors', 'requests', 'localStorage', 'text', 'sbCalls']) {
    const x = JSON.stringify(a[k]), y = JSON.stringify(b[k]);
    if (x !== y) out.push(k + ':\n   orig: ' + x.slice(0, 600) + '\n   new : ' + y.slice(0, 600));
  }
  return out;
}

/* ---------------- B. switch ON with a mocked Worker ---------------- */
const STAFF = { id: '9684de35-a49c-4630-b02b-a1deb8d52e6f', email: 'admin@grandpride.com', name: 'Reception', role: 'staff', emailVerified: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' };
const CUSTOMER = { id: '11111111-2222-3333-4444-555555555555', email: '60123456789@phone.grandlab.invalid', name: '+60123456789', phoneNumber: '+60123456789', phoneNumberVerified: true, role: 'customer', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' };
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-bucket, x-path, x-upsert', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Expose-Headers': 'set-auth-token' };

async function onRun(browser, base, page, opts) {
  opts = opts || {};
  const ctx = await newCtx(browser, { signedIn: false, seed: opts.seed });
  const p = await ctx.newPage();
  const rec = { console: [], errors: [], requests: [], api: [], supabase: [] };
  p.on('console', (m) => rec.console.push(m.type() + ': ' + m.text()));
  p.on('pageerror', (e) => rec.errors.push(e.message));
  p.on('request', (r) => {
    const u = r.url();
    rec.requests.push(r.method() + ' ' + u);
    if (u.startsWith(SUPA)) rec.supabase.push(r.method() + ' ' + u);
  });
  await ctx.route('**/*', async (route) => {
    const req = route.request(); const u = req.url();
    if (opts.config && u.startsWith(base) && /\/gl-backend-config\.js$/.test(u)) return route.fulfill({ status: 200, contentType: 'application/javascript', body: opts.config });
    if (u.startsWith(base)) return route.continue();
    if (SBJS.test(u)) return route.fulfill({ status: 200, contentType: 'application/javascript', body: STUB });
    if (/cdn\.jsdelivr\.net\/npm\/three@/.test(u)) return route.fulfill({ status: 200, contentType: 'application/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: /build\/three\.module\.js/.test(u) ? THREE_STUB : THREE_ADDON_STUB });
    if (u.startsWith(API)) {
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      const pth = new URL(u).pathname;
      const auth = req.headers()['authorization'] || '';
      let body = null; try { body = req.postDataJSON(); } catch (e) { body = req.postData(); }
      rec.api.push({ path: pth, auth, body });
      const J = (status, obj, extra) => route.fulfill({ status, contentType: 'application/json', headers: Object.assign({}, CORS, extra || {}), body: JSON.stringify(obj) });
      if (pth === '/gl/auth/get-session') {
        if (auth === 'Bearer staff.SIGNED') return J(200, { session: { expiresAt: '2026-12-21T00:00:00.000Z' }, user: STAFF });
        if (auth === 'Bearer cust.SIGNED') return J(200, { session: { expiresAt: '2026-12-21T00:00:00.000Z' }, user: CUSTOMER });
        return J(401, { message: 'unauthenticated' });
      }
      if (pth === '/gl/auth/phone-number/send-otp') return J(200, { message: 'sent' });
      if (pth === '/gl/auth/phone-number/verify') return body && body.code === '123456' ? J(200, { status: true, token: 'raw', user: CUSTOMER }, { 'set-auth-token': 'cust.SIGNED' }) : J(400, { code: 'INVALID_OTP', message: 'Invalid OTP' });
      if (pth === '/gl/auth/sign-out') return J(200, { success: true });
      if (pth === '/gl/auth/sign-in/email') return body && body.password === 'pw' ? J(200, { token: 'raw', user: STAFF }, { 'set-auth-token': 'staff.SIGNED' }) : J(401, { message: 'Invalid email or password' });
      if (pth.startsWith('/gl/api/fn/')) {
        if (!/^Bearer (staff|cust)\.SIGNED$/.test(auth)) return J(401, { error: 'unauthenticated' });
        if (pth === '/gl/api/fn/doku/create') return J(200, { url: 'https://pay.mock/doku', order_ref: body && body.order_ref });
        return J(200, { ok: true, fn: pth.slice(11) });
      }
      if (pth === '/gl/api/db' || pth === '/gl/public/db') {
        if (pth === '/gl/api/db' && !/^Bearer (staff|cust)\.SIGNED$/.test(auth)) return J(401, { error: 'unauthenticated' });
        const one = body && (body.single || body.maybeSingle);
        const t = body && body.table;
        let data = (body && body.head) ? null : (one ? null : []);
        if (t === 'gl_profiles' && auth === 'Bearer cust.SIGNED') data = [{ id: CUSTOMER.id, name: 'Ali', phone: '60123456789' }];
        if (t === 'gl_vehicles' && one) data = { id: 'v1', make: 'Perodua', model: 'Myvi', plate: 'WXX1234', owner_id: 'p1' };
        if (t === 'gl_profiles' && body.filters && body.filters[0] && body.filters[0][1] === 'in') data = [{ id: 'p1', name: 'Ali', phone: '6012', email: 'a@x', tier: 'gold' }];
        return J(200, { data, error: null, count: 0 });
      }
      if (pth.startsWith('/gl/api/rpc/') || pth.startsWith('/gl/public/rpc/')) return J(200, { data: [], error: null });
      return J(404, { message: 'mock: no route ' + pth });
    }
    return route.abort();
  });
  try { await p.goto(base + '/' + page + (opts.query != null ? opts.query : '?backend=cf'), { waitUntil: 'load', timeout: 30000 }); } catch (e) { rec.errors.push('goto: ' + e.message.split('\n')[0]); }
  await p.waitForTimeout(opts.wait || 2500);
  return { ctx, p, rec };
}
async function ls(p) { return p.evaluate(() => { const o = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); o[k] = localStorage.getItem(k); } return o; }); }


// URL extras so link pages do real work
const EXTRA = { 'q.html': 'c=ABC123', 'gl-sa-accept.html': 't=TOK123', 'gl-inspect-view.html': 't=TOK123', 'gl-qc-view.html': 't=TOK123', 'receipt.html': 'id=INV-1', 'gl-warranty.html': 'plate=WXX1234' };
const withQ = (page, q) => { const e = EXTRA[page]; if (!e) return q; return q ? q + '&' + e : '?' + e; };
const STAFF_SEED = { gl_ba_token: 'staff.SIGNED', gl_auth: '{"keep":"old staff login"}' };
const FIRST_ELEVEN = ['gl-claim.html', 'gl-marketing.html', 'gl-ads.html', 'gl-mkt-calendar.html', 'gl-hub-v3.html', 'gl-platescan.html', 'gl-jobcard.html', 'gl-staff-appointment-FINAL.html', 'gl-customers.html', 'grandlab-pos-v2.html'];

(async () => {
  const o = await serve(ORIG), n = await serve(NEW);
  const browser = await chromium.launch();
  const failures = [];
  const ok = (cond, msg) => { if (!cond) failures.push(msg); };
  const t0 = Date.now();

  /* ---------------- A. switch OFF: identical to the unchanged pages ---------------- */
  const SB_SESSION = JSON.stringify({ access_token: 'old.jwt', refresh_token: 'r', expires_at: 1900000000, user: { id: CUSTOMER.id, phone: '60123456789' } });
  const runs = [];
  for (const page of PAGES) for (const mode of ['blocked', 'stub']) for (const q of ['', '?backend=sb']) runs.push({ page, mode, q: withQ(page, q) });
  runs.push({ page: 'index.html', mode: 'blocked', q: '', seed: { gl_session: SB_SESSION } });
  runs.push({ page: 'index.html', mode: 'blocked', q: '?backend=sb', seed: { gl_session: SB_SESSION } });
  runs.push({ page: 'gl-jobcard.html', mode: 'stub', q: '?plate=WXX1234&phone=0123456789' });
  runs.push({ page: 'grandlab-admin.html', mode: 'blocked', q: '', seed: { gl_svc_key: 'svc' } });
  const lines = await pool(runs, CONCURRENCY, async (r) => {
    const a = await record(browser, o.base, r.page, r.q, r.mode, r.seed);
    const b = await record(browser, n.base, r.page, r.q, r.mode, r.seed);
    const d = diff(a, b);
    const label = 'OFF ' + r.page + (r.q || '') + ' [' + r.mode + (r.seed ? ', ' + Object.keys(r.seed).join('+') : '') + ']';
    ok(!d.length, label + ' differs:\n  ' + d.join('\n  '));
    ok(!b.requests.some((x) => /gl-cf-(client|page)\.js/.test(x)), label + ': loaded gl-cf files with the switch off');
    ok(!('gl_backend' in b.localStorage), label + ': gl_backend set');
    ok(b.config.length >= 1 && a.config.length === 0, label + ': gl-backend-config.js not loaded (' + b.config.length + ')');
    return (d.length ? 'DIFF ' : 'same ') + label + '  (' + b.requests.length + ' requests, ' + b.console.length + ' console, ' + b.errors.length + ' errors)';
  });
  lines.forEach((l) => console.log(l));
  const compared = runs.length;
  console.log('-- A done: ' + compared + ' comparisons, ' + Math.round((Date.now() - t0) / 1000) + ' s');

  /* ---------------- B. switch ON (?backend=cf), mocked Worker: every page ---------------- */
  const onPages = PAGES.filter((x) => x !== 'index.html');
  const onLines = await pool(onPages, CONCURRENCY, async (page) => {
    const info = PAGE_INFO[page];
    const out = [];
    // B1. signed in as staff (the normal case for every page, also guest pages on a shop device)
    {
      const { ctx, p, rec } = await onRun(browser, n.base, page, { seed: STAFF_SEED, query: withQ(page, '?backend=cf') });
      if (page === 'gl-platescan.html') { await p.evaluate(() => doSearch('WXX1234')); await p.waitForTimeout(1500); }
      if (page === 'gl-hub-v3.html') { await p.evaluate(() => applyRoles('staff1@grandlab.com.my')); await p.waitForTimeout(300); }
      const st = await ls(p);
      const label = 'ON ' + page;
      ok(rec.supabase.length === 0, label + ': requests to the Supabase server: ' + rec.supabase.join(', '));
      const sbCalls = await p.evaluate(() => window.__sbCalls || []);
      ok(!sbCalls.some((u) => u.startsWith(SUPA)), label + ': real supabase-js client created for Grandlab: ' + sbCalls.join(','));
      ok(st.gl_backend === 'cf', label + ': switch not stored');
      ok(st.gl_auth === '{"keep":"old staff login"}', label + ': gl_auth (old staff login) changed');
      ok(rec.requests.some((x) => /gl-cf-client\.js/.test(x)) && rec.requests.some((x) => /gl-cf-page\.js/.test(x)), label + ': gl-cf files not loaded');
      const data = rec.api.filter((x) => /^\/gl\/(api|public)\/(db|rpc\/|fn\/|storage\/)/.test(x.path));
      if (FIRST_ELEVEN.includes(page)) ok(data.length > 0, label + ': no /gl/api/db or /rpc request');
      ok(data.every((x) => x.auth === 'Bearer staff.SIGNED' && x.path.startsWith('/gl/api/')), label + ': data request without the staff Bearer / not on /gl/api: ' + JSON.stringify(data.filter((x) => x.auth !== 'Bearer staff.SIGNED').map((x) => x.path)));
      ok(await p.locator('#glcf-pill').count() === 1, label + ': NEW SYSTEM tag missing');
      ok(await p.locator('#glcf-bar').count() === 0, label + ': "not signed in" bar while signed in');
      const cfErr = rec.errors.filter((e) => /glcf|GLCF|gl-cf/i.test(e));
      ok(!cfErr.length, label + ': errors from gl-cf: ' + cfErr.join(' | '));
      const pageVar = await p.evaluate(() => { try { return typeof sb !== 'undefined' && sb ? (sb._cf ? 'cf' : (sb._stub ? 'stub' : (typeof sb === 'function' ? 'fetch-helper' : 'other'))) : 'none'; } catch (e) { return 'none'; } });
      ok(pageVar === 'cf' || pageVar === 'none' || (pageVar === 'fetch-helper' && !/supabase-js@2/.test(fs.readFileSync(path.join(NEW, page), 'utf8'))), label + ': page client is ' + pageVar);
      if (page === 'q.html') {
        const landed = new URL(p.url()).pathname + new URL(p.url()).search;
        ok(landed === '/gl-customers.html', label + ': staff device not sent to the staff view: ' + landed);
        out.push('ON   q.html?c=ABC123 (staff signed in on the new system): referral code looked up on /gl/api/db -> ' + landed);
      }
      const tables = [...new Set(data.filter((x) => x.body && x.body.table).map((x) => x.body.table))];
      const rpcs = [...new Set(data.filter((x) => /\/rpc\//.test(x.path)).map((x) => x.path.replace(/^.*\/rpc\//, '')))];
      out.push('ON   ' + page + ' [' + info.module + (info.public ? ',public' : '') + (info.hubLogin ? ',hubLogin' : '') + ']: client=' + pageVar + ', ' + data.length + ' API calls' + (tables.length ? '; tables ' + tables.join(',') : '') + (rpcs.length ? '; rpc ' + rpcs.join(',') : '') + (rec.errors.length ? '; page errors: ' + rec.errors.join(' | ').slice(0, 200) : ''));
      const pollCheck = async (topic, table) => {
        const chans = await p.evaluate(() => GLCF_PAGE.client.getChannels().map((c) => c.topic + ':' + c.state));
        ok(chans.includes(topic + ':joined'), label + ': realtime channel not polling: ' + chans);
        if (!chans.includes(topic + ':joined')) return;
        const before = rec.api.filter((x) => x.body && x.body.table === table).length;
        await p.evaluate((t) => GLCF_PAGE.client.getChannels().filter((c) => c.topic === t)[0]._tick(), topic);
        await p.waitForTimeout(2200);   // gl-tower debounces its reload by 1.5 s
        const after = rec.api.filter((x) => x.body && x.body.table === table).length;
        ok(after > before, label + ': poll tick did not reload ' + table);
        const ms = await p.evaluate(() => GLCF_PAGE.cfg.pollMs || 30000);
        out.push('ON   ' + page + ': ' + topic + ' polls every ' + ms / 1000 + ' s (tick reloaded ' + table + ' ' + before + ' -> ' + after + ')');
      };
      if (page === 'gl-jobcard.html') await pollCheck('realtime:jobs-rt', 'gl_jobs');
      if (page === 'GLboard/gl-board.html') await pollCheck('realtime:board-rt', 'gl_jobs');
      if (page === 'gl-tower.html' || page === 'gl-tower-lite.html') await pollCheck('realtime:gl-tower-jobs', 'gl_jobs');
      if (page === 'gl-platescan.html') {
        const emb = rec.api.filter((x) => x.body && x.body.table === 'gl_profiles' && x.body.filters && x.body.filters[0][0] === 'id' && x.body.filters[0][1] === 'in');
        ok(emb.length >= 1, label + ': embedded gl_profiles(...) not fetched as a 2nd query');
        ok(/Ali/.test(await p.evaluate(() => document.body.innerText)), label + ': owner from the embedded profile not shown');
      }
      if (page === 'gl-hub-v3.html') {
        const gp = sbCalls.concat(await p.evaluate(() => window.__sbCalls || [])).filter((u) => u.indexOf('gpdb.grandlab.com.my') >= 0);
        ok(gp.length === 0, label + ': still creates a supabase-js client for the old Grandpride gateway');
        ok(rec.requests.every((x) => x.indexOf('gpdb.grandlab.com.my') < 0), label + ': request to gpdb.grandlab.com.my');
        const me = rec.api.filter((x) => x.path === '/gl/gpread/me');
        ok(me.length >= 1 && me.every((x) => x.auth === 'Bearer staff.SIGNED'), label + ': Grandpride staff check is not GET /gl/gpread/me with the staff token: ' + JSON.stringify(me));
      }
      if (page === 'gl-ads.html') {
        await p.evaluate(() => syncNow()); await p.waitForTimeout(800);
        const fn = rec.api.filter((x) => x.path === '/gl/api/fn/meta-sync');
        ok(fn.length === 1 && fn[0].auth === 'Bearer staff.SIGNED' && fn[0].body && fn[0].body.force === true, label + ': "Sync now" not sent to /gl/api/fn/meta-sync: ' + JSON.stringify(fn));
        out.push('ON   gl-ads.html: Sync now -> POST /gl/api/fn/meta-sync {force:true} with the staff token');
      }
      await ctx.close();
    }
    // B2. not signed in on the new system
    {
      const { ctx, p, rec } = await onRun(browser, n.base, page, { query: withQ(page, '?backend=cf') });
      const label = 'ON signed-out ' + page;
      ok(rec.supabase.length === 0, label + ': Supabase contacted: ' + rec.supabase.join(', '));
      const bar = await p.locator('#glcf-bar').textContent().catch(() => '');
      const data = rec.api.filter((x) => /^\/gl\/(api|public)\/(db|rpc\/)/.test(x.path));
      if (info.public) {
        ok(!bar, label + ': guest page shows the "not signed in" bar');
        ok(data.every((x) => x.path.startsWith('/gl/public/') && !x.auth), label + ': guest data not on /gl/public without a token: ' + JSON.stringify(data.map((x) => x.path + ' ' + x.auth)));
        out.push('ON   ' + page + ' (guest): ' + data.length + ' public calls ' + [...new Set(data.map((x) => x.path.replace('/gl/public/', '') + (x.body && x.body.table ? ':' + x.body.table : '')))].join(','));
      } else {
        const landed = new URL(p.url()).pathname.replace(/^\//, '');
        ok(/not signed in/.test(bar), label + ': bar missing');
        if (info.hubLogin && landed === page) ok(/Hub/.test(bar) && /sign in here/.test(bar), label + ': bar does not point to the Hub / offer a sign-in');
        if (landed !== page) out.push('ON   ' + page + ' (signed out): the page itself sends the user to ' + landed + ' (its own rule), bar shown there');
        ok(data.every((x) => !x.auth), label + ': token sent while signed out');
      }
      await ctx.close();
    }
    return out.join('\n');
  });
  onLines.forEach((l) => console.log(l));

  // B3. hubLogin page: the bar's own sign-in (gl-claim has no Grandlab staff login of its own)
  {
    const { ctx, p, rec } = await onRun(browser, n.base, 'gl-claim.html', {});
    await p.click('#glcf-signin');
    await p.fill('#glcf-em', 'admin@grandpride.com'); await p.fill('#glcf-pw', 'wrong'); await p.click('#glcf-go'); await p.waitForTimeout(500);
    ok(/Invalid/.test(await p.locator('#glcf-msg').textContent()), 'ON gl-claim: wrong password not shown');
    await p.fill('#glcf-pw', 'pw');
    await Promise.all([p.waitForNavigation({ timeout: 10000 }).catch(() => null), p.click('#glcf-go')]);
    await p.waitForTimeout(1500);
    const st = await ls(p);
    ok(st.gl_ba_token === 'staff.SIGNED', 'ON gl-claim: bar sign-in did not keep the token');
    ok(await p.locator('#glcf-bar').count() === 0 && await p.locator('#glcf-pill').count() === 1, 'ON gl-claim: still not signed in after the bar sign-in');
    ok(rec.api.some((x) => x.path === '/gl/api/db' && x.auth === 'Bearer staff.SIGNED'), 'ON gl-claim: no data read after signing in');
    console.log('ON   gl-claim.html: bar "sign in here" -> wrong password shown, then signed in (staff token), page reloads its data');
    await ctx.close();
  }
  // B4. grandlab-admin (service-key REST) -> /gl/api/db with the staff token
  {
    const { ctx, rec } = await onRun(browser, n.base, 'grandlab-admin.html', { seed: Object.assign({ gl_svc_key: 'svc' }, STAFF_SEED) });
    const data = rec.api.filter((x) => x.path === '/gl/api/db');
    ok(data.length > 3 && data.every((x) => x.auth === 'Bearer staff.SIGNED'), 'ON grandlab-admin: service-key REST not on /gl/api/db with the staff token');
    ok(rec.supabase.length === 0, 'ON grandlab-admin: Supabase contacted');
    console.log('ON   grandlab-admin.html: ' + data.length + ' service-key REST reads -> /gl/api/db with the staff token (' + [...new Set(data.map((x) => x.body.table))].join(',') + ')');
    await ctx.close();
  }

  /* customer PWA (index.html) */
  {
    const SB_SESSION2 = JSON.stringify({ access_token: 'old.jwt', refresh_token: 'r', expires_at: 1900000000, user: { id: CUSTOMER.id, phone: '60123456789' } });
    const { ctx, p, rec } = await onRun(browser, n.base, 'index.html', { seed: { gl_session: SB_SESSION2 } });
    let st = await ls(p);
    ok(st.gl_session_sb === SB_SESSION2 && !('gl_session' in st), 'ON index: old login not put aside: ' + JSON.stringify(st));
    ok(rec.supabase.length === 0, 'ON index: Supabase contacted: ' + rec.supabase.join(', '));
    const pub = rec.api.filter((x) => x.path === '/gl/public/db');
    ok(pub.length >= 3 && pub.every((x) => !x.auth), 'ON index: guest catalogue reads not on /gl/public/db without a token');
    ok(await p.locator('#glcf-pill').count() === 1, 'ON index: NEW SYSTEM tag missing');
    const sent = await p.evaluate(() => sendOtp('+60123456789'));
    ok(sent === true, 'ON index: sendOtp failed');
    ok(rec.api.some((x) => x.path === '/gl/auth/phone-number/send-otp' && x.body.phoneNumber === '+60123456789'), 'ON index: send-otp not called with +60…');
    const bad = await p.evaluate(() => verifyOtp('+60123456789', '000000'));
    ok(bad === null, 'ON index: wrong code accepted');
    const sess = await p.evaluate(() => verifyOtp('+60123456789', '123456'));
    ok(sess && sess.access_token === 'cust.SIGNED' && sess.user.id === CUSTOMER.id && sess.user.phone === '60123456789' && sess._cf === true, 'ON index: verify session wrong: ' + JSON.stringify(sess));
    await p.evaluate((s) => { localStorage.setItem('gl_session', JSON.stringify(s)); SESSION = s; return fetchProfile(); }, sess);
    const prof = rec.api.filter((x) => x.path === '/gl/api/db' && x.body.table === 'gl_profiles');
    ok(prof.length && prof[prof.length - 1].auth === 'Bearer cust.SIGNED', 'ON index: profile read not with the customer token');
    st = await ls(p);
    ok(st.gl_ba_token_cust === 'cust.SIGNED' && !('gl_ba_token' in st), 'ON index: customer token not kept apart from staff token');
    const refreshed = await p.evaluate(async () => { SESSION.expires_at = Math.floor(Date.now() / 1000) + 10; const r = await refreshSession(); return { r, tok: SESSION.access_token }; });
    ok(refreshed.r === true && refreshed.tok === 'cust.SIGNED', 'ON index: refreshSession failed ' + JSON.stringify(refreshed));
    // DOKU online payment: the page's own call (anon key in the headers) -> /gl/api/fn/doku/create with the customer token
    const pay = await p.evaluate(async () => { const r = await fetch(SENANGPAY_FN + '/create', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + SUPA_ANON, apikey: SUPA_ANON }, body: JSON.stringify({ order_ref: 'GL-T1', amount: 50 }) }); return { status: r.status, j: await r.json() }; });
    const dk = rec.api.filter((x) => x.path === '/gl/api/fn/doku/create');
    ok(pay.status === 200 && pay.j.url === 'https://pay.mock/doku' && dk.length === 1 && dk[0].auth === 'Bearer cust.SIGNED' && dk[0].body.order_ref === 'GL-T1', 'ON index: DOKU create not routed ' + JSON.stringify({ pay, dk }));
    const notify = await p.evaluate(async () => { const r = await fetch(SENANGPAY_FN + '/notify', { method: 'POST', body: '{}' }); return r.status; });
    ok(notify === 400, 'ON index: doku/notify not blocked');
    ok(rec.supabase.length === 0, 'ON index: Supabase contacted after login: ' + rec.supabase.join(', '));
    console.log('ON   index.html: old login put aside; ' + pub.length + ' public reads without token; SMS login -> ' + sess.user.id + '; refresh ok; DOKU create -> /gl/api/fn/doku/create (customer token); /notify blocked');
    await p.goto(n.base + '/index.html', { waitUntil: 'load' }); await p.waitForTimeout(2000);
    st = await ls(p);
    ok(st.gl_session && JSON.parse(st.gl_session)._cf && st.gl_ba_token_cust === 'cust.SIGNED', 'ON index reload: lost the new-system login');
    await p.evaluate(() => { localStorage.removeItem('gl_session'); });
    await p.goto(n.base + '/index.html', { waitUntil: 'load' }); await p.waitForTimeout(1500);
    st = await ls(p);
    ok(!('gl_ba_token_cust' in st), 'ON index: token kept after the page logged out');
    ok(rec.api.some((x) => x.path === '/gl/auth/sign-out'), 'ON index: no sign-out after logout');
    await p.evaluate((s) => localStorage.setItem('gl_session', s), JSON.stringify(Object.assign({}, sess)));
    await ctx.route(SUPA + '/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify([{ id: CUSTOMER.id, name: 'Ali' }]) }));
    await p.goto(n.base + '/index.html?backend=sb', { waitUntil: 'load' }); await p.waitForTimeout(1500);
    st = await ls(p);
    ok(st.gl_session === SB_SESSION2 && !('gl_session_sb' in st) && !('gl_backend' in st), 'ON->OFF index: old login not restored: ' + JSON.stringify(st));
    console.log('OFF  index.html?backend=sb after cf: old Supabase login restored, switch cleared');
    await ctx.close();
  }

  /* ---------------- C. go-live setting per module (gl-backend-config.js served with other words) ---------------- */
  const cfgSrc = fs.readFileSync(path.join(NEW, 'gl-backend-config.js'), 'utf8');
  const withWords = (def, mods) => cfgSrc.replace('window.GL_BACKEND_DEFAULT = "sb";', 'window.GL_BACKEND_DEFAULT = "' + def + '";')
    .replace(/core:\s*"sb"/, 'core:      "' + mods.core + '"').replace(/customer:\s*"sb"/, 'customer:  "' + mods.customer + '"')
    .replace(/marketing:\s*"sb"/, 'marketing: "' + mods.marketing + '"').replace(/claim:\s*"sb"/, 'claim:     "' + mods.claim + '"');
  {
    const CLAIM_ONLY = withWords('sb', { core: 'sb', customer: 'sb', marketing: 'sb', claim: 'cf' });
    ok(CLAIM_ONLY !== cfgSrc && /claim:\s*"cf"/.test(CLAIM_ONLY), 'C: could not build the test setting');
    // claim page: new system with NO ?backend=cf, no tag (go-live), no gl_backend stored
    let r = await onRun(browser, n.base, 'gl-claim.html', { config: CLAIM_ONLY, query: '', seed: STAFF_SEED });
    let st = await ls(r.p);
    ok(r.rec.requests.some((x) => /gl-cf-client\.js/.test(x)), 'C claim=cf: gl-claim not on the new system');
    ok(!('gl_backend' in st), 'C claim=cf: device choice stored without ?backend');
    ok(await r.p.locator('#glcf-pill').count() === 0, 'C claim=cf: NEW SYSTEM tag shown after go-live');
    ok(r.rec.supabase.length === 0 && r.rec.api.some((x) => x.path.startsWith('/gl/api/')), 'C claim=cf: gl-claim not using the API');
    // same device, Hub (core still "sb"): old system
    await r.p.goto(n.base + '/gl-hub-v3.html', { waitUntil: 'load' }); await r.p.waitForTimeout(1500);
    const hubCf = await r.p.evaluate(() => !!window.GLCF_PAGE);
    ok(!hubCf, 'C claim=cf: gl-hub-v3 (core "sb") switched too');
    // emergency fallback on the claim page: remembered
    await r.p.goto(n.base + '/gl-claim.html?backend=sb', { waitUntil: 'load' }); await r.p.waitForTimeout(800);
    st = await ls(r.p);
    ok(st.gl_backend === 'sb' && !(await r.p.evaluate(() => !!window.GLCF_PAGE)), 'C claim=cf: ?backend=sb not a remembered fallback');
    await r.p.goto(n.base + '/gl-claim.html', { waitUntil: 'load' }); await r.p.waitForTimeout(800);
    ok(!(await r.p.evaluate(() => !!window.GLCF_PAGE)), 'C claim=cf: fallback forgotten on the next visit');
    await r.p.goto(n.base + '/gl-claim.html?backend=auto', { waitUntil: 'load' }); await r.p.waitForTimeout(800);
    st = await ls(r.p);
    ok(!('gl_backend' in st) && (await r.p.evaluate(() => !!window.GLCF_PAGE)), 'C claim=cf: ?backend=auto does not follow the setting again');
    console.log('GO-LIVE claim="cf": gl-claim on the new system without ?backend=cf and without the tag; gl-hub-v3 (core "sb") unchanged; ?backend=sb remembered fallback; ?backend=auto back to the setting');
    await r.ctx.close();
    // the same setting with core pages: an OFF core page is identical to today (no cf files)
    r = await onRun(browser, n.base, 'gl-jobcard.html', { config: CLAIM_ONLY, query: '', seed: STAFF_SEED });
    ok(!r.rec.requests.some((x) => /gl-cf-(client|page)\.js/.test(x)), 'C claim=cf: gl-jobcard loaded gl-cf files');
    await r.ctx.close();
    // marketing flipped: marketing pages + winback move, claim does not
    const MKT = withWords('sb', { core: 'sb', customer: 'sb', marketing: 'cf', claim: 'sb' });
    const mk = [];
    for (const pg of ['gl-marketing.html', 'gl-ads.html', 'gl-mkt-calendar.html', 'grandlab-winback.html', 'gl-claim.html', 'gl-hub-v3.html']) {
      const x = await onRun(browser, n.base, pg, { config: MKT, query: '', seed: STAFF_SEED, wait: 1200 });
      const on = await x.p.evaluate(() => !!window.GLCF_PAGE);
      ok(on === (PAGE_INFO[pg].module === 'marketing'), 'C marketing=cf: ' + pg + ' on=' + on);
      mk.push(pg + '=' + (on ? 'cf' : 'sb'));
      await x.ctx.close();
    }
    console.log('GO-LIVE marketing="cf": ' + mk.join(' '));
    // everything through GL_BACKEND_DEFAULT ("default" modules): customer app on the new system, no tag
    const ALL = withWords('cf', { core: 'default', customer: 'default', marketing: 'default', claim: 'default' });
    r = await onRun(browser, n.base, 'index.html', { config: ALL, query: '' });
    ok(await r.p.evaluate(() => !!window.GLCF_PAGE) && await r.p.locator('#glcf-pill').count() === 0 && r.rec.supabase.length === 0, 'C default=cf: customer app not on the new system (or tag shown)');
    await r.ctx.close();
    r = await onRun(browser, n.base, 'GLboard/gl-board.html', { config: ALL, query: '', seed: STAFF_SEED });
    ok(await r.p.evaluate(() => !!window.GLCF_PAGE) && r.rec.supabase.length === 0, 'C default=cf: TV board not on the new system');
    await r.ctx.close();
    console.log('GO-LIVE GL_BACKEND_DEFAULT="cf" + modules "default": customer app and TV board on the new system, no tag');
  }

  await browser.close(); o.server.close(); n.server.close();
  console.log('\n' + compared + ' switch-OFF comparisons over ' + PAGES.length + ' pages; ' + onPages.length + ' pages switched ON; ' + Math.round((Date.now() - t0) / 1000) + ' s; ' + (failures.length ? failures.length + ' FAILURES:\n- ' + failures.join('\n- ') : 'all checks passed'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
