// =====================================================
// Modelim plan guard
// =====================================================
// Users on plan='modelim' are friends of the "מודלים חישוביים" course who
// got the app with a pre-seeded MCQ library. They must never trigger Gemini
// or modify their account — the whole experience is read-only practice on
// the cloned data.
//
// Usage at an endpoint (anywhere that currently runs any Gemini / write):
//
//   import { assertNotModelim, fetchPlan } from './_lib/seed-guard.mjs';
//   const plan = await fetchPlan(admin, auth.userId);
//   if (assertNotModelim(res, plan)) return;
//
// The `assertNotModelim` helper sends a 403 JSON response itself and returns
// true; the caller just returns.

const MODELIM = 'modelim';

export function isModelim(planOrProfile) {
  if (!planOrProfile) return false;
  if (typeof planOrProfile === 'string') return planOrProfile === MODELIM;
  return planOrProfile?.plan === MODELIM;
}

export function assertNotModelim(res, planOrProfile) {
  // Admin profiles are exempt regardless of plan — they need to manage content.
  if (planOrProfile && typeof planOrProfile === 'object' && planOrProfile.is_admin) return false;
  if (!isModelim(planOrProfile)) return false;
  res.status(403).json({
    error: 'התוכנית שלך לא מאפשרת פעולה זו',
    guidance: 'משתמשי "מודלים חישוביים" יכולים רק לתרגל שאלות אמריקאיות מתוך המבחנים שהועלו.',
    plan: MODELIM,
  });
  return true;
}

// Lightweight plan lookup — single column, no quota-reset side effects.
// Pass the service-role client so RLS doesn't hide the row when the caller
// is in a context that doesn't have a user JWT.
export async function fetchPlan(admin, userId) {
  if (!admin || !userId) return null;
  try {
    const { data } = await admin.from('profiles').select('plan, is_admin').eq('id', userId).maybeSingle();
    return data || null;
  } catch {
    return null;
  }
}

// One-shot guard for AI endpoints. Returns true if the response was sent and
// the caller should return immediately. Admin users are exempt so a
// modelim-flagged admin can still upload + edit content.
export async function checkModelimBlock(res, admin, userId) {
  const row = await fetchPlan(admin, userId);
  if (row?.is_admin) return false;
  return assertNotModelim(res, row);
}
