// Tournament games (1 entry per person + player username) and required buyer phone.
// Run with: npm test (or node tests/suites/tournaments.suite.js)
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
    ilike(c, v) { filters.push(r => String(r[c] || '').toLowerCase() === String(v).toLowerCase()); return api; },
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
      if (db.__noNewCols && payload.some(p => 'buyer_phone' in p || 'entry_details' in p)) {
        const col = payload.some(p => 'buyer_phone' in p) ? 'buyer_phone' : 'entry_details';
        return { data: null, error: { code: 'PGRST204', message: `Could not find the '${col}' column of '${table}' in the schema cache` } };
      }
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
let gateway = {}; let gwSeq = 0;
const nativeFetch = global.fetch;
global.fetch = async (url, opts) => {
  if (opts.method === 'POST') { gateway.lastCreate = JSON.parse(opts.body); const id = 'chk_' + (++gwSeq); return { ok: true, status: 200, json: async () => ({ id, checkout_url: 'https://pay/' + id }) }; }
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



// ---- Tournament games (1 entry per person + player username) and buyer phone ----
const EFB = 'bbbbbbbb-0000-4000-8000-000000000001', FIFA = 'bbbbbbbb-0000-4000-8000-000000000002';
function seed() {
  reset();
  db.events.push({ id: 'evt-gn', title: 'Game Night', payment_amount: 500, requires_payment: true, max_attendees: 0, service_fee_override: 0, open_to_public: true, public_price: 700 });
  db.event_items = [
    { id: EFB, event_id: 'evt-gn', name: 'eFootball Mobile', price: 1000, public_price: 1500, max_plays: 3, tournament: true, is_active: true, sort_order: 0 },
    { id: FIFA, event_id: 'evt-gn', name: 'FIFA', price: 500, public_price: 700, max_plays: null, tournament: false, is_active: true, sort_order: 1 }
  ];
  db.students.forEach(s => { s.phone = null; });
}
const efb = (extra = {}) => ({ event_id: 'evt-gn', items: [{ item_id: EFB, plays: 1 }], usernames: { [EFB]: 'KingKolo_10' }, phone: '08031234567', ...extra });

(async () => {
  process.env.BACHS_SECRET_KEY = 'sk_live_x'; process.env.NODE_ENV = 'production'; delete process.env.ALLOW_PAYMENT_SIMULATION;
  seed();

  // Phone number
  let r = await call('/bachs-session', 'u1', { event_id: 'evt-gn', items: [{ item_id: FIFA, plays: 1 }], phone: '' });
  check('student checkout without a phone number is refused', r.status === 400 && /phone/i.test(r.body.error), r.body);
  r = await call('/bachs-session', 'u1', { event_id: 'evt-gn', items: [{ item_id: FIFA, plays: 1 }], phone: 'call me' });
  check('a made-up phone number is refused', r.status === 400 && /valid phone/i.test(r.body.error), r.body);
  r = await call('/bachs-session', 'u1', { event_id: 'evt-gn', items: [{ item_id: FIFA, plays: 2 }], phone: '+234 803 123 4567' });
  let pay = db.payments[db.payments.length - 1];
  check('normal game order with a phone goes through and saves buyer_phone', r.status === 200 && pay.buyer_phone === '+234 803 123 4567' && !pay.entry_details, pay);
  await new Promise(res => setTimeout(res, 50));
  check('phone is saved to the student profile when it was empty', db.students.find(s => s.user_id === 'u1').phone === '+234 803 123 4567', db.students.find(s => s.user_id === 'u1'));

  // Tournament: username
  r = await call('/bachs-session', 'u2', efb({ usernames: {} }));
  check('tournament entry without a player username is refused', r.status === 400 && /eFootball Mobile player username/.test(r.body.error), r.body);
  r = await call('/bachs-session', 'u2', efb({ usernames: { [EFB]: 'x' } }));
  check('a 1-character username is refused', r.status === 400, r.body);
  r = await call('/bachs-session', 'u2', efb({ usernames: { [EFB]: 'a'.repeat(41) } }));
  check('a 41-character username is refused', r.status === 400 && /too long/.test(r.body.error), r.body);

  // Tournament: 1 entry per person
  r = await call('/bachs-session', 'u2', efb({ items: [{ item_id: EFB, plays: 2 }] }));
  check('2 entries of a tournament in one order are refused', r.status === 409 && /1 entry per person/.test(r.body.error), r.body);
  r = await call('/bachs-session', 'u2', efb({ usernames: { [EFB]: '  <b>Kolo</b>  King ' } }));
  pay = db.payments[db.payments.length - 1];
  check('1 entry with a username goes through; username stored cleaned', r.status === 200 && Array.isArray(pay.entry_details) && pay.entry_details[0].username === 'bKolo/b King' && pay.entry_details[0].item_id === EFB && pay.entry_details[0].name === 'eFootball Mobile', pay.entry_details);
  r = await call('/bachs-session', 'u2', efb());
  check('retrying an unpaid tournament checkout retires the stale pending row and opens a fresh checkout', r.status === 200 && pay.status === 'abandoned', { status: r.status, oldStatus: pay.status, body: r.body });
  pay = db.payments[db.payments.length - 1];
  gateway[pay.transaction_id] = { status: 'completed', pricing: { amount: pay.amount.toFixed(2), currency: 'NGN' }, customer: { email: 'u2@st.tau.edu.ng' } };
  r = await call('/bachs-session', 'u2', efb());
  check('retrying when the earlier checkout was actually paid settles it and blocks duplicate payment', r.status === 409 && /already paid/.test(r.body.error) && pay.status === 'verified', { status: r.status, body: r.body, pay });
  delete gateway[pay.transaction_id];

  // Pay the entry, then try again
  pay.status = 'verified';
  db.event_registrations.push({ id: 'reg-u2', event_id: 'evt-gn', user_id: 'u2', status: 'registered', ticket_quantity: 1, event_item_id: EFB, linked_payment_id: pay.id, entry_details: pay.entry_details });
  r = await call('/bachs-session', 'u2', efb());
  check('someone who already has an entry cannot buy another', r.status === 409 && /already have an entry/.test(r.body.error), r.body);
  r = await call('/bachs-session', 'u2', { event_id: 'evt-gn', items: [{ item_id: FIFA, plays: 3 }], phone: '08031234567' });
  check('…but can still buy normal games', r.status === 200, r.body);

  // Capacity: 3 slots
  db.event_registrations.push({ id: 'reg-u3', event_id: 'evt-gn', user_id: 'u3', status: 'registered', ticket_quantity: 1, event_item_id: EFB });
  db.event_registrations.push({ id: 'reg-u4', event_id: 'evt-gn', user_id: 'u4', status: 'registered', ticket_quantity: 1, event_item_id: EFB });
  r = await call('/bachs-session', 'u5', efb());
  check('when all 3 slots are taken the tournament is fully booked', r.status === 409 && /fully booked/.test(r.body.error), r.body);
  r = await call('/games-availability/bbbbbbbb-0000-4000-8000-0000000000ee', '', null, 'GET');
  check('availability rejects nothing weird (unknown event -> empty list)', r.status === 200 && Array.isArray(r.body.data) && r.body.data.length === 0, r.body);
  db.events.find(e => e.id === 'evt-gn').id = 'cccccccc-0000-4000-8000-000000000001';
  db.event_items.forEach(i => { i.event_id = 'cccccccc-0000-4000-8000-000000000001'; });
  db.event_registrations.forEach(x => { x.event_id = 'cccccccc-0000-4000-8000-000000000001'; });
  r = await call('/games-availability/cccccccc-0000-4000-8000-000000000001', '', null, 'GET');
  const av = r.body.data || [];
  check('public availability says eFootball is full and FIFA is not, with no counts', r.status === 200 && av.find(a => a.item_id === EFB).full === true && av.find(a => a.item_id === FIFA).full === false && !JSON.stringify(av).match(/left|used|count/), av);
  r = await call('/games-availability/not-a-uuid', '', null, 'GET');
  check('availability with a bad id is refused', r.status === 400, r.body);

  // Guests
  seed();
  r = await call('/guest-session', '', { event_id: 'evt-gn', name: 'Gus Guest', email: 'gus@gmail.com', phone: '08099998888', items: [{ item_id: EFB, plays: 1 }] });
  check('guest tournament entry without a username is refused', r.status === 400 && /username/.test(r.body.error), r.body);
  r = await call('/guest-session', '', { event_id: 'evt-gn', name: 'Gus Guest', email: 'gus@gmail.com', phone: '08099998888', items: [{ item_id: EFB, plays: 1 }], usernames: { [EFB]: 'GusPlays' } });
  pay = db.payments[db.payments.length - 1];
  check('guest entry saves username and phone', r.status === 200 && pay.entry_details[0].username === 'GusPlays' && pay.buyer_phone === '08099998888', pay);
  r = await call('/guest-session', '', { event_id: 'evt-gn', name: 'Gus Guest', email: 'GUS@gmail.com', phone: '08099998888', items: [{ item_id: EFB, plays: 1 }], usernames: { [EFB]: 'GusPlays' } });
  check('guest retrying an unpaid tournament checkout retires the old pending row and starts fresh', r.status === 200 && pay.status === 'abandoned', { status: r.status, oldStatus: pay.status, body: r.body });
  pay = db.payments[db.payments.length - 1];

  // Ticket keeps the username
  gateway[pay.transaction_id] = { status: 'completed', pricing: { amount: pay.amount.toFixed(2), currency: 'NGN' }, customer: { email: 'gus@gmail.com' } };
  r = await call('/guest-verify', '', { reference: pay.transaction_id, email: 'gus@gmail.com' });
  const reg = db.event_registrations.find(x => x.linked_payment_id === pay.id);
  check('the ticket (registration) carries the player username', reg && Array.isArray(reg.entry_details) && reg.entry_details[0].username === 'GusPlays', { r: r.body, reg });

  // Before migration 032 is run: checkout still works, just without the new fields
  seed(); db.__noNewCols = true;
  r = await call('/bachs-session', 'u6', { event_id: 'evt-gn', items: [{ item_id: FIFA, plays: 1 }], phone: '08031234567' });
  pay = db.payments[db.payments.length - 1];
  check('without migration 032, student checkout still works (no phone column saved)', r.status === 200 && pay && pay.user_id === 'u6' && !('buyer_phone' in pay), { r: r.body, pay });
  r = await call('/guest-session', '', { event_id: 'evt-gn', name: 'Ann Guest', email: 'ann@gmail.com', phone: '08099998888', items: [{ item_id: FIFA, plays: 1 }] });
  check('without migration 032, guest checkout still works', r.status === 200, r.body);
  db.__noNewCols = false;

  console.log(fails ? `\n${fails} check(s) failed` : '\nAll tournament checks passed');
  server.close();
  process.exitCode = fails ? 1 : 0;
  setTimeout(() => process.exit(process.exitCode), 200);
})().catch(e => { console.error(e); process.exitCode = 1; setTimeout(() => process.exit(1), 200); });
