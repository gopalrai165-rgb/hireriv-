// Step 199: messages between the hiring team and applicants. The hiring side
// writes first, only people allowed to contact applicants take part, no money
// requests, emails never carry the words, and messages stay with the application.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, decodeEmail } = require('./helpers');
const { hashPassword } = require('../employers');

const iso = (ago = 0) => new Date(Date.now() - ago * 864e5).toISOString();
const today = iso().slice(0, 10);
const person = (id, email, name) => ({ id, email, name, phone: '9800000001', passwordHash: hashPassword(`${name} long password`), emailVerifiedAt: iso(1), phoneVerifiedAt: iso(1), createdAt: iso(1), active: true, link: null });
const member = (id, employerId, userId, role) => ({ id, employerId, userId, role, jobIds: [], createdAt: iso(1) });
const job = (id, employerId) => ({ id, title: `Rider ${id}`, company: employerId === 'emp-a' ? 'A Co' : 'B Co', employerId, createdBy: 'employer', createdByUser: employerId === 'emp-a' ? 'u-ann' : 'u-bob', location: 'Pune', mode: 'On-site', type: 'Full-time', category: 'Retail', experience: '', skills: [], description: 'Work', responsibilities: [], posted: today, status: 'open', alertsSentAt: today, resume: 'optional' });
const EMAIL = 'ravi@example.in';
const app = (id, jobId, extra = {}) => ({ id, jobId, jobTitle: `Rider ${jobId}`, name: 'Ravi Kumar', email: EMAIL, phone: '9845012399', status: 'New', createdAt: iso(2), history: [], ...extra });

let srv;
let ann;
let vic;
let bob;
let ravi;
let ip = 0;
const h = () => ({ 'x-forwarded-for': `10.199.${Math.floor(++ip / 250)}.${(ip % 250) + 1}` });
const get = (url, cookie) => srv.request(url, { cookie, headers: h() });
const post = (url, form, cookie) => srv.request(url, { method: 'POST', form, cookie, headers: h() });
const rec = (id) => srv.records('applications').find((a) => a.id === id);
const said = (r) => decodeURIComponent(r.headers.get('location') || '');

before(async () => {
  srv = await startServer({ TRUST_PROXY: '1' }, {
    employers: [{ id: 'emp-a', company: 'A Co', name: 'A Co', email: 'o@aco.in', active: true, approvedAt: iso(1), createdAt: iso(30) }, { id: 'emp-b', company: 'B Co', name: 'B Co', email: 'o@bco.in', active: true, approvedAt: iso(1), createdAt: iso(30) }],
    'employer-users': [person('u-ann', 'ann@aco.in', 'Ann'), person('u-vic', 'vic@aco.in', 'Vic'), person('u-bob', 'bob@bco.in', 'Bob')],
    'employer-members': [member('m1', 'emp-a', 'u-ann', 'owner'), member('m2', 'emp-a', 'u-vic', 'viewer'), member('m3', 'emp-b', 'u-bob', 'owner')],
    jobs: [job('hr-1', 'emp-a'), job('hr-2', 'emp-a'), job('hr-3', 'emp-b')],
    applications: [app('a1', 'hr-1'), app('a2', 'hr-2', { withdrawnAt: iso(1) }), app('a3', 'hr-3')],
  });
  const login = async (email, name) => srv.cookieFrom(await post('/employer/login', { email, password: `${name} long password` }));
  ann = await login('ann@aco.in', 'Ann');
  vic = await login('vic@aco.in', 'Vic');
  bob = await login('bob@bco.in', 'Bob');
  const fd = new FormData();
  for (const [k, v] of Object.entries({ name: 'Ravi Kumar', email: EMAIL, phone: '9845012399', location: 'Pune', agree: '1' })) fd.append(k, v);
  await srv.request('/account/register', { method: 'POST', body: fd, headers: h() });
  await srv.waitForEmail((m) => m.includes(`To: ${EMAIL}`) && decodeEmail(m).includes('/account/verify/'));
  const mail = decodeEmail(srv.emails().filter((m) => m.includes(`To: ${EMAIL}`)).pop());
  ravi = srv.cookieFrom(await srv.request(mail.match(/\/account\/verify\/[a-f0-9]{64}/)[0], { method: 'POST', form: {}, headers: h() }));
}, { timeout: 60000 });
after(() => srv && srv.stop());

test('a job seeker can not start a conversation; the page says what to expect', async () => {
  const page = await (await get('/account/messages', ravi)).text();
  assert.match(page, /No messages yet/);
  assert.equal((await get('/account/messages/a1', ravi)).status, 404, 'nothing until the hiring side writes');
  assert.equal((await post('/account/messages/a1', { text: 'Hello?' }, ravi)).status, 404);
  assert.equal(rec('a1').messages, undefined);
});

