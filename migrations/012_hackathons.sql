-- ============================================
-- NACOS TAU CHAPTER: HACKATHONS & PITCHATHONS MODULE
-- Migration: 012_hackathons.sql
-- ============================================

-- 1. Create Hackathons Table
CREATE TABLE IF NOT EXISTS hackathons (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    title TEXT NOT NULL,
    slug TEXT UNIQUE,
    tagline TEXT,
    description TEXT,
    banner_url TEXT,
    event_type TEXT NOT NULL DEFAULT 'hackathon' CHECK (event_type IN ('hackathon', 'pitchathon')),
    mode TEXT NOT NULL DEFAULT 'hybrid' CHECK (mode IN ('in-person', 'virtual', 'online', 'hybrid')),
    location TEXT DEFAULT 'TAU Campus / Online',
    start_date TIMESTAMPTZ NOT NULL,
    end_date TIMESTAMPTZ NOT NULL,
    registration_deadline TIMESTAMPTZ NOT NULL,
    prize_pool TEXT,
    max_team_size INTEGER DEFAULT 4,
    min_team_size INTEGER DEFAULT 1,
    tracks JSONB DEFAULT '[]'::jsonb, -- e.g. [{"name": "Fintech", "description": "..."}]
    milestones JSONB DEFAULT '[]'::jsonb, -- e.g. [{"title": "Opening", "date": "..."}]
    rules TEXT,
    judging_criteria JSONB DEFAULT '[]'::jsonb,
    is_published BOOLEAN DEFAULT true,
    status TEXT NOT NULL DEFAULT 'upcoming' CHECK (status IN ('upcoming', 'ongoing', 'judging', 'voting', 'completed', 'past')),
    created_by UUID REFERENCES auth.users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Create Hackathon Registrations (Teams or Individuals)
CREATE TABLE IF NOT EXISTS hackathon_registrations (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    hackathon_id UUID REFERENCES hackathons(id) ON DELETE CASCADE,
    leader_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    team_name TEXT NOT NULL,
    is_looking_for_members BOOLEAN DEFAULT false,
    track_selected TEXT,
    team_members JSONB DEFAULT '[]'::jsonb, -- [{"name": "...", "email": "...", "role": "Frontend", "matric_no": "..."}]
    status TEXT NOT NULL DEFAULT 'registered' CHECK (status IN ('registered', 'checked_in', 'submitted', 'disqualified')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(hackathon_id, leader_id)
);

-- 3. Create Hackathon Submissions & Project Showcase
CREATE TABLE IF NOT EXISTS hackathon_submissions (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    hackathon_id UUID REFERENCES hackathons(id) ON DELETE CASCADE,
    registration_id UUID REFERENCES hackathon_registrations(id) ON DELETE CASCADE UNIQUE,
    project_title TEXT NOT NULL,
    tagline TEXT,
    description TEXT,
    github_url TEXT,
    demo_url TEXT,
    video_url TEXT,
    pitch_deck_url TEXT,
    tech_stack TEXT[] DEFAULT '{}',
    is_winner BOOLEAN DEFAULT false,
    award_title TEXT, -- e.g. '1st Place Winner', 'Most Innovative Pitch'
    ranking INTEGER, -- 1, 2, 3
    feedback TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Indexes for Performance and Queries
CREATE INDEX IF NOT EXISTS idx_hackathons_status ON hackathons(status);
CREATE INDEX IF NOT EXISTS idx_hackathons_dates ON hackathons(start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_hackathons_published ON hackathons(is_published);
CREATE INDEX IF NOT EXISTS idx_hackathon_reg_hackathon ON hackathon_registrations(hackathon_id);
CREATE INDEX IF NOT EXISTS idx_hackathon_reg_leader ON hackathon_registrations(leader_id);
CREATE INDEX IF NOT EXISTS idx_hackathon_sub_hackathon ON hackathon_submissions(hackathon_id);
CREATE INDEX IF NOT EXISTS idx_hackathon_sub_winner ON hackathon_submissions(is_winner);

-- 5. Row Level Security Policies
ALTER TABLE hackathons ENABLE ROW LEVEL SECURITY;
ALTER TABLE hackathon_registrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE hackathon_submissions ENABLE ROW LEVEL SECURITY;

-- Hackathons: Anyone can read published hackathons
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'hackathons_public_read') THEN
        CREATE POLICY "hackathons_public_read" ON hackathons FOR SELECT USING (is_published = true);
    END IF;
END $$;

-- Registrations: Authenticated users can view teams and register their own
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'hackathon_registrations_select') THEN
        CREATE POLICY "hackathon_registrations_select" ON hackathon_registrations FOR SELECT TO authenticated USING (true);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'hackathon_registrations_insert_own') THEN
        CREATE POLICY "hackathon_registrations_insert_own" ON hackathon_registrations FOR INSERT TO authenticated WITH CHECK (auth.uid() = leader_id);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'hackathon_registrations_update_own') THEN
        CREATE POLICY "hackathon_registrations_update_own" ON hackathon_registrations FOR UPDATE TO authenticated USING (auth.uid() = leader_id);
    END IF;
END $$;

-- Submissions: Public can read submissions for completed hackathons or their own team
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'hackathon_submissions_select') THEN
        CREATE POLICY "hackathon_submissions_select" ON hackathon_submissions FOR SELECT USING (true);
    END IF;
END $$;
