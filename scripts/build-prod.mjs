// Build script:
//   1. Generate public/config.js from env vars (existing)
//   2. Minify public/app.js → public/app.min.js (esbuild)
//   3. Minify public/styles.css → public/styles.min.css (esbuild)
//   4. Rewrite public/index.html to reference the .min.* files in prod
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..');

// Try to load .env locally (optional - only needed for local dev)
// In production (Vercel), env vars are set via dashboard.
try {
  const envFile = path.join(APP_ROOT, '.env');
  if (fs.existsSync(envFile)) {
    const content = fs.readFileSync(envFile, 'utf8');
    for (const line of content.split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  }
} catch {}

const templatePath = path.join(APP_ROOT, 'public', 'config.js.template');
const outPath = path.join(APP_ROOT, 'public', 'config.js');

if (!fs.existsSync(templatePath)) {
  console.error('Missing template:', templatePath);
  process.exit(1);
}

const url = (process.env.SUPABASE_URL || '').trim();
const key = (process.env.SUPABASE_ANON_KEY || '').trim();
if (!url || !key) {
  console.warn('⚠️  WARNING: SUPABASE_URL or SUPABASE_ANON_KEY env vars are missing');
  console.warn('   The site will load but auth/data features will not work.');
}

let content = fs.readFileSync(templatePath, 'utf8');
content = content
  .replaceAll('__SUPABASE_URL__', url)
  .replaceAll('__SUPABASE_ANON_KEY__', key)
  .replaceAll('__APP_TITLE__', (process.env.APP_TITLE || 'ExamPrep').trim())
  .replaceAll('__APP_URL__', (process.env.APP_URL || 'https://examprep.vercel.app').trim());

fs.writeFileSync(outPath, content);
console.log('✓ Generated public/config.js');
console.log('  Supabase URL:', url || '(not set)');
console.log('  Has anon key:', !!key);

// ===== Minify JS + CSS with esbuild =====
// Strategy: overwrite public/app.js and public/styles.css IN PLACE with the
// minified output on the build host. The source files in git stay unminified
// for readability; the build step replaces them just before deploy so the CDN
// serves the minified bytes under the same URLs (no HTML rewrite needed).
//
// Local dev is protected in two ways:
//   1. This block is skipped entirely unless we're running in the Vercel build
//      env (VERCEL=1) or the user explicitly set MINIFY=1.
//   2. esbuild is a devDependency — `npm install --production` would skip it
//      and the dynamic import throws, which we log and continue past.
const shouldMinify = process.env.VERCEL === '1' || process.env.MINIFY === '1';
if (shouldMinify) {
  try {
    const esbuild = await import('esbuild');

    const jsSrc = path.join(APP_ROOT, 'public/app.js');
    if (fs.existsSync(jsSrc)) {
      const before = fs.statSync(jsSrc).size;
      const result = await esbuild.build({
        entryPoints: [jsSrc],
        write: false,
        bundle: false,
        minify: true,
        sourcemap: false,
        format: 'esm',
        target: ['es2020', 'safari14', 'chrome90', 'firefox90'],
        legalComments: 'none',
        logLevel: 'warning',
      });
      if (result.outputFiles?.[0]) {
        fs.writeFileSync(jsSrc, result.outputFiles[0].contents);
        const after = fs.statSync(jsSrc).size;
        console.log(`✓ Minified public/app.js: ${(before/1024).toFixed(1)}KB → ${(after/1024).toFixed(1)}KB (${Math.round((1 - after/before) * 100)}% smaller)`);
      }
    }

    const cssSrc = path.join(APP_ROOT, 'public/styles.css');
    if (fs.existsSync(cssSrc)) {
      const before = fs.statSync(cssSrc).size;
      const result = await esbuild.build({
        entryPoints: [cssSrc],
        write: false,
        minify: true,
        loader: { '.css': 'css' },
        logLevel: 'warning',
      });
      if (result.outputFiles?.[0]) {
        fs.writeFileSync(cssSrc, result.outputFiles[0].contents);
        const after = fs.statSync(cssSrc).size;
        console.log(`✓ Minified public/styles.css: ${(before/1024).toFixed(1)}KB → ${(after/1024).toFixed(1)}KB (${Math.round((1 - after/before) * 100)}% smaller)`);
      }
    }
  } catch (e) {
    console.warn('⚠️  esbuild minification skipped:', e.message);
    console.warn('    Site will serve unminified public/app.js + public/styles.css');
  }
} else {
  console.log('  (minification skipped — set VERCEL=1 or MINIFY=1 to enable)');
}
