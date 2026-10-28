// backend/scripts/bulk-send-reset-emails.js
//
// Sends a Supabase password-reset email to every student whose account
// was bulk-imported (i.e. status = 'active' but has never logged in, so
// they still have the temporary NACOSImport@ password).
//
// USAGE:
//   node scripts/bulk-send-reset-emails.js
//
// Safe to re-run — students who have already reset their password won't
// be harmed by receiving another reset email.

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL              = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON_KEY          = process.env.SUPABASE_ANON_KEY;
const FRONTEND_URL               = process.env.FRONTEND_URL || 'https://nacosportal.vercel.app';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_ANON_KEY) {
  console.error('❌  Missing env vars. Check SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY in .env');
  process.exit(1);
}

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});
const supabaseAnon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function run() {
  console.log('\n📧  Fetching all active students...');
  const { data: students, error } = await supabaseAdmin
    .from('students')
    .select('email')
    .eq('status', 'active')
    .order('created_at', { ascending: true });

  if (error) {
    console.error('❌  Failed to fetch students:', error.message);
    process.exit(1);
  }

  console.log(`    Found ${students.length} active students.\n`);

  let sent = 0, failed = 0;

  for (let i = 0; i < students.length; i++) {
    const { email } = students[i];
    process.stdout.write(`  [${i + 1}/${students.length}] ${email} ... `);

    try {
      const { error: resetErr } = await supabaseAnon.auth.resetPasswordForEmail(email, {
        redirectTo: `${FRONTEND_URL}/reset-password.html`
      });

      if (resetErr) {
        console.log(`❌  ${resetErr.message}`);
        failed++;
      } else {
        console.log('✅  Sent');
        sent++;
      }
    } catch (err) {
      console.log(`❌  ${err.message}`);
      failed++;
    }

    // Supabase free tier: ~2 emails/sec; throttle to stay safe
    await sleep(600);
  }

  console.log('\n' + '='.repeat(50));
  console.log(`  ✅  Sent    : ${sent}`);
  console.log(`  ❌  Failed  : ${failed}`);
  console.log('='.repeat(50) + '\n');
}

run().catch(err => {
  console.error('❌  Unexpected error:', err.message);
  process.exit(1);
});
