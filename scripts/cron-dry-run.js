#!/usr/bin/env node
/**
 * ==============================================================================
 * NACOS TAU: Cron Profile Reminder Investigation & Dry-Run Utility
 * ==============================================================================
 *
 * Usage:
 *   node backend/scripts/cron-dry-run.js                     # Standard scan with cooldown breakdown
 *   node backend/scripts/cron-dry-run.js --ignore-cooldown   # Show ALL incomplete profiles ignoring 44h cooldown
 *   node backend/scripts/cron-dry-run.js --reset-cooldown    # Clear reminder audit logs to reset cooldown
 *   node backend/scripts/cron-dry-run.js --verbose           # Show full candidate list
 *   node backend/scripts/cron-dry-run.js --test-email=you@tau.edu.ng  # Test real email delivery
 * ==============================================================================
 */

const path = require('path');
const fs = require('fs');

// 1. Resolve and load .env
const envPaths = [
  path.join(__dirname, '../.env'),
  path.join(__dirname, '../../.env'),
  path.join(process.cwd(), 'backend/.env'),
  path.join(process.cwd(), '.env')
];

for (const p of envPaths) {
  if (fs.existsSync(p)) {
    require('dotenv').config({ path: p });
    console.log(`📁 Loaded environment from: ${path.resolve(p)}`);
    break;
  }
}

const { supabase } = require('../config/supabase');
const { checkAndSendProfileReminders, sendProfileUpdateReminderEmail } = require('../services/email');

// Parse CLI flags
const args = process.argv.slice(2);
const isVerbose = args.includes('--verbose') || args.includes('-v');
const ignoreCooldown = args.includes('--ignore-cooldown') || args.includes('-f');
const resetCooldown = args.includes('--reset-cooldown');
const sendLive = args.includes('--send-live');
const limitArg = args.find(a => a.startsWith('--limit='));
const previewLimit = limitArg ? parseInt(limitArg.split('=')[1], 10) : 15;
const batchLimit = limitArg ? parseInt(limitArg.split('=')[1], 10) : 50;
const testEmailArg = args.find(a => a.startsWith('--test-email='));
const targetTestEmail = testEmailArg ? testEmailArg.split('=')[1].trim() : null;

