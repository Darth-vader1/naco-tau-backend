-- ============================================
-- Migration 012: Resource Activity Analytics
-- ============================================
-- Tracks views, downloads, and engagement across all resources
-- (Academic Resources, Past Questions, Timetables, Career Paths)
-- Standalone table with no external foreign-key dependencies.

CREATE TABLE IF NOT EXISTS public.resource_activity_logs (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID,
    student_id UUID,
    student_name TEXT,
    student_email TEXT,
    matric_no TEXT,
    department TEXT,
    level INTEGER,
    resource_type TEXT NOT NULL CHECK (resource_type IN ('past_question', 'academic_resource', 'timetable', 'career_path', 'other')),
    resource_id TEXT,
    resource_title TEXT NOT NULL,
    course_code TEXT,
    action TEXT NOT NULL CHECK (action IN ('view', 'download', 'save')),
    ip_address TEXT,
    user_agent TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Ensure resource_id is TEXT if table already existed with UUID
DO $$
BEGIN
  ALTER TABLE public.resource_activity_logs ALTER COLUMN resource_id TYPE TEXT;
EXCEPTION
  WHEN others THEN NULL;
END $$;

-- Drop foreign key constraint on student_id if it was previously created
DO $$
BEGIN
  ALTER TABLE public.resource_activity_logs DROP CONSTRAINT IF EXISTS resource_activity_logs_student_id_fkey;
  ALTER TABLE public.resource_activity_logs DROP CONSTRAINT IF EXISTS resource_activity_logs_user_id_fkey;
EXCEPTION
  WHEN others THEN NULL;
END $$;

-- Performance Indexes
CREATE INDEX IF NOT EXISTS idx_activity_resource_type ON public.resource_activity_logs(resource_type);
CREATE INDEX IF NOT EXISTS idx_activity_action ON public.resource_activity_logs(action);
CREATE INDEX IF NOT EXISTS idx_activity_created_at ON public.resource_activity_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_user_id ON public.resource_activity_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_activity_student_id ON public.resource_activity_logs(student_id);
CREATE INDEX IF NOT EXISTS idx_activity_matric_no ON public.resource_activity_logs(matric_no);
CREATE INDEX IF NOT EXISTS idx_activity_resource_id ON public.resource_activity_logs(resource_id);

-- Enable Row Level Security (RLS)
ALTER TABLE public.resource_activity_logs ENABLE ROW LEVEL SECURITY;

-- 1. Service role has full access
DROP POLICY IF EXISTS "resource_activity_service_role_all" ON public.resource_activity_logs;
CREATE POLICY "resource_activity_service_role_all" 
ON public.resource_activity_logs
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- 2. Allow authenticated users and anon users to insert logs
DROP POLICY IF EXISTS "resource_activity_insert_any" ON public.resource_activity_logs;
CREATE POLICY "resource_activity_insert_any" 
ON public.resource_activity_logs
FOR INSERT
WITH CHECK (true);

-- 3. Allow admins to read all activity logs (safely checking if admin_users exists)
DO $$
BEGIN
  DROP POLICY IF EXISTS "resource_activity_admin_read_all" ON public.resource_activity_logs;
  
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'admin_users') THEN
    EXECUTE '
      CREATE POLICY "resource_activity_admin_read_all" 
      ON public.resource_activity_logs
      FOR SELECT
      TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM public.admin_users
          WHERE admin_users.user_id = auth.uid()
        )
      )
    ';
  ELSE
    EXECUTE '
      CREATE POLICY "resource_activity_admin_read_all" 
      ON public.resource_activity_logs
      FOR SELECT
      TO authenticated
      USING (true)
    ';
  END IF;
END $$;
