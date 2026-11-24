// Run: node --test tests/phone-core.test.mjs          (no packages needed)
// One phone format (+60...): gl-platescan.html saveProfile() and gl-staff-appointment-FINAL.html (walk-in dedupe) must
// find an existing customer whatever format the number was typed or stored in (60... / 0... / +60... / +0...), by the
// "core digits" rule of the Worker (phoneCore: digits only, one leading 60 or 0 dropped). The real page code is cut out of
// the page files and run against a fake supabase client; the code of origin/main (before the fix) is run the same way to
// show the old exact-digits compare misses. No network, FAKE numbers only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const gitMain = (f) => { try { return execFileSync('git', ['show', 'origin/main:' + f], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 }); } catch { return null; } };

/* text from `start` to the matching closing brace of the first "{" at/after it */
function braceBlock(src, start) {
  const i = src.indexOf(start); assert.ok(i >= 0, 'not found: ' + start);
  let d = 0, k = src.indexOf('{', i);
  for (let j = k; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) return src.slice(i, j + 1); }
  throw new Error('unbalanced: ' + start);
}

/* a fake supabase client over an in-memory gl_walkin: select/ilike/limit/maybeSingle, insert(.select), update(.eq) */
function fakeSb(rows, { insertError = null, onInsertError = null } = {}) {
  const log = [];
  const like = (pat, v) => { const re = new RegExp('^' + pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$', 'i'); return re.test(String(v ?? '')); };
  const from = (table) => {
    const q = { table, op: 'select', filters: [], lim: null, values: null, one: false, ret: false };
    const run = async () => {
      if (q.op === 'insert') { log.push(['insert', table, q.values]); if (insertError) { if (onInsertError) onInsertError(rows); return { data: null, error: insertError }; } rows.push({ id: 'n' + rows.length, ...q.values }); return { data: { id: 'n' + (rows.length - 1) }, error: null }; }
      if (q.op === 'update') { log.push(['update', table, q.values, q.filters]); const r = rows.find((x) => q.filters.every(([c, v]) => x[c] === v)); if (r) Object.assign(r, q.values); return { data: null, error: null }; }
      let out = rows.filter((x) => q.filters.every(([c, p]) => like(p, x[c])));
      if (q.lim) out = out.slice(0, q.lim);
      return { data: q.one ? (out[0] ?? null) : out, error: null };
    };
    const api = {
      select() { return api; }, ilike(c, p) { q.filters.push([c, p]); return api; }, eq(c, v) { q.filters.push([c, v]); return api; },
      limit(n) { q.lim = n; if (n === 1) { /* maybeSingle follows */ } return api; }, maybeSingle() { q.one = true; return run(); },
      insert(v) { q.op = 'insert'; q.values = v; return api; }, update(v) { q.op = 'update'; q.values = v; return api; },
      then(res, rej) { return run().then(res, rej); },
    };
    return api;
  };
  return { sb: { from }, log };
}

/* gl-platescan.html saveProfile(): run the page's own function with fake page elements */
async function saveProfileRun(html, { phone, plate, rows, insertError, onInsertError }) {
  const fn = braceBlock(html, 'async function saveProfile()');
  const core = html.match(/^const phoneCore=.*$/m);
  const els = { eName: { value: 'N' }, ePhone: { value: phone }, ePlate: { value: plate }, eModel: { value: '' }, eType: { value: '' }, ePkgName: { value: '', selectedOptions: [] },
    ePkgBal: { value: '' }, saveMsg: { textContent: '' } };
  const { sb, log } = fakeSb(rows, { insertError, onInsertError });
  const ctx = { $: (id) => els[id], sb, CUR: null, HIST_ROWS: [], closeEdit() {}, doSearch() {}, setTimeout() {}, parseInt, String, Math, console };
  vm.createContext(ctx);
  vm.runInContext((core ? core[0] : '') + '\n' + fn + '\n;globalThis.__f = saveProfile;', ctx);
  await ctx.__f();
  return { log, msg: els.saveMsg.textContent, rows };
}

const WALKIN = () => [{ id: 'w-1', name: 'Old', phone: '+60123456789', plate: 'AAA1' }];
const platescanNew = read('gl-platescan.html');
const platescanOld = gitMain('gl-platescan.html');

test('platescan: same customer typed 012-345 6789 with a NEW plate updates the +60 row, no duplicate', async () => {
  const r = await saveProfileRun(platescanNew, { phone: '012-345 6789', plate: 'BBB2', rows: WALKIN() });
  assert.deepEqual(r.log.map((x) => x[0]), ['update']);
  assert.equal(r.log[0][3][0][1], 'w-1');
  assert.equal(r.rows.length, 1);
});

for (const typed of ['0123456789', '60123456789', '+60 12-345 6789', '123456789', '+60123456789']) {
  test('platescan: typed ' + typed + ' finds the walk-in stored as +60123456789', async () => {
    const r = await saveProfileRun(platescanNew, { phone: typed, plate: 'CCC3', rows: WALKIN() });
    assert.deepEqual(r.log.map((x) => x[0]), ['update']);
  });
}
for (const stored of ['0123456789', '60123456789', '+0123456789']) {
  test('platescan: typed +60123456789 finds the walk-in stored as ' + stored, async () => {
    const r = await saveProfileRun(platescanNew, { phone: '+60123456789', plate: 'DDD4', rows: [{ id: 'w-2', name: 'x', phone: stored, plate: 'ZZZ9' }] });
    assert.deepEqual(r.log.map((x) => x[0]), ['update']);
    assert.equal(r.log[0][3][0][1], 'w-2');
  });
}
test('platescan: a different customer is still a new row', async () => {
  const r = await saveProfileRun(platescanNew, { phone: '0129999999', plate: 'EEE5', rows: WALKIN() });
  assert.deepEqual(r.log.map((x) => x[0]), ['insert']);
});
test('platescan: a number with no digits does not match anybody (was: matched any row without digits)', async () => {
  const r = await saveProfileRun(platescanNew, { phone: '---', plate: 'EEE6', rows: [{ id: 'w-3', phone: 'n/a', plate: 'Q1' }] });
  assert.deepEqual(r.log.map((x) => x[0]), ['insert']);
});
test('platescan: duplicate-key recovery finds the real row by plate + core phone, then updates it', async () => {
  // another device saved the same car a moment earlier (stored as 60...): our lookups missed, the insert hit UNIQUE, recovery compares core digits
  const rows = [];
  const r = await saveProfileRun(platescanNew, { phone: '0123456789', plate: 'ABC1', rows, insertError: { code: '23505', message: 'duplicate key value violates unique constraint' },
    onInsertError: (rs) => rs.push({ id: 'w-4', name: 'x', phone: '60123456789', plate: 'ABC1' }) });
  assert.deepEqual(r.log.map((x) => x[0]), ['insert', 'update']);
  assert.equal(r.log[1][3][0][1], 'w-4');
  assert.equal(r.msg.startsWith('Save failed'), false);
});
test('platescan: other errors are still shown, not swallowed', async () => {
  const r = await saveProfileRun(platescanNew, { phone: '0129999999', plate: 'FFF6', rows: [], insertError: { code: 'XX000', message: 'boom' } });
  assert.equal(r.msg, 'Save failed: boom');
});
test('platescan BEFORE the fix (origin/main) missed typed 012... against +60..., and made a duplicate', { skip: !platescanOld }, async () => {
  const r = await saveProfileRun(platescanOld, { phone: '012-345 6789', plate: 'BBB2', rows: WALKIN() });
  assert.deepEqual(r.log.map((x) => x[0]), ['insert']);
});

/* gl-staff-appointment-FINAL.html: the walk-in dedupe part of the booking save */
async function apptDedupe(html, { phoneDigits, plate, rows }) {
  const a = html.indexOf('let ex2=null;'), b = html.indexOf('const wkBody=', a);
  assert.ok(a > 0 && b > a, 'dedupe block not found');
  const core = html.match(/^const phoneCore=.*$/m);
  const { sb, log } = fakeSb(rows);
  const ctx = { sb, phone: phoneDigits, plate, String };
  vm.createContext(ctx);
  vm.runInContext((core ? core[0] : '') + '\n;globalThis.__f = async function(){\n' + html.slice(a, b) + '\nreturn ex2; };', ctx);
  return { ex2: await ctx.__f(), log };
}
const apptNew = read('gl-staff-appointment-FINAL.html');
const apptOld = gitMain('gl-staff-appointment-FINAL.html');
for (const typed of ['0123456789', '60123456789', '123456789']) {
  test('appointment: typed ' + typed + ' (digits) finds the walk-in stored as +60123456789', async () => {
    assert.equal(JSON.stringify((await apptDedupe(apptNew, { phoneDigits: typed, plate: 'NEW1', rows: WALKIN() })).ex2), '{"id":"w-1"}');
  });
}
for (const stored of ['0123456789', '60123456789', '+0123456789']) {
  test('appointment: typed 60123456789 finds the walk-in stored as ' + stored, async () => {
    assert.equal(JSON.stringify((await apptDedupe(apptNew, { phoneDigits: '60123456789', plate: 'NEW1', rows: [{ id: 'w-5', phone: stored, plate: 'ZZ1' }] })).ex2), '{"id":"w-5"}');
  });
}
test('appointment: plate match still comes first; a different phone finds nothing', async () => {
  assert.equal((await apptDedupe(apptNew, { phoneDigits: '0129999999', plate: 'AAA1', rows: WALKIN() })).ex2.id, 'w-1');
  assert.equal((await apptDedupe(apptNew, { phoneDigits: '0129999999', plate: 'NEW1', rows: WALKIN() })).ex2, null);
});
test('appointment BEFORE the fix (origin/main): typed 0123456789 vs +60123456789 found nothing', { skip: !apptOld }, async () => {
  assert.equal((await apptDedupe(apptOld, { phoneDigits: '0123456789', plate: 'NEW1', rows: WALKIN() })).ex2, null);
});
test('appointment still writes the number as before (the Worker makes it +60...): wkBody unchanged', () => {
  assert.ok(apptNew.includes("const wkBody={ name:nm||null, phone:'+'+phone, plate:plate||null, model:carModel||null };"));
});

/* the helper is the same rule as the Worker's phoneCore */
test('phoneCore in both pages = Worker phoneCore on every format', () => {
  for (const f of [platescanNew, apptNew]) {
    const m = f.match(/^const phoneCore=.*$/m); assert.ok(m);
    const ctx = vm.createContext({}); const pc = vm.runInContext(m[0] + ';phoneCore', ctx);
    for (const [i, o] of [['+60123456789', '123456789'], ['60123456789', '123456789'], ['0123456789', '123456789'], ['+0123456789', '123456789'], ['012-345 6789', '123456789'],
      ['+60 12-345 6789', '123456789'], ['123456789', '123456789'], ['+600123456789', '0123456789'], ['', ''], [null, ''], [undefined, '']]) assert.equal(pc(i), o, String(i));
  }
});
