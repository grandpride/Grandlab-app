/* ============================================================
   gl-cf-page.js — new-backend glue for Grandlab pages (adapted from the Hub's cf-page.js)

   LOADED ONLY WHEN THE SWITCH IS ON, by the small guard <script> in each page, right after gl-cf-client.js:
   gl-backend-config.js says "cf" for the page's module (go-live setting) or this device chose ?backend=cf
   (localStorage.gl_backend). Switch off = this file is never downloaded.

   window.GLCF_PAGE_CFG (set by the guard):
     page      name shown in the console
     customer  true on the customer PWA (index.html): its own login token key (gl_ba_token_cust), so a
               customer's SMS login never mixes with the staff (reception) login on a shared shop device —
               the same split as today's gl_session (customers) vs gl_auth (staff)
     module    go-live module of the page (core | customer | marketing | claim), see gl-backend-config.js
     hubLogin  true on pages with no staff login of their own (gl-claim, gl-sa-admin, grandlab-admin, …): the bar
               says "sign in on the Hub" and offers a small staff sign-in form (email + password, new system)
     public    true on pages used without a login (customer / partner links, shop kiosks, TV board): no bar; with no
               login, data calls go to the public routes (/gl/public/*) like the anon key today
     restAuth  "token": the page calls Supabase REST with fetch() using a service/anon key but means "the staff login"
               (grandlab-admin, grandlab-pos): such calls go to /gl/api/* with the staff token
     pollMs    realtime polling interval (default 30000; TV board 15000)

   What it does (switch on only):
   1. supabase.createClient(<Grandlab Supabase URL>, ...) returns the gl cf-client instead, so the pages keep
      their sb.* code. Other URLs (the Grandpride gp_staff access check) still get real supabase-js.
      Pages that load supabase-js twice (gl-jobcard, gl-platescan) re-apply this with GLCF_PAGE.rewrap().
   2. fetch() to the Grandlab Supabase server (/rest/v1, /rest/v1/rpc, /storage/v1/object, /auth/v1) is answered
      by GLCF.handleSupabaseFetch -> the new API. /functions/v1/<name> goes to the new server route in
      GLCF.FUNCTION_ROUTES (gl-cf-client.js: POST /gl/api/fn/<name>, DOKU create -> /gl/api/fn/doku/create, push-send -> /gl/api/push/send);
      a route set to null there is blocked with a clear error.
   3. Customer PWA only: a login saved by the old system (localStorage.gl_session) is put aside as gl_session_sb
      (the guard puts it back on ?backend=sb), and a new-system token without a matching gl_session is signed out
      (that is what the page's own logout leaves behind).
   4. Shows who is on what: a small "NEW SYSTEM" tag; on staff pages a bar when not signed in on the new system.
   ============================================================ */
