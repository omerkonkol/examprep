#!/usr/bin/env node
// Usage:
//   GEMINI_API_KEY="..." EP_EMAIL="..." EP_PASSWORD="..." node scripts/generate-tiktok-carousel.mjs
//
// Optional overrides:
//   EP_COURSE=tohna1   EP_URL=https://try.examprep.com   GEMINI_IMAGE_MODEL=gemini-2.0-flash-exp-image-generation

import { chromium } from 'playwright';
import { writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve } from 'path';

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const EP_EMAIL   = process.env.EP_EMAIL;
const EP_PASS    = process.env.EP_PASSWORD;
const COURSE_ID  = process.env.EP_COURSE || 'tohna1';
const BASE_URL   = (process.env.EP_URL || 'https://try.examprep.com').replace(/\/$/, '');
const OUT_DIR    = resolve('tiktok-assets');
const MODEL      = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.0-flash-exp-image-generation';

if (!GEMINI_KEY) throw new Error('Missing GEMINI_API_KEY env var');
if (!EP_EMAIL)   throw new Error('Missing EP_EMAIL env var');
if (!EP_PASS)    throw new Error('Missing EP_PASSWORD env var');

// ---------------------------------------------------------------------------
// Slide definitions
// ---------------------------------------------------------------------------
const SLIDES = [
  {
    id: 1,
    name: 'hook-desk',
    screenshotFlow: null, // text-to-image only
    prompt: `Cinematic moody photograph of a student's desk at 2am during exam season.
Single warm yellow desk lamp illuminates an open notebook, half-drunk coffee mug,
highlighter pens scattered, laptop slightly open with soft blue screen glow.
Window in background shows blurred city lights (bokeh). Slight top-down angle,
shallow depth of field. Aesthetic: cozy authentic "study with me" TikTok vibe.
Soft film grain, warm-cool color contrast. 9:16 vertical 1080x1920, no text, no logos,
no people visible. Upper 20% of frame is calm dark gradient sky — leave space for
Hebrew text overlay.`,
  },
  {
    id: 2,
    name: 'course-dashboard',
    viewport: { width: 1280, height: 900 },
    screenshotFlow: async (page) => {
      await page.goto(`${BASE_URL}/course/${COURSE_ID}`);
      await page.waitForSelector('#cd-actions', { timeout: 15000 });
      await page.waitForTimeout(1800);
    },
    prompt: `This is a screenshot of ExamPrep's course dashboard showing 6 study mode tiles:
practice, smart lab, insights, progress, study-from-summary, and exam bank.
Transform into a stunning 9:16 TikTok marketing visual (1080x1920).
Render the UI as if displayed on a floating MacBook Pro, slightly tilted 6°, centered.
Background: soft blue gradient (#eff6ff to #f0f9ff, 135°) with gentle light bokeh circles.
Add subtle blue glow halo behind laptop (#3b82f6, 40% opacity, 90px blur).
Keep all UI tiles and text exactly readable. Leave top 280px and bottom 380px empty.
No added text or logos. Output 1080x1920 PNG.`,
  },
  {
    id: 3,
    name: 'quiz-answer',
    viewport: { width: 430, height: 932 },
    screenshotFlow: async (page) => {
      // Should already be on course dashboard after slide 2 reset
      await page.goto(`${BASE_URL}/course/${COURSE_ID}`);
      await page.waitForSelector('[data-action="practice"]', { timeout: 12000 });
      await page.waitForTimeout(500);
      await page.click('[data-action="practice"]');
      await page.waitForSelector('#batch-start', { timeout: 10000 });
      await page.waitForTimeout(400);
      await page.click('#batch-start');
      await page.waitForSelector('#quiz-progress-label', { timeout: 15000 });
      await page.waitForTimeout(800);
      // Try to reveal the answer
      const revealBtn = page.locator('#btn-reveal');
      const isVisible = await revealBtn.isVisible().catch(() => false);
      if (isVisible) {
        await revealBtn.click();
        await page.waitForTimeout(1200);
      }
    },
    prompt: `This is a mobile screenshot of ExamPrep's quiz view, showing a multiple-choice
question with potentially a correct answer highlighted in green and explanation panel.
Transform into a premium 9:16 TikTok marketing visual (1080x1920).
Render as a floating iPhone 15 Pro frame, tilted 8° left.
Background: deep dark blue-to-black gradient (#0a0a1a to #001030) with tiny glowing particles.
Add bright green glow emanating from the answer area. Keep all UI content exactly as-is.
Leave top 280px and bottom 380px empty. No added text. Output 1080x1920 PNG.`,
  },
  {
    id: 4,
    name: 'progress',
    viewport: { width: 430, height: 932 },
    screenshotFlow: async (page) => {
      await page.goto(`${BASE_URL}/course/${COURSE_ID}/progress`);
      await page.waitForSelector('.progress-hero-main', { timeout: 15000 });
      await page.waitForTimeout(1800);
    },
    prompt: `This is a mobile screenshot of ExamPrep's student progress dashboard showing
accuracy trends, study streak counter, and topic mastery bars.
Transform into a premium 9:16 TikTok marketing visual (1080x1920).
Render as a floating iPhone 15 Pro frame, tilted 5°.
Background: very dark navy (#0a0f1e) with subtle grid lines and soft blue center radial glow.
Make chart lines and progress bars pop with increased vibrancy and soft glow.
Keep all UI data intact and readable. Leave top 300px and bottom 400px empty.
No added text. Output 1080x1920 PNG.`,
  },
  {
    id: 5,
    name: 'insights-heatmap',
    viewport: { width: 430, height: 932 },
    screenshotFlow: async (page) => {
      await page.goto(`${BASE_URL}/course/${COURSE_ID}/insights`);
      await page.waitForSelector('#insights-banner', { timeout: 15000 });
      await page.waitForTimeout(2200);
    },
    prompt: `This is a mobile screenshot of ExamPrep's topic insights page showing
topic mastery levels and AI analysis recommendations.
Transform into a bold urgent 9:16 TikTok marketing visual (1080x1920).
Render as a floating iPhone 15 Pro frame, tilted 12°.
Background: deep dark warm gradient (#1a0000 to #2d0000) with soft red vignette.
Make any red or weak topic elements glow intensely with danger feel.
Green/mastered elements shine bright with satisfaction glow.
Leave 300px top, 400px bottom empty. No text changes. Output 1080x1920 PNG.`,
  },
  {
    id: 6,
    name: 'mock-exam-lab',
    viewport: { width: 430, height: 932 },
    screenshotFlow: async (page) => {
      await page.goto(`${BASE_URL}/course/${COURSE_ID}/lab`);
      // Wait for either the mock start button or AI generate button
      await page.waitForSelector('#btn-mock-start, #btn-start-ai-mock, #btn-ai-generate', { timeout: 15000 });
      await page.waitForTimeout(1800);
    },
    prompt: `This is a mobile screenshot of ExamPrep's smart lab showing mock exam setup
with exam type options or AI question generator.
Transform into a DRAMATIC 9:16 TikTok marketing visual (1080x1920) — this is the CTA slide.
Render as a floating iPhone 15 Pro frame, slight tilt 5°.
Background: dark deep blue-black (#050d1a) with a large glowing blue pulse/ripple circle behind phone.
Make any timer, exam option buttons or AI elements glow bright white-blue (urgency feel).
Add a solid deep blue gradient band (#1d4ed8) filling the bottom 450px of the 1920px canvas.
Keep all app UI intact. Leave top 250px empty. Output 1080x1920 PNG.`,
  },
];

