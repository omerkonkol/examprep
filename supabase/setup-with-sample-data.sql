-- =====================================================
-- ExamPrep - Complete Setup + Sample Data
-- =====================================================
-- Run this ONCE in Supabase SQL Editor
-- This creates all tables AND inserts a sample course
-- "תוכנה 1 (לדוגמה)" with 8 questions from moed א סמסטר א 2024

-- ====== EXTEND PROFILES ======
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'free';
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS pdfs_uploaded_this_month INTEGER NOT NULL DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS ai_questions_used_this_month INTEGER NOT NULL DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS storage_bytes_used BIGINT NOT NULL DEFAULT 0;

-- ====== EP_COURSES ======
CREATE TABLE IF NOT EXISTS ep_courses (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  color TEXT DEFAULT '#3b82f6',
  total_questions INTEGER NOT NULL DEFAULT 0,
  total_pdfs INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ep_courses_user_idx ON ep_courses(user_id);
ALTER TABLE ep_courses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ep_courses_all_own" ON ep_courses;
CREATE POLICY "ep_courses_all_own" ON ep_courses FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ====== EP_EXAMS ======
CREATE TABLE IF NOT EXISTS ep_exams (
  id BIGSERIAL PRIMARY KEY,
  course_id BIGINT REFERENCES ep_courses(id) ON DELETE CASCADE NOT NULL,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL,
  exam_pdf_path TEXT,
  solution_pdf_path TEXT,
  exam_pdf_hash TEXT,
  total_pages INTEGER,
  question_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ep_exams_course_idx ON ep_exams(course_id);
CREATE INDEX IF NOT EXISTS ep_exams_user_idx ON ep_exams(user_id);
ALTER TABLE ep_exams ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ep_exams_all_own" ON ep_exams;
CREATE POLICY "ep_exams_all_own" ON ep_exams FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ====== EP_QUESTIONS ======
CREATE TABLE IF NOT EXISTS ep_questions (
  id BIGSERIAL PRIMARY KEY,
  exam_id BIGINT REFERENCES ep_exams(id) ON DELETE CASCADE NOT NULL,
  course_id BIGINT REFERENCES ep_courses(id) ON DELETE CASCADE NOT NULL,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  question_number INTEGER NOT NULL,
  section_label TEXT,
  image_path TEXT NOT NULL,
  num_options INTEGER NOT NULL DEFAULT 4,
  option_labels JSONB,
  correct_idx INTEGER NOT NULL,
  topic TEXT,
  general_explanation TEXT,
  option_explanations JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ep_questions_course_idx ON ep_questions(course_id);
ALTER TABLE ep_questions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ep_questions_all_own" ON ep_questions;
CREATE POLICY "ep_questions_all_own" ON ep_questions FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ====== EP_ATTEMPTS ======
CREATE TABLE IF NOT EXISTS ep_attempts (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  question_id BIGINT REFERENCES ep_questions(id) ON DELETE CASCADE NOT NULL,
  course_id BIGINT REFERENCES ep_courses(id) ON DELETE CASCADE NOT NULL,
  selected_idx INTEGER,
  is_correct BOOLEAN NOT NULL DEFAULT FALSE,
  revealed BOOLEAN NOT NULL DEFAULT FALSE,
  time_seconds INTEGER,
  batch_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ep_attempts_user_idx ON ep_attempts(user_id);
ALTER TABLE ep_attempts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ep_attempts_all_own" ON ep_attempts;
CREATE POLICY "ep_attempts_all_own" ON ep_attempts FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ====== MARK ADMIN ======
UPDATE profiles SET is_admin = TRUE, plan = 'pro', email = 'admin@examprep.app'
WHERE id = 'ac8866f4-e462-440f-92c0-42e60ecba7bb';

-- ====== INSERT SAMPLE DATA: תוכנה 1 course ======
-- (Only if it doesn't exist yet, identified by special hash)
DO $$
DECLARE
  v_user_id UUID := 'ac8866f4-e462-440f-92c0-42e60ecba7bb';
  v_course_id BIGINT;
  v_exam_id BIGINT;
BEGIN
  -- Check if sample course already exists
  SELECT id INTO v_course_id FROM ep_courses
  WHERE user_id = v_user_id AND name = 'תוכנה 1 (לדוגמה)' LIMIT 1;

  IF v_course_id IS NULL THEN
    -- Create course
    INSERT INTO ep_courses (user_id, name, description, color, total_questions, total_pdfs)
    VALUES (v_user_id, 'תוכנה 1 (לדוגמה)', 'דוגמה לקורס תוכנה 1 - אונ'' תל אביב. 8 שאלות אמריקאיות מהמועד א סמסטר א 2024.', '#2563eb', 8, 1)
    RETURNING id INTO v_course_id;

    -- Create the sample exam
    INSERT INTO ep_exams (course_id, user_id, name, status, question_count, processed_at)
    VALUES (v_course_id, v_user_id, 'מועד א, סמסטר א, 2024', 'ready', 8, NOW())
    RETURNING id INTO v_exam_id;

    -- Insert 8 sample questions (images served from tohna1-quiz.vercel.app)
    INSERT INTO ep_questions (exam_id, course_id, user_id, question_number, section_label, image_path, num_options, option_labels, correct_idx, topic) VALUES
    (v_exam_id, v_course_id, v_user_id, 1, 'א',
      'https://tohna1-quiz.vercel.app/images/moed_a_sem_a_2024/q-01_%D7%90.png',
      2, '["מתקמפל","לא מתקמפל"]'::jsonb, 2, 'Method Overloading + Generics'),
    (v_exam_id, v_course_id, v_user_id, 2, 'ב',
      'https://tohna1-quiz.vercel.app/images/moed_a_sem_a_2024/q-02_%D7%91.png',
      2, '["מתקמפל","לא מתקמפל"]'::jsonb, 2, 'Method Overloading + Wildcards'),
    (v_exam_id, v_course_id, v_user_id, 3, 'ג',
      'https://tohna1-quiz.vercel.app/images/moed_a_sem_a_2024/q-03_%D7%92.png',
      3, NULL, 2, 'Inner Classes + Generics'),
    (v_exam_id, v_course_id, v_user_id, 4, 'ד',
      'https://tohna1-quiz.vercel.app/images/moed_a_sem_a_2024/q-04_%D7%93.png',
      3, NULL, 2, 'Wildcards (extends/super)'),
    (v_exam_id, v_course_id, v_user_id, 5, 'ה',
      'https://tohna1-quiz.vercel.app/images/moed_a_sem_a_2024/q-05_%D7%94.png',
      3, NULL, 1, 'Streams (peek/sorted/forEach)'),
    (v_exam_id, v_course_id, v_user_id, 6, 'ו',
      'https://tohna1-quiz.vercel.app/images/moed_a_sem_a_2024/q-06_%D7%95.png',
      2, '["מנשק פונקציונלי","אינו מנשק פונקציונלי"]'::jsonb, 2, 'Functional Interfaces'),
    (v_exam_id, v_course_id, v_user_id, 7, 'ז',
      'https://tohna1-quiz.vercel.app/images/moed_a_sem_a_2024/q-07_%D7%96.png',
      4, NULL, 1, 'Constructor + Method Overriding'),
    (v_exam_id, v_course_id, v_user_id, 8, 'ח',
      'https://tohna1-quiz.vercel.app/images/moed_a_sem_a_2024/q-08_%D7%97.png',
      4, NULL, 2, 'private vs public Method Resolution');

    RAISE NOTICE 'Sample course created with id %', v_course_id;
  ELSE
    RAISE NOTICE 'Sample course already exists with id %', v_course_id;
  END IF;
END $$;
