// Calls and WhatsApp messages to HR after applying: kept on the application,
// shown to the employer (applicant page, list, dashboard) and in our timeline.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, decodeEmail } = require('./helpers');
const { hashPassword } = require('../employers');
const starter = require('./fixtures/jobs.json');

const EMP = { id: 'emp-old', company: 'Old Co', name: 'Olga Rao', email: 'olga@oldco.in', passwordHash: hashPassword('olga long password'), passwordSetAt: '2026-01-01T00:00:00.000Z', active: true, createdAt: '2026-01-01T00:00:00.000Z' };
const JOB = { ...starter[0], id: 'hr-900', employerId: 'emp-old', createdBy: 'employer', status: 'open', sample: false };
const DESK = { ...starter[1], id: 'hr-901', status: 'open', sample: false };
let srv; let seeker; let employer; let admin;
before(async () => {
  srv = await startServer({}, {
    employers: [EMP], jobs: [JOB, DESK],
    applications: [{ id: 'app-1', jobId: 'hr-900', jobTitle: JOB.title, email: 'asha@example.in', name: 'Asha Rao', phone: '9811100001', createdAt: '2026-11-01T05:00:00.000Z', status: 'New' }, { id: 'app-2', jobId: 'hr-901', jobTitle: DESK.title, email: 'asha@example.in', name: 'Asha Rao', phone: '9811100001', createdAt: '2026-11-01T06:00:00.000Z', status: 'New' }],
  });
  const fd = new FormData();
  for (const [k, v] of Object.entries({ agree: '1', name: 'Asha Rao', email: 'asha@example.in', phone: '9811100001' })) fd.append(k, v);
  await srv.request('/account/register', { method: 'POST', body: fd });
  const seen = srv.emails().length;
  await srv.request('/account/login', { method: 'POST', form: { email: 'asha@example.in' } });
  for (let i = 0; i < 100 && !seeker; i++) {
    await new Promise((r) => setTimeout(r, 50));
    const mail = srv.emails().slice(seen).map(decodeEmail).find((e) => e.includes('/account/verify/'));
    if (mail) seeker = srv.cookieFrom(await srv.request(mail.match(/\/account\/verify\/[A-Za-z0-9_-]+/)[0], { method: 'POST', form: {} }));
  }
  employer = srv.cookieFrom(await srv.request('/employer/login', { method: 'POST', form: { email: 'olga@oldco.in', password: 'olga long password' } }));
  admin = await srv.adminLogin();
});
after(() => srv && srv.stop());
const page = async (p, cookie) => (await srv.request(p, { cookie })).text();
const tap = (jobId, via, cookie) => srv.request(`/api/jobs/${jobId}/hr-contact`, { method: 'POST', cookie, headers: { accept: 'application/json' }, form: { via } });

test('only a signed-in applicant can note a call or message, and only to a job they applied to', async () => {
  assert.equal((await tap('hr-900', 'call')).status, 401);
  assert.equal((await tap('hr-900', 'fax', seeker)).status, 400);
  assert.equal((await tap('hr-902', 'call', seeker)).status, 404, 'not applied to this one');
  const cross = await srv.request('/api/jobs/hr-900/hr-contact', { method: 'POST', cookie: seeker, headers: { origin: 'https://evil.example' }, form: { via: 'call' } });
  assert.equal(cross.status, 403);
});

test('a call and a WhatsApp message are kept on the application, a quick second tap only once', async () => {
  assert.equal((await tap('hr-900', 'call', seeker)).status, 200);
  assert.equal((await tap('hr-900', 'call', seeker)).status, 200);
  assert.equal((await tap('hr-900', 'whatsapp', seeker)).status, 200);
  const a = srv.records('applications').find((x) => x.id === 'app-1');
  assert.deepEqual(a.hrContacts.map((c) => c.via), ['call', 'whatsapp']);
});

test('the employer sees who got in touch: applicant page, applicants list and dashboard', async () => {
  const one = await page('/employer/applicants/app-1', employer);
  assert.match(one, /<b>Asha Rao sent a WhatsApp message to your hiring contact<\/b> on .+ \(2 times in all\)/);
  assert.match(await page('/employer/applicants', employer), /<span class="pill pill-contacted">WhatsApped you<\/span>/);
  const dash = await page('/employer', employer);
  assert.match(dash, /Candidates who called or messaged you/);
  assert.match(dash, /<span class="pill st-interview">Call<\/span><span class="activity-text contact-who"><a href="\/employer\/applicants\/app-1"><b>Asha Rao<\/b><\/a>/);
  assert.match(await page('/admin?tab=applications', admin), /Candidate tapped Call HR/, 'in our timeline too');
});

test('the job page buttons note the tap; the browser sends it without holding up the call', async () => {
  const settings = { tagline: 'Hiring', phone: '+91 98765 43210', whatsapp: '919876543210', email: 'hello@hireriv.com', address: 'Pune', hours: '9-6', jobCategories: 'Technology', jobLocations: 'Pune', billing_feePercent: '8.33', billing_guaranteeDays: '90', billing_gstPercent: '18', billing_paymentDays: '15', billing_tdsPercent: '10', retentionMonths: '0' };
  assert.equal((await srv.request('/admin/settings', { method: 'POST', cookie: admin, form: settings })).status, 302);
  const html = await page(`/jobs/${DESK.id}`, seeker);
  assert.match(html, /href="tel:\+919876543210" data-hr-contact="call" data-job="hr-901"/);
  assert.match(html, /data-hr-contact="whatsapp" data-job="hr-901"/);
  assert.match(await page('/js/main.js'), /navigator\.sendBeacon\(`\/api\/jobs\/\$\{encodeURIComponent\(link\.dataset\.job\)\}\/hr-contact`/);
});
