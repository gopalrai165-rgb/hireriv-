// Long lists are paged on the public jobs page and in admin tables.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const jobs = Array.from({ length: 45 }, (_, i) => ({
  id: `hr-${300 + i}`, title: `Role ${i + 1}`, company: 'Client', location: i % 3 ? 'Pune' : 'Remote', mode: 'On-site', type: 'Full-time', category: 'Technology',
  experience: '1-3 years', salary: '', skills: [], description: 'x', responsibilities: [], posted: day(-i), status: 'open', alertsSentAt: day(-i),
}));
const applications = Array.from({ length: 120 }, (_, i) => ({
  id: `app-${i}`, name: `Candidate ${i}`, email: `c${i}@x.in`, phone: '9876543210', jobId: 'hr-300', jobTitle: 'Role 1', status: i < 60 ? 'New' : 'Screening', createdAt: new Date(Date.now() - i * 60000).toISOString(),
}));

let srv;
let admin;
before(async () => {
  srv = await startServer({}, { jobs, applications });
  admin = await srv.adminLogin();
});
after(() => srv && srv.stop());

const count = (html, re) => (html.match(re) || []).length;

test('job listings show 20 per page with working links', async () => {
  const p1 = await (await srv.request('/jobs')).text();
  assert.equal(count(p1, /<article class="job-card/g), 20);
  assert.match(p1, /<b>45<\/b> jobs found/);
  assert.match(p1, /href="\/jobs\?page=2" rel="next"/);
  assert.match(p1, /<link rel="canonical" href="[^"]+\/jobs">/);

  const p3 = await (await srv.request('/jobs?page=3')).text();
  assert.equal(count(p3, /<article class="job-card/g), 5);
  assert.match(p3, /<link rel="canonical" href="[^"]+\/jobs\?page=3">/);

  // Filters stay in the page links.
  const remote = await (await srv.request('/jobs?location=Remote')).text();
  assert.match(remote, /<b>15<\/b> jobs found/);
  assert.doesNotMatch(remote, /rel="next"/);
});

test('admin applications are paged at 50 and filters carry over', async () => {
  const p1 = await (await srv.request('/admin?tab=applications', { cookie: admin })).text();
  assert.match(p1, /1–50 of 120/);
  assert.equal(count(p1, /name="ids" value="app-/g), 50);
  const p3 = await (await srv.request('/admin?tab=applications&page=3', { cookie: admin })).text();
  assert.match(p3, /101–120 of 120/);

  const screening = await (await srv.request('/admin?tab=applications&status=Screening', { cookie: admin })).text();
  assert.match(screening, /1–50 of 60/);
  assert.match(screening, /href="\/admin\?tab=applications&amp;status=Screening&amp;page=2"/);
});

test('the talent pool counts every candidate, not just the page', async () => {
  const html = await (await srv.request('/admin?tab=talent', { cookie: admin })).text();
  assert.match(html, /<b>120<\/b> candidates/);
  assert.match(html, /1–50 of 120/);
});

test('CSV export still includes every row', async () => {
  await srv.confirm(admin);
  const csv = await (await srv.request('/admin/export/applications.csv', { cookie: admin })).text();
  assert.equal(csv.trim().split('\n').length, 121);
});
