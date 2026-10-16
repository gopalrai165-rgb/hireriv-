// Job closing dates: expired jobs close themselves, and old undated jobs are flagged.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, resumeForm } = require('./helpers');

const day = (offset) => new Date(Date.now() + offset * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const base = { company: 'Client', location: 'Pune', mode: 'On-site', type: 'Full-time', category: 'Technology', experience: '1-3 years', salary: '', skills: ['Go'], description: 'Build things', responsibilities: [] };
const seedJobs = [
  { ...base, id: 'hr-201', title: 'Expired Role', posted: day(-20), status: 'open', closesOn: day(-1), alertsSentAt: day(-20) },
  { ...base, id: 'hr-202', title: 'Last Day Role', posted: day(-10), status: 'open', closesOn: day(0), alertsSentAt: day(-10) },
  { ...base, id: 'hr-203', title: 'Stale Role', posted: day(-75), status: 'open', alertsSentAt: day(-75) },
];

let app;
let admin;
before(async () => {
  app = await startServer({}, { jobs: seedJobs });
  admin = await app.adminLogin();
});
after(() => app && app.stop());

const job = (id) => app.records('jobs').find((j) => j.id === id);

test('a job past its closing date closes itself and stops taking applications', async () => {
  assert.equal(job('hr-201').status, 'closed');
  assert.equal(job('hr-201').closedReason, 'Closing date passed');
  const listing = await (await app.request('/jobs')).text();
  assert.ok(!listing.includes('Expired Role'));
  const fd = resumeForm({ jobId: 'hr-201', name: 'A B', email: 'ab@example.in', phone: '9876543210' });
  const res = await app.request('/api/apply', { method: 'POST', body: fd, headers: { accept: 'application/json' } });
  assert.equal(res.status, 400);
});

test('the closing date itself is still open, with a last-day label', async () => {
  assert.equal(job('hr-202').status, 'open');
  const listing = await (await app.request('/jobs')).text();
  assert.match(listing, /Last day today/);
  assert.match(await (await app.request('/jobs/hr-202')).text(), /Apply by/);
});

test('admin flags jobs open 60+ days with no closing date', async () => {
  const html = await (await app.request('/admin?tab=jobs', { cookie: admin })).text();
  assert.match(html, /Open 75 days/);
  const dash = await (await app.request('/admin', { cookie: admin })).text();
  assert.match(dash, /1 open 60\+ days/);
});

test('a closing date in the past is refused for an open job', async () => {
  const res = await app.request('/admin/jobs/hr-203', { method: 'POST', cookie: admin, form: { ...base, title: 'Stale Role', skills: 'Go', responsibilities: '', status: 'open', closesOn: day(-3) } });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /closing date is in the past/);
});

test('setting a closing date clears the stale flag', async () => {
  const res = await app.request('/admin/jobs/hr-203', { method: 'POST', cookie: admin, form: { ...base, title: 'Stale Role', skills: 'Go', responsibilities: '', status: 'open', closesOn: day(14) } });
  assert.equal(res.status, 302);
  assert.equal(job('hr-203').closesOn, day(14));
  assert.doesNotMatch(await (await app.request('/admin?tab=jobs', { cookie: admin })).text(), /Open 75 days/);
});

test('reopening an expired job removes its past closing date', async () => {
  const res = await app.request('/admin/jobs/hr-201/toggle', { method: 'POST', cookie: admin, form: {} });
  assert.match(decodeURIComponent(res.headers.get('location')), /removed its past closing date/);
  assert.equal(job('hr-201').status, 'open');
  assert.equal(job('hr-201').closesOn, null);
  assert.equal(job('hr-201').closedReason, undefined);
});
