// Shared helper for Gemini API key selection across all endpoints.
// Default (April 2026): PAID-ONLY mode. GEMINI_API_KEY_PAID is used for every
// call; we never silently downgrade to the free quota. Set
// GEMINI_PAID_ONLY=false to restore the old paid→free fallback on 429.

import { PAID_ONLY } from './gemini-models.mjs';

function clean(raw) {
  return (raw || '').replace(/\\n/g, '').trim();
}

export function getGeminiKeys() {
  const freeKey = clean(process.env.GEMINI_API_KEY);
  const paidKey = clean(process.env.GEMINI_API_KEY_PAID);
  if (PAID_ONLY) {
    return {
      primaryKey: paidKey,
      fallbackKey: null,
      paidKey,
      freeKey: '',
      hasPaid: !!paidKey,
    };
  }
  const primaryKey = paidKey || freeKey;
  const fallbackKey = paidKey && freeKey ? freeKey : null;
  return { primaryKey, fallbackKey, paidKey, freeKey, hasPaid: !!paidKey };
}

export function isQuotaError(status, body) {
  if (status === 429) return true;
  if (status === 403 && typeof body === 'string' && /quota|rate/i.test(body)) return true;
  return false;
}

// Retry helper for transient failures (429, 503, 504) with exponential backoff.
// `fn` should return { ok, status } or throw. Only retries on transient errors.
// Layer 6: wraps Gemini callers to survive Gemini rate-limit blips without
// failing the whole upload.
export async function withBackoff(fn, { maxRetries = 3, delaysMs = [2000, 8000, 30000], label = 'backoff' } = {}) {
  for (let i = 0; i <= maxRetries; i++) {
    try {
      const res = await fn();
      if (res && res.ok === false) {
        const s = res.status;
        const retryable = s === 429 || (s >= 500 && s < 600);
        if (retryable && i < maxRetries) {
          const wait = delaysMs[i] ?? delaysMs[delaysMs.length - 1];
          console.warn(`[${label}] attempt ${i + 1}/${maxRetries + 1} got ${s}; retrying in ${wait}ms`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
      }
      return res;
    } catch (err) {
      const msg = err?.message || String(err);
      // AbortError / network timeouts considered transient.
      const retryable = /abort|timeout|ECONN|fetch failed/i.test(msg);
      if (retryable && i < maxRetries) {
        const wait = delaysMs[i] ?? delaysMs[delaysMs.length - 1];
        console.warn(`[${label}] attempt ${i + 1}/${maxRetries + 1} threw (${msg.slice(0, 80)}); retrying in ${wait}ms`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
  // Should not reach — the loop either returns or throws.
  return null;
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
