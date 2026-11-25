// Run: node --test tests/platescan-dup-save.test.mjs      (no packages needed)
// gl-platescan.html saveProfile(): the Worker writes phones as +60... and gl_walkin is UNIQUE(phone, plate). When the
// phone+plate being saved is already held by ANOTHER row of the same car (shop data has duplicate rows per plate), the old
// page showed "Save failed: UNIQUE constraint failed: gl_walkin.phone, gl_walkin.plate". The page must save onto the row that
// already holds it instead. The real page function is cut out of the file and run against a fake client that ENFORCES the
// unique rule the way D1 does. FAKE numbers only, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
function braceBlock(src, start) {
  const i = src.indexOf(start); assert.ok(i >= 0, 'not found: ' + start);
  let d = 0, k = src.indexOf('{', i);
  for (let j = k; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) return src.slice(i, j + 1); }
  throw new Error('unbalanced: ' + start);
}
const UNIQUE_MSG = 'UNIQUE constraint failed: gl_walkin.phone, gl_walkin.plate (extended: SQLITE_CONSTRAINT_UNIQUE)';
// the Worker's canonPhone for the cases used here: any 0.. / 60.. / +60.. Malaysian mobile -> +60<number>
const canon = (p) => { const d = String(p ?? '').replace(/\D/g, ''); if (!d) return String(p ?? ''); const n = d.replace(/^(60|0)/, ''); return /^1\d{8,9}$/.test(n) ? '+60' + n : String(p); };

