// Run: node tests/gl-gp-read.playwright.cjs          (headless Chromium via playwright, preinstalled; NODE_PATH may need the playwright folder)
// The 16 pages that used to read Grandpride data from the dead gateway gpdb.grandlab.com.my (docs/cf-migration-gl.md), loaded for real
// on BOTH backend settings with a mocked Worker (GET /gl/gpread/*): "sb" = a stubbed supabase-js session + gl_auth in localStorage,
// "cf" = ?backend=cf + a Cloudflare token (the real gl-cf-client.js / gl-cf-page.js run). Nothing reaches the internet.
//   per guard page: staff with the app opens / staff without the app and "not in the list" get NO ACCESS / server error lets the
//   person in (GLGP.GUARD_FAIL_OPEN) and, with the flag flipped to false, blocks / reception makes no check call at all.
//   always: 0 requests to gpdb.grandlab.com.my, one GET /gl/gpread/me with the right Bearer.
//   gl-tower(-lite): liveData() uses the tower view (people + presence + fleet) and falls back when it fails.
//   gl-academy: staff sync + "who am I".   gl-hub / gl-hub-v3: tiles hidden by apps, everything shown when the check fails.
'use strict';
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const API = 'https://gl-api.jimmykuek94.workers.dev';
const SBJS = /^https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@2/;
const GUARD = ['gl-academy', 'gl-agents', 'gl-commission-centre', 'gl-commission', 'gl-daily', 'gl-inspect', 'gl-jobcard', 'gl-ladder', 'gl-platescan', 'gl-qc-addon', 'gl-qc', 'gl-statement', 'gl-tower-lite', 'gl-tower'];
const HUBS = ['gl-hub', 'gl-hub-v3'];
const APP_OF = { 'gl-academy': 'academy', 'gl-agents': 'agentdesk', 'gl-commission-centre': 'commission', 'gl-commission': 'commission', 'gl-daily': 'daily', 'gl-inspect': 'inspect', 'gl-jobcard': 'joborder', 'gl-ladder': 'ladder', 'gl-platescan': 'platescan', 'gl-qc-addon': 'qc', 'gl-qc': 'qc', 'gl-statement': 'statement', 'gl-tower-lite': 'tower', 'gl-tower': 'tower' };
const CONCURRENCY = Number(process.env.PW_CONCURRENCY || 6);
const SB_TOKEN = 'SB.JWT.TOKEN', CF_TOKEN = 'staff.SIGNED';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-bucket, x-path, x-upsert', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Expose-Headers': 'set-auth-token' };

