// Central Gemini model configuration. Every API caller pulls its model chain
// from here so the whole app can be re-targeted to a different model without
// a code change — set env vars in Vercel and redeploy.
//
// Two chain profiles (April 2026):
//   FAST     — flash models only. Used where latency matters (full-PDF layout
//              extraction, batched solution generation for a whole exam). The
//              strong pro-preview is a thinking model and routinely needs
//              60-120s on a full PDF; chaining it first blows the 300s Vercel
//              maxDuration on upload.mjs.
//   ACCURATE — leads with pro-preview. Used for small/targeted calls where
//              accuracy matters more than latency: answer-key extraction,
//              per-question explanation generation, reverify.
//
//   extraction — PDF layout detection + batch solution generation  → FAST
//   critical   — answer-key extraction, highlight scans            → ACCURATE
//   explain    — on-demand explanation generation                  → ACCURATE

export const MODELS = {
  primary:  (process.env.GEMINI_MODEL_PRIMARY  || 'gemini-3-flash-preview').trim(),
  strong:   (process.env.GEMINI_MODEL_STRONG   || 'gemini-3.1-pro-preview').trim(),
  fallback: (process.env.GEMINI_MODEL_FALLBACK || 'gemini-2.5-flash').trim(),
};

// Paid-only mode — when true, every caller uses ONLY the paid API key.
// If Google returns 429 we fail loudly instead of silently degrading to the
// free tier. Defaults to true; set GEMINI_PAID_ONLY=false to re-enable the
// free fallback.
export const PAID_ONLY = (process.env.GEMINI_PAID_ONLY !== 'false');

function dedupe(arr) {
  const seen = new Set();
  const out = [];
  for (const m of arr) { if (m && !seen.has(m)) { seen.add(m); out.push(m); } }
  return out;
}

// FAST_CHAIN order: 2.5-flash FIRST despite being the "older" flash model.
// Production evidence (2026-04-22): gemini-3-flash-preview timed out at 60s
// on a full exam PDF while gemini-2.5-flash completed the same call in under
// 30s and returned 11 MCQs. For upload reliability (where a 300s Vercel
// maxDuration is a hard ceiling) proven-fast beats newer-preview.
// flash-preview stays as a fallback so we still benefit from it when it works.
const FAST_CHAIN     = dedupe([MODELS.fallback, MODELS.primary]);
const ACCURATE_CHAIN = dedupe([MODELS.strong, MODELS.primary, MODELS.fallback]);

export const MODEL_CHAIN = {
  extraction: FAST_CHAIN,
  critical:   ACCURATE_CHAIN,
  explain:    ACCURATE_CHAIN,
};

// When a caller already has a hard-coded need for the strongest model (e.g.
// a last-resort retry with the loose prompt), expose the single ID too.
export const STRONG_MODEL = MODELS.strong;
