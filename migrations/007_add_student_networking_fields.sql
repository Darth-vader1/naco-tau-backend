-- ============================================
-- Migration: Add Student Networking & Directory Fields
-- Version: 007
-- Created: 2026-08-03
-- Description: Adds social media, interests, privacy controls, and academic info fields to students table
-- ============================================

-- Add new columns to students table
ALTER TABLE students
  ADD COLUMN IF NOT EXISTS twitter TEXT,
  ADD COLUMN IF NOT EXISTS instagram TEXT,
  ADD COLUMN IF NOT EXISTS portfolio_url TEXT,
  ADD COLUMN IF NOT EXISTS interests TEXT[],
  ADD COLUMN IF NOT EXISTS year_of_study INTEGER,
  ADD COLUMN IF NOT EXISTS graduation_year INTEGER,
  ADD COLUMN IF NOT EXISTS visibility TEXT DEFAULT 'students-only' 
    CHECK (visibility IN ('public', 'students-only', 'private')),
  ADD COLUMN IF NOT EXISTS privacy_settings JSONB DEFAULT 
    '{"show_email": false, "show_phone": false, "show_matric": false}'::jsonb;

-- Add comments to new columns for documentation
COMMENT ON COLUMN students.twitter IS 'Twitter/X profile URL';
COMMENT ON COLUMN students.instagram IS 'Instagram profile URL';
COMMENT ON COLUMN students.portfolio_url IS 'Personal website or portfolio URL';
COMMENT ON COLUMN students.interests IS 'Array of student interests (e.g., Web Development, AI/ML)';
COMMENT ON COLUMN students.year_of_study IS 'Current year of study (100, 200, 300, 400, 500)';
COMMENT ON COLUMN students.graduation_year IS 'Expected graduation year';
COMMENT ON COLUMN students.visibility IS 'Profile visibility: public, students-only, or private';
COMMENT ON COLUMN students.privacy_settings IS 'JSONB object for field-level privacy controls';

-- ============================================
-- CREATE INDEXES FOR PERFORMANCE
-- ============================================

-- Index on visibility for filtering directory queries
CREATE INDEX IF NOT EXISTS idx_students_visibility ON students(visibility);

-- Index on year_of_study for filtering by year
CREATE INDEX IF NOT EXISTS idx_students_year ON students(year_of_study);

-- GIN index on skills array for efficient array searches
CREATE INDEX IF NOT EXISTS idx_students_skills_gin ON students USING GIN(skills);

-- GIN index on interests array for efficient array searches
CREATE INDEX IF NOT EXISTS idx_students_interests_gin ON students USING GIN(interests);

-- Index on department for filtering (if not already exists)
CREATE INDEX IF NOT EXISTS idx_students_department ON students(department);

-- Composite index for common directory queries (status + visibility)
CREATE INDEX IF NOT EXISTS idx_students_status_visibility ON students(status, visibility);

-- ============================================
-- UPDATE ROW LEVEL SECURITY (RLS) POLICIES
-- ============================================

-- Drop existing policy if it exists (to avoid conflicts)
DROP POLICY IF EXISTS "students_directory_read" ON students;

-- Create new policy: Allow authenticated students to view other active students' profiles
-- based on visibility settings
CREATE POLICY "students_directory_read" ON students
  FOR SELECT
  TO authenticated
  USING (
    -- Allow viewing if:
    -- 1. Student is viewing their own profile (always allowed)
    auth.uid() = user_id
    OR
    -- 2. Student is active AND visibility is not private
    (status = 'active' AND visibility IN ('students-only', 'public'))
  );

-- Note: Admin access is handled separately via service role key bypass of RLS

-- ============================================
-- DATA MIGRATION (Set defaults for existing records)
-- ============================================

-- Set default visibility for existing students (if NULL)
UPDATE students 
SET visibility = 'students-only' 
WHERE visibility IS NULL;

-- Set default privacy_settings for existing students (if NULL)
UPDATE students 
SET privacy_settings = '{"show_email": false, "show_phone": false, "show_matric": false}'::jsonb 
WHERE privacy_settings IS NULL;

-- ============================================
-- VERIFICATION QUERIES (for testing)
-- ============================================

-- Verify new columns were added
-- SELECT column_name, data_type, is_nullable 
-- FROM information_schema.columns 
-- WHERE table_name = 'students' 
-- AND column_name IN ('twitter', 'instagram', 'portfolio_url', 'interests', 'year_of_study', 'graduation_year', 'visibility', 'privacy_settings');

-- Verify indexes were created
-- SELECT indexname, indexdef 
-- FROM pg_indexes 
-- WHERE tablename = 'students' 
-- AND indexname LIKE 'idx_students_%';

-- Verify RLS policy was created
-- SELECT policyname, permissive, roles, qual 
-- FROM pg_policies 
-- WHERE tablename = 'students' 
-- AND policyname = 'students_directory_read';

-- ============================================
-- ROLLBACK INSTRUCTIONS
-- ============================================
-- To rollback this migration, run:
-- 
-- DROP POLICY IF EXISTS "students_directory_read" ON students;
-- DROP INDEX IF EXISTS idx_students_visibility;
-- DROP INDEX IF EXISTS idx_students_year;
-- DROP INDEX IF EXISTS idx_students_skills_gin;
-- DROP INDEX IF EXISTS idx_students_interests_gin;
-- DROP INDEX IF EXISTS idx_students_department;
-- DROP INDEX IF EXISTS idx_students_status_visibility;
-- ALTER TABLE students 
--   DROP COLUMN IF EXISTS twitter,
--   DROP COLUMN IF EXISTS instagram,
--   DROP COLUMN IF EXISTS portfolio_url,
--   DROP COLUMN IF EXISTS interests,
--   DROP COLUMN IF EXISTS year_of_study,
--   DROP COLUMN IF EXISTS graduation_year,
--   DROP COLUMN IF EXISTS visibility,
--   DROP COLUMN IF EXISTS privacy_settings;
