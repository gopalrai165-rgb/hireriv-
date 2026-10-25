// Step 56: the client employer's self-service portal. Contract documents
// reviewed by a second person, sent, signed by an owner with evidence,
// activated, terminated or sent back with comments; bulk hiring requests
// checked whole; shortlist answers with reasons; interviews, invoices,
// reports and the team under /api/client/*; no self-escalation; every
// company sees only its own records.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startServer, decodeEmail } = require('./helpers');
const { hashPassword } = require('../employers');

const DAY = 86400000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const ymd = (msAgo) => new Date(Date.now() - msAgo).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

const company = (id, name, email) => ({ id, company: name, name: email.split('@')[0], email, active: true, createdAt: iso(30 * DAY) });
const person = (id, email, name) => ({ id, email, name, phone: '', passwordHash: hashPassword(`${name} long password`), emailVerifiedAt: iso(DAY), phoneVerifiedAt: null, createdAt: iso(DAY), active: true, link: null });
const membership = (id, employerId, userId, role) => ({ id, employerId, userId, role, jobIds: [], createdAt: iso(DAY) });

let srv;
const p = {};
let ip = 0;
const headers = (extra = {}) => ({ 'x-forwarded-for': `10.7.${Math.floor(++ip / 250)}.${ip % 250}`, ...extra });
const get = (url, cookie) => srv.request(url, { cookie, headers: headers() });
const post = (url, form, cookie) => srv.request(url, { method: 'POST', form, cookie, headers: headers() });
const call = async (url, method, body, cookie) => {
  const r = await srv.request(url, { method, cookie, body: body === undefined ? undefined : JSON.stringify(body), headers: headers({ 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'TestBrowser/1.0' }) });
  return { status: r.status, ...(await r.json()) };
};
const rec = (collection, fn) => srv.records(collection).find(fn);
const msg = (res) => decodeURIComponent(res.headers.get('location') || '');

async function member(name, email, role) {
  await post('/admin/team', { name, email, role }, p.admin);
  const link = decodeEmail(await srv.waitForEmail((e) => e.includes(`To: ${email}`))).match(/\/admin\/setup\/[a-f0-9]{64}/)[0];
  return srv.cookieFrom(await post(link, { password: `${name} long password`, confirm: `${name} long password` }));
}
const employer = async (email, name) => srv.cookieFrom(await post('/employer/login', { email, password: `${name} long password` }));

before(async () => {
  srv = await startServer({ TRUST_PROXY: '1' }, {
    employers: [company('emp-a', 'A Co', 'olga@aco.in'), company('emp-b', 'B Co', 'bob@bco.in')],
    'employer-users': [person('u-olga', 'olga@aco.in', 'Olga Rao'), person('u-mona', 'mona@aco.in', 'Mona'), person('u-vic', 'vic@aco.in', 'Vic'), person('u-bob', 'bob@bco.in', 'Bob')],
    'employer-members': [membership('m1', 'emp-a', 'u-olga', 'owner'), membership('m2', 'emp-a', 'u-mona', 'manager'), membership('m3', 'emp-a', 'u-vic', 'viewer'), membership('m4', 'emp-b', 'u-bob', 'owner')],
    jobs: [{ id: 'j1', title: 'Store Manager', company: 'A Co', location: 'Pune', mode: 'On-site', type: 'Full-time', category: 'Retail', experience: '', posted: ymd(5 * DAY), approvedAt: iso(5 * DAY), skills: [], description: 'A job.', responsibilities: [], status: 'open', closesOn: null, sample: false }],
    applications: [{
      id: 'a1', jobId: 'j1', jobTitle: 'Store Manager', name: 'Ravi Patil', email: 'ravi@example.in', phone: '9800000000', status: 'Shortlisted', createdAt: iso(10 * DAY), history: [],
      shared: { employerId: 'emp-a', sharedAt: iso(2 * DAY), summary: 'Ran two stores.' }, interviews: [{ id: 'iv1', at: iso(-3 * DAY), duration: 30, mode: 'Video', status: 'scheduled', feedback: [] }],
    }],
  });
  p.admin = await srv.adminLogin();
  p.arun = await member('Arun', 'arun@hireriv.test', 'Account Manager');
  p.rita = await member('Rita', 'rita@hireriv.test', 'Recruiter');
  p.olga = await employer('olga@aco.in', 'Olga Rao');
  p.mona = await employer('mona@aco.in', 'Mona');
  p.vic = await employer('vic@aco.in', 'Vic');
  p.bob = await employer('bob@bco.in', 'Bob');
  const arunId = rec('team', (u) => u.email === 'arun@hireriv.test').id;
  await call('/api/clients/emp-a/account-manager', 'PUT', { accountManagerId: arunId }, p.admin);
}, { timeout: 30000 });
after(() => srv && srv.stop());

