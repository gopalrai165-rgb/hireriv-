// Refer a friend: a signed-in job seeker's links carry a code; a friend who
// opens one and applies is noted on the application, on the referrer's
// account, for the employer and in our timeline. Never for yourself.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, decodeEmail } = require('./helpers');
const { hashPassword } = require('../employers');
const starter = require('./fixtures/jobs.json');

const EMP = { id: 'emp-old', company: 'Old Co', name: 'Olga Rao', email: 'olga@oldco.in', passwordHash: hashPassword('olga long password'), passwordSetAt: '2026-01-01T00:00:00.000Z', active: true, createdAt: '2026-01-01T00:00:00.000Z' };
const JOB = { ...starter[0], id: 'hr-900', employerId: 'emp-old', createdBy: 'employer', status: 'open', sample: false, resume: 'optional' };
let srv; let seeker; let employer; let admin; let code;
before(async () => {
  srv = await startServer({}, { employers: [EMP], jobs: [JOB] });
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
const apply = (cookie, name, email, phone) => srv.request('/api/apply', { method: 'POST', cookie, headers: { accept: 'application/json' }, form: { jobId: 'hr-900', name, email, phone } });

test('a signed-in job seeker gets a referral link and a WhatsApp button on the job page', async () => {
  const html = await page('/jobs/hr-900', seeker);
  const m = html.match(/\?utm_source=referral&amp;ref=([a-z0-9]{8})/);
  assert.ok(m, 'referral link shown');
  code = m[1];
  assert.match(html, /Know someone for this job\?/);
  assert.match(html, /Refer a friend on WhatsApp/);
  assert.match(html, new RegExp(`data-share-url="[^"]+\\?utm_source=share&amp;ref=${code}"`), 'share buttons carry it too');
  assert.equal((await page('/jobs/hr-900', seeker)).match(/ref=([a-z0-9]{8})/)[1], code, 'the same code every time');
  assert.doesNotMatch(await page('/jobs/hr-900'), /Know someone for this job\?/, 'not for visitors who are signed out');
});

test('a friend who opens the link and applies is noted as referred', async () => {
  const visit = await srv.request(`/jobs/hr-900?ref=${code}`);
  const friend = srv.cookieFrom(visit);
  assert.match(friend, new RegExp(`hr_ref=${code}`));
  const res = await apply(friend, 'Ravi Kumar', 'ravi@example.in', '9822200002');
  assert.equal(res.status, 200, await res.clone().text());
  const a = srv.records('applications').find((x) => x.email === 'ravi@example.in');
  assert.equal(a.referredBy.email, 'asha@example.in');
  assert.equal(a.referredBy.name, 'Asha Rao');
});

test('your own link never refers yourself, and a bad code is ignored', async () => {
  const own = await srv.request(`/jobs/hr-900?ref=${code}`, { cookie: seeker });
  assert.doesNotMatch(String(own.headers.get('set-cookie') || ''), /hr_ref=/);
  await apply(`hr_ref=${code}`, 'Asha Rao', 'asha2@example.in', '9811100001');
  assert.equal(srv.records('applications').find((x) => x.email === 'asha2@example.in').referredBy, undefined, 'same phone as the referrer');
  const bad = await srv.request('/jobs/hr-900?ref=<script>');
  assert.doesNotMatch(String(bad.headers.get('set-cookie') || ''), /hr_ref=/);
  await apply('hr_ref=zzzzzzzz', 'Meena Shah', 'meena@example.in', '9833300003');
  assert.equal(srv.records('applications').find((x) => x.email === 'meena@example.in').referredBy, undefined);
});

test('the referrer, the employer and our team see the referral', async () => {
  const acct = await page('/account', seeker);
  assert.match(acct, /Friends you referred/);
  assert.match(acct, /1 friend has applied through your links/);
  assert.match(acct, /<b>Ravi<\/b> applied for /);
  assert.doesNotMatch(acct, /Kumar|ravi@example\.in|9822200002/, 'only the first name');
  const id = srv.records('applications').find((x) => x.email === 'ravi@example.in').id;
  assert.match(await page(`/employer/applicants/${id}`, employer), /Referred by <b>Asha Rao<\/b>/);
  assert.match(await page('/employer/applicants', employer), /<span class="pill pill-referred" title="Referred by Asha Rao">Referred<\/span>/);
  assert.match(await page('/admin?tab=applications', admin), /Referred by Asha Rao, who shared the job link/);
});
