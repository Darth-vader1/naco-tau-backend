// Tests for the audit middleware rules and the audit-log API filters/stats.
// Run with: npm test (or node tests/suites/audit-logs.test.js)
const path = require('path');
const Module = require('module');
const backend = path.resolve(process.argv[2] || path.join(__dirname, '..', '..'));
const express = require(path.join(backend, 'node_modules', 'express'));

// ---------- fake audit_logs table + PostgREST-ish query builder ----------
let rows = [];
const likeToRe = (pat) => new RegExp('^' + pat.split('%').map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/_/g, '.')).join('.*') + '$', 'i');
function qb() {
  const f = []; let head = false; let wantCount = false; let order = null; let rng = null;
  const api = {
    select(_c, o = {}) { head = !!o.head; wantCount = o.count === 'exact'; return api; },
    eq(c, v) { f.push(r => r[c] === v); return api; },
    neq(c, v) { f.push(r => r[c] !== v); return api; },
    not(c, op, v) { if (op !== 'like') throw new Error('op'); const re = likeToRe(v); f.push(r => !re.test(r[c] || '')); return api; },
    ilike(c, v) { const re = likeToRe(v); f.push(r => re.test(r[c] || '')); return api; },
    gte(c, v) { f.push(r => r[c] >= v); return api; },
    lte(c, v) { f.push(r => r[c] <= v); return api; },
    or(expr) {
      if (/[()]/.test(expr.replace(/\.ilike\./g, ''))) throw new Error('INJECTION: parentheses reached .or(): ' + expr);
      const parts = expr.split(',').map(p => { const [c, , ...v] = p.split('.'); return { c, re: likeToRe(v.join('.')) }; });
      if (parts.length !== 2) throw new Error('INJECTION: extra or() clauses: ' + expr);
      f.push(r => parts.some(p => p.re.test(r[p.c] || ''))); return api;
    },
    order(c, o = {}) { order = order || { c, asc: o.ascending }; return api; },
    range(a, b) { rng = [a, b]; return api; },
    then(res, rej) {
      let out = rows.filter(r => f.every(fn => fn(r)));
      const count = out.length;
      if (order) out = [...out].sort((x, y) => (x[order.c] > y[order.c] ? 1 : -1) * (order.asc ? 1 : -1));
      if (rng) out = out.slice(rng[0], rng[1] + 1);
      else out = out.slice(0, 1000); // database default cap
      return Promise.resolve(head ? { count, error: null } : { data: out, count: wantCount ? count : null, error: null }).then(res, rej);
    }
  };
  return api;
}
const inserted = [];
const stubs = {
  [path.join(backend, 'config/supabase.js')]: { supabase: { from: (t) => (t === 'audit_logs' ? Object.assign(qb(), { insert: async (r) => { inserted.push(...r); return { error: null }; } }) : qb()) } },
  [path.join(backend, 'middleware/auth.js')]: { authenticate: (q, s, n) => n(), requireAdmin: (q, s, n) => n() }
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const resolved = Module._resolveFilename(request, parent, isMain);
  return stubs[resolved] || origLoad.apply(this, arguments);
};

let fails = 0;
const check = (name, cond, extra) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : ' ' + JSON.stringify(extra))); if (!cond) fails++; };

