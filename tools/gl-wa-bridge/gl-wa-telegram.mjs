/*
  gl-wa-telegram — a Telegram card for every customer who has been left waiting.

  Lives inside the bridge (gl-wa-bridge.mjs loads it) and is OFF unless
  TELEGRAM_TOKEN and TELEGRAM_JOIN_CODE are both set in .env.

  What it does
    - Every few seconds it looks for a customer whose last message has gone
      unanswered for TELEGRAM_WAIT_MINUTES (default 3).
    - It asks MIA for drafts (the same MIA function the CRM uses) and sends ONE
      card to your Telegram: who, what they said, and draft buttons.
    - Tap a draft -> it shows the full text -> tap "Yes, send" -> the reply is
      put in the CRM outbox, and the bridge sends it on WhatsApp like any
      other CRM reply (same staff-name header, same limits).

  What it never does
    - Never sends anything without your "Yes, send" tap.
    - Never messages anyone who has not messaged the shop first (the outbox
      only accepts existing chats).
    - Never pings the same customer message twice, and never goes back through
      old chats: it only watches the last TELEGRAM_MAX_AGE_HOURS.
    - Voice notes: skipped entirely (no card, no draft), as agreed for MIA.
    - Never stops the bridge. Any Telegram or MIA problem is logged and the
      WhatsApp import carries on.

  Only the Telegram account that sends  /start <TELEGRAM_JOIN_CODE>  can use
  the bot. Anyone else is ignored without a reply.
*/

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const enc = encodeURIComponent;

const LANGS = [['en', 'EN'], ['bm', 'BM'], ['zh', '中文']];
const OPTS  = [['short', '1 Short'], ['explain', '2 Explain'], ['push', '3 Push']];

function guessLang(txt) {
  const t = String(txt || '');
  if (/[一-鿿]/.test(t)) return 'zh';
  if (/\b(boleh|nak|nk|berapa|brp|harga|saya|tak|tidak|ada|macam|kereta|tolong|lah|bila|esok|sila|terima kasih|tq|cuci|kaca|nanti|dah|ye|ya)\b/i.test(t)) return 'bm';
  return 'en';
}

