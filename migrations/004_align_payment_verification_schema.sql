-- ============================================
-- Migration: Align payment_verification Schema
-- Date: 2026-07-27
-- Description: Your existing payment_verification table has a different structure
--              than what the admin dashboard expects. This migration adds the
--              missing columns and creates aliases so both structures work.
-- ============================================

-- ============================================
-- ANALYSIS OF YOUR CURRENT SCHEMA
-- ============================================
-- Your current payment_verification has:
--   - user_id (but code expects student_id)
--   - payment_proof_url (but code expects proof_url)
--   - submitted_at (but code expects created_at)
--   - updated_at (exists but code doesn't use it)
--   - Extra columns: payment_type, transaction_id, verified_by, verified_at, notes

-- ============================================
-- OPTION 1: Add Missing Columns (Recommended)
-- ============================================
-- This keeps your existing data and adds what the code needs

DO $$ 
BEGIN
    -- Add student_id as an alias/copy of user_id
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_schema = 'public' 
          AND table_name = 'payment_verification' 
          AND column_name = 'student_id'
    ) THEN
        -- Add student_id column
        ALTER TABLE public.payment_verification 
        ADD COLUMN student_id UUID REFERENCES public.students(id) ON DELETE CASCADE;
        
        -- Copy existing user_id values to student_id if they match
        -- (assuming user_id references students.user_id, we need students.id)
        UPDATE public.payment_verification pv
        SET student_id = s.id
        FROM public.students s
        WHERE pv.user_id = s.user_id AND pv.student_id IS NULL;
        
        RAISE NOTICE 'Added student_id column to payment_verification';
    ELSE
        RAISE NOTICE 'payment_verification.student_id already exists';
    END IF;
    
    -- Add created_at column (copy from submitted_at if exists)
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_schema = 'public' 
          AND table_name = 'payment_verification' 
          AND column_name = 'created_at'
    ) THEN
        ALTER TABLE public.payment_verification 
        ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
        
        -- Copy submitted_at values to created_at for existing rows
        UPDATE public.payment_verification 
        SET created_at = submitted_at 
        WHERE submitted_at IS NOT NULL AND created_at IS NULL;
        
        RAISE NOTICE 'Added created_at column to payment_verification';
    ELSE
        RAISE NOTICE 'payment_verification.created_at already exists';
    END IF;
    
    -- Add payment_reference as an alias/copy of transaction_id
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_schema = 'public' 
          AND table_name = 'payment_verification' 
          AND column_name = 'payment_reference'
    ) THEN
        ALTER TABLE public.payment_verification 
        ADD COLUMN payment_reference TEXT;
        
        -- Copy transaction_id to payment_reference
        UPDATE public.payment_verification 
        SET payment_reference = transaction_id 
        WHERE transaction_id IS NOT NULL AND payment_reference IS NULL;
        
        RAISE NOTICE 'Added payment_reference column to payment_verification';
    ELSE
        RAISE NOTICE 'payment_verification.payment_reference already exists';
    END IF;
    
    -- Add proof_url as an alias/copy of payment_proof_url
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_schema = 'public' 
          AND table_name = 'payment_verification' 
          AND column_name = 'proof_url'
    ) THEN
        ALTER TABLE public.payment_verification 
        ADD COLUMN proof_url TEXT;
        
        -- Copy payment_proof_url to proof_url
        UPDATE public.payment_verification 
        SET proof_url = payment_proof_url 
        WHERE payment_proof_url IS NOT NULL AND proof_url IS NULL;
        
        RAISE NOTICE 'Added proof_url column to payment_verification';
    ELSE
        RAISE NOTICE 'payment_verification.proof_url already exists';
    END IF;
END $$;

-- ============================================
-- OPTION 2: Create Triggers to Keep Columns Synced
-- ============================================
-- This ensures that when old columns are updated, new columns stay in sync

