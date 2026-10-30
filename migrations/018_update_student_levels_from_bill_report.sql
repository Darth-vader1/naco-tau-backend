-- ==============================================================================
-- Migration 018: Update student academic levels based on Bill Report
-- Date: 2026-10-30
-- Description:
--   Updates the academic level of specified students to match the official Bill Report.
--   By updating year_of_study and graduation_year, the database view 
--   students_with_current_level automatically computes the exact levels
--   (400, 300, 200) without modifying view schemas or encountering 42P16 errors.
-- ==============================================================================

-- Step 1: Update year_of_study and graduation_year on the students table
-- Mapping for 2026 academic calendar:
-- 400 Level -> year_of_study = 2023, graduation_year = 2027
-- 300 Level -> year_of_study = 2024, graduation_year = 2028
-- 200 Level -> year_of_study = 2025, graduation_year = 2029

UPDATE students
SET 
  year_of_study = v.target_year_of_study,
  graduation_year = v.target_grad_year
FROM (
  VALUES
    ('24/10MSC021', 2023, 2027), -- ANIFOWOSHE Khadijah Oluwatosin (400 Level)
    ('24/10MSC034', 2025, 2029), -- IDRIS Tolamise Promise (200 Level)
    ('24/10MSC076', 2023, 2027), -- AWOSURU Michael Ayodeji (400 Level)
    ('25/10MSC132', 2024, 2028), -- MURITALA Fawas Ayomide (300 Level)
    ('25/10MSS108', 2024, 2028), -- ADEYEYE Oluwafemi John (300 Level)
    ('25/10MSC134', 2024, 2028), -- ODEYINKA Khalid Olalekan (300 Level)
    ('25/10MSC131', 2024, 2028), -- TIRIMISIYU Abass Ojo (300 Level)
    ('25/10MSCS059', 2024, 2028), -- Ayoola Micheal Temileyin (300 Level)
    ('25/10MSC145', 2024, 2028), -- ESSIEN Idara Edem (300 Level)
    ('26/10MSC154', 2025, 2029)  -- AJETUNMOBI Plenty Momooreoluwa (200 Level)
) AS v(matric_no, target_year_of_study, target_grad_year)
WHERE UPPER(TRIM(students.matric_no)) = UPPER(TRIM(v.matric_no));

-- Step 2: If the 'level' column exists on the students table, update it
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'students' AND column_name = 'level'
  ) THEN
    UPDATE students
    SET level = CASE 
      WHEN UPPER(TRIM(matric_no)) = '24/10MSC021' THEN 400
      WHEN UPPER(TRIM(matric_no)) = '24/10MSC034' THEN 200
      WHEN UPPER(TRIM(matric_no)) = '24/10MSC076' THEN 400
      WHEN UPPER(TRIM(matric_no)) = '25/10MSC132' THEN 300
      WHEN UPPER(TRIM(matric_no)) = '25/10MSS108' THEN 300
      WHEN UPPER(TRIM(matric_no)) = '25/10MSC134' THEN 300
      WHEN UPPER(TRIM(matric_no)) = '25/10MSC131' THEN 300
      WHEN UPPER(TRIM(matric_no)) = '25/10MSCS059' THEN 300
      WHEN UPPER(TRIM(matric_no)) = '25/10MSC145' THEN 300
      WHEN UPPER(TRIM(matric_no)) = '26/10MSC154' THEN 200
    END
    WHERE UPPER(TRIM(matric_no)) IN (
      '24/10MSC021', '24/10MSC034', '24/10MSC076', '25/10MSC132', '25/10MSS108',
      '25/10MSC134', '25/10MSC131', '25/10MSCS059', '25/10MSC145', '26/10MSC154'
    );
  END IF;
END $$;

-- Step 3: If the 'current_level' column exists on the students table, update it
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'students' AND column_name = 'current_level'
  ) THEN
    UPDATE students
    SET current_level = CASE 
      WHEN UPPER(TRIM(matric_no)) = '24/10MSC021' THEN 400
      WHEN UPPER(TRIM(matric_no)) = '24/10MSC034' THEN 200
      WHEN UPPER(TRIM(matric_no)) = '24/10MSC076' THEN 400
      WHEN UPPER(TRIM(matric_no)) = '25/10MSC132' THEN 300
      WHEN UPPER(TRIM(matric_no)) = '25/10MSS108' THEN 300
      WHEN UPPER(TRIM(matric_no)) = '25/10MSC134' THEN 300
      WHEN UPPER(TRIM(matric_no)) = '25/10MSC131' THEN 300
      WHEN UPPER(TRIM(matric_no)) = '25/10MSCS059' THEN 300
      WHEN UPPER(TRIM(matric_no)) = '25/10MSC145' THEN 300
      WHEN UPPER(TRIM(matric_no)) = '26/10MSC154' THEN 200
    END
    WHERE UPPER(TRIM(matric_no)) IN (
      '24/10MSC021', '24/10MSC034', '24/10MSC076', '25/10MSC132', '25/10MSS108',
      '25/10MSC134', '25/10MSC131', '25/10MSCS059', '25/10MSC145', '26/10MSC154'
    );
  END IF;
END $$;

-- Step 4: Verification query
-- Query the students_with_current_level view to confirm the updated levels
SELECT 
  first_name || ' ' || last_name AS student_name,
  matric_no,
  year_of_study,
  current_level,
  current_level || ' Level' AS directory_display,
  is_graduated
FROM students_with_current_level
WHERE UPPER(TRIM(matric_no)) IN (
  '24/10MSC021',
  '24/10MSC034',
  '24/10MSC076',
  '25/10MSC132',
  '25/10MSS108',
  '25/10MSC134',
  '25/10MSC131',
  '25/10MSCS059',
  '25/10MSC145',
  '26/10MSC154'
)
ORDER BY current_level DESC, matric_no ASC;
