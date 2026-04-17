-- =====================================================
-- instructor_solution_text — preserve rich solution text written by the
-- instructor when a solution PDF contains detailed explanations (not just
-- a final-answer key). When present, the UI shows the instructor text
-- verbatim and skips calling Gemini to generate explanations.
-- =====================================================

ALTER TABLE ep_questions
  ADD COLUMN IF NOT EXISTS instructor_solution_text TEXT,
  ADD COLUMN IF NOT EXISTS has_rich_solution BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS ep_questions_has_rich_solution_idx
  ON ep_questions(has_rich_solution) WHERE has_rich_solution = true;
