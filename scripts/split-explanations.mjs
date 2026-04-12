// Split public/data/explanations.json into per-exam files so dashboard load
// doesn't block on a single 196KB blob. Idempotent — safe to re-run.
//
// Usage: node scripts/split-explanations.mjs
//
// Input  : public/data/explanations.json  (flat map: "<exam>__<num>" → obj)
// Output : public/data/explanations/<exam>.json  (flat map: "<num>" → obj)

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'public/data/explanations.json');
const OUT_DIR = path.join(ROOT, 'public/data/explanations');

const raw = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const byExam = {};
for (const [key, value] of Object.entries(raw)) {
  if (key === '_comment') continue;
  const idx = key.lastIndexOf('__');
  if (idx === -1) continue;
  const exam = key.slice(0, idx);
  const num = key.slice(idx + 2);
  (byExam[exam] = byExam[exam] || {})[num] = value;
}

fs.mkdirSync(OUT_DIR, { recursive: true });
let total = 0;
for (const [exam, map] of Object.entries(byExam)) {
  const out = path.join(OUT_DIR, `${exam}.json`);
  fs.writeFileSync(out, JSON.stringify(map));
  const bytes = fs.statSync(out).size;
  total += bytes;
  console.log(`  ${exam}: ${Object.keys(map).length} keys, ${(bytes / 1024).toFixed(1)}KB`);
}
console.log(`\nTotal: ${(total / 1024).toFixed(1)}KB across ${Object.keys(byExam).length} files`);
console.log(`Original: ${(fs.statSync(SRC).size / 1024).toFixed(1)}KB`);
