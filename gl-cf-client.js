/* ============================================================
   gl-cf-client.js — supabase-js-shaped client for the new Grandlab backend
   (gl-api on Cloudflare Workers + D1, Better Auth login). Tenant "gl".

   Adapted from the Grandpride Hub cf-client.js (same query JSON, same storage calls).
   Grandlab additions:
     - customer SMS login:  auth.signInWithOtp({phone}) / auth.verifyOtp({phone, token, type:'sms'})
                            -> POST /gl/auth/phone-number/send-otp | /gl/auth/phone-number/verify
                            Malaysian numbers are normalised first (01x… -> +601x…).
     - direct Supabase auth REST used by the customer PWA (index.html):
                            /auth/v1/otp, /auth/v1/verify, /auth/v1/token?grant_type=refresh_token|password,
                            /auth/v1/logout, /auth/v1/user  (answers look like Supabase's)
     - "anon" requests (the page sent the public anon key, no user login) go to /gl/public/db and
       /gl/public/rpc/:name (no token), so guests can still read the shop catalogue.
     - embedded selects for the two relations the staff pages use, done here as a 2nd query:
         gl_vehicles -> gl_profiles(...)   (object, via gl_vehicles.owner_id = gl_profiles.id)
         gl_profiles -> gl_vehicles(...)   (array,  via gl_vehicles.owner_id = gl_profiles.id)
     - realtime: client.channel(...).on('postgres_changes', …).subscribe() POLLS (callbacks run every
       realtimePollMs while the page is visible, and when it becomes visible again). Off when realtimePollMs is 0.

   OFF BY DEFAULT. Pages only load this when the switch is on:
     localStorage.gl_backend === "cf"     (?backend=cf sets it, ?backend=sb clears it)
   The small guard <script> in each page loads this file + gl-cf-page.js ONLY when the switch is on.

   Not supported yet (fail soft: console.warn + {error:{code:"CF_UNSUPPORTED"}}): see GLCF.UNSUPPORTED.
   Plain browser JS, no build step, no CDN.
   ============================================================ */
