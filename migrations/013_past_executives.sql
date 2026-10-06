-- ============================================
-- NACOS TAU CHAPTER: PAST EXECUTIVES ROLL OF HONOUR
-- Migration: 013_past_executives.sql
-- ============================================

CREATE TABLE IF NOT EXISTS past_executives (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    full_name TEXT NOT NULL,
    portfolio TEXT NOT NULL, -- e.g. President, Vice-President, General Secretary
    academic_session TEXT NOT NULL, -- e.g. '2023/2024', '2024/2025'
    administration_name TEXT, -- e.g. 'Pioneer Administration'
    department TEXT DEFAULT 'Computer Science',
    photo_url TEXT,
    linkedin_url TEXT,
    github_url TEXT,
    twitter_url TEXT,
    bio TEXT,
    rank_order INTEGER DEFAULT 10, -- 1=President, 2=VP, 3=Gen Sec, etc.
    is_featured BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast session querying & ordering
CREATE INDEX IF NOT EXISTS idx_past_execs_session ON past_executives (academic_session);
CREATE INDEX IF NOT EXISTS idx_past_execs_rank ON past_executives (rank_order ASC);

-- Row Level Security (RLS)
ALTER TABLE past_executives ENABLE ROW LEVEL SECURITY;

-- Allow public read access to everyone
DROP POLICY IF EXISTS "Public can view past executives" ON past_executives;
CREATE POLICY "Public can view past executives" 
ON past_executives FOR SELECT 
TO public 
USING (true);

-- Allow authenticated users / admins full write access
DROP POLICY IF EXISTS "Admins can manage past executives" ON past_executives;
CREATE POLICY "Admins can manage past executives" 
ON past_executives FOR ALL 
TO authenticated 
USING (true)
WITH CHECK (true);

-- NOTE: Current 2025/2026 Executives are actively serving and displayed on index.html.
-- Past administrations (e.g., 2023/2024, 2024/2025) can be entered via the Admin Dashboard.

