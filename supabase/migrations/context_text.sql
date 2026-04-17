-- Add context_text column to ep_questions.
-- Stores raw text from the shared context block (code / theorem / passage)
-- that appears above a set of related MCQs (group_id not null).
-- Displayed during quiz so students can read context without opening the crop image.
ALTER TABLE ep_questions ADD COLUMN IF NOT EXISTS context_text TEXT;
