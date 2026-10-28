// Walk-in interviews (days, time, whom to ask) and the English a job needs:
// set on the job form, shown on cards and the job page, used as filters and
// in the API, and compared with the English on a job seeker's profile.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const needs = require('../job-needs');
const jobMatch = require('../job-match');
const { startServer } = require('./helpers');

const day = (offset) => new Date(Date.now() + offset * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const today = day(0);

test('walk-in details are checked and described', () => {
  const ok = needs.parse({ english: 'Basic', walkInFrom: day(1), walkInTo: day(3), walkInTime: ' 10 am –  4 pm ', walkInContact: 'Priya, HR desk' }, { walkIn: true, today });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.walkInTime, '10 am – 4 pm');
  // Without the box ticked, the days are ignored.
  assert.equal(needs.parse({ walkInFrom: day(1) }, { walkIn: false, today }).walkInFrom, '');
  for (const [body, re] of [
    [{ english: 'Some' }, /English needed/],
    [{ walkInFrom: '2026-02-30' }, /not a date/],
    [{ walkInFrom: day(5), walkInTo: day(2) }, /before the first/],
    [{ walkInTo: day(-1) }, /are over/],
  ]) assert.ok(needs.parse(body, { walkIn: true, today }).errors.some((e) => re.test(e)), JSON.stringify(body));
  // A closed job may keep walk-in days that have passed.
  assert.deepEqual(needs.parse({ walkInTo: day(-1) }, { walkIn: true, today, closed: true }).errors, []);

  const job = { walkIn: true, walkInFrom: day(2), walkInTo: day(4), address: 'Gate 2, MIDC' };
  assert.equal(needs.walkInOf(job, today).state, 'upcoming');
  assert.equal(needs.walkInOf({ ...job, walkInFrom: day(-1) }, today).state, 'open');
  assert.equal(needs.walkInOf({ ...job, walkInTo: day(-1), walkInFrom: day(-3) }, today).state, 'over');
  assert.equal(needs.walkInOpen({ walkIn: true }, today), true, 'no days means any working day');
  assert.equal(needs.walkInOf({ walkIn: false }, today), null);
  assert.equal(needs.walkInDays({ from: '2026-11-12', to: '2026-11-15' }, '2026-10-28'), '12 Nov – 15 Nov');
  assert.equal(needs.walkInDays({ from: '2027-01-05', to: '' }, '2026-10-28'), '5 Jan 2027');
});

test('English: the filter keeps jobs needing that much or less, and the match compares the profile', () => {
  assert.equal(needs.fitsEnglish({ english: 'None' }, 'Basic'), true);
  assert.equal(needs.fitsEnglish({ english: 'Good' }, 'Basic'), false);
  assert.equal(needs.fitsEnglish({}, 'Fluent'), false, 'a job that never said is not promised');
  const job = { id: 'x', title: 'Telecaller', type: 'Full-time', location: 'Pune', english: 'Good', skills: [] };
  const req = (languages) => jobMatch.requirementsOf(jobMatch.facts({ languages }), job).find((r) => r.key === 'english');
  assert.equal(req([{ name: 'English', level: 'Basic' }]).met, false);
  assert.equal(req([{ name: 'English', level: 'Conversational' }]).met, true);
  assert.equal(req([{ name: 'Hindi', level: 'Native' }]).met, null, 'unknown until English is on the profile');
  assert.equal(jobMatch.requirementsOf(jobMatch.facts({}), { ...job, english: 'None' }).some((r) => r.key === 'english'), false);
});

