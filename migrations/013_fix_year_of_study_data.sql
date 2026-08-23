-- Migration 013: Fix year_of_study data issues
-- Some students have incorrect year_of_study values (e.g., 400 instead of 2022)
-- This migration re-extracts and corrects the data

-- First, let's improve the extraction function to handle edge cases
CREATE OR REPLACE FUNCTION extract_year_from_matric(matric_no TEXT)
RETURNS INTEGER AS $$
DECLARE
  year_str TEXT;
  extracted_year INTEGER;
BEGIN
  -- Return NULL if matric_no is NULL or empty
  IF matric_no IS NULL OR LENGTH(TRIM(matric_no)) = 0 THEN
    RETURN NULL;
  END IF;
  
  -- Try format: 22/10MSC014 or 23/10MSC014 (YY/...)
  IF matric_no ~ '^\d{2}/' THEN
    year_str := substring(matric_no from '^\d{2}');
    extracted_year := 2000 + year_str::INTEGER;
    RETURN extracted_year;
  END IF;
  
  -- Try format: TAU/CS/23/014 (TAU/DEPT/YY/...)
  IF matric_no ~ 'TAU/[A-Z]+/\d{2}/' THEN
    year_str := substring(matric_no from 'TAU/[A-Z]+/(\d{2})');
    extracted_year := 2000 + year_str::INTEGER;
    RETURN extracted_year;
  END IF;
  
  -- Try format: TAU/MSC/2023/0014 (TAU/DEPT/YYYY/...)
  IF matric_no ~ 'TAU/[A-Z]+/\d{4}/' THEN
    year_str := substring(matric_no from 'TAU/[A-Z]+/(\d{4})');
    RETURN year_str::INTEGER;
  END IF;
  
  RETURN NULL;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Re-populate year_of_study from matric numbers for ALL students
-- This will fix students with incorrect values like 400
UPDATE students
SET year_of_study = extract_year_from_matric(matric_no)
WHERE matric_no IS NOT NULL;

-- Recalculate graduation_year based on corrected year_of_study
UPDATE students
SET graduation_year = year_of_study + program_duration
WHERE year_of_study IS NOT NULL;

-- Verify the fixes
DO $$
DECLARE
  fixed_count INTEGER;
  total_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO total_count FROM students WHERE matric_no IS NOT NULL;
  SELECT COUNT(*) INTO fixed_count FROM students WHERE year_of_study IS NOT NULL;
  
  RAISE NOTICE 'Migration 013 Results:';
  RAISE NOTICE '  Total students with matric numbers: %', total_count;
  RAISE NOTICE '  Students with year_of_study set: %', fixed_count;
  
  IF fixed_count < total_count THEN
    RAISE WARNING '  % students could not extract year from matric_no', (total_count - fixed_count);
    RAISE NOTICE '  Check matric number formats for these students';
  END IF;
END $$;

-- Show sample results for verification
SELECT 
  matric_no,
  year_of_study,
  graduation_year,
  program_duration,
  CASE 
    WHEN year_of_study IS NULL THEN 'FAILED'
    WHEN year_of_study < 2000 OR year_of_study > 2030 THEN 'INVALID'
    ELSE 'OK'
  END as status
FROM students
WHERE matric_no IS NOT NULL
ORDER BY matric_no
LIMIT 10;

-- Migration completed
SELECT 'Migration 013: Fixed year_of_study data extraction' AS status;
