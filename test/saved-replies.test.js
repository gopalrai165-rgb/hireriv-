// Step 204: saved replies. Each hiring team keeps words it sends often and picks
// one when writing to an applicant. A person still reads it and presses Send.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');
const { hashPassword } = require('../employers');
const { fill, parse } = require('../message-templates');

const iso = (ago = 0) => new Date(Date.now() - ago * 864e5).toISOString();
const today = iso().slice(0, 10);
const person = (id, email, name) => ({ id, email, name, phone: '9800000001', passwordHash: hashPassword(`${name} long password`), emailVerifiedAt: iso(1), phoneVerifiedAt: iso(1), createdAt: iso(1), active: true, link: null });
const company = (id, name) => ({ id, company: name, name, email: `o@${id}.in`, active: true, approvedAt: iso(1), createdAt: iso(30) });
const member = (id, employerId, userId, role) => ({ id, employerId, userId, role, jobIds: [], createdAt: iso(1) });
const job = (id, extra = {}) => ({ id, title: `Job ${id}`, company: 'Secret Client', location: 'Pune', mode: 'On-site', type: 'Full-time', category: 'Retail', experience: '', skills: [], description: 'Work', responsibilities: [], posted: today, status: 'open', alertsSentAt: today, resume: 'optional', ...extra });
const app = (id, jobId, extra = {}) => ({ id, jobId, jobTitle: `Job ${jobId}`, name: 'Ravi Kumar', email: `${id}@example.in`, phone: `98450120${id.slice(1).padStart(2, '0')}`, status: 'New', createdAt: iso(2), history: [], ...extra });
const teamMember = (id, name, role) => ({ id, name, email: `${id}@hireriv.test`, role, active: true, passwordHash: hashPassword(`${name} long password`), createdAt: iso(50) });

let srv;
let ann;
let rob;
let vic;
let bob;
let admin;
let rita;
let fin;
let ip = 0;
const h = () => ({ 'x-forwarded-for': `10.204.${Math.floor(++ip / 250)}.${(ip % 250) + 1}` });
const get = (url, cookie) => srv.request(url, { cookie, headers: h() });
const post = (url, form, cookie) => srv.request(url, { method: 'POST', form, cookie, headers: h() });
const text = async (url, cookie) => (await get(url, cookie)).text();
const said = (r) => decodeURIComponent((r.headers.get('location') || '').replace(/\+/g, ' '));
const saved = () => srv.records('message-templates');
const box = (html) => (html.match(/<textarea id="msg-text"[^>]*>([^<]*)<\/textarea>/) || [])[1];
const EMP = '/employer/message-templates';
const TEAM = '/admin/message-templates';

before(async () => {
  srv = await startServer({ TRUST_PROXY: '1' }, {
    employers: [company('emp-a', 'A Co'), company('emp-b', 'B Co')],
    'employer-users': [person('u-ann', 'ann@aco.in', 'Ann'), person('u-rob', 'rob@aco.in', 'Rob'), person('u-vic', 'vic@aco.in', 'Vic'), person('u-bob', 'bob@bco.in', 'Bob')],
    'employer-members': [member('m1', 'emp-a', 'u-ann', 'owner'), { ...member('m2', 'emp-a', 'u-rob', 'recruiter'), jobIds: ['j1'] }, member('m3', 'emp-a', 'u-vic', 'viewer'), member('m4', 'emp-b', 'u-bob', 'owner')],
    team: [teamMember('t-rita', 'Rita', 'Recruiter'), teamMember('t-fin', 'Farah', 'Finance Manager')],
    jobs: [job('j1', { employerId: 'emp-a', company: 'A Co', createdBy: 'employer' }), job('j2')],
    applications: [app('a1', 'j1'), app('a2', 'j2'), app('a3', 'j1', { withdrawnAt: iso(1) })],
  });
  const login = async (email, name) => srv.cookieFrom(await post('/employer/login', { email, password: `${name} long password` }));
  ann = await login('ann@aco.in', 'Ann');
  rob = await login('rob@aco.in', 'Rob');
  vic = await login('vic@aco.in', 'Vic');
  bob = await login('bob@bco.in', 'Bob');
  admin = await srv.adminLogin();
  const teamLogin = async (id, name) => srv.cookieFrom(await post('/admin/login', { login: `${id}@hireriv.test`, password: `${name} long password` }));
  rita = await teamLogin('t-rita', 'Rita');
  fin = await teamLogin('t-fin', 'Farah');
}, { timeout: 60000 });
after(() => srv && srv.stop());

test('filling in: first name, job and company; unknown words are refused', () => {
  assert.equal(fill('Hi {name}, about {job} at {company}. {name}!', { name: 'Ravi Kumar', job: 'Packer', company: 'A Co' }), 'Hi Ravi, about Packer at A Co. Ravi!');
  assert.match(parse({ name: 'x', text: 'Hi {firstname}' }, []).error, /\{firstname\}/);
  assert.match(parse({ name: 'x', text: 'Please pay the registration fee' }, []).error, /pay/);
  assert.match(parse({ name: 'x', text: 'Send me the OTP you got' }, []).error, /code/);
  assert.match(parse({ name: 'Same', text: 'Hello' }, [{ name: 'same' }]).error, /already/);
  assert.match(parse({ name: '', text: 'Hello' }, []).error, /name/);
});

