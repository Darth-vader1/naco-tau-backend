// Tests for GET /hackathons/:id/teammate-search and linked-teammate checks
// in POST /hackathons/:id/register, against an in-memory database.
const path = require('path');
const Module = require('module');
const backend = path.resolve(process.argv[2] || path.join(__dirname, '..', '..'));
const express = require(path.join(backend, 'node_modules', 'express'));

// ---------- in-memory tables ----------
const db = {
  hackathons: [{ id: 'h1', title: 'Build', max_team_size: 4, min_team_size: 1, status: 'open', is_published: true, registration_deadline: null }],
  students: [],
  hackathon_registrations: []
};
const student = (user_id, name, extra = {}) => ({ user_id, name, first_name: name.split(' ')[0], last_name: name.split(' ')[1] || '', email: `${user_id}@st.tau.edu.ng`, department: 'Computer Science', current_level: 200, status: 'active', visibility: 'students-only', profile_picture_url: null, ...extra });
db.students.push(
  student('me', 'Adeoye Opeyemi'),
  student('u1', 'Olorunshola Olamide'),
  student('u2', 'Olumide Bakare'),
  student('u3', 'Olusumade Churchill'),
  student('u4', 'Ola Private', { visibility: 'private' }),
  student('u5', 'Olaniyi Banned', { status: 'banned' }),
  student('u6', 'Ibrahim Kolade', { email: 'Ibraheem.kolade@st.tau.edu.ng' }),
  student('u7', 'Olawale Taken'),
  student('u8', 'Olabisi Leader')
);
for (let i = 0; i < 12; i++) db.students.push(student('x' + i, 'Olamide Extra' + i));
db.hackathon_registrations.push({
  id: 'r-other', hackathon_id: 'h1', team_name: 'Rivals', leader_id: 'u8',
  team_members: [{ name: 'Olawale Taken', email: 'u7@st.tau.edu.ng', role: 'Dev' }, { name: '[LEADER_META]', leader_name: 'Olabisi Leader', email: 'u8@st.tau.edu.ng' }]
});

