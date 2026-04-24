-- Adds enrichment columns for the opt-in ensemble explainer (Layer 4).
-- concept_tag: short Hebrew tag (e.g. "סיבוכיות זמן", "טבלאות אמת")
-- distractor_analysis: per-wrong-option misconception breakdown, JSONB array
-- explanation_status: lifecycle flag for async/ensemble generation
--
-- All columns are additive + nullable. Existing questions and explainer paths
-- continue to work unchanged.

ALTER TABLE ep_questions
  ADD COLUMN IF NOT EXISTS concept_tag TEXT;

ALTER TABLE ep_questions
  ADD COLUMN IF NOT EXISTS distractor_analysis JSONB;

ALTER TABLE ep_questions
  ADD COLUMN IF NOT EXISTS explanation_status TEXT NOT NULL DEFAULT 'none'
    CHECK (explanation_status IN ('none','generating','verified','failed','stale'));

-- Index for quickly finding questions needing regeneration after user feedback.
CREATE INDEX IF NOT EXISTS ep_questions_explanation_status_idx
  ON ep_questions (explanation_status)
  WHERE explanation_status IN ('generating','failed');

COMMENT ON COLUMN ep_questions.concept_tag IS 'Short Hebrew tag describing the concept (e.g. "סיבוכיות זמן"). Populated by the ensemble explainer. Null = not yet classified.';
COMMENT ON COLUMN ep_questions.distractor_analysis IS 'JSONB array: [{idx, misconception, why_wrong}]. Explains WHY each wrong option sounds plausible. Complements option_explanations (kept for backward compat).';
COMMENT ON COLUMN ep_questions.explanation_status IS 'Lifecycle: none → generating → (verified | failed | stale). verified = validated ensemble output. stale = flagged for regeneration (e.g. after manual answer correction).';
