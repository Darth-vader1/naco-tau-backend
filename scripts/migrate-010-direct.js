// scripts/migrate-010-direct.js
// Direct PostgreSQL migration for audit_logs RLS policies
// Run with: node scripts/migrate-010-direct.js

require('dotenv').config();
const fs = require('fs');
const path = require('path');

console.log('🚀 Starting Migration 010: Fix Audit Logs RLS Policies...\n');

// Check if pg module is available
let pg;
try {
  pg = require('pg');
} catch (error) {
  console.error('❌ PostgreSQL module not found. Installing...\n');
  console.log('Run this command first:');
  console.log('  npm install pg\n');
  console.log('Then run this script again.\n');
  showManualSql();
  process.exit(1);
}

const { Client } = pg;

// Get connection details from environment
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl) {
  console.error('❌ SUPABASE_URL not found in .env file\n');
  showManualSql();
  process.exit(1);
}

// Extract host from Supabase URL
// Format: https://xxx.supabase.co -> xxx.supabase.co
const host = supabaseUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
const projectRef = host.split('.')[0];

// Construct PostgreSQL connection string
// Supabase format: postgresql://postgres:[PASSWORD]@db.[PROJECT-REF].supabase.co:5432/postgres
const connectionString = process.env.DATABASE_URL || 
  `postgresql://postgres.${projectRef}:${supabaseKey}@aws-0-us-east-1.pooler.supabase.com:6543/postgres`;

console.log('📡 Connecting to database...');
console.log(`   Host: db.${projectRef}.supabase.co\n`);

const client = new Client({
  connectionString: connectionString,
  ssl: { rejectUnauthorized: false }
});

async function runMigration() {
  try {
    await client.connect();
    console.log('✅ Connected to database\n');

    // Read migration SQL file
    const sqlFile = path.join(__dirname, '..', 'migrations', '010_fix_audit_logs_rls.sql');
    const sql = fs.readFileSync(sqlFile, 'utf8');

    // Split SQL into individual statements
    const statements = sql
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('--') && !s.startsWith('DO $$'));

    console.log('📝 Executing migration steps...\n');

    // Execute migration
    try {
      // Step 1: Drop old policy
      console.log('   Step 1: Dropping old restrictive policy...');
      await client.query(`DROP POLICY IF EXISTS "audit_logs_no_anon" ON public.audit_logs;`);
      console.log('   ✅ Done\n');

      // Step 2: Create service_role policy
      console.log('   Step 2: Creating service_role policy...');
      await client.query(`
        CREATE POLICY "audit_logs_service_role_all" 
        ON public.audit_logs
        FOR ALL
        TO service_role
        USING (true)
        WITH CHECK (true);
      `);
      console.log('   ✅ Done\n');

      // Step 3: Create user read policy
      console.log('   Step 3: Creating user read policy...');
      await client.query(`
        CREATE POLICY "audit_logs_read_own" 
        ON public.audit_logs
        FOR SELECT
        TO authenticated
        USING (user_id = auth.uid());
      `);
      console.log('   ✅ Done\n');

      // Step 4: Create admin read policy
      console.log('   Step 4: Creating admin read policy...');
      await client.query(`
        CREATE POLICY "audit_logs_admin_read_all" 
        ON public.audit_logs
        FOR SELECT
        TO authenticated
        USING (
          EXISTS (
            SELECT 1 FROM public.admin_users
            WHERE admin_users.user_id = auth.uid()
          )
        );
      `);
      console.log('   ✅ Done\n');

      // Step 5: Enable RLS
      console.log('   Step 5: Ensuring RLS is enabled...');
      await client.query(`ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;`);
      console.log('   ✅ Done\n');

      // Verify policies
      console.log('   Step 6: Verifying policies...');
      const result = await client.query(`
        SELECT schemaname, tablename, policyname, cmd
        FROM pg_policies 
        WHERE tablename = 'audit_logs'
        ORDER BY policyname;
      `);

      if (result.rows.length > 0) {
        console.log('   ✅ Policies found:');
        result.rows.forEach(row => {
          console.log(`      - ${row.policyname} (${row.cmd})`);
        });
      } else {
        console.log('   ⚠️ No policies found (this might indicate an issue)');
      }

    } catch (error) {
      if (error.message.includes('already exists')) {
        console.log('   ℹ️ Policy already exists (skipping)');
      } else {
        throw error;
      }
    }

    console.log('\n' + '='.repeat(60));
    console.log('✅ Migration 010 completed successfully!');
    console.log('='.repeat(60));
    console.log('\n📋 Next steps:');
    console.log('1. Restart your backend server: node server.js');
    console.log('2. Test by performing an admin action (e.g., delete student)');
    console.log('3. Verify no RLS errors in console\n');

  } catch (error) {
    console.error('\n❌ Migration failed:', error.message);
    console.error('\nFull error:', error);
    console.log('\n📋 Troubleshooting:');
    console.log('1. Check if Supabase is accessible');
    console.log('2. Verify your DATABASE_URL or SUPABASE credentials in .env');
    console.log('3. Try the manual SQL below when Supabase is back:\n');
    showManualSql();
  } finally {
    await client.end();
  }
}

function showManualSql() {
  console.log('='.repeat(60));
  console.log('📄 MANUAL SQL (copy and run in Supabase SQL Editor)');
  console.log('='.repeat(60));
  console.log(`
-- Migration 010: Fix Audit Logs RLS Policies

-- Step 1: Drop old policy
DROP POLICY IF EXISTS "audit_logs_no_anon" ON public.audit_logs;

-- Step 2: Create service_role policy (allows backend to write)
CREATE POLICY "audit_logs_service_role_all" 
ON public.audit_logs
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- Step 3: Create user read policy
CREATE POLICY "audit_logs_read_own" 
ON public.audit_logs
FOR SELECT
TO authenticated
USING (user_id = auth.uid());

-- Step 4: Create admin read policy
CREATE POLICY "audit_logs_admin_read_all" 
ON public.audit_logs
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.admin_users
    WHERE admin_users.user_id = auth.uid()
  )
);

-- Step 5: Enable RLS
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
`);
  console.log('='.repeat(60));
  console.log('\nRun this SQL when Supabase dashboard is back online.\n');
}

// Run migration
runMigration().catch(error => {
  console.error('\n❌ Fatal error:', error);
  process.exit(1);
});
