-- =====================================================
-- Migration: Reorganize existing courses into degree hierarchy
-- 1. omerkol123@gmail.com → מודלים חישוביים inside תואר מדעי המחשב
-- 2. xtractions1mv@gmail.com (admin) → תוכנה 1 inside תואר למדעי המחשב
-- Preserves all existing data (exams, questions, attempts, batches).
-- =====================================================

DO $$
DECLARE
  v_user1_id   UUID;
  v_user2_id   UUID;
  v_degree1_id BIGINT;
  v_degree2_id BIGINT;
  v_course1_id BIGINT;
  v_course2_id BIGINT;
  v_updated    INT;
BEGIN

  -- ── User 1: omerkol123@gmail.com ─────────────────────────────────────────
  SELECT id INTO v_user1_id FROM auth.users WHERE email = 'omerkol123@gmail.com';

  IF v_user1_id IS NULL THEN
    RAISE NOTICE 'User omerkol123@gmail.com not found — skipping';
  ELSE
    -- Find מודלים חישוביים (top-level, not already in a degree)
    SELECT id INTO v_course1_id
      FROM ep_courses
      WHERE user_id = v_user1_id
        AND name ILIKE '%מודלים חישוביים%'
        AND parent_id IS NULL
      ORDER BY created_at ASC
      LIMIT 1;

    IF v_course1_id IS NULL THEN
      RAISE NOTICE 'No top-level "מודלים חישוביים" found for omerkol123@gmail.com';
    ELSE
      -- Get or create degree "תואר מדעי המחשב"
      SELECT id INTO v_degree1_id
        FROM ep_courses
        WHERE user_id = v_user1_id
          AND is_degree = TRUE
          AND name = 'תואר מדעי המחשב'
        LIMIT 1;

      IF v_degree1_id IS NULL THEN
        INSERT INTO ep_courses (user_id, name, description, is_degree, color, parent_id)
        VALUES (
          v_user1_id,
          'תואר מדעי המחשב',
          '',
          TRUE,
          COALESCE((SELECT color FROM ep_courses WHERE id = v_course1_id), '#3b82f6'),
          NULL
        )
        RETURNING id INTO v_degree1_id;
        RAISE NOTICE 'Created degree "תואר מדעי המחשב" id=% for omerkol123', v_degree1_id;
      ELSE
        RAISE NOTICE 'Degree "תואר מדעי המחשב" id=% already exists', v_degree1_id;
      END IF;

      -- Move course into degree
      UPDATE ep_courses SET parent_id = v_degree1_id WHERE id = v_course1_id;
      GET DIAGNOSTICS v_updated = ROW_COUNT;
      RAISE NOTICE 'Moved "מודלים חישוביים" id=% into degree % (rows updated: %)',
        v_course1_id, v_degree1_id, v_updated;
    END IF;
  END IF;


  -- ── User 2: admin (xtractions1mv@gmail.com) ──────────────────────────────
  SELECT id INTO v_user2_id FROM auth.users WHERE email = 'xtractions1mv@gmail.com';

  IF v_user2_id IS NULL THEN
    RAISE NOTICE 'Admin user xtractions1mv@gmail.com not found — skipping';
  ELSE
    -- Find תוכנה 1 (top-level, not already in a degree)
    SELECT id INTO v_course2_id
      FROM ep_courses
      WHERE user_id = v_user2_id
        AND name ILIKE '%תוכנה 1%'
        AND parent_id IS NULL
      ORDER BY created_at ASC
      LIMIT 1;

    IF v_course2_id IS NULL THEN
      RAISE NOTICE 'No top-level "תוכנה 1" found for admin — will create one';

      -- Create a real ep_courses row for תוכנה 1 (initially empty; admin data is local)
      INSERT INTO ep_courses (user_id, name, description, is_degree, color, parent_id)
      VALUES (v_user2_id, 'תוכנה 1', '', FALSE, '#3b82f6', NULL)
      RETURNING id INTO v_course2_id;
      RAISE NOTICE 'Created "תוכנה 1" course id=% for admin', v_course2_id;
    ELSE
      RAISE NOTICE 'Found "תוכנה 1" id=% for admin', v_course2_id;
    END IF;

    -- Get or create degree "תואר למדעי המחשב"
    SELECT id INTO v_degree2_id
      FROM ep_courses
      WHERE user_id = v_user2_id
        AND is_degree = TRUE
        AND name ILIKE '%תואר%מדעי המחשב%'
      LIMIT 1;

    IF v_degree2_id IS NULL THEN
      INSERT INTO ep_courses (user_id, name, description, is_degree, color, parent_id)
      VALUES (v_user2_id, 'תואר למדעי המחשב', '', TRUE, '#3b82f6', NULL)
      RETURNING id INTO v_degree2_id;
      RAISE NOTICE 'Created degree "תואר למדעי המחשב" id=% for admin', v_degree2_id;
    ELSE
      RAISE NOTICE 'Degree "תואר למדעי המחשב" id=% already exists', v_degree2_id;
    END IF;

    -- Move תוכנה 1 into the degree
    UPDATE ep_courses SET parent_id = v_degree2_id WHERE id = v_course2_id;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    RAISE NOTICE 'Moved "תוכנה 1" id=% into degree % (rows updated: %)',
      v_course2_id, v_degree2_id, v_updated;
  END IF;

END $$;

-- Verify result
SELECT
  u.email,
  c.id,
  c.name,
  c.is_degree,
  c.parent_id,
  c.color,
  c.created_at
FROM ep_courses c
JOIN auth.users u ON u.id = c.user_id
WHERE u.email IN ('omerkol123@gmail.com', 'xtractions1mv@gmail.com')
ORDER BY u.email, c.is_degree DESC, c.created_at ASC;
