// Unpaid online checkouts older than 24h are marked "abandoned"; nothing else is touched.
// Run with: npm test (or node tests/suites/abandoned-checkouts.suite.js)
const path = require('path');
const Module = require('module');
const backend = path.resolve(process.argv[2] || path.join(__dirname, '..', '..'));

const hoursAgo = (h) => new Date(Date.now() - h * 3600000).toISOString();
let rows = [];
function qb() {
  const f = []; let op = 'select'; let payload = null; let lim = null;
  const like = (pat) => new RegExp('^' + pat.split('%').map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
  const api = {
    select() { return api; },
    eq(c, v) { f.push(r => r[c] === v); return api; },
    lt(c, v) { f.push(r => r[c] < v); return api; },
    ilike(c, v) { const re = like(v); f.push(r => re.test(r[c] || '')); return api; },
    in(c, vals) { f.push(r => vals.includes(r[c])); return api; },
    limit(n) { lim = n; return api; },
    update(u) { op = 'update'; payload = u; return api; },
    then(a, b) {
      let m = rows.filter(r => f.every(fn => fn(r)));
      if (op === 'update') m.forEach(r => Object.assign(r, payload));
      else if (lim) m = m.slice(0, lim);
      return Promise.resolve({ data: m, error: null }).then(a, b);
    }
  };
  return api;
}
const stubs = { [path.join(backend, 'config/supabase.js')]: { supabase: { from: qb } } };
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const resolved = Module._resolveFilename(request, parent, isMain);
  return stubs[resolved] || origLoad.apply(this, arguments);
};
const { markAbandonedCheckouts } = require(path.join(backend, 'utils/abandonedCheckouts.js'));

let fails = 0;
const check = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' ' + JSON.stringify(x))); if (!c) fails++; };

(async () => {
  rows = [
    { id: 'old-online', status: 'pending', submitted_at: hoursAgo(30), notes: '[online-checkout] Checkout started; awaiting gateway confirmation.' },
    { id: 'old-guest', status: 'pending', submitted_at: hoursAgo(48), notes: '[online-checkout] [guest] Checkout started' },
    { id: 'fresh-online', status: 'pending', submitted_at: hoursAgo(2), notes: '[online-checkout] Checkout started' },
    { id: 'old-manual', status: 'pending', submitted_at: hoursAgo(72), notes: 'Bank transfer proof uploaded' },
    { id: 'old-paid', status: 'verified', submitted_at: hoursAgo(72), notes: '[online-checkout] paid' },
    { id: 'old-rejected', status: 'rejected', submitted_at: hoursAgo(72), notes: '[online-checkout] rejected' }
  ];
  const r = await markAbandonedCheckouts();
  const st = Object.fromEntries(rows.map(x => [x.id, x.status]));
  check('unpaid online checkouts older than 24h are marked abandoned', st['old-online'] === 'abandoned' && st['old-guest'] === 'abandoned' && r.marked === 2, { r, st });
  check('a checkout started 2 hours ago is left pending', st['fresh-online'] === 'pending', st);
  check('manual (bank transfer) payments awaiting admin review are left alone', st['old-manual'] === 'pending', st);
  check('verified and rejected payments are untouched', st['old-paid'] === 'verified' && st['old-rejected'] === 'rejected', st);
  const again = await markAbandonedCheckouts();
  check('running it again changes nothing', again.marked === 0, again);
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  process.exitCode = fails ? 1 : 0; setTimeout(() => process.exit(process.exitCode), 200);
})();
