-- ============================================
-- Migration 012: Resource Activity Analytics
-- ============================================
-- Tracks views, downloads, and engagement across all resources
-- (Academic Resources, Past Questions, Timetables, Career Paths)
-- Capturing student identity, matric number, department, and timestamps.

CREATE TABLE IF NOT EXISTS public.resource_activity_logs (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    student_id UUID REFERENCES public.students(id) ON DELETE SET NULL,
    student_name TEXT,
    student_email TEXT,
    matric_no TEXT,
    department TEXT,
    level INTEGER,
    resource_type TEXT NOT NULL CHECK (resource_type IN ('past_question', 'academic_resource', 'timetable', 'career_path', 'other')),
    resource_id UUID,
    resource_title TEXT NOT NULL,
    course_code TEXT,
    action TEXT NOT NULL CHECK (action IN ('view', 'download', 'save')),
    ip_address TEXT,
    user_agent TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

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

-- Service role has full access
DO $$ 
BEGIN
  DROP POLICY IF EXISTS "resource_activity_service_role_all" ON public.resource_activity_logs;
  CREATE POLICY "resource_activity_service_role_all" 
  ON public.resource_activity_logs
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

  -- Allow authenticated users and anon users to insert logs (via backend service-role or client)
  DROP POLICY IF EXISTS "resource_activity_insert_any" ON public.resource_activity_logs;
  CREATE POLICY "resource_activity_insert_any" 
  ON public.resource_activity_logs
  FOR INSERT
  WITH CHECK (true);

  -- Allow admins to read all activity logs
  DROP POLICY IF EXISTS "resource_activity_admin_read_all" ON public.resource_activity_logs;
  CREATE POLICY "resource_activity_admin_read_all" 
  ON public.resource_activity_logs
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.admin_users
      WHERE admin_users.user_id = auth.uid()
    )
  );
END $$;
