-- ============================================
-- STUDENTS TABLE
-- ============================================
CREATE TABLE students (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT UNIQUE NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  name TEXT NOT NULL,
  matric_no TEXT UNIQUE NOT NULL,
  department TEXT NOT NULL,
  course TEXT,
  phone TEXT,
  bio TEXT,
  skills TEXT[],
  github TEXT,
  linkedin TEXT,
  profile_picture_url TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'rejected', 'banned')),
  verified_at TIMESTAMPTZ,
  verified_by UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- ADMIN USERS TABLE
-- ============================================
CREATE TABLE admin_users (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  role TEXT DEFAULT 'admin' CHECK (role IN ('admin', 'super_admin')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- EVENTS TABLE
-- ============================================
CREATE TABLE events (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  date DATE NOT NULL,
  time TIME,
  location TEXT,
  image_url TEXT,
  event_type TEXT,
  requires_payment BOOLEAN DEFAULT false,
  payment_amount DECIMAL(10,2),
  max_attendees INTEGER,
  is_active BOOLEAN DEFAULT true,
  created_by UUID REFERENCES students(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- EVENT REGISTRATIONS
-- ============================================
CREATE TABLE event_registrations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  event_id UUID REFERENCES events(id) ON DELETE CASCADE,
  user_id UUID REFERENCES students(user_id) ON DELETE CASCADE,
  status TEXT DEFAULT 'registered' CHECK (status IN ('registered', 'attended', 'cancelled')),
  registration_date TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(event_id, user_id)
);

-- ============================================
-- ACADEMIC RESOURCES
-- ============================================
CREATE TABLE academic_resources (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('past_question', 'lecture_note', 'tutorial', 'reference_material')),
  course TEXT,
  year INTEGER,
  semester TEXT,
  file_url TEXT NOT NULL,
  file_name TEXT,
  file_size BIGINT,
  file_type TEXT,
  author TEXT,
  uploaded_by UUID REFERENCES students(user_id),
  is_active BOOLEAN DEFAULT true,
  download_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- TIMETABLES
-- ============================================
CREATE TABLE timetables (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL,
  department TEXT NOT NULL,
  level INTEGER,
  semester TEXT,
  academic_session TEXT,
  file_url TEXT NOT NULL,
  file_name TEXT,
  description TEXT,
  is_current BOOLEAN DEFAULT false,
  version INTEGER DEFAULT 1,
  uploaded_by UUID REFERENCES students(user_id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- CAREER PATHS
-- ============================================
CREATE TABLE career_paths (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  skills TEXT[],
  tools TEXT[],
  roadmap JSONB,
  required_education TEXT,
  salary_range TEXT,
  job_outlook TEXT,
  resources TEXT[],
  is_active BOOLEAN DEFAULT true,
  created_by UUID REFERENCES students(user_id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- SAVED CAREERS
-- ============================================
CREATE TABLE saved_careers (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  career_id UUID REFERENCES career_paths(id) ON DELETE CASCADE,
  user_id UUID REFERENCES students(user_id) ON DELETE CASCADE,
  saved_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(career_id, user_id)
);

-- ============================================
-- VOTING POSITIONS
-- ============================================
CREATE TABLE voting_positions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  display_order INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  voting_start TIMESTAMPTZ,
  voting_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- VOTING CANDIDATES
-- ============================================
CREATE TABLE voting_candidates (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  position_id UUID REFERENCES voting_positions(id) ON DELETE CASCADE,
  student_id UUID REFERENCES students(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  bio TEXT,
  manifesto TEXT,
  photo_url TEXT,
  is_active BOOLEAN DEFAULT true,
  vote_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- VOTES
-- ============================================
CREATE TABLE votes (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  position_id UUID REFERENCES voting_positions(id) ON DELETE CASCADE,
  candidate_id UUID REFERENCES voting_candidates(id) ON DELETE CASCADE,
  voter_id UUID REFERENCES students(user_id) ON DELETE CASCADE,
  voted_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(position_id, voter_id)
);

-- ============================================
-- PAYMENTS
-- ============================================
CREATE TABLE payments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES students(user_id) ON DELETE CASCADE,
  amount DECIMAL(10,2) NOT NULL,
  payment_type TEXT NOT NULL CHECK (payment_type IN ('association_fee', 'event_registration', 'other')),
  transaction_id TEXT,
  payment_proof_url TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'rejected')),
  verified_by UUID REFERENCES students(user_id),
  verified_at TIMESTAMPTZ,
  notes TEXT,
  submitted_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- LOGIN HISTORY
-- ============================================
CREATE TABLE login_history (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES students(user_id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  login_time TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- AUDIT LOGS
-- ============================================
CREATE TABLE audit_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  action TEXT NOT NULL,
  user_id UUID REFERENCES students(user_id) ON DELETE SET NULL,
  user_email TEXT,
  details JSONB,
  ip_address TEXT,
  timestamp TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- RESOURCE DOWNLOADS
-- ============================================
CREATE TABLE resource_downloads (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  resource_id UUID REFERENCES academic_resources(id) ON DELETE CASCADE,
  user_id UUID REFERENCES students(user_id) ON DELETE CASCADE,
  downloaded_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- CREATE INDEXES FOR PERFORMANCE
-- ============================================
CREATE INDEX idx_students_email ON students(email);
CREATE INDEX idx_students_matric_no ON students(matric_no);
CREATE INDEX idx_students_status ON students(status);
CREATE INDEX idx_events_date ON events(date);
CREATE INDEX idx_payments_status ON payments(status);
CREATE INDEX idx_payments_user_id ON payments(user_id);
CREATE INDEX idx_votes_voter_id ON votes(voter_id);
CREATE INDEX idx_votes_position_id ON votes(position_id);
CREATE INDEX idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_timestamp ON audit_logs(timestamp);