-- Idempotent migration: ensure all ep_questions columns that are added by
-- individual migration files also exist here. Running this in production
-- guarantees the generate-solutions and add-solution endpoints don't fail
-- with "column does not exist" even if earlier migration files were skipped.

-- From question_group_id.sql
ALTER TABLE ep_questions ADD COLUMN IF NOT EXISTS group_id TEXT;

-- From context_text.sql
ALTER TABLE ep_questions ADD COLUMN IF NOT EXISTS context_text TEXT;

-- From answer_confidence.sql + answer_confidence_add_uncertain.sql
ALTER TABLE ep_questions ADD COLUMN IF NOT EXISTS answer_confidence TEXT NOT NULL DEFAULT 'confirmed';
ALTER TABLE ep_questions DROP CONSTRAINT IF EXISTS ep_questions_answer_confidence_check;
ALTER TABLE ep_questions ADD CONSTRAINT ep_questions_answer_confidence_check
  CHECK (answer_confidence IN ('confirmed', 'unknown', 'manual', 'uncertain'));

-- From instructor_solutions.sql
ALTER TABLE ep_questions ADD COLUMN IF NOT EXISTS instructor_solution_text TEXT;
ALTER TABLE ep_questions ADD COLUMN IF NOT EXISTS has_rich_solution BOOLEAN NOT NULL DEFAULT FALSE;

-- num_options already defined in base schema (DEFAULT 4) but ensure it exists
ALTER TABLE ep_questions ADD COLUMN IF NOT EXISTS num_options INTEGER NOT NULL DEFAULT 4;

-- question_text / options_text already in base schema idempotent section
ALTER TABLE ep_questions ADD COLUMN IF NOT EXISTS question_text TEXT;
ALTER TABLE ep_questions ADD COLUMN IF NOT EXISTS options_text JSONB;

-- deleted_at already in base schema idempotent section
ALTER TABLE ep_questions ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Partial index for group queries (IF NOT EXISTS not supported on CREATE INDEX in older PG,
-- but the WHERE clause makes it effectively a no-op if already present).
CREATE INDEX IF NOT EXISTS ep_questions_group_idx ON ep_questions(exam_id, group_id)
  WHERE group_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ep_questions_has_rich_solution_idx
  ON ep_questions(has_rich_solution) WHERE has_rich_solution = true;

-- From context_image_path.sql
ALTER TABLE ep_questions ADD COLUMN IF NOT EXISTS context_image_path TEXT;

-- From context_cross_page.sql
ALTER TABLE ep_questions ADD COLUMN IF NOT EXISTS context_cross_page BOOLEAN NOT NULL DEFAULT FALSE;

-- ep_exams: Cloudinary publicIds stored at upload time so per-question re-analysis
-- can fetch the original PDFs without needing them re-uploaded.
ALTER TABLE ep_exams ADD COLUMN IF NOT EXISTS exam_pdf_path TEXT;
ALTER TABLE ep_exams ADD COLUMN IF NOT EXISTS solution_pdf_path TEXT;
