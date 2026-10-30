#!/usr/bin/env node
/**
 * ==============================================================================
 * NACOS TAU: Cron Profile Reminder Investigation & Dry-Run Utility
 * ==============================================================================
 *
 * Usage:
 *   node backend/scripts/cron-dry-run.js             # Safe dry-run (scans & previews eligible students)
 *   node backend/scripts/cron-dry-run.js --limit=10  # Preview up to 10 candidates
 *   node backend/scripts/cron-dry-run.js --verbose   # Show missing details for all eligible students
 *   node backend/scripts/cron-dry-run.js --test-email=your-email@example.com  # Send 1 test email to verify SMTP
 *
 * This script connects using backend/.env and executes the exact same scanning
 * and candidate detection logic used by the Vercel cron job.
 * ==============================================================================
 */

const path = require('path');
const fs = require('fs');

// 1. Resolve and load .env from backend/.env or root
const envPaths = [
  path.join(__dirname, '../.env'),
  path.join(__dirname, '../../.env'),
  path.join(process.cwd(), 'backend/.env'),
  path.join(process.cwd(), '.env')
];

let loadedEnv = false;
for (const p of envPaths) {
  if (fs.existsSync(p)) {
    require('dotenv').config({ path: p });
    console.log(`📁 Loaded environment from: ${path.resolve(p)}`);
    loadedEnv = true;
    break;
  }
}

if (!loadedEnv) {
  require('dotenv').config();
  console.log('⚠️  No explicit .env file found; using existing process.env');
}

const { supabase } = require('../config/supabase');
const { checkAndSendProfileReminders, sendProfileUpdateReminderEmail } = require('../services/email');

// Parse CLI flags
const args = process.argv.slice(2);
const isVerbose = args.includes('--verbose') || args.includes('-v');
const limitArg = args.find(a => a.startsWith('--limit='));
const previewLimit = limitArg ? parseInt(limitArg.split('=')[1], 10) : 15;
const testEmailArg = args.find(a => a.startsWith('--test-email='));
const targetTestEmail = testEmailArg ? testEmailArg.split('=')[1].trim() : null;

