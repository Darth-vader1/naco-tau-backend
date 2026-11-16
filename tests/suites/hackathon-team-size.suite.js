// Test POST /hackathons/:id/register team-size rules with a stubbed database.
const path = require('path');
const Module = require('module');
const backend = path.resolve(process.argv[2] || path.join(__dirname, '..', '..'));
const express = require(path.join(backend, 'node_modules', 'express'));

const saved = [];
function qb(table) {
  const api = {
    select() { return api; }, eq() { return api; }, neq() { return api; }, ilike() { return api; }, limit() { return api; },
    order() { return api; }, in() { return api; },
    maybeSingle: async () => (table === 'hackathon_registrations' && global.existing ? { data: { id: 'r-existing', status: 'registered', leader_id: 'leader-1' }, error: null } : table === 'hackathons'
      ? { data: { id: 'h1', title: 'Build', max_team_size: 4, min_team_size: 1, status: 'open', is_published: true, registration_deadline: null }, error: null }
      : { data: null, error: null }),
    single: async () => ({ data: saved[saved.length - 1] || null, error: null }),
    insert(rows) { saved.push({ id: 'r' + saved.length, ...rows[0] }); return api; },
    update(row) { saved.push({ id: 'r' + saved.length, ...row }); return api; },
    then(res, rej) { return Promise.resolve({ data: [], error: null }).then(res, rej); }
  };
  return api;
}
const stubs = {
  [path.join(backend, 'config/supabase.js')]: { supabase: { from: qb } },
  [path.join(backend, 'middleware/auth.js')]: {
    authenticate: (req, res, next) => { req.userId = 'leader-1'; req.user = { id: 'leader-1', email: 'adeoye.emmanuel@st.tau.edu.ng' }; next(); },
    requireAdmin: (q, s, n) => n(), optionalAuth: (q, s, n) => n(), requireSuperAdmin: (q, s, n) => n()
  },
  [path.join(backend, 'middleware/audit.js')]: { auditLog: async () => {} },
  [path.join(backend, 'services/email.js')]: { triggerAutoContentBroadcast: () => {}, sendHackathonTeamAdminNotificationEmail: async (a) => { global.alerts = global.alerts || []; global.alerts.push(a); if (global.failEmail) throw new Error('smtp down'); } }
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const resolved = Module._resolveFilename(request, parent, isMain);
  return stubs[resolved] || origLoad.apply(this, arguments);
};

const router = require(path.join(backend, 'routes/hackathons.js'));
const app = express(); app.use(express.json()); app.use('/h', router);
const server = app.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}/h`;
  const post = async (body) => { const r = await fetch(base + '/h1/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  let fails = 0;
  const check = (name, cond, extra) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : ' ' + JSON.stringify(extra))); if (!cond) fails++; };

  const meta = [{ name: '[LEADER_META]', leader_name: 'adeoye opeyemi', email: 'adeoye.emmanuel@st.tau.edu.ng' }, { name: '[ROLE_REQ]', role: 'Designer' }];
  const faenaMembers = [
    { name: 'Adeoye Opeyemi', email: 'ADEOYE.EMMANUEL@st.tau.edu.ng', role: 'Team Lead' },
    { name: 'Olorunshola Olamide', email: 'olorunshola.olamide@st.tau.edu.ng', role: 'Member' },
    { name: 'Ibrahim kolade', email: 'Ibraheem.kolade@st.tau.edu.ng', role: 'Member' },
    { name: 'Olusumade Churchill', email: 'olusunmade.churchill@st.tau.edu.ng', role: 'Member' },
    ...meta
  ];
  let r = await post({ teamName: 'Faena', trackSelected: 'General', teamMembers: faenaMembers });
  const stored = saved[saved.length - 1] || {};
  const storedTeammates = (stored.team_members || []).filter(m => !String(m.name).startsWith('['));
  check('4-person team (leader listed themself too) is accepted under a 4-person limit', r.status === 200 || r.status === 201, r);
  check('leader is not saved as a teammate', storedTeammates.length === 3 && !storedTeammates.some(m => /adeoye\.emmanuel/i.test(m.email)), stored.team_members);
  check('internal rows are kept', (stored.team_members || []).some(m => m.name === '[LEADER_META]'), stored.team_members);

  r = await post({ teamName: 'TooBig', trackSelected: 'General', teamMembers: [
    { name: 'A', email: 'a@st.tau.edu.ng' }, { name: 'B', email: 'b@st.tau.edu.ng' }, { name: 'C', email: 'c@st.tau.edu.ng' }, { name: 'D', email: 'd@st.tau.edu.ng' }, ...meta] });
  check('5 people (leader + 4 teammates) is refused under a 4-person limit', r.status === 400 && /cannot exceed 4/.test(r.body.error || r.body.message), r);


  // ---- Admin alert on new team ----
  global.alerts = [];
  r = await post({ teamName: 'Nova', trackSelected: 'AI', teamMembers: [{ name: 'Tola', email: 'tola@st.tau.edu.ng', role: 'Dev' }, ...meta] });
  const a = global.alerts[0];
  check('new team -> exactly one admin email', (r.status === 200 || r.status === 201) && global.alerts.length === 1, { r, n: global.alerts.length });
  check('alert has team, hackathon and teammates (leader not duplicated)', a && a.registration.team_name === 'Nova' && a.hackathon.title === 'Build' && a.teammates.length === 1 && a.teammates[0].name === 'Tola', a);

  global.alerts = []; global.existing = true;
  r = await post({ teamName: 'Nova Renamed', trackSelected: 'AI', teamMembers: [...meta] });
  check('editing an existing team sends no admin email', r.status === 200 && global.alerts.length === 0, { r, n: global.alerts.length });
  global.existing = false;

  global.alerts = []; global.failEmail = true;
  r = await post({ teamName: 'Orbit', trackSelected: 'General', teamMembers: [...meta] });
  check('email failure does not break registration', (r.status === 200 || r.status === 201) && global.alerts.length === 1, r);
  global.failEmail = false;

  server.close();
  console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
  process.exitCode = fails ? 1 : 0; setTimeout(() => process.exit(process.exitCode), 200);
});