// ---------------------------------------------------------------------------
// Gemini image generation
// ---------------------------------------------------------------------------
async function callNanoBanana(prompt, screenshotBase64 = null) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_KEY}`;

  const parts = [{ text: prompt }];
  if (screenshotBase64) {
    parts.push({ inlineData: { mimeType: 'image/png', data: screenshotBase64 } });
  }

  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!r.ok) {
    const text = await r.text().catch(() => r.statusText);
    throw new Error(`Gemini ${r.status}: ${text.slice(0, 300)}`);
  }

  const j = await r.json();
  const imagePart = j.candidates?.[0]?.content?.parts?.find(
    p => p.inlineData?.mimeType?.startsWith('image/')
  );
  if (!imagePart) {
    const summary = j.candidates?.[0]?.content?.parts?.map(p => Object.keys(p)[0]).join(', ');
    throw new Error(`No image returned. Parts: ${summary ?? 'none'}. Finish: ${j.candidates?.[0]?.finishReason}`);
  }

  return Buffer.from(imagePart.inlineData.data, 'base64');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  if (!existsSync(OUT_DIR)) await mkdir(OUT_DIR, { recursive: true });

  console.log('🚀 ExamPrep TikTok Carousel Generator');
  console.log(`   Model : ${MODEL}`);
  console.log(`   Site  : ${BASE_URL}`);
  console.log(`   Course: ${COURSE_ID}`);
  console.log(`   Output: ${OUT_DIR}\n`);

  // Chromium resolves DNS differently from Node — override known hosts so
// the browser can reach the live site even when system DNS is restricted.
const VERCEL_IP = process.env.VERCEL_IP || '216.198.79.3';
const BASE_HOST = new URL(BASE_URL).hostname;
const browser = await chromium.launch({
  headless: true,
  args: [`--host-resolver-rules=MAP ${BASE_HOST} ${VERCEL_IP}`],
});
  const context = await browser.newContext({ locale: 'he-IL' });

  // Dismiss any confirm/alert dialogs automatically (e.g. quiz "quit?" prompt)
  context.on('dialog', d => d.dismiss().catch(() => {}));

  const page = await context.newPage();

  try {
    // ── LOGIN ──────────────────────────────────────────────────────────────
    console.log('🔐 Logging in...');
    await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle' });
    // Debug: take screenshot to see what loaded
    await page.screenshot({ path: 'tiktok-assets/debug-login.png' });
    console.log('   Debug screenshot saved: tiktok-assets/debug-login.png');
    await page.waitForSelector('#auth-email', { timeout: 25000 });
    await page.fill('#auth-email', EP_EMAIL);
    await page.fill('#auth-pass', EP_PASS);
    await page.click('#auth-submit');
    await page.waitForFunction(
      () => !location.pathname.includes('/login') && !location.pathname.includes('/signup'),
      { timeout: 25000 }
    );
    console.log('✅ Logged in\n');

    // ── SLIDES ──────────────────────────────────────────────────────────────
    for (const slide of SLIDES) {
      console.log(`── Slide ${slide.id}: ${slide.name}`);

      let screenshotBase64 = null;

      if (slide.screenshotFlow) {
        await page.setViewportSize(slide.viewport);

        try {
          await slide.screenshotFlow(page);
          const buf = await page.screenshot({ fullPage: false });
          screenshotBase64 = buf.toString('base64');
          await writeFile(resolve(OUT_DIR, `raw-${slide.id}-${slide.name}.png`), buf);
          console.log(`   📷 Screenshot saved (raw-${slide.id}-${slide.name}.png)`);
        } catch (err) {
          console.warn(`   ⚠️  Screenshot failed — will generate without: ${err.message}`);
        }
      } else {
        console.log('   ✏️  Text-to-image (no screenshot needed)');
      }

      console.log('   🤖 Calling Nano Banana...');
      try {
        const imgBuf = await callNanoBanana(slide.prompt, screenshotBase64);
        const outPath = resolve(OUT_DIR, `slide-${slide.id}-${slide.name}.png`);
        await writeFile(outPath, imgBuf);
        console.log(`   ✅ slide-${slide.id}-${slide.name}.png\n`);
      } catch (err) {
        console.error(`   ❌ Nano Banana error: ${err.message}\n`);
      }
    }
  } finally {
    await browser.close();
  }

  console.log('🎉 Done! Files saved to:', OUT_DIR);
  console.log('');
  console.log('Next: Open each slide-N-*.png in Canva and add Hebrew text overlays');
  console.log('      per the marketing plan at ~/.claude/plans/rosy-whistling-hippo.md');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