/* supabase-js stand-in: signed-in session for window.__email, records client URLs (window.__sbCalls) */
const STUB = `var supabase=(function(){
  function res(){ return {data:[],error:null,count:0,status:200,statusText:'OK'}; }
  function chain(){ var p=new Proxy(function(){},{get:function(t,k){
      if(k==='then') return function(a,b){ return Promise.resolve(res()).then(a,b); };
      if(k==='catch') return function(b){ return Promise.resolve(res()).catch(b); };
      if(k==='finally') return function(f){ return Promise.resolve(res()).finally(f); };
      return p; }, apply:function(){ return p; }}); return p; }
  function createClient(url){
    (window.__sbCalls=window.__sbCalls||[]).push(String(url));
    var session = window.__email ? {access_token:'${SB_TOKEN}',user:{id:'u1',email:window.__email}} : null;
    return { _stub:true,
      auth:{ getSession:function(){return Promise.resolve({data:{session:session},error:null});},
             getUser:function(){return Promise.resolve({data:{user:session&&session.user},error:null});},
             signInWithPassword:function(){return Promise.resolve({data:{},error:{message:'stub'}});},
             signOut:function(){return Promise.resolve({error:null});},
             onAuthStateChange:function(){return {data:{subscription:{unsubscribe:function(){}}}};} },
      from:function(){return chain();}, rpc:function(){return chain();},
      storage:{from:function(){return {upload:function(){return Promise.resolve({data:null,error:{message:'stub'}});},getPublicUrl:function(p){return {data:{publicUrl:'stub://'+p}};},remove:function(){return Promise.resolve({data:[],error:null});}};}},
      channel:function(){ var c={on:function(){return c;},subscribe:function(){return c;},unsubscribe:function(){return Promise.resolve('ok');}}; return c; },
      removeChannel:function(){return Promise.resolve('ok');},
      functions:{invoke:function(){return Promise.resolve({data:null,error:{message:'stub'}});}} };
  }
  return {createClient:createClient};
})();`;
const THREE_NAMES = [...new Set((fs.readFileSync(path.join(ROOT, 'gl-tower.html'), 'utf8').match(/THREE\.([A-Za-z0-9_]+)/g) || []).map((x) => x.slice(6)))];
const ANY = `const H={get(t,k){if(k==='domElement')return t.__el||(t.__el=document.createElement('div'));if(k===Symbol.toPrimitive)return()=>0;if(k==='then')return undefined;if(k==='length')return 0;if(k===Symbol.iterator)return function*(){};if(!(k in t))t[k]=U;return t[k]},set(t,k,v){t[k]=v;return true},apply(){return U},construct(){return U}};const U=new Proxy(function(){},H);`;
const THREE_STUB = ANY + THREE_NAMES.map((n) => 'export const ' + n + '=U;').join('');
const THREE_ADDON_STUB = ANY + 'export const OrbitControls=U,CSS2DRenderer=U,CSS2DObject=U,mergeGeometries=U;';

function serve(dir) {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.png': 'image/png', '.json': 'application/json' };
  return new Promise((resolve) => {
    const s = http.createServer((q, r) => {
      let p = decodeURIComponent(new URL(q.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html';
      const f = path.join(dir, p);
      if (!f.startsWith(dir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); r.end('not found'); return; }
      r.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); fs.createReadStream(f).pipe(r);
    });
    s.listen(0, '127.0.0.1', () => resolve({ server: s, base: 'http://127.0.0.1:' + s.address().port }));
  });
}
async function pool(items, n, fn) { const out = new Array(items.length); let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } })); return out; }

