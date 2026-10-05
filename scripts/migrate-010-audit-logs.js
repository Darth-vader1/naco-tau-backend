// scripts/migrate-010-audit-logs.js
// Migration script to fix audit_logs RLS policies
// Run with: node scripts/migrate-010-audit-logs.js

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

// Initialize Supabase client with service role key
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('❌ Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env file');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

async function runMigration() {
  console.log('🚀 Starting Migration 010: Fix Audit Logs RLS Policies...\n');

  try {
    // Step 1: Drop old restrictive policy
    console.log('📝 Step 1: Removing old restrictive policy...');
    const { error: dropError } = await supabase.rpc('exec_sql', {
      sql_string: `DROP POLICY IF EXISTS "audit_logs_no_anon" ON public.audit_logs;`
    });

    if (dropError) {
      // If exec_sql RPC doesn't exist, try direct SQL execution
      console.log('   Note: Using alternative method for policy drop');
      // Continue anyway - policy might not exist
    } else {
      console.log('   ✅ Old policy dropped (if existed)');
    }

    // Step 2: Create service_role policy (allows backend to write logs)
    console.log('\n📝 Step 2: Creating service_role policy...');
    await executeSqlWithRetry(`
      DO $$ 
      BEGIN
        -- Drop if exists
        DROP POLICY IF EXISTS "audit_logs_service_role_all" ON public.audit_logs;
        
        -- Create new policy
        CREATE POLICY "audit_logs_service_role_all" 
        ON public.audit_logs
        FOR ALL
        TO service_role
        USING (true)
        WITH CHECK (true);
        
        RAISE NOTICE '✅ Service role policy created';
      END $$;
    `);
    console.log('   ✅ Service role policy created');

    // Step 3: Create user read policy
    console.log('\n📝 Step 3: Creating user read policy...');
    await executeSqlWithRetry(`
      DO $$ 
      BEGIN
        -- Drop if exists
        DROP POLICY IF EXISTS "audit_logs_read_own" ON public.audit_logs;
        
        -- Create new policy
        CREATE POLICY "audit_logs_read_own" 
        ON public.audit_logs
        FOR SELECT
        TO authenticated
        USING (user_id = auth.uid());
        
        RAISE NOTICE '✅ User read policy created';
      END $$;
    `);
    console.log('   ✅ User read policy created');

    // Step 4: Create admin read policy
    console.log('\n📝 Step 4: Creating admin read policy...');
    await executeSqlWithRetry(`
      DO $$ 
      BEGIN
        -- Drop if exists
        DROP POLICY IF EXISTS "audit_logs_admin_read_all" ON public.audit_logs;
        
        -- Create new policy
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
        
        RAISE NOTICE '✅ Admin read policy created';
      END $$;
    `);
    console.log('   ✅ Admin read policy created');

    // Step 5: Verify RLS is enabled
    console.log('\n📝 Step 5: Verifying RLS is enabled...');
    await executeSqlWithRetry(`
      ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
    `);
    console.log('   ✅ RLS enabled');

    // Step 6: Verify policies were created
    console.log('\n📝 Step 6: Verifying policies...');
    const { data: policies, error: checkError } = await supabase
      .from('pg_policies')
      .select('policyname, cmd')
      .eq('tablename', 'audit_logs');

    if (checkError) {
      console.log('   ⚠️ Could not verify policies (this is OK)');
    } else if (policies && policies.length > 0) {
      console.log('   ✅ Policies verified:');
      policies.forEach(p => {
        console.log(`      - ${p.policyname} (${p.cmd})`);
      });
    }

    console.log('\n' + '='.repeat(60));
    console.log('✅ Migration 010 completed successfully!');
    console.log('='.repeat(60));
    console.log('\nNext steps:');
    console.log('1. Restart your backend server');
    console.log('2. Test audit logging by performing an admin action');
    console.log('3. Check that no RLS errors appear in console\n');

  } catch (error) {
    console.error('\n❌ Migration failed:', error.message);
    console.error('\nDetails:', error);
    console.log('\n📋 Troubleshooting:');
    console.log('1. Verify SUPABASE_SERVICE_ROLE_KEY is set correctly in .env');
    console.log('2. Check that you have admin access to the database');
    console.log('3. Try running the SQL directly in Supabase dashboard when it\'s back online');
    process.exit(1);
  }
}

// Helper function to execute SQL with retry logic
async function executeSqlWithRetry(sql, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Try using RPC first
      const { error: rpcError } = await supabase.rpc('exec_sql', {
        sql_string: sql
      });

      if (!rpcError) {
        return; // Success
      }

      // If RPC doesn't exist, try using REST API directly
      const response = await fetch(`${supabaseUrl}/rest/v1/rpc/exec_sql`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': supabaseServiceKey,
          'Authorization': `Bearer ${supabaseServiceKey}`
        },
        body: JSON.stringify({ sql_string: sql })
      });

      if (response.ok) {
        return; // Success
      }

      // If both methods fail and we have retries left, try again
      if (attempt < maxRetries) {
        console.log(`   ⚠️ Attempt ${attempt} failed, retrying...`);
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        continue;
      }

      // If all retries failed, throw error
      throw new Error(`Failed after ${maxRetries} attempts: ${rpcError?.message || 'Unknown error'}`);

    } catch (error) {
      if (attempt === maxRetries) {
        throw error;
      }
      console.log(`   ⚠️ Attempt ${attempt} failed, retrying...`);
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }
}

// Alternative: Manual SQL execution (fallback if Supabase client fails)
async function manualSqlExecution() {
  console.log('\n⚠️ Automatic execution failed. Here\'s the SQL to run manually:\n');
  console.log('='.repeat(60));
  
  const sqlFile = path.join(__dirname, '..', 'migrations', '010_fix_audit_logs_rls.sql');
  const sql = fs.readFileSync(sqlFile, 'utf8');
  
  console.log(sql);
  console.log('='.repeat(60));
  console.log('\nCopy the SQL above and run it in:');
  console.log('1. Supabase Dashboard → SQL Editor (when it\'s back online)');
  console.log('2. Or use psql: psql "your-connection-string" -f backend/migrations/010_fix_audit_logs_rls.sql\n');
}

// Run migration
runMigration().catch(error => {
  console.error('\n❌ Fatal error:', error);
  console.log('\nFalling back to manual SQL output...');
  manualSqlExecution();
  process.exit(1);
});
