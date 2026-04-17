-- Context group support: questions sharing a figure/passage/table get the same group_id.
-- NULL = standalone question (the vast majority).
-- group_id is a short label (e.g. "A", "B") identifying the shared context cluster
-- within a single exam. Set at upload time by analyzeExamWithGemini.
ALTER TABLE ep_questions ADD COLUMN IF NOT EXISTS group_id TEXT;

-- Partial index for future querying (e.g. "show all questions in group A of exam X").
-- Partial so it has zero storage/maintenance overhead for standalone questions.
CREATE INDEX IF NOT EXISTS ep_questions_group_idx ON ep_questions(exam_id, group_id)
  WHERE group_id IS NOT NULL;
