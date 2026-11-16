-- ============================================================================
-- Migration 027: Homepage CMS (Current Executives + Site Settings)
-- Date: 2026-11-16
--
-- Makes index.html dynamically managed from admin-dashboard.html:
--   1. executives     - Current academic session executive team cards
--   2. site_settings  - Single-row (id = 1) homepage copy, dues/bank info,
--                       and executive inquiry contacts
--
-- Safe to re-run (idempotent).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Current Executives Table
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS executives (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    full_name TEXT NOT NULL,
    portfolio TEXT NOT NULL,
    photo_url TEXT,
    linkedin_url TEXT,
    rank_order INTEGER NOT NULL DEFAULT 10,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_executives_active_rank
    ON executives (is_active, rank_order ASC, full_name ASC);

ALTER TABLE executives ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public can view active executives" ON executives;
CREATE POLICY "Public can view active executives"
    ON executives FOR SELECT
    TO public
    USING (is_active = true);

DROP POLICY IF EXISTS "Admins can manage executives" ON executives;
CREATE POLICY "Admins can manage executives"
    ON executives FOR ALL
    TO authenticated
    USING (true)
    WITH CHECK (true);

-- Seed current 2026/2027 executives ONLY if the table is empty
INSERT INTO executives (full_name, portfolio, photo_url, linkedin_url, rank_order, is_active)
SELECT v.full_name, v.portfolio, v.photo_url, v.linkedin_url, v.rank_order, true
FROM (VALUES
    ('Ajetomobi Praise Jesutofunmi', 'President', 'assets/img/praise.webp', 'https://www.linkedin.com/in/praise-ajetomobi-7256302ba?/', 1),
    ('Akinlotan Victor', 'Vice-President', 'assets/img/victor.webp', 'https://www.linkedin.com/in/akinlotan-victor-88b86a380', 2),
    ('Bamiro Temitayo', 'General Secretary', 'assets/img/temitayo.webp', 'https://www.linkedin.com/in/temitayo-bamiro-b06840288', 3),
    ('Henry Oyawoye', 'Assistant General Secretary', 'assets/img/henry.webp', 'https://www.linkedin.com/in/henry-oyawoye-aa7528394?', 4),
    ('Olufemi-Abiodun Gbolahan', 'Software Director', 'assets/img/gbolahan.webp', 'https://www.linkedin.com/in/olufemi-abiodun-gbolahan-543aa52a4', 5),
    ('philemon .O. Olusegun', 'Assistant Software Director', 'assets/img/philemon.webp', 'https://www.linkedin.com/in/neo-valos-3465702a6?', 6),
    ('Mohammedsiraj surajudeen-Bakinde', 'Social Director', 'assets/img/siraj.webp', 'https://www.linkedin.com/in/mohammedsiraj-surajudeen-bakinde-6aa5b7425?', 7),
    ('Anifowoshe Khadijah', 'Financial Secretary', 'assets/img/carmen.webp', 'https://www.linkedin.com/in/anifowoshe-khadijah-292299271/', 8),
    ('Olawuyi Marvellous', 'Treasurer', 'assets/img/marvelous.webp', 'https://www.linkedin.com/in/olawuyi-marvelous-505960401', 9),
    ('Aina Folahan', 'Sports Director', 'assets/img/fola.webp', 'https://www.linkedin.com/in/folahan-aina-0012162a4?', 10),
    ('Al-ameen Akinwumi', 'Assistant Sports Director', 'assets/img/alameen.webp', 'https://www.linkedin.com/in/al-ameen-akinwumi-1627aa303?', 11),
    ('Friday Ugochi Daniel', 'Provost', 'assets/img/daniel.webp', 'https://www.linkedin.com/in/olajide-peter-b55108275/', 12),
    ('Oyedokun Joshua Ayooluwaposi', 'Academic Director', 'assets/img/jiggy.webp', 'https://www.linkedin.com/in/ayooluwaposi-oyedokun-3a83b12a0?', 13),
    ('Samuel', 'Welfare Director', 'assets/img/samuel.webp', 'https://www.linkedin.com/in/ayooluwaposi-oyedokun-3a83b12a0?', 14)
) AS v(full_name, portfolio, photo_url, linkedin_url, rank_order)
WHERE NOT EXISTS (SELECT 1 FROM executives LIMIT 1);

-- ----------------------------------------------------------------------------
-- 2. Site Settings Table (Single Row: id = 1)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS site_settings (
    id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    hero_title_prefix TEXT NOT NULL DEFAULT 'Welcome to Thomas Adewumi University''s',
    hero_title_highlight TEXT NOT NULL DEFAULT 'Nigeria Association of Computing Students',
    hero_subtitle TEXT NOT NULL DEFAULT 'Breeding the innovators of tomorrow''s technology.',
    about_heading TEXT NOT NULL DEFAULT 'Breeding the innovators of tomorrow''s technology',
    about_intro TEXT NOT NULL DEFAULT 'The Nigeria Association of Computing Students (NACOS) at Thomas Adewumi University is home to all students of Computer Science, Software Engineering and all other IT related courses.',
    about_bullets JSONB NOT NULL DEFAULT '[
        "We foster a supportive and collaborative community for all computing students.",
        "We aim to bridge the gap between theoretical and practical knowledge by providing students with real-world experiences.",
        "We create awareness on the latest technology and its applications on our campus and community as a whole."
    ]'::jsonb,
    exec_session TEXT NOT NULL DEFAULT '2026/2027 ACADEMIC SESSION',
    exec_subtitle TEXT NOT NULL DEFAULT 'With a versatile and hardworking team of student leaders, we are proud to be led by some of the brightest minds on campus for the 2026/2027 academic tenure!',
    bank_account_number TEXT NOT NULL DEFAULT '0118670866',
    bank_account_name TEXT NOT NULL DEFAULT 'Nigerian Association of Computing Students - TAU',
    bank_name TEXT NOT NULL DEFAULT 'Sterling Bank',
    dues_amount TEXT NOT NULL DEFAULT '₦40,000',
    payment_note TEXT NOT NULL DEFAULT 'Please include your full name, matric number and purpose of payment as the payment reference.',
    payment_reference_format TEXT NOT NULL DEFAULT 'NACOS-TAU | Your Matric Number | Association Fee',
    contact_email TEXT NOT NULL DEFAULT 'nacos@tau.edu.ng',
    inquiry_contacts JSONB NOT NULL DEFAULT '[
        {"label": "The President", "url": "https://wa.me/+2349167566489"},
        {"label": "The Vice President", "url": "https://wa.me/09167566489"},
        {"label": "The General Secretary", "url": "https://wa.me/08028756004"},
        {"label": "The Asst. General Secretary", "url": "https://wa.me/08130383123"},
        {"label": "The Software Director", "url": "https://wa.me/08126398496"},
        {"label": "The Asst. Software Director", "url": "https://wa.me/+2349136800485"},
        {"label": "Social Director", "url": "https://wa.me/+2349037070701"}
    ]'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by UUID
);

INSERT INTO site_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE site_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public can view site settings" ON site_settings;
CREATE POLICY "Public can view site settings"
    ON site_settings FOR SELECT
    TO public
    USING (true);

DROP POLICY IF EXISTS "Admins can manage site settings" ON site_settings;
CREATE POLICY "Admins can manage site settings"
    ON site_settings FOR ALL
    TO authenticated
    USING (true)
    WITH CHECK (true);