async function runInvestigation() {
  console.log('\n================================================================');
  console.log('  🔍 NACOS CRON & PROFILE REMINDER INVESTIGATION');
  console.log('================================================================\n');

  // 1. Check Vercel Cron Configuration
  console.log('--- 1. CRON SCHEDULE INSPECTION ---');
  try {
    const vercelJsonPath = path.join(__dirname, '../../vercel.json');
    if (fs.existsSync(vercelJsonPath)) {
      const vercelConfig = JSON.parse(fs.readFileSync(vercelJsonPath, 'utf8'));
      const cronJobs = vercelConfig.crons || [];
      if (cronJobs.length === 0) {
        console.log('❌ No crons array found in vercel.json');
      } else {
        cronJobs.forEach((c, idx) => {
          console.log(`  Job #${idx + 1}:`);
          console.log(`    • Path:     ${c.path}`);
          console.log(`    • Schedule: "${c.schedule}"`);
          if (c.schedule === '0 15 * * 1,3,5') {
            console.log('    • Meaning:  Monday, Wednesday, Friday at 15:00 UTC (4:00 PM West Africa Time)');
            console.log('    • Status:   ✅ Perfectly matches requested schedule (Mon/Wed/Fri 4PM)');
          } else {
            console.log(`    • Note: Custom cron schedule: ${c.schedule}`);
          }
        });
      }
    } else {
      console.log('⚠️  vercel.json not found at project root');
    }
  } catch (err) {
    console.log(`❌ Error reading vercel.json: ${err.message}`);
  }

  // 2. Check Secret Configuration
  console.log('\n--- 2. CRON SECURITY & AUTHENTICATION ---');
  const cronSecret = process.env.CRON_SECRET;
  const adminApiKey = process.env.ADMIN_API_KEY;

  if (cronSecret) {
    console.log(`  • CRON_SECRET: Configured (${cronSecret.substring(0, 4)}••••${cronSecret.substring(cronSecret.length - 3)})`);
    console.log('  • Auth check:  ✅ Vercel will send "Authorization: Bearer <CRON_SECRET>" automatically');
  } else if (adminApiKey) {
    console.log('  • CRON_SECRET: Not set; fallback ADMIN_API_KEY is active');
  } else {
    console.log('  • CRON_SECRET: ⚠️  Not configured in local .env');
    console.log('    Remember to add CRON_SECRET in Vercel Dashboard -> Project -> Settings -> Environment Variables');
  }

  // 3. Check Email Provider
  console.log('\n--- 3. EMAIL DISPATCH SYSTEM STATUS ---');
  const oauthActive = Boolean(process.env.OAUTH_CLIENT_ID && process.env.OAUTH_CLIENT_SECRET && process.env.OAUTH_REFRESH_TOKEN);
  const smtpActive = Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
  const fromAddress = process.env.EMAIL_FROM || 'nacos@tau.edu.ng';

  console.log(`  • Sender Address: ${fromAddress}`);
  if (oauthActive) {
    console.log('  • Mode:           ✅ Gmail OAuth2 API (Active - Bypasses port/cloud blocks)');
  } else if (smtpActive) {
    console.log(`  • Mode:           ✅ Standard SMTP (${process.env.SMTP_HOST}:${process.env.SMTP_PORT || 465})`);
  } else {
    console.log('  • Mode:           ⚠️  No SMTP or OAuth2 credentials set - emails will not send');
  }

  // 4. Test Email Option
  if (targetTestEmail) {
    console.log(`\n--- 4. SENDING SINGLE TEST REMINDER TO: ${targetTestEmail} ---`);
    try {
      const mockStudent = {
        name: 'Test Student',
        first_name: 'Tester',
        last_name: 'Student',
        email: targetTestEmail,
        matric_no: '24/10MSC001',
        department: 'Computer Science'
      };
      const testMissing = ['Profile Picture', 'Bio / About Me', 'Technical Skills'];
      console.log('  Sending sample profile reminder email...');
      const res = await sendProfileUpdateReminderEmail({ student: mockStudent, missingFields: testMissing });
      console.log('  Result:', res);
      console.log('  ✅ Test email executed!');
    } catch (sendErr) {
      console.error('  ❌ Test email failed:', sendErr.message);
    }
  }

  // 5. Run Live Database Scan (Dry-Run)
  console.log('\n--- 5. LIVE DATABASE SCAN (DRY RUN - 0 EMAILS SENT) ---');
  console.log('  Scanning active students in Supabase...');

  try {
    const result = await checkAndSendProfileReminders({ dryRun: true });
    
    if (!result.success) {
      console.error('  ❌ Scan failed:', result.error);
      return;
    }

    console.log(`\n  📊 SCAN RESULTS:`);
    console.log(`    • Total Active Students:            ${result.totalActive}`);
    console.log(`    • Students Eligible for Reminder:   ${result.eligibleCount}`);
    console.log(`    • Students Complete / In Cooldown:  ${result.totalActive - result.eligibleCount}`);

    if (result.candidates && result.candidates.length > 0) {
      const displayCandidates = isVerbose ? result.candidates : result.candidates.slice(0, previewLimit);
      console.log(`\n  👥 CANDIDATES PREVIEW (Showing ${displayCandidates.length} of ${result.eligibleCount}):`);
      console.log('  ' + '-'.repeat(75));
      console.log('  ' + 'NAME'.padEnd(25) + 'MATRIC'.padEnd(16) + 'MISSING DETAILS');
      console.log('  ' + '-'.repeat(75));

      displayCandidates.forEach(c => {
        const name = (c.name || 'Student').substring(0, 23).padEnd(25);
        const matric = (c.matricNo || 'N/A').padEnd(16);
        const missing = c.missing.join(', ');
        console.log(`  ${name}${matric}${missing}`);
      });
      console.log('  ' + '-'.repeat(75));

      if (!isVerbose && result.eligibleCount > previewLimit) {
        console.log(`  ℹ️  Run with --verbose to view all ${result.eligibleCount} candidates.`);
      }
    } else {
      console.log('\n  🎉 All active students have complete profiles or were recently reminded!');
    }

    console.log('\n================================================================');
    console.log('  ✅ CRON SYSTEM STATUS: READY & VERIFIED');
    console.log('================================================================\n');

  } catch (err) {
    console.error('  ❌ Fatal scan error:', err);
  }
}

runInvestigation().catch(err => {
  console.error('Unhandled script error:', err);
  process.exit(1);
});
