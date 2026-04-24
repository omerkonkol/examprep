#!/usr/bin/env node
// =====================================================
// One-time migration: move question image_paths from Supabase Storage → Cloudinary
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//   CLOUDINARY_CLOUD_NAME=... CLOUDINARY_API_KEY=... CLOUDINARY_API_SECRET=... \
//   node scripts/migrate-images-to-cloudinary.mjs [--dry-run]
// =====================================================

import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';

const DRY_RUN = process.argv.includes('--dry-run');
const BATCH = 20;

// ---- Config ----
const sbUrl   = process.env.SUPABASE_URL?.trim();
const sbKey   = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const clName  = (process.env.CLOUDINARY_CLOUD_NAME || '').replace(/\s+/g,'').trim();
const clKey   = (process.env.CLOUDINARY_API_KEY   || '').replace(/\s+/g,'').trim();
const clSec   = (process.env.CLOUDINARY_API_SECRET|| '').replace(/\s+/g,'').trim();

if (!sbUrl || !sbKey) { console.error('❌  Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
if (!clName || !clKey || !clSec) { console.error('❌  Missing CLOUDINARY_CLOUD_NAME / API_KEY / API_SECRET'); process.exit(1); }

const sb = createClient(sbUrl, sbKey, { auth: { persistSession: false } });

// ---- Helpers ----
function cloudinaryFetchUrl(supabaseUrl) {
  // Cloudinary "fetch" mode: caches any public URL on first access, serves from CDN after.
  return `https://res.cloudinary.com/${clName}/image/fetch/q_auto,f_auto/${encodeURIComponent(supabaseUrl)}`;
}

async function uploadToCloudinary(imageBuffer, publicId) {
  const base64 = imageBuffer.toString('base64');
  const mimeType = 'image/webp'; // most stored images are webp
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHash('sha1')
    .update(`public_id=${publicId}&timestamp=${timestamp}${clSec}`)
    .digest('hex');

  const r = await fetch(`https://api.cloudinary.com/v1_1/${clName}/image/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      file: `data:${mimeType};base64,${base64}`,
      public_id: publicId,
      api_key: clKey,
      timestamp,
      signature,
    }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`Cloudinary ${r.status}: ${t.slice(0, 200)}`);
  }
  const d = await r.json();
  return d.secure_url;
}

async function downloadFromSupabase(path) {
  // path is relative like "userId/examId/q-01.webp"
  const { data, error } = await sb.storage.from('exam-pages').download(`exams/${path}`);
  if (error) throw new Error(`Storage download: ${error.message}`);
  const buf = Buffer.from(await data.arrayBuffer());
  return buf;
}

// ---- Main ----
async function main() {
  console.log(`\n📦  Cloudinary Image Migration${DRY_RUN ? ' [DRY RUN]' : ''}`);
  console.log(`    Cloud: ${clName}`);
  console.log(`    Supabase: ${sbUrl}\n`);

  // Fetch all questions where image_path is NOT already a Cloudinary URL
  let offset = 0;
  let totalMigrated = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  while (true) {
    const { data: rows, error } = await sb
      .from('ep_questions')
      .select('id, user_id, exam_id, image_path')
      .not('image_path', 'ilike', 'https://res.cloudinary.com%')
      .not('image_path', 'eq', 'text-only')
      .range(offset, offset + BATCH - 1)
      .order('id');

    if (error) { console.error('❌  DB fetch error:', error.message); break; }
    if (!rows || rows.length === 0) break;

    console.log(`Processing batch at offset ${offset} (${rows.length} rows)...`);

    for (const row of rows) {
      const { id, user_id, exam_id, image_path } = row;

      try {
        let newUrl;

        if (image_path.startsWith('http')) {
          // Full URL (probably Supabase Storage public URL) → use Cloudinary fetch mode
          newUrl = cloudinaryFetchUrl(image_path);
          console.log(`  [fetch] q${id}: ${image_path.slice(0, 60)}...`);
        } else {
          // Relative path → download from Storage → upload to Cloudinary
          const publicId = `examprep/questions/${user_id}/${exam_id}/${id}`;
          console.log(`  [upload] q${id}: ${image_path}`);
          if (!DRY_RUN) {
            const buf = await downloadFromSupabase(image_path);
            newUrl = await uploadToCloudinary(buf, publicId);
          } else {
            newUrl = `https://res.cloudinary.com/${clName}/image/upload/${publicId}.webp`;
          }
        }

        if (!DRY_RUN) {
          const { error: updErr } = await sb
            .from('ep_questions')
            .update({ image_path: newUrl })
            .eq('id', id);
          if (updErr) throw new Error(`DB update: ${updErr.message}`);
        }

        console.log(`  ✓ q${id} → ${newUrl.slice(0, 70)}...`);
        totalMigrated++;
      } catch (e) {
        console.error(`  ✗ q${id}: ${e.message}`);
        totalErrors++;
      }
    }

    offset += BATCH;
    if (rows.length < BATCH) break; // last batch
  }

  // Also: backfill any auth.users without a profiles row
  console.log('\n🔍  Checking for users missing profiles...');
  let orphans = null;
  try { ({ data: orphans } = await sb.rpc('find_users_without_profiles')); } catch {}
  if (orphans === null) {
    console.log('   (Skipped — run the backfill SQL manually if needed)');
  }

  console.log(`\n✅  Done.`);
  console.log(`   Migrated: ${totalMigrated}`);
  console.log(`   Skipped:  ${totalSkipped}`);
  console.log(`   Errors:   ${totalErrors}`);
  if (DRY_RUN) console.log('\n   ⚠️  DRY RUN — no changes were made.');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
