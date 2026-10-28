// backend/scripts/bulk-import-students.js
//
// Bulk-register students from an Excel (.xlsx) file into Supabase.
//
// USAGE:
//   1. Drop your Excel file into:  backend/scripts/students.xlsx
//   2. Make sure your backend/.env is configured (SUPABASE_URL, keys, etc.)
//   3. Run:  node scripts/bulk-import-students.js
//            (or with a custom file path):
//            node scripts/bulk-import-students.js ./scripts/my-file.xlsx
//
// EXCEL COLUMNS (case-insensitive, order doesn't matter):
//   Required:
//     first_name  (or "First Name")
//     last_name   (or "Last Name")
//     matric_no   (or "Matric No", "Matric Number")
//     email       (or "Email")
//     department  (or "Department")
//   Optional:
//     course      (or "Course")
//     phone       (or "Phone")
//     level       (or "Level")  — 100, 200, 300, 400, 500
//
// BEHAVIOUR:
//   - Skips rows where email or matric_no already exist in the database
//   - Creates a Supabase Auth user for each student (email confirmed)
//   - Sets status = 'active' so students can log in immediately
//   - Generates a temporary password: NACOSImport@<MATRIC_NO>
//     Students must change it on first login via forgot-password.
//   - Prints a full summary at the end (imported / skipped / failed)
//   - Writes a CSV report to scripts/bulk-import-report-<timestamp>.csv

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const path = require('path');
const fs   = require('fs');

// ── Dependencies check ──────────────────────────────────────────────────────
let XLSX;
try {
  XLSX = require('xlsx');
} catch (_) {
  console.error('\n❌  Missing dependency: xlsx');
  console.error('    Run:  npm install xlsx  (inside the backend folder)');
  process.exit(1);
}

const { createClient } = require('@supabase/supabase-js');
const { sendWelcomeEmail } = require('../services/email');

// ── Config ──────────────────────────────────────────────────────────────────
const SUPABASE_URL             = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('\n❌  SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing in .env');
  process.exit(1);
}

// Service-role client — bypasses RLS and can create Auth users
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

// Default department if column is missing in the spreadsheet
const DEFAULT_DEPARTMENT = 'Computer Science';

// How long to wait between rows to avoid hitting Supabase Auth rate limits
const ROW_DELAY_MS = 300;

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Normalise column header: lowercase, collapse spaces/underscores */
const normalise = (str) => String(str).toLowerCase().replace(/[\s_-]+/g, '_').trim();

/** Map common header variants to canonical field names */
const HEADER_MAP = {
  first_name:    ['first_name', 'firstname', 'first'],
  last_name:     ['last_name', 'lastname', 'last', 'surname'],
  email:         ['email', 'email_address', 'school_email'],
  matric_no:     ['matric_no', 'matric_number', 'matricno', 'matric', 'reg_no', 'reg_number'],
  department:    ['department', 'dept', 'faculty'],
  course:        ['course', 'programme', 'program'],
  phone:         ['phone', 'phone_no', 'phone_number', 'mobile'],
  level:         ['level', 'year', 'academic_level', 'current_level'],
};

function mapHeader(rawHeader) {
  const n = normalise(rawHeader);
  for (const [canonical, variants] of Object.entries(HEADER_MAP)) {
    if (variants.includes(n)) return canonical;
  }
  return null;
}

/** Build a column-index → canonical-field map from the first row */
function buildColumnMap(headers) {
  const map = {};
  headers.forEach((h, idx) => {
    const canonical = mapHeader(h);
    if (canonical) map[idx] = canonical;
  });
  return map;
}

/** Extract and validate matric number — returns uppercase or null */
function cleanMatric(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toUpperCase().replace(/\s+/g, '');
  if (!s) return null;
  return s;
}

