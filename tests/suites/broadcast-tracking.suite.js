// Bulk broadcasts (e.g. a flyer) must show in Email Analytics even if the
// run is cut short: the record is written before sending and updated after
// every batch. Run with: npm test (or node tests/suites/broadcast-tracking.suite.js)
const path = require('path');
const Module = require('module');
const backend = path.resolve(process.argv[2] || path.join(__dirname, '..', '..'));

// Skip the 5s pause between batches.
const realSetTimeout = global.setTimeout;
global.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, ms >= 1000 ? 0 : ms, ...a);

const students = Array.from({ length: 120 }, (_, i) => ({ email: `s${i}@st.tau.edu.ng`, name: 'S' + i, status: 'active' }));
const notifications = [];
const snapshots = []; // notification state seen at each send
let failBatch = -1;
let sendNo = 0;

const fakeNodemailer = {
  createTransport: () => ({
    sendMail: async () => {
      const n = notifications[0];
      snapshots.push(n ? { ...n } : null);
      const mine = sendNo++;
      if (mine === failBatch) throw new Error('SMTP down');
      return { messageId: 'm' + mine };
    }
  })
};

function table(name) {
  const q = {
    _name: name, _filter: null,
    select() { return q; },
    or() { return Promise.resolve({ data: name === 'students_with_current_level' ? students : [], error: null }); },
    insert(rows) {
      const row = Array.isArray(rows) ? rows[0] : rows;
      if (name === 'notifications') {
        const rec = { id: 'n' + (notifications.length + 1), ...row };
        notifications.push(rec);
        return { select: () => ({ single: async () => ({ data: { id: rec.id }, error: null }) }), then: (r) => r({ error: null }) };
      }
      return Promise.resolve({ error: null });
    },
    update(patch) {
      return { eq: async (col, val) => { const n = notifications.find(x => x[col] === val); if (n) Object.assign(n, patch); return { error: null }; } };
    }
  };
  return q;
}

const stubs = { [path.join(backend, 'config/supabase.js')]: { supabase: { from: table } } };
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'nodemailer') return fakeNodemailer;
  const resolved = Module._resolveFilename(request, parent, isMain);
  return stubs[resolved] || origLoad.apply(this, arguments);
};
Object.assign(process.env, { SMTP_HOST: 'smtp.test', SMTP_USER: 'bot@test', SMTP_PASS: 'x', OAUTH_CLIENT_ID: '' });

let fails = 0;
const check = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' ' + JSON.stringify(x))); if (!c) fails++; };

(async () => {
  const { sendBulkEmail } = require(path.join(backend, 'services/email.js'));

  const r = await sendBulkEmail({ subject: 'Game Night flyer', html: '<p>hi</p>', text: 'hi' });
  check('3 batches sent for 120 students', sendNo === 3 && r.sent === 120, { sendNo, r });
  check('exactly one analytics record for the broadcast', notifications.length === 1, notifications);
  check('record exists before the first batch goes out (marked sending)', snapshots[0] && snapshots[0].details === 'sending' && snapshots[0].success_count === 0, snapshots[0]);
  check('record shows progress between batches (50 then 100)', snapshots[1]?.success_count === 50 && snapshots[2]?.success_count === 100, snapshots.map(s => s && s.success_count));
  const n = notifications[0];
  check('final record: 120/120 sent, complete', n.success_count === 120 && n.error_count === 0 && n.recipient_count === 120 && n.details === 'complete' && n.type === 'bulk_email' && n.subject === 'Game Night flyer', n);

  // A failing batch is counted and the record still completes
  notifications.length = 0; snapshots.length = 0; sendNo = 0; failBatch = 1;
  const r2 = await sendBulkEmail({ subject: 'Flyer 2', html: '<p>x</p>' });
  const n2 = notifications[0];
  check('a failed batch is counted as failed, others still sent', r2.sent === 70 && r2.failed === 50 && n2.success_count === 70 && n2.error_count === 50, { r2, n2 });
  check('record ends as complete with failures noted', /complete with 50 failed/.test(n2.details), n2.details);

  // The analytics view shows a cut-short broadcast as "sending" with partial counts
  const routeSrc = require('fs').readFileSync(path.join(backend, 'routes/email.js'), 'utf8');
  check('broadcast route keeps the function alive with waitUntil', /waitUntil\(job\)/.test(routeSrc) && /require\('@vercel\/functions'\)/.test(routeSrc));
  check('analytics marks in-progress broadcasts as sending', /isSending \? 'sending'/.test(routeSrc));

  console.log(fails ? `\n${fails} check(s) failed` : '\nAll broadcast tracking checks passed');
  process.exitCode = fails ? 1 : 0;
  realSetTimeout(() => process.exit(process.exitCode), 200);
})().catch(e => { console.error(e); process.exitCode = 1; realSetTimeout(() => process.exit(1), 200); });
