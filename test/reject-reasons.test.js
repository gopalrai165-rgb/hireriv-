// Step 198: why applicants weren't selected. A reason from a fixed list, kept on
// the move to Not selected, counted in Hiring reports, never in the candidate's
// email, and in their data download.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, decodeEmail } = require('./helpers');
const { hashPassword } = require('../employers');
const rr = require('../reject-reasons');

const iso = (ago = 0) => new Date(Date.now() - ago * 864e5).toISOString();
const today = iso().slice(0, 10);
const person = (id, email, name) => ({ id, email, name, phone: '9800000001', passwordHash: hashPassword(`${name} long password`), emailVerifiedAt: iso(1), phoneVerifiedAt: iso(1), createdAt: iso(1), active: true, link: null });
const job = (id, extra = {}) => ({ id, title: `Job ${id}`, company: 'A Co', employerId: 'emp-a', createdBy: 'employer', createdByUser: 'u-ann', location: 'Pune', mode: 'On-site', type: 'Full-time', category: 'Retail', experience: '', skills: [], description: 'Work', responsibilities: [], posted: today, status: 'open', alertsSentAt: today, ...extra });
const app = (id, jobId, name, extra = {}) => ({ id, jobId, jobTitle: `Job ${jobId}`, name, email: `${id}@example.in`, phone: '9811111111', status: 'New', createdAt: iso(2), history: [], ...extra });

let srv;
let owner;
let team;
let ip = 0;
const h = () => ({ 'x-forwarded-for': `10.198.${Math.floor(++ip / 250)}.${(ip % 250) + 1}` });
const get = (url, cookie) => srv.request(url, { cookie, headers: h() });
const post = (url, form, cookie) => srv.request(url, { method: 'POST', form, cookie, headers: h() });
const rec = (id) => srv.records('applications').find((a) => a.id === id);
const lastMove = (id) => rec(id).history.at(-1);

before(async () => {
  srv = await startServer({ TRUST_PROXY: '1' }, {
    employers: [{ id: 'emp-a', company: 'A Co', name: 'A Co', email: 'owner@aco.in', active: true, approvedAt: iso(1), createdAt: iso(30) }],
    'employer-users': [person('u-ann', 'ann@aco.in', 'Ann')],
    'employer-members': [{ id: 'm1', employerId: 'emp-a', userId: 'u-ann', role: 'owner', jobIds: [], createdAt: iso(1) }],
    jobs: [job('hr-1'), { ...job('hr-9'), employerId: '', createdBy: '', company: 'Team client' }],
    applications: [app('a1', 'hr-1', 'Asha'), app('a2', 'hr-1', 'Bala'), app('a3', 'hr-1', 'Chitra'), app('a4', 'hr-1', 'Dev'), app('a5', 'hr-1', 'Esha'),
      app('old', 'hr-1', 'Old', { status: 'Rejected', history: [{ at: iso(200), from: 'New', to: 'Rejected', by: 'Ann', rejectReason: 'pay' }] }),
      app('t1', 'hr-9', 'Tara')],
  });
  owner = srv.cookieFrom(await post('/employer/login', { email: 'ann@aco.in', password: 'Ann long password' }));
  team = await srv.adminLogin();
}, { timeout: 60000 });
after(() => srv && srv.stop());

test('the list, checking a reason, and counting', () => {
  assert.equal(rr.parse('').key, '');
  assert.equal(rr.parse('pay').key, 'pay');
  assert.match(rr.parse('lazy').error, /must be one of/);
  const s = rr.summary([
    { status: 'Rejected', history: [{ to: 'Rejected', at: iso(1), rejectReason: 'pay' }] },
    { status: 'Rejected', history: [{ to: 'Rejected', at: iso(1), rejectReason: 'pay' }] },
    { status: 'Rejected', history: [{ to: 'Rejected', at: iso(1), rejectReason: 'filled' }] },
    { status: 'Rejected', history: [{ to: 'Rejected', at: iso(1) }] },
    { status: 'Rejected', history: [{ to: 'Rejected', at: iso(90), rejectReason: 'skills' }] },
    { status: 'Shortlisted', history: [{ to: 'Rejected', at: iso(1), rejectReason: 'pay' }, { to: 'Shortlisted', at: iso(1) }] },
    { status: 'Rejected', withdrawnAt: iso(1), history: [{ to: 'Rejected', at: iso(1), rejectReason: 'pay' }] },
  ], { since: iso(30) });
  assert.equal(s.total, 4);
  assert.deepEqual(s.rows.map((r) => [r.key, r.count, r.share]), [['pay', 2, 50], ['filled', 1, 25]]);
  assert.equal(s.none, 1);
});

