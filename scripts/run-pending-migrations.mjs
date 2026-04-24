#!/usr/bin/env node
// Apply pending schema migrations to the production Supabase DB.
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... SUPABASE_ACCESS_TOKEN=... \
//   node scripts/run-pending-migrations.mjs
//
// SUPABASE_ACCESS_TOKEN: personal access token from https://supabase.com/dashboard/account/tokens

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));

const sbUrl = process.env.SUPABASE_URL?.trim();
const accessToken = process.env.SUPABASE_ACCESS_TOKEN?.trim();

if (!sbUrl || !accessToken) {
  console.error('Set SUPABASE_URL and SUPABASE_ACCESS_TOKEN');
  console.error('Get your access token from: https://supabase.com/dashboard/account/tokens');
  process.exit(1);
}

// Extract project ref from URL: https://{ref}.supabase.co
const projectRef = new URL(sbUrl).hostname.split('.')[0];
console.log('Project ref:', projectRef);

const MIGRATIONS_DIR = join(__dir, '..', 'supabase', 'migrations');

// Add new SQL files to this list when they need to be applied to the live DB.
// Idempotent (ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS) files are
// safe to re-apply, so no tracking table is needed.
const MIGRATIONS = [
  'ensure_exam_columns.sql',     // columns used by upload & context
  'question_pdf_pages.sql',      // pdf_page + confidence columns for the crop tool
];

for (const fname of MIGRATIONS) {
  console.log(`\n── ${fname} ──`);
  const sql = readFileSync(join(MIGRATIONS_DIR, fname), 'utf8');
  const statements = sql.split(/;\s*\n/).map(s => s.trim()).filter(Boolean);

  for (const stmt of statements) {
    if (stmt.startsWith('--') || !stmt) continue;
    const query = stmt + ';';
    console.log('Running:', query.split('\n')[0].slice(0, 80) + '...');
    const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
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
}

console.log('\nAll migrations applied. Upload should now work.');
