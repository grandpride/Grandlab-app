/*
  gl-wa-cf — lets the WhatsApp bridge talk to the new Grandlab backend (gl-api on Cloudflare)
  instead of the laptop's Supabase. OFF unless BACKEND=cloudflare in .env (default: supabase,
  and then this file is not even loaded).

  What it replaces (the bridge's four Supabase calls):
    login()          Supabase  /auth/v1/token?grant_type=password   ->  POST {base}/gl/auth/sign-in/email
                     (same reception login; the password hashes were copied, so the same password works)
    api(path, ...)   Supabase  /rest/v1/<table>?<filters>           ->  POST {base}/gl/api/db  (compat JSON)
                     and       /rest/v1/rpc/<name>                  ->  POST {base}/gl/api/rpc/<name>
    upload(...)      Supabase  /storage/v1/object/gl-wa-media/<name> ->  POST {base}/gl/api/storage/upload
                     (headers x-bucket / x-path; the file lands in R2 as gl/storage/gl-wa-media/<name>)
    miaCall(...)     Supabase  /functions/v1/mia                    ->  POST {base}/gl/api/fn/mia

  Safety, same as the bridge itself: it never sends WhatsApp messages (that stays in the bridge),
  it never deletes (DELETE is refused here), and a PATCH without a filter is refused (so a bug can
  never rewrite a whole table). No key or password is ever logged or put in a URL.
*/

const TABLE = /^[a-z_][a-z0-9_]*$/;
const COL = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FILTER = /^(not\.)?(eq|neq|gt|gte|lt|lte|like|ilike|in|is)\.([\s\S]*)$/;
const CHUNK = 100;   // rows per write request (the server allows 500; D1 batches stay small)

const dec = s => { try { return decodeURIComponent(s); } catch { return s; } };

