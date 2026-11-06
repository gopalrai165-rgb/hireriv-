// Step 210: the team invites someone who applied to apply for another job the
// team runs. They decide; nothing is applied for them. A job past its closing
// date isn't offered, here or on the employer's page.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, decodeEmail } = require('./helpers');
const { hashPassword } = require('../employers');

const iso = (ago = 0) => new Date(Date.now() - ago * 864e5).toISOString();
const today = iso().slice(0, 10);
const job = (id, extra = {}) => ({ id, title: `Job ${id}`, company: 'Client Co', location: 'Pune', mode: 'On-site', type: 'Full-time', category: 'Retail', experience: '', skills: [], description: 'Work', responsibilities: [], posted: today, status: 'open', alertsSentAt: today, resume: 'optional', ...extra });
const app = (id, jobId, email, extra = {}) => ({ id, jobId, jobTitle: `Job ${jobId}`, name: `Person ${id}`, email, phone: `98450210${id.slice(1).padStart(2, '0')}`, status: 'Rejected', createdAt: iso(2), history: [], ...extra });
const member = (id, name, role) => ({ id, name, email: `${id}@hireriv.test`, role, active: true, passwordHash: hashPassword(`${name} long password`), createdAt: iso(50) });
const own = { employerId: 'emp-a', company: 'A Co', createdBy: 'employer' };

let srv;
let rita;
let fin;
let ann;
let ip = 0;
const h = () => ({ 'x-forwarded-for': `10.210.${Math.floor(++ip / 250)}.${(ip % 250) + 1}` });
const get = (url, cookie) => srv.request(url, { cookie, headers: h() });
const post = (url, form, cookie) => srv.request(url, { method: 'POST', form, cookie, headers: h() });
const said = (r) => decodeURIComponent((r.headers.get('location') || '').replace(/\+/g, ' '));
const page = async (id, cookie = rita) => (await get(`/admin/applications/${id}`, cookie)).text();
const invites = () => srv.records('candidate-invites');
const url = (id) => `/admin/applications/${id}/invite`;

before(async () => {
  srv = await startServer({ TRUST_PROXY: '1' }, {
    team: [member('t-rita', 'Rita', 'Recruiter'), member('t-fin', 'Farah', 'Finance Manager')],
    employers: [{ id: 'emp-a', company: 'A Co', name: 'A Co', email: 'o@aco.in', active: true, approvedAt: iso(1), createdAt: iso(30) }],
    'employer-users': [{ id: 'u-ann', email: 'ann@aco.in', name: 'Ann', phone: '9800000001', passwordHash: hashPassword('Ann long password'), emailVerifiedAt: iso(1), phoneVerifiedAt: iso(1), createdAt: iso(1), active: true, link: null }],
    'employer-members': [{ id: 'm1', employerId: 'emp-a', userId: 'u-ann', role: 'owner', jobIds: [], createdAt: iso(1) }],
    jobs: [job('j1'), job('j2', { company: 'Other Client' }), job('j3', { status: 'closed' }), job('j4', { closesOn: '2020-01-01' }), job('j5'), job('e1', own), job('e2', own), job('e3', { ...own, closesOn: '2020-01-01' })],
    applications: [
      app('a1', 'j1', 'asha@example.in'),
      app('a2', 'j5', 'asha@example.in', { status: 'New' }),
      app('a3', 'j1', ''),
      app('a4', 'j1', 'gone@example.in', { withdrawnAt: iso(1) }),
      app('a5', 'e1', 'own@example.in'),
      app('a6', 'general', 'general@example.in', { jobTitle: 'General application' }),
    ],
  });
  const login = async (id, name) => srv.cookieFrom(await post('/admin/login', { login: `${id}@hireriv.test`, password: `${name} long password` }));
  rita = await login('t-rita', 'Rita');
  fin = await login('t-fin', 'Farah');
  ann = srv.cookieFrom(await post('/employer/login', { email: 'ann@aco.in', password: 'Ann long password' }));
}, { timeout: 60000 });
after(() => srv && srv.stop());

