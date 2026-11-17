// Stubbed test of payment.js security checks. Run with: npm test (or node tests/suites/payments.test.js)
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
  // --- Live key, production ---
  process.env.BACHS_SECRET_KEY = 'sk_live_x'; process.env.NODE_ENV = 'production'; delete process.env.ALLOW_PAYMENT_SIMULATION;
  reset();
  let r = await call('/bachs-session', 'u1', { event_id: 'evt-bbbb-2', amount: 1 });
  check('session uses server price not client amount', r.status === 200 && gateway.lastCreate.pricing.amount === '5000.00', r);
  r = await call('/bachs-session', 'u1', { event_id: 'evt-free-3', amount: 1 });
  check('session rejected for free event', r.status === 400, r);

  gateway['ref-cheap'] = { status: 'completed', pricing: { amount: '100.00', currency: 'NGN' }, customer: { email: 'u1@st.tau.edu.ng' } };
  r = await call('/verify-paystack', 'u1', { reference: 'ref-cheap', event_id: 'evt-bbbb-2' });
  check('underpayment rejected', r.status === 400 && /less than/.test(r.body.error), r);

  r = await call('/verify-paystack', 'u1', { reference: 'ref-cheap', event_id: 'evt-aaaa-1' });
  check('correct payment accepted', r.status === 200, r);
  r = await call('/verify-paystack', 'u1', { reference: 'ref-cheap', event_id: 'evt-aaaa-1' });
  check('same event retry still ok (idempotent)', r.status === 200, r);
  gateway['ref-cheap'].pricing.amount = '5000.00';
  r = await call('/verify-paystack', 'u1', { reference: 'ref-cheap', event_id: 'evt-bbbb-2' });
  check('reference reuse for second event blocked', r.status === 409, r);
  r = await call('/verify-paystack', 'u2', { reference: 'ref-cheap', event_id: 'evt-aaaa-1' });
  check('other user cannot claim reference', r.status === 403, r);

  gateway['ref-other'] = { status: 'completed', pricing: { amount: '5000.00', currency: 'NGN' }, customer: { email: 'victim@st.tau.edu.ng' } };
  r = await call('/verify-paystack', 'u3', { reference: 'ref-other', event_id: 'evt-bbbb-2' });
  check('unrecorded reference from another payer blocked', r.status === 403, r);

  r = await call('/verify-paystack', 'u1', { reference: 'fake-ref', event_id: 'evt-bbbb-2' });
  check('unknown reference rejected (live)', r.status === 400, r);

  gateway['ref-noamt'] = { status: 'paid' };
  r = await call('/verify-paystack', 'u1', { reference: 'ref-noamt', event_id: 'evt-bbbb-2' });
  check('missing gateway amount rejected', r.status === 400, r);

  // Webhook-created row with no event, then claimed
  db.payments.push({ id: 'pay-wh', transaction_id: 'ref-wh', status: 'verified', user_id: 'u4', event_id: null, amount: 5000 });
  gateway['ref-wh'] = { status: 'completed', pricing: { amount: '5000.00', currency: 'NGN' } };
  r = await call('/verify-paystack', 'u4', { reference: 'ref-wh', event_id: 'evt-bbbb-2' });
  check('webhook row claimed for its event', r.status === 200 && db.payments.find(p => p.id === 'pay-wh').event_id === 'evt-bbbb-2', r);
  gateway['ref-wh'].pricing.amount = '9999';
  r = await call('/verify-paystack', 'u4', { reference: 'ref-wh', event_id: 'evt-aaaa-1' });
  check('claimed webhook row cannot be reused', r.status === 409, r);

  // --- Sandbox key, no simulation flag: must NOT fake success ---
  process.env.BACHS_SECRET_KEY = 'sk_test_x'; process.env.NODE_ENV = 'development';
  r = await call('/verify-paystack', 'u5', { reference: 'never-paid', event_id: 'evt-bbbb-2' });
  check('sandbox key does not simulate success', r.status === 400, r);

  // --- Missing key, dev, no flag ---
  delete process.env.BACHS_SECRET_KEY;
  r = await call('/verify-paystack', 'u5', { reference: 'never-paid-2', event_id: 'evt-bbbb-2' });
  check('missing key + no flag -> 503', r.status === 503, r);
  r = await call('/bachs-session', 'u5', { event_id: 'evt-bbbb-2' });
  check('missing key session -> 503', r.status === 503, r);

  // --- Flag set but Vercel production -> still refused ---
  process.env.ALLOW_PAYMENT_SIMULATION = 'true'; process.env.VERCEL_ENV = 'production';
  r = await call('/verify-paystack', 'u5', { reference: 'never-paid-3', event_id: 'evt-bbbb-2' });
  check('simulation flag ignored on Vercel production', r.status === 503, r);

  // --- Flag set locally -> simulation allowed ---
  delete process.env.VERCEL_ENV;
  r = await call('/verify-paystack', 'u5', { reference: 'sim-1', event_id: 'evt-bbbb-2' });
  check('local simulation works when explicitly enabled', r.status === 200, r);


  // ================= Reliability tests =================
  delete process.env.ALLOW_PAYMENT_SIMULATION; process.env.BACHS_SECRET_KEY = 'sk_live_x'; process.env.NODE_ENV = 'production';
  reset(); global.ticketEmails = 0;
  // session creation records an intent row
  r = await call('/bachs-session', 'u1', { event_id: 'evt-bbbb-2' });
  const intent = db.payments.find(p => p.transaction_id === 'chk_1');
  check('checkout intent recorded server-side', r.status === 200 && intent && intent.status === 'pending' && intent.event_id === 'evt-bbbb-2' && intent.user_id === 'u1' && r.body.data.payment_id === intent.id, { r, intent });

  // admin cannot manually approve an online checkout
  r = await call('/' + intent.id + '/verify', 'admin1', { status: 'verified' }, 'PUT');
  check('admin manual approval of online checkout blocked', r.status === 409, r);

  // webhook (signed) settles intent and issues ticket BEFORE responding
  const crypto = require('crypto');
  const whBody = { type: 'checkout.completed', data: { id: 'chk_1', status: 'completed', pricing: { amount: '5000.00', currency: 'NGN' }, customer: { email: 'u1@st.tau.edu.ng' } } };
  const raw = JSON.stringify(whBody);
  const sig = crypto.createHmac('sha256', 'sk_live_x').update(raw).digest('hex');
  r = await call('/webhook', 'x', whBody, 'POST', { 'x-bachs-signature': sig });
  const reg = db.event_registrations.find(x => x.user_id === 'u1' && x.event_id === 'evt-bbbb-2');
  check('webhook settles intent + registers student before 200', r.status === 200 && intent.status === 'verified' && reg && reg.linked_payment_id === intent.id, { r, intent, reg });
  check('ticket email sent once by webhook', global.ticketEmails === 1, global.ticketEmails);

  // webhook redelivery is idempotent
  r = await call('/webhook', 'x', whBody, 'POST', { 'x-bachs-signature': sig });
  check('webhook redelivery idempotent (no 2nd email)', r.status === 200 && global.ticketEmails === 1 && db.event_registrations.length === 1, { r, e: global.ticketEmails });

  // student re-check after webhook: same ticket, no new email
  gateway['chk_1'] = { status: 'completed', pricing: { amount: '5000.00', currency: 'NGN' }, customer: { email: 'u1@st.tau.edu.ng' } };
  r = await call('/' + intent.id + '/recheck', 'u1', {});
  check('re-check returns deterministic ticket, no extra email', r.status === 200 && r.body.data.ticket_number === ('NACOS-EVT--' + intent.id.substring(0,6).toUpperCase()) && global.ticketEmails === 1, { r, e: global.ticketEmails });

  // other user cannot re-check someone else's payment
  r = await call('/' + intent.id + '/recheck', 'u2', {});
  check('re-check of another user payment -> 404', r.status === 404, r);

  // lost tab: intent pending, no webhook, student re-checks
  r = await call('/bachs-session', 'u6', { event_id: 'evt-aaaa-1' });
  const intent2 = db.payments.find(p => p.user_id === 'u6');
  intent2.transaction_id = 'chk_lost'; // gateway id for this checkout
  gateway['chk_lost'] = { status: 'pending' };
  r = await call('/' + intent2.id + '/recheck', 'u6', {});
  check('re-check before payment completes -> not confirmed', r.status === 400 && /could not be verified/.test(r.body.error) && intent2.status === 'pending', r);
  gateway['chk_lost'] = { status: 'completed', pricing: { amount: '100.00', currency: 'NGN' }, customer: { email: 'u6@st.tau.edu.ng' } };
  r = await call('/' + intent2.id + '/recheck', 'u6', {});
  check('re-check after payment completes -> ticket issued', r.status === 200 && intent2.status === 'verified' && db.event_registrations.some(x => x.user_id === 'u6'), r);

  // underpaid webhook: recorded pending, no ticket
  db.payments.push({ id: 'pay-under-0001', transaction_id: 'chk_under', user_id: 'u7', event_id: 'evt-bbbb-2', status: 'pending', amount: 5000, notes: '[online-checkout] x' });
  const ub = { type: 'checkout.completed', data: { id: 'chk_under', status: 'completed', pricing: { amount: '100.00', currency: 'NGN' } } };
  const usig = crypto.createHmac('sha256', 'sk_live_x').update(JSON.stringify(ub)).digest('hex');
  const before = global.ticketEmails;
  r = await call('/webhook', 'x', ub, 'POST', { 'x-bachs-signature': usig });
  const up = db.payments.find(p => p.id === 'pay-under-0001');
  check('underpaid webhook: pending, flagged, no ticket', r.status === 200 && up.status === 'pending' && /UNDERPAID/.test(up.notes) && !db.event_registrations.some(x => x.user_id === 'u7') && global.ticketEmails === before, { r, up });
  r = await call('/' + up.id + '/verify', 'admin1', { status: 'verified' }, 'PUT');
  check('admin CAN review underpaid row (no longer marked online-checkout)', r.status !== 409, r);

  // unsigned webhook rejected
  r = await call('/webhook', 'x', whBody, 'POST', {});
  check('unsigned webhook rejected', r.status === 401, r);


  // ================= Multi-ticket tests =================
  process.env.BACHS_SECRET_KEY = 'sk_live_x'; process.env.NODE_ENV = 'production'; delete process.env.VERCEL_ENV; delete process.env.ALLOW_PAYMENT_SIMULATION;
  reset(); global.ticketEmails = 0; global.lastTicketPayment = null;
  db.events.push({ id: 'evt-capp-4', title: 'Capped', payment_amount: 100, max_attendees: 3, requires_payment: true });

  // quantity validation
  r = await call('/bachs-session', 'u1', { event_id: 'evt-aaaa-1', quantity: 0 });
  check('qty 0 rejected', r.status === 400, r);
  r = await call('/bachs-session', 'u1', { event_id: 'evt-aaaa-1', quantity: 11 });
  check('qty above max rejected', r.status === 400, r);
  r = await call('/bachs-session', 'u1', { event_id: 'evt-aaaa-1', quantity: 2.5 });
  check('fractional qty rejected', r.status === 400, r);

  // 2 x 100 = 200 charged at the gateway, recorded on the intent
  gateway.lastCreate = null;
  r = await call('/bachs-session', 'u1', { event_id: 'evt-aaaa-1', quantity: 2, amount: 1 });
  const qi = db.payments.find(p => p.user_id === 'u1' && p.event_id === 'evt-aaaa-1');
  check('2 tickets x 100 charges 200 at gateway', r.status === 200 && gateway.lastCreate.pricing.amount === '200.00' && r.body.data.total_amount === 200 && r.body.data.quantity === 2, { r, g: gateway.lastCreate });
  check('intent stores qty 2 and amount 200', qi && qi.ticket_quantity === 2 && qi.amount === 200, qi);

  // paying only one ticket's worth for a 2-ticket order is rejected
  qi.transaction_id = 'chk_q2';
  gateway['chk_q2'] = { status: 'completed', pricing: { amount: '100.00', currency: 'NGN' }, customer: { email: 'u1@st.tau.edu.ng' } };
  r = await call('/verify-paystack', 'u1', { reference: 'chk_q2', event_id: 'evt-aaaa-1', quantity: 1 });
  check('underpaid 2-ticket order rejected even if client claims qty 1', r.status === 400 && /less than/.test(r.body.error), r);

  gateway['chk_q2'].pricing.amount = '200.00';
  r = await call('/verify-paystack', 'u1', { reference: 'chk_q2', event_id: 'evt-aaaa-1' });
  const qreg = db.event_registrations.find(x => x.user_id === 'u1' && x.event_id === 'evt-aaaa-1');
  const ev1 = db.events.find(e => e.id === 'evt-aaaa-1');
  check('full payment issues registration with 2 tickets', r.status === 200 && qreg && qreg.ticket_quantity === 2 && r.body.data.ticket_quantity === 2 && r.body.data.total_amount === 200, { r, qreg });
  check('current_attendees counts tickets (2)', ev1.current_attendees === 2, ev1);
  check('ticket email got payment with qty 2', global.lastTicketPayment && global.lastTicketPayment.ticket_quantity === 2 && global.lastTicketPayment.amount === 200, global.lastTicketPayment);

  // second order for the same event is blocked
  r = await call('/bachs-session', 'u1', { event_id: 'evt-aaaa-1', quantity: 1 });
  check('second order for same event blocked', r.status === 409 && /already have 2/.test(r.body.error), r);

  // receipt shows quantity publicly
  r = await call('/receipt/chk_q2', 'nobody', null, 'GET');
  check('public receipt shows qty 2, unit 100, amount 200', r.status === 200 && r.body.data.ticket_quantity === 2 && r.body.data.unit_price === 100 && r.body.data.amount === 200, r);

  // capacity counted in tickets: cap 3, u2 buys 2, u3 wants 2 -> only 1 left
  r = await call('/bachs-session', 'u2', { event_id: 'evt-capp-4', quantity: 2 });
  const ci = db.payments.find(p => p.user_id === 'u2' && p.event_id === 'evt-capp-4'); ci.transaction_id = 'chk_cap';
  gateway['chk_cap'] = { status: 'completed', pricing: { amount: '200.00', currency: 'NGN' }, customer: { email: 'u2@st.tau.edu.ng' } };
  r = await call('/' + ci.id + '/recheck', 'u2', {});
  check('capped event: 2 tickets issued', r.status === 200 && db.events.find(e => e.id === 'evt-capp-4').current_attendees === 2, r);
  r = await call('/bachs-session', 'u3', { event_id: 'evt-capp-4', quantity: 2 });
  check('capacity in tickets: only 1 left -> 409', r.status === 409 && /Only 1 ticket/.test(r.body.error), r);
  r = await call('/bachs-session', 'u3', { event_id: 'evt-capp-4', quantity: 1 });
  check('last seat can still be bought', r.status === 200, r);

  // legacy row without a quantity settles as 1 ticket
  const wb = { type: 'checkout.completed', data: { id: 'chk_noint', status: 'completed', pricing: { amount: '300.00', currency: 'NGN' }, customer: { email: 'u4@st.tau.edu.ng' } } };
  db.payments.push({ id: require('crypto').randomUUID(), transaction_id: 'chk_noint', user_id: 'u4', event_id: 'evt-aaaa-1', status: 'pending', amount: 0, notes: 'legacy row without qty' });
  const wsig = require('crypto').createHmac('sha256', 'sk_live_x').update(JSON.stringify(wb)).digest('hex');
  r = await call('/webhook', 'x', wb, 'POST', { 'x-bachs-signature': wsig });
  const r4 = db.event_registrations.find(x => x.user_id === 'u4');
  check('legacy row (no qty) settles as 1 ticket', r.status === 200 && r4 && r4.ticket_quantity === 1, { r, r4 });

  // webhook with no recorded checkout but a Paystack-style event hint infers qty from amount
  process.env.PAYSTACK_SECRET_KEY = 'psk';
  const pb = { event: 'charge.success', data: { reference: 'ps_ref_1', amount: 30000, currency: 'NGN', customer: { email: 'u5@st.tau.edu.ng' }, metadata: { custom_fields: [{ variable_name: 'event_id', value: 'evt-aaaa-1' }] } } };
  const psig = require('crypto').createHmac('sha512', 'psk').update(JSON.stringify(pb)).digest('hex');
  r = await call('/webhook', 'x', pb, 'POST', { 'x-paystack-signature': psig });
  const r5 = db.event_registrations.find(x => x.user_id === 'u5');
  check('no-intent webhook infers 3 tickets from 300 / 100', r.status === 200 && r5 && r5.ticket_quantity === 3, { r, r5 });

  // manual proof: 2 tickets needs >= 200
  const proof = 'https://pnusmlckowqagnlzjqbv.supabase.co/storage/v1/object/x.png';
  process.env.SUPABASE_URL = 'https://pnusmlckowqagnlzjqbv.supabase.co';
  db.events.push({ id: 'evt-manu-5', title: 'Manual', payment_amount: 100, requires_payment: true });
  r = await call('/submit', 'u6', { amount: 150, payment_type: 'event_registration', payment_proof_url: proof, event_id: 'evt-manu-5', ticket_quantity: 2 });
  check('manual proof 150 for 2x100 rejected', r.status === 400 && /required total/.test(r.body.error), r);
  r = await call('/submit', 'u6', { amount: 200, payment_type: 'event_registration', payment_proof_url: proof, event_id: 'evt-manu-5', ticket_quantity: 2 });
  const mp = r.body && r.body.data && r.body.data.payment;
  check('manual proof 200 for 2x100 accepted with qty 2', r.status === 201 && mp && mp.ticket_quantity === 2, r);
  if (mp) {
    r = await call('/' + mp.id + '/verify', 'admin1', { status: 'verified' }, 'PUT');
    const mreg = db.event_registrations.find(x => x.user_id === 'u6' && x.event_id === 'evt-manu-5');
    check('admin approval registers 2 tickets', r.status === 200 && mreg && mreg.ticket_quantity === 2 && db.events.find(e => e.id === 'evt-manu-5').current_attendees === 2, { r, mreg });
  }

  // CSV export includes Tickets + Unit Price
  r = await call('/export/csv', 'admin1', null, 'GET');
  const csv = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
  check('CSV has Tickets and Unit Price columns', r.status === 200 && /Tickets/.test(csv) && /Unit Price/.test(csv), String(csv).slice(0, 300));


  // ================= Repeat purchases =================
  process.env.BACHS_SECRET_KEY = 'sk_live_x'; process.env.NODE_ENV = 'production'; delete process.env.VERCEL_ENV; delete process.env.ALLOW_PAYMENT_SIMULATION;
  reset(); global.ticketEmails = 0; global.lastTicketPayment = null; global.lastTicketTo = null;
  const C = require('crypto');
  const repEv = { id: 'evt-rept-6', title: 'Game night', payment_amount: 100, requires_payment: true, allow_repeat_orders: false };
  db.events.push(repEv);
  const buy = async (user, eventId, qty, ref, amount) => {
    const s1 = await call('/bachs-session', user, { event_id: eventId, quantity: qty });
    if (s1.status !== 200) return s1;
    const row = db.payments.find(p => p.id === s1.body.data.payment_id);
    row.transaction_id = ref;
    gateway[ref] = { status: 'completed', pricing: { amount: amount.toFixed(2), currency: 'NGN' }, customer: { email: user + '@st.tau.edu.ng' } };
    return call('/' + row.id + '/recheck', user, {});
  };
  r = await buy('u1', 'evt-rept-6', 1, 'chk_rep_1', 100);
  check('repeat-off: first order ok', r.status === 200, r);
  r = await call('/bachs-session', 'u1', { event_id: 'evt-rept-6', quantity: 1 });
  check('repeat-off: second order blocked', r.status === 409, r);

  repEv.allow_repeat_orders = true; // admin flips the switch
  r = await buy('u1', 'evt-rept-6', 2, 'chk_rep_2', 200);
  const u1Regs = db.event_registrations.filter(x => x.user_id === 'u1' && x.event_id === 'evt-rept-6');
  check('repeat-on: second order issues a separate registration', r.status === 200 && u1Regs.length === 2 && u1Regs.map(x => x.ticket_quantity).sort().join(',') === '1,2', { r, u1Regs });
  check('repeat-on: each order has its own ticket number', r.body.data && r.body.data.ticket_number !== undefined && new Set(u1Regs.map(x => x.linked_payment_id)).size === 2, r.body);
  check('repeat-on: seats count all orders (3 tickets)', repEv.current_attendees === 3, repEv);
  r = await buy('u1', 'evt-rept-6', 1, 'chk_rep_3', 100);
  check('repeat-on: no per-student limit (third order ok)', r.status === 200 && db.event_registrations.filter(x => x.user_id === 'u1' && x.event_id === 'evt-rept-6').length === 3, r);
  const emailsBefore = global.ticketEmails;
  r = await call('/' + db.payments.find(p => p.transaction_id === 'chk_rep_2').id + '/recheck', 'u1', {});
  check('repeat-on: re-check of an old order is idempotent', r.status === 200 && global.ticketEmails === emailsBefore && db.event_registrations.filter(x => x.user_id === 'u1' && x.event_id === 'evt-rept-6').length === 3, r);

  repEv.allow_repeat_orders = false; // switched off again
  r = await call('/bachs-session', 'u1', { event_id: 'evt-rept-6', quantity: 1 });
  check('repeat switched off again: new orders blocked', r.status === 409 && /already have 4/.test(r.body.error), r);

  // ================= Guest checkout =================
  const pubEv = { id: 'evt-publ-7', title: 'Open day', payment_amount: 100, requires_payment: true, open_to_public: true, public_price: 150, max_attendees: 5, is_active: true };
  const closedEv = { id: 'evt-clsd-8', title: 'Members only', payment_amount: 100, requires_payment: true, open_to_public: false, public_price: null };
  db.events.push(pubEv, closedEv);
  const guest = { name: 'Ada Guest', email: 'ada@gmail.com', phone: '+2348012345678' };

  r = await call('/guest-session', 'anon', { event_id: 'evt-clsd-8', quantity: 1, ...guest });
  check('guest: members-only event refused', r.status === 403, r);
  r = await call('/guest-session', 'anon', { event_id: 'evt-publ-7', quantity: 1, ...guest, email: 'not-an-email' });
  check('guest: invalid email refused', r.status === 400, r);
  r = await call('/guest-session', 'anon', { event_id: 'evt-publ-7', quantity: 1, ...guest, phone: 'abc' });
  check('guest: invalid phone refused', r.status === 400, r);
  r = await call('/guest-session', 'anon', { event_id: 'evt-publ-7', quantity: 1, ...guest, email: 'someone@st.tau.edu.ng' });
  check('guest: member (tau) email told to sign in', r.status === 409 && /sign in/i.test(r.body.error), r);
  r = await call('/guest-session', 'anon', { event_id: 'evt-publ-7', quantity: 1, ...guest, email: 'u3@st.tau.edu.ng' });
  check('guest: existing student email told to sign in', r.status === 409, r);

  gateway.lastCreate = null;
  r = await call('/guest-session', 'anon', { event_id: 'evt-publ-7', quantity: 2, ...guest, amount: 1 });
  const gi = r.body && r.body.data && db.payments.find(p => p.id === r.body.data.payment_id);
  check('guest: 2 x guest price 150 = 300 charged', r.status === 200 && gateway.lastCreate.pricing.amount === '300.00' && gateway.lastCreate.customer.email === 'ada@gmail.com' && r.body.data.total_amount === 300, { r, g: gateway.lastCreate });
  check('guest: order recorded with guest details, no user', gi && gi.user_id === null && gi.guest_email === 'ada@gmail.com' && gi.guest_phone === '+2348012345678' && gi.ticket_quantity === 2 && gi.amount === 300, gi);

  gi.transaction_id = 'chk_guest_1';
  gateway['chk_guest_1'] = { status: 'completed', pricing: { amount: '150.00', currency: 'NGN' }, customer: { email: 'ada@gmail.com' } };
  r = await call('/guest-verify', 'anon', { reference: 'chk_guest_1', email: 'wrong@gmail.com' });
  check('guest: wrong email cannot see/confirm the order', r.status === 404, r);
  r = await call('/guest-verify', 'anon', { reference: 'chk_guest_1', email: 'ada@gmail.com' });
  check('guest: underpaid order rejected', r.status === 400 && /less than/.test(r.body.error), r);
  r = await call('/verify-paystack', 'u2', { reference: 'chk_guest_1', event_id: 'evt-publ-7' });
  check('guest: a member cannot claim a guest reference', r.status === 403, r);

  gateway['chk_guest_1'].pricing.amount = '300.00';
  global.lastTicketTo = null;
  r = await call('/guest-verify', 'anon', { reference: 'chk_guest_1', email: 'ADA@gmail.com ' });
  const greg = db.event_registrations.find(x => x.linked_payment_id === gi.id);
  check('guest: paid order issues guest ticket (2 tickets)', r.status === 200 && greg && greg.user_id === null && greg.guest_email === 'ada@gmail.com' && greg.ticket_quantity === 2 && r.body.data.ticket_quantity === 2 && r.body.data.total_amount === 300, { r, greg });
  check('guest: ticket emailed to the guest', global.lastTicketTo === 'ada@gmail.com', global.lastTicketTo);
  check('guest: seats include guest tickets', pubEv.current_attendees === 2, pubEv);
  const ge = global.ticketEmails;
  r = await call('/guest-verify', 'anon', { reference: 'chk_guest_1', email: 'ada@gmail.com' });
  check('guest: lookup again returns same ticket, no 2nd email', r.status === 200 && global.ticketEmails === ge && db.event_registrations.filter(x => x.linked_payment_id === gi.id).length === 1, r);
  check('guest: response has no other PII', r.body.data && !('guest_phone' in r.body.data.payment) && r.body.data.guest.email === 'ada@gmail.com', r.body.data);

  // capacity: 5 seats, 2 used -> guest asking for 4 refused
  r = await call('/guest-session', 'anon', { event_id: 'evt-publ-7', quantity: 4, ...guest, email: 'bola@yahoo.com' });
  check('guest: capacity counts tickets (only 3 left)', r.status === 409 && /Only 3/.test(r.body.error), r);

  // webhook settles a guest order and does NOT attach it to a student
  r = await call('/guest-session', 'anon', { event_id: 'evt-publ-7', quantity: 1, name: 'Bola', email: 'u4@st-friend.com', phone: '08012345678' });
  const gw2 = db.payments.find(p => p.id === r.body.data.payment_id);
  gw2.transaction_id = 'chk_guest_2';
  const gwb = { type: 'checkout.completed', data: { id: 'chk_guest_2', status: 'completed', pricing: { amount: '150.00', currency: 'NGN' }, customer: { email: 'u4@st-friend.com' } } };
  const gsig = C.createHmac('sha256', 'sk_live_x').update(JSON.stringify(gwb)).digest('hex');
  r = await call('/webhook', 'x', gwb, 'POST', { 'x-bachs-signature': gsig });
  const greg2 = db.event_registrations.find(x => x.linked_payment_id === gw2.id);
  check('guest: webhook issues guest ticket at guest price', r.status === 200 && gw2.status === 'verified' && greg2 && greg2.user_id === null && greg2.guest_name === 'Bola', { r, gw2, greg2 });

  // admin cannot manually approve a guest online checkout either
  r = await call('/guest-session', 'anon', { event_id: 'evt-publ-7', quantity: 1, name: 'Chi', email: 'chi@gmail.com', phone: '08011112222' });
  r = await call('/' + r.body.data.payment_id + '/verify', 'admin1', { status: 'verified' }, 'PUT');
  check('guest: admin cannot hand-approve an unpaid guest checkout', r.status === 409, r);

  // CSV marks guests
  r = await call('/export/csv', 'admin1', null, 'GET');
  const gcsv = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
  check('CSV has Buyer Type with Guest rows', r.status === 200 && /Buyer Type/.test(gcsv) && /"Guest"/.test(gcsv) && /ada@gmail\.com/.test(gcsv), gcsv.slice(0, 300));


  // ================= Reference matching + status variants =================
  process.env.BACHS_SECRET_KEY = 'sk_live_x'; process.env.NODE_ENV = 'production'; delete process.env.VERCEL_ENV; delete process.env.ALLOW_PAYMENT_SIMULATION;
  reset(); global.ticketEmails = 0;
  const C2 = require('crypto');
  const ev9 = { id: 'evt-refs-9', title: 'Ref test', payment_amount: 100, requires_payment: true, open_to_public: true, public_price: 300, is_active: true };
  db.events.push(ev9);

  // Guest order exactly like the real one: recorded as chk_..., Bachs charge is ch_...
  r = await call('/guest-session', 'anon', { event_id: 'evt-refs-9', quantity: 1, name: 'Gbolahan', email: 'olu@gmail.com', phone: '08126398496' });
  const order = db.payments.find(p => p.id === r.body.data.payment_id);
  order.transaction_id = 'chk_rM0x1pxDA5sWkZ2d';

  // Webhook whose data.id is the CHARGE id and checkout_id is our checkout id
  const wh = { type: 'payment.succeeded', data: { id: 'ch_1c26e464ebcf4790a72dea794af9de0b', checkout_id: 'chk_rM0x1pxDA5sWkZ2d', status: 'succeeded', amount: '300.00', currency: 'NGN', customer: { email: 'olu@gmail.com' } } };
  const whSig = C2.createHmac('sha256', 'sk_live_x').update(JSON.stringify(wh)).digest('hex');
  r = await call('/webhook', 'x', wh, 'POST', { 'x-bachs-signature': whSig });
  const whReg = db.event_registrations.find(x => x.linked_payment_id === order.id);
  check('webhook matches on checkout_id even when data.id is the charge id', r.status === 200 && order.status === 'verified' && !!whReg, { r, order, whReg });
  check('webhook did not create a duplicate payment row for the charge id', !db.payments.some(p => p.transaction_id === 'ch_1c26e464ebcf4790a72dea794af9de0b'), db.payments.map(p => p.transaction_id));
  check('charge id recorded in notes for reconciliation', /ch_1c26e464/.test(order.notes || ''), order.notes);

  // status "complete" + payment_status "paid" counts as paid (verify path)
  r = await call('/guest-session', 'anon', { event_id: 'evt-refs-9', quantity: 1, name: 'Ada', email: 'ada2@gmail.com', phone: '08011112222' });
  const order2 = db.payments.find(p => p.id === r.body.data.payment_id);
  order2.transaction_id = 'chk_status_variant';
  gateway['chk_status_variant'] = { status: 'complete', payment_status: 'paid', pricing: { amount: '300.00', currency: 'NGN' }, customer: { email: 'ada2@gmail.com' } };
  r = await call('/guest-verify', 'anon', { reference: 'chk_status_variant', email: 'ada2@gmail.com' });
  check('status complete + payment_status paid is accepted', r.status === 200 && order2.status === 'verified', r);

  // status "open" / payment_status "unpaid" is NOT paid
  r = await call('/guest-session', 'anon', { event_id: 'evt-refs-9', quantity: 1, name: 'Bayo', email: 'bayo@gmail.com', phone: '08033334444' });
  const order3 = db.payments.find(p => p.id === r.body.data.payment_id);
  order3.transaction_id = 'chk_unpaid';
  gateway['chk_unpaid'] = { status: 'open', payment_status: 'unpaid', pricing: { amount: '300.00', currency: 'NGN' } };
  r = await call('/guest-verify', 'anon', { reference: 'chk_unpaid', email: 'bayo@gmail.com' });
  check('open/unpaid checkout is not treated as paid', r.status === 400 && order3.status === 'pending', r);

  // Admin re-check: unpaid stays pending, paid gets confirmed + ticket
  r = await call('/' + order3.id + '/gateway-recheck', 'admin1', {});
  check('admin re-check of unpaid order reports not confirmed', r.status === 400 && order3.status === 'pending', r);
  gateway['chk_unpaid'] = { status: 'complete', payment_status: 'paid', pricing: { amount: '300.00', currency: 'NGN' }, customer: { email: 'bayo@gmail.com' } };
  r = await call('/' + order3.id + '/gateway-recheck', 'admin1', {});
  check('admin re-check confirms a paid order and issues the ticket', r.status === 200 && order3.status === 'verified' && db.event_registrations.some(x => x.linked_payment_id === order3.id) && r.body.data.newly_issued === true, r);
  r = await call('/' + order3.id + '/gateway-recheck', 'admin1', {});
  check('admin re-check again is idempotent', r.status === 200 && r.body.data.newly_issued === false && db.event_registrations.filter(x => x.linked_payment_id === order3.id).length === 1, r);

  // Member order: admin re-check uses the student's email for the payer check
  r = await call('/bachs-session', 'u2', { event_id: 'evt-refs-9', quantity: 2 });
  const order4 = db.payments.find(p => p.id === r.body.data.payment_id);
  order4.transaction_id = 'chk_member_rc';
  gateway['chk_member_rc'] = { status: 'paid', pricing: { amount: '200.00', currency: 'NGN' }, customer: { email: 'u2@st.tau.edu.ng' } };
  r = await call('/' + order4.id + '/gateway-recheck', 'admin1', {});
  check('admin re-check works for member orders (2 tickets)', r.status === 200 && order4.status === 'verified' && r.body.data.ticket_quantity === 2, r);


  // ================= Ticket fees =================
  process.env.BACHS_SECRET_KEY = 'sk_live_x'; process.env.NODE_ENV = 'production'; delete process.env.VERCEL_ENV; delete process.env.ALLOW_PAYMENT_SIMULATION;
  reset(); global.ticketEmails = 0; global.lastTicketPayment = null;
  db.fee_settings = [{ id: 1, member_service_fee: 0, guest_service_fee: 0, customer_bears_gateway_fee: true }];
  const evF = { id: 'evt-fees-10', title: 'Fee night', payment_amount: 100, requires_payment: true, open_to_public: true, public_price: 300, is_active: true };
  const evNoFee = { id: 'evt-nofe-11', title: 'Charity', payment_amount: 100, requires_payment: true, service_fee_override: 0, is_active: true };
  db.events.push(evF, evNoFee);

  r = await call('/fee-settings', 'admin1', { member_service_fee: -5 }, 'PUT');
  check('fees: negative service fee rejected', r.status === 400, r);
  r = await call('/fee-settings', 'admin1', { member_service_fee: 50, guest_service_fee: 100, customer_bears_gateway_fee: true }, 'PUT');
  check('fees: super admin saves settings', r.status === 200 && r.body.data.member_service_fee === 50 && r.body.data.guest_service_fee === 100, r);
  r = await call('/fees', 'anon', null, 'GET');
  check('fees: public fee info for the events page', r.status === 200 && r.body.data.member_service_fee === 50 && r.body.data.gateway_fee_added_at_checkout === true, r);

  // Member: 2 x 100 + 2 x 50 = 300, Bachs adds its fee on top
  gateway.lastCreate = null;
  r = await call('/bachs-session', 'u1', { event_id: 'evt-fees-10', quantity: 2 });
  const fo = db.payments.find(p => p.id === r.body.data.payment_id);
  check('fees: member total = tickets + service fee (300)', r.status === 200 && gateway.lastCreate.pricing.amount === '300.00' && r.body.data.subtotal_amount === 200 && r.body.data.service_fee === 100 && r.body.data.total_amount === 300, { body: r.body.data, g: gateway.lastCreate });
  check('fees: Bachs asked to add its fee on top (customer_bears_fee)', gateway.lastCreate.customer_bears_fee === true, gateway.lastCreate);
  check('fees: order stores the breakdown', fo.amount === 300 && fo.subtotal_amount === 200 && fo.service_fee === 100, fo);

  fo.transaction_id = 'chk_fee_1';
  gateway['chk_fee_1'] = { status: 'paid', pricing: { amount: '200.00', currency: 'NGN' }, customer: { email: 'u1@st.tau.edu.ng' } };
  r = await call('/' + fo.id + '/recheck', 'u1', {});
  check('fees: paying only the ticket price (no service fee) is rejected', r.status === 400 && /less than/.test(r.body.error), r);

  // Gateway reports total incl. its own fee (304.50) and the fee itself
  gateway['chk_fee_1'] = { status: 'paid', pricing: { amount: '304.50', currency: 'NGN' }, fees: { amount: '4.50', currency: 'NGN' }, fee_paid_by: 'customer', customer: { email: 'u1@st.tau.edu.ng' } };
  r = await call('/' + fo.id + '/recheck', 'u1', {});
  check('fees: paid order confirmed; stored amount stays tickets + service fee', r.status === 200 && fo.status === 'verified' && fo.amount === 300 && fo.subtotal_amount === 200 && fo.service_fee === 100, { r, fo });
  check('fees: Bachs fee recorded separately', fo.gateway_fee === 4.5 && fo.gateway_fee_paid_by === 'customer', fo);
  check('fees: response carries the breakdown', r.body.data.subtotal_amount === 200 && r.body.data.service_fee === 100 && r.body.data.gateway_fee === 4.5, r.body.data);
  check('fees: ticket email gets the breakdown', global.lastTicketPayment && global.lastTicketPayment.service_fee === 100 && global.lastTicketPayment.gateway_fee === 4.5, global.lastTicketPayment);

  // Guest: 1 x 300 + 1 x 100 guest fee = 400
  gateway.lastCreate = null;
  r = await call('/guest-session', 'anon', { event_id: 'evt-fees-10', quantity: 1, name: 'Kemi', email: 'kemi@gmail.com', phone: '08011112222' });
  const go = db.payments.find(p => p.id === r.body.data.payment_id);
  check('fees: guest total = guest price + guest service fee (400)', r.status === 200 && gateway.lastCreate.pricing.amount === '400.00' && go.subtotal_amount === 300 && go.service_fee === 100 && gateway.lastCreate.customer_bears_fee === true, { body: r.body.data, go });

  // Per-event override 0 = no service fee
  gateway.lastCreate = null;
  r = await call('/bachs-session', 'u2', { event_id: 'evt-nofe-11', quantity: 3 });
  check('fees: event override 0 charges no service fee', r.status === 200 && gateway.lastCreate.pricing.amount === '300.00' && r.body.data.service_fee === 0, r.body.data);

  // Webhook with no recorded checkout infers quantity from (price + fee): 300 / 150 = 2
  process.env.PAYSTACK_SECRET_KEY = 'psk';
  const fpb = { event: 'charge.success', data: { reference: 'ps_fee_1', amount: 30000, currency: 'NGN', customer: { email: 'u3@st.tau.edu.ng' }, metadata: { custom_fields: [{ variable_name: 'event_id', value: 'evt-fees-10' }, { variable_name: 'user_id', value: 'u3' }] } } };
  const fpsig = require('crypto').createHmac('sha512', 'psk').update(JSON.stringify(fpb)).digest('hex');
  r = await call('/webhook', 'x', fpb, 'POST', { 'x-paystack-signature': fpsig });
  const fwRow = db.payments.find(p => p.transaction_id === 'ps_fee_1');
  check('fees: webhook without a recorded order infers 2 tickets from price + fee', r.status === 200 && fwRow && fwRow.status === 'verified' && fwRow.ticket_quantity === 2 && fwRow.subtotal_amount === 200 && fwRow.service_fee === 100 && fwRow.amount === 300, fwRow);

  // Receipt shows the breakdown publicly
  r = await call('/receipt/chk_fee_1', 'nobody', null, 'GET');
  check('fees: receipt has subtotal, service fee, Bachs fee', r.status === 200 && r.body.data.subtotal_amount === 200 && r.body.data.service_fee === 100 && r.body.data.gateway_fee === 4.5 && r.body.data.unit_price === 100, r.body.data);

  // Revenue report
  r = await call('/revenue', 'admin1', null, 'GET');
  const evRow = (r.body.data?.by_event || []).find(e => e.event_id === 'evt-fees-10');
  check('fees: revenue splits tickets / service fees / Bachs fees', r.status === 200 && evRow && evRow.ticket_revenue === 400 && evRow.service_fees === 200 && evRow.gateway_fees === 4.5 && evRow.tickets === 4, { totals: r.body.data?.totals, evRow });

  // CSV has the fee columns
  r = await call('/export/csv', 'admin1', null, 'GET');
  const fcsv = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
  check('fees: CSV has subtotal, service fee and Bachs fee columns', /Tickets Subtotal/.test(fcsv) && /Service Fee/.test(fcsv) && /Bachs Fee/.test(fcsv), fcsv.slice(0, 200));

  // Turning the fee back to 0 restores old prices
  r = await call('/fee-settings', 'admin1', { member_service_fee: 0, guest_service_fee: 0 }, 'PUT');
  gateway.lastCreate = null;
  r = await call('/bachs-session', 'u4', { event_id: 'evt-fees-10', quantity: 1 });
  check('fees: fee 0 means ticket price only', r.status === 200 && gateway.lastCreate.pricing.amount === '100.00', r.body.data);

  // ---------------- Manual spot reservation (complimentary & cash) ----------------
  r = await call('/manual-reserve', 'admin1', { event_id: 'evt-fees-10', attendee_type: 'guest', guest_name: 'VIP Speaker', guest_email: 'vip@domain.org', quantity: 2, reservation_mode: 'complimentary', notes: 'Keynote speaker' });
  check('manual-reserve: complimentary ₦0 guest reservation issues 2 tickets', r.status === 201 && r.body.data.amount === 0 && r.body.data.ticket_quantity === 2 && /^RSV-/.test(r.body.data.reference) && /^NACOS-/.test(r.body.data.ticket_number), r.body);
  r = await call('/receipt/' + encodeURIComponent(r.body.data.reference), 'nobody', null, 'GET');
  check('manual-reserve: receipt shows guest name and email for reserved ticket', r.status === 200 && r.body.data.student && r.body.data.student.name === 'VIP Speaker' && r.body.data.student.email === 'vip@domain.org', r.body.data);

  r = await call('/manual-reserve', 'admin1', { event_id: 'evt-aaaa-1', attendee_type: 'student', student_identifier: 'u6@st.tau.edu.ng', quantity: 1, reservation_mode: 'cash', amount_paid: 100, notes: 'Paid cash at desk' });
  check('manual-reserve: cash student reservation records ₦100 and issues ticket', r.status === 201 && r.body.data.amount === 100 && r.body.data.attendee.email === 'u6@st.tau.edu.ng', r.body);

  server.close();
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  process.exitCode = fails ? 1 : 0; setTimeout(() => process.exit(process.exitCode), 200);
})().catch(e => { console.error(e); process.exit(2); });
