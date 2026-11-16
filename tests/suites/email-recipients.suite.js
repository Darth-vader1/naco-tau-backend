// Who receives admin alert emails. No personal addresses are hardcoded:
// payment alerts go to PAYMENT_ALERT_EMAILS, or nacos@tau.edu.ng + ADMIN_EMAIL.
// Run with: npm test (or node tests/suites/email-recipients.suite.js)
const path = require('path');
const Module = require('module');
const backend = path.resolve(process.argv[2] || path.join(__dirname, '..', '..'));

// Fake mailer: records every message instead of sending it.
const sent = [];
const fakeNodemailer = { createTransport: () => ({ sendMail: async (opts) => { sent.push(opts); return { messageId: 'test' }; } }) };
const stubs = {
  [path.join(backend, 'config/supabase.js')]: { supabase: { from: () => ({ insert: async () => ({}) }) } }
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'nodemailer') return fakeNodemailer;
  const resolved = Module._resolveFilename(request, parent, isMain);
  return stubs[resolved] || origLoad.apply(this, arguments);
};

let fails = 0;
const check = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' ' + JSON.stringify(x))); if (!c) fails++; };
const toList = (m) => String(m && m.to || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const PERSONAL = 'olufemi-abiodun.gbolahan@st.tau.edu.ng';

function load(env) {
  for (const k of ['PAYMENT_ALERT_EMAILS', 'ADMIN_EMAIL', 'HACKATHON_ALERT_EMAILS']) delete process.env[k];
  Object.assign(process.env, { SMTP_HOST: 'smtp.test', SMTP_USER: 'bot@test', SMTP_PASS: 'x', OAUTH_CLIENT_ID: '' }, env);
  delete require.cache[require.resolve(path.join(backend, 'services/email.js'))];
  return require(path.join(backend, 'services/email.js'));
}
const payment = { amount: 1050, subtotal_amount: 1000, service_fee: 50, ticket_quantity: 1, transaction_id: 'chk_x' };

(async () => {
  let email = load({});
  sent.length = 0;
  await email.sendPaymentAdminNotificationEmail({ student: { name: 'A' }, event: { title: 'Movie Night' }, payment, ticketNumber: 'N-1' });
  check('payment alert goes to nacos@tau.edu.ng only by default', sent.length === 1 && toList(sent[0]).join() === 'nacos@tau.edu.ng', sent.map(toList));
  check('payment alert never goes to the personal address', !sent.some(m => toList(m).includes(PERSONAL)), sent.map(toList));

  email = load({ ADMIN_EMAIL: 'Exec@tau.edu.ng' });
  sent.length = 0;
  await email.sendPaymentAdminNotificationEmail({ student: { name: 'A' }, event: { title: 'Movie Night' }, payment, ticketNumber: 'N-1' });
  check('ADMIN_EMAIL is added once', toList(sent[0]).join() === 'nacos@tau.edu.ng,exec@tau.edu.ng', toList(sent[0]));

  email = load({ PAYMENT_ALERT_EMAILS: 'treasurer@tau.edu.ng, nacos@tau.edu.ng', ADMIN_EMAIL: 'exec@tau.edu.ng' });
  sent.length = 0;
  await email.sendPaymentAdminNotificationEmail({ student: { name: 'A' }, event: { title: 'Movie Night' }, payment, ticketNumber: 'N-1' });
  check('PAYMENT_ALERT_EMAILS, when set, is the exact list', toList(sent[0]).join() === 'treasurer@tau.edu.ng,nacos@tau.edu.ng', toList(sent[0]));

  // New hackathon team alert
  const hack = { hackathon: { title: 'Build' }, registration: { team_name: 'Faena' }, leader: { name: 'Lead' }, teammates: [] };
  email = load({});
  sent.length = 0;
  await email.sendHackathonTeamAdminNotificationEmail(hack);
  check('hackathon alert goes to nacos@tau.edu.ng only by default', sent.length === 1 && toList(sent[0]).join() === 'nacos@tau.edu.ng', sent.map(toList));
  check('hackathon alert never goes to the personal address', !sent.some(m => toList(m).includes(PERSONAL)), sent.map(toList));
  email = load({ HACKATHON_ALERT_EMAILS: 'tech@tau.edu.ng' });
  sent.length = 0;
  await email.sendHackathonTeamAdminNotificationEmail(hack);
  check('HACKATHON_ALERT_EMAILS, when set, is the exact list', toList(sent[0]).join() === 'tech@tau.edu.ng', sent.map(toList));

  const src = require('fs').readFileSync(path.join(backend, 'services/email.js'), 'utf8');
  check('the personal address appears nowhere in the email code', !src.toLowerCase().includes(PERSONAL));

  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  process.exitCode = fails ? 1 : 0; setTimeout(() => process.exit(process.exitCode), 200);
})().catch(e => { console.error(e); process.exit(2); });
