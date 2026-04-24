#!/usr/bin/env node
// One-time: apply lock_profile_rls.sql to production Supabase.
// Usage:
//   SUPABASE_ACCESS_TOKEN=<your-personal-token> node scripts/apply-profile-rls-migration.mjs
//
// Get your token from: https://supabase.com/dashboard/account/tokens

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));

const sbUrl = (process.env.SUPABASE_URL || '').trim();
const accessToken = (process.env.SUPABASE_ACCESS_TOKEN || '').trim();

if (!accessToken) {
  console.error('Set SUPABASE_ACCESS_TOKEN (from https://supabase.com/dashboard/account/tokens)');
  process.exit(1);
}

const projectRef = sbUrl
  ? new URL(sbUrl).hostname.split('.')[0]
  : 'lbkwykuzcffphvabmzex';

console.log('Project ref:', projectRef);

const sqlPath = join(__dir, '..', 'supabase', 'migrations', 'lock_profile_rls.sql');
const sql = readFileSync(sqlPath, 'utf8');

// The CREATE POLICY statement spans many lines; run the whole file as one query.
console.log('Applying lock_profile_rls.sql...');
const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
  },
  body: JSON.stringify({ query: sql }),
});
const body = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error('FAILED:', body?.message || res.status);
  process.exit(1);
}
console.log('OK — privilege-escalation vector closed.');
