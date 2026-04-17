// Shared helper for Gemini API key selection across all endpoints.
// Prefers GEMINI_API_KEY_PAID (billed to Google Cloud credits) with fallback
// to GEMINI_API_KEY (free tier) on quota_exceeded. Both keys are trimmed of
// whitespace/newlines that occasionally creep in via Vercel env-var storage.

function clean(raw) {
  return (raw || '').replace(/\\n/g, '').trim();
}

export function getGeminiKeys() {
  const freeKey = clean(process.env.GEMINI_API_KEY);
  const paidKey = clean(process.env.GEMINI_API_KEY_PAID);
  const primaryKey = paidKey || freeKey;
  const fallbackKey = paidKey && freeKey ? freeKey : null;
  return { primaryKey, fallbackKey, paidKey, freeKey, hasPaid: !!paidKey };
}

export function isQuotaError(status, body) {
  if (status === 429) return true;
  if (status === 403 && typeof body === 'string' && /quota|rate/i.test(body)) return true;
  return false;
}

// Calls Gemini generateContent with automatic paid→free fallback on quota errors.
// `callFn(apiKey)` must return { ok, status, bodyText, json } or throw.
export async function callGeminiWithFallback(callFn, label = 'gemini') {
  const { primaryKey, fallbackKey, hasPaid } = getGeminiKeys();
  if (!primaryKey) return { ok: false, reason: 'no_api_key' };

  console.log(`[${label}] using ${hasPaid ? 'paid' : 'free'} key as primary`);
  const primary = await callFn(primaryKey);
  if (primary.ok) return primary;

  if (fallbackKey && isQuotaError(primary.status, primary.bodyText)) {
    console.warn(`[${label}] primary key quota exceeded — switching to fallback key`);
    const fallback = await callFn(fallbackKey);
    return fallback;
  }
  return primary;
}