function fakeSb(rows, { forceUpdateError = false } = {}) {
  const log = [];
  const like = (pat, v) => new RegExp('^' + pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$', 'i').test(String(v ?? ''));
  const from = (table) => {
    const q = { op: 'select', filters: [], lim: null, values: null, one: false };
    const run = async () => {
      if (q.op === 'insert') {
        const v = { ...q.values, phone: canon(q.values.phone) }; log.push(['insert', v]);
        if (rows.some((x) => x.phone === v.phone && x.plate === v.plate)) return { data: null, error: { message: UNIQUE_MSG } };
        rows.push({ id: 'n' + rows.length, ...v }); return { data: { id: 'n' + (rows.length - 1) }, error: null };
      }
      if (q.op === 'update') {
        const v = { ...q.values }; if ('phone' in v) v.phone = canon(v.phone);
        const r = rows.find((x) => q.filters.every(([c, p, k]) => (k === 'eq' ? x[c] === p : like(p, x[c]))));
        log.push(['update', r && r.id, v]);
        if (forceUpdateError) return { data: null, error: { message: UNIQUE_MSG } };
        if (!r) return { data: null, error: null };
        const next = { ...r, ...v };
        if (rows.some((x) => x !== r && x.phone === next.phone && x.plate === next.plate)) return { data: null, error: { message: UNIQUE_MSG } };
        Object.assign(r, v); return { data: null, error: null };
      }
      let out = rows.filter((x) => q.filters.every(([c, p, k]) => (k === 'eq' ? x[c] === p : like(p, x[c]))));
      if (q.lim) out = out.slice(0, q.lim);
      return { data: q.one ? (out[0] ?? null) : out, error: null };
    };
    const api = {
      select() { return api; }, ilike(c, p) { q.filters.push([c, p, 'ilike']); return api; }, eq(c, v) { q.filters.push([c, v, 'eq']); return api; },
      limit(n) { q.lim = n; return api; }, maybeSingle() { q.one = true; return run(); },
      insert(v) { q.op = 'insert'; q.values = v; return api; }, update(v) { q.op = 'update'; q.values = v; return api; },
      then(res, rej) { return run().then(res, rej); },
    };
    return api;
  };
  return { sb: { from }, log };
}

async function save(html, { phone, plate, rows, cur, forceUpdateError }) {
  const fn = braceBlock(html, 'async function saveProfile()');
  const core = html.match(/^const phoneCore=.*$/m);
  const els = { eName: { value: 'Ali' }, ePhone: { value: phone }, ePlate: { value: plate }, eModel: { value: 'Myvi' }, eType: { value: '' },
    ePkgName: { value: '', selectedOptions: [] }, ePkgBal: { value: '' }, saveMsg: { textContent: '' } };
  const { sb, log } = fakeSb(rows, { forceUpdateError });
  const ctx = { $: (id) => els[id], sb, CUR: cur ?? null, HIST_ROWS: [], closeEdit() {}, doSearch() {}, setTimeout() {}, parseInt, String, Math, console };
  vm.createContext(ctx);
  vm.runInContext((core ? core[0] : '') + '\n' + fn + '\n;globalThis.__f = saveProfile;', ctx);
  await ctx.__f();
  return { log, msg: els.saveMsg.textContent, rows, cur: ctx.CUR };
}
const page = read('gl-platescan.html');
const cur = (id) => ({ src: 'walkin', walkinId: id, name: '', phone: '', plate: 'ABC123', model: '', car_type: '', pkg_name: '', pkg_total: 0, pkg_used: 0 });

// the car has two rows: A (no phone) was opened by the scan, B already holds phone+plate. Staff type the phone on A.
const TWO_ROWS = () => [{ id: 'A', name: '', phone: '', plate: 'ABC123' }, { id: 'B', name: 'Ali', phone: '+60123456789', plate: 'ABC123' }];

test('opened row has no phone, phone+plate already on another row: saves onto that row, no error', async () => {
  const r = await save(page, { phone: '012-345 6789', plate: 'ABC123', rows: TWO_ROWS(), cur: cur('A') });
  assert.equal(r.msg.startsWith('Save failed'), false, r.msg);
  assert.equal(r.rows.length, 2, 'no row added or removed');
  assert.equal(r.rows.find((x) => x.id === 'B').model, 'Myvi', 'details landed on the row that holds phone+plate');
  assert.equal(r.rows.find((x) => x.id === 'A').phone, '', 'the other row is left exactly as it was');
  assert.equal(r.cur.walkinId, 'B');
});
test('plate stored with spaces on the opened row, clean plate on the other row', async () => {
  const rows = [{ id: 'A', name: 'x', phone: '+60123456789', plate: 'ABC 123' }, { id: 'B', name: 'Ali', phone: '+60123456789', plate: 'ABC123' }];
  const r = await save(page, { phone: '+60123456789', plate: 'ABC 123', rows, cur: cur('A') });
  assert.equal(r.msg.startsWith('Save failed'), false, r.msg);
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows.find((x) => x.id === 'B').model, 'Myvi');
});
test('no conflict: plain update of the opened row is unchanged', async () => {
  const rows = [{ id: 'A', name: 'x', phone: '+60123456789', plate: 'ABC123' }];
  const r = await save(page, { phone: '0123456789', plate: 'ABC123', rows, cur: cur('A') });
  assert.deepEqual(r.log.map((x) => x[0]), ['update']);
  assert.equal(r.cur.walkinId, 'A');
});
test('no row opened (new scan): insert still works and a clash is recovered, not shown', async () => {
  const r = await save(page, { phone: '0129999999', plate: 'XYZ9', rows: TWO_ROWS(), cur: null });
  assert.deepEqual(r.log.map((x) => x[0]), ['insert']);
  const r2 = await save(page, { phone: '012-345 6789', plate: 'ABC123', rows: TWO_ROWS(), cur: null });
  assert.equal(r2.msg.startsWith('Save failed'), false, r2.msg);
  assert.equal(r2.rows.length, 2);
});
test('a unique error with no other row to blame is still shown, not hidden', async () => {
  const rows = [{ id: 'A', name: '', phone: '', plate: 'ABC123' }];
  const r = await save(page, { phone: '012-345 6789', plate: 'ABC123', rows, cur: cur('A'), forceUpdateError: true });
  assert.ok(r.msg.startsWith('Save failed: UNIQUE constraint failed'), r.msg);
});
