-- Migration 008: Add Snapchat field to students table
-- Created: 2026-08-03
-- Purpose: Add snapchat username field for student networking

-- Add snapchat column
ALTER TABLE students
  ADD COLUMN IF NOT EXISTS snapchat TEXT;

-- Add comment
COMMENT ON COLUMN students.snapchat IS 'Snapchat username (not URL, just username)';

-- No index needed for snapchat as it won't be searched/filtered
