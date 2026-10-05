// backend/scripts/apply-indexes.js
require('dotenv').config();
const { supabase } = require('../config/supabase');

const INDEX_QUERIES = [
    'CREATE INDEX IF NOT EXISTS idx_students_user_id ON students(user_id);',
    'CREATE INDEX IF NOT EXISTS idx_students_email ON students(email);',
    'CREATE INDEX IF NOT EXISTS idx_students_matric_no ON students(matric_no);',
    'CREATE INDEX IF NOT EXISTS idx_students_status ON students(status);',
    'CREATE INDEX IF NOT EXISTS idx_admin_users_user_id ON admin_users(user_id);',
    'CREATE INDEX IF NOT EXISTS idx_events_date ON events(date);',
    'CREATE INDEX IF NOT EXISTS idx_events_is_active ON events(is_active);',
    'CREATE INDEX IF NOT EXISTS idx_event_reg_event_user ON event_registrations(event_id, user_id);',
    'CREATE INDEX IF NOT EXISTS idx_event_reg_user_id ON event_registrations(user_id);',
    'CREATE INDEX IF NOT EXISTS idx_event_reg_payment_id ON event_registrations(linked_payment_id);',
    'CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);',
    'CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments(user_id);',
    'CREATE INDEX IF NOT EXISTS idx_payments_event_id ON payments(event_id);',
    'CREATE INDEX IF NOT EXISTS idx_payments_submitted_at ON payments(submitted_at);',
    'CREATE INDEX IF NOT EXISTS idx_voting_pos_active ON voting_positions(is_active);',
    'CREATE INDEX IF NOT EXISTS idx_voting_cand_position ON voting_candidates(position_id);',
    'CREATE INDEX IF NOT EXISTS idx_votes_voter_id ON votes(voter_id);',
    'CREATE INDEX IF NOT EXISTS idx_votes_position_id ON votes(position_id);',
    'CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);',
    'CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp);',
    'CREATE INDEX IF NOT EXISTS idx_resources_type ON academic_resources(resource_type);',
    'CREATE INDEX IF NOT EXISTS idx_timetables_department ON timetables(department);',
    'CREATE INDEX IF NOT EXISTS idx_resource_views_resource_id ON resource_views(resource_id);',
    'CREATE INDEX IF NOT EXISTS idx_resource_downloads_resource_id ON resource_downloads(resource_id);'
];

async function applyIndexes() {
    console.log('🚀 Applying database performance indexes...');
    let successCount = 0;
    let skipCount = 0;

    for (const sql of INDEX_QUERIES) {
        try {
            const { error } = await supabase.rpc('exec_sql', { sql });
            if (error) {
                console.warn(`⚠️  Could not run via exec_sql: ${error.message}`);
                skipCount++;
            } else {
                successCount++;
            }
        } catch (e) {
            console.warn(`⚠️  Execution failed for "${sql.substring(0, 45)}...":`, e.message);
            skipCount++;
        }
    }

    console.log(`\n🏁 Done: ${successCount} indexes confirmed/created, ${skipCount} skipped or need direct SQL Editor execution.`);
    if (skipCount > 0) {
        console.log('💡 Tip: If exec_sql RPC is not enabled, copy backend/migrations/011_performance_indexes.sql directly into Supabase Dashboard -> SQL Editor.');
    }
}

applyIndexes()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error('Fatal index script error:', err);
        process.exit(1);
    });
