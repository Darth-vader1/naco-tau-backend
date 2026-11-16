#!/usr/bin/env node
// Runs every backend test suite in tests/suites/ and prints a summary.
//
//   npm test                     run all suites
//   npm test -- payments games   run suites whose file name contains a word
//
// Each suite is a plain Node script that stubs the database, email and auth
// (no real Supabase, Redis, Bachs or email is touched) and exits non-zero on
// a failed check. Safe to run anywhere, including CI.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const suitesDir = path.join(__dirname, 'suites');
const filters = process.argv.slice(2).map(s => s.toLowerCase());
const files = fs.readdirSync(suitesDir)
  .filter(f => f.endsWith('.suite.js'))
  .filter(f => !filters.length || filters.some(w => f.toLowerCase().includes(w)))
  .sort();

// Dummy settings so modules that read env at load time can start.
const env = {
  ...process.env,
  SUPABASE_URL: process.env.TEST_SUPABASE_URL || 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'test-anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
  REDIS_URL: '',
  SENTRY_DSN: '',
  EMAIL_USER: '',
  EMAIL_PASS: '',
  BACHS_SECRET_KEY: '',
  NODE_ENV: 'development'
};

const TIMEOUT_MS = 120000;

function runSuite(file) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(suitesDir, file)], { env, cwd: path.join(__dirname, '..') });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    const timer = setTimeout(() => { out += '\n[timed out]'; child.kill('SIGKILL'); }, TIMEOUT_MS);
    child.on('close', (code) => {
      clearTimeout(timer);
      const passed = (out.match(/^PASS /gm) || []).length;
      const failedLines = out.split('\n').filter(l => /^FAIL /.test(l));
      resolve({ file, ok: code === 0, passed, failedLines, out, ms: Date.now() - started });
    });
  });
}

(async () => {
  if (!files.length) {
    console.log('No test suites matched.');
    process.exit(1);
  }
  let total = 0;
  const failures = [];
  for (const file of files) {
    const r = await runSuite(file);
    total += r.passed;
    const name = file.replace(/\.suite\.js$/, '');
    if (r.ok) {
      console.log(`  ok    ${name}  (${r.passed} checks, ${(r.ms / 1000).toFixed(1)}s)`);
    } else {
      failures.push(r);
      console.log(`  FAIL  ${name}`);
      (r.failedLines.length ? r.failedLines : r.out.trim().split('\n').slice(-15)).forEach(l => console.log('        ' + l.slice(0, 400)));
    }
  }
  console.log(`\n${files.length - failures.length}/${files.length} suites passed, ${total} checks passed.`);
  process.exit(failures.length ? 1 : 0);
})();
