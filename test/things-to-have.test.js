// What a worker must have for a job (their own two-wheeler, a driving
// licence, a smartphone, a laptop): set on the job form or read from its
// requirements, shown on cards and the job page, a filter that hides jobs
// needing what someone doesn't have, in the API, and compared with "Things
// you have for work" on a job seeker's profile.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const needs = require('../job-needs');
const jobMatch = require('../job-match');
const { startServer } = require('./helpers');

const day = (offset) => new Date(Date.now() + offset * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

test('things to have are ticked or read from the requirement lines only', () => {
  assert.deepEqual(needs.itemsOf({ mustHave: ['Two-wheeler driving licence'], qualifications: ['Own bike required', 'Android phone'] }), ['bike', 'licence', 'smartphone']);
  assert.deepEqual(needs.itemsOf({ qualifications: ['Laptop provided by the company'] }), [], 'a laptop the employer gives is not one to bring');
  assert.deepEqual(needs.itemsOf({ eligibility: ['Must have own laptop'] }), ['laptop']);
  assert.deepEqual(needs.itemsOf({ description: 'Bike delivery in Pune', benefits: ['Petrol allowance for your own bike'] }), [], 'only requirement lines count');
  assert.deepEqual(needs.itemsOf({ bring: ['laptop', 'nonsense'] }), ['laptop']);
  assert.equal(needs.needsNoneOf({ bring: ['bike'] }, ['laptop']), true);
  assert.equal(needs.needsNoneOf({ bring: ['bike'] }, ['laptop', 'bike']), false);
  assert.deepEqual(needs.parseExtras({ bring: 'licence, bike' }).bring, ['bike', 'licence']);
  assert.equal(needs.parseExtras({ bring: ['car'] }).errors.length, 1);
});

test('the match says whether the profile has each one; a licence also counts from certificates', () => {
  const job = { id: 'x', title: 'Delivery Partner', type: 'Full-time', location: 'Pune', bring: ['bike', 'licence'], skills: [] };
  const reqs = (profile) => Object.fromEntries(jobMatch.requirementsOf(jobMatch.facts(profile), job).filter((r) => r.key.startsWith('item-')).map((r) => [r.key, r.met]));
  assert.deepEqual(reqs({}), { 'item-bike': null, 'item-licence': null });
  assert.deepEqual(reqs({ preferences: { has: ['bike'] } }), { 'item-bike': true, 'item-licence': null });
  assert.deepEqual(reqs({ preferences: { has: ['bike'] }, certifications: [{ name: 'Two-wheeler licence (MCWG)' }] }), { 'item-bike': true, 'item-licence': true });
});

const base = { company: 'Nova Foods', location: 'Pune', mode: 'On-site', type: 'Full-time', category: 'Logistics', experience: 'Fresher', salary: '', skills: ['Packing'], description: 'Work', responsibilities: [], posted: day(-1), status: 'open', alertsSentAt: day(-1) };
const seedJobs = [
  { ...base, id: 'hr-601', title: 'Delivery Partner', bring: ['bike', 'licence', 'smartphone'] },
  { ...base, id: 'hr-602', title: 'Remote Data Entry', mode: 'Remote', location: 'Remote', eligibility: ['Must have own laptop and internet'] },
  { ...base, id: 'hr-603', title: 'Store Helper' },
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

test('cards, the job page and the "things I don\'t have" filter', async () => {
  const all = await (await srv.request('/jobs')).text();
  assert.match(all, /name="without" value="bike"/);
  assert.match(all, /class="tag tag-item">Needs: Own two-wheeler</);
  assert.match(all, /class="tag tag-item">Needs: Laptop</);
  shows(await (await srv.request('/jobs?without=bike')).text(), ['Remote Data Entry', 'Store Helper']);
  shows(await (await srv.request('/jobs?without=bike&without=laptop')).text(), ['Store Helper']);
  assert.equal((await srv.request('/jobs?without=car')).status, 200, 'an unknown one is ignored on the page');

  const page = await (await srv.request('/jobs/hr-601')).text();
  assert.match(page, /<dt>You need to have<\/dt><dd>Own two-wheeler · Driving licence · Smartphone<\/dd>/);
  assert.doesNotMatch(await (await srv.request('/jobs/hr-603')).text(), /You need to have/);
});

test('the API filters and describes them', async () => {
  const r = await (await srv.request('/api/jobs?without=laptop,smartphone')).json();
  assert.deepEqual(r.jobs.map((j) => j.id), ['hr-603']);
  const one = await (await srv.request('/api/jobs/hr-601')).json();
  assert.deepEqual((one.job || one).needsToHave, ['bike', 'licence', 'smartphone']);
  assert.equal((await srv.request('/api/jobs?without=car')).status, 400);
  const spec = await (await srv.request('/api/v1/openapi.json')).json();
  assert.ok(spec.components.schemas.Job.properties.needsToHave);
  assert.ok(spec.components.schemas.JobInput.properties.bring);
});

test('the team sets them on the job form', async () => {
  assert.match(await (await srv.request('/admin/jobs/new', { cookie: admin })).text(), /name="bring" value="licence"/);
  const form = { ...base, skills: 'Packing', responsibilities: '', title: 'Store Helper', bring: ['smartphone'] };
  delete form.posted; delete form.alertsSentAt;
  const saved = await srv.request('/admin/jobs/hr-603', { method: 'POST', cookie: admin, form });
  assert.ok(saved.status < 400, String(saved.status));
  assert.deepEqual(srv.records('jobs').find((x) => x.id === 'hr-603').bring, ['smartphone']);
});

test('a job seeker says what they have on their profile', async () => {
  const cp = require('../candidate-profile');
  const ctx = { categories: [], cities: [], types: [], modes: [] };
  assert.deepEqual(cp.parsePatch({ preferences: { has: ['bike', 'laptop'] } }, ctx).patch.preferences.has, ['bike', 'laptop']);
  assert.match(cp.parsePatch({ preferences: { has: ['car'] } }, ctx).errors.join(' '), /Things you have: choose from the list/);
});
