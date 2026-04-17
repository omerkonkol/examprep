-- =====================================================
-- Security hardening — April 2026
-- Closes gaps introduced by study_packs_course, degree_hierarchy migrations
-- and locks the is_admin flag against client-side tampering.
-- Run manually in Supabase SQL editor.
-- =====================================================

-- ─────────────────────────────────────────────────────────────
-- 1) ep_study_packs: validate course_id ownership via RLS
-- ─────────────────────────────────────────────────────────────
-- Drop any broad policies and re-create with FK ownership check.
DROP POLICY IF EXISTS "study_packs_insert" ON ep_study_packs;
DROP POLICY IF EXISTS "study_packs_update" ON ep_study_packs;
DROP POLICY IF EXISTS "ep_study_packs_write" ON ep_study_packs;
DROP POLICY IF EXISTS "ep_study_packs_insert_own" ON ep_study_packs;
DROP POLICY IF EXISTS "ep_study_packs_update_own" ON ep_study_packs;

CREATE POLICY "ep_study_packs_insert_own" ON ep_study_packs
  FOR INSERT WITH CHECK (
    user_id = auth.uid() AND (
      course_id IS NULL OR
      course_id IN (SELECT id FROM ep_courses WHERE user_id = auth.uid())
    )
  );

CREATE POLICY "ep_study_packs_update_own" ON ep_study_packs
  FOR UPDATE USING (user_id = auth.uid())
  WITH CHECK (
    user_id = auth.uid() AND (
      course_id IS NULL OR
      course_id IN (SELECT id FROM ep_courses WHERE user_id = auth.uid())
    )
  );

-- ─────────────────────────────────────────────────────────────
-- 2) ep_courses: validate parent_id integrity via trigger
--    — parent must belong to same user
--    — no cycles (A → B → A)
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION validate_course_parent() RETURNS trigger AS $$
DECLARE
  parent_owner UUID;
  cursor_id BIGINT;
  depth INT;
BEGIN
  IF NEW.parent_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.parent_id = NEW.id THEN
    RAISE EXCEPTION 'course cannot be its own parent';
  END IF;

  SELECT user_id INTO parent_owner FROM ep_courses WHERE id = NEW.parent_id;
  IF parent_owner IS NULL THEN
    RAISE EXCEPTION 'parent_id % does not exist', NEW.parent_id;
  END IF;
  IF parent_owner <> NEW.user_id THEN
    RAISE EXCEPTION 'parent_id must belong to the same user';
  END IF;

  -- Cycle detection (max depth 20 — far beyond any legitimate hierarchy)
  cursor_id := NEW.parent_id;
  depth := 0;
  WHILE cursor_id IS NOT NULL AND depth < 20 LOOP
    IF cursor_id = NEW.id THEN
      RAISE EXCEPTION 'cycle detected in parent_id chain';
    END IF;
    SELECT parent_id INTO cursor_id FROM ep_courses WHERE id = cursor_id;
    depth := depth + 1;
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_validate_course_parent ON ep_courses;
CREATE TRIGGER trg_validate_course_parent
  BEFORE INSERT OR UPDATE OF parent_id ON ep_courses
  FOR EACH ROW EXECUTE FUNCTION validate_course_parent();

-- ─────────────────────────────────────────────────────────────
-- 3) profiles: prevent client-side escalation of is_admin
--    Users may update their own profile, but NOT the is_admin flag.
-- ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "profiles_self_update" ON profiles;
DROP POLICY IF EXISTS "profiles_update_own" ON profiles;
DROP POLICY IF EXISTS "profiles_update_own_no_admin" ON profiles;

CREATE POLICY "profiles_update_own_no_admin" ON profiles
  FOR UPDATE USING (auth.uid() = id)
  WITH CHECK (
    auth.uid() = id AND
    -- is_admin must remain unchanged from its current stored value
    is_admin IS NOT DISTINCT FROM (SELECT is_admin FROM profiles WHERE id = auth.uid())
  );

-- Also revoke direct UPDATE on is_admin via column-level GRANT (defense in depth).
-- Uncomment if direct GRANTs are used in your project:
-- REVOKE UPDATE (is_admin) ON profiles FROM authenticated;
