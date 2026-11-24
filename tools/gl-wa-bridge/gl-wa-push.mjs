/* Phone alerts from the bridge (web push). Sends one notification per new customer
   message to every phone/computer that tapped "Phone alerts" in the CRM.
   - Needs the "web-push" npm module (npm install web-push, once, in this folder) and
     VAPID_PUBLIC / VAPID_PRIVATE / VAPID_SUBJECT in .env. Without them it does nothing.
   - Only fresh incoming messages (last 10 minutes), at most one push per chat per 2 minutes.
   - Never touches customers or the CRM tables (read-only RPC for the subscriber list).
   - Everything is wrapped: a failure here can never stop the WhatsApp import.          */
export function createPush({ env, api, log, now = () => Date.now(), loadLib = () => import('web-push'), throttleMs = 120000, listTtlMs = 60000 }) {
  const PUB = String(env.VAPID_PUBLIC || '').trim(), PRIV = String(env.VAPID_PRIVATE || '').trim();
  const SUBJ = String(env.VAPID_SUBJECT || 'mailto:info@grandpride.com').trim();
  const CRM = String(env.CRM_URL || 'https://app.grandlab.com.my/gl-crm.html').trim();
  const enabled = !!(PUB && PRIV);
  let lib = null, subs = [], subsAt = 0, warned = false;
  const last = new Map();

  async function ready() {
    if (lib) return true;
    try {
      const m = await loadLib(); lib = m.default || m;
      lib.setVapidDetails(SUBJ, PUB, PRIV); return true;
    } catch (e) {
      if (!warned) { warned = true; log('push: web-push module not available (run: npm install web-push) —', String(e.message || e).slice(0, 100)); }
      return false;
    }
  }
  async function getSubs() {
    if (now() - subsAt < listTtlMs) return subs;
    const r = await api('rpc/gl_crm_push_list', { method: 'POST', body: {} });
    subs = Array.isArray(r) ? r : []; subsAt = now(); return subs;
  }
  /* rows = freshly inserted gl_wa_msg rows */
  async function onNew(rows) {
    try {
      if (!enabled || !Array.isArray(rows) || !rows.length) return 0;
      const t = now();
      const fresh = rows.filter(r => r && r.direction === 'in' && r.wa_ts && t - Date.parse(r.wa_ts) < 600000);
      if (!fresh.length) return 0;
      if (!(await ready())) return 0;
      const list = await getSubs(); if (!list.length) return 0;
      let sent = 0;
      for (const r of fresh) {
        if (t - (last.get(r.chat_jid) || 0) < throttleMs) continue;
        last.set(r.chat_jid, t);
        const name = r.name || (r.phone ? '+' + String(r.phone).replace(/\D/g, '') : 'Customer');
        const body = String(r.body || '').trim() || ({ voice: 'Voice note', audio: 'Voice note', image: 'Photo', video: 'Video' }[String(r.msg_type || '').toLowerCase()] || 'New message');
        const payload = JSON.stringify({ title: name, body: body.slice(0, 110), tag: 'chat-' + r.chat_jid, url: CRM + '#pipeline' });
        await Promise.all(list.map(async s => {
          try { await lib.sendNotification(s.sub, payload); sent++; }
          catch (e) { /* expired subscriptions just fail; nothing is deleted */ }
        }));
      }
      return sent;
    } catch (e) { try { log('push:', String(e && e.message || e).slice(0, 120)); } catch (_) {} return 0; }
  }
  return { onNew, enabled };
}