-- Trigger function to sync columns
CREATE OR REPLACE FUNCTION sync_payment_verification_columns()
RETURNS TRIGGER AS $$
BEGIN
    -- Sync user_id → student_id
    IF NEW.user_id IS NOT NULL AND (NEW.student_id IS NULL OR OLD.user_id != NEW.user_id) THEN
        SELECT id INTO NEW.student_id 
        FROM public.students 
        WHERE user_id = NEW.user_id 
        LIMIT 1;
    END IF;
    
    -- Sync student_id → user_id (reverse direction)
    IF NEW.student_id IS NOT NULL AND (NEW.user_id IS NULL OR OLD.student_id != NEW.student_id) THEN
        SELECT user_id INTO NEW.user_id 
        FROM public.students 
        WHERE id = NEW.student_id 
        LIMIT 1;
    END IF;
    
    -- Sync transaction_id → payment_reference
    IF NEW.transaction_id IS NOT NULL THEN
        NEW.payment_reference := NEW.transaction_id;
    END IF;
    
    -- Sync payment_reference → transaction_id (reverse)
    IF NEW.payment_reference IS NOT NULL AND NEW.transaction_id IS NULL THEN
        NEW.transaction_id := NEW.payment_reference;
    END IF;
    
    -- Sync payment_proof_url → proof_url
    IF NEW.payment_proof_url IS NOT NULL THEN
        NEW.proof_url := NEW.payment_proof_url;
    END IF;
    
    -- Sync proof_url → payment_proof_url (reverse)
    IF NEW.proof_url IS NOT NULL AND NEW.payment_proof_url IS NULL THEN
        NEW.payment_proof_url := NEW.proof_url;
    END IF;
    
    -- Sync submitted_at → created_at
    IF NEW.submitted_at IS NOT NULL AND NEW.created_at IS NULL THEN
        NEW.created_at := NEW.submitted_at;
    END IF;
    
    -- Sync created_at → submitted_at (reverse)
    IF NEW.created_at IS NOT NULL AND NEW.submitted_at IS NULL THEN
        NEW.submitted_at := NEW.created_at;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop existing trigger if it exists
DROP TRIGGER IF EXISTS sync_payment_verification_trigger ON public.payment_verification;

-- Create trigger
CREATE TRIGGER sync_payment_verification_trigger
    BEFORE INSERT OR UPDATE ON public.payment_verification
    FOR EACH ROW
    EXECUTE FUNCTION sync_payment_verification_columns();

RAISE NOTICE 'Created sync trigger for payment_verification';

-- ============================================
-- Add Indexes for New Columns
-- ============================================
CREATE INDEX IF NOT EXISTS idx_payment_verification_student_id ON public.payment_verification(student_id);
CREATE INDEX IF NOT EXISTS idx_payment_verification_created_at ON public.payment_verification(created_at DESC);

-- ============================================
-- Update RLS Policies to Work with Both Column Sets
-- ============================================

-- Drop old policies if they exist
DROP POLICY IF EXISTS "payment_verification_select_own" ON public.payment_verification;
DROP POLICY IF EXISTS "payment_verification_insert_own" ON public.payment_verification;

-- Create new policies that work with both user_id and student_id
CREATE POLICY "payment_verification_select_own" 
  ON public.payment_verification 
  FOR SELECT 
  USING (
    user_id = auth.uid() 
    OR student_id IN (SELECT id FROM public.students WHERE user_id = auth.uid())
  );

CREATE POLICY "payment_verification_insert_own" 
  ON public.payment_verification 
  FOR INSERT 
  WITH CHECK (
    user_id = auth.uid() 
    OR student_id IN (SELECT id FROM public.students WHERE user_id = auth.uid())
  );

-- ============================================
-- VERIFICATION QUERIES
-- ============================================

-- Check all columns now exist
-- SELECT column_name, data_type, is_nullable
-- FROM information_schema.columns 
-- WHERE table_name = 'payment_verification' 
--   AND table_schema = 'public'
-- ORDER BY ordinal_position;

-- Test that the query the admin dashboard uses now works
-- SELECT id, student_id, event_id, amount, payment_reference, proof_url, status, created_at
-- FROM public.payment_verification
-- ORDER BY created_at DESC
-- LIMIT 5;

-- Verify trigger is working (insert a test row and check both column sets are populated)
-- INSERT INTO public.payment_verification (user_id, event_id, amount, payment_proof_url, submitted_at)
-- VALUES (
--   (SELECT user_id FROM public.students LIMIT 1),
--   (SELECT id FROM public.events LIMIT 1),
--   100.00,
--   'https://example.com/proof.jpg',
--   NOW()
-- );
-- SELECT student_id, proof_url, payment_reference, created_at FROM public.payment_verification ORDER BY created_at DESC LIMIT 1;

RAISE NOTICE 'Payment verification schema alignment completed!';
RAISE NOTICE 'Both old columns (user_id, payment_proof_url, etc.) and new columns (student_id, proof_url, etc.) now work together.';