test('a recruiter saves a reply and the company shares it', async () => {
  assert.match(await text(EMP, rob), /No saved replies yet/);
  assert.match(await text('/employer/applicants/a1', rob), /Save replies you send often/);
  const r = await post(EMP, { name: 'Invite', text: 'Hi {name}, about {job} at {company}: can we talk?' }, rob);
  assert.equal(r.status, 303);
  assert.match(said(r), /Saved/);
  assert.equal(saved().length, 1);
  assert.equal(saved()[0].owner, 'employer:emp-a');
  assert.match(await text(EMP, ann), /value="Invite"/);
  assert.ok(srv.records('employer-audit').some((e) => e.event === 'saved-reply-added' && e.detail === 'Invite'));
});

test('picking a reply fills the box for that person and sends nothing', async () => {
  const page = await text('/employer/applicants/a1', ann);
  assert.match(page, /Manage saved replies/);
  const id = saved()[0].id;
  assert.match(page, new RegExp(`href="/employer/applicants/a1\\?use=${id}#messages"`));
  assert.equal(box(page), '', 'empty until picked');
  const filled = await text(`/employer/applicants/a1?use=${id}`, ann);
  assert.match(box(filled), /^Hi Ravi, about Job j1 at A Co: can we talk\?/);
  assert.equal((srv.records('applications').find((a) => a.id === 'a1').messages || []).length, 0, 'not sent');
  assert.equal(box(await text('/employer/applicants/a1?use=nope', ann)), '', 'an unknown one is ignored');
  assert.doesNotMatch(await text('/employer/applicants/a3', ann), /Manage saved replies/, 'none for someone who withdrew');
});

test('words are escaped in the box and on the page', async () => {
  await post(EMP, { name: '<b>Bold</b>', text: '</textarea><script>alert(1)</script>' }, ann);
  const t = saved().find((x) => x.name === '<b>Bold</b>');
  assert.doesNotMatch(await text(EMP, ann), /<script>alert\(1\)/);
  assert.doesNotMatch(await text(`/employer/applicants/a1?use=${t.id}`, ann), /<script>alert\(1\)|<b>Bold/);
  await post(`${EMP}/${t.id}/delete`, {}, ann);
});

test('other companies and roles', async () => {
  const id = saved()[0].id;
  assert.doesNotMatch(await text(EMP, bob), /value="Invite"/);
  assert.match(said(await post(`${EMP}/${id}/delete`, {}, bob)), /no longer here/);
  assert.match(said(await post(`${EMP}/${id}`, { name: 'Taken', text: 'Mine now' }, bob)), /no longer here/);
  assert.equal(saved()[0].name, 'Invite');
  assert.equal((await get(EMP, vic)).status, 403);
  assert.equal((await post(EMP, { name: 'V', text: 'Hello' }, vic)).status, 403);
  assert.equal((await srv.request(EMP, { method: 'POST', form: { name: 'E', text: 'Hello' }, cookie: ann, headers: { ...h(), origin: 'https://evil.example' } })).status, 403);
  assert.notEqual((await get(EMP)).status, 200);
  assert.equal(saved().length, 1);
});

test('changing and deleting; money words are refused when saving and sending', async () => {
  const id = saved()[0].id;
  assert.match(said(await post(EMP, { name: 'Fee', text: 'Please pay the training fee' }, ann)), /Not saved: .*pay/);
  assert.match(said(await post(`${EMP}/${id}`, { name: 'Invite', text: 'Please pay the training fee' }, ann)), /Not saved/);
  assert.match(saved()[0].text, /can we talk/);
  assert.match(said(await post(`${EMP}/${id}`, { name: 'Invite again', text: 'Hi {name}' }, ann)), /Saved/);
  assert.equal(saved()[0].name, 'Invite again');
  assert.equal(saved()[0].text, 'Hi {name}');
  assert.match(said(await post(`${EMP}/${id}/delete`, {}, ann)), /Deleted/);
  assert.equal(saved().length, 0);
});

test('the team has its own list, and {company} is never the client', async () => {
  assert.equal((await post(TEAM, { name: 'Team hello', text: 'Hi {name}, {company} here about {job}.' }, rita)).status, 303);
  const t = saved().find((x) => x.owner === 'team');
  assert.ok(t);
  assert.ok(srv.records('activity').some((e) => e.action === 'Added a saved reply' && e.detail === 'Team hello'));
  assert.match(await text(TEAM, admin), /Team hello/);
  assert.doesNotMatch(await text(EMP, ann), /Team hello/);
  const page = await text(`/admin/applications/a2?use=${t.id}`, rita);
  assert.match(box(page), /^Hi Ravi, Hireriv here about Job j2\./);
  assert.doesNotMatch(box(page), /Secret Client/);
  assert.match(page, /Manage saved replies/);
  assert.equal((await get(TEAM, fin)).status, 403);
  assert.equal((await post(TEAM, { name: 'F', text: 'Hello' }, fin)).status, 403);
  assert.notEqual((await get(TEAM)).status, 200);
  assert.doesNotMatch(await text(`/employer/applicants/a1?use=${t.id}`, ann), /Hireriv here/, "a company can't use the team's reply");
});

test('the list has a limit', async () => {
  for (let i = saved().filter((x) => x.owner === 'employer:emp-b').length; i < 30; i++) await post(EMP, { name: `R${i}`, text: 'Hello' }, bob);
  assert.match(said(await post(EMP, { name: 'One more', text: 'Hello' }, bob)), /list is full/);
});
