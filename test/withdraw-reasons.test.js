// Step 213: withdrawing offers an optional reason, and the company running the
// job is told, including when an interview it scheduled was cancelled.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, decodeEmail } = require('./helpers');
const { hashPassword } = require('../employers');

const iso = (ago = 0) => new Date(Date.now() - ago * 864e5).toISOString();
const today = iso().slice(0, 10);
const person = (id, email, name) => ({ id, email, name, phone: '9800000001', passwordHash: hashPassword(`${name} long password`), emailVerifiedAt: iso(1), phoneVerifiedAt: iso(1), createdAt: iso(1), active: true, link: null });
const job = (id, extra = {}) => ({ id, employerId: 'emp-a', title: `Job ${id}`, company: 'A Co', location: 'Pune', mode: 'On-site', type: 'Full-time', category: 'Retail', experience: '', skills: [], description: 'Work', responsibilities: [], posted: today, status: 'open', alertsSentAt: today, resume: 'optional', createdBy: 'employer', ...extra });
const app = (id, jobId, extra = {}) => ({ id, jobId, jobTitle: `Job ${jobId}`, name: `Asha ${id}`, email: 'asha@example.in', phone: '9845021301', status: 'Interview', createdAt: iso(2), history: [], ...extra });

let srv;
let me;
let ann;
let ip = 0;
const h = () => ({ 'x-forwarded-for': `10.213.${Math.floor(++ip / 250)}.${(ip % 250) + 1}` });
const get = (url, cookie) => srv.request(url, { cookie, headers: h() });
const post = (url, form, cookie) => srv.request(url, { method: 'POST', form, cookie, headers: h() });
const text = async (url, cookie) => (await get(url, cookie)).text();
const rec = (id) => srv.records('applications').find((a) => a.id === id);
const withdraw = (id, reason) => post(`/account/applications/${id}/withdraw`, reason === undefined ? {} : { reason }, me);

before(async () => {
  srv = await startServer({ TRUST_PROXY: '1' }, {
    employers: [{ id: 'emp-a', company: 'A Co', name: 'A', email: 'o@a.in', active: true, approvedAt: iso(1), createdAt: iso(30) }],
    'employer-users': [person('u-ann', 'ann@aco.in', 'Ann')],
    'employer-members': [{ id: 'm1', employerId: 'emp-a', userId: 'u-ann', role: 'owner', jobIds: [], createdAt: iso(1) }],
    jobs: [job('j1'), job('j2'), job('j3'), job('j4'), { ...job('t1'), employerId: undefined, createdBy: undefined, company: 'Client Co' }],
    applications: [
      app('a1', 'j1', { interviews: [{ id: 'v1', at: iso(-2), duration: 30, mode: 'Phone', status: 'scheduled', feedback: [] }] }),
      app('a2', 'j2'),
      app('a3', 'j3'),
      app('a4', 'j4', { status: 'Hired' }),
      app('a5', 't1'),
    ],
  });
  ann = srv.cookieFrom(await post('/employer/login', { email: 'ann@aco.in', password: 'Ann long password' }));
  const fd = new FormData();
  for (const [k, v] of Object.entries({ name: 'Asha Rao', email: 'asha@example.in', phone: '9845021301', location: 'Pune', agree: '1' })) fd.append(k, v);
  await srv.request('/account/register', { method: 'POST', body: fd, headers: h() });
  const has = (m) => m.includes('To: asha@example.in') && decodeEmail(m).includes('/account/verify/');
  await srv.waitForEmail(has);
  const link = decodeEmail(srv.emails().filter(has).pop()).match(/\/account\/verify\/[a-f0-9]{64}/)[0];
  me = srv.cookieFrom(await post(link, {}));
}, { timeout: 60000 });
after(() => srv && srv.stop());

test('the form offers reasons, says who sees them, and needs none', async () => {
  const page = await text('/account', me);
  assert.match(page, /<option value="another-job">I took another job/);
  assert.match(page, /I'd rather not say|I&#39;d rather not say/);
  assert.match(page, /The hiring team sees your answer/);
  assert.doesNotMatch(page, /<textarea name="reason"/, 'no free text');
});

test('withdrawing with a reason: the company hears it, and that the interview was cancelled', async () => {
  assert.equal((await withdraw('a1', 'another-job')).status, 302);
  const a = rec('a1');
  assert.ok(a.withdrawnAt);
  assert.equal(a.withdrawReason, 'another-job');
  assert.equal(a.interviews[0].status, 'cancelled');
  const mail = decodeEmail(await srv.waitForEmail((m) => m.includes('To: ann@aco.in') && /withdrew from Job j1/.test(decodeEmail(m))));
  assert.match(mail, /The interview you scheduled was cancelled/);
  assert.match(mail, /I took another job/);
  assert.match(await text('/employer/applicants/a1', ann), /Their reason: <b>I took another job/);
  const notes = JSON.parse(await text('/api/notifications', ann)).notifications;
  assert.ok(notes.some((n) => /withdrew from Job j1/.test(n.title)));
  const mine = JSON.parse(await text('/account/my-data.json', me));
  assert.equal(mine.applications.find((x) => x.job === 'Job j1').withdrawReason, 'I took another job');
});

test('no reason, or a made-up one, still withdraws', async () => {
  assert.equal((await withdraw('a2')).status, 302);
  assert.ok(rec('a2').withdrawnAt);
  assert.equal(rec('a2').withdrawReason, undefined);
  const mail = decodeEmail(await srv.waitForEmail((m) => m.includes('To: ann@aco.in') && /withdrew from Job j2/.test(decodeEmail(m))));
  assert.match(mail, /They didn.{1,6}t say/);
  assert.doesNotMatch(mail, /interview/i);
  assert.equal((await withdraw('a3', '<script>nonsense')).status, 302);
  assert.ok(rec('a3').withdrawnAt);
  assert.equal(rec('a3').withdrawReason, undefined);
  assert.doesNotMatch(await text('/employer/applicants/a2', ann), /Their reason/);
});

test('once only, and someone already hired can\'t', async () => {
  const at = rec('a1').withdrawnAt;
  await withdraw('a1', 'pay');
  assert.equal(rec('a1').withdrawnAt, at);
  assert.equal(rec('a1').withdrawReason, 'another-job', 'the first answer stays');
  await withdraw('a4', 'pay');
  assert.equal(rec('a4').withdrawnAt, undefined);
});

test('the company\'s reports count the reasons', async () => {
  const page = await text('/employer/ats/reports', ann);
  assert.match(page, /Why applicants withdrew/);
  assert.match(page, /<td>I took another job<\/td><td data-label="Applicants">1<\/td><td data-label="Share">33%/);
  assert.match(page, /No reason given<\/td><td data-label="Applicants">2<\/td>/);
  assert.match(page, /Out of 3 withdrawn/);
});

test('on a job the team runs, the team inbox hears, with the reason', async () => {
  await withdraw('a5', 'pay');
  assert.equal(rec('a5').withdrawReason, 'pay');
  const mail = decodeEmail(await srv.waitForEmail((m) => /A candidate withdrew their application/.test(decodeEmail(m)) && /Job t1/.test(decodeEmail(m))));
  assert.match(mail, /The pay isn.{1,12}t right for me/);
  const c = await srv.adminLogin();
  assert.match(await text('/admin/applications/a5', c), /Candidate withdrew: The pay isn.{1,12}t right for me/);
  assert.equal(srv.emails().filter((m) => m.includes('To: ann@aco.in') && /Job t1/.test(decodeEmail(m))).length, 0, 'not the company');
});
