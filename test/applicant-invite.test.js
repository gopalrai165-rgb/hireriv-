// Step 207: from an applicant's page, an employer invites the person to apply
// for another of the company's open jobs. The person is told and decides;
// nothing is applied for them.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, decodeEmail } = require('./helpers');
const { hashPassword } = require('../employers');

const iso = (ago = 0) => new Date(Date.now() - ago * 864e5).toISOString();
const today = iso().slice(0, 10);
const person = (id, email, name) => ({ id, email, name, phone: '9800000001', passwordHash: hashPassword(`${name} long password`), emailVerifiedAt: iso(1), phoneVerifiedAt: iso(1), createdAt: iso(1), active: true, link: null });
const company = (id, name) => ({ id, company: name, name, email: `o@${id}.in`, active: true, approvedAt: iso(1), createdAt: iso(30) });
const member = (id, employerId, userId, role, jobIds = []) => ({ id, employerId, userId, role, jobIds, createdAt: iso(1) });
const job = (id, employerId, extra = {}) => ({ id, employerId, title: `Job ${id}`, company: employerId === 'emp-a' ? 'A Co' : 'B Co', location: 'Pune', mode: 'On-site', type: 'Full-time', category: 'Retail', experience: '', skills: [], description: 'Work', responsibilities: [], posted: today, status: 'open', alertsSentAt: today, resume: 'optional', createdBy: 'employer', ...extra });
const application = (id, jobId, name, email, phone, extra = {}) => ({ id, jobId, jobTitle: `Job ${jobId}`, name, email, phone, status: 'Rejected', createdAt: iso(2), history: [], ...extra });

let srv;
let ann;
let vic;
let bob;
let ip = 0;
const h = () => ({ 'x-forwarded-for': `10.207.${Math.floor(++ip / 250)}.${(ip % 250) + 1}` });
const get = (url, cookie) => srv.request(url, { cookie, headers: h() });
const post = (url, form, cookie) => srv.request(url, { method: 'POST', form, cookie, headers: h() });
const text = async (url, cookie) => (await get(url, cookie)).text();
const said = (r) => decodeURIComponent((r.headers.get('location') || '').replace(/\+/g, ' '));
const invites = () => srv.records('candidate-invites');

before(async () => {
  srv = await startServer({ TRUST_PROXY: '1' }, {
    employers: [company('emp-a', 'A Co'), company('emp-b', 'B Co')],
    'employer-users': [person('u-ann', 'ann@aco.in', 'Ann'), person('u-vic', 'vic@aco.in', 'Vic'), person('u-bob', 'bob@bco.in', 'Bob')],
    'employer-members': [member('m1', 'emp-a', 'u-ann', 'owner'), member('m3', 'emp-a', 'u-vic', 'viewer'), member('m4', 'emp-b', 'u-bob', 'owner')],
    jobs: [job('j1', 'emp-a'), job('j2', 'emp-a'), job('j3', 'emp-a'), job('j4', 'emp-a', { status: 'closed' }), job('j9', 'emp-b')],
    applications: [
      application('a1', 'j1', 'Asha Rao', 'asha@example.in', '9845017001'),
      application('a2', 'j3', 'Asha Rao', 'asha@example.in', '9845017001', { status: 'New' }),
      application('a3', 'j1', 'No Mail', '', '9845017003'),
      application('a4', 'j1', 'Gone Away', 'gone@example.in', '9845017004', { withdrawnAt: iso(1) }),
    ],
  });
  const login = async (email, name) => srv.cookieFrom(await post('/employer/login', { email, password: `${name} long password` }));
  ann = await login('ann@aco.in', 'Ann');
  vic = await login('vic@aco.in', 'Vic');
  bob = await login('bob@bco.in', 'Bob');
}, { timeout: 60000 });
after(() => srv && srv.stop());

test('the applicant page offers the company\'s other open jobs they haven\'t applied for', async () => {
  const page = await text('/employer/applicants/a1', ann);
  assert.match(page, /Another job for them\?/);
  assert.match(page, /action="\/employer\/applicants\/a1\/invite"/);
  assert.match(page, /<option value="j2">/);
  assert.doesNotMatch(page, /<option value="j1">|<option value="j3">|<option value="j4">|<option value="j9">/, 'not this job, one they applied for, a closed job or another company\'s');
  assert.doesNotMatch(await text('/employer/applicants/a1', vic), /Another job for them\?/, 'viewers can\'t contact applicants');
  assert.doesNotMatch(await text('/employer/applicants/a4', ann), /Another job for them\?/, 'not after they withdrew');
});

