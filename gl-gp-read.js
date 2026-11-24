/* Grandpride READ-ONLY data for Grandlab pages  (gl-api: GET /gl/gpread/me | tower | staff-apps | desk).
   Replaces the reads from the old gateway gpdb.grandlab.com.my (stopped 21 Nov). Works the same on both backend settings:
     switch "cf" -> the Grandlab Cloudflare login (GLCF_PAGE.client.auth.token())
     switch "sb" -> the Grandlab Supabase login (localStorage 'gl_auth', the shared sign-in)
   The server answers only about the signed-in person: `me` returns that person's OWN staff row (name + apps), nothing else;
   tower / staff-apps / desk need the matching app. No phone, birthday, location or profile ever comes back.
   Every call returns what supabase-js returned, {data, error}, so the page code after the call stays as it was.

   ACCESS GUARD SWITCH (one place, all pages): GLGP.GUARD_FAIL_OPEN
     true  (now)  if the staff-list check itself cannot run (server down, network, login not recognised) the person is let in;
                  only a clear answer "not in the staff list" / "no access to this app" blocks.
     false        a failed check blocks the page ("NO ACCESS"), like the old behaviour.
   To flip: change the one word below and push this file. */
(function (g) {
  var GUARD_FAIL_OPEN = true;                                      // <<< the switch described above
  var API = 'https://gl-api.jimmykuek94.workers.dev';              // same default as gl-cf-client.js; override: localStorage gl_api_base
  var TIMEOUT_MS = 8000;                                           // a hung server must not hang the page

  function base() { try { return (g.localStorage.getItem('gl_api_base') || API).replace(/\/+$/, ''); } catch (e) { return API; } }
  function token() {
    try { if (g.GLCF_PAGE && g.GLCF_PAGE.client) { var t = g.GLCF_PAGE.client.auth.token(); if (t) return t; } } catch (e) {}
    try {
      var s = JSON.parse(g.localStorage.getItem('gl_auth') || 'null');
      return (s && (s.access_token || (s.currentSession && s.currentSession.access_token))) || null;
    } catch (e) { return null; }
  }
  function fail(code, message) { return { data: null, error: { code: code, message: message } }; }
  function get(view, tok) {
    tok = tok || token();
    if (!tok) return Promise.resolve(fail('401', 'Not signed in'));
    var ctl = (typeof g.AbortController === 'function') ? new g.AbortController() : null;
    var timer = ctl ? setTimeout(function () { try { ctl.abort(); } catch (e) {} }, TIMEOUT_MS) : null;
    return g.fetch(base() + '/gl/gpread/' + view, { headers: { Authorization: 'Bearer ' + tok }, signal: ctl ? ctl.signal : undefined })
      .then(function (r) {
        return r.json().then(function (j) {
          if (!j || typeof j !== 'object') return fail(String(r.status), 'HTTP ' + r.status);
          if (!r.ok && !j.error) j.error = { code: String(r.status), message: 'HTTP ' + r.status };
          return j;
        }, function () { return fail(String(r.status), 'HTTP ' + r.status); });
      })
      .catch(function (e) { return fail('NET', String((e && e.message) || e)); })
      .then(function (j) { if (timer) clearTimeout(timer); return j; });
  }

  g.GLGP = {
    GUARD_FAIL_OPEN: GUARD_FAIL_OPEN,
    me: function (tok) { return get('me', tok); },                    // {data:{username,name,apps}|null, master, error}
    staffApps: function (tok) { return get('staff-apps', tok); },     // {data:[{username,name,role,apps}], error}
    tower: function (tok) {                                           // three supabase-style results for gl-tower / gl-tower-lite
      return get('tower', tok).then(function (j) {
        var e = j.error || null;
        return { staff: { data: e ? null : (j.staff || []), error: e }, attendance: { data: e ? null : (j.attendance || []), error: e }, fleet: { data: e ? null : (j.fleet || []), error: e } };
      });
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