(async () => {
  // ---------- middleware rules ----------
  const { describeRequestForAudit } = require(path.join(backend, 'middleware/audit.js'));
  const req = (method, url, extra = {}) => ({ method, originalUrl: url, baseUrl: extra.baseUrl || '', route: extra.route === null ? undefined : { path: extra.route || '/' }, params: extra.params || {}, body: extra.body || {}, user: extra.user, userRole: extra.role });

  check('HEAD / ping is skipped', describeRequestForAudit(req('HEAD', '/'), 200) === null);
  check('OPTIONS preflight is skipped', describeRequestForAudit(req('OPTIONS', '/api/events'), 204) === null);
  check('bucket housekeeping is skipped', describeRequestForAudit(req('POST', '/api/storage/ensure-buckets', { baseUrl: '/api/storage', route: '/ensure-buckets' }), 200) === null);
  check('session-status is skipped', describeRequestForAudit(req('GET', '/api/auth/session-status', { baseUrl: '/api/auth', route: '/session-status' }), 401) === null);
  check('token refresh is skipped', describeRequestForAudit(req('POST', '/api/auth/refresh', { baseUrl: '/api/auth', route: '/refresh' }), 200) === null);
  check('unmatched route probe is skipped', describeRequestForAudit(req('GET', '/wp-login.php', { route: null }), 404) === null);
  check('explicitly audited payment verify not duplicated', describeRequestForAudit(req('POST', '/api/payments/guest-verify', { baseUrl: '/api/payments', route: '/guest-verify' }), 200) === null);
  check('public read not audited', describeRequestForAudit(req('GET', '/api/events/upcoming', { baseUrl: '/api/events', route: '/upcoming' }), 200) === null);

  const create = describeRequestForAudit(req('POST', '/api/admin/events', { baseUrl: '/api/admin', route: '/:table', body: { title: 'Game Night' }, user: { id: 'a' }, role: 'admin' }), 201);
  check('admin create is named and targeted', create && create.action === 'admin_create_events' && create.target === 'events "Game Night"', create);
  const upd = describeRequestForAudit(req('PUT', '/api/admin/events/11111111-2222', { baseUrl: '/api/admin', route: '/:table/:id', body: { allow_repeat_orders: true } }), 200);
  check('admin update targets the record id', upd && upd.action === 'admin_update_events' && /#11111111/.test(upd.target), upd);
  const del = describeRequestForAudit(req('DELETE', '/api/admin/past_questions/abc', { baseUrl: '/api/admin', route: '/:table/:id' }), 200);
  check('admin delete named', del && del.action === 'admin_delete_past_questions', del);
  const pii = describeRequestForAudit(req('GET', '/api/hackathons/admin/7/participants', { baseUrl: '/api/hackathons', route: '/admin/:id/participants', params: { id: '7' } }), 200);
  check('admin data access (participants) is audited with readable action', pii && pii.action === 'get_api_hackathons_admin_id_participants' && pii.target === '#7', pii);
  const exp = describeRequestForAudit(req('GET', '/api/students/export/csv', { baseUrl: '/api/students', route: '/export/csv' }), 200);
  check('student CSV export is audited', !!exp, exp);
  const failedReg = describeRequestForAudit(req('POST', '/api/events/9/register', { baseUrl: '/api/events', route: '/:id/register', params: { id: '9' } }), 409);
  check('failed event registration is audited', failedReg && failedReg.action === 'post_api_events_id_register', failedReg);

  // ---------- API: filters + stats ----------
  const router = require(path.join(backend, 'routes/auditLogs.js'));
  const app = express(); app.use('/a', router);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/a`;
  const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };

  const now = Date.now();
  const iso = (msAgo) => new Date(now - msAgo).toISOString();
  rows = [];
  let id = 0;
  // 1,500 old pings (10 days ago) + 300 recent pings
  for (let i = 0; i < 1500; i++) rows.push({ id: ++id, action: 'auto_HEAD_root', user_email: null, user_id: null, timestamp: iso(10 * 864e5 + i * 1000) });
  for (let i = 0; i < 300; i++) rows.push({ id: ++id, action: 'auto_HEAD_root', user_email: null, user_id: null, timestamp: iso(i * 60000) });
  for (let i = 0; i < 200; i++) rows.push({ id: ++id, action: 'auto_POST_ensure-buckets', user_email: 'admin@tau.edu.ng', user_id: 'adm', timestamp: iso(i * 60000) });
  rows.push({ id: ++id, action: 'auto_GET_*', user_email: null, user_id: null, timestamp: iso(5000) });
  // real events: 5 today, 3 four days ago, 2 twenty days ago
  for (let i = 0; i < 5; i++) rows.push({ id: ++id, action: 'guest_payment_verified', user_email: null, user_id: null, timestamp: iso(i * 3600e3) });
  for (let i = 0; i < 3; i++) rows.push({ id: ++id, action: 'admin_update_events', user_email: 'admin@tau.edu.ng', user_id: 'adm', timestamp: iso(4 * 864e5 + i) });
  for (let i = 0; i < 2; i++) rows.push({ id: ++id, action: 'user_login', user_email: 'stu@st.tau.edu.ng', user_id: 'stu', timestamp: iso(20 * 864e5 + i) });

  let r = await get('/stats');
  check('stats hide system traffic by default (10 real events)', r.body.data.totalLogs === 10, r.body.data);
  check('last 24 hours is exact (5)', r.body.data.last24 === 5, r.body.data);
  check('last 7 days is exact (8)', r.body.data.last7 === 8, r.body.data);
  check('top actions exclude pings', !r.body.data.topActions.some(t => /HEAD|ensure/.test(t.action)), r.body.data.topActions);
  r = await get('/stats?include_system=true');
  check('with system traffic, total is exact beyond the 1,000-row cap (2011)', r.body.data.totalLogs === 2011, r.body.data);
  check('with system traffic, last 24h counts all recent rows', r.body.data.last24 === 506, r.body.data);

  r = await get('/?limit=50');
  check('list hides system rows by default', r.body.data.pagination.total === 10 && r.body.data.logs.every(l => !/HEAD|ensure|\*/.test(l.action)), r.body.data.pagination);
  check('list is newest first', r.body.data.logs[0].action === 'guest_payment_verified', r.body.data.logs[0]);
  r = await get('/?include_system=true&limit=10&page=3');
  check('list with system traffic paginates over everything', r.body.data.pagination.total === 2011 && r.body.data.logs.length === 10, r.body.data.pagination);

  r = await get('/?search=' + encodeURIComponent('x%,user_id.eq.adm),(action.ilike.*'));
  check('search cannot inject extra filter clauses', r.status === 200, r.body);
  r = await get('/?search=admin');
  check('search still works', r.body.data.pagination.total === 3, r.body.data.pagination);

  const today = new Date().toISOString().slice(0, 10);
  r = await get(`/?start_date=${today}&end_date=${today}`);
  check('end date includes the whole day', r.body.data.pagination.total >= 1, r.body.data.pagination);

  r = await get('/actions');
  check('action list excludes system actions', Array.isArray(r.body.data) && !r.body.data.some(a => /HEAD|ensure|\*/.test(a)) && r.body.data.includes('guest_payment_verified'), r.body.data);

  server.close();
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  process.exitCode = fails ? 1 : 0; setTimeout(() => process.exit(process.exitCode), 200);
})().catch(e => { console.error(e); process.exit(2); });
