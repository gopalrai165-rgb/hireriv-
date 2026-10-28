// Minimum education and perks (food, a place to stay, transport, PF …): set
// on the job form or read from the job's own words, shown on cards and the
// job page, used as filters, landing pages and in the API, and compared with
// the education on a job seeker's profile.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const needs = require('../job-needs');
const jobMatch = require('../job-match');
const { startServer } = require('./helpers');

const day = (offset) => new Date(Date.now() + offset * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

test('education is read from the list or the words, and met by higher levels on the same track', () => {
  assert.deepEqual(needs.educationNeeds({ education: '12th pass or ITI' }), ['12th', 'iti']);
  assert.deepEqual(needs.educationNeeds({ education: 'Post graduate (MBA)' }), ['postgraduate'], 'post graduate is not also graduate');
  assert.deepEqual(needs.educationNeeds({ education: 'B.Com or BBA' }), ['graduate']);
  assert.deepEqual(needs.educationNeeds({ education: 'Should be able to read' }), []);
  assert.deepEqual(needs.educationNeeds({ education: 'Graduate', minEducation: '10th' }), ['10th'], 'the list choice wins');
  assert.equal(needs.fitsEducation({ minEducation: '10th' }, '12th'), true);
  assert.equal(needs.fitsEducation({ minEducation: '12th' }, 'iti'), false, 'ITI is its own track');
  assert.equal(needs.fitsEducation({ education: '12th pass or ITI' }, 'iti'), true);
  assert.equal(needs.fitsEducation({ minEducation: 'none' }, 'below'), true);
  assert.equal(needs.fitsEducation({}, 'graduate'), false, 'a job that never said is not promised');
  assert.deepEqual(needs.educationFromProfile(['Diploma', 'Graduate', 'Doctorate']), ['iti', 'graduate', 'postgraduate']);

  const job = { id: 'x', title: 'Accounts Assistant', type: 'Full-time', location: 'Pune', minEducation: 'graduate', skills: [] };
  const req = (education) => jobMatch.requirementsOf(jobMatch.facts({ education }), job).find((r) => r.key === 'education');
  assert.equal(req([{ level: 'Graduate', course: 'B.Com' }]).met, true);
  assert.equal(req([{ level: '12th pass' }]).met, false);
  assert.equal(req([]).met, null, 'unknown until education is on the profile');
  assert.equal(req([]).label, 'Graduate or more');
  assert.equal(jobMatch.requirementsOf(jobMatch.facts({}), { ...job, minEducation: 'none' }).some((r) => r.key === 'education'), false);
});

test('perks come from the ticks and the benefits, never from the costs the worker pays', () => {
  assert.deepEqual(needs.perksOf({ perks: ['pf'], benefits: ['Free lunch in the canteen', 'Hostel for outstation staff'], payNote: 'plus monthly incentives' }), ['food', 'stay', 'pf', 'incentives']);
  assert.deepEqual(needs.perksOf({ workerCosts: 'Room rent ₹1,500 a month, food at cost' }), []);
  assert.deepEqual(needs.perksOf({ perks: ['nonsense'] }), []);
  assert.equal(needs.hasPerks({ perks: ['food', 'stay'] }, ['stay']), true);
  assert.equal(needs.hasPerks({ perks: ['food'] }, ['food', 'stay']), false);
  assert.deepEqual(needs.parseExtras({ minEducation: 'iti', perks: ['stay', 'food'] }), { minEducation: 'iti', perks: ['food', 'stay'], bring: [], errors: [] });
  assert.deepEqual(needs.parseExtras({ perks: 'transport, pf' }).perks, ['transport', 'pf']);
  const bad = needs.parseExtras({ minEducation: 'phd', perks: ['gym'] });
  assert.equal(bad.errors.length, 2);
  assert.deepEqual([bad.minEducation, bad.perks], ['', []]);
});

const base = { company: 'Nova Foods', location: 'Pune', mode: 'On-site', type: 'Full-time', category: 'Logistics', experience: 'Fresher', salary: '', skills: ['Packing'], description: 'Work', responsibilities: [], posted: day(-1), status: 'open', alertsSentAt: day(-1) };
const seedJobs = [
  { ...base, id: 'hr-501', title: 'Warehouse Helper', minEducation: '10th', perks: ['food', 'stay'] },
  { ...base, id: 'hr-502', title: 'Machine Operator', education: 'ITI (Fitter) or Diploma', benefits: ['Company bus from Chakan', 'PF and ESI'] },
  { ...base, id: 'hr-503', title: 'Accounts Executive', location: 'Mumbai', minEducation: 'graduate' },
  { ...base, id: 'hr-504', title: 'Telecaller', education: '12th pass', workerCosts: 'Stay at own cost' },
];
const titles = seedJobs.map((j) => j.title);
const shows = (html, want) => { for (const t of titles) assert.equal(html.includes(`>${t}<`), want.includes(t), t); };
let srv;
let admin;
before(async () => {
  srv = await startServer({}, { jobs: seedJobs });
  admin = await srv.adminLogin();
});
after(() => srv && srv.stop());

test('Find Jobs filters by education and perks', async () => {
  const all = await (await srv.request('/jobs')).text();
  assert.match(all, /id="f-education"/);
  assert.match(all, /name="perk" value="stay"/);
  assert.match(all, /class="tag tag-perk">Stay \/ room</);
  assert.match(all, /class="tag tag-perk">Transport</, 'read from the benefits');

  shows(await (await srv.request('/jobs?education=12th')).text(), ['Warehouse Helper', 'Telecaller']);
  shows(await (await srv.request('/jobs?education=iti')).text(), ['Warehouse Helper', 'Machine Operator']);
  shows(await (await srv.request('/jobs?education=postgraduate')).text(), ['Warehouse Helper', 'Accounts Executive', 'Telecaller']);
  const both = await (await srv.request('/jobs?perk=food&perk=stay')).text();
  shows(both, ['Warehouse Helper']);
  // With nothing found, each perk has a link that drops just that one.
  assert.match(await (await srv.request('/jobs?perk=food&perk=insurance')).text(), /href="\/jobs\?perk=food"/);
  shows(await (await srv.request('/jobs?perks=pf')).text(), ['Machine Operator']);
  assert.match(await (await srv.request('/jobs?education=12th')).text(), /My education: 12th pass/);
  assert.equal((await srv.request('/jobs?education=phd')).status, 200, 'an unknown level is ignored on the page');
});

test('the job page shows the education and perks', async () => {
  const page = await (await srv.request('/jobs/hr-501')).text();
  assert.match(page, /<dd>10th pass<\/dd>/);
  assert.match(page, /class="perk-list"[\s\S]*Food \/ meals[\s\S]*Stay \/ room/);
  const op = await (await srv.request('/jobs/hr-502')).text();
  assert.match(op, /<dd>ITI \(Fitter\) or Diploma<\/dd>/, 'the words alone when nothing was picked from the list');
  assert.doesNotMatch(await (await srv.request('/jobs/hr-504')).text(), /class="perk-list"/, 'costs the worker pays are not perks');
});

test('the API filters and describes them', async () => {
  const r = await (await srv.request('/api/jobs?education=iti&perk=transport')).json();
  assert.deepEqual(r.jobs.map((j) => j.id), ['hr-502']);
  assert.equal(r.jobs[0].minEducation, 'iti');
  assert.deepEqual(r.jobs[0].perks, ['transport', 'pf']);
  assert.equal((await srv.request('/api/jobs?perk=gym')).status, 400);
  const spec = await (await srv.request('/api/v1/openapi.json')).json();
  assert.ok(spec.components.schemas.Job.properties.perks);
  assert.ok(spec.components.schemas.JobInput.properties.minEducation);
});

test('landing pages for 10th pass, 12th pass, ITI and jobs with a place to stay', async () => {
  const expect = {
    '/jobs/10th-pass': ['Warehouse Helper'],
    '/jobs/12th-pass': ['Warehouse Helper', 'Telecaller'],
    '/jobs/iti-diploma': ['Warehouse Helper', 'Machine Operator'],
    '/jobs/with-accommodation': ['Warehouse Helper'],
    '/jobs/12th-pass/in/pune': ['Warehouse Helper', 'Telecaller'],
  };
  for (const [path, want] of Object.entries(expect)) {
    const res = await srv.request(path);
    assert.equal(res.status, 200, path);
    shows(await res.text(), want);
  }
  const map = await (await srv.request('/sitemap.xml')).text();
  for (const p of ['/jobs/10th-pass</loc>', '/jobs/with-accommodation/in/pune</loc>']) assert.ok(map.includes(p), p);
  assert.ok(!map.includes('/jobs/with-accommodation/in/mumbai</loc>'), 'empty city pages are left out');
});

test('the team sets them on the job form', async () => {
  const page = await (await srv.request('/admin/jobs/new', { cookie: admin })).text();
  assert.match(page, /name="minEducation"/);
  assert.match(page, /name="perks" value="insurance"/);
  const form = { ...base, skills: 'Packing', responsibilities: '', title: 'Telecaller', minEducation: '12th', perks: ['transport', 'insurance'] };
  delete form.posted; delete form.alertsSentAt;
  const saved = await srv.request('/admin/jobs/hr-504', { method: 'POST', cookie: admin, form });
  assert.ok(saved.status < 400, String(saved.status));
  const j = srv.records('jobs').find((x) => x.id === 'hr-504');
  assert.deepEqual([j.minEducation, j.perks], ['12th', ['transport', 'insurance']]);
  const refused = await srv.request('/admin/jobs/hr-504', { method: 'POST', cookie: admin, form: { ...form, minEducation: 'phd' } });
  assert.equal(refused.status, 400);
  assert.match(await refused.text(), /minimum education must be one of/);
});
