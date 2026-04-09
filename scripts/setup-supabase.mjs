// Run setup SQL via Supabase Management API
// Usage: SBP_TOKEN=sbp_xxx node scripts/setup-supabase.mjs
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = process.env.SBP_TOKEN || process.argv[2];
const PROJECT_REF = 'bhdkdttsxdrfpbheyouy';

if (!TOKEN) {
  console.error('Missing SBP_TOKEN env var or CLI arg');
  process.exit(1);
}

const sqlFile = path.join(__dirname, '..', 'supabase', 'setup-with-sample-data.sql');
const sql = fs.readFileSync(sqlFile, 'utf8');

console.log('Running setup SQL (' + sql.length + ' chars)...');

const r = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer ' + TOKEN,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ query: sql }),
});
const result = await r.json();
console.log('HTTP', r.status);
console.log('Result:', JSON.stringify(result, null, 2).substring(0, 1500));
