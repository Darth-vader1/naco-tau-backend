-- ============================================
-- Migration: Fix academic_resources Schema Mismatch
-- Date: 2026-08-03
-- Description: Adds missing columns to academic_resources table
-- ============================================

-- Add missing columns to academic_resources table
-- The admin dashboard code expects these columns but they're missing

DO $$ 
BEGIN
    -- Add 'category' column if it doesn't exist
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_schema = 'public' 
          AND table_name = 'academic_resources' 
          AND column_name = 'category'
    ) THEN
        ALTER TABLE public.academic_resources 
        ADD COLUMN category TEXT;
        
        RAISE NOTICE 'Added category column to academic_resources';
    ELSE
        RAISE NOTICE 'academic_resources.category already exists';
    END IF;
    
    -- Add 'url' column if it doesn't exist
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_schema = 'public' 
          AND table_name = 'academic_resources' 
          AND column_name = 'url'
    ) THEN
        ALTER TABLE public.academic_resources 
        ADD COLUMN url TEXT;
        
        RAISE NOTICE 'Added url column to academic_resources';
    ELSE
        RAISE NOTICE 'academic_resources.url already exists';
    END IF;
    
    -- Ensure 'uploaded_by' references admin_users (not students)
    -- Drop existing constraint if it references students
    IF EXISTS (
        SELECT 1
        FROM information_schema.table_constraints tc
        JOIN information_schema.constraint_column_usage ccu 
          ON tc.constraint_name = ccu.constraint_name
        WHERE tc.table_name = 'academic_resources'
          AND tc.constraint_type = 'FOREIGN KEY'
          AND ccu.column_name = 'uploaded_by'
          AND ccu.table_name = 'students'
    ) THEN
        -- Find the constraint name
        DECLARE
            constraint_name TEXT;
        BEGIN
            SELECT tc.constraint_name INTO constraint_name
            FROM information_schema.table_constraints tc
            JOIN information_schema.constraint_column_usage ccu 
              ON tc.constraint_name = ccu.constraint_name
            WHERE tc.table_name = 'academic_resources'
              AND tc.constraint_type = 'FOREIGN KEY'
              AND ccu.column_name = 'uploaded_by'
              AND ccu.table_name = 'students'
            LIMIT 1;
            
            IF constraint_name IS NOT NULL THEN
                EXECUTE format('ALTER TABLE public.academic_resources DROP CONSTRAINT %I', constraint_name);
                RAISE NOTICE 'Dropped old uploaded_by constraint referencing students';
            END IF;
        END;
    END IF;
    
    -- Add new constraint if uploaded_by doesn't reference admin_users
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.table_constraints tc
        JOIN information_schema.constraint_column_usage ccu 
          ON tc.constraint_name = ccu.constraint_name
        WHERE tc.table_name = 'academic_resources'
          AND tc.constraint_type = 'FOREIGN KEY'
          AND ccu.column_name = 'uploaded_by'
          AND ccu.table_name = 'admin_users'
    ) THEN
        ALTER TABLE public.academic_resources
        ADD CONSTRAINT fk_academic_resources_uploaded_by
        FOREIGN KEY (uploaded_by) REFERENCES public.admin_users(id) ON DELETE SET NULL;
        
        RAISE NOTICE 'Added uploaded_by foreign key to admin_users';
    ELSE
        RAISE NOTICE 'uploaded_by already references admin_users';
    END IF;
END $$;

-- Add indexes for performance
CREATE INDEX IF NOT EXISTS idx_academic_resources_category 
ON public.academic_resources(category);

CREATE INDEX IF NOT EXISTS idx_academic_resources_url 
ON public.academic_resources(url);

-- ============================================
-- VERIFICATION
-- ============================================
-- Check that all required columns exist
SELECT column_name, data_type, is_nullable
FROM information_schema.columns 
WHERE table_name = 'academic_resources' 
  AND table_schema = 'public'
ORDER BY ordinal_position;

RAISE NOTICE 'Academic resources schema migration completed!';
