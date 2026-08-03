-- ============================================
-- Migration: Add past_questions and payment_verification tables
-- Date: 2026-07-27
-- Description: Creates missing tables for past questions and payment verification
-- ============================================

-- ============================================
-- PAST QUESTIONS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS public.past_questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT,
  course_code TEXT NOT NULL,
  course_name TEXT,
  level TEXT,
  semester TEXT,
  file_url TEXT NOT NULL,
  file_type TEXT,
  uploaded_by UUID REFERENCES public.admin_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enable Row Level Security
ALTER TABLE public.past_questions ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Allow authenticated users to read past questions
CREATE POLICY "past_questions_select_authenticated" 
  ON public.past_questions 
  FOR SELECT 
  TO authenticated 
  USING (true);

-- ============================================
-- PAYMENT VERIFICATION TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS public.payment_verification (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID REFERENCES public.students(id) ON DELETE CASCADE,
  event_id UUID REFERENCES public.events(id) ON DELETE CASCADE,
  amount NUMERIC(10,2),
  payment_reference TEXT,
  proof_url TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enable Row Level Security
ALTER TABLE public.payment_verification ENABLE ROW LEVEL SECURITY;

-- RLS Policies: Allow students to read their own payment verifications
CREATE POLICY "payment_verification_select_own" 
  ON public.payment_verification 
  FOR SELECT 
  USING (student_id IN (SELECT id FROM public.students WHERE user_id = auth.uid()));

-- Allow students to insert their own payment verifications
CREATE POLICY "payment_verification_insert_own" 
  ON public.payment_verification 
  FOR INSERT 
  WITH CHECK (student_id IN (SELECT id FROM public.students WHERE user_id = auth.uid()));

-- ============================================
-- CREATE INDEXES FOR PERFORMANCE
-- ============================================
CREATE INDEX IF NOT EXISTS idx_past_questions_course_code ON public.past_questions(course_code);
CREATE INDEX IF NOT EXISTS idx_past_questions_level ON public.past_questions(level);
CREATE INDEX IF NOT EXISTS idx_past_questions_created_at ON public.past_questions(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payment_verification_student_id ON public.payment_verification(student_id);
CREATE INDEX IF NOT EXISTS idx_payment_verification_event_id ON public.payment_verification(event_id);
CREATE INDEX IF NOT EXISTS idx_payment_verification_status ON public.payment_verification(status);
CREATE INDEX IF NOT EXISTS idx_payment_verification_created_at ON public.payment_verification(created_at DESC);

-- ============================================
-- GRANT PERMISSIONS (if needed)
-- ============================================
-- Note: These grants may not be needed if you're using the service role key
-- But they ensure proper access if using anon key with RLS

-- Grant usage on schema
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO anon;

-- Grant select on tables for authenticated users
GRANT SELECT ON public.past_questions TO authenticated;
GRANT SELECT ON public.payment_verification TO authenticated;

-- Grant insert on payment_verification for authenticated users
GRANT INSERT ON public.payment_verification TO authenticated;

-- ============================================
-- VERIFICATION QUERIES
-- ============================================
-- Run these queries to verify the tables were created successfully:
-- SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('past_questions', 'payment_verification');
-- SELECT * FROM public.past_questions LIMIT 1;
-- SELECT * FROM public.payment_verification LIMIT 1;