const base = { company: 'Nova Foods', location: 'Pune', mode: 'On-site', type: 'Full-time', category: 'Logistics', experience: 'Fresher', salary: '', skills: ['Packing'], description: 'Packing in a warehouse', responsibilities: [], posted: day(-1), status: 'open', alertsSentAt: day(-1) };
const seedJobs = [
  { ...base, id: 'hr-301', title: 'Warehouse Packer', english: 'None', walkIn: true, address: 'Plot 12, MIDC Bhosari, Pune', walkInFrom: day(-1), walkInTo: day(5), walkInTime: '10 am – 4 pm', walkInContact: 'Priya, HR desk' },
  { ...base, id: 'hr-302', title: 'Customer Care Executive', english: 'Good' },
  { ...base, id: 'hr-303', title: 'Loader', walkIn: true, address: 'Gate 4, Chakan', walkInFrom: day(-6), walkInTo: day(-2) },
];
let srv;
let admin;
before(async () => {
  srv = await startServer({}, { jobs: seedJobs });
  admin = await srv.adminLogin();
});
after(() => srv && srv.stop());

test('cards, filters and the job page show walk-ins and English', async () => {
  const all = await (await srv.request('/jobs')).text();
  assert.match(all, /class="tag tag-walkin">Walk-in: /);
  assert.match(all, /class="tag tag-english">No English needed/);
  assert.match(all, /name="english"/);
  assert.match(all, /name="walkin"/);

  const walkins = await (await srv.request('/jobs?walkin=1')).text();
  assert.ok(walkins.includes('Warehouse Packer'));
  assert.ok(!walkins.includes('Loader'), 'walk-ins that ended drop out');
  assert.ok(!walkins.includes('Customer Care Executive'));

  const basic = await (await srv.request('/jobs?english=basic')).text();
  assert.ok(basic.includes('Warehouse Packer'));
  assert.ok(!basic.includes('Customer Care Executive'));
  assert.match(basic, /My English: Basic English/);
  assert.equal((await srv.request('/jobs?english=perfect')).status, 200, 'an unknown level is ignored on the page');

  const page = await (await srv.request('/jobs/hr-301')).text();
  assert.match(page, /class="walkin-box"/);
  assert.match(page, /10 am – 4 pm/);
  assert.match(page, /Ask for Priya, HR desk/);
  assert.match(page, /You never pay a fee/);
  assert.match(await (await srv.request('/jobs/hr-303')).text(), /The walk-in days are over/);
  // Hindi labels.
  assert.match(await (await srv.request('/jobs/hr-301?lang=hi')).text(), /अंग्रेज़ी ज़रूरी नहीं/);
});

test('the API filters and describes them', async () => {
  const r = await (await srv.request('/api/jobs?walkin=1&english=none')).json();
  assert.deepEqual(r.jobs.map((j) => j.id), ['hr-301']);
  assert.equal(r.jobs[0].englishNeeded, 'None');
  assert.deepEqual(r.jobs[0].walkInDetails, { from: day(-1), to: day(5), time: '10 am – 4 pm', contact: 'Priya, HR desk', open: true });
  const bad = await srv.request('/api/jobs?english=perfect');
  assert.equal(bad.status, 400);
});

test('the team sets English and walk-in days on the job form', async () => {
  const form = { ...base, skills: 'Packing', responsibilities: '', title: 'Picker', english: 'Basic', walkIn: '1', address: 'Unit 3, Talegaon', walkInFrom: day(1), walkInTo: day(2), walkInTime: '9 am – 1 pm', walkInContact: 'Ravi' };
  delete form.posted; delete form.alertsSentAt;
  const page = await (await srv.request('/admin/jobs/new', { cookie: admin })).text();
  assert.match(page, /name="walkInFrom"/);
  assert.match(page, /name="english"/);
  const saved = await srv.request('/admin/jobs/hr-302', { method: 'POST', cookie: admin, form });
  assert.ok(saved.status < 400, String(saved.status));
  const j = srv.records('jobs').find((x) => x.id === 'hr-302');
  assert.deepEqual([j.english, j.walkIn, j.walkInFrom, j.walkInTo, j.walkInTime, j.walkInContact], ['Basic', true, day(1), day(2), '9 am – 1 pm', 'Ravi']);
  const refused = await srv.request('/admin/jobs/hr-302', { method: 'POST', cookie: admin, form: { ...form, walkInTo: day(-3), walkInFrom: day(-4) } });
  assert.equal(refused.status, 400);
  assert.match(await refused.text(), /walk-in days are over/);
});
