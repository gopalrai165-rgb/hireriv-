// How fast a hiring team opens applications: per team, only settled
// applications from the last 90 days, never-opened ones count as slow,
// at least 5 needed, and only good news is shown.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const rt = require('../response-time');
const { startServer } = require('./helpers');

const NOW = Date.parse('2026-10-31T12:00:00Z');
const ago = (days, hours = 0) => new Date(NOW - days * 86400000 + hours * 3600000).toISOString();
const app = (id, jobId, createdDaysAgo, openedAfterHours, extra = {}) => ({ id, jobId, createdAt: ago(createdDaysAgo), viewedAt: openedAfterHours == null ? '' : ago(createdDaysAgo, openedAfterHours), ...extra });
const jobsById = { j1: { id: 'j1', employerId: 'emp-a' }, j2: { id: 'j2', employerId: 'emp-a' }, j3: { id: 'j3' }, j4: { id: 'j4', employerId: 'emp-b' } };
const byId = (id) => jobsById[id];

test('a team\'s jobs share one figure; new, withdrawn and old applications don\'t count', () => {
  const list = [
    app('1', 'j1', 10, 2), app('2', 'j1', 10, 5), app('3', 'j2', 20, 10), app('4', 'j2', 30, 20), app('5', 'j1', 40, 30),
    app('6', 'j1', 1, null), app('7', 'j1', 10, null, { withdrawnAt: ago(9) }), app('8', 'j1', 200, null),
  ];
  const t = rt.byTeam(list, byId, NOW)['emp-a'];
  assert.equal(t.count, 5);
  assert.equal(t.medianHours, 10);
  assert.equal(t.label, 'day');
});

test('never-opened applications count as slow; fewer than 5 says nothing', () => {
  const slow = [app('1', 'j3', 10, 2), app('2', 'j3', 10, 3), app('3', 'j3', 10, null), app('4', 'j3', 10, null), app('5', 'j3', 10, null)];
  assert.equal(rt.byTeam(slow, byId, NOW).team.label, '');
  const mid = [app('1', 'j3', 10, 30), app('2', 'j3', 10, 40), app('3', 'j3', 10, 50), app('4', 'j3', 10, 60), app('5', 'j3', 10, null)];
  assert.equal(rt.byTeam(mid, byId, NOW).team.label, '3days');
  assert.equal(rt.byTeam([app('1', 'j4', 10, 1)], byId, NOW)['emp-b'], undefined);
});

const day = (offset) => new Date(Date.now() + offset * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const base = { company: 'Nova Foods', location: 'Pune', mode: 'On-site', type: 'Full-time', category: 'Logistics', experience: 'Fresher', salary: '', skills: [], description: 'Work', responsibilities: [], posted: day(-30), status: 'open', alertsSentAt: day(-30) };
const real = Date.now();
const seenApp = (i, jobId) => ({ id: `s${i}`, jobId, name: `P${i}`, email: `p${i}@example.com`, phone: '9876543210', status: 'New', createdAt: new Date(real - 10 * 86400000).toISOString(), viewedAt: new Date(real - 10 * 86400000 + 3 * 3600000).toISOString() });
let srv;
before(async () => {
  srv = await startServer({}, { jobs: [{ ...base, id: 'hr-971', title: 'Packer' }, { ...base, id: 'hr-972', title: 'Helper', employerId: 'emp-x' }], applications: [1, 2, 3, 4, 5].map((i) => seenApp(i, 'hr-971')) });
});
after(() => srv && srv.stop());

test('job page, card tag and API for a team that opens applications fast', async () => {
  assert.match(await (await srv.request('/jobs/hr-971')).text(), /The hiring team usually opens applications within a day/);
  assert.doesNotMatch(await (await srv.request('/jobs/hr-972')).text(), /usually opens applications/);
  assert.match(await (await srv.request('/jobs')).text(), /<span class="tag tag-fast">Replies fast<\/span>/);
  const api = await (await srv.request('/api/jobs')).json();
  assert.equal(api.jobs.find((j) => j.id === 'hr-971').hiringTeamResponds, 'day');
  assert.equal(api.jobs.find((j) => j.id === 'hr-972').hiringTeamResponds, null);
});
