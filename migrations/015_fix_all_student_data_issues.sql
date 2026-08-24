-- Migration 015: Fix all student data issues
-- Fixes identified by diagnostic script and manual review

-- ==============================================================================
-- ISSUE 1: Gbolahan's wrong matric number (22 → 23)
-- ==============================================================================
UPDATE students
SET matric_no = '23/10MSC014',
    year_of_study = 2023,
    graduation_year = 2027,
    program_duration = 4
WHERE email = 'gbolahan@st.tau.edu.ng'
   OR matric_no = '22/10MSC014';

RAISE NOTICE '✓ Fixed Gbolahan matric number: 22/10MSC014 → 23/10MSC014';

-- ==============================================================================
-- ISSUE 2: Students with level values (400) instead of years in year_of_study
-- ==============================================================================

-- These students have 400 in year_of_study when it should be the enrollment year
UPDATE students
SET year_of_study = 2023,
    graduation_year = 2027,
    program_duration = 4
WHERE year_of_study = 400
  AND matric_no LIKE '23/%';

UPDATE students
SET year_of_study = 2022,
    graduation_year = 2026,
    program_duration = 4
WHERE year_of_study = 400
  AND matric_no LIKE '22/%';

RAISE NOTICE '✓ Fixed students with level values (400) in year_of_study';

-- ==============================================================================
-- ISSUE 3: Students with NULL year_of_study
-- ==============================================================================

-- Praise Ajetomobi (23/10MSC015)
UPDATE students
SET year_of_study = 2023,
    graduation_year = 2027,
    program_duration = 4
WHERE matric_no = '23/10MSC015'
  AND year_of_study IS NULL;

-- Onitomiwa Jayden Adebiyi (23/10MSS043)
UPDATE students
SET year_of_study = 2023,
    graduation_year = 2027,
    program_duration = 4
WHERE matric_no = '23/10MSS043'
  AND year_of_study IS NULL;

RAISE NOTICE '✓ Fixed students with NULL year_of_study';

-- ==============================================================================
-- ISSUE 4: Re-extract year_of_study for all students to ensure consistency
-- ==============================================================================
UPDATE students
SET year_of_study = extract_year_from_matric(matric_no)
WHERE matric_no IS NOT NULL
  AND extract_year_from_matric(matric_no) IS NOT NULL
  AND extract_year_from_matric(matric_no) != year_of_study;

-- Recalculate graduation_year for all students
UPDATE students
SET graduation_year = year_of_study + COALESCE(program_duration, 4)
WHERE year_of_study IS NOT NULL;

RAISE NOTICE '✓ Re-validated all year_of_study values from matric numbers';

-- ==============================================================================
-- VERIFICATION
-- ==============================================================================

-- Check for any remaining issues
DO $$
DECLARE
  issue_count INTEGER;
BEGIN
  -- Check for year_of_study values that look like levels (100-500)
  SELECT COUNT(*) INTO issue_count
  FROM students
  WHERE year_of_study >= 100 AND year_of_study <= 500;
  
  IF issue_count > 0 THEN
    RAISE WARNING '⚠️  Still have % students with suspicious year_of_study values (100-500)', issue_count;
  ELSE
    RAISE NOTICE '✓ No students with level values in year_of_study';
  END IF;
  
  -- Check for NULL year_of_study with valid matric numbers
  SELECT COUNT(*) INTO issue_count
  FROM students
  WHERE matric_no IS NOT NULL
    AND year_of_study IS NULL;
  
  IF issue_count > 0 THEN
    RAISE WARNING '⚠️  Still have % students with NULL year_of_study', issue_count;
  ELSE
    RAISE NOTICE '✓ All students with matric numbers have year_of_study set';
  END IF;
  
  -- Check for current_level > 1000 (indicates data issue)
  SELECT COUNT(*) INTO issue_count
  FROM students_with_current_level
  WHERE current_level > 1000;
  
  IF issue_count > 0 THEN
    RAISE WARNING '⚠️  Still have % students with suspicious current_level values', issue_count;
  ELSE
    RAISE NOTICE '✓ All students have valid current_level values (100-500)';
  END IF;
END $$;

-- ==============================================================================
-- SHOW RESULTS
-- ==============================================================================

-- Show all students with their corrected data
SELECT 
  first_name || ' ' || last_name as name,
  matric_no,
  year_of_study,
  current_level,
  is_graduated,
  graduation_year,
  CASE 
    WHEN is_graduated THEN current_level || ' Level 🎓'
    WHEN current_level IS NULL THEN 'Not Set'
    ELSE current_level || ' Level'
  END as display,
  CASE 
    WHEN year_of_study IS NULL THEN '❌ Missing year_of_study'
    WHEN year_of_study >= 100 AND year_of_study <= 500 THEN '⚠️  Suspicious (level not year)'
    WHEN current_level IS NULL THEN '⚠️  No level calculated'
    WHEN current_level > 1000 THEN '⚠️  Invalid level'
    ELSE '✓ OK'
  END as status
FROM students_with_current_level
WHERE matric_no IS NOT NULL
ORDER BY matric_no;

-- Migration completed
SELECT 'Migration 015: Fixed all student data issues' AS status;
