// Step 181: analytics numbers compared with the period of the same length just
// before the chosen one: counts and money in per cent, rates in points and
// times in days, with lower times counting as better; balances today have no
// previous value. Shown on the dashboard and in the CSV export.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');
const { previousRange, changeOf } = require('../analytics');

const DAY = 86400000;
const iso = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString();
const ymd = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const JOB = { id: 'job-cmp', title: 'Warehouse picker', company: 'Compare Co', location: 'Pune', mode: 'On-site', type: 'Full-time', category: 'Logistics', experience: '', posted: ymd(80), approvedAt: iso(80), skills: [], description: 'A job.', responsibilities: [], status: 'open', closesOn: null, sample: false };
const app = (id, daysAgo) => ({ id, jobId: JOB.id, jobTitle: JOB.title, name: `Candidate ${id}`, email: `${id}@example.in`, phone: '9800000000', status: 'New', createdAt: iso(daysAgo), history: [], interviews: [] });

let srv;
let admin;
before(async () => {
  // 3 applications in the last 30 days, 2 in the 30 before.
  srv = await startServer({}, { jobs: [JOB], applications: [app('a1', 2), app('a2', 5), app('a3', 20), app('b1', 35), app('b2', 50), app('c1', 90)] });
  admin = await srv.adminLogin();
}, { timeout: 30000 });
after(() => srv && srv.stop());

test('the previous range has the same length and ends the day before', () => {
  assert.deepEqual(previousRange({ from: '2026-10-08', to: '2026-11-06' }), { from: '2026-09-08', to: '2026-10-07' });
  assert.deepEqual(previousRange({ from: '2026-11-06', to: '2026-11-06' }), { from: '2026-11-05', to: '2026-11-05' });
  assert.deepEqual(previousRange({ from: '2026-03-01', to: '2026-03-07' }), { from: '2026-02-22', to: '2026-02-28' });
});

test('changes: per cent for counts, points for rates, days for times (lower is better)', () => {
  assert.deepEqual(changeOf({ id: 'applications', value: 3 }, 2), { previous: 2, by: 50, kind: 'percent', better: 'better', from0: false });
  assert.equal(changeOf({ id: 'applications', value: 2 }, 2).better, 'same');
  assert.equal(changeOf({ id: 'applications', value: 4 }, 0).from0, true);
  assert.deepEqual(changeOf({ id: 'interviewRate', value: 40, unit: '%' }, 25), { previous: 25, by: 15, kind: 'points', better: 'better' });
  assert.deepEqual(changeOf({ id: 'timeToHire', value: 12, unit: 'days' }, 15), { previous: 15, by: -3, kind: 'days', better: 'better' });
  assert.equal(changeOf({ id: 'timeToFill', value: 20, unit: 'days' }, 10).better, 'worse');
  assert.equal(changeOf({ id: 'outstandingInvoices', value: 500, unit: 'paise' }, 100), null);
  assert.equal(changeOf({ id: 'interviewRate', value: null, unit: '%' }, 20), null);
  assert.equal(changeOf({ id: 'applications', value: 3 }, undefined), null);
  assert.equal(changeOf({ id: 'placements', value: 0 }, 0), null);
});

test('the dashboard and the API show the change against the previous 30 days', async () => {
  const html = await (await srv.request('/admin/analytics', { cookie: admin })).text();
  assert.match(html, /Changes are against the .+ period of the same length\./);
  assert.match(html, /<span class="kpi-change kpi-better"><span aria-hidden="true">▲<\/span> Up 50% <span class="muted">\(was 2\)<\/span><\/span>/);
  const api = await (await srv.request('/api/analytics/overview', { cookie: admin, headers: { accept: 'application/json' } })).json();
  const body = api.data || api;
  const apps = body.kpis.find((k) => k.id === 'applications');
  assert.equal(apps.value, 3);
  assert.deepEqual(apps.change, { previous: 2, by: 50, kind: 'percent', better: 'better', from0: false });
  assert.equal(body.previous.to, ymd(30));
  const csv = await (await srv.request('/api/analytics/reports/overview/export', { cookie: admin })).text();
  assert.match(csv.split('\n')[0], /previousValue,previousFrom,previousTo/);
});
