// Takes TikTok-ready screenshots of ExamPrep using the local dev server.
// No Supabase / internet needed — injects user state directly into localStorage.
//
// Requires local server on port 3000:  node scripts/serve-local.mjs
// Run:  node scripts/screenshot-only.mjs
import { chromium } from 'playwright';
import { writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve } from 'path';

const OUT_DIR  = resolve('tiktok-assets');
const BASE_URL = process.env.EP_LOCAL_URL || 'http://localhost:4000';
const COURSE   = 'tohna1';

// User object injected into localStorage to bypass Supabase login.
// Must have isAdmin:true so the app exposes the tohna1 builtin course.
const FAKE_USER = JSON.stringify({
  id: 'demo-screenshot-user',
  email: 'demo@examprep.co',
  name: 'Demo',
  plan: 'pro',
  planExpiry: null,
  isAdmin: true,
});

// Inject user + seed study history BEFORE the page script reads localStorage.
const INIT_SCRIPT = `
  localStorage.setItem('ep_user', ${JSON.stringify(FAKE_USER)});
  // Dismiss cookie banner so it never blocks clicks
  localStorage.setItem('cookie-consent', '1');
  // Inject realistic demo progress so insights/progress pages look rich
  const uid = 'demo@examprep.co';
  const cid = 'tohna1';
  const progressKey = 'ep_progress_' + uid + '_' + cid;
  if (!localStorage.getItem(progressKey)) {
    const now = Date.now();
    const day = 86400000;
    // Build fake attempts — mix of correct/wrong across multiple sessions
    const attempts = [];
    const topics = ['מחסניות ותורים','רקורסיה','עצי חיפוש','גרפים','מיון','עצי ביטוי','תכנות דינמי','אלגוריתמי גרף','מבנה נתונים','חסימות'];
    for (let i = 0; i < 60; i++) {
      attempts.push({
        questionId: 'q' + (i + 1),
        isCorrect: Math.random() > 0.3,
        revealed: false,
        timestamp: now - (i * day / 8),
        topic: topics[i % topics.length],
        examId: 'exam' + (Math.floor(i / 10) + 1),
        timeUsed: Math.floor(Math.random() * 90) + 15,
      });
    }
    // Build fake batches
    const batches = [];
    for (let b = 0; b < 8; b++) {
      const size = 10;
      const correct = Math.floor(Math.random() * 4) + 6;
      batches.push({
        id: 'batch' + b,
        timestamp: now - (b * day * 1.5),
        size,
        correct,
        wrong: size - correct,
        skipped: 0,
        score: Math.round((correct / size) * 100),
        examMode: b % 3 === 0,
      });
    }
    const streakStart = now - 12 * day;
    localStorage.setItem(progressKey, JSON.stringify({
      attempts,
      batches,
      streakStart,
      streakLast: now - day,
    }));
  }
`;

const SLIDES = [
  {
    id: 2,
    name: 'course-dashboard',
    viewport: { width: 1280, height: 900 },
    flow: async (page) => {
      // Hash-based SPA: navigate to base URL first, then set hash
      await page.goto(`${BASE_URL}/`, { waitUntil: 'load' });
      await page.evaluate(course => { location.hash = `#/course/${course}`; }, COURSE);
      await page.waitForSelector('#cd-actions', { timeout: 20000 });
      await page.waitForTimeout(1500);
    },
  },
  {
    id: 3,
    name: 'quiz-question',
    viewport: { width: 430, height: 932 },
    flow: async (page) => {
      await page.goto(`${BASE_URL}/`, { waitUntil: 'load' });
      await page.evaluate(course => { location.hash = `#/course/${course}`; }, COURSE);
      await page.waitForSelector('[data-action="practice"]', { timeout: 20000 });
      await page.waitForTimeout(500);
      await page.click('[data-action="practice"]');
      await page.waitForSelector('#batch-start', { timeout: 10000 });
      await page.waitForTimeout(400);
      await page.click('#batch-start');
      await page.waitForSelector('#quiz-progress-label', { timeout: 15000 });
      await page.waitForTimeout(1200);
      const reveal = page.locator('#btn-reveal');
      if (await reveal.isVisible().catch(() => false)) {
        await reveal.click();
        await page.waitForTimeout(1200);
      }
    },
  },
  {
    id: 4,
    name: 'progress',
    viewport: { width: 430, height: 932 },
    flow: async (page) => {
      await page.goto(`${BASE_URL}/`, { waitUntil: 'load' });
      await page.evaluate(course => { location.hash = `#/course/${course}/progress`; }, COURSE);
      await page.waitForSelector('.progress-hero-main', { timeout: 20000 });
      await page.waitForTimeout(2000);
    },
  },
  {
    id: 5,
    name: 'insights',
    viewport: { width: 430, height: 932 },
    flow: async (page) => {
      await page.goto(`${BASE_URL}/`, { waitUntil: 'load' });
      await page.evaluate(course => { location.hash = `#/course/${course}/insights`; }, COURSE);
      await page.waitForSelector('#insights-banner', { timeout: 20000 });
      await page.waitForTimeout(2000);
    },
  },
  {
    id: 6,
    name: 'lab-mock-exam',
    viewport: { width: 430, height: 932 },
    flow: async (page) => {
      await page.goto(`${BASE_URL}/`, { waitUntil: 'load' });
      await page.evaluate(course => { location.hash = `#/course/${course}/lab`; }, COURSE);
      await page.waitForSelector('#btn-mock-start, #btn-ai-generate, .lab-preview-title', { timeout: 20000 });
      await page.waitForTimeout(1800);
    },
  },
];

async function main() {
  if (!existsSync(OUT_DIR)) await mkdir(OUT_DIR, { recursive: true });

  console.log('📸 ExamPrep Screenshot Tool (localhost mode)');
  console.log(`   Server: ${BASE_URL}`);
  console.log(`   Output: ${OUT_DIR}\n`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: 'he-IL' });

  // Dismiss quit-quiz confirm dialogs automatically
  context.on('dialog', d => d.dismiss().catch(() => {}));

  // Inject user + demo data before ANY page script runs
  await context.addInitScript(INIT_SCRIPT);

  const page = await context.newPage();

  try {
    for (const slide of SLIDES) {
      console.log(`── Slide ${slide.id}: ${slide.name}`);
      await page.setViewportSize(slide.viewport);

      try {
        await slide.flow(page);
        const buf = await page.screenshot({ fullPage: false });
        const outPath = resolve(OUT_DIR, `raw-slide-${slide.id}-${slide.name}.png`);
        await writeFile(outPath, buf);
        console.log(`   ✅ Saved: raw-slide-${slide.id}-${slide.name}.png\n`);
      } catch (err) {
        // Save a debug screenshot even on failure
        try {
          const dbg = await page.screenshot({ fullPage: false });
          await writeFile(resolve(OUT_DIR, `debug-slide-${slide.id}-fail.png`), dbg);
        } catch {}
        console.error(`   ❌ Failed: ${err.message}\n`);
      }
    }
  } finally {
    await browser.close();
  }

  console.log('🎉 Done! Open tiktok-assets/ to review screenshots.');
  console.log('   Next: Upload each raw-slide-N-*.png to Google AI Studio with the');
  console.log('   matching Nano Banana prompt from the marketing plan.');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
