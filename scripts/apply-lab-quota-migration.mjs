#!/usr/bin/env node
// One-time: apply lab_quota.sql to production Supabase.
// Usage:
//   SUPABASE_ACCESS_TOKEN=<your-personal-token> node scripts/apply-lab-quota-migration.mjs
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

const sql = readFileSync(join(__dir, '..', 'supabase', 'migrations', 'lab_quota.sql'), 'utf8');

// Split on semicolons that end actual statements (skip comment-only lines)
const statements = sql
  .split(/;\s*\n/)
  .map(s => s.trim())
  .filter(s => s && !s.startsWith('--'));

for (const stmt of statements) {
  const query = stmt + ';';
  const preview = query.split('\n')[0].slice(0, 80);
  console.log('Running:', preview + (query.length > 80 ? '...' : ''));
  const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ query }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('  FAILED:', body?.message || res.status);
  } else {
    console.log('  OK');
  }
}

console.log('\nMigration complete.');
