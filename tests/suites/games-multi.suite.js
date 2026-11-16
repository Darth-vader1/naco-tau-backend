// Stubbed test of payment.js security checks. Usage: node paytest.js <backendDir>
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
  [path.join(backend, 'services/email.js')]: { sendEventTicketEmail: async (a) => { global.ticketEmails = (global.ticketEmails||0)+1; global.lastTicketPayment = a.payment; global.lastTicketTo = a.student && a.student.email; global.lastTicketGames = a.games; global.lastTicketTitle = a.event && a.event.title; }, sendPaymentAdminNotificationEmail: async (a) => { global.adminGames = a.games; } }
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


const FIFA='aaaaaaaa-0000-4000-8000-000000000001', LUDO='aaaaaaaa-0000-4000-8000-000000000002', MK='aaaaaaaa-0000-4000-8000-000000000003', HIDDEN='aaaaaaaa-0000-4000-8000-000000000004';
function seedGames() {
  reset();
  db.events.push({ id: 'evt-game', title: 'Game Night', payment_amount: 300, requires_payment: true, max_attendees: 0, service_fee_override: 50, open_to_public: true, public_price: 400 });
  db.event_items = [
    { id: FIFA, event_id: 'evt-game', name: 'FIFA', price: 500, public_price: 700, max_plays: null, is_active: true, sort_order: 0 },
    { id: LUDO, event_id: 'evt-game', name: 'Ludo', price: 300, public_price: null, max_plays: null, is_active: true, sort_order: 1 },
    { id: MK, event_id: 'evt-game', name: 'Mortal Kombat', price: 500, public_price: 600, max_plays: 3, is_active: true, sort_order: 2 },
    { id: HIDDEN, event_id: 'evt-game', name: 'Old game', price: 100, is_active: false, sort_order: 3 }
  ];
}
(async () => {
  process.env.BACHS_SECRET_KEY = 'sk_live_x'; process.env.NODE_ENV = 'production'; delete process.env.ALLOW_PAYMENT_SIMULATION;
  seedGames(); global.ticketEmails = 0;

  // 1. Member: FIFA x2 + Ludo x1 in one checkout
  let r = await call('/bachs-session', 'u1', { event_id: 'evt-game', quantity: 99, amount: 1, items: [{ item_id: FIFA, plays: 2 }, { item_id: LUDO, plays: 1 }] });
  let intent = db.payments.find(p => p.transaction_id === 'chk_1');
  check('two games in one checkout: 2x500 + 1x300 = 1300, + 3 x 50 fee = 1450', r.status === 200 && r.body.data.total_amount === 1450 && r.body.data.subtotal_amount === 1300 && r.body.data.service_fee === 150 && r.body.data.quantity === 3, r.body);
  check('Bachs is charged the server total, not the client amount', gateway.lastCreate && JSON.stringify(gateway.lastCreate).includes('1450.00'), gateway.lastCreate);
  check('order records both games (order_items) and 3 plays', intent && intent.ticket_quantity === 3 && Array.isArray(intent.order_items) && intent.order_items.length === 2 && intent.event_item_id === null && intent.order_items.find(l => l.item_id === FIFA).plays === 2, intent);
  check('checkout response lists the games', Array.isArray(r.body.data.games) && r.body.data.games.length === 2, r.body.data);

  // pay it and verify: the browser lying about games/quantity is ignored
  gateway['chk_1'] = { status: 'completed', pricing: { amount: '1450.00', currency: 'NGN' }, customer: { email: 'u1@st.tau.edu.ng' } };
  r = await call('/verify-paystack', 'u1', { reference: 'chk_1', event_id: 'evt-game', quantity: 1, items: [{ item_id: LUDO, plays: 1 }] });
  const reg = db.event_registrations.find(x => x.linked_payment_id === intent.id);
  check('verify uses the recorded games, issues one ticket for 3 plays', r.status === 200 && reg && reg.ticket_quantity === 3 && Array.isArray(reg.order_items) && reg.order_items.length === 2, { r: r.body, reg });
  check('ticket title names both games', r.body.data && /Game Night: FIFA × 2, Ludo × 1/.test(r.body.data.event.title) && global.lastTicketTitle === r.body.data.event.title, { t: r.body.data && r.body.data.event && r.body.data.event.title, e: global.lastTicketTitle });
  check('ticket + admin emails get the game lines with prices', global.ticketEmails === 1 && Array.isArray(global.lastTicketGames) && global.lastTicketGames.length === 2 && global.lastTicketGames[0].unit_price === 500 && Array.isArray(global.adminGames), global.lastTicketGames);

  // underpaying a multi-game order is refused
  seedGames(); gateway = {};
  r = await call('/bachs-session', 'u2', { event_id: 'evt-game', items: [{ item_id: FIFA, plays: 2 }, { item_id: LUDO, plays: 1 }] });
  gateway['chk_1'] = { status: 'completed', pricing: { amount: '500.00', currency: 'NGN' }, customer: { email: 'u2@st.tau.edu.ng' } };
  r = await call('/verify-paystack', 'u2', { reference: 'chk_1', event_id: 'evt-game' });
  check('paying less than the multi-game total is refused', r.status === 400 && db.event_registrations.length === 0, r.body);

  // single game still uses the old column (works before migration 025)
  seedGames(); gateway = {};
  r = await call('/bachs-session', 'u3', { event_id: 'evt-game', quantity: 2, item_id: FIFA });
  intent = db.payments.find(p => p.transaction_id === 'chk_1');
  check('old single-game request still works (2 x 500 + fee = 1100)', r.status === 200 && r.body.data.total_amount === 1100 && intent.event_item_id === FIFA && !('order_items' in intent), { b: r.body, intent });
  r = await call('/bachs-session', 'u3', { event_id: 'evt-game', items: [{ item_id: FIFA, plays: 2 }] });
  intent = db.payments.filter(p => p.transaction_id === 'chk_1').pop();
  check('one game via items[] stored as single-game order', r.status === 200 && intent.event_item_id === FIFA && !('order_items' in intent), intent);

  // validation
  seedGames(); gateway = {};
  r = await call('/bachs-session', 'u1', { event_id: 'evt-game' });
  check('game event with no game picked is refused', r.status === 400 && /choose at least one game/i.test(r.body.error || r.body.message), r.body);
  r = await call('/bachs-session', 'u1', { event_id: 'evt-game', items: [{ item_id: HIDDEN, plays: 1 }] });
  check('hidden game cannot be bought', r.status === 400, r.body);
  r = await call('/bachs-session', 'u1', { event_id: 'evt-game', items: [{ item_id: FIFA, plays: 0 }] });
  check('zero plays refused', r.status === 400, r.body);
  r = await call('/bachs-session', 'u1', { event_id: 'evt-game', items: [{ item_id: FIFA, plays: 11 }] });
  check('more than 10 plays of one game refused', r.status === 400, r.body);
  r = await call('/bachs-session', 'u1', { event_id: 'evt-game', items: [{ item_id: 'aaaaaaaa-0000-4000-8000-00000000dead', plays: 1 }] });
  check('game from nowhere refused', r.status === 400, r.body);
  r = await call('/bachs-session', 'u1', { event_id: 'evt-game', items: [{ item_id: FIFA, plays: 1 }, { item_id: FIFA, plays: 2 }] });
  intent = db.payments.filter(p => p.transaction_id === 'chk_1').pop();
  check('same game twice is merged into one line (3 plays)', r.status === 200 && intent.event_item_id === FIFA && intent.ticket_quantity === 3, intent);

  // play limit counts plays from multi-game orders too
  seedGames(); gateway = {};
  db.event_registrations.push({ id: 'r-old', event_id: 'evt-game', user_id: 'u9', status: 'registered', ticket_quantity: 3, order_items: [{ item_id: MK, plays: 2 }, { item_id: FIFA, plays: 1 }] });
  r = await call('/bachs-session', 'u1', { event_id: 'evt-game', items: [{ item_id: MK, plays: 2 }, { item_id: FIFA, plays: 1 }] });
  check('play limit counts earlier multi-game orders (MK 3 max, 2 used)', r.status === 409 && /Only 1 play\(s\) of Mortal Kombat left/.test(r.body.error || r.body.message), r.body);

  // guest: only games with a guest price
  seedGames(); gateway = {};
  const guest = { name: 'Tola Guest', email: 'tola@gmail.com', phone: '08012345678' };
  r = await call('/guest-session', '', { event_id: 'evt-game', items: [{ item_id: FIFA, plays: 1 }, { item_id: MK, plays: 2 }], ...guest });
  intent = db.payments.find(p => p.transaction_id === 'chk_1');
  check('guest multi-game at guest prices: 700 + 2x600 = 1900 (+ fee)', r.status === 200 && r.body.data.subtotal_amount === 1900 && intent && intent.order_items.length === 2, r.body);
  gateway['chk_1'] = { status: 'completed', pricing: { amount: Number(r.body.data.total_amount).toFixed(2), currency: 'NGN' }, customer: { email: 'tola@gmail.com' } };
  let gv = await call('/guest-verify', 'anon', { reference: 'chk_1', email: 'tola@gmail.com' });
  check('guest confirmation returns the games (for the on-screen ticket)', gv.status === 200 && Array.isArray(gv.body.data.games) && gv.body.data.games.length === 2 && /FIFA × 1, Mortal Kombat × 2/.test(gv.body.data.event.title), gv.body);
  r = await call('/guest-session', '', { event_id: 'evt-game', items: [{ item_id: FIFA, plays: 1 }, { item_id: LUDO, plays: 1 }], ...guest });
  check('guest cannot add a members-only game', r.status === 403 && /Ludo is for NACOS members only/.test(r.body.error || r.body.message), r.body);

  // webhook settles a recorded multi-game order
  seedGames(); gateway = {}; global.ticketEmails = 0;
  r = await call('/bachs-session', 'u4', { event_id: 'evt-game', items: [{ item_id: FIFA, plays: 1 }, { item_id: LUDO, plays: 2 }] });
  const crypto = require('crypto');
  const whBody = { type: 'checkout.completed', data: { id: 'chk_1', status: 'completed', pricing: { amount: Number(r.body.data.total_amount).toFixed(2), currency: 'NGN' }, customer: { email: 'u4@st.tau.edu.ng' } } };
  const sig = crypto.createHmac('sha256', 'sk_live_x').update(JSON.stringify(whBody)).digest('hex');
  r = await call('/webhook', 'x', whBody, 'POST', { 'x-bachs-signature': sig });
  const wreg = db.event_registrations.find(x => x.user_id === 'u4');
  check('webhook settles multi-game order with both games on the ticket', r.status === 200 && wreg && wreg.ticket_quantity === 3 && Array.isArray(wreg.order_items) && wreg.order_items.length === 2 && global.ticketEmails === 1, { r: r.body, wreg });

  // receipt lists games
  r = await call('/receipt/chk_1', 'x', null, 'GET');
  check('receipt shows both games', r.status === 200 && JSON.stringify(r.body).includes('Ludo') && JSON.stringify(r.body).includes('FIFA'), r.body);
  check('receipt: nothing used yet', r.body.data.games.every(g => g.used === 0 && g.left === g.plays), r.body.data.games);
  db.game_plays = [{ registration_id: wreg.id, item_id: LUDO, plays: 1, created_at: '2026-11-24T18:42:00.000Z' }];
  r = await call('/receipt/chk_1', 'x', null, 'GET');
  const ludo = r.body.data.games.find(g => g.name === 'Ludo'), fifa = r.body.data.games.find(g => g.name === 'FIFA');
  check('receipt shows plays used, left and when', ludo.used === 1 && ludo.left === 1 && ludo.used_at.length === 1 && fifa.used === 0 && fifa.left === 1, r.body.data.games);

  // late payments on checkouts already marked "abandoned" still settle
  seedGames(); gateway = {}; global.ticketEmails = 0;
  r = await call('/bachs-session', 'u6', { event_id: 'evt-game', items: [{ item_id: FIFA, plays: 2 }] });
  intent = db.payments.find(p => p.transaction_id === 'chk_1');
  intent.status = 'abandoned';
  const lateBody = { type: 'checkout.completed', data: { id: 'chk_1', status: 'completed', pricing: { amount: Number(r.body.data.total_amount).toFixed(2), currency: 'NGN' }, customer: { email: 'u6@st.tau.edu.ng' } } };
  const lateSig = crypto.createHmac('sha256', 'sk_live_x').update(JSON.stringify(lateBody)).digest('hex');
  r = await call('/webhook', 'x', lateBody, 'POST', { 'x-bachs-signature': lateSig });
  check('late webhook on an abandoned checkout still settles and issues the ticket', r.status === 200 && intent.status === 'verified' && db.event_registrations.some(x => x.user_id === 'u6') && global.ticketEmails === 1, { r: r.body, status: intent.status });

  seedGames(); gateway = {};
  r = await call('/bachs-session', 'u7', { event_id: 'evt-game', items: [{ item_id: LUDO, plays: 1 }] });
  intent = db.payments.find(p => p.transaction_id === 'chk_1');
  intent.status = 'abandoned';
  gateway['chk_1'] = { status: 'completed', pricing: { amount: Number(r.body.data.total_amount).toFixed(2), currency: 'NGN' }, customer: { email: 'u7@st.tau.edu.ng' } };
  r = await call('/verify-paystack', 'u7', { reference: 'chk_1', event_id: 'evt-game' });
  check('student returning late to an abandoned checkout still gets the ticket at the quoted price', r.status === 200 && intent.status === 'verified' && db.event_registrations.some(x => x.user_id === 'u7'), r.body);

  // normal ticketed events unchanged
  seedGames(); gateway = {};
  r = await call('/bachs-session', 'u5', { event_id: 'evt-bbbb-2', quantity: 2 });
  check('normal event: 2 x 5000 unchanged', r.status === 200 && r.body.data.subtotal_amount === 10000 && !r.body.data.games, r.body);

  server.close();
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  process.exitCode = fails ? 1 : 0; setTimeout(() => process.exit(process.exitCode), 200);
})();
