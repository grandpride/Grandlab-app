// Run: node tests/gl-switch.playwright.cjs <dir with the UNCHANGED pages>
// Headless Chromium (playwright, preinstalled). Nothing reaches the internet: every external request is aborted,
// supabase-js is replaced by a local stub (same "var supabase=" shape as the real bundle), the new API is mocked.
//
// A. Switch OFF: every changed page, unchanged copy vs this copy, must give IDENTICAL console messages, page errors,
//    requested URLs, localStorage and page text (Date and Math.random are frozen so runs are comparable), and must
//    never request gl-cf-client.js / gl-cf-page.js. Modes: all external blocked / supabase-js stub signed in;
//    plain URL and ?backend=sb; index.html also with a saved customer login.
// B. Switch ON (?backend=cf), mocked Worker: pages talk to /gl/api/* with the Bearer token and never to Supabase,
//    the Grandpride gp_staff check still uses supabase-js, realtime polls, the customer PWA logs in by SMS code,
//    keeps the old login aside and gets it back with ?backend=sb, DOKU payment is blocked.
'use strict';
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const NEW = path.resolve(__dirname, '..');
const ORIG = path.resolve(process.argv[2] || '');
if (!process.argv[2] || !fs.existsSync(path.join(ORIG, 'index.html'))) { console.error('usage: node tests/gl-switch.playwright.cjs <dir with unchanged pages>'); process.exit(2); }

const PAGES = ['gl-claim.html', 'gl-marketing.html', 'gl-ads.html', 'gl-mkt-calendar.html', 'index.html', 'gl-hub-v3.html',
  'gl-platescan.html', 'gl-jobcard.html', 'gl-staff-appointment-FINAL.html', 'gl-customers.html', 'grandlab-pos-v2.html'];
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
    if (u.startsWith(base)) return route.continue();
    if (SBJS.test(u)) return route.fulfill({ status: 200, contentType: 'application/javascript', body: STUB });
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

