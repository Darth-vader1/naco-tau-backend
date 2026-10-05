-- ============================================
-- Migration: Add URL column to academic_resources
-- Date: 2026-08-03
-- Description: Adds the missing 'url' column that admin dashboard requires
-- ============================================

-- Add 'url' column to academic_resources table
ALTER TABLE public.academic_resources 
ADD COLUMN IF NOT EXISTS url TEXT;

-- Add index for performance
CREATE INDEX IF NOT EXISTS idx_academic_resources_url 
ON public.academic_resources(url);

-- Verify the column was added
SELECT column_name, data_type, is_nullable
FROM information_schema.columns 
WHERE table_name = 'academic_resources' 
  AND table_schema = 'public'
  AND column_name = 'url';

-- Success message
DO $$
BEGIN
  RAISE NOTICE '✅ URL column added to academic_resources table';
END $$;
