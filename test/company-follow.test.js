// Following a company: a button on the company page, a saved search for
// that company's new jobs (emailed as soon as one goes live), stopping, and
// the employer's count of followers.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, decodeEmail } = require('./helpers');
const { hashPassword } = require('../employers');
const starter = require('./fixtures/jobs.json');

const EMP = { id: 'emp-old', company: 'Old Co', name: 'Olga Rao', email: 'olga@oldco.in', passwordHash: hashPassword('olga long password'), passwordSetAt: '2026-01-01T00:00:00.000Z', active: true, createdAt: '2026-01-01T00:00:00.000Z' };
const JOB = { ...starter[0], id: 'hr-900', company: 'Old Co', employerId: 'emp-old', createdBy: 'employer', status: 'open', sample: false };
let srv; let seeker; let employer; let admin;
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
const follow = (cookie, form = {}) => srv.request('/companies/emp-old/follow', { method: 'POST', cookie, form });

test('signed out, the button leads to sign-in and back', async () => {
  const html = await page('/companies/emp-old');
  assert.match(html, /Follow Old Co<\/button>/);
  assert.match(html, /Sign in to get an email as soon as this company posts a new job/);
  const res = await follow();
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/account/login?next=%2Fcompanies%2Femp-old');
  const cross = await srv.request('/companies/emp-old/follow', { method: 'POST', cookie: seeker, headers: { origin: 'https://evil.example' }, form: {} });
  assert.equal(cross.status, 403);
  assert.equal((await follow(seeker, {}).then(() => srv.request('/companies/nobody/follow', { method: 'POST', cookie: seeker, form: {} }))).status, 404);
});

test('following saves an instant search for the company, once; the page and the employer show it', async () => {
  const res = await follow(seeker);
  assert.equal(res.headers.get('location'), '/companies/emp-old?msg=followed#follow');
  await follow(seeker);
  const mine = srv.records('job-alerts').filter((s) => s.email === 'asha@example.in');
  assert.equal(mine.length, 1, 'following twice keeps one');
  assert.deepEqual(mine[0].filters, { company: 'Old Co' });
  assert.equal(mine[0].frequency, 'instant');
  assert.equal(mine[0].name, 'Jobs at Old Co');
  const html = await page('/companies/emp-old?msg=followed', seeker);
  assert.match(html, /aria-pressed="true"><svg class="i" aria-hidden="true"><use href="#i-check"\/><\/svg> Following<\/button>/);
  assert.match(html, /You follow this company/);
  assert.match(await page('/employer', employer), /<b>1 job seeker<\/b> follows your company/);
  assert.match(await page('/account/saved-searches', seeker), /Jobs at Old Co/);
});

test('a new job from the company is emailed to followers; other companies\' jobs are not', async () => {
  const base = { mode: 'On-site', type: 'Full-time', category: 'Technology', experience: '', salary: '', description: 'Work with us.', skills: '', responsibilities: 'Do the work', location: 'Pune' };
  await srv.request('/admin/jobs', { method: 'POST', cookie: admin, form: { ...base, title: 'Other Firm Clerk', company: 'Other Firm' } });
  await srv.request('/admin/jobs', { method: 'POST', cookie: admin, form: { ...base, title: 'Old Co Packer', company: 'Old Co' } });
  await srv.waitForEmail((m) => m.includes('To: asha@example.in') && m.includes('Old Co Packer'));
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(srv.emails().filter((m) => m.includes('To: asha@example.in') && m.includes('Other Firm Clerk')).length, 0);
});

test('stopping removes the search', async () => {
  const res = await follow(seeker, { action: 'unfollow' });
  assert.equal(res.headers.get('location'), '/companies/emp-old?msg=unfollowed#follow');
  assert.equal(srv.records('job-alerts').filter((s) => s.email === 'asha@example.in').length, 0);
  assert.match(await page('/companies/emp-old', seeker), /Follow Old Co<\/button>/);
  assert.doesNotMatch(await page('/employer', employer), /follows your company/);
});
