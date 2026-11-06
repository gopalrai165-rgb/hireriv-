// Step 208: invitations to apply are listed in the candidate's account, with
// View & apply and Not for me. Putting one aside doesn't tell the company.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, decodeEmail } = require('./helpers');

const iso = (ago = 0) => new Date(Date.now() - ago * 864e5).toISOString();
const today = iso().slice(0, 10);
const job = (id, extra = {}) => ({ id, employerId: 'emp-a', title: `Job ${id}`, company: 'A Co', location: 'Pune', mode: 'On-site', type: 'Full-time', category: 'Retail', experience: '', skills: [], description: 'Work', responsibilities: [], posted: today, status: 'open', alertsSentAt: today, resume: 'optional', createdBy: 'employer', ...extra });
const invite = (id, jobId, extra) => ({ id, employerId: 'emp-a', jobId, invitedBy: 'u-ann', createdAt: iso(1), ...extra });

let srv;
let me;
let other;
let ip = 0;
const h = () => ({ 'x-forwarded-for': `10.208.${Math.floor(++ip / 250)}.${(ip % 250) + 1}` });
const get = (url, cookie) => srv.request(url, { cookie, headers: h() });
const post = (url, form, cookie) => srv.request(url, { method: 'POST', form, cookie, headers: h() });
const text = async (url, cookie) => (await get(url, cookie)).text();
const said = (r) => decodeURIComponent((r.headers.get('location') || '').replace(/\+/g, ' '));

async function register(name, email, phone) {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ name, email, phone, location: 'Pune', agree: '1' })) fd.append(k, v);
  await srv.request('/account/register', { method: 'POST', body: fd, headers: h() });
  const has = (m) => m.includes(`To: ${email}`) && decodeEmail(m).includes('/account/verify/');
  await srv.waitForEmail(has);
  const link = decodeEmail(srv.emails().filter(has).pop()).match(/\/account\/verify\/[a-f0-9]{64}/)[0];
  return srv.cookieFrom(await post(link, {}));
}

before(async () => {
  srv = await startServer({ TRUST_PROXY: '1' }, {
    employers: [{ id: 'emp-a', company: 'A Co', name: 'A', email: 'o@a.in', active: true, approvedAt: iso(1), createdAt: iso(30) }],
    jobs: [job('j1'), job('j2'), job('j3'), job('j4', { status: 'closed' }), job('j5')],
    applications: [
      { id: 'a1', jobId: 'j1', jobTitle: 'Job j1', name: 'Asha Rao', email: 'asha@example.in', phone: '9845018001', status: 'Rejected', createdAt: iso(3), history: [] },
      { id: 'a5', jobId: 'j5', jobTitle: 'Job j5', name: 'Asha Rao', email: 'asha@example.in', phone: '9845018001', status: 'New', createdAt: iso(1), history: [] },
    ],
    'candidate-invites': [
      invite('i2', 'j2', { applicationId: 'a1', email: 'asha@example.in', fromJobId: 'j1' }),
      invite('i2b', 'j2', { applicationId: 'a1', email: 'asha@example.in', fromJobId: 'j1', createdAt: iso(2) }),
      invite('i3', 'j3', { applicationId: 'a1', email: 'asha@example.in', fromJobId: 'j1' }),
      invite('i4', 'j4', { applicationId: 'a1', email: 'asha@example.in', fromJobId: 'j1' }),
      invite('i5', 'j5', { applicationId: 'a1', email: 'asha@example.in', fromJobId: 'j1' }),
      invite('ix', 'j2', { applicationId: 'zz', email: 'someone@example.in', fromJobId: 'j1' }),
    ],
  });
  me = await register('Asha Rao', 'asha@example.in', '9845018001');
  other = await register('Ravi Kumar', 'ravi@example.in', '9845018002');
}, { timeout: 60000 });
after(() => srv && srv.stop());

test('open invitations are listed once per job, with why and how to apply', async () => {
  const page = await text('/account', me);
  assert.match(page, /Invitations to apply/);
  assert.match(page, /It's your choice, and always free/);
  const block = page.slice(page.indexOf('id="invitations"'), page.indexOf('id="jobs-for-you"'));
  assert.equal((block.match(/<b>Job j2<\/b>/g) || []).length, 1, 'two invitations for one job show once');
  assert.match(block, /<b>Job j3<\/b>/);
  assert.doesNotMatch(block, /Job j4<\/b>|Job j5<\/b>/, 'not closed jobs or jobs they applied for');
  assert.match(block, /After your application for Job j1/);
  assert.match(block, /utm_source=invite#apply/);
  assert.doesNotMatch(await text('/account', other), /id="invitations"/, 'nobody else\'s invitations');
});

test('Not for me puts it aside without telling the company, and only for its owner', async () => {
  assert.match(said(await post('/account/invitations/ix/dismiss', {}, me)), /no longer there/);
  assert.match(said(await post('/account/invitations/i3/dismiss', {}, other)), /no longer there/);
  assert.equal(srv.records('candidate-invites').find((i) => i.id === 'i3').dismissedAt, undefined);
  const notices = srv.emails().length;
  const r = await post('/account/invitations/i2/dismiss', {}, me);
  assert.match(said(r), /put aside\. The company is not told/);
  const list = srv.records('candidate-invites');
  assert.ok(list.find((i) => i.id === 'i2').dismissedAt);
  assert.ok(list.find((i) => i.id === 'i2b').dismissedAt, 'every invitation for that job');
  assert.equal(list.find((i) => i.id === 'ix').dismissedAt, undefined);
  assert.equal(srv.emails().length, notices);
  const page = await text('/account', me);
  assert.doesNotMatch(page, /<b>Job j2<\/b>/);
  assert.match(page, /<b>Job j3<\/b>/);
  const data = JSON.parse(await text('/account/my-data.json', me));
  assert.ok(data.invitationsFromEmployers.find((i) => i.job === 'Job j2' && i.putAsideAt));
});

test('forms from elsewhere and signed-out visitors are refused', async () => {
  const r = await srv.request('/account/invitations/i3/dismiss', { method: 'POST', form: {}, cookie: me, headers: { ...h(), origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
  assert.notEqual((await post('/account/invitations/i3/dismiss', {})).headers.get('location') || '', '/account?msg=Invitation');
  assert.equal(srv.records('candidate-invites').find((i) => i.id === 'i3').dismissedAt, undefined);
});
