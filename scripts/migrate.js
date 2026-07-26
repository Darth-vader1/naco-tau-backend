// backend/scripts/migrate.js
require('dotenv').config();
const { supabase } = require('../config/supabase');

/**
 * Migration script to set up all Supabase tables
 * Run with: npm run migrate
 */
async function migrate() {
    console.log('🚀 Starting database migration...');
    console.log('📡 Connected to:', process.env.SUPABASE_URL);

    try {
        // ============================================
        // 0. CREATE HELPER FUNCTIONS FIRST (required by later steps)
        // ============================================

        console.log('\n⚡ Creating helper functions...');

        // Function to safely create tables
        try {
            await supabase.rpc('exec_sql', {
                sql: `
                    CREATE OR REPLACE FUNCTION create_table_if_not_exists(
                        table_name text,
                        table_definition text
                    ) RETURNS void AS $$
                    BEGIN
                        IF NOT EXISTS (
                            SELECT FROM information_schema.tables 
                            WHERE table_schema = 'public' 
                            AND table_name = create_table_if_not_exists.table_name
                        ) THEN
                            EXECUTE 'CREATE TABLE ' || quote_ident(table_name) || ' (' || table_definition || ');';
                        END IF;
                    END;
                    $$ LANGUAGE plpgsql;
                `
            });
            console.log('✅ create_table_if_not_exists function ready');
        } catch (err) {
            console.error('Helper function creation error:', err.message);
        }

        // ============================================
        // 1. CREATE TABLES
        // ============================================

        console.log('\n📋 Creating tables...');

        // Students Table
        console.log('Creating students table...');
        const { error: studentsError } = await supabase.rpc('create_table_if_not_exists', {
            table_name: 'students',
            table_definition: `
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
            `
        });
        if (studentsError) console.error('Students table error:', studentsError);

        // Admin Users Table
        console.log('Creating admin_users table...');
        const { error: adminError } = await supabase.rpc('create_table_if_not_exists', {
            table_name: 'admin_users',
            table_definition: `
                id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
                user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
                email TEXT UNIQUE NOT NULL,
                name TEXT NOT NULL,
                role TEXT DEFAULT 'admin' CHECK (role IN ('admin', 'super_admin')),
                created_at TIMESTAMPTZ DEFAULT NOW()
            `
        });
        if (adminError) console.error('Admin users error:', adminError);

        // Events Table
        console.log('Creating events table...');
        const { error: eventsError } = await supabase.rpc('create_table_if_not_exists', {
            table_name: 'events',
            table_definition: `
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
            `
        });
        if (eventsError) console.error('Events table error:', eventsError);

        // Event Registrations
        console.log('Creating event_registrations table...');
        const { error: regError } = await supabase.rpc('create_table_if_not_exists', {
            table_name: 'event_registrations',
            table_definition: `
                id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
                event_id UUID REFERENCES events(id) ON DELETE CASCADE,
                user_id UUID REFERENCES students(user_id) ON DELETE CASCADE,
                status TEXT DEFAULT 'registered' CHECK (status IN ('registered', 'attended', 'cancelled')),
                registration_date TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE(event_id, user_id)
            `
        });
        if (regError) console.error('Event registrations error:', regError);

        // Academic Resources
        console.log('Creating academic_resources table...');
        const { error: resourcesError } = await supabase.rpc('create_table_if_not_exists', {
            table_name: 'academic_resources',
            table_definition: `
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
            `
        });
        if (resourcesError) console.error('Resources error:', resourcesError);

        // Timetables
        console.log('Creating timetables table...');
        const { error: timetableError } = await supabase.rpc('create_table_if_not_exists', {
            table_name: 'timetables',
            table_definition: `
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
            `
        });
        if (timetableError) console.error('Timetables error:', timetableError);

        // Career Paths
        console.log('Creating career_paths table...');
        const { error: careerError } = await supabase.rpc('create_table_if_not_exists', {
            table_name: 'career_paths',
            table_definition: `
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
            `
        });
        if (careerError) console.error('Career paths error:', careerError);

        // Saved Careers
        console.log('Creating saved_careers table...');
        const { error: savedCareerError } = await supabase.rpc('create_table_if_not_exists', {
            table_name: 'saved_careers',
            table_definition: `
                id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
                career_id UUID REFERENCES career_paths(id) ON DELETE CASCADE,
                user_id UUID REFERENCES students(user_id) ON DELETE CASCADE,
                saved_at TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE(career_id, user_id)
            `
        });
        if (savedCareerError) console.error('Saved careers error:', savedCareerError);

        // Voting Positions
        console.log('Creating voting_positions table...');
        const { error: positionError } = await supabase.rpc('create_table_if_not_exists', {
            table_name: 'voting_positions',
            table_definition: `
                id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
                title TEXT NOT NULL,
                description TEXT,
                display_order INTEGER DEFAULT 0,
                is_active BOOLEAN DEFAULT true,
                voting_start TIMESTAMPTZ,
                voting_end TIMESTAMPTZ,
                created_at TIMESTAMPTZ DEFAULT NOW()
            `
        });
        if (positionError) console.error('Voting positions error:', positionError);

        // Voting Candidates
        console.log('Creating voting_candidates table...');
        const { error: candidateError } = await supabase.rpc('create_table_if_not_exists', {
            table_name: 'voting_candidates',
            table_definition: `
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
            `
        });
        if (candidateError) console.error('Voting candidates error:', candidateError);

        // Votes
        console.log('Creating votes table...');
        const { error: voteError } = await supabase.rpc('create_table_if_not_exists', {
            table_name: 'votes',
            table_definition: `
                id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
                position_id UUID REFERENCES voting_positions(id) ON DELETE CASCADE,
                candidate_id UUID REFERENCES voting_candidates(id) ON DELETE CASCADE,
                voter_id UUID REFERENCES students(user_id) ON DELETE CASCADE,
                voted_at TIMESTAMPTZ DEFAULT NOW(),
                UNIQUE(position_id, voter_id)
            `
        });
        if (voteError) console.error('Votes error:', voteError);

        // Payments
        console.log('Creating payments table...');
        const { error: paymentError } = await supabase.rpc('create_table_if_not_exists', {
            table_name: 'payments',
            table_definition: `
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
            `
        });
        if (paymentError) console.error('Payments error:', paymentError);

        // Login History
        console.log('Creating login_history table...');
        const { error: loginError } = await supabase.rpc('create_table_if_not_exists', {
            table_name: 'login_history',
            table_definition: `
                id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
                user_id UUID REFERENCES students(user_id) ON DELETE CASCADE,
                email TEXT NOT NULL,
                ip_address TEXT,
                user_agent TEXT,
                login_time TIMESTAMPTZ DEFAULT NOW()
            `
        });
        if (loginError) console.error('Login history error:', loginError);

        // Audit Logs
        console.log('Creating audit_logs table...');
        const { error: auditError } = await supabase.rpc('create_table_if_not_exists', {
            table_name: 'audit_logs',
            table_definition: `
                id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
                action TEXT NOT NULL,
                user_id UUID REFERENCES students(user_id) ON DELETE SET NULL,
                user_email TEXT,
                details JSONB,
                ip_address TEXT,
                user_agent TEXT,
                timestamp TIMESTAMPTZ DEFAULT NOW()
            `
        });
        if (auditError) console.error('Audit logs error:', auditError);

        // Resource Downloads
        console.log('Creating resource_downloads table...');
        const { error: downloadError } = await supabase.rpc('create_table_if_not_exists', {
            table_name: 'resource_downloads',
            table_definition: `
                id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
                resource_id UUID REFERENCES academic_resources(id) ON DELETE CASCADE,
                user_id UUID REFERENCES students(user_id) ON DELETE CASCADE,
                downloaded_at TIMESTAMPTZ DEFAULT NOW()
            `
        });
        if (downloadError) console.error('Resource downloads error:', downloadError);

        // Resource Views
        console.log('Creating resource_views table...');
        const { error: viewsError } = await supabase.rpc('create_table_if_not_exists', {
            table_name: 'resource_views',
            table_definition: `
                id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
                resource_id UUID REFERENCES academic_resources(id) ON DELETE CASCADE,
                user_id UUID REFERENCES students(user_id) ON DELETE CASCADE,
                viewed_at TIMESTAMPTZ DEFAULT NOW()
            `
        });
        if (viewsError) console.error('Resource views error:', viewsError);

        // ============================================
        // 2. CREATE INDEXES
        // ============================================

        console.log('\n📊 Creating indexes...');

        const indexes = [
            'CREATE INDEX IF NOT EXISTS idx_students_email ON students(email);',
            'CREATE INDEX IF NOT EXISTS idx_students_matric_no ON students(matric_no);',
            'CREATE INDEX IF NOT EXISTS idx_students_status ON students(status);',
            'CREATE INDEX IF NOT EXISTS idx_events_date ON events(date);',
            'CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);',
            'CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments(user_id);',
            'CREATE INDEX IF NOT EXISTS idx_votes_voter_id ON votes(voter_id);',
            'CREATE INDEX IF NOT EXISTS idx_votes_position_id ON votes(position_id);',
            'CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);',
            'CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp);',
            'CREATE INDEX IF NOT EXISTS idx_resources_type ON academic_resources(resource_type);',
            'CREATE INDEX IF NOT EXISTS idx_timetables_department ON timetables(department);',
            'CREATE INDEX IF NOT EXISTS idx_resource_views_resource_id ON resource_views(resource_id);',
            'CREATE INDEX IF NOT EXISTS idx_resource_downloads_resource_id ON resource_downloads(resource_id);'
        ];

        for (const indexSql of indexes) {
            try {
                const { error } = await supabase.rpc('exec_sql', { sql: indexSql });
                if (error) console.error('Index creation error:', error);
            } catch (err) {
                console.error('Index creation failed:', err.message);
            }
        }

        // ============================================
        // 3. CREATE RLS POLICIES
        // ============================================

        console.log('\n🔒 Setting up Row Level Security (RLS)...');

        // Enable RLS on all tables
        const tables = [
            'students', 'admin_users', 'events', 'event_registrations',
            'academic_resources', 'timetables', 'career_paths', 'saved_careers',
            'voting_positions', 'voting_candidates', 'votes', 'payments',
            'login_history', 'audit_logs', 'resource_downloads', 'resource_views'
        ];

        for (const table of tables) {
            try {
                await supabase.rpc('exec_sql', {
                    sql: `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`
                });
            } catch (err) {
                console.error(`RLS enable failed for ${table}:`, err.message);
            }
        }

        // ============================================
        // 3b. CREATE RLS POLICIES (anon + authenticated roles)
        // ============================================

        console.log('\n🛡️  Creating RLS policies...');

        const policies = [
            // --- students: public read for own profile; write for self only ---
            `CREATE POLICY "students_select_own" ON students FOR SELECT USING (auth.uid() = user_id);`,
            `CREATE POLICY "students_insert_own" ON students FOR INSERT WITH CHECK (auth.uid() = user_id);`,
            `CREATE POLICY "students_update_own" ON students FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);`,

            // --- events: public read for active; write admin only ---
            `CREATE POLICY "events_select_public" ON events FOR SELECT USING (is_active = true);`,

            // --- event_registrations: read/write own records ---
            `CREATE POLICY "event_registrations_select_own" ON event_registrations FOR SELECT USING (auth.uid() = user_id);`,
            `CREATE POLICY "event_registrations_insert_own" ON event_registrations FOR INSERT WITH CHECK (auth.uid() = user_id);`,

            // --- academic_resources: read all active authenticated; insert admin ---
            `CREATE POLICY "resources_select_authenticated" ON academic_resources FOR SELECT TO authenticated USING (is_active = true);`,

            // --- timetables: read all current/authenticated ---
            `CREATE POLICY "timetables_select_authenticated" ON timetables FOR SELECT TO authenticated USING (true);`,

            // --- career_paths: public read active; write admin only ---
            `CREATE POLICY "careers_select_public" ON career_paths FOR SELECT USING (is_active = true);`,

            // --- saved_careers: read/write own records ---
            `CREATE POLICY "saved_careers_select_own" ON saved_careers FOR SELECT USING (auth.uid() = user_id);`,
            `CREATE POLICY "saved_careers_insert_own" ON saved_careers FOR INSERT WITH CHECK (auth.uid() = user_id);`,
            `CREATE POLICY "saved_careers_delete_own" ON saved_careers FOR DELETE USING (auth.uid() = user_id);`,

            // --- voting_positions & voting_candidates: public read active ---
            `CREATE POLICY "voting_positions_select_public" ON voting_positions FOR SELECT USING (is_active = true);`,
            `CREATE POLICY "voting_candidates_select_public" ON voting_candidates FOR SELECT USING (is_active = true);`,

            // --- votes: read/write own; one per position enforced by UNIQUE ---
            `CREATE POLICY "votes_select_own" ON votes FOR SELECT USING (auth.uid() = voter_id);`,
            `CREATE POLICY "votes_insert_own" ON votes FOR INSERT WITH CHECK (auth.uid() = voter_id);`,

            // --- payments: read/write own student records; admin has service role ---
            `CREATE POLICY "payments_select_own" ON payments FOR SELECT USING (auth.uid() = user_id);`,
            `CREATE POLICY "payments_insert_own" ON payments FOR INSERT WITH CHECK (auth.uid() = user_id);`,

            // --- login_history: read own ---
            `CREATE POLICY "login_history_select_own" ON login_history FOR SELECT USING (auth.uid() = user_id);`,

            // --- audit_logs: no direct anon access; service_role only via backend ---
            `CREATE POLICY "audit_logs_no_anon" ON audit_logs FOR SELECT USING (false);`,

            // --- resource_downloads & resource_views: read/write own ---
            `CREATE POLICY "resource_downloads_select_own" ON resource_downloads FOR SELECT USING (auth.uid() = user_id);`,
            `CREATE POLICY "resource_downloads_insert_own" ON resource_downloads FOR INSERT WITH CHECK (auth.uid() = user_id);`,
            `CREATE POLICY "resource_views_insert_own" ON resource_views FOR INSERT WITH CHECK (auth.uid() = user_id);`
        ];

        for (const policySql of policies) {
            try {
                // Use CREATE POLICY IF NOT EXISTS pattern: wrap in DO block to avoid duplicate errors
                await supabase.rpc('exec_sql', {
                    sql: `DO $$ BEGIN ${policySql.replace(/;$/, '')} EXCEPTION WHEN duplicate_object THEN NULL; END $$;`
                });
            } catch (applyErr) {
                // Fallback: try plain create (first run)
                try {
                    await supabase.rpc('exec_sql', { sql: policySql });
                } catch (err) {
                    console.error(`Policy creation warning:`, err.message);
                }
            }
        }
        console.log('✅ RLS policies applied (note: backend uses service-role key which bypasses RLS)');

        // ============================================
        // 4. CREATE STORAGE BUCKETS
        // ============================================

        console.log('\n📦 Creating storage buckets...');

        const buckets = [
            'resources',
            'timetables',
            'profile-pictures',
            'event-images',
            'payment-proofs',
            'voting-photos'
        ];

        for (const bucket of buckets) {
            try {
                const { error } = await supabase.storage.createBucket(bucket, {
                    public: true,
                    allowedMimeTypes: ['image/*', 'application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.*', 'text/*'],
                    fileSizeLimit: 10 * 1024 * 1024 // 10MB
                });
                if (error && error.message !== 'Bucket already exists') {
                    console.error(`Bucket creation failed for ${bucket}:`, error);
                } else {
                    console.log(`✅ ${bucket} bucket ready`);
                }
            } catch (err) {
                console.error(`Bucket creation failed for ${bucket}:`, err.message);
            }
        }

        // ============================================
        // 5. CREATE ADDITIONAL HELPER FUNCTIONS
        // ============================================

        console.log('\n⚡ Ensuring helper functions (idempotent OR REPLACE)...');

        // Function to safely execute arbitrary SQL via rpc
        try {
            await supabase.rpc('exec_sql', {
                sql: `
                    CREATE OR REPLACE FUNCTION create_table_if_not_exists(
                        table_name text,
                        table_definition text
                    ) RETURNS void AS $$
                    BEGIN
                        IF NOT EXISTS (
                            SELECT FROM information_schema.tables 
                            WHERE table_schema = 'public' 
                            AND table_name = create_table_if_not_exists.table_name
                        ) THEN
                            EXECUTE 'CREATE TABLE ' || quote_ident(table_name) || ' (' || table_definition || ');';
                        END IF;
                    END;
                    $$ LANGUAGE plpgsql;
                `
            });
            console.log('✅ Helper functions ready');
        } catch (err) {
            console.error('Function creation error:', err.message);
        }

        console.log('\n✅ Migration completed successfully!');

    } catch (error) {
        console.error('❌ Migration failed:', error);
        process.exit(1);
    }
}

// Run migration
migrate();