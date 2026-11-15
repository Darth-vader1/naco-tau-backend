// Render the hackathon announcement email (no sending) and check the prize pool.
const path = require('path');
const Module = require('module');
const backend = path.resolve(process.argv[2] || path.join(__dirname, '..', '..'));

const stubs = {
  [path.join(backend, 'config/supabase.js')]: { supabase: { from: () => ({ insert: async () => ({}), select: () => ({}) }) } }
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const resolved = Module._resolveFilename(request, parent, isMain);
  return stubs[resolved] || origLoad.apply(this, arguments);
};

const email = require(path.join(backend, 'services/email.js'));
let fails = 0;
const check = (name, cond, extra) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  ' + extra)); if (!cond) fails++; };

const cases = [
  ['300000', '₦300,000'],
  ['N300,000 (1st: 150k, 2nd: 100k, 3rd: 50k)', '₦300,000 (1st: ₦150,000, 2nd: ₦100,000, 3rd: ₦50,000)'],
  ['Laptops and internships', 'Laptops and internships']
];
for (const [prize, want] of cases) {
  const tpl = email.getEmailTemplate('new_hackathon', { title: 'Build Week', prize_pool: prize, event_type: 'hackathon' });
  const html = typeof tpl === 'string' ? tpl : (tpl && (tpl.html || tpl.body)) || JSON.stringify(tpl);
  check(`email body shows "${want}"`, html.includes(want), html.match(/Prize Pool[\s\S]{0,300}/)?.[0]);
}
const empty = email.getEmailTemplate('new_hackathon', { title: 'Build Week', prize_pool: null });
const emptyHtml = typeof empty === 'string' ? empty : (empty && (empty.html || empty.body)) || '';
check('no prize -> "Prizes & Recognition"', emptyHtml.includes('Prizes &amp; Recognition') || emptyHtml.includes('Prizes & Recognition'), '');

// Subject line: same formatting (built inside triggerAutoContentBroadcast)
const src = require('fs').readFileSync(path.join(backend, 'services/email.js'), 'utf8');
check('subject uses the formatter', /prizeSnippet = itemData\.prize_pool \? ` \(\$\{formatPrizeText\(itemData\.prize_pool\)\}\)`/.test(src), '');
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
process.exitCode = fails ? 1 : 0; setTimeout(() => process.exit(process.exitCode), 200);