test('the page offers open jobs the team runs that they have not applied for', async () => {
  const p = await page('a1');
  assert.match(p, /Another job for them\?/);
  assert.match(p, /action="\/admin\/applications\/a1\/invite"/);
  assert.match(p, /<option value="j2">/);
  assert.doesNotMatch(p, /<option value="(j1|j3|j4|j5|e1|e2)">/, 'not this job, closed or past its date, already applied for, or a company\'s own');
  assert.doesNotMatch(await page('a1', fin), /Another job for them\?/, 'not for roles that do not write to candidates');
  assert.doesNotMatch(await page('a4'), /Another job for them\?/, 'not after they withdrew');
  assert.doesNotMatch(await page('a5'), /Another job for them\?/, 'not on a job a company runs');
  assert.match(await page('a6'), /Another job for them\?/, 'people who sent a general resume can be invited');
});

test('inviting: recorded as the team\'s, and the email comes from the team', async () => {
  const r = await post(url('a1'), { jobId: 'j2' }, rita);
  assert.equal(r.status, 303);
  assert.match(said(r), /Invitation sent for Job j2\. Person decides whether to apply/);
  const mine = invites().filter((i) => i.applicationId === 'a1');
  assert.equal(mine.length, 1);
  assert.equal(mine[0].byTeam, true);
  assert.equal(mine[0].employerId, undefined);
  assert.equal(mine[0].email, 'asha@example.in');
  assert.match(said(await post(url('a1'), { jobId: 'j2' }, rita)), /Already invited to apply for Job j2/);
  assert.equal(invites().filter((i) => i.applicationId === 'a1').length, 1);
  assert.match(await page('a1'), /Invited<\/span><span class="activity-text">Job j2/);
  const mail = decodeEmail(await srv.waitForEmail((m) => m.includes('To: asha@example.in') && /Invitation to apply/.test(decodeEmail(m))));
  assert.match(mail, /A job you may suit/);
  assert.match(mail, /Hireriv team thinks you may suit this job at Other Client/);
  assert.match(mail, /stays as it is/);
  assert.match(mail, /never pay/i);
  assert.doesNotMatch(mail, /another of their jobs/);
  assert.equal(srv.records('applications').filter((a) => a.jobId === 'j2').length, 0, 'nothing is applied for them');
});

test('what is refused', async () => {
  const n = invites().length;
  for (const id of ['j1', 'j3', 'j4', 'e2', 'zz']) assert.match(said(await post(url('a2'), { jobId: id }, rita)), /pick an open job the team runs/, id);
  assert.match(said(await post(url('a3'), { jobId: 'j2' }, rita)), /no email address/);
  assert.match(said(await post(url('a4'), { jobId: 'j2' }, rita)), /withdrew/);
  assert.match(said(await post(url('a5'), { jobId: 'j2' }, rita)), /runs its own hiring/);
  assert.equal((await post(url('a1'), { jobId: 'j5' }, fin)).status, 403);
  assert.equal((await post(url('nope'), { jobId: 'j2' }, rita)).status, 404);
  assert.equal((await srv.request(url('a6'), { method: 'POST', form: { jobId: 'j2' }, cookie: rita, headers: { ...h(), origin: 'https://evil.example' } })).status, 403);
  assert.notEqual((await post(url('a6'), { jobId: 'j2' })).status, 303);
  assert.equal(invites().length, n);
});

test('team invitations stay out of a company\'s list and its daily count', async () => {
  const p = await (await get('/employer/invitations', ann)).text();
  assert.match(p, /<b>0<\/b> invitations/);
  assert.match(p, /30 left today/);
});

test('an employer is not offered a job past its closing date either', async () => {
  const p = await (await get('/employer/applicants/a5', ann)).text();
  assert.match(p, /<option value="e2">/);
  assert.doesNotMatch(p, /<option value="e3">/);
  assert.match(said(await post('/employer/applicants/a5/invite', { jobId: 'e3' }, ann)), /pick one of your open jobs/);
});
