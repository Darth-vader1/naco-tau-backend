-- Migration: Fix double-encoded skills and interests
-- Purpose: Decode HTML entities (&#x2F;, &amp;, etc.) back to normal characters
-- Run once to clean up existing data

-- Check affected rows
SELECT 
  id,
  name,
  email,
  skills,
  interests
FROM students
WHERE 
  (skills IS NOT NULL AND array_to_string(skills, '') LIKE '%&#%')
  OR
  (interests IS NOT NULL AND array_to_string(interests, '') LIKE '%&#%');

-- Decode HTML entities in skills
UPDATE students
SET skills = ARRAY(
  SELECT 
    -- Decode common HTML entities
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            regexp_replace(
              unnest(skills),
              '&#x2F;', '/', 'g'  -- Forward slash
            ),
            '&amp;', '&', 'g'  -- Ampersand
          ),
          '&lt;', '<', 'g'  -- Less than
        ),
        '&gt;', '>', 'g'  -- Greater than
      ),
      '&quot;', '"', 'g'  -- Quote
    )
  FROM unnest(skills)
)
WHERE skills IS NOT NULL
  AND array_to_string(skills, '') LIKE '%&#%';

-- Decode HTML entities in interests
UPDATE students
SET interests = ARRAY(
  SELECT 
    -- Decode common HTML entities
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            regexp_replace(
              unnest(interests),
              '&#x2F;', '/', 'g'  -- Forward slash
            ),
            '&amp;', '&', 'g'  -- Ampersand
          ),
          '&lt;', '<', 'g'  -- Less than
        ),
        '&gt;', '>', 'g'  -- Greater than
      ),
      '&quot;', '"', 'g'  -- Quote
    )
  FROM unnest(interests)
)
WHERE interests IS NOT NULL
  AND array_to_string(interests, '') LIKE '%&#%';

-- Verify fix
SELECT 
  id,
  name,
  email,
  skills,
  interests,
  CASE 
    WHEN array_to_string(skills, '') LIKE '%&#%' THEN 'Still encoded'
    WHEN array_to_string(interests, '') LIKE '%&#%' THEN 'Still encoded'
    ELSE 'Fixed'
  END as status
FROM students
WHERE skills IS NOT NULL OR interests IS NOT NULL
ORDER BY status DESC, name ASC
LIMIT 20;

-- Output summary
SELECT 
  COUNT(*) as total_students,
  COUNT(CASE WHEN skills IS NOT NULL THEN 1 END) as with_skills,
  COUNT(CASE WHEN interests IS NOT NULL THEN 1 END) as with_interests,
  COUNT(CASE WHEN array_to_string(skills, '') LIKE '%&#%' OR array_to_string(interests, '') LIKE '%&#%' THEN 1 END) as still_encoded
FROM students;
