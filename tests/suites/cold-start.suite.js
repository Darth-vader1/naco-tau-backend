// Boot the real backend like Vercel does (VERCEL=1, no listen) with real
// ioredis pointed at an address that never answers, then hit /api/health
// immediately. Usage: node coldstart_real.js <path to server.js>
process.env.VERCEL = '1';
process.env.NODE_ENV = 'production';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'test-anon-key';
process.env.REDIS_URL = 'redis://10.255.255.1:6379'; // non-routable: connects never complete
process.env.SENTRY_DSN = '';

let crashed = null;
process.on('uncaughtException', (e) => { crashed = e && e.message || String(e); });
process.on('exit', (code) => { if (code !== 0 && !crashed) console.log('process exiting with code', code); });

const serverPath = require('path').resolve(process.argv[2] || require('path').join(__dirname, '..', '..', 'server.js'));
let app;
try {
  app = require(serverPath);
} catch (e) {
  console.log('BOOT FAILED:', e.message);
  process.exit(3);
}

const http = require('http');
const server = http.createServer(app).listen(0, async () => {
  const url = `http://127.0.0.1:${server.address().port}/api/health`;
  const statuses = [];
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(url);
      await r.text();
      statuses.push(r.status);
    } catch (e) {
      statuses.push('error: ' + e.message);
    }
  }
  const ok = statuses.every(s => s === 200);
  console.log((ok ? 'PASS ' : 'FAIL ') + 'health answers 200 x5 while Redis is unreachable (cold start)' + (ok ? '' : ' ' + JSON.stringify(statuses)));
  const noCrash = !crashed;
  console.log((noCrash ? 'PASS ' : 'FAIL ') + 'no uncaught exception during cold start' + (noCrash ? '' : ' ' + crashed));
  console.log(ok && noCrash ? 'ALL PASSED' : 'FAILED');
  server.close();
  setTimeout(() => process.exit(ok && noCrash ? 0 : 1), 200);
});