/* One page load. sc = { email, me: {status,json}|'down', tower:{...}, staffApps:{...}, flag: true|false } */
async function load(browser, base, page, setting, sc) {
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  await ctx.addInitScript((o) => {
    window.__email = o.email;
    if (o.setting === 'sb') localStorage.setItem('gl_auth', JSON.stringify({ access_token: o.sbToken, refresh_token: 'r', user: { email: o.email } }));
    else localStorage.setItem('gl_ba_token', o.cfToken);
  }, { email: sc.email, setting, sbToken: SB_TOKEN, cfToken: CF_TOKEN });
  const p = await ctx.newPage();
  const rec = { gpdb: [], gp: [], errors: [], supabaseServer: [] };
  p.on('pageerror', (e) => rec.errors.push(e.message));
  p.on('request', (r) => { const u = r.url(); if (/gpdb\.grandlab\.com\.my/.test(u)) rec.gpdb.push(u); if (/db\.grandlab\.com\.my/.test(u) && !/gpdb/.test(u)) rec.supabaseServer.push(u); });
  await ctx.route('**/*', async (route) => {
    const req = route.request(), u = req.url();
    if (u.startsWith(base)) {
      if (sc.flag === false && /\/gl-gp-read\.js$/.test(u)) { const src = fs.readFileSync(path.join(ROOT, 'gl-gp-read.js'), 'utf8').replace('var GUARD_FAIL_OPEN = true;', 'var GUARD_FAIL_OPEN = false;'); return route.fulfill({ status: 200, contentType: 'application/javascript', body: src }); }
      return route.continue();
    }
    if (SBJS.test(u)) return route.fulfill({ status: 200, contentType: 'application/javascript', body: STUB });
    if (/cdn\.jsdelivr\.net\/npm\/three@/.test(u)) return route.fulfill({ status: 200, contentType: 'application/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: /build\/three\.module\.js/.test(u) ? THREE_STUB : THREE_ADDON_STUB });
    if (u.startsWith(API)) {
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
      const pth = new URL(u).pathname, auth = req.headers()['authorization'] || '';
      const J = (status, obj) => route.fulfill({ status, contentType: 'application/json', headers: CORS, body: JSON.stringify(obj) });
      if (pth.startsWith('/gl/gpread/')) {
        const view = pth.slice('/gl/gpread/'.length);
        rec.gp.push({ view, auth, method: req.method() });
        const s = view === 'me' ? sc.me : view === 'tower' ? sc.tower : view === 'staff-apps' ? sc.staffApps : null;
        if (!s || s === 'down') return route.abort();
        return J(s.status, s.json);
      }
      if (pth === '/gl/auth/get-session') return auth === 'Bearer ' + CF_TOKEN ? J(200, { session: { expiresAt: '2027-01-01T00:00:00.000Z' }, user: { id: 'u1', email: sc.email, name: 'T', role: 'staff', emailVerified: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } }) : J(401, { message: 'unauthenticated' });
      if (pth === '/gl/api/db' || pth === '/gl/public/db') {
        let body = null; try { body = req.postDataJSON(); } catch (e) {}
        const t = body && body.table; let data = body && body.head ? null : (body && (body.single || body.maybeSingle) ? null : []);
        if (t === 'gl_team') data = [{ name: 'Fallback Fred', side: 'detailing', active: true, gp_username: 'mixed', apps: [] }];
        return J(200, { data, error: null, count: 0 });
      }
      if (pth.startsWith('/gl/api/rpc/') || pth.startsWith('/gl/public/rpc/')) return J(200, { data: [], error: null });
      return J(200, { data: [], error: null });
    }
    return route.abort();
  });
  try { await p.goto(base + '/' + page + '.html' + (setting === 'cf' ? '?backend=cf' : ''), { waitUntil: 'load', timeout: 30000 }); } catch (e) { rec.errors.push('goto: ' + e.message.split('\n')[0]); }
  await p.waitForTimeout(sc.wait || 1800);
  return { ctx, p, rec };
}
const denied = (p) => p.evaluate(() => /NO ACCESS/.test(document.body ? document.body.innerText : ''));
const R = (status, json) => ({ status, json });
const ME = (apps, name) => R(200, { data: { username: 'mixed', name: name || 'Mixed Case', apps }, master: false, error: null });

(async () => {
  const srv = await serve(ROOT);
  const browser = await chromium.launch();
  const failures = []; const ok = (c, m) => { if (!c) failures.push(m); };
  let n = 0; const count = (c, m) => { n++; ok(c, m); };
  const SETTINGS = ['sb', 'cf'];
  const tokenOf = (s) => 'Bearer ' + (s === 'sb' ? SB_TOKEN : CF_TOKEN);
  const jobs = [];
  if (!process.env.PW_SKIP_GUARD) for (const setting of SETTINGS) for (const page of GUARD.filter((x) => !process.env.PW_PAGES || process.env.PW_PAGES.split(',').includes(x))) jobs.push({ setting, page }); // PW_SKIP_GUARD=1: only the tower / academy / hub parts

  const lines = await pool(jobs, CONCURRENCY, async ({ setting, page }) => {
    const app = APP_OF[page], L = page + ' [' + setting + ']';
    const staffEmail = 'mixed@example.test';
    const common = async (sc, label) => { const r = await load(browser, srv.base, page, setting, sc); count(r.rec.gpdb.length === 0, L + ' ' + label + ': request to gpdb.grandlab.com.my: ' + r.rec.gpdb.join(',')); return r; };
    // 1 staff with the app -> opens, one GET /me with the right Bearer
    { const r = await common({ email: staffEmail, me: ME([app, 'hub']), tower: R(200, { staff: [], attendance: [], fleet: [], error: null }), staffApps: R(200, { data: [], error: null }) }, 'with app');
      const me = r.rec.gp.filter((x) => x.view === 'me');
      count(me.length === (page === 'gl-academy' ? 2 : 1) && me.every((x) => x.auth === tokenOf(setting) && x.method === 'GET'), L + ' with app: GET /gl/gpread/me x' + (page === 'gl-academy' ? 2 : 1) + ' with ' + tokenOf(setting) + ', got ' + JSON.stringify(me));
      count(!(await denied(r.p)), L + ' with app: page shows NO ACCESS');
      count(r.rec.supabaseServer.length === 0, L + ' with app: request to the Supabase server');
      await r.ctx.close(); }
    // 2 staff without the app, 3 not in the staff list -> NO ACCESS
    for (const [label, me] of [['without the app', ME(['hub'], 'Mixed Case')], ['not in the staff list', R(200, { data: null, master: false, error: null })]]) {
      const r = await common({ email: staffEmail, me }, label);
      count(await denied(r.p), L + ' ' + label + ': page did not show NO ACCESS');
      if (label === 'without the app') count((await r.p.evaluate(() => document.body.innerText)).includes('Hi Mixed Case'), L + ': deny text lost the name');
      await r.ctx.close();
    }
    // 4 server error / network down / not-signed-in answer -> let in (flag true); 5 flag false -> NO ACCESS
    for (const [label, me] of [['Worker 500', R(500, { data: null, error: { code: '500', message: 'could not read' } })], ['Worker 401', R(401, { data: null, error: { code: '401', message: 'Not signed in' } })], ['Worker unreachable', 'down']]) {
      const r = await common({ email: staffEmail, me }, label);
      count(!(await denied(r.p)), L + ' ' + label + ': person was locked out although the check could not run');
      await r.ctx.close();
      const r2 = await common({ email: staffEmail, me, flag: false }, label + ' + GUARD_FAIL_OPEN=false');
      count(await denied(r2.p), L + ' ' + label + ' with GUARD_FAIL_OPEN=false: not blocked');
      await r2.ctx.close();
    }
    // 6 reception (admin@grandpride.com): no check call at all from the guard
    { const r = await common({ email: 'admin@grandpride.com', me: R(500, {}), tower: R(200, { staff: [], attendance: [], fleet: [], error: null }), staffApps: R(200, { data: [], error: null }) }, 'reception');
      // the guard itself makes no call for reception; gl-academy's own identify() (who is this person?) is the one allowed /me call
      count(r.rec.gp.filter((x) => x.view === 'me').length === (page === 'gl-academy' ? 1 : 0), L + ' reception: unexpected /gl/gpread/me calls: ' + r.rec.gp.filter((x) => x.view === 'me').length);
      count(!(await denied(r.p)), L + ' reception: NO ACCESS');
      await r.ctx.close(); }
    return 'ok   ' + L + ' (open / no app / not listed / 500 / 401 / unreachable / flag false / reception)';
  });
  lines.forEach((l) => console.log(l));

  /* ---- gl-tower + gl-tower-lite: the live data (gl-tower-lite: liveData(); gl-tower is a module, so read what it draws) ---- */
  const TOWER = { staff: [{ username: 'mixed', name: 'Mixed Case', company: 'Grandlab', title: 'Advisor', is_chauffeur: false, chauffeur_status: 'ready' }, { username: 'drv', name: 'Driver D', company: 'Grandpride', title: 'Chauffeur', is_chauffeur: true, chauffeur_status: 'busy' }],
    attendance: [{ username: 'mixed', rec: { amIn: '09:00' } }, { username: 'drv', rec: { amIn: '08:00', leave: true } }], fleet: [{ plate: 'GP1', model: 'Roma', status: 'available', car_type: 'Supercar', colour: 'Red' }], error: null };
  const seen = async (r, page) => {
    if (page === 'gl-tower-lite') return r.p.evaluate(async () => { const x = await liveData(); return { people: x.people, fleet: x.fleet, gpOk: x.gpOk }; });
    return r.p.evaluate(() => ({ footer: (document.getElementById('f_upd') || {}).textContent || '', text: document.body.innerText }));
  };
  for (const setting of SETTINGS) for (const page of ['gl-tower', 'gl-tower-lite']) {
    const L = page + ' [' + setting + ']';
    let r = await load(browser, srv.base, page, setting, { email: 'admin@grandpride.com', tower: R(200, TOWER), wait: 3000 });
    count(!r.rec.gpdb.length, L + ': gpdb request');
    let d = await seen(r, page);
    if (page === 'gl-tower-lite') count(d.gpOk === true && d.people.length === 2 && d.people.find((x) => x.id === 'drv').chauffeur === true && d.people.find((x) => x.id === 'mixed').rec.amIn === '09:00' && d.people.find((x) => x.id === 'drv').rec.leave === true && d.fleet.length === 1 && d.fleet[0].plate === 'GP1', L + ': liveData people/presence/fleet wrong: ' + JSON.stringify(d));
    else count(!/attendance offline/.test(d.footer) && /GP FLEET READY\s*1\/1/.test(d.text), L + ': footer "' + d.footer + '" / Grandpride fleet not drawn (1/1): ' + d.text.slice(0, 300).replace(/\n/g, ' | '));
    const towerCalls = r.rec.gp.filter((x) => x.view === 'tower');
    count(towerCalls.length >= 1 && towerCalls.every((x) => x.auth === tokenOf(setting)), L + ': tower calls ' + JSON.stringify(towerCalls));
    await r.ctx.close();
    for (const [label, tower] of [['500', R(500, { data: null, error: { code: '500', message: 'x' } })], ['403', R(403, { data: null, error: { code: '42501', message: 'No access' } })], ['down', 'down']]) {
      r = await load(browser, srv.base, page, setting, { email: 'admin@grandpride.com', tower, wait: 3000 });
      d = await seen(r, page);
      if (page === 'gl-tower-lite') count(d.gpOk === false && d.fleet.length === 0 && (setting === 'sb' || d.people.length >= 1) && d.people.every((x) => x.unknown === true && x.company === 'Grandlab'), L + ' tower ' + label + ': no fall back to gl_team: ' + JSON.stringify(d));
      else count(/attendance offline/.test(d.footer) && !/GP FLEET READY\s*1\/1/.test(d.text), L + ' tower ' + label + ': footer "' + d.footer + '"');
      await r.ctx.close();
    }
    console.log('ok   ' + L + ': tower view -> people + presence + fleet; 500 / 403 / unreachable -> gl_team fallback (attendance offline)');
  }

  /* ---- gl-academy: sync + identify ---- */
  for (const setting of SETTINGS) {
    const L = 'gl-academy [' + setting + ']';
    const r = await load(browser, srv.base, 'gl-academy', setting, { email: 'mixed@example.test', me: ME(['academy']), staffApps: R(200, { data: [{ username: 'mixed', name: 'Mixed Case', role: 'staff', apps: ['academy', 'tower'] }], error: null }) });
    const out = await r.p.evaluate(async () => { TEAM = [{ name: 'Fred', gp_username: 'mixed', apps: [], gp_role: null }, { name: 'Nobody', gp_username: 'zzz', apps: ['x'], gp_role: null }]; await syncFromGP(); const who = await identify(); return { t0: TEAM[0].apps, role: TEAM[0].gp_role, t1: TEAM[1].apps, who }; });
    count(JSON.stringify(out) === JSON.stringify({ t0: ['academy', 'tower'], role: 'staff', t1: ['x'], who: 'Fred' }), L + ': sync/identify: ' + JSON.stringify(out));
    count(r.rec.gp.some((x) => x.view === 'staff-apps' && x.auth === tokenOf(setting)), L + ': no staff-apps call with the token');
    await r.ctx.close();
    const r2 = await load(browser, srv.base, 'gl-academy', setting, { email: 'mixed@example.test', me: ME(['academy']), staffApps: R(403, { data: null, error: { code: '42501', message: 'No access' } }) });
    const out2 = await r2.p.evaluate(async () => { TEAM = [{ name: 'Fred', gp_username: 'mixed', apps: ['keep'], gp_role: 'old' }]; await syncFromGP(); return { apps: TEAM[0].apps, role: TEAM[0].gp_role }; });
    count(JSON.stringify(out2) === JSON.stringify({ apps: ['keep'], role: 'old' }), L + ': failed sync changed TEAM: ' + JSON.stringify(out2));
    await r2.ctx.close();
    const r3 = await load(browser, srv.base, 'gl-academy', setting, { email: 'mixed@example.test', me: 'down' });
    const who3 = await r3.p.evaluate(async () => { TEAM = [{ name: 'Fred', gp_username: 'mixed', apps: [] }]; return await identify(); });
    count(who3 === '', L + ': identify() with the Worker down returned ' + who3);
    await r3.ctx.close();
    console.log('ok   ' + L + ': staff-apps sync updates only matching people; failed sync changes nothing; identify() by own row / "" when down');
  }

  /* ---- hubs: tiles ---- */
  for (const setting of SETTINGS) {
    for (const page of HUBS) {
      const L = page + ' [' + setting + ']';
      const probe = async (sc) => {
        const r = await load(browser, srv.base, page, setting, sc);
        if (page === 'gl-hub-v3') { await r.p.evaluate((e) => { try { SB_OK = true; } catch (x) {} return applyRoles(e); }, sc.email); await r.p.waitForTimeout(400); }
        const vis = await r.p.evaluate(() => { const o = {}; document.querySelectorAll('a.tile').forEach((a) => { const f = (a.getAttribute('href') || '').split('/').pop().split('?')[0]; o[f] = a.style.display !== 'none'; }); return o; });
        await r.ctx.close(); return { vis, rec: r.rec };
      };
      const a = await probe({ email: 'mixed@example.test', me: ME(['qc']) });
      count(a.rec.gpdb.length === 0, L + ': gpdb request');
      count(a.vis['gl-qc.html'] === true && a.vis['gl-qc-addon.html'] === true && a.vis['gl-platescan.html'] === false && a.vis['gl-jobcard.html'] === false && a.vis['gl-tower.html'] === false, L + ' apps ["qc"]: tiles ' + JSON.stringify(a.vis));
      count(a.rec.gp.some((x) => x.view === 'me' && x.auth === tokenOf(setting)), L + ': no /me call with the token: ' + JSON.stringify(a.rec.gp));
      const b = await probe({ email: 'mixed@example.test', me: R(500, { data: null, error: { code: '500', message: 'x' } }) });
      count(Object.values(b.vis).length > 5 && Object.values(b.vis).every(Boolean), L + ' Worker 500: some tile hidden: ' + JSON.stringify(b.vis));
      const c = await probe({ email: 'mixed@example.test', me: 'down' });
      count(Object.values(c.vis).every(Boolean), L + ' Worker unreachable: some tile hidden');
      const d = await probe({ email: 'mixed@example.test', me: R(200, { data: null, master: false, error: null }) });
      count(Object.values(d.vis).every(Boolean), L + ' not in the staff list: tiles hidden (old behaviour: show all)');
      const e = await probe({ email: 'admin@grandpride.com', me: ME([]) });
      count(e.rec.gp.filter((x) => x.view === 'me').length === 0 && Object.values(e.vis).every(Boolean), L + ' reception: check call made or tile hidden');
      console.log('ok   ' + L + ': apps ["qc"] hides the other tiles; Worker 500 / down / not listed / reception show everything (reception makes no call)');
    }
  }

  await browser.close(); srv.server.close();
  console.log('\n' + (n - failures.length) + ' checks passed, ' + failures.length + ' failed (counted checks: ' + n + ')');
  if (failures.length) { failures.slice(0, 40).forEach((f) => console.log('FAIL ' + f)); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(2); });
