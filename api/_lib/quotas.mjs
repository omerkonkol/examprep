// =====================================================
// Single source of truth for per-plan usage quotas.
// =====================================================
// Every endpoint that enforces or reports quotas imports from here.
// Use -1 for "unlimited" caps (the reserve_*-slot RPCs skip checks at -1).

// explain_day is the per-day cap for the OPT-IN ensemble explainer (Layer 4).
// It's a subset of ai_day; each ensemble call burns 3 ai-slots (since it runs
// 3 parallel LLM calls). Free users get 0 to protect the global budget;
// paid tiers scale with plan size.
export const PLAN_QUOTAS = {
  // Restricted plan for friends of the "מודלים חישוביים" course. Pure offline
  // practice on the pre-seeded MCQ library; zero AI, no uploads, no new courses.
  // Server guards (api/_lib/seed-guard.mjs) block AI endpoints for this plan,
  // so the quota numbers here are a belt-and-suspenders fallback.
  modelim: {
    pdf_day: 0,  pdf_month: 0,
    ai_day: 0,   ai_month: 0,
    explain_day: 0,
    pack_day: 0, pack_month: 0, pack_total: 0,
    lab_day: 0,  lab_month: 0,
    courses: 0,
    storage_mb: 0,
    max_pdf_size_mb: 0, max_pages_per_pdf: 0,
  },
  trial: {
    pdf_day: 7,  pdf_month: 40,
    ai_day: 25,  ai_month: 150,
    explain_day: 3,
    pack_day: 6,  pack_month: 30, pack_total: -1,
    lab_day: 20, lab_month: 120,
    courses: 5,
    storage_mb: 500,
    max_pdf_size_mb: 20,  max_pages_per_pdf: 60,
  },
  free: {
    pdf_day: 5,  pdf_month: 30,
    ai_day: 15,  ai_month: 80,
    explain_day: 0,
    pack_day: 4, pack_month: 20, pack_total: -1,
    lab_day: 10, lab_month: 60,
    courses: 5,
    storage_mb: 300,
    max_pdf_size_mb: 15,  max_pages_per_pdf: 40,
  },
  basic: {
    pdf_day: 10,  pdf_month: 60,
    ai_day: 30,   ai_month: 200,
    explain_day: 5,
    pack_day: 8,  pack_month: 50,  pack_total: -1,
    lab_day: 25, lab_month: 150,
    courses: 10,
    storage_mb: 1024,
    max_pdf_size_mb: 20,  max_pages_per_pdf: 50,
  },
  pro: {
    pdf_day: 20,  pdf_month: 150,
    ai_day: 80,   ai_month: 600,
    explain_day: 15,
    pack_day: 20, pack_month: 150, pack_total: -1,
    lab_day: 60, lab_month: 400,
    courses: -1,
    storage_mb: 5120,
    max_pdf_size_mb: 30,  max_pages_per_pdf: 100,
  },
  education: {
    pdf_day: 40,  pdf_month: 400,
    ai_day: 150,  ai_month: 1500,
    explain_day: 40,
    pack_day: -1, pack_month: -1, pack_total: -1,
    lab_day: 150, lab_month: 1500,
    courses: -1,
    storage_mb: 20480,
    max_pdf_size_mb: 50,  max_pages_per_pdf: 150,
  },
};

export function getQuota(plan) {
  return PLAN_QUOTAS[plan] || PLAN_QUOTAS.free;
}

// Legacy shape used by api/crud.mjs for /api/me + course limits.
// Keeps existing field names (pdfs_per_day, courses, …) so callers don't break.
export function legacyQuotaShape(plan) {
  const q = getQuota(plan);
  return {
    pdfs_total: -1,
    pdfs_per_day: q.pdf_day,
    pdfs_per_month: q.pdf_month,
    ai_questions_per_day: q.ai_day,
    ai_questions_per_month: q.ai_month,
    study_packs_total: q.pack_total,
    study_packs_per_day: q.pack_day,
    study_packs_per_month: q.pack_month,
    lab_questions_per_day: q.lab_day,
    lab_questions_per_month: q.lab_month,
    courses: q.courses,
    storage_mb: q.storage_mb,
    max_pdf_size_mb: q.max_pdf_size_mb,
    max_pages_per_pdf: q.max_pages_per_pdf,
  };
}
