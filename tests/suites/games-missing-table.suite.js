// utils/games.js must treat a missing event_items table (migration 024 not run) as "no games".
const path = require('path'), Module = require('module');
const B = path.resolve(process.argv[2] || path.join(__dirname, '..', '..'));
const err = { code: 'PGRST205', message: "Could not find the table 'public.event_items' in the schema cache" };
const q = () => { const a = { select: () => a, eq: () => a, order: () => a, maybeSingle: async () => ({ data: null, error: err }), then: (r, j) => Promise.resolve({ data: null, error: err }).then(r, j) }; return a; };
const stubs = { [path.join(B, 'config/supabase.js')]: { supabase: { from: q } } };
const o = Module._load; Module._load = function (r, p, m) { const f = Module._resolveFilename(r, p, m); return stubs[f] || o.apply(this, arguments); };
const g = require(path.join(B, 'utils/games.js'));
(async () => {
  const a = await g.loadEventItems('e');
  const b = await g.loadEventItem('00000000-0000-4000-8000-000000000000');
  const ok = Array.isArray(a) && a.length === 0 && b === null;
  console.log(ok ? 'PASS missing table (PGRST205) = no games' : 'FAIL', a, b);
  process.exit(ok ? 0 : 1);
})();
