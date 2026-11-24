/*
  gl-wa-media — opens ONE voice note / photo when staff press Play in the CRM.
  Nothing is downloaded in bulk: only rows staff asked for in gl_wa_media_req.
  Off unless MEDIA_ENABLED=1 in .env. Never sends anything to WhatsApp.
  Flow: queued row -> wacli media download (one file) -> private bucket gl-wa-media -> row 'done'.
*/
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';

const MIME = { '.ogg':'audio/ogg', '.opus':'audio/ogg', '.oga':'audio/ogg', '.mp3':'audio/mpeg', '.m4a':'audio/mp4', '.aac':'audio/aac',
  '.wav':'audio/wav', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.png':'image/png', '.webp':'image/webp', '.gif':'image/gif' };
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_ATTEMPTS = 3;

export function createMedia({ env, api, log, wacli, account, supabaseUrl, anon, getToken, relogin }) {
  const ENABLED = /^(1|true|yes|on)$/i.test(String(env.MEDIA_ENABLED || ''));
  let busy = false, timer = null;

  async function upload(name, buf, mime, retry = true) {
    const r = await fetch(`${supabaseUrl}/storage/v1/object/gl-wa-media/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { apikey: anon, Authorization: `Bearer ${getToken()}`, 'Content-Type': mime },
      body: buf
    });
    if (r.status === 401 && retry) { await relogin(); return upload(name, buf, mime, false); }
    const txt = await r.text();
    // already uploaded earlier = fine
    if (!r.ok && !/already exists|Duplicate/i.test(txt)) throw new Error(`upload ${r.status} ${txt.slice(0, 160)}`);
  }

  async function one(row) {
    const claimed = await api(`gl_wa_media_req?id=eq.${row.id}&status=eq.queued`, {
      method: 'PATCH', body: { status: 'working', attempts: (row.attempts || 0) + 1, updated_at: new Date().toISOString() },
      prefer: 'return=representation' });
    if (!Array.isArray(claimed) || !claimed.length) return;
    const dir = mkdtempSync(join(tmpdir(), 'glmedia-'));
    try {
      const args = (account ? ['--account', account] : [])
        .concat(['media', 'download', '--chat', row.chat_jid, '--id', row.wa_id, '--output', dir, '--retry-on-phone']);
      const r = spawnSync(wacli, args, { encoding: 'utf8', timeout: 90000, maxBuffer: 16 * 1024 * 1024 });
      if (r.error) throw new Error(r.error.message);
      if (r.status !== 0) throw new Error(String(r.stderr || r.stdout || 'wacli exited ' + r.status).trim().split('\n')[0].slice(0, 200));
      const files = readdirSync(dir).filter(f => statSync(join(dir, f)).isFile());
      if (!files.length) throw new Error('wacli gave no file');
      const f = files[0], ext = extname(f).toLowerCase();
      const size = statSync(join(dir, f)).size;
      if (size > MAX_BYTES) throw new Error('file too large (' + size + ' bytes)');
      const mime = MIME[ext] || (row.msg_type === 'image' ? 'image/jpeg' : 'audio/ogg');
      const name = row.wa_id.replace(/[^A-Za-z0-9_-]/g, '') + (ext || '.bin');
      await upload(name, readFileSync(join(dir, f)), mime);
      await api(`gl_wa_media_req?id=eq.${row.id}`, { method: 'PATCH',
        body: { status: 'done', path: name, mime, error: null, updated_at: new Date().toISOString() } });
      log('media ready: ' + name);
    } catch (e) {
      const msg = String(e && e.message || e).slice(0, 300);
      const final = (row.attempts || 0) + 1 >= MAX_ATTEMPTS;
      await api(`gl_wa_media_req?id=eq.${row.id}`, { method: 'PATCH',
        body: { status: final ? 'failed' : 'queued', error: msg, updated_at: new Date().toISOString() } });
      log('media failed: ' + msg);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch (e) {}   // only this call's own temp folder
    }
  }

  async function tick() {
    if (!ENABLED || busy) return;
    busy = true;
    try {
      // a row stuck in 'working' for 3+ minutes (bridge was closed) goes back to queued
      const old = new Date(Date.now() - 180000).toISOString();
      await api(`gl_wa_media_req?status=eq.working&updated_at=lt.${old}`, { method: 'PATCH', body: { status: 'queued' } });
      const rows = await api(`gl_wa_media_req?status=eq.queued&attempts=lt.${MAX_ATTEMPTS}&select=id,wa_id,chat_jid,msg_type,attempts&order=created_at.asc&limit=3`);
      for (const row of rows || []) await one(row);
    } catch (e) { log('media check failed: ' + String(e.message || e).slice(0, 160)); }
    finally { busy = false; }
  }

  function start() {
    if (!ENABLED) { log('voice notes / photos: OFF (set MEDIA_ENABLED=1 in .env)'); return; }
    log('voice notes / photos: ON (only what staff press Play on)');
    timer = setInterval(() => { tick(); }, 3000);
  }
  return { start, tick, enabled: ENABLED };
}
