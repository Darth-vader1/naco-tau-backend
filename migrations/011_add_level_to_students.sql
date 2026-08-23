-- Migration 011: Add level field to students table
-- This adds the academic level (100, 200, 300, 400) to the students table

-- Add level column
ALTER TABLE students 
ADD COLUMN IF NOT EXISTS level INTEGER;

-- Add check constraint to ensure valid levels (100-400)
ALTER TABLE students
ADD CONSTRAINT students_level_check 
CHECK (level IS NULL OR level IN (100, 200, 300, 400));

-- Add comment
COMMENT ON COLUMN students.level IS 'Academic level: 100, 200, 300, or 400';

-- Create index for filtering by level
CREATE INDEX IF NOT EXISTS idx_students_level ON students(level);

-- Migration completed
SELECT 'Migration 011: Added level field to students table' AS status;
