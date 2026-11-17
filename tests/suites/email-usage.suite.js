// Gmail daily-limit meter: every email is counted; usage over the rolling
// last 24 hours is compared with Google's limits. No addresses are stored.
// Run with: npm test (or node tests/suites/email-usage.suite.js)
const path = require('path');
const Module = require('module');
const backend = path.resolve(process.argv[2] || path.join(__dirname, '..', '..'));

let table = [];
let missingTable = false;
function qb() {
  const f = []; let op = 'select'; let payload = null; let range = null;
  const api = {
    select() { return api; },
    gte(c, v) { f.push(r => r[c] >= v); return api; },
    lt(c, v) { f.push(r => r[c] < v); return api; },
    not(c, o, v) { f.push(r => r[c] != null); return api; },
    order() { return api; },
    range(a, b) { range = [a, b]; return api; },
    insert(rows) { op = 'insert'; payload = rows; return api; },
    update(u) { op = 'update'; payload = u; return api; },
    then(res, rej) {
      if (missingTable) return Promise.resolve({ data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.email_send_log'" } }).then(res, rej);
      if (op === 'insert') { payload.forEach(r => table.push({ sent_at: new Date().toISOString(), ...r })); return Promise.resolve({ data: null, error: null }).then(res, rej); }
      let m = table.filter(r => f.every(fn => fn(r)));
      if (op === 'update') { m.forEach(r => Object.assign(r, payload)); return Promise.resolve({ data: m, error: null }).then(res, rej); }
      if (range) m = m.slice(range[0], range[1] + 1);
      return Promise.resolve({ data: m, error: null }).then(res, rej);
    }
  };
  return api;
}
const sent = [];
const stubs = { [path.join(backend, 'config/supabase.js')]: { supabase: { from: qb } } };
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'nodemailer') return { createTransport: () => ({ sendMail: async (o) => { sent.push(o); if (global.failNext) { global.failNext = false; throw new Error('Daily user sending limit exceeded'); } return { messageId: 'm' }; } }) };
  const resolved = Module._resolveFilename(request, parent, isMain);
  return stubs[resolved] || origLoad.apply(this, arguments);
};
Object.assign(process.env, { SMTP_HOST: 'smtp.test', SMTP_USER: 'nacos@st.tau.edu.ng', SMTP_PASS: 'x', EMAIL_FROM: 'nacos@st.tau.edu.ng' });
delete process.env.EMAIL_INTERNAL_DOMAINS;

const email = require(path.join(backend, 'services/email.js'));
const { getEmailUsage, kindOf } = require(path.join(backend, 'utils/emailUsage.js'));

let fails = 0;
const check = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' ' + JSON.stringify(x))); if (!c) fails++; };

(async () => {
  // A ticket to one student, a broadcast BCC to 3 students + 1 guest, and an alert
  await email.sendEmail({ to: 'ada@st.tau.edu.ng', subject: '🎟️ Ticket Confirmed: Movie Night', html: '<p>x</p>' });
  await email.sendEmail({ bcc: ['b1@st.tau.edu.ng', 'b2@st.tau.edu.ng', 'ADA@st.tau.edu.ng', 'guest@gmail.com'], subject: 'New event!', html: '<p>x</p>' });
  await email.sendEmail({ to: ['nacos@tau.edu.ng'], subject: '💰 Payment Received: ₦1,050 from Ada (Movie Night)', html: '<p>x</p>' });
  check('every email sent is recorded once', table.length === 3, table.length);
  check('a BCC broadcast counts every recipient, including the sender copy Gmail counts', table[1].recipients === 5, table[1]);
  check('outside addresses are counted (guest Gmail, and a different domain)', table[1].external_recipients === 1 && table[2].external_recipients === 1, table.map(r => r.external_recipients));
  check('no email addresses are stored, only fingerprints', !JSON.stringify(table).includes('@'), table);
  check('the kind is recorded from fixed patterns (no names stored)', table[0].kind === 'ticket' && table[2].kind === 'payment_alert' && !JSON.stringify(table).includes('Ada'), table.map(r => r.kind));

  global.failNext = true;
  try { await email.sendEmail({ to: 'x@st.tau.edu.ng', subject: 'Hello', html: '<p>x</p>' }); } catch (_) {}
  check('failed sends are recorded as failed', table.length === 4 && table[3].ok === false && /limit/.test(table[3].error), table[3]);

  let u = await getEmailUsage();
  check('usage counts the last 24 hours: 3 sent (failed one not counted)', u.available && u.used.messages === 3 && u.failed_last_24h === 1, u);
  check('total recipients 1 + 5 + 1 = 7', u.used.recipients === 7, u.used);
  check('different people: Ada counted once across emails (ada, b1, b2, guest, sender, nacos@tau = 6)', u.used.unique_recipients === 6, u.used);
  check('different outside people: 2 (guest, nacos@tau.edu.ng)', u.used.unique_external_recipients === 2, u.used);
  check("Google's limits are the defaults (2,000 messages, 10,000 recipients…)", u.limits.messages === 2000 && u.limits.recipients === 10000 && u.limits.external_recipients === 3000, u.limits);
  check('status is ok well under the limit', u.status === 'ok', u.status);

  // Older than 24 hours: in the daily history, not in the rolling window
  table.push({ sent_at: new Date(Date.now() - 30 * 3600000).toISOString(), recipients: 50, external_recipients: 0, recipient_hashes: null, ok: true, kind: 'broadcast_or_other' });
  u = await getEmailUsage();
  check('emails older than 24 hours leave the rolling window', u.used.messages === 3 && u.used.recipients === 7, u.used);
  check('…but stay in the per-day history', u.daily.reduce((s, d) => s + d.messages, 0) === 4, u.daily);

  // Near the limit
  const now = new Date().toISOString();
  for (let i = 0; i < 1650; i++) table.push({ sent_at: now, recipients: 1, external_recipients: 0, recipient_hashes: [], ok: true });
  u = await getEmailUsage();
  check('over 80% of 2,000 messages shows a warning', u.status === 'warning' && u.used.messages === 1653, { s: u.status, m: u.used.messages });
  for (let i = 0; i < 400; i++) table.push({ sent_at: now, recipients: 1, external_recipients: 0, recipient_hashes: [], ok: true });
  u = await getEmailUsage();
  check('at 2,000+ messages it says the limit is reached', u.status === 'over', u.status);

  missingTable = true;
  u = await getEmailUsage();
  check('before migration 030 it says counting has not started (no crash)', u.available === false, u);
  let threw = false;
  try { await email.sendEmail({ to: 'y@st.tau.edu.ng', subject: 'Hi', html: '<p>x</p>' }); } catch (_) { threw = true; }
  check('…and sending email still works without the table', !threw);
  check('kind patterns', kindOf('🎮 Game Marshal for Game Night') === 'marshal_invite' && kindOf('Complete Your NACOS TAU Student Profile') === 'profile_reminder');

  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  process.exitCode = fails ? 1 : 0; setTimeout(() => process.exit(process.exitCode), 200);
})().catch(e => { console.error(e); process.exit(2); });
