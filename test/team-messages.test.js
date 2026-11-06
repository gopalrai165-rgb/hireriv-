// Step 201: the team's page for one application, with messages on the jobs the
// team runs. Companies that run their own hiring keep writing from the portal.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, decodeEmail } = require('./helpers');
const { hashPassword } = require('../employers');

const iso = (ago = 0) => new Date(Date.now() - ago * 864e5).toISOString();
const today = iso().slice(0, 10);
const EMAIL = 'ravi@example.in';
const job = (id, extra = {}) => ({ id, title: `Job ${id}`, company: 'Client Co', location: 'Pune', mode: 'On-site', type: 'Full-time', category: 'Retail', experience: '', skills: [], description: 'Work', responsibilities: [], posted: today, status: 'open', alertsSentAt: today, resume: 'optional', ...extra });
const app = (id, jobId, extra = {}) => ({ id, jobId, jobTitle: `Job ${jobId}`, name: 'Ravi Kumar', email: EMAIL, phone: '9845012399', status: 'New', createdAt: iso(2), history: [], ...extra });
const member = (id, name, role) => ({ id, name, email: `${id}@hireriv.test`, role, active: true, passwordHash: hashPassword(`${name} long password`), createdAt: iso(50) });

let srv;
let admin;
let rita;
let fin;
let ip = 0;
const h = () => ({ 'x-forwarded-for': `10.201.${Math.floor(++ip / 250)}.${(ip % 250) + 1}` });
const get = (url, cookie) => srv.request(url, { cookie, headers: h() });
const post = (url, form, cookie) => srv.request(url, { method: 'POST', form, cookie, headers: h() });
const rec = (id) => srv.records('applications').find((a) => a.id === id);
const said = (r) => decodeURIComponent(r.headers.get('location') || '');
const login = async (id, name) => srv.cookieFrom(await post('/admin/login', { login: `${id}@hireriv.test`, password: `${name} long password` }));

before(async () => {
  srv = await startServer({ TRUST_PROXY: '1' }, {
    team: [member('t-rita', 'Rita', 'Recruiter'), member('t-fin', 'Farah', 'Finance Manager'), member('t-sup', 'Sam', 'Support Agent')],
    employers: [{ id: 'emp-a', company: 'A Co', name: 'A Co', email: 'o@aco.in', active: true, approvedAt: iso(1), createdAt: iso(30) }],
    jobs: [job('hr-1', { ownerId: 't-rita' }), job('hr-2', { employerId: 'emp-a', company: 'A Co', createdBy: 'employer' })],
    applications: [app('a1', 'hr-1'), app('a2', 'hr-2'), app('a3', 'hr-1', { email: '', phone: '9845012300', name: 'No Email' }), app('a4', 'hr-1', { withdrawnAt: iso(1), email: 'w@example.in' })],
  });
  admin = await srv.adminLogin();
  rita = await login('t-rita', 'Rita');
  fin = await login('t-fin', 'Farah');
}, { timeout: 60000 });
after(() => srv && srv.stop());

test('the Applications tab links to the page; it shows the candidate and timeline', async () => {
  assert.match(await (await get('/admin?tab=applications', admin)).text(), /href="\/admin\/applications\/a1"/);
  const page = await (await get('/admin/applications/a1', rita)).text();
  assert.match(page, /<h1>Ravi Kumar<\/h1>/);
  assert.match(page, /9845012399/);
  assert.match(page, /Applied for Job hr-1/);
  assert.match(page, /Write to Ravi/);
  assert.equal((await get('/admin/applications/nope', admin)).status, 404);
  assert.notEqual((await get('/admin/applications/a1')).status, 200, 'signed-in team only');
});

