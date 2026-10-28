// backend/scripts/migrate-012-analytics.js
require('dotenv').config();
const { supabase } = require('../config/supabase');
const fs = require('fs');
const path = require('path');

async function runMigration() {
  console.log('🚀 Running Migration 012: Resource Activity Analytics...');

  const sqlFile = path.join(__dirname, '..', 'migrations', '012_resource_activity_analytics.sql');
  const sql = fs.readFileSync(sqlFile, 'utf8');

  // Try via exec_sql RPC
  try {
    const { error } = await supabase.rpc('exec_sql', { sql_string: sql });
    if (!error) {
      console.log('✅ Migration 012 applied successfully via exec_sql(sql_string)!');
      return;
    }
  } catch (e) {
    // try fallback parameter name
  }

  try {
    const { error: err2 } = await supabase.rpc('exec_sql', { sql: sql });
    if (!err2) {
      console.log('✅ Migration 012 applied successfully via exec_sql(sql)!');
      return;
    }
    console.warn('⚠️  Could not run via exec_sql RPC:', err2.message);
  } catch (err) {
    console.warn('⚠️  exec_sql error:', err.message);
  }

  // Fallback: check if table can be queried directly
  const { data, error: testErr } = await supabase.from('resource_activity_logs').select('id').limit(1);
  if (!testErr) {
    console.log('✅ resource_activity_logs table already exists and is accessible!');
  } else {
    console.log('\n📋 If the table does not exist, run backend/migrations/012_resource_activity_analytics.sql in Supabase SQL Editor.');
  }
}

runMigration()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('Migration error:', e);
    process.exit(1);
  });
