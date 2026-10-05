// backend/scripts/apply-hackathons.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { supabase } = require('../config/supabase');

async function applyHackathonsMigration() {
    console.log('🚀 Running Hackathons & Pitchathons migration...');

    const migrationFile = path.join(__dirname, '../migrations/012_hackathons.sql');
    if (!fs.existsSync(migrationFile)) {
        console.error('❌ Migration file 012_hackathons.sql not found at:', migrationFile);
        process.exit(1);
    }

    const sqlContent = fs.readFileSync(migrationFile, 'utf8');

    try {
        const { error } = await supabase.rpc('exec_sql', { sql: sqlContent });
        if (error) {
            console.warn(`⚠️  exec_sql RPC execution notice: ${error.message}`);
            console.log('\n💡 Please copy the contents of "backend/migrations/012_hackathons.sql"');
            console.log('   into the Supabase Dashboard -> SQL Editor to run directly.');
        } else {
            console.log('✅ Hackathons migration executed successfully via exec_sql RPC!');
        }
    } catch (e) {
        console.warn('⚠️  Could not run via exec_sql:', e.message);
        console.log('\n💡 Direct execution instructions:');
        console.log('   1. Open Supabase Dashboard');
        console.log('   2. Navigate to SQL Editor');
        console.log('   3. Paste and run backend/migrations/012_hackathons.sql');
    }
}

applyHackathonsMigration()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error('Fatal error applying migration:', err);
        process.exit(1);
    });
