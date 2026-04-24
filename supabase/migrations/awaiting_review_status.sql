-- Adds 'awaiting_review' to ep_exams.status so uploads that produced
-- any unknown/uncertain answers don't auto-publish; the user must open
-- the Review screen, confirm answers, and finalize → 'ready'.
--
-- Transitions: pending → processing → (awaiting_review | ready | failed)
-- From awaiting_review → ready (via /api/exams/finalize-review).
--
-- ep_exams.status is TEXT (not enum) per schema.sql; only the CHECK
-- constraint needs updating. Idempotent: drops the old check if present.

DO $$
BEGIN
  ALTER TABLE ep_exams DROP CONSTRAINT IF EXISTS ep_exams_status_check;
  ALTER TABLE ep_exams
    ADD CONSTRAINT ep_exams_status_check
    CHECK (status IN ('pending','processing','awaiting_review','ready','failed'));
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'awaiting_review_status: constraint alter skipped: %', SQLERRM;
END $$;

COMMENT ON COLUMN ep_exams.status IS
  'Upload lifecycle: pending → processing → (awaiting_review | ready | failed). awaiting_review = at least one question has answer_confidence in (unknown,uncertain); user must open Review and confirm before practice is unlocked.';
