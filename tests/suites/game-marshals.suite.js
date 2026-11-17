// Stubbed tests for routes/gameMarshals.js. Run with: npm test (or node tests/suites/game-marshals.test.js)
const path = require('path');
const Module = require('module');
const crypto = require('crypto');
const backend = path.resolve(process.argv[2] || path.join(__dirname, '..', '..'));
const express = require(path.join(backend, 'node_modules', 'express'));

const EV = 'e1e1e1e1-0000-4000-8000-000000000001';
const EV2 = 'f2f2f2f2-0000-4000-8000-000000000002';
const FIFA = 'aaaaaaaa-0000-4000-8000-000000000001', LUDO = 'aaaaaaaa-0000-4000-8000-000000000002';
const PAY1 = 'abc123de-0000-4000-8000-000000000001', PAY2 = 'def456aa-0000-4000-8000-000000000002';
const MOVIE = 'a0a0a0a0-0000-4000-8000-000000000003', FREEEV = 'b0b0b0b0-0000-4000-8000-000000000004';
const PAY3 = 'c0ffee12-0000-4000-8000-000000000003', PAY4 = 'beef3412-0000-4000-8000-000000000004';
const hour = 3600000;
let db, invites, rpcCalls;
function reset() {
  invites = []; rpcCalls = 0;
  db = {
    events: [{ id: EV, title: 'Game Night', date: '2026-11-24', location: 'Hall' }, { id: EV2, title: 'Other Night' },
      { id: MOVIE, title: 'Movie Night', requires_payment: true, payment_amount: 1000 }, { id: FREEEV, title: 'Free Talk', requires_payment: false }],
    event_items: [
      { id: FIFA, event_id: EV, name: 'FIFA', price: 500, is_active: true, sort_order: 0 },
      { id: LUDO, event_id: EV, name: 'Ludo', price: 300, is_active: true, sort_order: 1 }
    ],
    students: [
      { user_id: 'marsh', name: 'Mara Shal', email: 'Mara.Shal@st.tau.edu.ng', status: 'active' },
      { user_id: 'buyer', name: 'Bayo Buyer', email: 'bayo@st.tau.edu.ng', status: 'active', matric_no: '23/1' },
      { user_id: 'banned', name: 'Ban Ned', email: 'ban@st.tau.edu.ng', status: 'banned' },
      { user_id: 'other', name: 'Odd One', email: 'odd@st.tau.edu.ng', status: 'active' }
    ],
    event_checkins: [],
    event_registrations: [
      { id: 'reg-m6', event_id: MOVIE, user_id: 'buyer', linked_payment_id: PAY3, status: 'registered', ticket_quantity: 6 },
      { id: 'reg-m1', event_id: MOVIE, guest_name: 'Gus Guest', guest_email: 'gus@gmail.com', linked_payment_id: PAY4, status: 'registered', ticket_quantity: 1 },
      { id: 'reg-1', event_id: EV, user_id: 'buyer', linked_payment_id: PAY1, status: 'registered', ticket_quantity: 3, order_items: [{ item_id: FIFA, name: 'FIFA', plays: 2, unit_price: 500 }, { item_id: LUDO, name: 'Ludo', plays: 1, unit_price: 300 }] },
      { id: 'reg-2', event_id: EV, guest_name: 'Gina Guest', guest_email: 'g@gmail.com', linked_payment_id: PAY2, status: 'registered', ticket_quantity: 1, event_item_id: FIFA }
    ],
    game_marshals: [],
    game_plays: []
  };
}
function qb(table) {
  const f = []; let op = 'select'; let payload = null; let lim = null;
  const api = {
    select() { return api; },
    eq(c, v) { f.push(r => r[c] === v); return api; },
    neq(c, v) { f.push(r => r[c] !== v); return api; },
    is(c, v) { f.push(r => (r[c] ?? null) === v); return api; },
    not(c, o, v) { f.push(r => (r[c] ?? null) !== v); return api; },
    in(c, vals) { f.push(r => vals.includes(r[c])); return api; },
    lte(c, v) { f.push(r => r[c] <= v); return api; },
    gt(c, v) { f.push(r => r[c] > v); return api; },
    ilike(c, v) { const re = new RegExp('^' + v.replace(/\\([\\%_])/g, '$1').replace(/[.*+?^${}()|[\]]/g, '\\$&') + '$', 'i'); f.push(r => re.test(r[c] || '')); return api; },
    order() { return api; }, limit(n) { lim = n; return api; },
    insert(rows) { op = 'insert'; payload = rows; return api; },
    update(u) { op = 'update'; payload = u; return api; },
    single() { return run(true); }, maybeSingle() { return run(true); },
    then(a, b) { return run(false).then(a, b); }
  };
  async function run(single) {
    const rows = db[table] || (db[table] = []);
    if (op === 'insert') { const out = payload.map(p => { const r = { id: crypto.randomUUID(), created_at: new Date().toISOString(), revoked_at: null, ...p }; rows.push(r); return r; }); return { data: single ? out[0] : out, error: null }; }
    let m = rows.filter(r => f.every(fn => fn(r)));
    if (op === 'update') { m.forEach(r => Object.assign(r, payload)); return { data: single ? m[0] || null : m, error: null }; }
    if (lim) m = m.slice(0, lim);
    return { data: single ? m[0] || null : m, error: null };
  }
  return api;
}
const rpc = async (name, a) => {
  if (name === 'admit_tickets') {
    const reg = db.event_registrations.find(r => r.id === a.p_registration_id);
    if (!reg) return { data: null, error: { message: 'TICKET_NOT_FOUND' } };
    const used = db.event_checkins.filter(c => c.registration_id === reg.id).reduce((s, c) => s + c.admitted, 0);
    if (used + a.p_count > a.p_bought) return { data: null, error: { message: 'ALREADY_ADMITTED' } };
    db.event_checkins.push({ id: crypto.randomUUID(), registration_id: reg.id, event_id: reg.event_id, admitted: a.p_count, marshal_id: a.p_marshal_id, marshal_user_id: a.p_marshal_user_id, created_at: new Date().toISOString() });
    return { data: a.p_bought - used - a.p_count, error: null };
  }
  rpcCalls++;
  const reg = db.event_registrations.find(r => r.id === a.p_registration_id);
  if (!reg) return { data: null, error: { message: 'TICKET_NOT_FOUND' } };
  const used = db.game_plays.filter(p => p.registration_id === reg.id && p.item_id === a.p_item_id).reduce((s, p) => s + p.plays, 0);
  if (used + a.p_plays > a.p_bought) return { data: null, error: { message: 'NO_PLAYS_LEFT' } };
  db.game_plays.push({ id: crypto.randomUUID(), registration_id: reg.id, event_id: reg.event_id, item_id: a.p_item_id, plays: a.p_plays, marshal_id: a.p_marshal_id, marshal_user_id: a.p_marshal_user_id, created_at: new Date().toISOString() });
  return { data: a.p_bought - used - a.p_plays, error: null };
};
const stubs = {
  [path.join(backend, 'config/supabase.js')]: { supabase: { from: qb, rpc } },
  [path.join(backend, 'middleware/auth.js')]: {
    authenticate: (req, res, next) => { req.userId = req.headers['x-user']; if (!req.userId) return res.status(401).json({ success: false }); req.user = { id: req.userId }; next(); },
    requireAdmin: (req, res, next) => req.headers['x-admin'] === '1' ? next() : res.status(403).json({ success: false, error: 'admin only' }),
    optionalAuth: (q, s, n) => n(), requireSuperAdmin: (q, s, n) => n()
  },
  [path.join(backend, 'middleware/audit.js')]: { auditLog: async (e) => { (global.audits = global.audits || []).push(e.action); } },
  [path.join(backend, 'services/email.js')]: { sendGameMarshalInviteEmail: async (a) => { invites.push(a); return { success: true }; } }
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const resolved = Module._resolveFilename(request, parent, isMain);
  return stubs[resolved] || origLoad.apply(this, arguments);
};

