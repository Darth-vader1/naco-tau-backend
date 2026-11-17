// Attack simulations against the payment system (all must be blocked). Run with: npm test (or node tests/suites/payments.test.js)
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
    authenticate: (req, res, next) => { if (!req.headers['x-user']) return res.status(401).json({ success: false, error: 'Authentication required' }); req.userId = req.headers['x-user']; req.user = { id: req.userId, email: req.userId + '@st.tau.edu.ng' }; next(); },
    requireAdmin: (req, res, next) => req.headers['x-admin'] === '1' ? next() : res.status(403).json({ success: false, error: 'Admin access required' }),
    requireSuperAdmin: (req, res, next) => req.headers['x-super'] === '1' ? next() : res.status(403).json({ success: false, error: 'Super admin access required' })
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
  gateway.lastGetUrl = String(url);
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
  // Checkout now requires a phone number; send one unless the test sets its own.
  if (p === '/bachs-session' && body && typeof body === 'object' && !Array.isArray(body) && !('phone' in body)) body = { phone: '08012345678', ...body };
  const r = await realFetch(base + p, { method, headers: Object.assign({ 'content-type': 'application/json' }, user ? { 'x-user': user } : {}, headers), body: method === 'GET' ? undefined : JSON.stringify(body) });
  const txt = await r.text(); let b; try { b = JSON.parse(txt); } catch { b = txt; }
  return { status: r.status, body: b };
}
async function callOld(p, user, body) {
  const r = await realFetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-user': user }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

let fails = 0;
const check = (name, cond, extra) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : ' ' + JSON.stringify(extra))); if (!cond) fails++; };


// ===========================================================================
// Attack simulations. Every check describes an attack and asserts it FAILS.
// ===========================================================================
const crypto = require('crypto');
const sign = (body, key = 'sk_live_x') => crypto.createHmac('sha256', key).update(JSON.stringify(body)).digest('hex');
const GAMEEV = 'evt-game-9';
const FIFA = 'aaaaaaaa-0000-4000-8000-0000000000f1', LUDO = 'aaaaaaaa-0000-4000-8000-0000000000f2';
function seed() {
  reset(); gateway = {}; global.ticketEmails = 0;
  db.events.push(
    { id: 'evt-publ-7', title: 'Open day', payment_amount: 100, requires_payment: true, open_to_public: true, public_price: 150, max_attendees: 0, is_active: true },
    { id: 'evt-clsd-8', title: 'Members only', payment_amount: 100, requires_payment: true, open_to_public: false, public_price: null, is_active: true },
    { id: 'evt-gone-0', title: 'Inactive', payment_amount: 100, requires_payment: true, open_to_public: true, public_price: 100, is_active: false },
    { id: GAMEEV, title: 'Game Night', payment_amount: 300, requires_payment: true, open_to_public: true, public_price: 500, max_attendees: 0, is_active: true }
  );
  db.event_items = [
    { id: FIFA, event_id: GAMEEV, name: 'FIFA', price: 500, public_price: 700, is_active: true, sort_order: 0 },
    { id: LUDO, event_id: GAMEEV, name: 'Ludo', price: 300, public_price: null, is_active: true, sort_order: 1 }
  ];
}
const amountOf = () => (gateway.lastCreate && JSON.stringify(gateway.lastCreate).match(/"(\d+\.\d{2})"/) || [])[1];
const msg = (r) => (r.body && (r.body.error || r.body.message)) || '';

