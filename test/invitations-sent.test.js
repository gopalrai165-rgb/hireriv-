// Step 209: employers see the invitations their company sent and whether each
// person applied. Search candidates keep their short name until they apply;
// an invitation put aside reads as "Not yet".
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');
const { hashPassword } = require('../employers');

const iso = (ago = 0) => new Date(Date.now() - ago * 864e5).toISOString();
const today = iso().slice(0, 10);
const person = (id, email, name) => ({ id, email, name, phone: '9800000001', passwordHash: hashPassword(`${name} long password`), emailVerifiedAt: iso(1), phoneVerifiedAt: iso(1), createdAt: iso(1), active: true, link: null });
const company = (id, name) => ({ id, company: name, name, email: `o@${id}.in`, active: true, approvedAt: iso(1), createdAt: iso(30) });
const member = (id, employerId, userId, role, jobIds = []) => ({ id, employerId, userId, role, jobIds, createdAt: iso(1) });
const job = (id, employerId, extra = {}) => ({ id, employerId, title: `Job ${id}`, company: 'A Co', location: 'Pune', mode: 'On-site', type: 'Full-time', category: 'Retail', experience: '', skills: [], description: 'Work', responsibilities: [], posted: today, status: 'open', alertsSentAt: today, resume: 'optional', createdBy: 'employer', ...extra });
const app = (id, jobId, name, email, ago) => ({ id, jobId, jobTitle: `Job ${jobId}`, name, email, phone: '9845019001', status: 'New', createdAt: iso(ago), history: [] });

let srv;
let ann;
let rob;
let bob;
let ip = 0;
const h = () => ({ 'x-forwarded-for': `10.209.${Math.floor(++ip / 250)}.${(ip % 250) + 1}` });
const text = async (url, cookie) => (await srv.request(url, { cookie, headers: h() })).text();
const post = (url, form, cookie) => srv.request(url, { method: 'POST', form, cookie, headers: h() });

before(async () => {
  srv = await startServer({ TRUST_PROXY: '1' }, {
    employers: [company('emp-a', 'A Co'), company('emp-b', 'B Co')],
    'employer-users': [person('u-ann', 'ann@aco.in', 'Ann'), person('u-rob', 'rob@aco.in', 'Rob'), person('u-bob', 'bob@bco.in', 'Bob')],
    'employer-members': [member('m1', 'emp-a', 'u-ann', 'owner'), member('m2', 'emp-a', 'u-rob', 'recruiter', ['j2']), member('m4', 'emp-b', 'u-bob', 'owner')],
    jobs: [job('j1', 'emp-a'), job('j2', 'emp-a'), job('j3', 'emp-a', { status: 'closed' }), job('j9', 'emp-b')],
    candidates: [{ id: 'c1', email: 'meera@example.in', profile: { name: 'Meera Joshi Nair' }, privacy: { discoverable: true }, createdAt: iso(9) }],
    applications: [
      app('a1', 'j1', 'Asha Rao', 'asha@example.in', 5),
      app('a2', 'j2', 'Asha Rao', 'asha@example.in', 1),
      app('a3', 'j2', 'Meera Joshi Nair', 'meera@example.in', 8),
    ],
    'candidate-invites': [
      { id: 'i1', employerId: 'emp-a', jobId: 'j2', applicationId: 'a1', email: 'asha@example.in', fromJobId: 'j1', invitedBy: 'u-ann', createdAt: iso(3) },
      { id: 'i2', employerId: 'emp-a', jobId: 'j1', candidateId: 'c1', invitedBy: 'u-rob', createdAt: iso(2), dismissedAt: iso(1) },
      { id: 'i3', employerId: 'emp-a', jobId: 'j2', candidateId: 'c1', invitedBy: 'u-ann', createdAt: iso(4) },
      { id: 'i4', employerId: 'emp-a', jobId: 'j3', candidateId: 'c1', invitedBy: 'u-ann', createdAt: iso(4) },
      { id: 'i9', employerId: 'emp-b', jobId: 'j9', candidateId: 'c1', invitedBy: 'u-bob', createdAt: iso(1) },
    ],
  });
  const login = async (email, name) => srv.cookieFrom(await post('/employer/login', { email, password: `${name} long password` }));
  ann = await login('ann@aco.in', 'Ann');
  rob = await login('rob@aco.in', 'Rob');
  bob = await login('bob@bco.in', 'Bob');
}, { timeout: 60000 });
after(() => srv && srv.stop());

const rowOf = (page, re) => (page.match(/<tr>[\s\S]*?<\/tr>/g) || []).filter((r) => re.test(r));

test('the list says who, which job, how, when, by whom and what happened', async () => {
  const page = await text('/employer/invitations', ann);
  assert.match(page, /href="\/employer\/invitations"/, 'in the menu');
  assert.match(page, /<b>4<\/b> invitations · 1 applied · 30 left today/);
  const asha = rowOf(page, /Asha Rao/);
  assert.equal(asha.length, 1);
  assert.match(asha[0], /href="\/employer\/applicants\/a2"/, 'links to the new application');
  assert.match(asha[0], /After applying for Job j1/);
  assert.match(asha[0], />Applied</);
  const meera = rowOf(page, /Meera N\./);
  assert.equal(meera.length, 3, 'search candidates keep their short name');
  assert.doesNotMatch(page, /Meera Joshi Nair/, 'an application from before the invitation does not count');
  assert.ok(meera.some((r) => /Job j1/.test(r) && />Not yet</.test(r) && /Rob/.test(r)), 'put aside reads as Not yet');
  assert.ok(meera.some((r) => /Job j3/.test(r) && />Job closed</.test(r)));
  assert.ok(meera.every((r) => !/href=/.test(r)));
  assert.doesNotMatch(page, /Job j9/);
});

test('filters, roles and other companies', async () => {
  assert.equal(rowOf(await text('/employer/invitations?outcome=applied', ann), /<td>/).length, 1);
  assert.equal(rowOf(await text('/employer/invitations?job=j1', ann), /<td>/).length, 1);
  const robs = await text('/employer/invitations', rob);
  assert.doesNotMatch(robs, /Job j1<\/td>|Job j3<\/td>/, 'only jobs they work on');
  assert.match(robs, /Job j2<\/td>/);
  assert.match(robs, /After applying for another of your jobs/, 'not the title of a job they do not work on');
  const bobs = await text('/employer/invitations', bob);
  assert.doesNotMatch(bobs, /Asha|Job j1|Job j2/);
  assert.match(bobs, /<b>1<\/b> invitation/);
  assert.notEqual((await srv.request('/employer/invitations', { headers: h() })).status, 200);
});