/* PostgREST list "(a,"b c")" -> ['a','b c'] */
function parseIn(raw) {
  const inner = raw.replace(/^\(/, '').replace(/\)$/, '');
  if (inner === '') return [];
  const out = []; let cur = '', q = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (q && ch === '\\' && i + 1 < inner.length) { cur += inner[++i]; continue; }
    if (ch === '"') { q = !q; continue; }
    if (ch === ',' && !q) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function parseValue(op, raw) {
  if (op === 'in') return parseIn(raw);
  if (op === 'is') {
    if (raw === 'null') return null;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    throw new Error('is.' + raw + ' is not supported');
  }
  if (op === 'like' || op === 'ilike') return raw.replace(/\*/g, '%');
  return raw;   // the server turns text into the column's type
}

/* "gl_wa_chat?chat_jid=eq.x&select=a,b&order=a.asc&limit=5" + method/body/prefer
   -> { url: '/gl/api/db' | '/gl/api/rpc/<name>', body } (the compat JSON, docs/api/compat-contract.md) */
export function restToCompat(path, { method = 'GET', body, prefer = '' } = {}) {
  const m = String(method).toUpperCase();
  const q = String(path).indexOf('?');
  const rawTable = q < 0 ? String(path) : String(path).slice(0, q);
  const qs = q < 0 ? '' : String(path).slice(q + 1);

  if (rawTable.startsWith('rpc/')) {
    const name = rawTable.slice(4);
    if (!TABLE.test(name) || m !== 'POST') throw new Error('bad rpc call: ' + rawTable + ' ' + m);
    return { url: '/gl/api/rpc/' + name, body: body && typeof body === 'object' ? body : {} };
  }
  if (!TABLE.test(rawTable)) throw new Error('bad table name: ' + rawTable.slice(0, 60));
  if (m === 'DELETE') throw new Error('DELETE is not allowed from the bridge');

  const req = { table: rawTable };
  const filters = [];
  const order = [];
  let columns = '*', limit = null, offset = null, onConflict = null;
  for (const part of qs.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const key = dec(eq < 0 ? part : part.slice(0, eq));
    const val = eq < 0 ? '' : dec(part.slice(eq + 1));
    if (key === 'select') { columns = val.replace(/\s+/g, '') || '*'; continue; }
    if (key === 'limit') { limit = Number(val); continue; }
    if (key === 'offset') { offset = Number(val); continue; }
    if (key === 'on_conflict') { onConflict = val.replace(/\s+/g, ''); continue; }
    if (key === 'order') {
      for (const o of val.split(',').filter(Boolean)) {
        const [col, ...mods] = o.split('.');
        if (!COL.test(col)) throw new Error('bad order column: ' + col);
        const desc = mods.includes('desc');
        const nf = mods.includes('nullsfirst') ? true : mods.includes('nullslast') ? false : desc;   // PostgreSQL default
        order.push([col, { ascending: !desc, nullsFirst: nf }]);
      }
      continue;
    }
    if (!COL.test(key)) throw new Error('bad filter column: ' + key.slice(0, 60));
    const f = FILTER.exec(val);
    if (!f) throw new Error('unsupported filter on ' + key + ': ' + val.slice(0, 40));
    const [, not, op, raw] = f;
    if (not && op !== 'is') throw new Error('not.' + op + ' is not supported');
    filters.push([key, not ? 'not.is' : op, parseValue(op, raw)]);
  }

  const p = String(prefer || '').toLowerCase();
  const returning = /return=representation/.test(p);

  if (m === 'GET') {
    Object.assign(req, { op: 'select', columns });
    if (filters.length) req.filters = filters;
    if (order.length) req.order = order;
    if (limit != null) req.limit = limit;
    if (offset != null) req.offset = offset;
    return { url: '/gl/api/db', body: req };
  }
  if (m === 'PATCH') {
    if (!filters.length) throw new Error('PATCH without a filter is refused');
    Object.assign(req, { op: 'update', filters, values: body });
    if (returning) req.returning = true;
    return { url: '/gl/api/db', body: req };
  }
  if (m === 'POST') {
    const ignore = /resolution=ignore-duplicates/.test(p);
    const merge = /resolution=merge-duplicates/.test(p);
    if ((ignore || merge) && !onConflict) throw new Error('on_conflict is needed with Prefer resolution=');
    Object.assign(req, { op: ignore || merge ? 'upsert' : 'insert', values: body });
    if (ignore || merge) req.onConflict = onConflict;
    if (ignore) req.ignoreDuplicates = true;
    if (returning) req.returning = true;
    return { url: '/gl/api/db', body: req };
  }
  throw new Error('method not supported: ' + m);
}

export function createCf({ base, email, password, fetchFn = fetch, log = () => {}, origin = 'https://app.grandlab.com.my' }) {
  const BASE = String(base || '').replace(/\/+$/, '');
  if (!/^https?:\/\/[^/\s]+/.test(BASE)) throw new Error('GL_API_BASE is missing or not a web address');
  let token = null;
  const hdr = extra => ({ Origin: origin, ...extra });

  async function login() {
    const r = await fetchFn(BASE + '/gl/auth/sign-in/email', {
      method: 'POST', headers: hdr({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ email: String(email || '').trim().toLowerCase(), password })
    });
    const t = r.headers.get('set-auth-token');
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !t) throw new Error('Could not sign in to Grandlab (new system): ' + (j.message || j.code || r.status));
    token = t;
    log('signed in to the new Grandlab system');
    return t;
  }

  async function call(url, body, label, retry = true) {
    const r = await fetchFn(BASE + url, {
      method: 'POST', headers: hdr({ Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }),
      body: JSON.stringify(body)
    });
    if (r.status === 401 && retry) { await login(); return call(url, body, label, false); }
    const txt = await r.text();
    if (!r.ok) throw new Error(`${label} -> ${r.status} ${txt.slice(0, 300)}`);
    let j; try { j = txt ? JSON.parse(txt) : null; } catch { throw new Error(`${label} -> answer was not JSON`); }
    if (j && j.error) throw new Error(`${label} -> ${j.error.code || ''} ${String(j.error.message || '').slice(0, 300)}`.replace(/\s+/g, ' '));
    return j ? (j.data === undefined ? null : j.data) : null;
  }

  /* Same signature as the bridge's Supabase api(): returns rows (select / return=representation) or null. */
  async function api(path, { method = 'GET', body, prefer } = {}) {
    const label = `${method} ${String(path).split('?')[0]}`;
    const first = restToCompat(path, { method, body, prefer });
    // big array writes go in chunks of CHUNK rows (rows of the answer are put back together)
    if (Array.isArray(first.body.values) && first.body.values.length > CHUNK) {
      const all = first.body.values, out = [];
      for (let i = 0; i < all.length; i += CHUNK) {
        const part = await call(first.url, { ...first.body, values: all.slice(i, i + CHUNK) }, label);
        if (Array.isArray(part)) out.push(...part);
      }
      return first.body.returning ? out : null;
    }
    return call(first.url, first.body, label);
  }

  /* file -> R2 bucket gl-photos as gl/storage/<bucket>/<name>. "already exists" is fine (same file earlier). */
  async function upload(bucket, name, buf, mime, retry = true) {
    const r = await fetchFn(BASE + '/gl/api/storage/upload', {
      method: 'POST',
      headers: hdr({ Authorization: 'Bearer ' + token, 'Content-Type': mime, 'x-bucket': bucket, 'x-path': encodeURIComponent(name), 'x-upsert': 'false' }),
      body: buf
    });
    if (r.status === 401 && retry) { await login(); return upload(bucket, name, buf, mime, false); }
    const txt = await r.text();
    if (r.status === 409 || /already exists|Duplicate/i.test(txt)) return 'exists';
    if (!r.ok) throw new Error(`upload ${r.status} ${txt.slice(0, 160)}`);
    return 'stored';
  }

  async function miaCall(messages, retry = true) {
    const r = await fetchFn(BASE + '/gl/api/fn/mia', {
      method: 'POST', headers: hdr({ Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }),
      body: JSON.stringify({ mode: 'coach', messages, stage: 'auto' }), signal: AbortSignal.timeout(90000)
    });
    if (r.status === 401 && retry) { await login(); return miaCall(messages, false); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error((j.error && (j.error.message || j.error)) || ('MIA request failed (' + r.status + ')'));
    return j;
  }

  return { login, api, upload, miaCall, getToken: () => token };
}
