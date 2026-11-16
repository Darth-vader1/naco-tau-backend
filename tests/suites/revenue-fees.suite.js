// Revenue report and Bachs fee fixes (deleted events, fee on the charge, fee backfill). Run with: npm test (or node tests/suites/payments.test.js)
const path = require('path');
const Module = require('module');
const backend = path.resolve(process.argv[2] || path.join(__dirname, '..', '..'));
const req_ = (p) => require(path.join(backend, 'node_modules', p));
const express = req_('express');

// ---- in-memory "DB" ----
let db;
function reset() {
  db = {
    events: [
      { id: 'evt-aaaa-1', title: 'Cheap', payment_amount: 100, max_attendees: 0 },
      { id: 'evt-bbbb-2', title: 'Pricey', payment_amount: 5000, max_attendees: 0 },
      { id: 'evt-free-3', title: 'Free', payment_amount: 0 }
    ],
    payments: [], event_registrations: [], students: ['u1','u2','u3','u4','u5','u6','u7'].map(u => ({ id: 's-' + u, user_id: u, email: u + '@st.tau.edu.ng', name: u })), payment_verification: []
  };
}
function qb(table) {
  const filters = []; let op = 'select'; let payload = null; let headCount = false;
  const api = {
    select(_c, o) { if (o && o.head) headCount = true; return api; },
    eq(c, v) { filters.push(r => r[c] === v); return api; },
    neq(c, v) { filters.push(r => r[c] !== v); return api; },
    not(c, op, v) { filters.push(r => op === 'is' && v === null ? r[c] != null : r[c] !== v); return api; },
    in(c, vals) { filters.push(r => vals.includes(r[c])); return api; },
    gte() { return api; }, lte() { return api; }, order() { return api; }, range() { return api; }, limit() { return api; },
    is(c, v) { filters.push(r => r[c] == v); return api; },
    ilike(c, v) { const re = new RegExp('^' + v.split('%').map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i'); filters.push(r => re.test(r[c] || '')); return api; },
    or(expr) {
      const parts = expr.split(',').map(p => { const [c, o, ...v] = p.split('.'); return { c, o, v: v.join('.') }; });
      filters.push(r => parts.some(p => p.o === 'is' ? r[p.c] == null : String(r[p.c]) === p.v));
      return api;
    },
    insert(rows) { op = 'insert'; payload = rows; return api; },
    update(u) { op = 'update'; payload = u; return api; },
    upsert(rows) { op = 'upsert'; payload = rows; return api; },
    single() { return run(true); }, maybeSingle() { return run(true); },
    then(res, rej) { return run(false).then(res, rej); }
  };
  async function run(single) {
    const rows = db[table] || (db[table] = []);
    const match = rows.filter(r => filters.every(f => f(r)));
    if (op === 'insert' || op === 'upsert') {
      const out = payload.map(p => {
        if (op === 'upsert') { const ex = rows.find(r => r.event_id === p.event_id && r.user_id === p.user_id); if (ex) return Object.assign(ex, p); }
        const r = { id: require('crypto').randomUUID(), ...p }; rows.push(r); return r;
      });
      return { data: single ? out[0] : out, error: null };
    }
    if (op === 'update') { match.forEach(r => Object.assign(r, payload)); return { data: single ? (match[0] || null) : match, error: null }; }
    if (headCount) return { count: match.length, error: null };
    return { data: single ? (match[0] || null) : match, error: null };
  }
  return api;
}
const stubs = {
  [path.join(backend, 'config/supabase.js')]: { supabase: { from: qb } },
  [path.join(backend, 'middleware/auth.js')]: {
    authenticate: (req, res, next) => { req.userId = req.headers['x-user']; req.user = { id: req.userId, email: req.userId + '@st.tau.edu.ng' }; next(); },
    requireAdmin: (q, s, n) => n(),
    requireSuperAdmin: (q, s, n) => n()
  },
  [path.join(backend, 'middleware/audit.js')]: { auditLog: async () => {} },
  [path.join(backend, 'services/email.js')]: { sendEventTicketEmail: async (a) => { global.ticketEmails = (global.ticketEmails||0)+1; global.lastTicketPayment = a.payment; global.lastTicketTo = a.student && a.student.email; }, sendPaymentAdminNotificationEmail: async () => {} }
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const resolved = Module._resolveFilename(request, parent, isMain);
  if (stubs[resolved]) return stubs[resolved];
  return origLoad.apply(this, arguments);
};

// Fake Bachs gateway
let gateway = {};
const nativeFetch = global.fetch;
global.fetch = async (url, opts) => {
  if (opts.method === 'POST') { gateway.lastCreate = JSON.parse(opts.body); return { ok: true, status: 200, json: async () => ({ id: 'chk_1', checkout_url: 'https://pay/x' }) }; }
  const ref = decodeURIComponent(url.split('/').pop());
  const s = gateway[ref];
  if (!s) return { ok: false, status: 404, json: async () => ({ message: 'not found' }) };
  return { ok: true, status: 200, json: async () => ({ data: s }) };
};

const router = require(path.join(backend, 'routes/payment.js'));
const app = express(); app.use(express.json()); app.use('/p', router);
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/p`;
const realFetch = nativeFetch;
async function call(p, user, body, method = 'POST', headers = {}) {
  const r = await realFetch(base + p, { method, headers: Object.assign({ 'content-type': 'application/json', 'x-user': user }, headers), body: method === 'GET' ? undefined : JSON.stringify(body) });
  const txt = await r.text(); let b; try { b = JSON.parse(txt); } catch { b = txt; }
  return { status: r.status, body: b };
}
async function callOld(p, user, body) {
  const r = await realFetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-user': user }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

let fails = 0;
const check = (name, cond, extra) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : ' ' + JSON.stringify(extra))); if (!cond) fails++; };


(async () => {
  const { gatewayFeeOf, gatewayFeePaidByOf } = require(path.join(backend, 'utils/fees.js'));
  check('Bachs fee read from the checkout session\'s charge', gatewayFeeOf({ checkout_id: 'chk_1', charge: { fees: { amount: '2.50', currency: 'NGN' } } }) === 2.5);
  check('Bachs fee read from a payment object', gatewayFeeOf({ payment_id: 'ch_1', fees: { amount: '3.00', currency: 'NGN' } }) === 3);
  check('no fee reported yet gives null (not 0)', gatewayFeeOf({ charge: { fees: null } }) === null && gatewayFeeOf({}) === null);
  check('who paid the fee read from the charge', gatewayFeePaidByOf({ charge: { fee_paid_by: 'merchant' } }) === 'merchant' && gatewayFeePaidByOf({ customer_bears_fee: true }) === 'customer');

  // ---- revenue report: deleted events keep their name ----
  reset();
  db.events.push({ id: 'evt-live', title: 'Live Event', payment_amount: 100 });
  const pay = (o) => db.payments.push({ id: require('crypto').randomUUID(), status: 'verified', payment_type: 'event_registration', ticket_quantity: 1, verified_at: '2026-11-10T10:00:00Z', notes: '[online-checkout] Verified', ...o });
  pay({ event_id: 'evt-live', amount: 150, subtotal_amount: 100, service_fee: 50, gateway_fee: 2.5, description: 'Online payment for event: Live Event (1 ticket)' });
  pay({ event_id: null, amount: 550, subtotal_amount: 450, service_fee: 100, description: 'Online payment for event: Game Night (Fifa × 1, Ludo × 1 (2 plays))', ticket_quantity: 2 });
  pay({ event_id: null, amount: 100, subtotal_amount: 100, service_fee: 0, description: 'Online payment for event: Game Night (1 ticket)' });
  pay({ event_id: null, amount: 200, subtotal_amount: 200, description: 'Old manual payment' });
  let r = await call('/revenue', 'admin1', null, 'GET');
  const rows = r.body.data.by_event;
  const gn = rows.find(x => /Game Night/.test(x.title));
  check('orders of a deleted event are grouped under its old name', r.status === 200 && gn && gn.title === 'Game Night (deleted event)' && gn.orders === 2 && gn.service_fees === 100, rows);
  check('live events keep their name; unnamed leftovers say deleted', rows.some(x => x.title === 'Live Event') && rows.some(x => x.title === 'Unknown event (deleted)'), rows.map(x => x.title));
  check('totals still add up: service fees 150, Bachs fees 2.50', r.body.data.totals.service_fees === 150 && r.body.data.totals.gateway_fees === 2.5, r.body.data.totals);

  // ---- fetch missing Bachs fees for past orders ----
  reset();
  process.env.BACHS_SECRET_KEY = 'sk_live_x'; process.env.NODE_ENV = 'production';
  db.payments.push(
    { id: 'p1', status: 'verified', transaction_id: 'chk_a', notes: 'Verified via Bachs (online checkout)', gateway_fee: null, verified_at: '2026-11-10T10:00:00Z' },
    { id: 'p2', status: 'verified', transaction_id: 'chk_b', notes: 'Verified via Bachs webhook', gateway_fee: null, verified_at: '2026-11-10T11:00:00Z' },
    { id: 'p3', status: 'verified', transaction_id: 'chk_c', notes: 'Verified via Bachs (online checkout)', gateway_fee: 1.5, verified_at: '2026-11-10T12:00:00Z' },
    { id: 'p4', status: 'verified', transaction_id: 'manual-1', notes: 'Bank transfer', gateway_fee: null, verified_at: '2026-11-10T12:00:00Z' }
  );
  gateway = {
    chk_a: { checkout_id: 'chk_a', status: 'completed', charge: { payment_id: 'ch_a', fees: { amount: '2.50', currency: 'NGN' }, fee_paid_by: 'merchant' } },
    chk_b: { checkout_id: 'chk_b', status: 'completed', charge: { payment_id: 'ch_b', fees: null } }
  };
  r = await call('/refresh-gateway-fees', 'admin1', {});
  const p = (id) => db.payments.find(x => x.id === id);
  check('past order gets its Bachs fee from the session\'s charge', r.status === 200 && p('p1').gateway_fee === 2.5 && p('p1').gateway_fee_paid_by === 'merchant', { b: r.body, p1: p('p1') });
  check('fee not reported yet is left empty and counted', p('p2').gateway_fee === null && r.body.data.no_fee_yet === 1, r.body);
  check('orders that already have a fee, and manual payments, are not touched', p('p3').gateway_fee === 1.5 && p('p4').gateway_fee === null && r.body.data.checked === 2, r.body);

  server.close();
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  process.exitCode = fails ? 1 : 0; setTimeout(() => process.exit(process.exitCode), 200);
})().catch(e => { console.error(e); process.exit(2); });