/** Generate a temporary password from matric number */
function tempPassword(matric) {
  // e.g.  NACOSImport@22/10MSC014  →  NACOSImport@22_10MSC014
  const safe = matric.replace(/\//g, '_');
  return `NACOSImport@${safe}`;
}

/** Extract year_of_study from a two-digit matric prefix (e.g. "22/..." → 2022) */
function extractYearFromMatric(matric) {
  const m = matric.match(/^(\d{2})\//);
  if (m) return 2000 + parseInt(m[1], 10);
  const m2 = matric.match(/TAU\/[A-Z]+\/(\d{2})\//i);
  if (m2) return 2000 + parseInt(m2[1], 10);
  const m3 = matric.match(/TAU\/[A-Z]+\/(\d{4})\//i);
  if (m3) return parseInt(m3[1], 10);
  return null;
}

/** Sleep helper */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  // ── 1. Locate Excel file ──────────────────────────────────────────────────
  const filePath = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(__dirname, 'students.xlsx');

  if (!fs.existsSync(filePath)) {
    console.error(`\n❌  Excel file not found: ${filePath}`);
    console.error('    Drop your file at:  backend/scripts/students.xlsx');
    console.error('    Or pass a path:     node scripts/bulk-import-students.js ./path/to/file.xlsx');
    process.exit(1);
  }

  console.log(`\n📂  Reading: ${filePath}`);

  // ── 2. Parse Excel ────────────────────────────────────────────────────────
  const workbook  = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const sheet     = workbook.Sheets[sheetName];
  const rows      = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

  if (rows.length < 2) {
    console.error('\n❌  Spreadsheet appears to be empty (< 2 rows).');
    process.exit(1);
  }

  const headerRow = rows[0];
  const dataRows  = rows.slice(1).filter(r => r.some(c => String(c).trim() !== ''));
  const colMap    = buildColumnMap(headerRow);

  console.log(`📊  Sheet: "${sheetName}"  |  Columns found: ${Object.values(colMap).join(', ')}`);
  console.log(`📊  Data rows: ${dataRows.length}\n`);

  const missing = ['first_name', 'last_name', 'email', 'matric_no']
    .filter(f => !Object.values(colMap).includes(f));
  if (missing.length > 0) {
    console.error(`❌  Missing required columns: ${missing.join(', ')}`);
    console.error('    Check USAGE at the top of this file for expected column names.');
    process.exit(1);
  }

  // ── 3. Collect existing emails + matric numbers to detect duplicates ──────
  console.log('🔍  Fetching existing students from database...');
  const { data: existing } = await supabase
    .from('students')
    .select('email, matric_no');
  const existingEmails  = new Set((existing || []).map(s => s.email.toLowerCase()));
  const existingMatrics = new Set((existing || []).map(s => s.matric_no.toUpperCase()));
  console.log(`    Found ${existingEmails.size} existing students.\n`);

  // ── 4. Process rows ────────────────────────────────────────────────────────
  const results = { imported: 0, skipped: 0, failed: 0 };
  const report  = [['row', 'matric_no', 'email', 'status', 'reason']];

  for (let i = 0; i < dataRows.length; i++) {
    const row    = dataRows[i];
    const rowNum = i + 2; // 1-indexed with header

    // Extract fields from row using column map
    const get = (field) => {
      const idx = Object.keys(colMap).find(k => colMap[k] === field);
      return idx !== undefined ? String(row[idx] ?? '').trim() : '';
    };

    const firstName  = get('first_name');
    const lastName   = get('last_name');
    const email      = get('email').toLowerCase();
    const rawMatric  = get('matric_no');
    const department = get('department') || DEFAULT_DEPARTMENT;
    const course     = get('course') || department;
    const phone      = get('phone') || null;
    const level      = parseInt(get('level'), 10) || null;
    const matric     = cleanMatric(rawMatric);

    process.stdout.write(`  [${rowNum}/${dataRows.length + 1}] ${matric || '?'} — ${email} ... `);

    // ── Validate required fields ─────────────────────────────────────────
    if (!firstName || !lastName || !email || !matric) {
      console.log('⚠️  SKIP (missing required field)');
      report.push([rowNum, matric || '', email, 'skipped', 'Missing first_name, last_name, email, or matric_no']);
      results.skipped++;
      continue;
    }

    if (!email.includes('@')) {
      console.log('⚠️  SKIP (invalid email)');
      report.push([rowNum, matric, email, 'skipped', 'Invalid email format']);
      results.skipped++;
      continue;
    }

    // ── Duplicate check ──────────────────────────────────────────────────
    if (existingEmails.has(email)) {
      console.log('⏭️  SKIP (email already registered)');
      report.push([rowNum, matric, email, 'skipped', 'Email already exists']);
      results.skipped++;
      continue;
    }
    if (existingMatrics.has(matric)) {
      console.log('⏭️  SKIP (matric already registered)');
      report.push([rowNum, matric, email, 'skipped', 'Matric number already exists']);
      results.skipped++;
      continue;
    }

    // ── Create Supabase Auth user ────────────────────────────────────────
    const password    = tempPassword(matric);
    const yearOfStudy = extractYearFromMatric(matric);
    const programDuration = level && level === 500 ? 5 : 4;
    const graduationYear  = yearOfStudy ? yearOfStudy + programDuration : null;

    try {
      const { data: authData, error: authErr } = await supabase.auth.admin.createUser({
        email,
        password,
        email_confirm: true, // Mark email as confirmed — no verification email needed
        user_metadata: { first_name: firstName, last_name: lastName }
      });

      if (authErr) {
        // Auth user already exists but has no student profile — skip safely
        if (authErr.message?.toLowerCase().includes('already registered') ||
            authErr.message?.toLowerCase().includes('already been registered') ||
            authErr.status === 422) {
          console.log('⏭️  SKIP (Auth user already exists)');
          report.push([rowNum, matric, email, 'skipped', `Auth user already exists: ${authErr.message}`]);
          results.skipped++;
          continue;
        }
        throw authErr;
      }

      const userId = authData.user.id;

      // ── Insert student profile ────────────────────────────────────────
      const { error: profileErr } = await supabase.from('students').insert([{
        user_id:          userId,
        email:            email,
        first_name:       firstName,
        last_name:        lastName,
        name:             `${firstName} ${lastName}`,
        matric_no:        matric,
        department:       department,
        course:           course,
        phone:            phone,
        status:           'active',        // active immediately — admin bulk import
        year_of_study:    yearOfStudy,
        graduation_year:  graduationYear,
        program_duration: programDuration,
        visibility:       'students-only',
        created_at:       new Date().toISOString()
      }]);

      if (profileErr) {
        // Profile insert failed — roll back auth user to avoid orphans
        await supabase.auth.admin.deleteUser(userId);
        throw profileErr;
      }

      // Add to in-memory sets so later rows in the same file see the duplicate
      existingEmails.add(email);
      existingMatrics.add(matric);

      // Send welcome email (non-blocking — failure doesn't fail the import)
      sendWelcomeEmail({
        student: { email, first_name: firstName, last_name: lastName,
                   name: `${firstName} ${lastName}`, matric_no: matric, department }
      }).catch(() => {});

      console.log('✅  Imported');
      report.push([rowNum, matric, email, 'imported', `Temp password: ${password}`]);
      results.imported++;

    } catch (err) {
      console.log(`❌  FAILED — ${err.message}`);
      report.push([rowNum, matric, email, 'failed', err.message]);
      results.failed++;
    }

    // Throttle to avoid Supabase Auth rate limits
    await sleep(ROW_DELAY_MS);
  }

  // ── 5. Write CSV report ───────────────────────────────────────────────────
  const timestamp  = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const reportPath = path.join(__dirname, `bulk-import-report-${timestamp}.csv`);
  const csvContent = report.map(row =>
    row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')
  ).join('\n');
  fs.writeFileSync(reportPath, csvContent, 'utf8');

  // ── 6. Summary ────────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(55));
  console.log('📋  BULK IMPORT COMPLETE');
  console.log('='.repeat(55));
  console.log(`  ✅  Imported : ${results.imported}`);
  console.log(`  ⏭️  Skipped  : ${results.skipped}`);
  console.log(`  ❌  Failed   : ${results.failed}`);
  console.log(`  📄  Total    : ${dataRows.length}`);
  console.log('='.repeat(55));
  console.log(`\n📄  Full report saved to:\n    ${reportPath}\n`);

  if (results.imported > 0) {
    console.log('⚠️  IMPORTANT — Temporary Passwords');
    console.log('   Each imported student has a temporary password:');
    console.log('   Format:  NACOSImport@<MATRIC_NO>  (with / replaced by _)');
    console.log('   Example: NACOSImport@22_10MSC014');
    console.log('   Students should reset their password on first login.\n');
    console.log('   To force a password reset email for all imported students,');
    console.log('   run:  node scripts/bulk-send-reset-emails.js\n');
  }
}

run().catch(err => {
  console.error('\n❌  Unexpected error:', err.message);
  process.exit(1);
});
