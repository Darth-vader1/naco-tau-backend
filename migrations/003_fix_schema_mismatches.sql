-- ============================================
-- Migration: Fix Schema Mismatches
-- Date: 2026-07-27
-- Description: Fixes column mismatches between code expectations and actual database
-- ============================================

-- ============================================
-- FIX 1: payment_verification - Add created_at column
-- ============================================
-- Error: column payment_verification.created_at does not exist
-- The code tries to order by created_at, but the table only has updated_at

-- Check if created_at exists, if not add it
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_schema = 'public' 
          AND table_name = 'payment_verification' 
          AND column_name = 'created_at'
    ) THEN
        -- Add created_at column
        ALTER TABLE public.payment_verification 
        ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
        
        -- If there's an updated_at, copy those values to created_at for existing rows
        IF EXISTS (
            SELECT 1 
            FROM information_schema.columns 
            WHERE table_schema = 'public' 
              AND table_name = 'payment_verification' 
              AND column_name = 'updated_at'
        ) THEN
            UPDATE public.payment_verification 
            SET created_at = updated_at 
            WHERE created_at IS NULL;
        END IF;
        
        RAISE NOTICE 'Added created_at column to payment_verification';
    ELSE
        RAISE NOTICE 'payment_verification.created_at already exists';
    END IF;
END $$;

-- ============================================
-- FIX 2: audit_logs - Add admin_id and entity columns
-- ============================================
-- Error: Could not find the 'admin_id' column of 'audit_logs'
-- The code sends admin_id, entity_type, entity_id but table doesn't have them

DO $$ 
BEGIN
    -- Add admin_id column if it doesn't exist
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_schema = 'public' 
          AND table_name = 'audit_logs' 
          AND column_name = 'admin_id'
    ) THEN
        ALTER TABLE public.audit_logs 
        ADD COLUMN admin_id UUID REFERENCES public.admin_users(id) ON DELETE SET NULL;
        
        RAISE NOTICE 'Added admin_id column to audit_logs';
    ELSE
        RAISE NOTICE 'audit_logs.admin_id already exists';
    END IF;
    
    -- Add entity_type column if it doesn't exist
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_schema = 'public' 
          AND table_name = 'audit_logs' 
          AND column_name = 'entity_type'
    ) THEN
        ALTER TABLE public.audit_logs 
        ADD COLUMN entity_type TEXT;
        
        RAISE NOTICE 'Added entity_type column to audit_logs';
    ELSE
        RAISE NOTICE 'audit_logs.entity_type already exists';
    END IF;
    
    -- Add entity_id column if it doesn't exist
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_schema = 'public' 
          AND table_name = 'audit_logs' 
          AND column_name = 'entity_id'
    ) THEN
        ALTER TABLE public.audit_logs 
        ADD COLUMN entity_id UUID;
        
        RAISE NOTICE 'Added entity_id column to audit_logs';
    ELSE
        RAISE NOTICE 'audit_logs.entity_id already exists';
    END IF;
    
    -- Add user_agent column if it doesn't exist
    IF NOT EXISTS (
        SELECT 1 
        FROM information_schema.columns 
        WHERE table_schema = 'public' 
          AND table_name = 'audit_logs' 
          AND column_name = 'user_agent'
    ) THEN
        ALTER TABLE public.audit_logs 
        ADD COLUMN user_agent TEXT;
        
        RAISE NOTICE 'Added user_agent column to audit_logs';
    ELSE
        RAISE NOTICE 'audit_logs.user_agent already exists';
    END IF;
END $$;

-- ============================================
-- FIX 3: Add indexes for new columns
-- ============================================
CREATE INDEX IF NOT EXISTS idx_audit_logs_admin_id ON public.audit_logs(admin_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity_type ON public.audit_logs(entity_type);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity_id ON public.audit_logs(entity_id);
CREATE INDEX IF NOT EXISTS idx_payment_verification_created_at ON public.payment_verification(created_at DESC);

-- ============================================
-- VERIFICATION QUERIES
-- ============================================
-- Run these to verify the fixes worked:

-- Check payment_verification has created_at
-- SELECT column_name, data_type 
-- FROM information_schema.columns 
-- WHERE table_name = 'payment_verification' AND table_schema = 'public'
-- ORDER BY ordinal_position;

-- Check audit_logs has all required columns
-- SELECT column_name, data_type 
-- FROM information_schema.columns 
-- WHERE table_name = 'audit_logs' AND table_schema = 'public'
-- ORDER BY ordinal_position;

-- Test that queries work now
-- SELECT * FROM public.payment_verification ORDER BY created_at DESC LIMIT 1;
-- SELECT * FROM public.past_questions ORDER BY created_at DESC LIMIT 1;

RAISE NOTICE 'Schema mismatch fixes completed successfully!';