(async () => {
  const o = await serve(ORIG), n = await serve(NEW);
  const browser = await chromium.launch();
  const failures = [];
  const ok = (cond, msg) => { if (!cond) failures.push(msg); };
  let compared = 0;

  /* A */
  const SB_SESSION = JSON.stringify({ access_token: 'old.jwt', refresh_token: 'r', expires_at: 1900000000, user: { id: CUSTOMER.id, phone: '60123456789' } });
  const runs = [];
  for (const page of PAGES) for (const mode of ['blocked', 'stub']) for (const q of ['', '?backend=sb']) runs.push({ page, mode, q });
  runs.push({ page: 'index.html', mode: 'blocked', q: '', seed: { gl_session: SB_SESSION } });
  runs.push({ page: 'index.html', mode: 'blocked', q: '?backend=sb', seed: { gl_session: SB_SESSION } });
  runs.push({ page: 'gl-jobcard.html', mode: 'stub', q: '?plate=WXX1234&phone=0123456789' });
  for (const r of runs) {
    const a = await record(browser, o.base, r.page, r.q, r.mode, r.seed);
    const b = await record(browser, n.base, r.page, r.q, r.mode, r.seed);
    const d = diff(a, b);
    const label = 'OFF ' + r.page + (r.q || '') + ' [' + r.mode + (r.seed ? ', saved login' : '') + ']';
    ok(!d.length, label + ' differs:\n  ' + d.join('\n  '));
    ok(!b.requests.some((x) => /gl-cf-(client|page)\.js/.test(x)), label + ': loaded gl-cf files with the switch off');
    ok(!('gl_backend' in b.localStorage), label + ': gl_backend set');
    compared++;
    console.log((d.length ? 'DIFF ' : 'same ') + label + '  (' + b.requests.length + ' requests, ' + b.console.length + ' console, ' + b.errors.length + ' errors)');
  }

  /* B */
  const staffPages = PAGES.filter((x) => x !== 'index.html');
  for (const page of staffPages) {
    const { ctx, p, rec } = await onRun(browser, n.base, page, { seed: { gl_ba_token: 'staff.SIGNED', gl_auth: '{"keep":"old staff login"}' } });
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
    const data = rec.api.filter((x) => /^\/gl\/api\/(db|rpc\/)/.test(x.path));
    ok(data.length > 0, label + ': no /gl/api/db or /rpc request');
    ok(data.every((x) => x.auth === 'Bearer staff.SIGNED'), label + ': data request without the staff Bearer token');
    ok(await p.locator('#glcf-pill').count() === 1, label + ': NEW SYSTEM tag missing');
    const cfErr = rec.errors.filter((e) => /glcf|GLCF|gl-cf/i.test(e));
    ok(!cfErr.length, label + ': errors from gl-cf: ' + cfErr.join(' | '));
    const pageVar = await p.evaluate(() => { try { return typeof sb !== 'undefined' && sb ? (sb._cf ? 'cf' : (sb._stub ? 'stub' : 'other')) : 'none'; } catch (e) { return 'none'; } });
    ok(pageVar === 'cf' || pageVar === 'none', label + ': page client is ' + pageVar);
    const tables = [...new Set(data.filter((x) => x.body && x.body.table).map((x) => x.body.table))];
    const rpcs = [...new Set(data.filter((x) => x.path.startsWith('/gl/api/rpc/')).map((x) => x.path.slice(12)))];
    console.log('ON   ' + page + ': client=' + pageVar + ', ' + data.length + ' API calls; tables ' + tables.join(',') + (rpcs.length ? '; rpc ' + rpcs.join(',') : '') + (rec.errors.length ? '; page errors: ' + rec.errors.join(' | ').slice(0, 300) : ''));
    if (page === 'gl-jobcard.html') {
      const chans = await p.evaluate(() => GLCF_PAGE.client.getChannels().map((c) => c.topic + ':' + c.state));
      ok(chans.join() === 'realtime:jobs-rt:joined', label + ': realtime channel not polling: ' + chans);
      const before = rec.api.filter((x) => x.body && x.body.table === 'gl_jobs').length;
      await p.evaluate(() => GLCF_PAGE.client.getChannels()[0]._tick());
      await p.waitForTimeout(800);
      const after = rec.api.filter((x) => x.body && x.body.table === 'gl_jobs').length;
      ok(after > before, label + ': poll tick did not reload gl_jobs');
      console.log('ON   gl-jobcard.html: jobs-rt polls (tick reloaded gl_jobs ' + before + ' -> ' + after + ')');
    }
    if (page === 'gl-platescan.html') {
      const emb = rec.api.filter((x) => x.body && x.body.table === 'gl_profiles' && x.body.filters && x.body.filters[0][0] === 'id' && x.body.filters[0][1] === 'in');
      ok(emb.length >= 1, label + ': embedded gl_profiles(...) not fetched as a 2nd query');
      const shown = await p.evaluate(() => document.body.innerText);
      ok(/Ali/.test(shown), label + ': owner from the embedded profile not shown');
      console.log('ON   gl-platescan.html: search WXX1234 -> vehicle + embedded owner (2nd query) shown');
    }
    if (page === 'gl-hub-v3.html') {
      const gp = sbCalls.concat(await p.evaluate(() => window.__sbCalls || [])).filter((u) => u.indexOf('gpdb.grandlab.com.my') >= 0);
      ok(gp.length >= 1, label + ': Grandpride gp_staff check no longer uses supabase-js');
    }
    await ctx.close();
  }
  // not signed in on the new system: staff page shows the bar; gl-claim says "sign in on the Hub"
  for (const page of ['gl-claim.html', 'gl-jobcard.html']) {
    const { ctx, p, rec } = await onRun(browser, n.base, page, {});
    const bar = await p.locator('#glcf-bar').textContent().catch(() => '');
    ok(/not signed in/.test(bar), 'ON signed-out ' + page + ': bar missing');
    if (page === 'gl-claim.html') ok(/Hub/.test(bar), 'ON signed-out gl-claim: bar does not point to the Hub');
    ok(rec.supabase.length === 0, 'ON signed-out ' + page + ': Supabase contacted');
    console.log('ON   ' + page + ' (signed out): bar "' + bar.slice(0, 70) + '…"');
    await ctx.close();
  }

  // customer PWA
  {
    const SB_SESSION2 = JSON.stringify({ access_token: 'old.jwt', refresh_token: 'r', expires_at: 1900000000, user: { id: CUSTOMER.id, phone: '60123456789' } });
    const { ctx, p, rec } = await onRun(browser, n.base, 'index.html', { seed: { gl_session: SB_SESSION2 } });
    let st = await ls(p);
    ok(st.gl_session_sb === SB_SESSION2 && !('gl_session' in st), 'ON index: old login not put aside: ' + JSON.stringify(st));
    ok(rec.supabase.length === 0, 'ON index: Supabase contacted: ' + rec.supabase.join(', '));
    const pub = rec.api.filter((x) => x.path === '/gl/public/db');
    ok(pub.length >= 3 && pub.every((x) => !x.auth), 'ON index: guest catalogue reads not on /gl/public/db without a token');
    ok(await p.locator('#glcf-pill').count() === 1, 'ON index: NEW SYSTEM tag missing');
    // SMS login through the page's own functions (sendOtp / verifyOtp -> /auth/v1 -> Better Auth)
    const sent = await p.evaluate(() => sendOtp('+60123456789'));
    ok(sent === true, 'ON index: sendOtp failed');
    ok(rec.api.some((x) => x.path === '/gl/auth/phone-number/send-otp' && x.body.phoneNumber === '+60123456789'), 'ON index: send-otp not called with +60…');
    const bad = await p.evaluate(() => verifyOtp('+60123456789', '000000'));
    ok(bad === null, 'ON index: wrong code accepted');
    const sess = await p.evaluate(() => verifyOtp('+60123456789', '123456'));
    ok(sess && sess.access_token === 'cust.SIGNED' && sess.user.id === CUSTOMER.id && sess.user.phone === '60123456789' && sess._cf === true, 'ON index: verify session wrong: ' + JSON.stringify(sess));
    // what the page does next: store it, read the profile with the user token
    await p.evaluate((s) => { localStorage.setItem('gl_session', JSON.stringify(s)); SESSION = s; return fetchProfile(); }, sess);
    const prof = rec.api.filter((x) => x.path === '/gl/api/db' && x.body.table === 'gl_profiles');
    ok(prof.length && prof[prof.length - 1].auth === 'Bearer cust.SIGNED', 'ON index: profile read not with the customer token');
    st = await ls(p);
    ok(st.gl_ba_token_cust === 'cust.SIGNED' && !('gl_ba_token' in st), 'ON index: customer token not kept apart from staff token');
    // refresh (page calls it on start and every 45 min)
    const refreshed = await p.evaluate(async () => { SESSION.expires_at = Math.floor(Date.now() / 1000) + 10; const r = await refreshSession(); return { r, tok: SESSION.access_token }; });
    ok(refreshed.r === true && refreshed.tok === 'cust.SIGNED', 'ON index: refreshSession failed ' + JSON.stringify(refreshed));
    // DOKU online payment is blocked (it reads the OLD database)
    const pay = await p.evaluate(async () => { const r = await fetch(SENANGPAY_FN + '/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); return { status: r.status, j: await r.json() }; });
    ok(pay.status === 400 && /Online payment is not on the new system/.test(pay.j.message), 'ON index: DOKU not blocked ' + JSON.stringify(pay));
    ok(rec.supabase.length === 0, 'ON index: Supabase contacted after login: ' + rec.supabase.join(', '));
    console.log('ON   index.html: old login put aside; ' + pub.length + ' public reads without token; SMS login -> ' + sess.user.id + '; refresh ok; DOKU blocked (' + pay.status + ')');
    // reload while signed in: stays signed in (cf session kept)
    await p.goto(n.base + '/index.html', { waitUntil: 'load' }); await p.waitForTimeout(2000);
    st = await ls(p);
    ok(st.gl_session && JSON.parse(st.gl_session)._cf && st.gl_ba_token_cust === 'cust.SIGNED', 'ON index reload: lost the new-system login');
    // page logout clears gl_session -> next load ends the new-system session too
    await p.evaluate(() => { localStorage.removeItem('gl_session'); });
    await p.goto(n.base + '/index.html', { waitUntil: 'load' }); await p.waitForTimeout(1500);
    st = await ls(p);
    ok(!('gl_ba_token_cust' in st), 'ON index: token kept after the page logged out');
    ok(rec.api.some((x) => x.path === '/gl/auth/sign-out'), 'ON index: no sign-out after logout');
    // switch back: the old login returns
    await p.evaluate((s) => localStorage.setItem('gl_session', s), JSON.stringify(Object.assign({}, sess)));
    // switched off the page talks to Supabase again: answer its profile read so it keeps the restored login
    await ctx.route(SUPA + '/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify([{ id: CUSTOMER.id, name: 'Ali' }]) }));
    await p.goto(n.base + '/index.html?backend=sb', { waitUntil: 'load' }); await p.waitForTimeout(1500);
    st = await ls(p);
    ok(st.gl_session === SB_SESSION2 && !('gl_session_sb' in st) && !('gl_backend' in st), 'ON->OFF index: old login not restored: ' + JSON.stringify(st));
    console.log('OFF  index.html?backend=sb after cf: old Supabase login restored, switch cleared');
    await ctx.close();
  }

  await browser.close(); o.server.close(); n.server.close();
  console.log('\n' + compared + ' switch-OFF comparisons; ' + (failures.length ? failures.length + ' FAILURES:\n- ' + failures.join('\n- ') : 'all checks passed'));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
