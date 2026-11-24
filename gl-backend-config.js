/* GO-LIVE SWITCH for the new Grandlab backend (Cloudflare). docs/cf-migration-gl.md
   "sb" = the current system (Supabase, db.grandlab.com.my)      "cf" = the new system (gl-api on Cloudflare)

   GL_BACKEND_DEFAULT  the setting for every module below that says "default" (and for a page with no module).
   GL_BACKEND_MODULES  one word per module, so the modules can go live one at a time:
                         "sb"       this module stays on the current system
                         "cf"       this module uses the new system
                         "default"  follow GL_BACKEND_DEFAULT
   Which page belongs to which module: the table in docs/cf-migration-gl.md (each page also says it in its guard).
   A phone/PC that opened a page with ?backend=cf (or ?backend=sb) keeps that choice for ALL modules until it
   opens ?backend=auto. Switch-over day: change the words below (one-line commits). Going back: change them back. */
window.GL_BACKEND_DEFAULT = "sb";
window.GL_BACKEND_MODULES = {
  core:      "cf",   // shop floor + staff tools: Hub, job card, plate scan, appointments, POS, TV board, QC, commission, win-back...
  customer:  "cf",   // customer app (index.html) + customer / partner links (receipt, e-warranty, inspection, QC view, SA quote)
  marketing: "cf",   // marketing analysis, ads report, marketing calendar
  claim:     "cf"    // GL Claim (expense claims)
};

/* ---- do not change below (shared by every Grandlab page) ----
   GL_BACKEND_PICK(module) -> "cf" | "sb" for this page load:
     ?backend=cf    this device: new system (remembered, all modules)
     ?backend=sb    this device: current system. Remembered only while this page's module is set to "cf"
                    (emergency fallback); while it is "sb" it just clears the device choice (as before go-live)
     ?backend=auto  this device: forget the choice, follow the settings above
     otherwise      the remembered device choice (localStorage.gl_backend), else the module's setting
   GL_BACKEND_SOURCE(module) -> "device" | "default" (where the answer came from)
   GL_BACKEND_MODULE_SETTING(module) -> "cf" | "sb" (the setting above, ignoring any device choice) */
(function (g) {
  var KEY = 'gl_backend';
  function word(v) { return v === 'cf' ? 'cf' : 'sb'; }
  function setting(mod) {
    var m = g.GL_BACKEND_MODULES || {};
    var v = mod && Object.prototype.hasOwnProperty.call(m, mod) ? m[mod] : 'default';
    if (v === 'cf' || v === 'sb') return v;
    return word(g.GL_BACKEND_DEFAULT);
  }
  function get() { try { return g.localStorage.getItem(KEY); } catch (e) { return null; } }
  function set(v) { try { if (v == null) g.localStorage.removeItem(KEY); else g.localStorage.setItem(KEY, v); } catch (e) {} }
  function applyUrl(mod) {
    try {
      var m = /[?&]backend=(cf|sb|auto)(?:&|$)/.exec((g.location && g.location.search) || '');
      if (!m) return;
      if (m[1] === 'cf') set('cf');
      else if (m[1] === 'sb') set(setting(mod) === 'cf' ? 'sb' : null);
      else set(null);
    } catch (e) {}
  }
  g.GL_BACKEND_MODULE_SETTING = function (mod) { return setting(mod); };
  g.GL_BACKEND_PICK = function (mod) {
    applyUrl(mod);
    var v = get();
    if (v === 'cf' || v === 'sb') return v;
    return setting(mod);
  };
  g.GL_BACKEND_SOURCE = function () {
    var v = get();
    return (v === 'cf' || v === 'sb') ? 'device' : 'default';
  };
})(window);