test('an employer picks a reason on the applicant page; it is kept on the move and shown', async () => {
  const page = await (await get('/employer/applicants/a1', owner)).text();
  assert.match(page, /name="rejectReason"/);
  assert.match(page, /Didn’t come to the interview/);
  const before = srv.emails().length;
  const r = await post('/employer/applicants/a1/status', { status: 'Rejected', rejectReason: 'no-show' }, owner);
  assert.equal(r.status, 302);
  assert.equal(rec('a1').status, 'Rejected');
  assert.equal(lastMove('a1').rejectReason, 'no-show');
  assert.match(await (await get('/employer/applicants/a1', owner)).text(), /reason: Didn’t come to the interview/);
  await new Promise((res) => setTimeout(res, 300));
  for (const m of srv.emails().slice(before)) assert.doesNotMatch(m, /no-show|come to the interview/, 'never in the candidate email');
});

test('a reason is optional, only goes with Not selected, and must be from the list', async () => {
  await post('/employer/applicants/a2/status', { status: 'Rejected' }, owner);
  assert.equal(rec('a2').status, 'Rejected');
  assert.equal(lastMove('a2').rejectReason, undefined);
  await post('/employer/applicants/a3/status', { status: 'Screening', rejectReason: 'pay' }, owner);
  assert.equal(lastMove('a3').rejectReason, undefined, 'ignored for other stages');
  const bad = await post('/employer/applicants/a3/status', { status: 'Rejected', rejectReason: 'rude' }, owner);
  assert.match(decodeURIComponent(bad.headers.get('location')), /Not changed: the reason must be one of/);
  assert.equal(rec('a3').status, 'Screening');
});

test('several at once from the list carry the reason', async () => {
  const list = await (await get('/employer/applicants', owner)).text();
  assert.match(list, /Why not selected \(optional\)/);
  await post('/employer/applicants/bulk', [['ids', 'a3'], ['ids', 'a4'], ['status', 'Rejected'], ['rejectReason', 'filled']], owner);
  assert.equal(lastMove('a3').rejectReason, 'filled');
  assert.equal(lastMove('a4').rejectReason, 'filled');
});

test('Hiring reports count the reasons in the period', async () => {
  const html = await (await get('/employer/ats/reports?days=30', owner)).text();
  assert.match(html, /Why applicants weren't selected/);
  assert.match(html, /The position was filled or closed<\/td><td data-label="Applicants">2<\/td><td data-label="Share">50%/);
  assert.match(html, /No reason given<\/td><td data-label="Applicants">1</);
  assert.doesNotMatch(html, /Pay expectations/, 'last year is outside 30 days');
  assert.match(await (await get('/employer/ats/reports', owner)).text(), /Pay expectations didn’t match/);
});

test('the pipeline API takes a reason', async () => {
  const r = await srv.request('/api/ats/applications/a5/stage', { method: 'PATCH', cookie: owner, body: JSON.stringify({ stage: 'Rejected', rejectReason: 'location' }), headers: { ...h(), 'content-type': 'application/json', accept: 'application/json' } });
  assert.equal(r.status, 200);
  assert.equal(lastMove('a5').rejectReason, 'location');
});

test("the candidate's data download includes the reason", async () => {
  const email = 'a5@example.in';
  const fd = new FormData();
  for (const [k, v] of Object.entries({ name: 'Esha', email, phone: '9845012388', location: 'Pune', agree: '1' })) fd.append(k, v);
  await srv.request('/account/register', { method: 'POST', body: fd, headers: h() });
  await srv.waitForEmail((m) => m.includes(`To: ${email}`) && decodeEmail(m).includes('/account/verify/'));
  const mail = decodeEmail(srv.emails().filter((m) => m.includes(`To: ${email}`)).pop());
  const cookie = srv.cookieFrom(await srv.request(mail.match(/\/account\/verify\/[a-f0-9]{64}/)[0], { method: 'POST', form: {}, headers: h() }));
  const data = JSON.parse(await (await get('/account/my-data.json', cookie)).text());
  const mine = data.applications.find((x) => x.job === 'Job hr-1');
  assert.equal(mine.stageChanges.at(-1).reasonRecorded, 'Too far, or can’t travel as the job needs');
});

test('the team picks a reason on the Applications tab; the spreadsheet has it', async () => {
  const html = await (await get('/admin?tab=applications', team)).text();
  assert.match(html, /name="rejectReason" aria-label="Reason if not selected, for Tara"/);
  assert.equal((await post('/admin/applications/t1/status', { status: 'Rejected', rejectReason: 'experience', notes: '' }, team)).status, 302);
  assert.equal(lastMove('t1').rejectReason, 'experience');
  assert.equal((await post('/admin/applications/t1/status', { status: 'Rejected', rejectReason: 'nonsense' }, team)).status, 400);
  await srv.confirm(team);
  const csv = await (await get('/admin/export/applications.csv', team)).text();
  assert.match(csv, /Not enough experience for this job/);
});