const likeRe = (pat) => new RegExp('^' + pat.split('%').map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
function qb(table) {
  const name = table === 'students_with_current_level' ? 'students' : table;
  const rows = () => db[name] || (db[name] = []);
  const f = []; let lim = null; let op = 'select'; let payload = null;
  const api = {
    select() { return api; },
    eq(c, v) { f.push(r => r[c] === v); return api; },
    neq(c, v) { f.push(r => r[c] !== v); return api; },
    in(c, vals) { f.push(r => vals.includes(r[c])); return api; },
    ilike(c, v) { const re = likeRe(v); f.push(r => re.test(r[c] || '')); return api; },
    or(expr) {
      const parts = expr.split(',').map(p => { const [c, , ...v] = p.split('.'); return { c, re: likeRe(v.join('.')) }; });
      if (parts.some(p => !['name', 'first_name', 'last_name'].includes(p.c))) throw new Error('INJECTION: ' + expr);
      f.push(r => parts.some(p => p.re.test(r[p.c] || ''))); return api;
    },
    order() { return api; },
    limit(n) { lim = n; return api; },
    insert(r) { op = 'insert'; payload = r; return api; },
    update(r) { op = 'update'; payload = r; return api; },
    async maybeSingle() { const out = await run(); return { data: out[0] || null, error: null }; },
    async single() { const out = await run(); return { data: out[0] || null, error: null }; },
    then(res, rej) { return run().then(data => ({ data, error: null })).then(res, rej); }
  };
  async function run() {
    if (op === 'insert') { const r = { id: 'r' + rows().length, ...payload[0] }; rows().push(r); return [r]; }
    let out = rows().filter(r => f.every(fn => fn(r)));
    if (op === 'update') { out.forEach(r => Object.assign(r, payload)); return out; }
    return lim ? out.slice(0, lim) : out;
  }
  return api;
}
const stubs = {
  [path.join(backend, 'config/supabase.js')]: { supabase: { from: qb } },
  [path.join(backend, 'middleware/auth.js')]: {
    authenticate: (req, res, next) => { req.userId = req.headers['x-user'] || 'me'; req.user = { id: req.userId, email: `${req.userId}@st.tau.edu.ng` }; next(); },
    requireAdmin: (q, s, n) => n(), optionalAuth: (q, s, n) => n(), requireSuperAdmin: (q, s, n) => n()
  },
  [path.join(backend, 'middleware/audit.js')]: { auditLog: async () => {} },
  [path.join(backend, 'services/email.js')]: { triggerAutoContentBroadcast: () => {}, sendHackathonTeamAdminNotificationEmail: async () => {} }
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
  const search = async (q, user = 'me') => { const r = await fetch(`${base}/h1/teammate-search?q=${encodeURIComponent(q)}`, { headers: { 'x-user': user } }); return { status: r.status, body: await r.json() }; };
  const register = async (teamMembers, user = 'me', teamName = 'Faena') => { const r = await fetch(`${base}/h1/register`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-user': user }, body: JSON.stringify({ teamName, trackSelected: 'General', teamMembers }) }); return { status: r.status, body: await r.json() }; };
  let fails = 0;
  const check = (name, cond, extra) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : ' ' + JSON.stringify(extra).slice(0, 400))); if (!cond) fails++; };

  // ---- search ----
  let r = await search('Ol');
  check('fewer than 3 letters returns nothing', r.status === 200 && r.body.data.results.length === 0, r.body);
  r = await search('olu');
  let names = r.body.data.results.map(s => s.name);
  check('"olu" finds Olusumade and Olumide (case-insensitive)', names.includes('Olusumade Churchill') && names.includes('Olumide Bakare'), names);
  r = await search('ola');
  names = r.body.data.results.map(s => s.name);
  check('up to 30 results sent so the browser can narrow locally', r.body.data.results.length > 8 && r.body.data.results.length <= 30, r.body.data.results.length);
  check('"ola" result marked complete (every match included)', r.body.data.complete === true, r.body.data);
  for (let i = 0; i < 40; i++) db.students.push(student('y' + i, 'Olayinka Many' + i));
  r = await search('ola');
  check('many matches -> capped at 30 and not complete', r.body.data.results.length === 30 && r.body.data.complete === false, { n: r.body.data.results.length, c: r.body.data.complete });
  db.students = db.students.filter(s => !s.user_id.startsWith('y'));
  r = await search('ola');
  check('private profiles left out', !names.includes('Ola Private'), names);
  check('inactive accounts left out', !names.includes('Olaniyi Banned'), names);
  r = await search('olaw');
  check('someone already on another team is left out', r.body.data.results.length === 0, r.body.data.results);
  r = await search('olab');
  check('another team\'s leader is left out', r.body.data.results.length === 0, r.body.data.results);
  r = await search('adeoye');
  check('you are not suggested to yourself', r.body.data.results.length === 0, r.body.data.results);
  r = await search('ibra');
  const ib = r.body.data.results[0] || {};
  check('result shows name, department and level only (no email/phone)', ib.name === 'Ibrahim Kolade' && ib.department && ib.level === 200 && !('email' in ib) && !('phone' in ib), ib);
  r = await search('x),status.eq.banned');
  check('search text cannot inject filters', r.status === 200, r.body);

  // ---- registration with linked teammates ----
  r = await register([{ name: 'ibr', email: '', role: 'Dev', user_id: 'u6' }, { name: 'Tola Manual', email: 'tola.manual@st.tau.edu.ng', role: 'Design' }]);
  const reg = db.hackathon_registrations.find(x => x.leader_id === 'me');
  const linked = reg && reg.team_members.find(m => m.user_id === 'u6');
  check('linked teammate saved with name/email from their account (no typos)', (r.status === 200 || r.status === 201) && linked && linked.name === 'Ibrahim Kolade' && linked.email === 'Ibraheem.kolade@st.tau.edu.ng', { r, linked });
  check('manual teammate still allowed', reg && reg.team_members.some(m => m.email === 'tola.manual@st.tau.edu.ng' && !m.user_id), reg && reg.team_members);

  r = await search('ibra', 'me');
  check('your own teammates stay findable while you edit your team', r.body.data.results.some(s => s.user_id === 'u6'), r.body.data.results);
  r = await search('ibra', 'u1');
  check('but other leaders can no longer pick them', r.body.data.results.length === 0, r.body.data.results);

  r = await register([{ name: 'Ghost', user_id: 'nobody' }]);
  check('unknown account is refused', r.status === 400 && /couldn't be found/.test(r.body.error || r.body.message), r);
  r = await register([{ name: 'Banned', user_id: 'u5' }]);
  check('inactive account is refused', r.status === 400, r);
  r = await register([{ name: 'A', user_id: 'u1' }, { name: 'A again', user_id: 'u1' }]);
  check('same person twice is refused', r.status === 400 && /more than once/.test(r.body.error || r.body.message), r);
  r = await register([{ name: 'Olawale', user_id: 'u7' }]);
  check('teammate already on another team is refused', r.status === 409 && /Rivals/.test(r.body.error || r.body.message), r);
  r = await register([{ name: 'Olawale typed', email: 'U7@st.tau.edu.ng' }]);
  check('also caught when typed manually by email', r.status === 409, r);
  r = await register([{ name: 'Me', user_id: 'me' }, { name: 'Olu', user_id: 'u3' }]);
  const mine = db.hackathon_registrations.find(x => x.leader_id === 'me');
  check('picking yourself is dropped, not counted', (r.status === 200 || r.status === 201) && !mine.team_members.some(m => m.user_id === 'me') && mine.team_members.some(m => m.user_id === 'u3'), mine.team_members);
  r = await register([], 'u7', 'Second Team');
  check('a student already on a team cannot lead another team', r.status === 409 && /already listed on team "Rivals"/.test(r.body.error || r.body.message), r);

  server.close();
  console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
  process.exitCode = fails ? 1 : 0; setTimeout(() => process.exit(process.exitCode), 200);
});