let contractId;
let v1;
test('contract documents: drafted, reviewed by someone else, sent, signed with evidence, active', async () => {
  const made = await call('/api/clients/emp-a/contracts', 'POST', { reference: 'MSA-26', kind: 'Both', status: 'Draft', startsOn: ymd(DAY), endsOn: ymd(-365 * DAY), feeMode: 'percent', feePercent: '8.33', guaranteeDays: '90', paymentDays: '30', markupPercent: '' }, p.arun);
  assert.equal(made.status, 201, JSON.stringify(made.errors));
  contractId = made.contract.id;
  assert.equal((await call(`/api/contracts/${contractId}/versions`, 'POST', { title: 'Master agreement' }, p.rita)).status, 403);
  const d = await call(`/api/contracts/${contractId}/versions`, 'POST', { title: 'Master agreement', clauses: 'Both parties keep candidate data confidential.' }, p.arun);
  assert.equal(d.status, 201);
  v1 = d.version;
  assert.equal(v1.status, 'draft');
  assert.match(v1.text, /8\.33% of the hire's annual CTC/);
  assert.match(v1.text, /Replacement guarantee: 90 days/);
  assert.equal(v1.sha256, crypto.createHash('sha256').update(v1.text).digest('hex'));
  assert.equal((await call(`/api/contracts/${contractId}/versions`, 'POST', {}, p.arun)).status, 409, 'one version in progress at a time');
  assert.equal((await call(`/api/contract-versions/${v1.id}`, 'PATCH', { clauses: 'Both parties keep candidate data confidential. Disputes go to Pune courts.' }, p.arun)).status, 200);
  // Clients never see drafts or internal review.
  assert.deepEqual((await call('/api/client/contracts', 'GET', undefined, p.olga)).contracts, []);
  assert.equal((await call(`/api/contract-versions/${v1.id}/send`, 'POST', {}, p.admin)).status, 409, 'reviewed before it is sent');
  assert.equal((await call(`/api/contract-versions/${v1.id}/submit`, 'POST', {}, p.arun)).version.status, 'pending_review');
  assert.equal((await call(`/api/contract-versions/${v1.id}/send`, 'POST', {}, p.arun)).status, 403, 'not by its author');
  const sent = await call(`/api/contract-versions/${v1.id}/send`, 'POST', {}, p.admin);
  assert.equal(sent.version.status, 'sent');
  await srv.waitForEmail((e) => e.includes('To: olga@aco.in') && e.includes('Contract to review and sign'));
  assert.equal((await call(`/api/contract-versions/${v1.id}`, 'PATCH', { title: 'Changed' }, p.arun)).status, 409, 'immutable once sent');

  // Who sees and signs it.
  const list = await call('/api/client/contracts', 'GET', undefined, p.olga);
  assert.equal(list.contracts.length, 1);
  assert.equal(list.contracts[0].history, undefined, 'no internal history for the client');
  assert.equal((await call(`/api/client/contracts/${v1.id}`, 'GET', undefined, p.mona)).status, 200, 'hiring managers read');
  assert.equal((await call(`/api/client/contracts/${v1.id}`, 'GET', undefined, p.vic)).status, 403);
  assert.equal((await call(`/api/client/contracts/${v1.id}`, 'GET', undefined, p.bob)).status, 404);
  const doc = (await call(`/api/client/contracts/${v1.id}`, 'GET', undefined, p.olga)).contract;
  const good = { typedName: 'Olga Rao', designation: 'Director', accept: true, sha256: doc.sha256 };
  assert.equal((await call(`/api/client/contracts/${v1.id}/sign`, 'POST', good, p.mona)).status, 403, 'owners sign');
  assert.equal((await call(`/api/client/contracts/${v1.id}/sign`, 'POST', good, p.bob)).status, 404);
  const bad = await call(`/api/client/contracts/${v1.id}/sign`, 'POST', { typedName: 'Someone', designation: '', sha256: 'x' }, p.olga);
  assert.equal(bad.status, 400);
  assert.equal(bad.errors.length, 4, bad.errors.join(' | '));
  const signed = await call(`/api/client/contracts/${v1.id}/sign`, 'POST', { ...good, typedName: 'olga  rao' }, p.olga);
  assert.equal(signed.status, 200);
  assert.equal(signed.contract.status, 'active', 'signed after its start date: active at once');
  const evidence = rec('contract-versions', (v) => v.id === v1.id).signature;
  assert.deepEqual([evidence.userId, evidence.typedName, evidence.designation, evidence.documentSha256, evidence.userAgent], ['u-olga', 'olga rao', 'Director', doc.sha256, 'TestBrowser/1.0']);
  assert.match(evidence.ipHash, /^[a-f0-9]{32}$/, 'the connection is kept only as a hash');
  assert.equal(rec('client-contracts', (c) => c.id === contractId).status, 'Active', 'its terms now apply');
  assert.equal((await call(`/api/client/contracts/${v1.id}/sign`, 'POST', good, p.olga)).existed, true);
  assert.ok(rec('employer-audit', (e) => e.event === 'contract-signed' && e.employerId === 'emp-a'));
  assert.ok(rec('agency-audit', (e) => e.action === 'contract-send' && e.entityId === v1.id));
  await srv.waitForEmail((e) => e.includes('To: olga@aco.in') && e.includes('Contract signed'));
});

test('contract documents: changes asked by the client, and termination', async () => {
  const d = await call(`/api/contracts/${contractId}/versions`, 'POST', { title: 'Master agreement', clauses: 'New payment terms.' }, p.arun);
  assert.deepEqual([d.status, d.version.version], [201, 2]);
  await call(`/api/contract-versions/${d.version.id}/submit`, 'POST', {}, p.arun);
  assert.equal((await call(`/api/contract-versions/${d.version.id}/back`, 'POST', {}, p.admin)).status, 400, 'a reason is needed');
  await call(`/api/contract-versions/${d.version.id}/send`, 'POST', {}, p.admin);
  assert.equal((await call(`/api/client/contracts/${d.version.id}/request-changes`, 'POST', {}, p.olga)).status, 400);
  const asked = await call(`/api/client/contracts/${d.version.id}/request-changes`, 'POST', { comment: 'Payment in 45 days please' }, p.olga);
  assert.deepEqual([asked.contract.status, asked.contract.terminationReason], ['terminated', 'Client asked for changes: Payment in 45 days please']);
  await srv.waitForEmail((e) => e.includes('To: arun@hireriv.test') && e.includes('asked for contract changes'));
  // The active version still holds until the team ends it.
  assert.equal(rec('contract-versions', (v) => v.id === v1.id).status, 'active');
  assert.equal((await call(`/api/contract-versions/${v1.id}/terminate`, 'POST', {}, p.arun)).status, 400);
  assert.equal((await call(`/api/contract-versions/${v1.id}/terminate`, 'POST', { reason: 'Client moved to a new agreement' }, p.arun)).version.status, 'terminated');
  assert.equal(rec('client-contracts', (c) => c.id === contractId).status, 'Ended');
  // Pages.
  assert.match(await (await get(`/employer/contracts/${v1.id}`, p.olga)).text(), /Signed by <b>Olga Rao<\/b>/);
  assert.equal((await get('/employer/contracts', p.vic)).status, 403);
  assert.match(await (await get('/admin/clients/emp-a/contract-documents', p.arun)).text(), /Version 2/);
  assert.equal((await get('/admin/clients/emp-a/contract-documents', p.rita)).status, 403);
});

test('hiring requests: single or bulk, checked whole, reviewed by Hireriv', async () => {
  const bad = await call('/api/client/hiring-requests', 'POST', { lines: [{ title: 'Picker', openings: '10' }, { title: '', openings: '0' }] }, p.mona);
  assert.equal(bad.status, 400);
  assert.ok(bad.errors.every((e) => /^line 2: /.test(e)), bad.errors.join(' | '));
  assert.equal(srv.records('requisitions').length, 0, 'nothing saved from a bad order');
  assert.equal((await call('/api/client/hiring-requests', 'POST', { lines: [{ title: 'Picker', openings: '1', rate: '5' }] }, p.mona)).status, 400, 'unknown fields refused');
  assert.equal((await call('/api/client/hiring-requests', 'POST', { title: 'Picker', openings: '1' }, p.vic)).status, 403);
  const order = await call('/api/client/hiring-requests', 'POST', { lines: [{ title: 'Picker', openings: '10', location: 'Chakan', kind: 'Temporary' }, { title: 'Forklift Operator', openings: '2', kind: 'Temporary' }], note: 'Festive season' }, p.mona);
  assert.equal(order.status, 201);
  assert.equal(order.orderNumber, 'ORD-0001');
  assert.deepEqual(order.requests.map((r) => [r.title, r.openings, r.status]), [['Picker', 10, 'Requested'], ['Forklift Operator', 2, 'Requested']]);
  const one = await call('/api/client/hiring-requests', 'POST', { title: 'Cashier', openings: '1' }, p.mona);
  assert.equal(one.requests.length, 1);
  const mine = await call('/api/client/hiring-requests', 'GET', undefined, p.olga);
  assert.equal(mine.requests.filter((r) => r.orderNumber === 'ORD-0001').length, 2);
  assert.equal((await call('/api/client/hiring-requests', 'GET', undefined, p.bob)).requests.length, 0);
  assert.equal((await call(`/api/client/hiring-requests/${one.requests[0].id}`, 'GET', undefined, p.bob)).status, 404);
  // The form takes one line per role.
  assert.match(msg(await post('/employer/requisitions/bulk', { lines: '3 × Loader, Pune\n1 x Driver', kind: 'Contract' }, p.mona)), /Order ORD-0002 sent: 2 request/);
  assert.match(msg(await post('/employer/requisitions/bulk', { lines: 'Loader without a number' }, p.mona)), /line 1: /);
  // Only Hireriv opens a request.
  assert.equal(rec('requisitions', (r) => r.id === one.requests[0].id).status, 'Requested');
});

test('shortlist answers keep their reasons; interviews, invoices, reports, team', async () => {
  assert.equal((await call('/api/client/candidates/a1/feedback', 'POST', { decision: 'Not a fit' }, p.mona)).status, 400, 'a reason is needed');
  assert.equal((await call('/api/client/candidates/a1/feedback', 'POST', { decision: 'Not a fit', reason: 'x' }, p.vic)).status, 403);
  assert.equal((await call('/api/client/candidates/a1/feedback', 'POST', { decision: 'Not a fit', reason: 'x' }, p.bob)).status, 404);
  assert.equal((await call('/api/client/candidates/a1/feedback', 'POST', { decision: 'Not a fit', reason: 'Needs grocery experience' }, p.mona)).feedback.reason, 'Needs grocery experience');
  assert.equal((await call('/api/client/candidates/a1/feedback', 'POST', { decision: 'Interested' }, p.olga)).status, 200);
  const shared = rec('applications', (a) => a.id === 'a1').shared;
  assert.deepEqual([shared.feedback.decision, shared.feedbackHistory[0].decision, shared.feedbackHistory[0].comment], ['Interested', 'Not a fit', 'Needs grocery experience']);
  const cands = await call('/api/client/candidates', 'GET', undefined, p.mona);
  assert.equal(cands.candidates[0].email, undefined, 'no contact details for clients');
  assert.equal((await call('/api/client/interviews', 'GET', undefined, p.mona)).interviews[0].id, 'iv1');
  assert.equal((await call('/api/client/interviews', 'GET', undefined, p.bob)).interviews.length, 0);
  assert.equal((await call('/api/client/invoices', 'GET', undefined, p.olga)).status, 200);
  assert.equal((await call('/api/client/invoices', 'GET', undefined, p.mona)).status, 403, 'billing is for owners');
  const rv = await call('/api/client/reports', 'GET', undefined, p.vic);
  assert.deepEqual([rv.report.requisitions.awaitingReview, rv.report.shortlist.interested, rv.report.billing], [5, 1, undefined]);
  assert.ok((await call('/api/client/reports', 'GET', undefined, p.olga)).report.billing);
  const dash = await call('/api/client/dashboard', 'GET', undefined, p.olga);
  assert.equal(dash.company, 'A Co');
  const teamOwner = (await call('/api/client/team', 'GET', undefined, p.olga)).team;
  assert.ok(teamOwner.every((m) => m.email));
  assert.ok((await call('/api/client/team', 'GET', undefined, p.mona)).team.every((m) => m.email === undefined), 'emails for owners only');
  assert.equal((await call('/api/client/company-profile', 'GET', undefined, p.mona)).company.id, 'emp-a');
  assert.equal((await call('/api/client/company-profile', 'PATCH', { about: 'x' }, p.mona)).status, 403);
  for (const url of ['/employer/invoices', '/employer/reports', '/employer/contracts']) assert.equal((await get(url, p.olga)).status, 200, url);
  for (const [from, to] of [['/client/dashboard', '/employer'], ['/client/contracts', '/employer/contracts'], ['/client/hiring-requests', '/employer/requisitions'], ['/client/team', '/employer/team']]) assert.equal((await get(from)).headers.get('location'), to);
});

test('no one changes their own role', async () => {
  assert.equal((await post('/employer/team/m2', { role: 'owner' }, p.mona)).status, 403, 'managers do not manage the team');
  assert.match(msg(await post('/employer/team/m1', { role: 'manager' }, p.olga)), /can't change your own role|at least one owner/);
  assert.equal(rec('employer-members', (m) => m.id === 'm1').role, 'owner');
  assert.doesNotMatch(msg(await post('/employer/team/m3', { role: 'manager' }, p.olga)), /can't/);
  assert.equal(rec('employer-members', (m) => m.id === 'm3').role, 'manager');
});
