-- Migration 012: Replace static level with year_of_study and graduation_year
-- This allows dynamic level calculation and better data management

-- Add year_of_study (year they started) - extract from matric number or manual entry
ALTER TABLE students 
ADD COLUMN IF NOT EXISTS year_of_study INTEGER;

-- Add graduation_year (expected graduation year)
ALTER TABLE students
ADD COLUMN IF NOT EXISTS graduation_year INTEGER;

-- Add program_duration (default 4 years for undergraduate)
ALTER TABLE students
ADD COLUMN IF NOT EXISTS program_duration INTEGER DEFAULT 4;

-- Add comments
COMMENT ON COLUMN students.year_of_study IS 'Year student started (e.g., 2022)';
COMMENT ON COLUMN students.graduation_year IS 'Expected graduation year (e.g., 2026)';
COMMENT ON COLUMN students.program_duration IS 'Program length in years (default: 4)';

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_students_year_of_study ON students(year_of_study);
CREATE INDEX IF NOT EXISTS idx_students_graduation_year ON students(graduation_year);

-- Helper function to extract year from matric number
-- Format examples: 22/10MSC014, TAU/CS/23/014, TAU/MSC/2023/0014
CREATE OR REPLACE FUNCTION extract_year_from_matric(matric_no TEXT)
RETURNS INTEGER AS $$
DECLARE
  year_str TEXT;
  extracted_year INTEGER;
BEGIN
  -- Try format: 22/10MSC014 or 23/10MSC014
  IF matric_no ~ '^\d{2}/' THEN
    year_str := substring(matric_no from '^\d{2}');
    extracted_year := 2000 + year_str::INTEGER;
    RETURN extracted_year;
  END IF;
  
  -- Try format: TAU/CS/23/014
  IF matric_no ~ 'TAU/[A-Z]+/\d{2}/' THEN
    year_str := substring(matric_no from 'TAU/[A-Z]+/(\d{2})/')::TEXT;
    extracted_year := 2000 + year_str::INTEGER;
    RETURN extracted_year;
  END IF;
  
  -- Try format: TAU/MSC/2023/0014
  IF matric_no ~ 'TAU/[A-Z]+/\d{4}/' THEN
    year_str := substring(matric_no from 'TAU/[A-Z]+/(\d{4})/')::TEXT;
    RETURN year_str::INTEGER;
  END IF;
  
  RETURN NULL;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Populate year_of_study from matric numbers for existing students
UPDATE students
SET year_of_study = extract_year_from_matric(matric_no)
WHERE year_of_study IS NULL AND matric_no IS NOT NULL;

-- Calculate graduation_year (year_of_study + program_duration)
UPDATE students
SET graduation_year = year_of_study + program_duration
WHERE graduation_year IS NULL AND year_of_study IS NOT NULL;

-- Create view for current level calculation
CREATE OR REPLACE VIEW students_with_current_level AS
SELECT 
  s.*,
  CASE 
    -- Calculate current level based on years elapsed since start
    WHEN year_of_study IS NULL THEN NULL
    WHEN (EXTRACT(YEAR FROM CURRENT_DATE)::INTEGER - year_of_study + 1) <= 0 THEN NULL
    WHEN (EXTRACT(YEAR FROM CURRENT_DATE)::INTEGER - year_of_study + 1) > program_duration THEN 
      -- Graduated
      CASE 
        WHEN program_duration = 4 THEN 400
        WHEN program_duration = 5 THEN 500
        WHEN program_duration = 2 THEN 200
        ELSE program_duration * 100
      END
    ELSE 
      -- Current level (100, 200, 300, 400)
      (EXTRACT(YEAR FROM CURRENT_DATE)::INTEGER - year_of_study + 1) * 100
  END AS current_level,
  -- Add graduated flag
  CASE 
    WHEN graduation_year IS NOT NULL AND EXTRACT(YEAR FROM CURRENT_DATE) >= graduation_year 
    THEN TRUE 
    ELSE FALSE 
  END AS is_graduated
FROM students;

-- Grant access to view
GRANT SELECT ON students_with_current_level TO authenticated;
GRANT SELECT ON students_with_current_level TO anon;

-- Migration completed
SELECT 'Migration 012: Added year_of_study and graduation_year for dynamic level calculation' AS status;

-- Usage example:
-- SELECT first_name, last_name, year_of_study, current_level, is_graduated 
-- FROM students_with_current_level 
-- WHERE status = 'active';