async function runInvestigation() {
  console.log('\n================================================================');
  console.log('  🔍 NACOS CRON & PROFILE REMINDER INVESTIGATION');
  console.log('================================================================\n');

  // Option: Reset Cooldown
  if (resetCooldown) {
    console.log('--- ⚠️  RESETTING REMINDER COOLDOWN IN AUDIT LOGS ---');
    const { data, error } = await supabase
      .from('audit_logs')
      .delete()
      .eq('action', 'profile_reminder_email_sent');

    if (error) {
      console.error('❌ Failed to clear reminder logs:', error.message);
    } else {
      console.log('✅ Cooldown cleared! All reminder audit logs have been reset.');
    }
    console.log('');
  }

  // 1. Check Vercel Cron Configuration
  console.log('--- 1. CRON SCHEDULE INSPECTION ---');
  try {
    const vercelJsonPath = path.join(__dirname, '../../vercel.json');
    if (fs.existsSync(vercelJsonPath)) {
      const vercelConfig = JSON.parse(fs.readFileSync(vercelJsonPath, 'utf8'));
      const cronJobs = vercelConfig.crons || [];
      cronJobs.forEach((c, idx) => {
        console.log(`  Job #${idx + 1}: Path: ${c.path} | Schedule: "${c.schedule}" (Mon, Wed, Fri at 4:00 PM WAT)`);
      });
    }
  } catch (err) {
    console.log(`❌ Error reading vercel.json: ${err.message}`);
  }

  // 2. Email Provider Status
  console.log('\n--- 2. EMAIL SENDER STATUS ---');
  const oauthActive = Boolean(process.env.OAUTH_CLIENT_ID && process.env.OAUTH_CLIENT_SECRET && process.env.OAUTH_REFRESH_TOKEN);
  const fromAddress = process.env.EMAIL_FROM || 'nacos@tau.edu.ng';
  console.log(`  • Sender: ${fromAddress}`);
  console.log(`  • Engine: ${oauthActive ? '✅ Gmail OAuth2 API' : '⚠️ SMTP/Unconfigured'}`);

  // 3. Test Email
  if (targetTestEmail) {
    console.log(`\n--- 3. SENDING REAL TEST EMAIL TO: ${targetTestEmail} ---`);
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
      const res = await sendProfileUpdateReminderEmail({ student: mockStudent, missingFields: testMissing });
      console.log('  Result:', res);
      console.log('  ✅ Test email delivered!');
    } catch (sendErr) {
      console.error('  ❌ Test email failed:', sendErr.message);
    }
  }

  // 4. Detailed Student & Cooldown Analysis
  console.log('\n--- 4. LIVE DATABASE PROFILE ANALYSIS ---');
  console.log('  Fetching all active students from Supabase...');

  const { data: students, error: stErr } = await supabase
    .from('students')
    .select('id, user_id, email, name, first_name, last_name, matric_no, department, bio, skills, interests, phone, profile_picture_url, linkedin, github, status')
    .eq('status', 'active')
    .order('created_at', { ascending: false });

  if (stErr || !students) {
    console.error('❌ Failed to fetch students:', stErr?.message);
    return;
  }

  // Load reminder audit logs for 44-hour cooldown
  const cooldownHours = 44;
  const cooldownThresholdIso = new Date(Date.now() - cooldownHours * 60 * 60 * 1000).toISOString();
  const { data: recentLogs, error: logErr } = await supabase
    .from('audit_logs')
    .select('user_id, user_email, timestamp')
    .eq('action', 'profile_reminder_email_sent')
    .gte('timestamp', cooldownThresholdIso);

  const recentlyRemindedUserIds = new Set((recentLogs || []).map(l => l.user_id).filter(Boolean));
  const recentlyRemindedEmails = new Set((recentLogs || []).map(l => (l.user_email || '').toLowerCase().trim()).filter(Boolean));

  // Check all reminder logs ever sent
  const { count: totalEverSent } = await supabase
    .from('audit_logs')
    .select('id', { count: 'exact', head: true })
    .eq('action', 'profile_reminder_email_sent');

  let completeCount = 0;
  let incompleteCount = 0;
  let inCooldownCount = 0;
  let readyToSend = [];
  let inCooldownList = [];

  students.forEach(s => {
    const emailLower = (s.email || '').toLowerCase().trim();
    const isUnderCooldown = Boolean(
      (s.user_id && recentlyRemindedUserIds.has(s.user_id)) ||
      (emailLower && recentlyRemindedEmails.has(emailLower))
    );

    const missing = [];
    const hasBio = s.bio && String(s.bio).trim().length >= 10;
    
    let skillsList = [];
    if (Array.isArray(s.skills)) {
      skillsList = s.skills;
    } else if (typeof s.skills === 'string' && s.skills.trim()) {
      try { skillsList = JSON.parse(s.skills); } catch (_) { skillsList = s.skills.split(',').map(x => x.trim()).filter(Boolean); }
    }
    const hasSkills = Array.isArray(skillsList) && skillsList.length > 0;
    const hasPfp = s.profile_picture_url && !s.profile_picture_url.includes('tau_logo');
    const hasPhone = s.phone && String(s.phone).trim().length >= 8;
    const hasSocial = Boolean(s.linkedin || s.github);

    if (!hasPfp) missing.push('Profile Picture');
    if (!hasBio) missing.push('Bio / About Me');
    if (!hasSkills) missing.push('Technical Skills');
    if (!hasSocial) missing.push('LinkedIn or GitHub');
    if (!hasPhone) missing.push('Phone Number');

    const isIncomplete = missing.length >= 2;

    if (!isIncomplete) {
      completeCount++;
    } else {
      incompleteCount++;
      const candidateInfo = {
        name: `${s.first_name || ''} ${s.last_name || ''}`.trim() || s.name || 'Student',
        matric: s.matric_no || 'N/A',
        email: s.email,
        missing: missing,
        isUnderCooldown
      };

      if (isUnderCooldown && !ignoreCooldown) {
        inCooldownCount++;
        inCooldownList.push(candidateInfo);
      } else {
        readyToSend.push(candidateInfo);
      }
    }
  });

  console.log(`\n  📊 ACCURATE STATUS BREAKDOWN:`);
  console.log(`    • Total Active Students:                  ${students.length}`);
  console.log(`    • Students with Complete Profiles:        ${completeCount} (have bio, skills, pfp, etc.)`);
  console.log(`    • Students with Incomplete Profiles:      ${incompleteCount} (missing 2+ details)`);
  console.log(`    • Incomplete, but in 44h Cooldown:        ${inCooldownCount} (reminded within last 44 hours)`);
  console.log(`    • Incomplete & Eligible to Send NOW:      ${readyToSend.length}`);
  console.log(`    • Total Reminder Logs on Record:          ${totalEverSent || 0}`);

  const listToDisplay = readyToSend.slice(0, isVerbose ? readyToSend.length : previewLimit);

  if (listToDisplay.length > 0) {
    console.log(`\n  👥 CANDIDATES PREVIEW (Showing ${listToDisplay.length} of ${readyToSend.length} ready):`);
    console.log('  ' + '-'.repeat(80));
    console.log('  ' + 'NAME'.padEnd(25) + 'MATRIC'.padEnd(16) + 'MISSING DETAILS');
    console.log('  ' + '-'.repeat(80));

    listToDisplay.forEach(c => {
      const name = c.name.substring(0, 23).padEnd(25);
      const matric = c.matric.padEnd(16);
      const missing = c.missing.join(', ');
      console.log(`  ${name}${matric}${missing}`);
    });
    console.log('  ' + '-'.repeat(80));
  }

  if (inCooldownCount > 0 && !ignoreCooldown) {
    console.log(`\n  ⏳ Note: ${inCooldownCount} incomplete students are currently protected by the 44-hour cooldown`);
    console.log(`     because reminder emails were recorded for them yesterday.`);
    console.log(`     • To preview ALL ${incompleteCount} incomplete profiles: run with '--ignore-cooldown'`);
    console.log(`     • To clear the cooldown log and re-trigger fresh reminders: run with '--reset-cooldown'`);
  }

  if (sendLive) {
    console.log(`\n--- 🚀 LIVE DISPATCH TRIGGERED (--send-live) ---`);
    console.log(`  Dispatching reminder emails to eligible students (limit: ${batchLimit})...`);
    const liveResult = await checkAndSendProfileReminders({ dryRun: false, limit: batchLimit });
    console.log('  Live Result:', liveResult);
    console.log('  ✅ Live reminder dispatch complete!');
  } else {
    console.log('\n================================================================');
    console.log('  ✅ DRY RUN COMPLETE (0 EMAILS SENT)');
    console.log('  • To actually send real reminders to eligible students, run:');
    console.log('    node backend/scripts/cron-dry-run.js --send-live --limit=20');
    console.log('================================================================\n');
  }
}

runInvestigation().catch(err => {
  console.error('Unhandled script error:', err);
  process.exit(1);
});
