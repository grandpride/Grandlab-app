/* Bridge watchdog: tells Jimmy on Telegram when no WhatsApp message has reached
   the database for a long time, and once more when it is back.

   - Reads only. Never sends to customers, never writes to the CRM tables.
   - Uses the same Telegram bot and chat the cards already use (telegram-state.json).
   - Only alerts between 08:00 and 22:00 Kuala Lumpur time, once per quiet spell.
   - Everything is wrapped in try/catch: a failure here can never stop the import loop.
   - TELEGRAM_QUIET_ALERT_HOURS in .env (default 6). Set to 0 to turn it off.      */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

export function createWatchdog({ env, api, log, stateFile, tgStateFile, now = () => Date.now(), fetchFn = fetch, checkEveryMs = 5 * 60 * 1000 }) {
  const HOURS = env.TELEGRAM_QUIET_ALERT_HOURS === undefined || env.TELEGRAM_QUIET_ALERT_HOURS === ''
    ? 6 : Number(env.TELEGRAM_QUIET_ALERT_HOURS);
  const TOKEN = String(env.TELEGRAM_TOKEN || '').trim();
  const BASE = String(env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');
  let st = { alerted: false, alertedAt: null };
  try { if (stateFile && existsSync(stateFile)) st = Object.assign(st, JSON.parse(readFileSync(stateFile, 'utf8'))); } catch (e) {}
  const save = () => { try { if (stateFile) writeFileSync(stateFile, JSON.stringify(st)); } catch (e) {} };
  let lastCheck = 0;

  const klHour = t => new Date(t + 8 * 3600e3).getUTCHours();
  const say = async text => {
    const chat = JSON.parse(readFileSync(tgStateFile, 'utf8')).chatId;
    if (!TOKEN || !chat) return false;
    const r = await fetchFn(`${BASE}/bot${TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML' })
    });
    return r.ok;
  };

  async function tick() {
    try {
      if (!(HOURS > 0) || !TOKEN) return 'off';
      const t = now();
      if (t - lastCheck < checkEveryMs) return 'skip';
      lastCheck = t;
      const rows = await api('gl_wa_msg?select=created_at&order=created_at.desc&limit=1');
      const newest = rows && rows[0] && rows[0].created_at ? Date.parse(rows[0].created_at) : 0;
      if (!newest) return 'nodata';
      const ageH = (t - newest) / 3600e3;
      const h = klHour(t);
      if (ageH >= HOURS && !st.alerted && h >= 8 && h < 22) {
        const ok = await say(`⚠️ <b>CRM bridge quiet</b>\nNo WhatsApp message has reached the CRM for about ${Math.floor(ageH)} hours (last one ${new Date(newest + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 16)} KL time).\nCheck the shop PC: is the bridge window open and WhatsApp still linked?`);
        if (ok) { st.alerted = true; st.alertedAt = new Date(t).toISOString(); save(); }
        return ok ? 'alerted' : 'tg-failed';
      }
      if (ageH < HOURS && st.alerted) {
        const ok = await say('✅ <b>CRM bridge is back</b> — WhatsApp messages are reaching the CRM again.');
        if (ok) { st.alerted = false; st.alertedAt = null; save(); }
        return ok ? 'back' : 'tg-failed';
      }
      return 'ok';
    } catch (e) {
      try { log('watchdog:', String(e && e.message || e).slice(0, 160)); } catch (_) {}
      return 'error';
    }
  }
  return { tick };
}
