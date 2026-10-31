// Jobs for people with a two-wheeler or a driving licence: ?needs= lists only
// jobs that need the thing (the opposite of ?without=), on /jobs, the API and
// the pages /jobs/two-wheeler and /jobs/driving-licence (and per city).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const needs = require('../job-needs');
const { startServer } = require('./helpers');

const day = (offset) => new Date(Date.now() + offset * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const base = { company: 'Nova Foods', location: 'Pune', mode: 'On-site', type: 'Full-time', category: 'Logistics', experience: 'Fresher', salary: '', skills: [], description: 'Work', responsibilities: [], posted: day(-1), status: 'open', alertsSentAt: day(-1) };
const seedJobs = [
  { ...base, id: 'hr-801', title: 'Delivery Rider', bring: ['bike', 'licence'] },
  { ...base, id: 'hr-802', title: 'Cab Chauffeur', location: 'Mumbai', mustHave: ['Valid driving licence (LMV)'] },
  { ...base, id: 'hr-803', title: 'Store Helper' },
];
let srv;
before(async () => { srv = await startServer({}, { jobs: seedJobs }); });
after(() => srv && srv.stop());

test('needsAllOf: every thing asked for must be needed by the job', () => {
  assert.equal(needs.needsAllOf({ bring: ['bike', 'licence'] }, ['bike']), true);
  assert.equal(needs.needsAllOf({ bring: ['licence'] }, ['bike']), false);
  assert.equal(needs.needsAllOf({ bring: ['licence'] }, ['bike', 'licence']), false);
});

test('?needs= on /jobs and the API lists only jobs that need it; bad values are refused', async () => {
  const ids = async (q) => (await (await srv.request(`/api/jobs?${q}`)).json()).jobs.map((j) => j.id).sort();
  assert.deepEqual(await ids('needs=bike'), ['hr-801']);
  assert.deepEqual(await ids('needs=licence'), ['hr-801', 'hr-802']);
  assert.deepEqual(await ids('needs=bike,licence'), ['hr-801']);
  assert.equal((await srv.request('/api/jobs?needs=car')).status, 400);
  const html = await (await srv.request('/jobs?needs=bike')).text();
  assert.match(html, /Delivery Rider/);
  assert.doesNotMatch(html, /Store Helper/);
  assert.match(html, /Needs: Own two-wheeler/);
});

test('the two-wheeler and driving licence pages, with city pages', async () => {
  const bike = await (await srv.request('/jobs/two-wheeler')).text();
  assert.match(bike, /Jobs for people with a two-wheeler/);
  assert.match(bike, /Delivery Rider/);
  assert.doesNotMatch(bike, /Cab Chauffeur|Store Helper/);
  const dl = await (await srv.request('/jobs/driving-licence/in/mumbai')).text();
  assert.match(dl, /Cab Chauffeur/);
  assert.doesNotMatch(dl, /Delivery Rider/);
  const map = await (await srv.request('/sitemap.xml')).text();
  assert.match(map, /\/jobs\/two-wheeler<\/loc>/);
});