(function (g) {
  'use strict';

  var DEFAULT_API = 'https://gl-api.jimmykuek94.workers.dev';
  var SWITCH_KEY = 'gl_backend';
  var API_KEY = 'gl_api_base';          // optional override, e.g. http://localhost:8787 for testing
  var UNSUPPORTED_CODE = 'CF_UNSUPPORTED';
  var SUPABASE_ORIGIN = 'https://db.grandlab.com.my';   // the Grandlab Supabase server today

  /* ---------- tiny storage helpers (never throw) ---------- */
  function lsGet(k) { try { return g.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { if (v == null) g.localStorage.removeItem(k); else g.localStorage.setItem(k, v); } catch (e) {} }

  /* ---------- switch ---------- */
  function applyUrlSwitch(search) {
    try {
      var s = search != null ? search : (g.location && g.location.search) || '';
      var m = /[?&]backend=(cf|sb)(?:&|$)/.exec(s);
      if (m) { if (m[1] === 'cf') lsSet(SWITCH_KEY, 'cf'); else lsSet(SWITCH_KEY, null); }
    } catch (e) {}
    return enabled();
  }
  function enabled() { return lsGet(SWITCH_KEY) === 'cf'; }

  /* ---------- fail-soft helpers ---------- */
  var warned = {};
  function warnOnce(what) {
    if (warned[what]) return;
    warned[what] = true;
    try { g.console && g.console.warn('[gl-cf-client] not supported on the new backend yet: ' + what); } catch (e) {}
  }
  function unsupportedError(what) {
    warnOnce(what);
    return { message: 'gl-cf-client: ' + what + ' is not supported on the new backend yet', code: UNSUPPORTED_CODE, details: null, hint: 'Switch back with ?backend=sb' };
  }

  // Features this client does not provide yet (documented in docs/cf-migration-gl.md)
  var UNSUPPORTED = [
    'realtime: broadcast / presence (send, track); postgres_changes is POLLED (no row payload, no filter)',
    'storage: move, copy, createSignedUploadUrl, uploadToSignedUrl, upload(FormData), list({search} or sortBy other than name asc), download/createSignedUrl with {transform|download}',
    'direct Supabase REST (handleSupabaseFetch): or/and/not.<op> other than not.is, offset without limit, filters on insert, Prefer resolution=ignore-duplicates, GET rpc, Request objects, public storage GETs, /auth/v1 other than otp/verify/token/logout/user',
    'edge functions: client.functions.invoke(); direct fetch to /functions/v1/* is blocked by gl-cf-page.js',
    'client.schema() (non-public schemas)',
    'embedded selects other than gl_vehicles->gl_profiles(...) and gl_profiles->gl_vehicles(...); nested embeds; aliases "a:b"; "x!inner(..)"; embeds after a write',
    'filters: contains, containedBy, overlaps, textSearch, range*, likeAllOf/AnyOf, not() with any op except "is"',
    'more than one or() per query; or()/order()/limit() with foreignTable/referencedTable',
    'upsert({ignoreDuplicates:true}); csv(); explain(); geojson()',
    'filters/modifiers chained after rpc()',
    'auth: signUp, OTP by WhatsApp, phone + password, sign-up by email code (shouldCreateUser:true), magic/invite/recovery links, resetPasswordForEmail, updateUser for anything except password, setSession, admin API'
  ];

  /* ---------- Malaysian phone numbers -> E.164 (+60…) ----------
     "012-345 6789" / "0123456789" -> +60123456789 ; "60123456789" -> +60123456789 ;
     "123456789" -> +60123456789 ; "+60 12-345 6789" -> +60123456789.
     The server only accepts +60 numbers (anything else gets a clear error from the server). */
  function normalizePhone(p) {
    var s = String(p == null ? '' : p).trim();
    var plus = s.charAt(0) === '+';
    var d = s.replace(/\D/g, '');
    if (!d) return '';
    if (plus) return '+' + d;
    if (d.charAt(0) === '0') return '+6' + d;
    if (d.indexOf('60') === 0) return '+' + d;
    return '+60' + d;
  }

  /* ---------- user / session mapping (Better Auth -> supabase-js shape) ---------- */
  var TEMP_EMAIL_RE = /@phone\.grandlab\.invalid$/i;   // server's placeholder email for SMS-only customers
  function mapUser(u) {
    if (!u) return null;
    var out = {};
    for (var k in u) if (Object.prototype.hasOwnProperty.call(u, k)) out[k] = u[k];
    var tempEmail = TEMP_EMAIL_RE.test(String(u.email || ''));
    out.aud = 'authenticated';
    out.role = 'authenticated';
    out.email = tempEmail ? '' : (u.email || '');
    out.phone = u.phoneNumber ? String(u.phoneNumber).replace(/\D/g, '') : '';   // Supabase keeps digits only (60123456789)
    out.user_metadata = { name: u.name || null, full_name: u.name || null };
    out.app_metadata = { provider: (tempEmail || (!u.email && u.phoneNumber)) ? 'phone' : 'email', role: u.role || null };
    out.email_confirmed_at = (u.emailVerified && !tempEmail) ? (u.updatedAt || u.createdAt || null) : null;
    out.phone_confirmed_at = u.phoneNumberVerified ? (u.updatedAt || u.createdAt || null) : null;
    out.created_at = u.createdAt || null;
    out.updated_at = u.updatedAt || null;
    return out;
  }
  function mapSession(token, s, u) {
    if (!token || !u) return null;
    var exp = s && s.expiresAt ? Math.floor(Date.parse(s.expiresAt) / 1000) : null;
    return { access_token: token, token_type: 'bearer', expires_at: exp, expires_in: exp ? Math.max(0, exp - Math.floor(Date.now() / 1000)) : null, refresh_token: null, user: mapUser(u) };
  }

  /* ---------- embedded selects done on the client (2nd query) ----------
     table -> { embeddedTable: { local: column on table, foreign: column on embeddedTable, one: object (true) or array (false) } } */
  var DEFAULT_EMBEDS = {
    gl_vehicles: { gl_profiles: { local: 'owner_id', foreign: 'id', one: true } },
    gl_profiles: { gl_vehicles: { local: 'id', foreign: 'owner_id', one: false } }
  };
  function splitTop(s) {
    var out = [], cur = '', d = 0, q = false;
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (ch === '"') q = !q;
      if (!q && ch === '(') d++;
      if (!q && ch === ')') d--;
      if (!q && d === 0 && ch === ',') { out.push(cur); cur = ''; continue; }
      cur += ch;
    }
    out.push(cur);
    return out.filter(function (x) { return x !== ''; });
  }
  function hasCol(list, c) { return list.indexOf('*') >= 0 || list.indexOf(c) >= 0; }

  /* ============================================================
     createClient
     opts: tenant ('gl'), storageKey ('gl_ba_token'), apiBase, fetch, sessionCacheMs,
           realtimePollMs (0 = channels are inert stubs), embeds (relation map), publicRpcs
     ============================================================ */
  function createClient(opts) {
    opts = opts || {};
    var tenant = opts.tenant || 'gl';
    var storageKey = opts.storageKey || (tenant + '_ba_token');
    var EMBEDS = opts.embeds || DEFAULT_EMBEDS;
    function apiBase() { return String(opts.apiBase || lsGet(API_KEY) || DEFAULT_API).replace(/\/+$/, ''); }
    function doFetch(url, init) { var f = opts.fetch || g.fetch; return f.call(g, url, init); }
    function token() { return lsGet(storageKey); }
    function setToken(t) { lsSet(storageKey, t || null); }

    /* ---------- auth ---------- */
    var listeners = [];
    var subSeq = 0;
    var cache = null;           // { at, session, user }
    var CACHE_MS = opts.sessionCacheMs != null ? opts.sessionCacheMs : 60000;
    var pendingReset = null;    // { email, otp } between verifyOtp and updateUser({password})

    function emit(ev, session) {
      listeners.slice().forEach(function (l) { try { l.cb(ev, session); } catch (e) {} });
    }

    function authCall(path, method, body) {
      var headers = { 'Content-Type': 'application/json' };
      var t = token(); if (t) headers.Authorization = 'Bearer ' + t;
      var init = { method: method || 'POST', headers: headers, credentials: 'omit' };
      if (body !== undefined) init.body = JSON.stringify(body);
      return Promise.resolve().then(function () { return doFetch(apiBase() + '/' + tenant + '/auth' + path, init); }).then(function (res) {
        var nt = res.headers && res.headers.get ? res.headers.get('set-auth-token') : null;
        return res.json().catch(function () { return null; }).then(function (json) {
          if (!res.ok) {
            return { data: null, newToken: null, error: { name: 'AuthApiError', status: res.status, code: (json && json.code) || String(res.status), message: (json && (json.message || json.error)) || res.statusText || ('HTTP ' + res.status) } };
          }
          return { data: json, newToken: nt, error: null };
        });
      }, function (e) {
        return { data: null, newToken: null, error: { name: 'AuthRetryableFetchError', status: 0, code: 'network', message: 'Network error: ' + (e && e.message ? e.message : String(e)) } };
      });
    }

    function fetchSession(force) {
      var t = token();
      if (!t) { cache = null; return Promise.resolve({ session: null, user: null, error: null }); }
      if (!force && cache && (Date.now() - cache.at) < CACHE_MS) return Promise.resolve({ session: cache.session, user: cache.user, error: null });
      return authCall('/get-session', 'GET').then(function (r) {
        if (r.error && r.error.status === 401) { setToken(null); cache = null; return { session: null, user: null, error: null }; }
        if (r.error) return { session: null, user: null, error: r.error };
        if (!r.data || !r.data.user) { setToken(null); cache = null; return { session: null, user: null, error: null }; }
        var u = mapUser(r.data.user);
        var s = mapSession(t, r.data.session, r.data.user);
        cache = { at: Date.now(), session: s, user: u };
        return { session: s, user: u, error: null };
      });
    }

    // after a sign-in that returned a new token: keep it, ask the server for the session (expiry), tell listeners
    function adoptToken(newToken, rawUser) {
      setToken(newToken);
      cache = null;
      return fetchSession(true).then(function (r) {
        var s = r.session || mapSession(newToken, null, rawUser);
        var u = r.user || mapUser(rawUser);
        if (!r.session && s) cache = { at: Date.now(), session: s, user: u };
        emit('SIGNED_IN', s);
        return { data: { user: u, session: s }, error: null };
      });
    }
    function noTokenError() {
      return { name: 'AuthApiError', status: 0, code: 'no_token', message: 'Signed in but no token came back (set-auth-token header missing / not exposed by CORS).' };
    }

    function signedIn(email, password) {
      return authCall('/sign-in/email', 'POST', { email: String(email || '').trim().toLowerCase(), password: password }).then(function (r) {
        if (r.error) {
          if (r.error.status === 401 || r.error.status === 400) r.error.message = r.error.message || 'Invalid login credentials';
          return { data: { user: null, session: null }, error: r.error };
        }
        if (!r.newToken) return { data: { user: null, session: null }, error: noTokenError() };
        setToken(r.newToken);
        cache = null;
        var u = r.data && r.data.user;
        var s = mapSession(r.newToken, null, u);
        cache = u ? { at: Date.now(), session: s, user: mapUser(u) } : null;
        emit('SIGNED_IN', s);
        return { data: { user: mapUser(u), session: s }, error: null };
      });
    }

    function sendPhoneOtp(phone, o) {
      o = o || {};
      if (o.channel && o.channel !== 'sms') return Promise.resolve({ data: { user: null, session: null, messageId: null }, error: unsupportedError('auth.signInWithOtp({phone, channel:"' + o.channel + '"})') });
      var p = normalizePhone(phone);
      if (!p) return Promise.resolve({ data: { user: null, session: null, messageId: null }, error: { name: 'AuthApiError', status: 400, code: 'validation_failed', message: 'Phone number is required' } });
      return authCall('/phone-number/send-otp', 'POST', { phoneNumber: p }).then(function (r) {
        return { data: { user: null, session: null, messageId: null }, error: r.error };
      });
    }
    function verifyPhoneOtp(phone, code) {
      var p = normalizePhone(phone);
      return authCall('/phone-number/verify', 'POST', { phoneNumber: p, code: String(code == null ? '' : code).trim() }).then(function (r) {
        if (r.error) return { data: { user: null, session: null }, error: r.error };
        if (!r.newToken) return { data: { user: null, session: null }, error: noTokenError() };
        return adoptToken(r.newToken, r.data && r.data.user);
      });
    }

    var auth = {
      signInWithPassword: function (creds) {
        creds = creds || {};
        if (creds.phone) return Promise.resolve({ data: { user: null, session: null }, error: unsupportedError('auth.signInWithPassword({phone})') });
        return signedIn(creds.email, creds.password);
      },

      // {phone}: customer SMS code. {email}: "first time / forgot password" code (as on the Hub).
      signInWithOtp: function (creds) {
        creds = creds || {};
        var o = creds.options || {};
        if (creds.phone) return sendPhoneOtp(creds.phone, o);
        if (o.shouldCreateUser === true) return Promise.resolve({ data: { user: null, session: null }, error: unsupportedError('sign-up by email code (shouldCreateUser:true)') });
        var email = String(creds.email || '').trim().toLowerCase();
        pendingReset = { email: email, otp: null };
        return authCall('/email-otp/request-password-reset', 'POST', { email: email }).then(function (r) {
          return { data: { user: null, session: null }, error: r.error };
        });
      },

      // {phone, token, type:'sms'} -> signs in (new customers are created by the server, same as Supabase).
      // {email, token, type:'email'} -> checks a password-reset code WITHOUT using it up (Hub flow).
      verifyOtp: function (p) {
        p = p || {};
        var type = p.type || (p.phone ? 'sms' : 'email');
        if (p.phone || type === 'sms') {
          if (type !== 'sms') return Promise.resolve({ data: { user: null, session: null }, error: unsupportedError('auth.verifyOtp type "' + type + '"') });
          return verifyPhoneOtp(p.phone, p.token);
        }
        if (type !== 'email' && type !== 'recovery' && type !== 'magiclink') return Promise.resolve({ data: { user: null, session: null }, error: unsupportedError('auth.verifyOtp type "' + type + '"') });
        if (p.token_hash) return Promise.resolve({ data: { user: null, session: null }, error: unsupportedError('auth.verifyOtp({token_hash}) (email links)') });
        var email = String(p.email || '').trim().toLowerCase();
        var otp = String(p.token || '').trim();
        return authCall('/email-otp/check-verification-otp', 'POST', { email: email, type: 'forget-password', otp: otp }).then(function (r) {
          if (r.error) return { data: { user: null, session: null }, error: r.error };
          pendingReset = { email: email, otp: otp };
          emit('PASSWORD_RECOVERY', null);
          return { data: { user: null, session: null }, error: null };
        });
      },

      updateUser: function (attrs) {
        attrs = attrs || {};
        var keys = Object.keys(attrs).filter(function (k) { return k !== 'password' && k !== 'currentPassword' && k !== 'nonce'; });
        if (keys.length) return Promise.resolve({ data: { user: null }, error: unsupportedError('auth.updateUser(' + keys.join(',') + ')') });
        if (!attrs.password) return Promise.resolve({ data: { user: null }, error: { name: 'AuthApiError', status: 400, code: 'bad_request', message: 'Nothing to update' } });
        if (pendingReset && pendingReset.otp) {
          var pr = pendingReset;
          return authCall('/email-otp/reset-password', 'POST', { email: pr.email, otp: pr.otp, password: attrs.password }).then(function (r) {
            if (r.error) return { data: { user: null }, error: r.error };
            pendingReset = null;
            emit('USER_UPDATED', null);
            return signedIn(pr.email, attrs.password).then(function (s) {
              return { data: { user: s.data ? s.data.user : null }, error: null };
            });
          });
        }
        if (attrs.currentPassword && token()) {
          return authCall('/change-password', 'POST', { currentPassword: attrs.currentPassword, newPassword: attrs.password, revokeOtherSessions: true }).then(function (r) {
            if (r.error) return { data: { user: null }, error: r.error };
            if (r.newToken) setToken(r.newToken);
            cache = null;
            var u = r.data && r.data.user ? mapUser(r.data.user) : null;
            emit('USER_UPDATED', null);
            return { data: { user: u }, error: null };
          });
        }
        return Promise.resolve({ data: { user: null }, error: unsupportedError('auth.updateUser({password}) without an email code or the current password') });
      },

      getSession: function () {
        return fetchSession(false).then(function (r) { return { data: { session: r.session }, error: r.error }; });
      },

      getUser: function () {
        return fetchSession(true).then(function (r) {
          if (r.error) return { data: { user: null }, error: r.error };
          if (!r.user) return { data: { user: null }, error: { name: 'AuthSessionMissingError', status: 400, code: 'session_missing', message: 'Auth session missing!' } };
          return { data: { user: r.user }, error: null };
        });
      },

      signOut: function () {
        var had = !!token();
        var p = had ? authCall('/sign-out', 'POST', {}) : Promise.resolve(null);
        return p.then(function () {
          setToken(null); cache = null; pendingReset = null;
          emit('SIGNED_OUT', null);
          return { error: null };
        });
      },

      onAuthStateChange: function (cb) {
        var l = { id: 'cf-' + (++subSeq), cb: cb };
        listeners.push(l);
        setTimeout(function () {
          fetchSession(false).then(function (r) { if (listeners.indexOf(l) >= 0) { try { cb('INITIAL_SESSION', r.session); } catch (e) {} } });
        }, 0);
        var sub = { id: l.id, callback: cb, unsubscribe: function () { var i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); } };
        return { data: { subscription: sub } };
      },

      // extras (not in supabase-js)
      token: token,
      _adoptToken: function (t) { setToken(t); cache = null; },
      _fetchSession: fetchSession,

      // not supported yet
      signUp: function () { return Promise.resolve({ data: { user: null, session: null }, error: unsupportedError('auth.signUp') }); },
      resetPasswordForEmail: function () { return Promise.resolve({ data: null, error: unsupportedError('auth.resetPasswordForEmail (email links)') }); },
      refreshSession: function () { return fetchSession(true).then(function (r) { return { data: { session: r.session, user: r.user }, error: r.error }; }); },
      setSession: function () { return Promise.resolve({ data: { session: null, user: null }, error: unsupportedError('auth.setSession') }); },
      exchangeCodeForSession: function () { return Promise.resolve({ data: { session: null, user: null }, error: unsupportedError('auth.exchangeCodeForSession (email links)') }); },
      startAutoRefresh: function () { return Promise.resolve(); },
      stopAutoRefresh: function () { return Promise.resolve(); }
    };

    // other tabs signing in/out on the same origin
    try {
      g.addEventListener && g.addEventListener('storage', function (e) {
        if (e.key === storageKey) { cache = null; emit(e.newValue ? 'SIGNED_IN' : 'SIGNED_OUT', null); }
      });
    } catch (e) {}

    /* ---------- data: query builder ---------- */
    // area: 'api' (needs login) or 'public' (no token; server decides what anonymous callers may read)
    function postJSON(path, body, signal, area) {
      var headers = { 'Content-Type': 'application/json' };
      var t = area === 'public' ? null : token(); if (t) headers.Authorization = 'Bearer ' + t;
      var init = { method: 'POST', headers: headers, body: JSON.stringify(body), credentials: 'omit' };
      if (signal) init.signal = signal;
      return Promise.resolve().then(function () { return doFetch(apiBase() + '/' + tenant + '/' + (area === 'public' ? 'public' : 'api') + path, init); }).then(function (res) {
        return res.json().catch(function () { return null; }).then(function (json) {
          if (res.status === 401) {
            if (t) { setToken(null); cache = null; emit('SIGNED_OUT', null); }
            return { data: null, error: { message: 'Not signed in (new backend). Please log in again.', code: '401', details: null, hint: null }, count: null, status: 401, statusText: res.statusText || 'Unauthorized' };
          }
          if (!res.ok) {
            return { data: null, error: { message: (json && (json.message || json.error)) || res.statusText || ('HTTP ' + res.status), code: (json && json.code) || String(res.status), details: null, hint: null }, count: null, status: res.status, statusText: res.statusText || '' };
          }
          json = json || {};
          return { data: json.data === undefined ? null : json.data, error: json.error || null, count: json.count === undefined ? null : json.count, status: res.status, statusText: res.statusText || 'OK' };
        });
      }, function (e) {
        return { data: null, error: { message: 'TypeError: ' + (e && e.message ? e.message : String(e)), code: '', details: String(e), hint: null }, count: null, status: 0, statusText: '' };
      });
    }

    // RPCs that must work before login: served at /{tenant}/public/rpc/:name (no token, rate-limited)
    var PUBLIC_RPCS = opts.publicRpcs || [];

    var SIMPLE_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'in', 'is'];
    var NOT_OPS = ['is'];   // contract v1: only not.is

    function cleanCols(c) {
      if (c == null) return '*';
      var quoted = false;
      return String(c).split('').filter(function (ch) {
        if (/\s/.test(ch) && !quoted) return false;
        if (ch === '"') quoted = !quoted;
        return true;
      }).join('');
    }

    function Q(table) {
      this._table = table;
      this._op = null;
      this._columns = null;
      this._embeds = null;      // [{ rel, cols, local, foreign, one, addedLocal, addedForeign }]
      this._filters = [];
      this._or = null;
      this._order = [];
      this._limit = null;
      this._offset = null;
      this._count = null;
      this._head = false;
      this._single = false;
      this._maybeSingle = false;
      this._values = undefined;
      this._onConflict = null;
      this._returning = false;
      this._uns = [];
      this._signal = null;
      this._throw = false;
      this._rpc = null;
      this._anon = false;       // set by handleSupabaseFetch for requests the page made with the anon key
      this._promise = null;
    }
    Q.prototype._bad = function (what) { this._uns.push(what); return this; };
    Q.prototype._write = function (op, values, o) {
      if (this._rpc) return this._bad(op + '() after rpc()');
      if (this._op) return this._bad(op + '() after ' + this._op + '()');
      this._op = op;
      if (values !== undefined) this._values = values;
      o = o || {};
      if (o.count) this._count = o.count;
      return this;
    };

    // "a,b, rel(x,y)" -> base columns + known embeds; anything else with ( ) : ! is unsupported
    Q.prototype._parseEmbeds = function (cols, isReturning) {
      if (!/[()]/.test(cols) && !/[^:]:[^:]/.test(cols) && cols.indexOf('!') < 0) return cols;
      var parts = splitTop(cols), base = [], embeds = [], rels = EMBEDS[this._table] || {}, self = this, bad = false;
      parts.forEach(function (p) {
        var m = /^([A-Za-z0-9_]+)\(([^()]*)\)$/.exec(p);
        if (m && rels[m[1]] && !isReturning && !/[^:]:[^:]|!/.test(m[2])) {
          var rc = rels[m[1]];
          embeds.push({ rel: m[1], cols: m[2] === '' ? '*' : m[2], local: rc.local, foreign: rc.foreign, one: !!rc.one });
        } else if (/[()!]/.test(p) || /[^:]:[^:]/.test(p)) {
          bad = true;
        } else base.push(p);
      });
      if (bad || !embeds.length) { self._bad('embedded select / alias "' + cols + '"'); return cols; }
      if (!base.length) base.push('*');
      embeds.forEach(function (e) {
        if (!hasCol(base, e.local)) { base.push(e.local); e.addedLocal = true; }
        var ec = e.cols.split(',');
        if (!hasCol(ec, e.foreign)) { ec.push(e.foreign); e.addedForeign = true; }
        e.cols = ec.join(',');
      });
      this._embeds = embeds;
      return base.join(',');
    };

    /* ---- operations ---- */
    Q.prototype.select = function (columns, o) {
      o = o || {};
      var cols = cleanCols(columns == null ? '*' : columns);
      if (this._rpc) return this._bad('select() after rpc()');
      if (!this._op) {
        this._op = 'select';
        this._columns = this._parseEmbeds(cols, false);
        if (o.count) this._count = o.count;
        if (o.head) this._head = true;
      } else {
        this._returning = true;
        this._columns = this._parseEmbeds(cols, true);
      }
      return this;
    };
    Q.prototype.insert = function (values, o) {
      return this._write('insert', values, o);
    };
    Q.prototype.upsert = function (values, o) {
      o = o || {};
      this._write('upsert', values, o);
      if (o.onConflict) this._onConflict = cleanCols(o.onConflict);
      if (o.ignoreDuplicates) this._bad('upsert({ignoreDuplicates:true})');
      return this;
    };
    Q.prototype.update = function (values, o) { return this._write('update', values, o); };
    Q.prototype['delete'] = function (o) { return this._write('delete', undefined, o); };

    /* ---- filters ---- */
    Q.prototype._f = function (col, op, val) {
      if (this._rpc) return this._bad('filter ' + op + '() after rpc()');
      if (typeof col !== 'string' || !col) return this._bad('filter with no column');
      if (op === 'in') {
        if (typeof val === 'string') val = val.replace(/^\(|\)$/g, '').split(',').map(function (s) { return s.trim().replace(/^"|"$/g, ''); });
        val = Array.isArray(val) ? val.slice() : [val];
      }
      this._filters.push([col, op, val === undefined ? null : val]);
      return this;
    };
    SIMPLE_OPS.forEach(function (op) {
      Q.prototype[op] = function (col, val) { return this._f(col, op, val); };
    });
    Q.prototype.not = function (col, op, val) {
      if (NOT_OPS.indexOf(op) < 0) return this._bad('not(' + col + ', "' + op + '")');
      return this._f(col, 'not.' + op, val);
    };
    Q.prototype.filter = function (col, op, val) {
      op = String(op || '');
      if (op.indexOf('not.') === 0) return this.not(col, op.slice(4), val);
      if (SIMPLE_OPS.indexOf(op) < 0) return this._bad('filter(' + col + ', "' + op + '")');
      return this._f(col, op, val);
    };
    Q.prototype.match = function (obj) {
      var self = this;
      Object.keys(obj || {}).forEach(function (k) { self._f(k, 'eq', obj[k]); });
      return this;
    };
    Q.prototype.or = function (str, o) {
      o = o || {};
      if (this._rpc) return this._bad('or() after rpc()');
      if (o.foreignTable || o.referencedTable) return this._bad('or() on a foreign table');
      if (this._or != null) return this._bad('more than one or()');
      this._or = cleanCols(str);
      return this;
    };
    ['contains', 'containedBy', 'overlaps', 'textSearch', 'rangeGt', 'rangeGte', 'rangeLt', 'rangeLte', 'rangeAdjacent',
     'likeAllOf', 'likeAnyOf', 'ilikeAllOf', 'ilikeAnyOf', 'regexMatch', 'imatch', 'isDistinct'].forEach(function (m) {
      Q.prototype[m] = function () { return this._bad(m + '()'); };
    });

    /* ---- modifiers ---- */
    Q.prototype.order = function (col, o) {
      o = o || {};
      if (this._rpc) return this._bad('order() after rpc()');
      if (o.foreignTable || o.referencedTable) return this._bad('order() on a foreign table');
      var asc = o.ascending !== false;
      // Postgres default: NULLS LAST when ascending, NULLS FIRST when descending. Sent explicitly so D1 matches.
      var nf = o.nullsFirst === undefined ? !asc : !!o.nullsFirst;
      this._order.push([col, { ascending: asc, nullsFirst: nf }]);
      return this;
    };
    Q.prototype.limit = function (n, o) {
      o = o || {};
      if (this._rpc) return this._bad('limit() after rpc()');
      if (o.foreignTable || o.referencedTable) return this._bad('limit() on a foreign table');
      this._limit = n;
      return this;
    };
    Q.prototype.range = function (from, to, o) {
      o = o || {};
      if (this._rpc) return this._bad('range() after rpc()');
      if (o.foreignTable || o.referencedTable) return this._bad('range() on a foreign table');
      this._offset = from;
      this._limit = to - from + 1;
      return this;
    };
    Q.prototype.single = function () { if (this._rpc) return this._bad('single() after rpc()'); this._single = true; return this; };
    Q.prototype.maybeSingle = function () { if (this._rpc) return this._bad('maybeSingle() after rpc()'); this._maybeSingle = true; return this; };
    Q.prototype.abortSignal = function (s) { this._signal = s; return this; };
    Q.prototype.throwOnError = function () { this._throw = true; return this; };
    Q.prototype.returns = function () { return this; };
    Q.prototype.overrideTypes = function () { return this; };
    Q.prototype.setHeader = function () { return this; };
    ['csv', 'geojson', 'explain', 'rollback'].forEach(function (m) {
      Q.prototype[m] = function () { return this._bad(m + '()'); };
    });

    /* ---- the JSON sent to /api/db (exactly the compat contract) ---- */
    Q.prototype.toJSON = function () {
      var b = { table: this._table, op: this._op };
      if (this._op === 'select' || this._returning) b.columns = this._columns || '*';
      if (this._filters.length) b.filters = this._filters;
      if (this._or != null) b.or = this._or;
      if (this._order.length) b.order = this._order;
      if (this._limit != null) b.limit = this._limit;
      if (this._offset != null) b.offset = this._offset;
      if (this._count) b.count = this._count;
      if (this._head) b.head = true;
      if (this._single) b.single = true;
      if (this._maybeSingle) b.maybeSingle = true;
      if (this._values !== undefined) b.values = this._values;
      if (this._onConflict) b.onConflict = this._onConflict;
      if (this._returning) b.returning = true;
      return b;
    };

    // 2nd query per embed: rel rows where foreign IN (keys of the base rows); attach as object/array
    Q.prototype._attachEmbeds = function (r) {
      var self = this, area = this._anon ? 'public' : 'api';
      if (r.error || r.data == null || this._head) return Promise.resolve(r);
      var rows = Array.isArray(r.data) ? r.data : [r.data];
      return this._embeds.reduce(function (p, e) {
        return p.then(function (prev) {
          if (prev.error) return prev;
          var keys = [];
          rows.forEach(function (row) { var k = row ? row[e.local] : null; if (k != null && keys.indexOf(k) < 0) keys.push(k); });
          var chunks = [];
          for (var i = 0; i < keys.length; i += 200) chunks.push(keys.slice(i, i + 200));
          return Promise.all(chunks.map(function (ks) {
            return postJSON('/db', { table: e.rel, op: 'select', columns: e.cols, filters: [[e.foreign, 'in', ks]] }, self._signal, area);
          })).then(function (rs) {
            var bad = rs.filter(function (x) { return x.error; })[0];
            if (bad) return { data: null, error: bad.error, count: null, status: bad.status, statusText: bad.statusText };
            var by = {};
            rs.forEach(function (x) { (x.data || []).forEach(function (er) { var k = String(er[e.foreign]); (by[k] = by[k] || []).push(er); }); });
            rows.forEach(function (row) {
              if (!row) return;
              var list = row[e.local] == null ? [] : (by[String(row[e.local])] || []);
              row[e.rel] = e.one ? (list[0] || null) : list;
            });
            if (e.addedForeign) Object.keys(by).forEach(function (k) { by[k].forEach(function (er) { delete er[e.foreign]; }); });
            return prev;
          });
        });
      }, Promise.resolve(r)).then(function (out) {
        if (!out.error) self._embeds.forEach(function (e) { if (e.addedLocal) rows.forEach(function (row) { if (row) delete row[e.local]; }); });
        return out;
      });
    };

    Q.prototype._exec = function () {
      if (this._promise) return this._promise;
      var self = this;
      var p;
      if (this._uns.length) {
        var err = unsupportedError(this._uns.join('; ') + (this._rpc ? ' (rpc ' + this._rpc.name + ')' : ' (table ' + this._table + ')'));
        p = Promise.resolve({ data: null, error: err, count: null, status: 0, statusText: '' });
      } else if (this._rpc) {
        var pub = this._anon || PUBLIC_RPCS.indexOf(this._rpc.name) >= 0;
        p = postJSON('/rpc/' + encodeURIComponent(this._rpc.name), this._rpc.args || {}, this._signal, pub ? 'public' : 'api').then(function (r) {
          return { data: r.data, error: r.error, count: null, status: r.status, statusText: r.statusText };
        });
      } else if (!this._op) {
        p = Promise.resolve({ data: null, error: { message: 'gl-cf-client: from(' + this._table + ') needs select/insert/update/upsert/delete', code: 'CF_BAD_QUERY', details: null, hint: null }, count: null, status: 0, statusText: '' });
      } else {
        p = postJSON('/db', this.toJSON(), this._signal, this._anon ? 'public' : 'api');
        if (this._embeds) p = p.then(function (r) { return self._attachEmbeds(r); });
      }
      this._promise = p.then(function (r) {
        if (self._throw && r.error) { var e = new Error(r.error.message); e.code = r.error.code; e.details = r.error.details; throw e; }
        return r;
      });
      return this._promise;
    };
    Q.prototype.then = function (a, b) { return this._exec().then(a, b); };
    Q.prototype['catch'] = function (b) { return this._exec()['catch'](b); };
    Q.prototype['finally'] = function (f) { return this._exec()['finally'](f); };

    function from(table) {
      var q = new Q(String(table));
      if (!/^[A-Za-z0-9_]+$/.test(String(table))) q._bad('table name "' + table + '"');
      return q;
    }

    function rpc(name, args, o) {
      var q = new Q(null);
      q._rpc = { name: String(name), args: args || {} };
      if (!/^[A-Za-z0-9_]+$/.test(String(name))) q._bad('rpc name "' + name + '"');
      o = o || {};
      if (o.head || o.count) q._bad('rpc() with head/count');
      return q;
    }

    /* ---------- realtime ----------
       realtimePollMs > 0: postgres_changes callbacks are called on a timer while the page is visible
       (and right away when it becomes visible again). Pages that just reload their list on any change
       (gl-jobcard, gl-board, gl-tower) keep working, a little later than today. */
    var POLL_MS = Number(opts.realtimePollMs) || 0;
    var channels = [];
    function docVisible() { try { return !g.document || g.document.visibilityState !== 'hidden'; } catch (e) { return true; } }
    function makeChannel(name) {
      var handlers = [];
      var timer = null;
      var ch = {
        topic: 'realtime:' + name,
        state: 'closed',
        _cfPoll: POLL_MS > 0,
        on: function (type, filter, cb) {
          if (type === 'postgres_changes' && typeof cb === 'function') handlers.push({ filter: filter || {}, cb: cb });
          else if (type === 'broadcast' || type === 'presence') warnOnce('realtime ' + type);
          return ch;
        },
        _tick: function () {
          if (!docVisible()) return;
          handlers.forEach(function (h) {
            var f = h.filter;
            var payload = { schema: f.schema || 'public', table: f.table || null, commit_timestamp: new Date().toISOString(), eventType: '*', new: {}, old: {}, errors: null, cf_poll: true };
            try { h.cb(payload); } catch (e) { try { g.console.error(e); } catch (x) {} }
          });
        },
        subscribe: function (statusCb) {
          if (POLL_MS > 0) {
            if (!timer) {
              timer = setInterval(ch._tick, POLL_MS);
              ch.state = 'joined';
            }
            if (typeof statusCb === 'function') setTimeout(function () { try { statusCb('SUBSCRIBED', null); } catch (e) {} }, 0);
          } else {
            warnOnce('realtime channel().subscribe()');
            if (typeof statusCb === 'function') setTimeout(function () { try { statusCb('CHANNEL_ERROR', unsupportedError('realtime')); } catch (e) {} }, 0);
          }
          return ch;
        },
        unsubscribe: function () { if (timer) { clearInterval(timer); timer = null; } ch.state = 'closed'; var i = channels.indexOf(ch); if (i >= 0) channels.splice(i, 1); return Promise.resolve('ok'); },
        send: function () { warnOnce('realtime send()'); return Promise.resolve('error'); },
        track: function () { warnOnce('realtime track()'); return Promise.resolve('error'); },
        untrack: function () { return Promise.resolve('error'); },
        presenceState: function () { return {}; }
      };
      channels.push(ch);
      return ch;
    }
    if (POLL_MS > 0) {
      try {
        g.document && g.document.addEventListener && g.document.addEventListener('visibilitychange', function () {
          if (docVisible()) channels.forEach(function (c) { if (c.state === 'joined') c._tick(); });
        });
      } catch (e) {}
    }

    /* ---------- storage (docs/api/storage-contract.md) ----------
       POST /{tenant}/api/storage/{upload|sign|sign-many|remove|list|download}, Bearer login.
       Signed URLs from the server (/gl/files/<key>?exp=&sig=) are passed through untouched. */
    var SIGN_DEFAULT_S = 7 * 24 * 3600;     // 7 days (server max)
    var signed = {};                        // 'bucket/path' -> signed URL (filled by upload / createSignedUrl(s))
    var lazySigning = {};
    function storageErr(status, json, fallback) {
      var e = json && json.error && typeof json.error === 'object' ? json.error : (json || {});
      var msg = e.message || (json && typeof json.error === 'string' ? json.error : null) || fallback || ('HTTP ' + status);
      var sc = e.statusCode || String(status);
      return { name: 'StorageApiError', message: msg, status: status, statusCode: String(sc), error: e.error || (json && typeof json.error === 'string' ? json.error : null) };
    }
    function capTtl(n) { n = Number(n); return Math.max(1, Math.min(isFinite(n) && n > 0 ? Math.floor(n) : SIGN_DEFAULT_S, SIGN_DEFAULT_S)); }
    var BUCKET_MAX = opts.bucketMax || {};     // bucket -> bytes; default 10 MB (server default)
    function bodySize(b) { if (!b) return 0; if (typeof b.size === 'number') return b.size; if (typeof b.byteLength === 'number') return b.byteLength; if (typeof b === 'string') return b.length; return 0; }
    function apiRequest(path, init) {
      init = init || {};
      var headers = init.headers || {};
      var t = token(); if (t) headers.Authorization = 'Bearer ' + t;
      init.headers = headers;
      init.credentials = 'omit';
      return Promise.resolve().then(function () { return doFetch(apiBase() + '/' + tenant + '/api' + path, init); }).then(function (res) {
        if (res.status === 401 && t) { setToken(null); cache = null; emit('SIGNED_OUT', null); }
        return res;
      });
    }
    function storageJSON(op, body) {
      return apiRequest('/storage/' + op, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(function (res) {
        return res.json().catch(function () { return null; }).then(function (json) {
          if (res.status === 401) return { data: null, error: storageErr(401, null, 'Not signed in (new backend). Please log in again.') };
          if (!res.ok) return { data: null, error: storageErr(res.status, json) };
          json = json || {};
          if (json.error) return { data: null, error: storageErr(res.status === 200 ? 400 : res.status, json) };
          return { data: json.data === undefined ? null : json.data, error: null };
        });
      }, function (e) {
        return { data: null, error: { name: 'StorageUnknownError', message: 'Network error: ' + (e && e.message ? e.message : String(e)), status: 0, statusCode: '0' } };
      });
    }
    function cleanPath(p) { return String(p == null ? '' : p).replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/'); }
    function encPath(p) { return cleanPath(p).split('/').map(encodeURIComponent).join('/'); }
    // A page may add its own "?v=<time>" cache-buster to a public URL (gl-claim does). On a signed URL that would
    // corrupt "sig", so the URL ends in an empty "&_=" the server ignores: "...&sig=X&_=?v=1" keeps sig=X intact.
    function bustSafe(u) { return /[?&]sig=/.test(u) && !/[?&]_=$/.test(u) ? u + '&_=' : u; }

    function bucketApi(bucket) {
      bucket = String(bucket);
      var badBucket = !/^[A-Za-z0-9_.-]+$/.test(bucket);
      var no = function (what) { return function () { return Promise.resolve({ data: null, error: unsupportedError('storage.' + what + ' (bucket ' + bucket + ')') }); }; };
      function ck(p) { return bucket + '/' + cleanPath(p); }
      function upload(path, body, o, forceUpsert) {
        o = o || {};
        if (badBucket) return no('bucket name')();
        if (typeof FormData !== 'undefined' && body instanceof FormData) return no('upload(FormData)')();
        var p = cleanPath(path);
        if (!p) return Promise.resolve({ data: null, error: storageErr(400, { message: 'Empty path' }) });
        var ctype = o.contentType || (body && body.type) || 'application/octet-stream';
        var max = BUCKET_MAX[bucket] || 10 * 1048576;
        if (bodySize(body) > max) return Promise.resolve({ data: null, error: storageErr(413, { message: 'The object exceeded the maximum allowed size (' + (max / 1048576) + ' MB)', statusCode: '413', error: 'Payload too large' }) });
        var headers = { 'x-bucket': bucket, 'x-path': encodeURIComponent(p), 'x-upsert': (forceUpsert || o.upsert) ? 'true' : 'false', 'Content-Type': ctype };
        return apiRequest('/storage/upload', { method: 'POST', headers: headers, body: body }).then(function (res) {
          return res.json().catch(function () { return null; }).then(function (json) {
            if (res.status === 401) return { data: null, error: storageErr(401, null, 'Not signed in (new backend). Please log in again.') };
            if (!res.ok || (json && json.error)) return { data: null, error: storageErr(res.ok ? 400 : res.status, json) };
            var d = (json && json.data) || {};
            var out = { path: d.path || p, fullPath: d.fullPath || (bucket + '/' + p) };
            if (d.id) out.id = d.id;
            delete signed[ck(p)];
            if (d.signedUrl) { signed[ck(p)] = d.signedUrl; return { data: out, error: null }; }
            return storageJSON('sign', { bucket: bucket, path: p, expiresIn: SIGN_DEFAULT_S }).then(function (s) {
              if (!s.error && s.data && s.data.signedUrl) signed[ck(p)] = s.data.signedUrl;
              return { data: out, error: null };
            });
          });
        }, function (e) {
          return { data: null, error: { name: 'StorageUnknownError', message: 'Network error: ' + (e && e.message ? e.message : String(e)), status: 0, statusCode: '0' } };
        });
      }
      return {
        upload: function (path, body, o) { return upload(path, body, o, false); },
        update: function (path, body, o) { return upload(path, body, o, true); },
        download: function (path, o) {
          o = o || {};
          if (badBucket) return no('bucket name')();
          if (o.transform) return no('download({transform})')();
          return apiRequest('/storage/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bucket: bucket, path: cleanPath(path) }) }).then(function (res) {
            var ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
            if (!res.ok || /application\/json/i.test(ct)) {
              return res.json().catch(function () { return null; }).then(function (json) {
                return { data: null, error: storageErr(res.ok ? 400 : res.status, json) };
              });
            }
            return res.blob().then(function (b) { return { data: b, error: null }; });
          }, function (e) {
            return { data: null, error: { name: 'StorageUnknownError', message: 'Network error: ' + (e && e.message ? e.message : String(e)), status: 0, statusCode: '0' } };
          });
        },
        remove: function (paths) {
          if (badBucket) return no('bucket name')();
          var ps = (Array.isArray(paths) ? paths : [paths]).map(cleanPath);
          ps.forEach(function (p) { delete signed[ck(p)]; });
          return storageJSON('remove', { bucket: bucket, paths: ps });
        },
        list: function (prefix, o) {
          o = o || {};
          if (badBucket) return no('bucket name')();
          if (o.search) return no('list({search})')();
          if (o.sortBy && !((o.sortBy.column || 'name') === 'name' && (o.sortBy.order || 'asc') === 'asc')) return no('list({sortBy} other than name asc)')();
          return storageJSON('list', { bucket: bucket, prefix: cleanPath(prefix), limit: o.limit != null ? o.limit : 100, offset: o.offset || 0 });
        },
        createSignedUrl: function (path, expiresIn, o) {
          o = o || {};
          if (badBucket) return no('bucket name')();
          if (o.download || o.transform) return no('createSignedUrl({download|transform})')();
          var p = cleanPath(path);
          return storageJSON('sign', { bucket: bucket, path: p, expiresIn: capTtl(expiresIn) }).then(function (r) {
            if (!r.error && r.data && r.data.signedUrl) signed[ck(p)] = r.data.signedUrl;
            return r;
          });
        },
        createSignedUrls: function (paths, expiresIn, o) {
          o = o || {};
          if (badBucket) return no('bucket name')();
          if (o.download) return no('createSignedUrls({download})')();
          var ps = (paths || []).map(cleanPath);
          return storageJSON('sign-many', { bucket: bucket, paths: ps, expiresIn: capTtl(expiresIn) }).then(function (r) {
            (Array.isArray(r.data) ? r.data : []).forEach(function (x) { if (x && x.signedUrl && !x.error) signed[ck(x.path)] = x.signedUrl; });
            return r;
          });
        },
        // Sync. Correct after upload()/createSignedUrl(s) in this page (signed URL, valid 7 days).
        // Otherwise returns <api>/<tenant>/files/<tenant>/storage/<bucket>/<path> (unsigned) and signs in the background.
        getPublicUrl: function (path, o) {
          var p = cleanPath(path);
          var hit = signed[ck(p)];
          if (hit) return { data: { publicUrl: bustSafe(hit) } };
          warnOnce('storage.getPublicUrl before upload/sign (bucket ' + bucket + ') — returned an unsigned URL');
          if (!badBucket && token() && !lazySigning[ck(p)]) {
            lazySigning[ck(p)] = true;
            storageJSON('sign', { bucket: bucket, path: p, expiresIn: SIGN_DEFAULT_S }).then(function (r) {
              if (!r.error && r.data && r.data.signedUrl) signed[ck(p)] = r.data.signedUrl;
              delete lazySigning[ck(p)];
            });
          }
          return { data: { publicUrl: apiBase() + '/' + tenant + '/files/' + tenant + '/storage/' + encodeURIComponent(bucket) + '/' + encPath(p) } };
        },
        move: no('move'), copy: no('copy'),
        createSignedUploadUrl: no('createSignedUploadUrl'), uploadToSignedUrl: no('uploadToSignedUrl')
      };
    }

    var client = {
      _cf: true,
      tenant: tenant,
      auth: auth,
      from: from,
      rpc: rpc,
      schema: function (s) {
        var what = 'schema("' + s + '")';
        return { from: function (t) { return from(t)._bad(what); }, rpc: function (n, a) { return rpc(n, a)._bad(what); } };
      },
      channel: makeChannel,
      removeChannel: function (ch) { return ch && ch.unsubscribe ? ch.unsubscribe() : Promise.resolve('ok'); },
      removeAllChannels: function () { return Promise.all(channels.slice().map(function (c) { return c.unsubscribe(); })); },
      getChannels: function () { return channels.slice(); },
      storage: { from: bucketApi, cachedSignedUrl: function (bucket, path) { return signed[String(bucket) + '/' + cleanPath(path)] || null; } },
      functions: { invoke: function (n) { return Promise.resolve({ data: null, error: unsupportedError('functions.invoke("' + n + '")') }); } },
      apiBase: apiBase
    };
    return client;
  }

  /* ============================================================
     handleSupabaseFetch(client, url, init)
     For the customer PWA (index.html), which calls Supabase REST with fetch() directly:
       GET    /rest/v1/<t>?select=..&<col>=eq.|neq.|gt.|gte.|lt.|lte.|like.|ilike.|in.(..)|is.|not.is.<v>&order=c.asc|desc[.nullsfirst|.nullslast]&limit=&offset=
       POST   /rest/v1/<t>[?on_conflict=c]  Prefer resolution=merge-duplicates -> upsert, else insert
       PATCH  /rest/v1/<t>?<filters>         -> update        DELETE /rest/v1/<t>?<filters> -> delete
              Prefer return=representation -> rows back (else 201/204 with no body, like PostgREST)
       POST   /rest/v1/rpc/<fn>              -> client.rpc(fn, body)
       PUT|POST /storage/v1/object/<bucket>/<path> (x-upsert, Content-Type) -> client.storage upload
       POST   /auth/v1/otp {phone}                         -> SMS code
       POST   /auth/v1/verify {phone, token, type:'sms'}   -> Supabase-shaped session (marked _cf:true)
       POST   /auth/v1/token?grant_type=refresh_token      -> current session (Better Auth sessions slide 30 days)
       POST   /auth/v1/token?grant_type=password {email,password}
       POST   /auth/v1/logout, GET /auth/v1/user
     A request whose Authorization bearer equals its apikey header (the anon key: no user login) is sent to the
     PUBLIC routes (/gl/public/db, /gl/public/rpc/:name) without a token, like the anon role today.
     /functions/v1/* returns null (gl-cf-page.js blocks it). Anything else -> 400 CF_UNSUPPORTED Response, no network.
     Values stay strings (PostgREST style), except is.null/true/false.
     ============================================================ */
  var REST_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'in', 'is'];
  function lowerHeaders(h) {
    var out = {};
    if (!h) return out;
    if (typeof h.forEach === 'function' && typeof h.get === 'function') { h.forEach(function (v, k) { out[String(k).toLowerCase()] = v; }); return out; }
    if (Array.isArray(h)) { h.forEach(function (kv) { out[String(kv[0]).toLowerCase()] = kv[1]; }); return out; }
    Object.keys(h).forEach(function (k) { out[k.toLowerCase()] = h[k]; });
    return out;
  }
  function mkResponse(status, body) {
    var R = g.Response;
    var noBody = status === 204 || status === 205 || status === 304;
    var text = noBody ? null : (body === undefined ? '' : (typeof body === 'string' ? body : JSON.stringify(body)));
    var headers = { 'Content-Type': 'application/json; charset=utf-8' };
    if (R) return new R(text, { status: status, headers: headers });
    return { ok: status >= 200 && status < 300, status: status, statusText: '', headers: { get: function (k) { return /content-type/i.test(k) ? headers['Content-Type'] : null; } },
      text: function () { return Promise.resolve(text || ''); }, json: function () { return Promise.resolve(JSON.parse(text || 'null')); } };
  }
  function errResponse(err, status) {
    var e = err || {};
    var st = status || (e.code === '401' ? 401 : 400);
    return mkResponse(st, { code: e.code || String(st), message: e.message || 'error', details: e.details || null, hint: e.hint || null });
  }
  function restUnsupported(what) { return Promise.resolve(errResponse(unsupportedError('Supabase REST ' + what), 400)); }
  // Supabase auth-style error body ({error, error_description, msg}) so the page's own checks keep working
  function authErrResponse(e, fallbackStatus) {
    var st = e && e.status >= 400 ? e.status : (fallbackStatus || 400);
    var msg = (e && e.message) || 'error';
    return mkResponse(st, { code: st, error_code: (e && e.code) || String(st), msg: msg, error: (e && e.code) || 'error', error_description: msg });
  }

  // anon intent: the page authorised the request with the public anon key itself (no user login)
  function isAnonRequest(init) {
    var h = lowerHeaders(init && init.headers);
    var auth = String(h.authorization || '');
    var key = String(h.apikey || '');
    return !!key && (auth === '' || auth === 'Bearer ' + key);
  }

  function parseRestValue(op, raw) {
    if (op === 'in') {
      var inner = raw.replace(/^\(/, '').replace(/\)$/, '');
      if (inner === '') return [];
      var out = [], cur = '', q = false;
      for (var i = 0; i < inner.length; i++) {
        var ch = inner.charAt(i);
        if (q && ch === '\\' && i + 1 < inner.length) { cur += inner.charAt(++i); continue; }
        if (ch === '"') { q = !q; continue; }
        if (ch === ',' && !q) { out.push(cur); cur = ''; continue; }
        cur += ch;
      }
      out.push(cur);
      return out;
    }
    if (op === 'is') {
      if (raw === 'null') return null;
      if (raw === 'true') return true;
      if (raw === 'false') return false;
      return undefined;
    }
    if (op === 'like' || op === 'ilike') return raw.replace(/\*/g, '%');
    return raw;
  }

  /* Links to the OLD Supabase storage that pages build themselves:
       https://db.grandlab.com.my/storage/v1/object/[public/]<bucket>/<path>   (index.html review proofs)
     - in data written to the new API (whole JSON string values only) -> bare key gl/storage/<bucket>/<path>
       (the server signs such keys on read; same key the cutover copies the old files to).
     - in other outgoing bodies -> the signed URL from the upload just made in this page, if known. */
  var KEY_PREFIX = 'gl/storage/';
  function decSegs(p) { return p.split('/').map(function (x) { try { return decodeURIComponent(x); } catch (e) { return x; } }).join('/').replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/'); }
  function sbObjRe(quoted) {
    var o = SUPABASE_ORIGIN.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
    var mid = '\\/storage\\/v1\\/object\\/(?:public\\/)?(?!sign\\/|authenticated\\/|info\\/|list\\/)([A-Za-z0-9_.-]+)\\/';
    return quoted ? new RegExp('"' + o + mid + '([^"?#\\\\]+)"', 'g')
                  : new RegExp(o + mid + '([^"\'\\s?#\\\\<>]+)', 'g');
  }
  function storageUrlsToKeys(text) {
    if (typeof text !== 'string' || text.indexOf('/storage/v1/object/') < 0) return text;
    return text.replace(sbObjRe(true), function (m, b, p) { return JSON.stringify(KEY_PREFIX + b + '/' + decSegs(p)); });
  }
  function storageUrlsToSigned(client, text) {
    if (typeof text !== 'string' || text.indexOf('/storage/v1/object/') < 0) return text;
    return text.replace(sbObjRe(false), function (m, b, p) {
      var u = client.storage.cachedSignedUrl ? client.storage.cachedSignedUrl(b, decSegs(p)) : null;
      return u || m;
    });
  }

  // Better Auth session -> the JSON Supabase's /auth/v1/verify and /token return (+ _cf marker)
  function supaSession(s) {
    if (!s) return null;
    var exp = s.expires_at || Math.floor(Date.now() / 1000) + 30 * 86400;
    return { access_token: s.access_token, token_type: 'bearer', expires_in: Math.max(0, exp - Math.floor(Date.now() / 1000)), expires_at: exp,
      refresh_token: s.access_token, user: s.user, _cf: true };
  }

  function handleAuthFetch(client, u, method, init) {
    var path = u.pathname.replace(/^\/auth\/v1/, '');
    var body = {};
    if (init.body != null) {
      if (typeof init.body !== 'string') return restUnsupported('auth with a non-JSON body');
      try { body = JSON.parse(init.body) || {}; } catch (e) { return restUnsupported('auth with a body that is not JSON'); }
    }
    var a = client.auth;
    if (path === '/otp' && method === 'POST') {
      if (!body.phone) return restUnsupported('POST /auth/v1/otp without phone (email links)');
      return a.signInWithOtp({ phone: body.phone, options: { channel: body.channel } }).then(function (r) {
        return r.error ? authErrResponse(r.error) : mkResponse(200, {});
      });
    }
    if (path === '/verify' && method === 'POST') {
      if (!body.phone) return restUnsupported('POST /auth/v1/verify without phone (email links)');
      return a.verifyOtp({ phone: body.phone, token: body.token, type: body.type || 'sms' }).then(function (r) {
        if (r.error) return authErrResponse(r.error);
        return mkResponse(200, supaSession(r.data.session));
      });
    }
    if (path === '/token' && method === 'POST') {
      var gt = u.searchParams.get('grant_type');
      if (gt === 'password') {
        if (!body.email) return restUnsupported('POST /auth/v1/token?grant_type=password with phone');
        return a.signInWithPassword({ email: body.email, password: body.password }).then(function (r) {
          if (r.error) return authErrResponse(r.error);
          return a._fetchSession(true).then(function (s) { return mkResponse(200, supaSession(s.session || r.data.session)); });
        });
      }
      if (gt === 'refresh_token') {
        // Better Auth sessions slide (30 days); "refresh" = check the session is still alive.
        if (!a.token() && body.refresh_token) a._adoptToken(body.refresh_token);
        return a._fetchSession(true).then(function (s) {
          if (s.error) return authErrResponse(s.error, 500);
          if (!s.session) return authErrResponse({ status: 400, code: 'refresh_token_not_found', message: 'Invalid Refresh Token: Refresh Token Not Found' });
          return mkResponse(200, supaSession(s.session));
        });
      }
      return restUnsupported('POST /auth/v1/token?grant_type=' + gt);
    }
    if (path === '/logout' && method === 'POST') return a.signOut().then(function () { return mkResponse(204); });
    if (path === '/user' && method === 'GET') {
      return a.getUser().then(function (r) { return r.error ? authErrResponse(r.error, 401) : mkResponse(200, r.data.user); });
    }
    return restUnsupported(method + ' /auth/v1' + path);
  }

  function handleSupabaseFetch(client, url, init) {
    init = init || {};
    var u;
    try { u = new URL(String(url)); } catch (e) { return null; }
    var path = u.pathname;
    var method = String(init.method || 'GET').toUpperCase();
    var h = lowerHeaders(init.headers);
    var prefer = String(h.prefer || '');
    var anon = isAnonRequest(init);

    if (path.indexOf('/functions/v1/') === 0) return null;   // edge functions: the page glue decides
    if (path.indexOf('/auth/v1/') === 0) return handleAuthFetch(client, u, method, init);

    /* ---- storage upload ---- */
    var sm = /^\/storage\/v1\/object\/(?!public\/|sign\/|authenticated\/|info\/|list\/)([^/]+)\/(.+)$/.exec(path);
    if (sm && (method === 'PUT' || method === 'POST')) {
      var bucket = decodeURIComponent(sm[1]);
      var objPath = sm[2].split('/').map(function (s) { return decodeURIComponent(s); }).join('/');
      var body = init.body;
      if (typeof FormData !== 'undefined' && body instanceof FormData) return restUnsupported('storage upload with FormData');
      var upsert = String(h['x-upsert'] || '') === 'true' || method === 'PUT';
      return client.storage.from(bucket).upload(objPath, body, { contentType: h['content-type'] || (body && body.type) || undefined, upsert: upsert }).then(function (r) {
        if (r.error) {
          var st = r.error.status === 401 ? 401 : (Number(r.error.status) >= 400 ? Number(r.error.status) : 400);
          return mkResponse(st, { statusCode: r.error.statusCode || String(st), error: r.error.name || 'Error', message: r.error.message });
        }
        return mkResponse(200, { Key: bucket + '/' + r.data.path });
      });
    }
    if (path.indexOf('/storage/v1/') === 0) return restUnsupported(method + ' ' + path.replace(/\/[^/]+$/, '/…'));
    if (path.indexOf('/rest/v1/') !== 0) return restUnsupported(method + ' ' + path);

    /* ---- body ---- */
    var values;
    if (init.body != null) {
      if (typeof init.body !== 'string') return restUnsupported('non-JSON body');
      try { values = JSON.parse(storageUrlsToKeys(init.body)); } catch (e) { return restUnsupported('body that is not JSON'); }
    }

    /* ---- rpc ---- */
    var rm = /^\/rest\/v1\/rpc\/([A-Za-z0-9_]+)$/.exec(path);
    if (rm) {
      if (method !== 'POST') return restUnsupported(method + ' rpc');
      if (Array.from(u.searchParams.keys()).length) return restUnsupported('rpc with query params');
      var rq = client.rpc(rm[1], values || {});
      rq._anon = anon;
      if (init.signal) rq.abortSignal(init.signal);
      return rq.then(function (r) {
        if (r.error) return errResponse(r.error, r.status === 401 ? 401 : null);
        return mkResponse(200, r.data === undefined ? null : r.data);
      });
    }

    /* ---- table ---- */
    var tm = /^\/rest\/v1\/([A-Za-z0-9_]+)\/?$/.exec(path);
    if (!tm) return restUnsupported(method + ' ' + path);
    var table = tm[1];
    var select = null, order = [], limit = null, offset = null, onConflict = null, filters = [], bad = [];
    u.searchParams.forEach(function (v, k) {
      if (k === 'select') select = v;
      else if (k === 'order') {
        v.split(',').forEach(function (part) {
          var bits = part.split('.');
          var col = bits.shift(); var o = {};
          bits.forEach(function (b) {
            if (b === 'asc') o.ascending = true; else if (b === 'desc') o.ascending = false;
            else if (b === 'nullsfirst') o.nullsFirst = true; else if (b === 'nullslast') o.nullsFirst = false;
            else bad.push('order modifier "' + b + '"');
          });
          if (col) order.push([col, o]);
        });
      }
      else if (k === 'limit') limit = Number(v);
      else if (k === 'offset') offset = Number(v);
      else if (k === 'on_conflict') onConflict = v;
      else if (k === 'or' || k === 'and' || k === 'columns') bad.push('"' + k + '=" param');
      else {
        var fm = /^(not\.)?([a-z]+)\.([\s\S]*)$/.exec(v);
        if (!fm || REST_OPS.indexOf(fm[2]) < 0) { bad.push('filter ' + k + '=' + String(v).split('.')[0] + '.…'); return; }
        if (fm[1] && fm[2] !== 'is') { bad.push('filter not.' + fm[2]); return; }
        var val = parseRestValue(fm[2], fm[3]);
        if (val === undefined) { bad.push('filter ' + k + '=is.' + fm[3]); return; }
        filters.push([k, (fm[1] ? 'not.' : '') + fm[2], val]);
      }
    });
    if (offset != null && limit == null) bad.push('offset without limit');
    if (/resolution=ignore-duplicates/.test(prefer)) bad.push('Prefer resolution=ignore-duplicates');
    if (bad.length) return restUnsupported(bad.join('; ') + ' (table ' + table + ')');

    var q = client.from(table);
    q._anon = anon;
    var wantRows = /return=representation/.test(prefer);
    var kind;
    if (method === 'GET' || method === 'HEAD') { kind = 'select'; q = q.select(select || '*'); }
    else if (method === 'POST') {
      if (filters.length) return restUnsupported('filters on insert (table ' + table + ')');
      if (/resolution=merge-duplicates/.test(prefer)) { kind = 'upsert'; q = q.upsert(values, onConflict ? { onConflict: onConflict } : undefined); }
      else { kind = 'insert'; q = q.insert(values); }
    }
    else if (method === 'PATCH') { kind = 'update'; q = q.update(values); }
    else if (method === 'DELETE') { kind = 'delete'; q = q['delete'](); }
    else return restUnsupported(method + ' (table ' + table + ')');
    filters.forEach(function (f) {
      if (f[1] === 'not.is') q = q.not(f[0], 'is', f[2]);
      else q = q[f[1]](f[0], f[2]);
    });
    order.forEach(function (o) { q = q.order(o[0], o[1]); });
    if (limit != null) { if (offset != null) q = q.range(offset, offset + limit - 1); else q = q.limit(limit); }
    if (kind !== 'select' && wantRows) q = q.select(select || '*');
    if (init.signal) q = q.abortSignal(init.signal);
    return q.then(function (r) {
      if (r.error) return errResponse(r.error, r.status === 401 ? 401 : null);
      if (kind === 'select') return mkResponse(200, method === 'HEAD' ? '' : (r.data == null ? [] : r.data));
      if (wantRows) { var rows = r.data == null ? [] : (Array.isArray(r.data) ? r.data : [r.data]); return mkResponse(kind === 'insert' || kind === 'upsert' ? 201 : 200, rows); }
      return mkResponse(kind === 'insert' || kind === 'upsert' ? 201 : 204);
    });
  }

  var GLCF = {
    version: '1.0.0',
    DEFAULT_API: DEFAULT_API,
    SWITCH_KEY: SWITCH_KEY,
    UNSUPPORTED: UNSUPPORTED,
    DEFAULT_EMBEDS: DEFAULT_EMBEDS,
    enabled: enabled,
    applyUrlSwitch: applyUrlSwitch,
    createClient: createClient,
    handleSupabaseFetch: handleSupabaseFetch,
    isAnonRequest: isAnonRequest,
    normalizePhone: normalizePhone,
    storageUrlsToKeys: storageUrlsToKeys,
    storageUrlsToSigned: storageUrlsToSigned,
    SUPABASE_ORIGIN: SUPABASE_ORIGIN
  };
  g.GLCF = GLCF;
  if (typeof module !== 'undefined' && module.exports) module.exports = GLCF;
})(typeof window !== 'undefined' ? window : globalThis);