(function (g) {
  'use strict';
  var CFG = g.GLCF_PAGE_CFG || {};
  if (!g.GLCF || !g.GLCF.createClient || !g.GLCF.handleSupabaseFetch) {
    try { g.console.warn('[gl-cf-page] gl-cf-client.js did not load — this page stays on the current system'); } catch (e) {}
    return;
  }
  var SB_ORIGINS = ['https://db.grandlab.com.my', 'https://eychljpzorzmaveixlnu.supabase.co'];
  var TOKEN_KEY = CFG.customer ? 'gl_ba_token_cust' : 'gl_ba_token';
  var realFetch = g.fetch ? g.fetch.bind(g) : null;
  var client = g.GLCF.createClient({
    tenant: 'gl',
    storageKey: TOKEN_KEY,
    guestPublic: !!CFG.public,
    realtimePollMs: CFG.pollMs != null ? CFG.pollMs : 30000,
    fetch: realFetch ? function (u, i) { return realFetch(u, i); } : undefined
  });

  function lsGet(k) { try { return g.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { if (v == null) g.localStorage.removeItem(k); else g.localStorage.setItem(k, v); } catch (e) {} }

  /* ---- 3. customer PWA: keep the old login aside, drop a stale new-system token ---- */
  function isCfSession(s) { try { var o = JSON.parse(s); return !!(o && o._cf); } catch (e) { return false; } }
  if (CFG.customer) {
    var sess = lsGet('gl_session');
    if (sess && !isCfSession(sess)) { lsSet('gl_session_sb', sess); lsSet('gl_session', null); sess = null; }
    if (client.auth.token() && !sess) {
      // page logged out (it only clears gl_session) -> end the new-system session too
      client.auth.signOut();
    }
  }

  function origins() {
    var list = SB_ORIGINS.slice();
    /* global SUPABASE_URL, SUPA_URL, SB_URL */
    try { if (typeof SUPABASE_URL === 'string' && SUPABASE_URL) list.push(new URL(SUPABASE_URL).origin); } catch (e) {}
    try { if (typeof SUPA_URL === 'string' && SUPA_URL) list.push(new URL(SUPA_URL).origin); } catch (e) {}
    try { if (typeof SB_URL === 'string' && SB_URL) list.push(new URL(SB_URL).origin); } catch (e) {}
    return list;
  }
  function isSupabaseUrl(url) {
    try { return origins().indexOf(new URL(String(url), g.location.href).origin) >= 0; } catch (e) { return false; }
  }
  function jsonResp(status, obj) {
    return Promise.resolve(new g.Response(JSON.stringify(obj), { status: status, headers: { 'Content-Type': 'application/json; charset=utf-8' } }));
  }

  var announced = false;
  function announce(how) {
    if (announced) return; announced = true;
    try { g.console.info('[gl-cf-page] ' + (CFG.page || 'page') + ' is using the NEW backend (Cloudflare) via ' + how + '. Turn off with ?backend=sb'); } catch (e) {}
  }

  /* ---- 1. supabase-js pages: createClient -> cf client ----
     The real supabase-js bundle starts with "var supabase=…", i.e. a non-configurable global: we can replace its
     value but not trap a later re-assignment. Pages that load supabase-js a second time (gl-jobcard,
     gl-platescan) therefore call GLCF_PAGE.rewrap() from a one-line guard right after that second tag. */
  var rewrap = function () {};
  (function () {
    function wrap(lib) {
      if (lib && lib.__glcfWrapped) return lib;
      var origCreate = lib && lib.createClient;
      var w = {};
      if (lib) { for (var k in lib) { try { w[k] = lib[k]; } catch (e) {} } }
      w.createClient = function (url) {
        if (isSupabaseUrl(url)) { announce('supabase.createClient'); return client; }
        if (origCreate) return origCreate.apply(lib, arguments);
        throw new Error('supabase-js is not loaded');
      };
      try { Object.defineProperty(w, '__glcfWrapped', { value: true }); } catch (e) { w.__glcfWrapped = true; }
      return w;
    }
    var current = wrap(g.supabase);
    try {
      // when window.supabase is still configurable (not created by "var"), also wrap any later re-assignment
      Object.defineProperty(g, 'supabase', { configurable: true, enumerable: true, get: function () { return current; }, set: function (v) { current = wrap(v); } });
    } catch (e) { try { g.supabase = current; } catch (x) {} }
    rewrap = function () { try { g.supabase = wrap(g.supabase); } catch (e) {} };
  })();

  /* ---- 2. direct REST (customer PWA): fetch() to Supabase -> new API ---- */
  if (realFetch) {
    g.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && typeof input.href === 'string' ? input.href : null);
      if (url == null && input && typeof input.url === 'string' && isSupabaseUrl(input.url)) {
        return jsonResp(400, { code: 'CF_UNSUPPORTED', message: 'gl-cf-page: fetch(Request) to Supabase is not supported on the new backend yet', details: null, hint: 'Switch back with ?backend=sb' });
      }
      if (url != null && isSupabaseUrl(url)) {
        var path = '';
        try { path = new URL(url, g.location.href).pathname; } catch (e) {}
        if (path.indexOf('/functions/v1/') === 0) {
          announce('fetch adapter');
          var fp = g.GLCF.handleFunctionFetch(client, url, init);
          if (fp) return fp;
        }
        announce('fetch adapter');
        var staffRest = CFG.restAuth === 'token';
        if (path.indexOf('/auth/v1/') !== 0 && !client.auth.token() && (staffRest || !g.GLCF.isAnonRequest(init))) {
          return jsonResp(401, { code: '401', message: 'Not signed in (new backend). Sign in again, or use ?backend=sb', details: null, hint: null });
        }
        var p = g.GLCF.handleSupabaseFetch(client, url, init, staffRest ? { anon: false } : undefined);
        if (p) return p;
      } else if (init && typeof init.body === 'string' && g.GLCF.storageUrlsToSigned && init.body.indexOf('/storage/v1/object/') >= 0) {
        var nb = g.GLCF.storageUrlsToSigned(client, init.body);
        if (nb !== init.body) { var ni = {}; for (var k in init) ni[k] = init[k]; ni.body = nb; return realFetch(input, ni); }
      }
      return realFetch(input, init);
    };
  }

  /* ---- 4. status UI ---- */
  var inFrame = false;
  try { inFrame = g.top !== g.self; } catch (e) { inFrame = true; }
  function backUrl() {
    try { var u = new URL(g.location.href); u.searchParams.set('backend', 'sb'); return u.href; } catch (e) { return '?backend=sb'; }
  }
  function el(html) { var d = g.document.createElement('div'); d.innerHTML = html; return d.firstChild; }
  // the tag is for devices switched BY HAND (?backend=cf); after go-live (module set to "cf") nobody sees it
  function byHand() {
    try { if (typeof g.GL_BACKEND_SOURCE === 'function') return g.GL_BACKEND_SOURCE(CFG.module) === 'device'; } catch (e) {}
    return true;
  }
  // small staff sign-in (new system) for pages without a login of their own
  function signInForm() {
    if (!bar) return;
    bar.innerHTML = 'New system sign-in: <input id="glcf-em" type="email" placeholder="email" autocomplete="username" style="font:inherit;padding:3px 6px;border-radius:6px;border:0;margin:2px;width:170px;color:#111"> ' +
      '<input id="glcf-pw" type="password" placeholder="password" autocomplete="current-password" style="font:inherit;padding:3px 6px;border-radius:6px;border:0;margin:2px;width:130px;color:#111"> ' +
      '<button id="glcf-go" type="button" style="font:inherit;padding:3px 10px;border-radius:6px;border:0;background:#fff;color:#b45309;cursor:pointer">Sign in</button> <span id="glcf-msg"></span>';
    var go = g.document.getElementById('glcf-go');
    go.onclick = function () {
      var em = g.document.getElementById('glcf-em').value, pw = g.document.getElementById('glcf-pw').value;
      var msg = g.document.getElementById('glcf-msg');
      msg.textContent = '…';
      client.auth.signInWithPassword({ email: em, password: pw }).then(function (r) {
        if (r.error) { msg.textContent = r.error.message || 'Sign-in failed'; return; }
        g.location.reload();
      });
    };
  }
  var bar = null, pill = null;
  function clear() { [bar, pill].forEach(function (x) { if (x && x.parentNode) x.parentNode.removeChild(x); }); bar = pill = null; }
  var FONT = 'font:600 13px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif';
  function render() {
    var d = g.document; if (!d || !d.body) return;
    clear();
    var signedIn = !!client.auth.token();
    if (signedIn || CFG.customer || CFG.public) {
      if (inFrame || !byHand()) return;   // gl-hub-v3 shows staff pages in frames: one tag (the Hub's) is enough
      pill = el('<div id="glcf-pill" style="position:fixed;left:8px;bottom:8px;z-index:2147483000;' + FONT + ';font-size:11px;background:#1d4ed8;color:#fff;border-radius:999px;padding:4px 10px;opacity:.9;box-shadow:0 1px 4px rgba(0,0,0,.3);pointer-events:auto">NEW SYSTEM · <a href="' + backUrl() + '" target="_top" style="color:#fff;text-decoration:underline">switch back</a></div>');
      d.body.appendChild(pill);
    } else {
      var msg = CFG.hubLogin
        ? 'New system: not signed in. Sign in on the Hub (reception login) first, <a href="#" id="glcf-signin" style="color:#fff;text-decoration:underline">sign in here</a>, or '
        : 'New system: not signed in — sign in again on this page, or ';
      bar = el('<div id="glcf-bar" role="status" style="position:fixed;left:0;right:0;top:0;z-index:2147483000;background:#b45309;color:#fff;padding:8px 12px;text-align:center;' + FONT + '">' +
        msg + '<a href="' + backUrl() + '" target="_top" style="color:#fff;text-decoration:underline">use the current system (?backend=sb)</a></div>');
      d.body.appendChild(bar);
      var sl = d.getElementById('glcf-signin');
      if (sl) sl.onclick = function (e) { e.preventDefault(); signInForm(); };
    }
  }
  function onReady(fn) {
    if (g.document.readyState === 'loading') g.document.addEventListener('DOMContentLoaded', fn); else fn();
  }
  onReady(render);
  try { g.addEventListener('storage', function (e) { if (e.key === TOKEN_KEY) render(); }); } catch (e) {}
  var lastTok = client.auth.token();
  setInterval(function () { var t = client.auth.token(); if (t !== lastTok) { lastTok = t; render(); } }, 1500);

  // share link for a server function (gl-inspect "share inspection"): new server link, or null (page keeps its own)
  function functionLink(name, query) { try { return g.GLCF.functionLink(client, name, query); } catch (e) { return null; } }

  g.GLCF_PAGE = { client: client, cfg: CFG, tokenKey: TOKEN_KEY, isSupabaseUrl: isSupabaseUrl, render: render, rewrap: function () { rewrap(); }, functionLink: functionLink };
})(window);