export function createTelegram({ env, api, log, miaCall, stateFile, crmUrl }) {
  const TOKEN   = String(env.TELEGRAM_TOKEN || '').trim();
  const JOIN    = String(env.TELEGRAM_JOIN_CODE || '').trim();
  const BASE    = String(env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');
  const WAIT_MIN  = Math.max(1, Number(env.TELEGRAM_WAIT_MINUTES || 3));
  const MAX_AGE_H = Math.max(1, Number(env.TELEGRAM_MAX_AGE_HOURS || 6));
  const MAX_PER_TICK = Math.max(1, Number(env.TELEGRAM_MAX_CARDS_PER_CHECK || 4));
  // who the customer sees on the front of an approved reply; blank = no name
  const SIGN_AS = String(env.TELEGRAM_SIGN_AS == null ? 'Jimmy' : env.TELEGRAM_SIGN_AS).trim();
  const SEND_ON = /^(1|true|yes|on)$/i.test(String(env.SEND_ENABLED || ''));
  const IGNORE  = new Set(String(env.TELEGRAM_IGNORE || '').split(/[,\s]+/).map(s => s.replace(/\D/g, '')).filter(Boolean));
  const enabled = !!(TOKEN && JOIN);

  /* ---------- what survives a restart ---------- */
  let state = { chatId: null, baselined: false, pinged: {}, muted: [] };
  try { if (stateFile && existsSync(stateFile)) state = Object.assign(state, JSON.parse(readFileSync(stateFile, 'utf8'))); } catch (e) {}
  const save = () => { try { if (stateFile) writeFileSync(stateFile, JSON.stringify(state)); } catch (e) {} };
  const muted = () => new Set((state.muted || []).map(String));

  /* ---------- Telegram ---------- */
  async function tg(method, params = {}, timeoutMs = 20000) {
    const r = await fetch(`${BASE}/bot${TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) throw new Error(`${method}: ${j.description || r.status}`);
    return j.result;
  }
  const say = (text, extra = {}) => tg('sendMessage', Object.assign({ chat_id: state.chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }, extra));
  async function edit(c, text, keyboard) {
    try {
      await tg('editMessageText', {
        chat_id: state.chatId, message_id: c.msgId, text, parse_mode: 'HTML', disable_web_page_preview: true,
        reply_markup: { inline_keyboard: keyboard || [] }
      });
    } catch (e) { if (!/not modified/i.test(e.message)) throw e; }
  }

  /* ---------- cards ---------- */
  const CARDS = new Map();
  let seq = 0;
  const newId = () => (++seq).toString(36) + Math.random().toString(36).slice(2, 5);
  const btn = (text, id, act, arg = '') => ({ text, callback_data: [id, act, arg].join('|') });
  const crmBtn = crmUrl ? [{ text: 'Open CRM', url: crmUrl }] : [];

  function header(c) {
    const who = c.name ? `<b>${esc(c.name)}</b> · ${esc(c.phone)}` : `<b>${esc(c.phone || c.jid)}</b>`;
    return `${who}\n<i>waiting ${esc(c.waited)}</i>\n\n${esc(clip(c.said, 600))}`;
  }
  function keyboardDrafts(c) {
    const set = (c.reply && c.reply[c.lang]) || {};
    const row1 = OPTS.filter(([k]) => set[k]).map(([k, l]) => btn(l, c.id, 'o', k));
    const row2 = LANGS.map(([k, l]) => btn((c.lang === k ? '• ' : '') + l, c.id, 'l', k));
    return [row1, row2, [btn('🔇 Mute', c.id, 'm'), btn('❌ Skip', c.id, 's'), ...crmBtn]].filter(r => r.length);
  }
  function render(c) {
    const r = c.reply;
    if (c.mode === 'clarify') {
      const kb = (r.options || []).map((o, i) => [btn(clip(o, 40), c.id, 'q', String(i))]);
      kb.push([btn('❌ Skip', c.id, 's'), ...crmBtn]);
      return { text: `${header(c)}\n\n❓ <b>MIA needs to know:</b> ${esc(r.question || '')}`, kb };
    }
    if (c.mode === 'confirm') {
      return { text: `${header(c)}\n\n━━━━━━━━\n${esc(c.chosen)}\n━━━━━━━━\n<b>Send this to ${esc(c.name || c.phone)}?</b>`,
        kb: [[btn('✅ Yes, send', c.id, 'y'), btn('⬅ Back', c.id, 'b'), btn('❌ Skip', c.id, 's')]] };
    }
    if (c.mode === 'stale') {
      return { text: `${header(c)}\n\n⚠️ <b>${esc(c.staleWhy)}</b>\nSend it anyway?`,
        kb: [[btn('Send anyway', c.id, 'f'), btn('⬅ Back', c.id, 'b'), btn('❌ Skip', c.id, 's')]] };
    }
    if (c.mode === 'nomia') {
      return { text: `${header(c)}\n\n${esc(c.why)}`, kb: [[btn('🔇 Mute', c.id, 'm'), btn('❌ Skip', c.id, 's'), ...crmBtn]] };
    }
    const warn = r && typeof r.handover === 'string' && r.handover.trim()
      ? `\n\n⚠️ <b>Check before sending:</b> ${esc(r.handover.trim())}` : '';
    const note = r && r.note ? `\n<i>${esc(clip(r.note, 200))}</i>` : '';
    const set = (r && r[c.lang]) || {};
    const none = OPTS.some(([k]) => set[k]) ? '' : `\n\nNo ${c.lang.toUpperCase()} version this time — try another language.`;
    return { text: `${header(c)}${note}${warn}${none}`, kb: keyboardDrafts(c) };
  }
  const draw = c => { const v = render(c); return edit(c, v.text, v.kb); };

  /* ---------- asking MIA ---------- */
  function transcript(rows) {
    return rows.slice(-12).map(m => {
      const t = String(m.msg_type || '').toLowerCase();
      let txt = String(m.body || '').trim();
      if (!txt) txt = ['voice', 'audio'].includes(t) ? '[voice note - not transcribed]'
        : t === 'image' ? '[photo]' : t === 'video' ? '[video]' : t === 'document' ? '[document]' : '';
      return txt ? (m.direction === 'out' ? 'Grandlab: ' : 'Customer: ') + txt : '';
    }).filter(Boolean).join('\n');
  }
  async function askMia(c, answer) {
    const msgs = [{ role: 'user', content: [{ type: 'text', text:
      'This is the WhatsApp chat so far, oldest first. Write what Grandlab should send next.\n\n' + c.transcript }] }];
    if (answer && c.extra) {
      msgs.push({ role: 'assistant', content: [{ type: 'text', text: c.extra }] });
      msgs.push({ role: 'user', content: [{ type: 'text', text: answer }] });
    }
    const out = await miaCall(msgs);
    c.extra = out && out.text || null;
    const r = out && out.reply;
    if (r && r.type === 'clarify') { c.reply = r; c.mode = 'clarify'; }
    else if (r && r.type === 'reply') { c.reply = r; c.mode = 'drafts'; }
    else { c.reply = null; c.mode = 'nomia'; c.why = 'MIA had nothing to suggest. Open the CRM to answer.'; }
  }

  /* ---------- finding who is waiting ---------- */
  function waitedText(ms) {
    const m = Math.max(1, Math.round(ms / 60000));
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}m`;
  }
  async function tick() {
    if (!enabled || !state.chatId) return { cards: 0 };
    const now = Date.now();
    const since = new Date(now - MAX_AGE_H * 3600e3).toISOString();
    const until = new Date(now - WAIT_MIN * 60e3).toISOString();
    const chats = await api(
      `gl_wa_chat?select=chat_jid,phone,name,last_in_at,last_out_at` +
      `&last_in_at=gte.${enc(since)}&last_in_at=lte.${enc(until)}&order=last_in_at.asc&limit=40`) || [];
    const waiting = chats.filter(ch => {
      const li = Date.parse(ch.last_in_at), lo = ch.last_out_at ? Date.parse(ch.last_out_at) : 0;
      return li > lo;
    });

    /* The very first time, do not announce every chat that is already open.
       Mark them seen and only speak about what arrives from now on. */
    if (!state.baselined) {
      for (const ch of waiting) state.pinged[ch.chat_jid] = ch.last_in_at;
      state.baselined = true; save();
      log(`telegram: first run — ${waiting.length} chat(s) already waiting were marked as seen, not announced`);
      return { cards: 0, baseline: waiting.length };
    }

    let cards = 0;
    const mutedSet = muted();
    for (const ch of waiting) {
      if (cards >= MAX_PER_TICK) break;
      const seen = state.pinged[ch.chat_jid];
      if (seen && Date.parse(seen) >= Date.parse(ch.last_in_at)) continue;
      const phone = String(ch.phone || ch.chat_jid.split('@')[0]).replace(/\D/g, '');
      state.pinged[ch.chat_jid] = ch.last_in_at;           // never twice for the same message
      save();
      if (mutedSet.has(phone) || IGNORE.has(phone)) continue;

      const rows = (await api(
        `gl_wa_msg?chat_jid=eq.${enc(ch.chat_jid)}&select=direction,msg_type,body,wa_ts&order=wa_ts.desc&limit=12`) || []).reverse();
      const last = rows[rows.length - 1];
      if (!last || last.direction !== 'in') continue;       // somebody answered in the meantime
      const lastType = String(last.msg_type || '').toLowerCase();
      if (['voice', 'audio'].includes(lastType)) { log(`telegram: ${phone} sent a voice note — skipped on purpose`); continue; }

      // what they said since we last spoke, newest at the bottom
      let i = rows.length - 1; const said = [];
      while (i >= 0 && rows[i].direction === 'in' && said.length < 4) {
        const m = rows[i];
        const t = String(m.msg_type || '').toLowerCase();
        said.unshift(String(m.body || '').trim() || (t === 'image' ? '📷 photo' : t === 'video' ? '🎬 video' : t === 'document' ? '📄 document' : t === 'sticker' ? 'sticker' : '(no text)'));
        i--;
      }
      const c = {
        id: newId(), jid: ch.chat_jid, phone, name: ch.name || '', lastIn: ch.last_in_at,
        waited: waitedText(now - Date.parse(ch.last_in_at)),
        said: said.join('\n'), transcript: transcript(rows), reply: null, extra: null,
        lang: guessLang(rows.filter(m => m.direction === 'in' && m.body).slice(-3).map(m => m.body).join(' ')),
        mode: 'drafts', msgId: null
      };
      const hasText = rows.slice(-4).some(m => m.direction === 'in' && String(m.body || '').trim());
      try {
        if (hasText) await askMia(c); else { c.mode = 'nomia'; c.why = 'They sent something with no text (a photo or similar), so MIA has nothing to read. Open the CRM to answer.'; }
      } catch (e) {
        c.mode = 'nomia'; c.why = 'MIA could not be reached (' + clip(e.message || e, 80) + '). Open the CRM to answer.';
        log('telegram: MIA failed for ' + phone + ': ' + (e.message || e));
      }
      const v = render(c);
      const sent = await say(v.text, { reply_markup: { inline_keyboard: v.kb } });
      c.msgId = sent.message_id; CARDS.set(c.id, c);
      cards++;
      log(`telegram: card sent for ${phone}`);
    }
    return { cards };
  }

  /* ---------- reading taps ---------- */
  async function queueReply(c, text) {
    if (!SEND_ON) {
      await edit(c, `${header(c)}\n\n⚠️ Not sent. Replies are switched off on the bridge (<code>SEND_ENABLED=0</code> in .env).`, [[...crmBtn]]);
      return false;
    }
    const body = SIGN_AS ? `*${SIGN_AS}:*\n${text}` : text;
    await api('gl_wa_outbox', {
      method: 'POST', prefer: 'return=minimal',
      body: { chat_jid: c.jid, phone: c.phone || null, body, staff_name: SIGN_AS || null }
    });
    await edit(c, `${header(c)}\n\n✅ <b>Queued.</b> The bridge sends it on WhatsApp within a minute:\n${esc(clip(text, 500))}`, []);
    log(`telegram: reply approved for ${c.phone}`);
    return true;
  }

  async function onTap(cq) {
    const chat = cq.message && cq.message.chat && cq.message.chat.id;
    if (!state.chatId || String(chat) !== String(state.chatId)) {         // not the linked account
      await tg('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});
      return;
    }
    const [id, act, arg] = String(cq.data || '').split('|');
    const c = CARDS.get(id);
    if (!c) {
      await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'This card is old — answer it in the CRM.', show_alert: true }).catch(() => {});
      return;
    }
    await tg('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});

    if (act === 's') { CARDS.delete(id); return edit(c, `${header(c)}\n\n— skipped`, []); }
    if (act === 'm') {
      state.muted = Array.from(new Set([...(state.muted || []), c.phone])); save(); CARDS.delete(id);
      return edit(c, `${header(c)}\n\n🔇 Muted. No more cards for ${esc(c.phone)}.`, []);
    }
    if (act === 'l') { c.lang = arg; c.mode = 'drafts'; return draw(c); }
    if (act === 'b') { c.mode = 'drafts'; return draw(c); }
    if (act === 'o') {
      const txt = c.reply && c.reply[c.lang] && c.reply[c.lang][arg];
      if (!txt) return;
      c.chosen = txt; c.mode = 'confirm'; return draw(c);
    }
    if (act === 'q') {
      const pick = c.reply && c.reply.options && c.reply.options[Number(arg)];
      if (pick == null) return;
      await edit(c, `${header(c)}\n\n… asking MIA`, []);
      try { await askMia(c, String(pick)); }
      catch (e) { c.mode = 'nomia'; c.why = 'MIA could not be reached (' + clip(e.message || e, 80) + '). Open the CRM to answer.'; }
      return draw(c);
    }
    if (act === 'y' || act === 'f') {
      if (!c.chosen) return;
      if (act === 'y') {
        // is the card still true? somebody may have answered from the CRM or the phone
        const cur = (await api(`gl_wa_chat?chat_jid=eq.${enc(c.jid)}&select=last_in_at,last_out_at`) || [])[0];
        if (cur) {
          const li = Date.parse(cur.last_in_at || 0), lo = cur.last_out_at ? Date.parse(cur.last_out_at) : 0;
          if (lo > Date.parse(c.lastIn)) { c.mode = 'stale'; c.staleWhy = 'Someone has already replied since this card was sent.'; return draw(c); }
          if (li > Date.parse(c.lastIn)) { c.mode = 'stale'; c.staleWhy = 'The customer has written again since this card was sent — the draft may not fit.'; return draw(c); }
        }
      }
      CARDS.delete(id);
      try { await queueReply(c, c.chosen); }
      catch (e) { log('telegram: could not queue reply: ' + (e.message || e)); await edit(c, `${header(c)}\n\n⚠️ Could not queue it: ${esc(clip(e.message || e, 120))}. Answer in the CRM.`, [[...crmBtn]]); }
    }
  }

  async function onMessage(m) {
    const text = String(m.text || '').trim();
    const chat = m.chat && m.chat.id;
    const mt = /^\/start(?:@\w+)?\s+(\S+)/.exec(text);
    if (mt) {                                   // linking. Wrong code: stay silent.
      if (mt[1] === JOIN) {
        state.chatId = chat; save();
        await say('✅ <b>Linked.</b> When a customer has waited ' + WAIT_MIN + ' minutes, a card comes here. Nothing is sent until you tap “Yes, send”.');
        log('telegram: linked to a Telegram account');
      }
      return;
    }
    if (!state.chatId || String(chat) !== String(state.chatId)) return;   // strangers get nothing
    if (/^\/status/.test(text)) {
      await say(`Watching. Cards after ${WAIT_MIN} min of waiting, looking back ${MAX_AGE_H}h. Replies from here are ${SEND_ON ? 'ON' : 'OFF'}. Muted numbers: ${(state.muted || []).length}.`);
    } else if (/^\/unmute/.test(text)) {
      state.muted = []; save(); await say('All numbers unmuted.');
    }
  }

  async function pollLoop() {
    try { await tg('deleteWebhook', { drop_pending_updates: false }); } catch (e) { log('telegram: ' + e.message); }
    let offset = 0, quiet = 0;
    for (;;) {
      try {
        const ups = await tg('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, 40000);
        quiet = 0;
        for (const u of ups) {
          offset = u.update_id + 1;
          try {
            if (u.callback_query) await onTap(u.callback_query);
            else if (u.message) await onMessage(u.message);
          } catch (e) { log('telegram: ' + (e.message || e)); }
        }
      } catch (e) {
        // a dropped network (the workplace WiFi restarts around midnight) just waits and tries again
        if (quiet++ % 20 === 0) log('telegram: ' + (e.message || e) + ' — retrying');
        await sleep(Math.min(60000, 5000 * (1 + quiet)));
      }
      if (process.env.GL_TG_ONCE) return;       // test hook only
    }
  }

  return {
    enabled, tick, onTap, onMessage, tg, pollLoop,
    start() {
      if (!enabled) { log('telegram cards are OFF — set TELEGRAM_TOKEN and TELEGRAM_JOIN_CODE in .env to turn them on'); return; }
      log(state.chatId
        ? `telegram cards are ON (after ${WAIT_MIN} min waiting)`
        : 'telegram cards are ON but not linked yet — in Telegram, open your bot and send:  /start  then a space, then your join code');
      pollLoop().catch(e => log('telegram stopped: ' + (e.message || e)));
    },
    _state: () => state
  };
}
