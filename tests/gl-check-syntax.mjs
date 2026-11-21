// node tests/gl-check-syntax.mjs [file.html|file.js ...]
// node --check on every JS file given and on every inline classic <script> of every HTML file given.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
const files = process.argv.slice(2);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'glchk-'));
let bad = 0, n = 0;
function check(label, code) {
  const f = path.join(tmp, 's' + (n++) + '.js');
  fs.writeFileSync(f, code);
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
  catch (e) { bad++; console.log('FAIL ' + label + '\n' + String(e.stderr).split('\n').slice(0, 6).join('\n')); }
}
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  if (/\.m?js$/.test(file)) { check(file, src); continue; }
  const re = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi; let m, i = 0;
  while ((m = re.exec(src))) {
    const attrs = m[1] || '';
    if (/\bsrc\s*=/.test(attrs)) continue;
    if (/type\s*=\s*["']?(module|application\/(ld\+)?json|text\/template)/i.test(attrs)) continue;
    i++;
    check(file + ' inline#' + i + ' (line ' + src.slice(0, m.index).split('\n').length + ')', m[2]);
  }
}
console.log((bad ? 'FAILED ' : 'OK ') + (n - bad) + '/' + n + ' scripts parse');
process.exit(bad ? 1 : 0);
