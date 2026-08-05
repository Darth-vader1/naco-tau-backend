-- ============================================
-- Migration 010: Fix Audit Logs RLS Policy
-- ============================================
-- Problem: audit_logs table has RLS enabled but no INSERT policy
-- Solution: Add policy to allow service_role to insert audit logs

-- Drop existing restrictive policy if it exists
DROP POLICY IF EXISTS "audit_logs_no_anon" ON public.audit_logs;

-- Create policy to allow service role (backend) to insert audit logs
CREATE POLICY "audit_logs_service_role_all" 
ON public.audit_logs
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- Create policy to allow authenticated users to read their own audit logs
CREATE POLICY "audit_logs_read_own" 
ON public.audit_logs
FOR SELECT
TO authenticated
USING (user_id = auth.uid());

-- Create policy to allow admins to read all audit logs
CREATE POLICY "audit_logs_admin_read_all" 
ON public.audit_logs
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.admin_users
    WHERE admin_users.user_id = auth.uid()
  )
);

-- Verify RLS is enabled
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

-- Success message
DO $$ 
BEGIN 
  RAISE NOTICE '✅ Migration 010 completed: Audit logs RLS policies updated';
END $$;