test('inviting: recorded once, logged without the name, and the person is told it is their choice', async () => {
  const r = await post('/employer/applicants/a1/invite', { jobId: 'j2' }, ann);
  assert.equal(r.status, 303);
  assert.match(said(r), /Invitation sent for Job j2\. Asha decides whether to apply/);
  const mine = invites().filter((i) => i.applicationId === 'a1');
  assert.equal(mine.length, 1);
  assert.equal(mine[0].jobId, 'j2');
  assert.equal(mine[0].email, 'asha@example.in');
  assert.equal(mine[0].fromJobId, 'j1');
  assert.match(said(await post('/employer/applicants/a1/invite', { jobId: 'j2' }, ann)), /already invited them to apply for Job j2/);
  assert.equal(invites().filter((i) => i.applicationId === 'a1').length, 1);
  const log = srv.records('employer-audit').find((e) => e.event === 'applicant-invited');
  assert.equal(log.detail, 'Job j1 to Job j2');
  const page = await text('/employer/applicants/a1', ann);
  assert.match(page, /Invited<\/span><span class="activity-text">Job j2/);
  assert.doesNotMatch(page, /<option value="j2">/);
  const mail = decodeEmail(await srv.waitForEmail((m) => m.includes('To: asha@example.in') && /Invitation to apply/.test(decodeEmail(m))));
  assert.match(mail, /A Co would like you to apply/);
  assert.match(mail, /stays as it is/);
  assert.match(mail, /never pay/i);
  assert.equal(srv.records('applications').filter((a) => a.jobId === 'j2').length, 0, 'nothing is applied for them');
});

test('what is refused', async () => {
  const n = invites().length;
  assert.match(said(await post('/employer/applicants/a1/invite', { jobId: 'j3' }, ann)), /pick one of your open jobs they haven't applied for/);
  assert.match(said(await post('/employer/applicants/a1/invite', { jobId: 'j4' }, ann)), /pick one of your open jobs/);
  assert.match(said(await post('/employer/applicants/a1/invite', { jobId: 'j9' }, ann)), /pick one of your open jobs/);
  assert.match(said(await post('/employer/applicants/a3/invite', { jobId: 'j2' }, ann)), /no email address/);
  assert.match(said(await post('/employer/applicants/a4/invite', { jobId: 'j2' }, ann)), /withdrew/);
  assert.equal((await post('/employer/applicants/a1/invite', { jobId: 'j3' }, vic)).status, 403);
  assert.equal((await post('/employer/applicants/a1/invite', { jobId: 'j9' }, bob)).status, 404);
  assert.equal((await srv.request('/employer/applicants/a1/invite', { method: 'POST', form: { jobId: 'j3' }, cookie: ann, headers: { ...h(), origin: 'https://evil.example' } })).status, 403);
  assert.equal(invites().length, n);
});

test('without an email the page offers job links to send another way', async () => {
  const page = await text('/employer/applicants/a3', ann);
  assert.match(page, /no email address for them/);
  assert.match(page, /href="\/jobs\/[^"]*j2[^"]*"|href="\/jobs\/[^"]+">Job j2/);
});

test('they see it in their account and in their data download', async () => {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ name: 'Asha Rao', email: 'asha@example.in', phone: '9845017001', location: 'Pune', agree: '1' })) fd.append(k, v);
  await srv.request('/account/register', { method: 'POST', body: fd, headers: h() });
  const has = (m) => m.includes('To: asha@example.in') && decodeEmail(m).includes('/account/verify/');
  await srv.waitForEmail(has);
  const link = decodeEmail(srv.emails().filter(has).pop()).match(/\/account\/verify\/[a-f0-9]{64}/)[0];
  const me = srv.cookieFrom(await post(link, {}));
  const notes = JSON.parse(await text('/api/notifications?category=jobs', me)).notifications;
  assert.ok(notes.some((n) => n.title === 'A Co invites you to apply: Job j2'));
  const mine = JSON.parse(await text('/account/my-data.json', me));
  assert.deepEqual(mine.invitationsFromEmployers.map((i) => i.job), ['Job j2']);
});