const router = require(path.join(backend, 'routes/gameMarshals.js'));
const app = express(); app.use(express.json()); app.use('/m', router);
const server = app.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}/m`;
  const call = async (method, p, user, body, admin) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(user ? { 'x-user': user } : {}), ...(admin ? { 'x-admin': '1' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  let fails = 0;
  const check = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' ' + JSON.stringify(x).slice(0, 500))); if (!c) fails++; };
  const T1 = 'NACOS-E1E1-ABC123', T2 = 'nacos-e1e1-def456';
  const iso = (ms) => new Date(Date.now() + ms).toISOString();
  reset();

  // ---- appoint ----
  let r = await call('POST', `/admin/event/${EV}`, 'admin1', { email: 'mara.shal@st.tau.edu.ng', starts_at: iso(-hour), ends_at: iso(3 * hour) });
  check('non-admin cannot appoint', r.status === 403, r);
  r = await call('POST', `/admin/event/${EV}`, 'admin1', { email: 'MARA.SHAL@st.tau.edu.ng', starts_at: iso(-hour), ends_at: iso(3 * hour) }, true);
  check('admin appoints by email (case-insensitive) and invite email is sent', r.status === 200 && r.body.data.emailed && invites.length === 1 && invites[0].student.user_id === 'marsh' && db.game_marshals.length === 1, r);
  r = await call('POST', `/admin/event/${EV}`, 'admin1', { email: 'nobody@st.tau.edu.ng', starts_at: iso(0), ends_at: iso(hour) }, true);
  check('unknown email refused with sign-up hint', r.status === 404 && /sign up/.test(r.body.error), r);
  r = await call('POST', `/admin/event/${EV}`, 'admin1', { email: 'ban@st.tau.edu.ng', starts_at: iso(0), ends_at: iso(hour) }, true);
  check('inactive account refused', r.status === 400, r);
  r = await call('POST', `/admin/event/${EV}`, 'admin1', { email: '%@st.tau.edu.ng', starts_at: iso(0), ends_at: iso(hour) }, true);
  check('email wildcards cannot match other students', r.status === 404 || r.status === 400, r);
  r = await call('POST', `/admin/event/${EV}`, 'admin1', { email: 'odd@st.tau.edu.ng', starts_at: iso(2 * hour), ends_at: iso(hour) }, true);
  check('end before start refused', r.status === 400, r);
  r = await call('POST', `/admin/event/${EV}`, 'admin1', { email: 'odd@st.tau.edu.ng', starts_at: iso(-3 * hour), ends_at: iso(-hour) }, true);
  check('end time in the past refused', r.status === 400, r);
  r = await call('POST', `/admin/event/${EV2}`, 'admin1', { email: 'odd@st.tau.edu.ng', starts_at: iso(0), ends_at: iso(hour) }, true);
  check('free event without games refused (no tickets to scan)', r.status === 400 && /free/.test(r.body.error), r);
  r = await call('POST', `/admin/event/${EV}`, 'admin1', { email: 'mara.shal@st.tau.edu.ng', starts_at: iso(-hour), ends_at: iso(5 * hour) }, true);
  check('appointing the same person again updates their times (no duplicate)', r.status === 200 && r.body.data.updated && db.game_marshals.length === 1, r);
  r = await call('POST', `/admin/event/${EV}`, 'admin1', { email: 'odd@st.tau.edu.ng', starts_at: iso(2 * hour), ends_at: iso(4 * hour) }, true);
  check('future appointment saved', r.status === 200, r);

  // ---- /me ----
  r = await call('GET', '/me', 'marsh');
  check('marshal sees their active appointment', r.status === 200 && r.body.data.length === 1 && r.body.data[0].active && r.body.data[0].event.title === 'Game Night', r);
  r = await call('GET', '/me', 'other');
  check('future marshal sees it as upcoming (not active yet)', r.body.data.length === 1 && r.body.data[0].active === false, r);
  r = await call('GET', '/me', 'buyer');
  check('ordinary student sees nothing', r.body.data.length === 0, r);

  // ---- lookup ----
  r = await call('GET', `/${EV}/ticket?code=${T1}`, 'buyer');
  check('non-marshal cannot look up tickets', r.status === 403, r);
  r = await call('GET', `/${EV}/ticket?code=${T1}`, 'other');
  check('marshal before their start time cannot look up', r.status === 403, r);
  r = await call('GET', `/${EV}/ticket?code=${encodeURIComponent(' ' + T1 + ' ')}`, 'marsh');
  check('marshal looks up a ticket: buyer + games with plays left', r.status === 200 && r.body.data.buyer === 'Bayo Buyer' && r.body.data.games.length === 2 && r.body.data.games[0].left === 2 && r.body.data.plays_left === 3, r);
  check('look-up shows no email, phone or payment details', !JSON.stringify(r.body.data).includes('@') && !('amount' in r.body.data), r.body.data);
  r = await call('GET', `/${EV}/ticket?code=${T2}`, 'marsh');
  check('lower-case typed ticket works; guest ticket shows guest name', r.status === 200 && r.body.data.buyer === 'Gina Guest' && r.body.data.is_guest, r);
  r = await call('GET', `/${EV}/ticket?code=NACOS-F2F2-ABC123`, 'marsh');
  check('ticket for another event refused', r.status === 404 && /different event/.test(r.body.error), r);
  r = await call('GET', `/${EV}/ticket?code=hello`, 'marsh');
  check('nonsense code refused', r.status === 400, r);
  r = await call('GET', `/${EV2}/ticket?code=${T1}`, 'marsh');
  check('marshal for one event cannot use another event', r.status === 403, r);

  // ---- redeem ----
  r = await call('POST', `/${EV}/redeem`, 'marsh', { code: T1, item_id: FIFA });
  check('mark 1 FIFA play: 1 left', r.status === 200 && r.body.data.games.find(g => g.name === 'FIFA').left === 1 && db.game_plays.length === 1 && db.game_plays[0].marshal_user_id === 'marsh', r);
  r = await call('POST', `/${EV}/redeem`, 'marsh', { code: T1, item_id: FIFA });
  r = await call('POST', `/${EV}/redeem`, 'marsh', { code: T1, item_id: FIFA });
  check('cannot use more plays than bought', r.status === 409 && /No plays left/.test(r.body.error), r);
  r = await call('POST', `/${EV}/redeem`, 'marsh', { code: T2, item_id: LUDO });
  check('game not on the ticket refused', r.status === 400, r);
  r = await call('POST', `/${EV}/redeem`, 'buyer', { code: T1, item_id: LUDO });
  check('non-marshal cannot mark plays', r.status === 403, r);
  r = await call('POST', `/${EV}/redeem`, 'marsh', { code: T1, item_id: LUDO, plays: 0 });
  check('zero plays refused', r.status === 400, r);

  // two marks at once on the last play: only one wins (the DB function locks the ticket)
  const [a, b] = await Promise.all([call('POST', `/${EV}/redeem`, 'marsh', { code: T1, item_id: LUDO }), call('POST', `/${EV}/redeem`, 'marsh', { code: T1, item_id: LUDO })]);
  check('two marshals marking the last play at once: one succeeds, one refused', [a.status, b.status].sort().join() === '200,409' && db.game_plays.filter(p => p.item_id === LUDO).length === 1, [a, b]);

  // ---- report ----
  r = await call('GET', `/admin/event/${EV}`, 'admin1', null, true);
  const g = r.body.data && r.body.data.games;
  check('report: FIFA sold 3 (2 + guest 1), played 2; Ludo sold 1, played 1', r.status === 200 && g.find(x => x.name === 'FIFA').sold === 3 && g.find(x => x.name === 'FIFA').played === 2 && g.find(x => x.name === 'Ludo').played === 1, g);
  check('report: buyers with ticket numbers and plays left', r.body.data.buyers.length === 2 && r.body.data.buyers.find(x => x.ticket_number === 'NACOS-E1E1-ABC123').games.find(x => x.name === 'FIFA').left === 0, r.body.data.buyers);
  check('report: marshals with status', r.body.data.marshals.find(m => m.email.startsWith('Mara')).status === 'active' && r.body.data.marshals.find(m => m.email === 'odd@st.tau.edu.ng').status === 'upcoming', r.body.data.marshals);
  r = await call('GET', `/admin/event/${EV}`, 'marsh');
  check('marshal cannot see the admin report', r.status === 403, r);

  // ---- remove / expiry ----
  const mid = db.game_marshals.find(m => m.user_id === 'marsh').id;
  r = await call('DELETE', `/admin/${mid}`, 'admin1', null, true);
  check('admin removes a marshal early', r.status === 200, r);
  r = await call('GET', `/${EV}/ticket?code=${T1}`, 'marsh');
  check('removed marshal is locked out at once', r.status === 403, r);
  r = await call('GET', '/me', 'marsh');
  check('removed marshal no longer sees the section', r.body.data.length === 0, r);
  const om = db.game_marshals.find(m => m.user_id === 'other');
  om.starts_at = iso(-2 * hour); om.ends_at = iso(-1000);
  r = await call('GET', `/${EV}/ticket?code=${T1}`, 'other');
  check('marshal whose time has ended is locked out', r.status === 403, r);

  // ================= Door check-in (normal paid event) =================
  reset();
  const M6 = 'NACOS-A0A0-C0FFEE', M1 = 'nacos-a0a0-beef34';
  r = await call('POST', `/admin/event/${MOVIE}`, 'admin1', { email: 'mara.shal@st.tau.edu.ng', starts_at: iso(-hour), ends_at: iso(3 * hour) }, true);
  check('check-in staff can be appointed for a normal paid event (no games needed)', r.status === 200 && invites.length === 1 && invites[0].mode === 'checkin', { r, inv: invites[0] && invites[0].mode });
  r = await call('POST', `/admin/event/${FREEEV}`, 'admin1', { email: 'odd@st.tau.edu.ng', starts_at: iso(0), ends_at: iso(hour) }, true);
  check('…but not for a free event', r.status === 400, r);
  r = await call('GET', '/me', 'marsh');
  check('staff dashboard shows the duty as check-in', r.body.data.length === 1 && r.body.data[0].mode === 'checkin', r.body);
  r = await call('GET', `/${MOVIE}/ticket?code=${M6}`, 'marsh');
  check('scanning a 6-ticket order shows "admits 6, 0 in"', r.status === 200 && r.body.data.mode === 'checkin' && r.body.data.tickets === 6 && r.body.data.admitted === 0 && r.body.data.admit_left === 6 && r.body.data.buyer === 'Bayo Buyer', r.body);
  check('no contact or payment details on the door screen', !JSON.stringify(r.body.data).includes('@') && !('amount' in r.body.data), r.body.data);
  r = await call('POST', `/${MOVIE}/admit`, 'marsh', { code: M6, count: 2 });
  check('admit 2 now: 4 still to come', r.status === 200 && r.body.data.admitted === 2 && r.body.data.admit_left === 4 && r.body.data.admitted_at.length === 2, r.body);
  r = await call('POST', `/${MOVIE}/admit`, 'marsh', { code: M6, count: 5 });
  check('can\'t admit more people than are left on the ticket', r.status === 409 && /Only 4 more/.test(r.body.error), r.body);
  r = await call('POST', `/${MOVIE}/admit`, 'marsh', { code: M6, count: 'all' });
  check('"Admit all" lets in the remaining 4', r.status === 200 && r.body.data.admitted === 6 && r.body.data.admit_left === 0, r.body);
  r = await call('POST', `/${MOVIE}/admit`, 'marsh', { code: M6, count: 1 });
  check('a fully used ticket can\'t be used again', r.status === 409 && /already in/.test(r.body.error), r.body);
  const [x1, x2] = await Promise.all([call('POST', `/${MOVIE}/admit`, 'marsh', { code: M1, count: 1 }), call('POST', `/${MOVIE}/admit`, 'marsh', { code: M1, count: 1 })]);
  check('two staff scanning a 1-person ticket at once: only one admits', [x1.status, x2.status].sort().join() === '200,409' && db.event_checkins.filter(c => c.registration_id === 'reg-m1').length === 1, [x1.body, x2.body]);
  r = await call('POST', `/${MOVIE}/admit`, 'marsh', { code: M6, count: 0 });
  check('admitting 0 is refused', r.status === 400 || r.status === 409, r.body);
  r = await call('POST', `/${MOVIE}/admit`, 'buyer', { code: M1, count: 1 });
  check('a non-staff student can\'t admit anyone', r.status === 403, r.body);
  r = await call('POST', `/${EV}/admit`, 'marsh', { code: M6, count: 1 });
  check('staff for Movie Night can\'t check in at another event', r.status === 403, r.body);
  r = await call('GET', `/admin/event/${MOVIE}`, 'admin1', null, true);
  check('admin report: 7 of 7 checked in, per buyer', r.status === 200 && r.body.data.mode === 'checkin' && r.body.data.checkins.tickets_sold === 7 && r.body.data.checkins.checked_in === 7 && r.body.data.buyers.find(b => b.ticket_number === 'NACOS-A0A0-C0FFEE').admitted === 6, r.body.data);
  r = await call('GET', `/${EV}/ticket?code=${T1}`, 'marsh');
  check('game nights still work as game marshal mode', r.status === 403 || (r.body.data && r.body.data.mode === 'games'), r.body);

  server.close();
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  process.exitCode = fails ? 1 : 0; setTimeout(() => process.exit(process.exitCode), 200);
});
