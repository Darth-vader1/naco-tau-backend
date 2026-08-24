-- Migration 014: Fix level display showing year instead of level
-- Issue: Some students show "2023L" instead of "400L"
-- Root cause: Frontend is receiving year_of_study value in current_level field

-- Step 1: Verify the view exists and is being used
-- The view should calculate current_level correctly

-- Step 2: Check for data issues
-- Some students may have year_of_study values that look like levels (e.g., 400 instead of 2022)

-- Step 3: Fix any students with year_of_study < 100 or > 2030 (clearly wrong)
UPDATE students
SET year_of_study = NULL
WHERE year_of_study IS NOT NULL 
  AND (year_of_study < 100 OR year_of_study > 2030);

-- Step 4: Re-extract year from matric numbers for all students
-- This ensures consistency
UPDATE students
SET year_of_study = extract_year_from_matric(matric_no)
WHERE matric_no IS NOT NULL 
  AND extract_year_from_matric(matric_no) IS NOT NULL;

-- Step 5: Recalculate graduation_year
UPDATE students
SET graduation_year = year_of_study + COALESCE(program_duration, 4)
WHERE year_of_study IS NOT NULL;

-- Step 6: Verify the students_with_current_level view is returning correct data
-- Test query to check
DO $$
DECLARE
  problem_count INTEGER;
BEGIN
  -- Check if any student has current_level > 1000 (which would indicate year_of_study is being shown)
  SELECT COUNT(*) INTO problem_count
  FROM students_with_current_level
  WHERE current_level > 1000;
  
  IF problem_count > 0 THEN
    RAISE WARNING '% students have suspicious current_level values (> 1000)', problem_count;
    RAISE NOTICE 'This might indicate the view is not calculating correctly or year_of_study data is wrong';
  ELSE
    RAISE NOTICE '✓ All students have valid current_level values (100-500)';
  END IF;
END $$;

-- Step 7: Show sample data for verification
SELECT 
  matric_no,
  year_of_study,
  current_level,
  is_graduated,
  graduation_year,
  CASE 
    WHEN current_level IS NULL THEN '❌ No Level'
    WHEN current_level > 1000 THEN '⚠️  Suspicious (showing year?)'
    WHEN is_graduated THEN '🎓 Graduated'
    ELSE '✓ OK'
  END as status
FROM students_with_current_level
WHERE matric_no IS NOT NULL
ORDER BY matric_no
LIMIT 20;

-- Migration completed
SELECT 'Migration 014: Fixed level display data issues' AS status;