test('a recruiter writes; the candidate is emailed without the words and replies; the recruiter is told', async () => {
  const r = await post('/admin/applications/a1/messages', { text: 'Hi Ravi, the client would like to meet you on Friday.' }, rita);
  assert.match(said(r), /Message sent to Ravi/);
  const m = rec('a1').messages[0];
  assert.deepEqual([m.from, m.by, m.userId], ['team', 'Rita, Hireriv', 't-rita']);
  assert.ok(srv.records('activity').some((e) => e.action === 'Sent a message to a candidate' && !/Friday/.test(e.detail)));
  const mail = decodeEmail(await srv.waitForEmail((e) => e.includes(`To: ${EMAIL}`) && /New message about your application/.test(decodeEmail(e))));
  assert.doesNotMatch(mail, /Friday/);

  const fd = new FormData();
  for (const [k, v] of Object.entries({ name: 'Ravi Kumar', email: EMAIL, phone: '9845012399', location: 'Pune', agree: '1' })) fd.append(k, v);
  await srv.request('/account/register', { method: 'POST', body: fd, headers: h() });
  await srv.waitForEmail((e) => e.includes(`To: ${EMAIL}`) && decodeEmail(e).includes('/account/verify/'));
  const verify = decodeEmail(srv.emails().filter((e) => e.includes(`To: ${EMAIL}`) && decodeEmail(e).includes('/account/verify/')).pop());
  const ravi = srv.cookieFrom(await srv.request(verify.match(/\/account\/verify\/[a-f0-9]{64}/)[0], { method: 'POST', form: {}, headers: h() }));
  const thread = await (await get('/account/messages/a1', ravi)).text();
  assert.match(thread, /Rita, Hireriv/);
  assert.match(thread, /meet you on Friday/);
  assert.equal((await post('/account/messages/a1', { text: 'Friday works for me.' }, ravi)).status, 303);

  const note = srv.records('notifications').find((n) => n.type === 'candidate-replied' && n.link === '/admin/applications/a1#messages');
  assert.ok(note, 'Rita is told in the app');
  await srv.waitForEmail((e) => e.includes('To: t-rita@hireriv.test') && /replied about Job hr-1/.test(decodeEmail(e)));
  assert.match(await (await get('/admin?tab=applications', admin)).text(), /1 new message/);
  assert.match(await (await get('/admin/applications/a1', rita)).text(), /Friday works for me/);
  assert.ok(rec('a1').messages[1].readAt);
});

test('jobs a company runs itself stay with the company', async () => {
  const page = await (await get('/admin/applications/a2', admin)).text();
  assert.match(page, /runs its own hiring for this job/);
  assert.doesNotMatch(page, /Write to Ravi/);
  assert.match(said(await post('/admin/applications/a2/messages', { text: 'Hi' }, admin)), /runs its own hiring/);
  assert.equal(rec('a2').messages, undefined);
});

test('roles, money, missing email and withdrawn applications', async () => {
  const fromFin = await post('/admin/applications/a1/messages', { text: 'Hello' }, fin);
  assert.notEqual(fromFin.status, 303);
  assert.match(said(await post('/admin/applications/a1/messages', { text: 'Please pay the training fee first' }, rita)), /can’t ask candidates to pay/);
  assert.match(said(await post('/admin/applications/a3/messages', { text: 'Hello' }, rita)), /no email address/);
  assert.match(await (await get('/admin/applications/a3', rita)).text(), /Call them instead/);
  assert.match(said(await post('/admin/applications/a4/messages', { text: 'Hello' }, rita)), /withdrew/);
  assert.equal((await srv.request('/admin/applications/a1/messages', { method: 'POST', form: { text: 'x' }, cookie: rita, headers: { ...h(), origin: 'https://evil.example' } })).status, 403);
  assert.equal(rec('a1').messages.length, 2);
});

test('words are escaped on the team page', async () => {
  await post('/admin/applications/a1/messages', { text: '<script>alert(1)</script>' }, rita);
  assert.doesNotMatch(await (await get('/admin/applications/a1', rita)).text(), /<script>alert\(1\)/);
});