test('the employer writes; the email says only that there is a message', async () => {
  const before = srv.emails().length;
  const r = await post('/employer/applicants/a1/messages', { text: 'Hi Ravi, can you come to the depot on Monday at 10?' }, ann);
  assert.equal(r.status, 303);
  assert.match(said(r), /Message sent to Ravi/);
  const m = rec('a1').messages[0];
  assert.deepEqual([m.from, m.by, m.userId, m.readAt], ['employer', 'Ann, A Co', 'u-ann', null]);
  const mail = decodeEmail(await srv.waitForEmail((e) => e.includes(`To: ${EMAIL}`) && /New message about your application/.test(decodeEmail(e))));
  assert.match(mail, /\/account\/messages\/a1/);
  assert.doesNotMatch(mail, /depot on Monday/, 'the words stay on the site');
  assert.ok(srv.emails().length > before);
  assert.ok(srv.records('employer-audit').some((e) => e.event === 'message-sent' && !/depot/.test(e.detail || '')));
  assert.match(await (await get('/employer/applicants/a1', ann)).text(), /depot on Monday/);
});

test('money, codes and passwords are refused; empty and withdrawn too', async () => {
  for (const text of ['Please pay a registration fee of 500', 'Send the OTP you got', 'Pay the security deposit first']) {
    assert.match(said(await post('/employer/applicants/a1/messages', { text }, ann)), /Not sent/, text);
  }
  assert.match(said(await post('/employer/applicants/a1/messages', { text: '   ' }, ann)), /write a message first/);
  assert.match(said(await post('/employer/applicants/a2/messages', { text: 'Hello' }, ann)), /withdrew/);
  assert.equal(rec('a1').messages.length, 1);
});

test('only people who may contact applicants, and only for their company', async () => {
  const seen = await (await get('/employer/applicants/a1', vic)).text();
  assert.doesNotMatch(seen, /depot on Monday/, 'a viewer does not see messages');
  assert.equal((await post('/employer/applicants/a1/messages', { text: 'Hi' }, vic)).status, 403);
  assert.equal((await post('/employer/applicants/a1/messages', { text: 'Hi' }, bob)).status, 404, 'another company: not found');
  assert.equal((await srv.request('/employer/applicants/a1/messages', { method: 'POST', form: { text: 'Hi' }, cookie: ann, headers: { ...h(), origin: 'https://evil.example' } })).status, 403);
});

test('the job seeker reads, sees the warning, and replies; the employer is told', async () => {
  const dash = await (await get('/account', ravi)).text();
  assert.match(dash, /1 new message/);
  const list = await (await get('/account/messages', ravi)).text();
  assert.match(list, /A Co · Rider hr-1/);
  const page = await (await get('/account/messages/a1', ravi)).text();
  assert.match(page, /depot on Monday/);
  assert.match(page, /Real employers never ask you to pay/);
  assert.match(page, /href="\/jobs\/[^"]+#report"/);
  assert.ok(rec('a1').messages[0].readAt, 'read once opened');
  assert.equal((await get('/account/messages/a3', ravi)).status, 404, 'no thread there yet');

  const r = await post('/account/messages/a1', { text: 'Yes, I will be there.' }, ravi);
  assert.equal(r.status, 303);
  assert.equal(rec('a1').messages[1].from, 'candidate');
  const note = srv.records('notifications').find((n) => n.type === 'candidate-replied');
  assert.ok(note && note.link === '/employer/applicants/a1#messages');
  const listed = await (await get('/employer/applicants', ann)).text();
  assert.match(listed, /1 new message/);
  const opened = await (await get('/employer/applicants/a1', ann)).text();
  assert.match(opened, /Yes, I will be there/);
  assert.ok(rec('a1').messages[1].readAt);
  assert.doesNotMatch(await (await get('/employer/applicants', ann)).text(), /new message/);
});

test('someone else can not read or reply to the thread', async () => {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ name: 'Mallory', email: 'mal@example.in', phone: '9845012311', location: 'Pune', agree: '1' })) fd.append(k, v);
  await srv.request('/account/register', { method: 'POST', body: fd, headers: h() });
  await srv.waitForEmail((m) => m.includes('To: mal@example.in') && decodeEmail(m).includes('/account/verify/'));
  const mail = decodeEmail(srv.emails().filter((m) => m.includes('To: mal@example.in')).pop());
  const mal = srv.cookieFrom(await srv.request(mail.match(/\/account\/verify\/[a-f0-9]{64}/)[0], { method: 'POST', form: {}, headers: h() }));
  assert.equal((await get('/account/messages/a1', mal)).status, 404);
  assert.equal((await post('/account/messages/a1', { text: 'hi' }, mal)).status, 404);
});

test('words are escaped; messages are in the data download', async () => {
  await post('/employer/applicants/a1/messages', { text: '<script>alert(1)</script> <b>bold</b>' }, ann);
  for (const [url, c] of [['/account/messages/a1', ravi], ['/employer/applicants/a1', ann], ['/account/messages', ravi]]) {
    assert.doesNotMatch(await (await get(url, c)).text(), /<script>alert\(1\)|<b>bold/, url);
  }
  const data = JSON.parse(await (await get('/account/my-data.json', ravi)).text());
  const mine = data.applications.find((x) => x.job === 'Rider hr-1');
  assert.deepEqual(mine.messages.slice(0, 2).map((m) => [m.from, m.text]), [['Ann, A Co', 'Hi Ravi, can you come to the depot on Monday at 10?'], ['You', 'Yes, I will be there.']]);
});
