#!/usr/bin/env node
// Backfill pdf_page / context_pdf_page for existing ep_questions rows.
//
// Strategy (cheap + deterministic):
// 1. Parse `pg_{N}` out of the existing `image_path` Cloudinary URL.
// 2. Parse `pg_{N}` out of the existing `context_image_path` when present.
// 3. Set pdf_page_confidence='detected' wherever we successfully extracted.
//
// We don't backfill solution_pdf_page here — that info isn't in any existing
// URL. New uploads get it via detectSolutionPages; old exams will fall back
// to their exam pdf_page the first time the user clicks "תקן תשובה", and
// self-heal when the user saves.
//
// Usage:   node scripts/backfill-pdf-pages.mjs
// Env:     SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const sb = createClient(url, key, { auth: { persistSession: false } });

function parsePg(imgUrl) {
  if (typeof imgUrl !== 'string') return null;
  const m = imgUrl.match(/\/pg_(\d+)[,/]/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n >= 1 ? n : null;
}

async function main() {
  let from = 0;
  const batch = 500;
  let totalScanned = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;

  while (true) {
    const { data, error } = await sb.from('ep_questions')
      .select('id, image_path, context_image_path, pdf_page, context_pdf_page')
      .range(from, from + batch - 1)
      .order('id', { ascending: true });
    if (error) { console.error('fetch failed:', error.message); process.exit(1); }
    if (!data || data.length === 0) break;

    totalScanned += data.length;

    for (const row of data) {
      const update = {};
      if (row.pdf_page == null) {
        const pg = parsePg(row.image_path);
        if (pg) {
          update.pdf_page = pg;
          update.pdf_page_confidence = 'detected';
        }
      }
      if (row.context_pdf_page == null && row.context_image_path) {
        const cpg = parsePg(row.context_image_path);
        if (cpg) update.context_pdf_page = cpg;
      }
      if (!Object.keys(update).length) { totalSkipped++; continue; }
      const { error: uErr } = await sb.from('ep_questions').update(update).eq('id', row.id);
      if (uErr) { console.warn('update failed for', row.id, uErr.message); continue; }
      totalUpdated++;
    }

    console.log(`[backfill] scanned=${totalScanned} updated=${totalUpdated} skipped=${totalSkipped}`);
    if (data.length < batch) break;
    from += batch;
  }

  console.log(`\n[backfill] done: ${totalUpdated} updated / ${totalScanned} scanned`);
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