(async () => {
  process.env.BACHS_SECRET_KEY = 'sk_live_x'; process.env.NODE_ENV = 'production'; delete process.env.ALLOW_PAYMENT_SIMULATION;
  let r;

  // ---------------- 1. Price tampering at checkout ----------------
  seed();
  r = await call('/bachs-session', 'u1', { event_id: 'evt-bbbb-2', amount: 1, price: 1, total_amount: 1, unit_price: 1, quantity: 1 });
  check('A1 price fields sent by the browser are ignored (charged 5000, not 1)', r.status === 200 && r.body.data.total_amount >= 5000 && amountOf() && Number(amountOf()) >= 5000, { b: r.body, a: amountOf() });
  for (const q of [0, -1, 1.5, '2.5', 'abc', null, 1e9, [], {}, '1; DROP TABLE payments']) {
    seed();
    r = await call('/bachs-session', 'u1', { event_id: 'evt-bbbb-2', quantity: q });
    if (q === null) { check('A2 missing quantity is refused or defaults to 1 ticket', r.status === 400 || (r.status === 200 && r.body.data.quantity === 1), r.body); continue; }
    check(`A2 bad quantity ${JSON.stringify(q)} refused`, r.status === 400, { q, s: r.status, b: r.body });
  }
  seed();
  r = await call('/bachs-session', 'u1', { event_id: GAMEEV, items: [{ item_id: FIFA, plays: -5 }, { item_id: LUDO, plays: 10 }] });
  check('A3 negative plays to cancel out the price refused', r.status === 400, r.body);
  r = await call('/bachs-session', 'u1', { event_id: GAMEEV, items: [{ item_id: FIFA, plays: 0.5 }] });
  check('A3 half a play refused', r.status === 400, r.body);
  r = await call('/bachs-session', 'u1', { event_id: GAMEEV, items: [{ item_id: FIFA, plays: 1, unit_price: 1, price: 1 }] });
  check('A3 price sent inside a game line is ignored (500 + fee)', r.status === 200 && r.body.data.subtotal_amount === 500, r.body);
  r = await call('/bachs-session', 'u1', { event_id: GAMEEV, items: { item_id: FIFA, plays: 1 } });
  check('A3 items sent as an object instead of a list is not accepted as a game order', r.status === 400, r.body);
  r = await call('/bachs-session', 'u1', { event_id: GAMEEV, items: [{ item_id: FIFA, plays: 1, '__proto__': { isAdmin: true } }] });
  check('A3 prototype-pollution key in a game line does nothing harmful', ({}).isAdmin === undefined, {});
  r = await call('/bachs-session', 'u1', { event_id: 'evt-bbbb-2', items: [{ item_id: FIFA, plays: 1 }] });
  check('A4 another event\'s cheap game used on a normal event is refused', r.status === 400, r.body);
  r = await call('/bachs-session', 'u1', { event_id: GAMEEV, items: Array.from({ length: 31 }, () => ({ item_id: FIFA, plays: 1 })) });
  check('A4 31 game lines (over the limit) refused', r.status === 400, r.body);
  r = await call('/bachs-session', 'u1', { event_id: 'evt-free-3', quantity: 1 });
  check('A5 checkout on a free event refused', r.status === 400, r.body);
  r = await call('/bachs-session', 'u1', { event_id: "x' OR '1'='1", quantity: 1 });
  check('A5 SQL-looking event id finds nothing', r.status === 404 || r.status === 400, r.body);
  r = await call('/bachs-session', '', { event_id: 'evt-bbbb-2', quantity: 1 });
  check('A6 member checkout without signing in refused', r.status === 401, r.body);

  // ---------------- 2. Fake or reused payment confirmations ----------------
  seed();
  r = await call('/verify-paystack', 'u1', { reference: 'made-up-ref', event_id: 'evt-bbbb-2' });
  check('B1 made-up reference never issues a ticket', r.status >= 400 && db.event_registrations.length === 0, r.body);
  gateway['ref-cheap'] = { status: 'completed', pricing: { amount: '100.00', currency: 'NGN' }, customer: { email: 'u1@st.tau.edu.ng' } };
  r = await call('/verify-paystack', 'u1', { reference: 'ref-cheap', event_id: 'evt-bbbb-2' });
  check('B2 ₦100 payment used to claim a ₦5000 ticket refused', r.status === 400 && db.event_registrations.length === 0, r.body);
  gateway['ref-usd'] = { status: 'completed', pricing: { amount: '5000.00', currency: 'USD' }, customer: { email: 'u1@st.tau.edu.ng' } };
  r = await call('/verify-paystack', 'u1', { reference: 'ref-usd', event_id: 'evt-bbbb-2' });
  check('B3 payment in another currency refused', r.status >= 400 && db.event_registrations.length === 0, r.body);
  gateway['ref-open'] = { status: 'open', pricing: { amount: '5000.00', currency: 'NGN' }, customer: { email: 'u1@st.tau.edu.ng' } };
  r = await call('/verify-paystack', 'u1', { reference: 'ref-open', event_id: 'evt-bbbb-2' });
  check('B4 checkout that was opened but not paid refused', r.status >= 400 && db.event_registrations.length === 0, r.body);
  gateway['ref-other'] = { status: 'completed', pricing: { amount: '5000.00', currency: 'NGN' }, customer: { email: 'victim@st.tau.edu.ng' } };
  r = await call('/verify-paystack', 'u1', { reference: 'ref-other', event_id: 'evt-bbbb-2' });
  check('B5 someone else\'s paid reference refused', r.status === 403 && db.event_registrations.length === 0, r.body);
  gateway['ref-ok'] = { status: 'completed', pricing: { amount: '5000.00', currency: 'NGN' }, customer: { email: 'u2@st.tau.edu.ng' } };
  r = await call('/verify-paystack', 'u2', { reference: 'ref-ok', event_id: 'evt-bbbb-2' });
  const okFirst = r.status === 200;
  r = await call('/verify-paystack', 'u3', { reference: 'ref-ok', event_id: 'evt-bbbb-2' });
  check('B6 a paid reference reused by another student refused', okFirst && r.status === 403, r.body);
  r = await call('/verify-paystack', 'u2', { reference: 'ref-ok', event_id: 'evt-aaaa-1' });
  check('B6 a paid reference reused for another event refused', r.status === 409 || r.status === 403 || r.status === 400, r.body);
  r = await call('/verify-paystack', 'u2', { reference: 'ref-ok', event_id: 'evt-bbbb-2', quantity: 10 });
  const tickets = db.event_registrations.filter(x => x.user_id === 'u2').reduce((s, x) => s + (x.ticket_quantity || 1), 0);
  check('B7 re-verifying the same payment asking for 10 tickets still gives 1', r.status === 200 && tickets === 1, { tickets, b: r.body });
  seed();
  gateway['ref-race'] = { status: 'completed', pricing: { amount: '5000.00', currency: 'NGN' }, customer: { email: 'u4@st.tau.edu.ng' } };
  await Promise.all(Array.from({ length: 5 }, () => call('/verify-paystack', 'u4', { reference: 'ref-race', event_id: 'evt-bbbb-2' })));
  check('B8 five simultaneous verifications of one payment issue one ticket', db.event_registrations.filter(x => x.user_id === 'u4').length === 1 && db.payments.filter(p => p.transaction_id === 'ref-race').length === 1, { regs: db.event_registrations.length, pays: db.payments.length });
  seed();
  r = await call('/verify-paystack', 'u1', { reference: '../../v1/payments/ch_victim', event_id: 'evt-bbbb-2' });
  check('B9 path tricks in the reference can\'t reach other Bachs endpoints', r.status >= 400 && (!gateway.lastGetUrl || !/\.\.\//.test(gateway.lastGetUrl)), { s: r.status, url: gateway.lastGetUrl });
  r = await call('/verify-paystack', 'u1', { reference: 'x'.repeat(5000), event_id: 'evt-bbbb-2' });
  check('B9 5000-character reference refused', r.status === 400, r.body);

  // ---------------- 3. Forged webhooks ----------------
  seed();
  r = await call('/bachs-session', 'u5', { event_id: 'evt-bbbb-2', quantity: 1 });
  const wh = { type: 'checkout.completed', data: { id: 'chk_1', status: 'completed', pricing: { amount: '5000.00', currency: 'NGN' }, customer: { email: 'u5@st.tau.edu.ng' } } };
  r = await call('/webhook', 'x', wh);
  check('C1 webhook with no signature rejected', r.status === 401 && db.event_registrations.length === 0, r.status);
  r = await call('/webhook', 'x', wh, 'POST', { 'x-bachs-signature': sign(wh, 'guessed-key') });
  check('C2 webhook signed with a guessed key rejected', r.status === 401 && db.event_registrations.length === 0, r.status);
  r = await call('/webhook', 'x', wh, 'POST', { 'x-bachs-signature': 'a'.repeat(64) });
  check('C2 webhook with a junk signature rejected', r.status === 401, r.status);
  const cheap = { ...wh, data: { ...wh.data, pricing: { amount: '1.00', currency: 'NGN' } } };
  r = await call('/webhook', 'x', cheap, 'POST', { 'x-bachs-signature': sign(wh) });
  check('C3 signature from one webhook reused on a changed body rejected', r.status === 401 && db.event_registrations.length === 0, r.status);
  r = await call('/webhook', 'x', cheap, 'POST', { 'x-bachs-signature': sign(cheap) });
  check('C4 properly signed but underpaid webhook issues no ticket', db.event_registrations.length === 0, { s: r.status });
  r = await call('/webhook', 'x', wh, 'POST', { 'x-webhook-token': 'wrong' });
  check('C5 webhook with a wrong shared token rejected', r.status === 401, r.status);
  r = await call('/webhook', 'x', wh, 'POST', { 'x-bachs-signature': sign(wh) });
  r = await call('/webhook', 'x', wh, 'POST', { 'x-bachs-signature': sign(wh) });
  check('C6 a genuine webhook replayed twice still gives exactly one ticket and one email', db.event_registrations.length === 1 && global.ticketEmails === 1, { regs: db.event_registrations.length, e: global.ticketEmails });
  delete process.env.PAYSTACK_SECRET_KEY;
  r = await call('/webhook', 'x', { event: 'charge.success', data: { reference: 'ps-1', amount: 500000, customer: { email: 'u6@st.tau.edu.ng' } } });
  check('C7 Paystack-style webhook without Paystack configured issues nothing', db.event_registrations.filter(x => x.user_id === 'u6').length === 0, { s: r.status });

  // ---------------- 4. Guest checkout abuse ----------------
  seed();
  const guest = { name: 'Eve Guest', email: 'eve@gmail.com', phone: '08012345678' };
  r = await call('/guest-session', 'anon', { event_id: 'evt-clsd-8', quantity: 1, ...guest });
  check('D1 guest buying a members-only event refused', r.status === 403, r.body);
  r = await call('/guest-session', 'anon', { event_id: 'evt-gone-0', quantity: 1, ...guest });
  check('D1 guest buying an inactive event refused', r.status === 400, r.body);
  r = await call('/guest-session', 'anon', { event_id: 'evt-publ-7', quantity: 1, ...guest, email: 'u1@st.tau.edu.ng' });
  check('D2 member email used as a guest to dodge member rules refused', r.status === 409, r.body);
  r = await call('/guest-session', 'anon', { event_id: 'evt-publ-7', items: [{ item_id: FIFA, plays: 1 }], ...guest });
  check('D3 guest sending a games list to a normal event (₦0 trick) refused', r.status === 400 && !db.payments.some(p => Number(p.amount) <= 0), r.body);
  r = await call('/guest-session', 'anon', { event_id: GAMEEV, items: [{ item_id: LUDO, plays: 1 }], ...guest });
  check('D3 guest adding a members-only game refused', r.status === 403, r.body);
  r = await call('/guest-session', 'anon', { event_id: 'evt-publ-7', quantity: 1, ...guest, name: 'Eve\r\nBcc: everyone@tau.edu.ng' });
  const gp = db.payments.find(p => p.guest_email === 'eve@gmail.com');
  check('D4 line breaks in the guest name (email header injection) are refused or stripped', r.status === 400 || (gp && !/[\r\n]/.test(gp.guest_name)), { s: r.status, n: gp && gp.guest_name });
  r = await call('/guest-session', 'anon', { event_id: 'evt-publ-7', quantity: 1, ...guest, email: 'eve@gmail.com\r\nBcc: x@y.com' });
  check('D4 line breaks in the guest email refused', r.status === 400, r.body);
  seed();
  r = await call('/guest-session', 'anon', { event_id: 'evt-publ-7', quantity: 1, ...guest });
  const gref = r.body.data && r.body.data.checkout_id;
  gateway[gref] = { status: 'completed', pricing: { amount: String(Number(r.body.data.total_amount).toFixed(2)), currency: 'NGN' }, customer: { email: 'eve@gmail.com' } };
  r = await call('/guest-verify', 'anon', { reference: gref, email: 'mallory@gmail.com' });
  check('D5 guest ticket can\'t be claimed with someone else\'s email', r.status === 404, r.body);
  r = await call('/verify-paystack', 'u1', { reference: gref, event_id: 'evt-publ-7' });
  check('D6 a member can\'t take over a guest\'s paid order', r.status === 403 && !db.event_registrations.some(x => x.user_id === 'u1'), r.body);

  // ---------------- 5. Data exposure on receipts ----------------
  r = await call('/guest-verify', 'anon', { reference: gref, email: 'eve@gmail.com' });
  r = await call('/receipt/' + encodeURIComponent(gref), '', null, 'GET');
  const pub = JSON.stringify(r.body);
  check('E1 a receipt link shows guest name and email for the ticket but no guest phone', r.status === 200 && pub.includes('eve@gmail.com') && !pub.includes('08012345678'), r.body.data && r.body.data.registration);
  seed();
  gateway['ref-u7'] = { status: 'completed', pricing: { amount: '5000.00', currency: 'NGN' }, customer: { email: 'u7@st.tau.edu.ng' } };
  r = await call('/verify-paystack', 'u7', { reference: 'ref-u7', event_id: 'evt-bbbb-2' });
  r = await call('/receipt/ref-u7', '', null, 'GET');
  const pub2 = JSON.stringify(r.body);
  check('E2 a student\'s receipt shows attendee details for the ticket but no internal account id', pub2.includes('u7@st.tau.edu.ng') && !pub2.includes('"user_id":"u7"'), r.body.data && { reg: r.body.data.registration, payment: r.body.data.payment });

  // ---------------- 6. Doing admin things without being admin ----------------
  seed();
  db.payments.push({ id: '11111111-1111-4111-8111-111111111111', status: 'pending', user_id: 'u1', event_id: 'evt-bbbb-2', transaction_id: 'manual-1', amount: 5000, payment_type: 'event_registration', notes: 'Bank transfer' });
  r = await call('/11111111-1111-4111-8111-111111111111/verify', 'u1', { status: 'verified' }, 'PUT');
  check('F1 a student approving their own payment refused', r.status === 403, r.status);
  r = await call('/fee-settings', 'u1', { member_service_fee: 0 }, 'PUT');
  check('F2 a student changing the service fee refused', r.status === 403, r.status);
  r = await call('/fee-settings', 'admin1', { member_service_fee: 0 }, 'PUT', { 'x-admin': '1' });
  check('F2 an ordinary admin changing the service fee refused (super admin only)', r.status === 403, r.status);
  r = await call('/fee-settings', 'boss', { member_service_fee: -50 }, 'PUT', { 'x-admin': '1', 'x-super': '1' });
  check('F3 a negative service fee refused even for super admins', r.status === 400, { s: r.status, b: r.body });
  for (const [m, p] of [['GET', '/'], ['GET', '/revenue'], ['GET', '/export/csv'], ['GET', '/stats'], ['POST', '/refresh-gateway-fees'], ['POST', '/archive'], ['POST', '/unarchive'], ['POST', '/manual-reserve'], ['POST', '/11111111-1111-4111-8111-111111111111/gateway-recheck']]) {
    r = await call(p, 'u1', m === 'GET' ? null : {}, m);
    check(`F4 student calling admin route ${m} ${p} refused`, r.status === 403, r.status);
  }
  r = await call('/cleanup-abandoned', '', null, 'GET', { authorization: 'Bearer guess' });
  check('F5 cleanup job without the secret refused', r.status === 401, r.status);
  r = await call('/11111111-1111-4111-8111-111111111111/recheck', 'u2', {});
  check('F6 re-checking someone else\'s payment looks like "not found"', r.status === 404, r.status);

  server.close();
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  process.exitCode = fails ? 1 : 0; setTimeout(() => process.exit(process.exitCode), 200);
})().catch(e => { console.error(e); process.exit(2); });
