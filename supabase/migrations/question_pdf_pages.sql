-- question_pdf_pages — store explicit PDF page numbers per question so the
-- frontend crop tool can open the exact page of the source exam / solution
-- PDF without any user flipping. Confidence columns let us flag auto-detected
-- values (may be wrong) vs user-confirmed values (ground truth after a save).
--
-- Values for *_confidence: 'detected' | 'user_confirmed' | 'unknown'
--   'detected'       — set by the upload pipeline (parsing or Gemini Flash).
--   'user_confirmed' — set after the user saves a crop / answer from a given
--                      page (self-heal: whatever page they actually used is
--                      treated as ground truth, overriding a prior detection).
--   'unknown'        — detection failed; UI should fall back to page 1 and
--                      show the "page not confirmed" banner.

ALTER TABLE ep_questions
  ADD COLUMN IF NOT EXISTS pdf_page INT,
  ADD COLUMN IF NOT EXISTS pdf_page_confidence TEXT,
  ADD COLUMN IF NOT EXISTS solution_pdf_page INT,
  ADD COLUMN IF NOT EXISTS solution_pdf_page_confidence TEXT,
  ADD COLUMN IF NOT EXISTS context_pdf_page INT;

CREATE INDEX IF NOT EXISTS idx_ep_questions_exam_page
  ON ep_questions(exam_id, pdf_page);
