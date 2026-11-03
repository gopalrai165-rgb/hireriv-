// Admin, Hire requests: the numbers, the status steps, the filters, the time
// to the first call, and "Email me this week's summary".
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, decodeEmail } = require('./helpers');
const stats = require('../enquiry-stats');

const now = Date.now();
const ago = (h) => new Date(now - h * 3600000).toISOString();
const seed = { 'hire-requests': [
  { id: 'e1', createdAt: ago(60), company: 'Alpha Foods', name: 'Anil', email: 'anil@alpha.example', phone: '9810000001', roles: 'Packers', location: 'Pune', followUp: 'New', source: 'linkedin', fromPage: 'Employers page' },
  { id: 'e2', createdAt: ago(30), company: 'Beta Logistics', name: 'Bina', email: 'bina@beta.example', phone: '9810000002', roles: 'Drivers', followUp: 'Contacted', contactedAt: ago(26), source: 'google' },
  { id: 'e3', createdAt: ago(10), company: 'Gamma Tech', name: 'Gita', email: 'gita@gamma.example', phone: '9810000003', roles: 'Java developers', followUp: 'Closed', contactedAt: ago(8) },
  { id: 'e4', createdAt: ago(24 * 200), company: 'Old Co', name: 'Om', email: 'om@old.example', phone: '9810000004', roles: 'Cooks', followUp: 'Candidates shared' },
] };

let srv;
let admin;
before(async () => {
  srv = await startServer({}, seed);
  admin = await srv.adminLogin();
});
after(() => srv && srv.stop());
const page = async (q) => (await srv.request(`/admin?tab=hire-requests${q || ''}`, { cookie: admin })).text();

test('the numbers: new, waiting, received, median time to first call and the status steps', async () => {
  const html = await page('&period=90');
  assert.match(html, /<span class="kpi-label">New<\/span><span class="kpi-value">1<\/span>/);
  assert.match(html, /<span class="kpi-label">Received<\/span><span class="kpi-value">3<\/span><span class="kpi-note">last 90 days/, 'the 200-day-old one is outside the period');
  assert.match(html, /<span class="kpi-label">Median time to first call<\/span><span class="kpi-value">3 hours<\/span><span class="kpi-note">100% within 24 hours/);
  for (const [s, n] of [['New', 1], ['Contacted', 1], ['Closed', 1], ['Candidates shared', 1], ['Requirement received', 0]]) assert.match(html, new RegExp(`<b>${n}</b><span>${s}</span>`), s);
  assert.match(html, /<b>1<\/b> · LinkedIn/);
  assert.match(html, /<b>1<\/b> · Employers page/);
  assert.match(html, /table class="hire-requests cards-on-phone"/);
  assert.match(html, /href="https:\/\/wa\.me\/919810000001"/, 'WhatsApp the contact in one tap');
  assert.match(html, /First contact after 4 hours/);
});

test('filters: status, search by words or phone, period, waiting for a call', async () => {
  let html = await page('&status=Contacted');
  assert.match(html, /Beta Logistics/);
  assert.doesNotMatch(html, /Alpha Foods/);
  html = await page('&q=java');
  assert.match(html, /Gamma Tech/);
  assert.doesNotMatch(html, /Beta Logistics/);
  html = await page('&q=98100-00002');
  assert.match(html, /Beta Logistics/);
  html = await page('&period=90');
  assert.doesNotMatch(html, /<b>Old Co<\/b>/);
  assert.match(await page(), /<b>Old Co<\/b>/, 'all time by default, so old open enquiries are never hidden');
  html = await page('&waiting=1');
  assert.match(html, /<b>Alpha Foods<\/b>/);
  assert.doesNotMatch(html, /<b>Beta Logistics<\/b>/);
  html = await page('&q=nobody-like-this');
  assert.match(html, /No enquiries match these filters/);
  html = await page('&status=Bogus&period=999');
  assert.match(html, /Received<\/span><span class="kpi-value">4<\/span><span class="kpi-note">all time/, 'unknown values fall back to the defaults');
});

test('the first move out of New records the first contact; "No owner yet" and "Mine" filter by owner', async () => {
  const res = await srv.request('/admin/hire-requests/e1/follow-up', { method: 'POST', cookie: admin, form: { followUp: 'Contacted', ownerId: '' } });
  assert.equal(res.status, 302);
  const first = srv.records('hire-requests').find((h) => h.id === 'e1').contactedAt;
  assert.ok(first, 'contactedAt is set');
  await srv.request('/admin/hire-requests/e1/follow-up', { method: 'POST', cookie: admin, form: { followUp: 'Requirement received' } });
  assert.equal(srv.records('hire-requests').find((h) => h.id === 'e1').contactedAt, first, 'only the first move counts');
  assert.match(await page('&owner=none'), /<b>Alpha Foods<\/b>/);
  assert.match(await page('&owner=me'), /No enquiries match these filters/);
});

test('"Email me this week\'s summary" sends the summary to the signed-in member', async () => {
  assert.match(await page(), /action="\/admin\/hire-requests\/summary"/);
  await srv.request('/admin/team', { method: 'POST', cookie: admin, form: { name: 'Rahul Das', email: 'rahul@hireriv.test', role: 'Recruiter' } });
  const link = decodeEmail(await srv.waitForEmail((e) => e.includes('rahul@hireriv.test'))).match(/\/admin\/setup\/[a-f0-9]{64}/)[0];
  const rahul = srv.cookieFrom(await srv.request(link, { method: 'POST', form: { password: 'rahul-long-password', confirm: 'rahul-long-password' } }));
  const res = await srv.request('/admin/hire-requests/summary', { method: 'POST', cookie: rahul });
  assert.equal(res.status, 302);
  assert.match(decodeURIComponent(res.headers.get('location')), /The summary is on its way to rahul@hireriv\.test/);
  const mail = await srv.waitForEmail((m) => m.includes('Your weekly enquiry summary') && m.includes('rahul@hireriv.test'));
  assert.ok(mail, 'the summary email is sent');
  assert.match(decodeEmail(mail), /Where they came from/);
});

test('the numbers module: periods, tallies, hours and filters', () => {
  const s = stats.summarise(seed['hire-requests'], { isOverdue: () => false, period: 'all', now });
  assert.equal(s.received, 4);
  assert.deepEqual(s.sources[0], ['Not tracked', 2]);
  assert.equal(stats.formatHours(0.2), '12 min');
  assert.equal(stats.formatHours(1), '1 hour');
  assert.equal(stats.formatHours(72), '3 days');
  assert.deepEqual(stats.parseFilters({ owner: 'x', period: '30', waiting: '1' }, ['y']), { q: '', status: '', owner: '', period: '30', waiting: true });
});
