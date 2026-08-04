-- ============================================
-- Rollback Migration: Remove Student Networking & Directory Fields
-- Version: 007_rollback
-- Created: 2026-08-03
-- Description: Rolls back migration 007 - removes networking fields from students table
-- WARNING: This will permanently delete data in these columns!
-- ============================================

-- Remove RLS policy
DROP POLICY IF EXISTS "students_directory_read" ON students;

-- Remove indexes
DROP INDEX IF EXISTS idx_students_visibility;
DROP INDEX IF EXISTS idx_students_year;
DROP INDEX IF EXISTS idx_students_skills_gin;
DROP INDEX IF EXISTS idx_students_interests_gin;
DROP INDEX IF EXISTS idx_students_department;
DROP INDEX IF EXISTS idx_students_status_visibility;

-- Remove columns (WARNING: This deletes data!)
ALTER TABLE students 
  DROP COLUMN IF EXISTS twitter,
  DROP COLUMN IF EXISTS instagram,
  DROP COLUMN IF EXISTS portfolio_url,
  DROP COLUMN IF EXISTS interests,
  DROP COLUMN IF EXISTS year_of_study,
  DROP COLUMN IF EXISTS graduation_year,
  DROP COLUMN IF EXISTS visibility,
  DROP COLUMN IF EXISTS privacy_settings;

-- Note: The original RLS policies that existed before should remain intact
-- Only the "students_directory_read" policy added in migration 007 is removed
