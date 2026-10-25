// Step 54: recruitment agency and staffing. Team roles and what each may do;
// client contracts and account managers; requisitions with recruiters and
// their status rules; placements linked to requisitions with fees from the
// contract; staffing assignments; invoice drafts that are idempotent and
// issued only by Finance through the existing billing; clients seeing only
// their own requisitions; reports and the audit log.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, decodeEmail } = require('./helpers');
const { hashPassword } = require('../employers');
const agency = require('../agency');
const roles = require('../agency-roles');

const DAY = 86400000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const ymd = (msAgo) => new Date(Date.now() - msAgo).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

test('money is exact: rupees to paise, percentages to basis points', () => {
  assert.equal(agency.paiseFrom('1,50,000.5'), 15000050);
  assert.equal(agency.paiseFrom('₹ 850.50'), 85050);
  assert.equal(agency.paiseFrom(''), null);
  assert.ok(Number.isNaN(agency.paiseFrom('12.345')));
  assert.ok(Number.isNaN(agency.paiseFrom('-5')));
  assert.equal(agency.bpFrom('8.33'), 833);
  assert.ok(Number.isNaN(agency.bpFrom('100.01')));
  // 8.33% of ₹12,34,567 = ₹1,02,839.4311 → ₹1,02,839.43; half a paisa rounds up.
  assert.equal(agency.percentOf(123456700, 833), 10283943);
  assert.equal(agency.percentOf(150, 5000), 75);
  assert.equal(agency.percentOf(1, 5000), 1);
  // 2.5 days at ₹850.50 = ₹2,126.25, no floating-point drift.
  assert.equal(agency.timesQty(85050, 250), 212625);
  assert.equal(agency.timesQty(10, 33), 3);
});

test('contracts need their fee written down; requisitions are checked', () => {
  const base = { reference: 'MSA-1', kind: 'Permanent recruitment', startsOn: '2026-04-01', paymentDays: '30', guaranteeDays: '90' };
  assert.deepEqual(agency.parseContract({ ...base, feePercent: '8.33' }).errors, []);
  assert.ok(agency.parseContract(base).errors.includes('fee % is required for permanent recruitment'));
  assert.ok(agency.parseContract({ ...base, feeMode: 'flat' }).errors.includes('fixed fee is required for permanent recruitment'));
  assert.deepEqual(agency.parseContract({ ...base, kind: 'Temporary & contract staffing', guaranteeDays: '' }).errors, [], 'staffing contracts have no placement fee');
  assert.ok(agency.parseContract({ ...base, feePercent: '8', endsOn: '2026-01-01' }).errors.includes('the contract ends before it starts'));
  assert.ok(agency.parseContract({ ...base, feePercent: '8', owner: 'x' }, { strict: true }).errors.includes('owner is not a field you can set'));
  const r = agency.parseRequisition({ title: 'Picker', openings: '0', kind: 'Gig', budgetMin: '30000', budgetMax: '20000', billRate: '500', payRate: '600' });
  for (const e of ['openings must be a whole number from 1 to 500', 'kind must be one of: Permanent, Temporary, Contract', 'budget to is less than budget from', 'the bill rate must be at least the pay rate']) assert.ok(r.errors.includes(e), e);
  assert.deepEqual(agency.REQ_MOVES.Cancelled, []);
  assert.ok(!agency.REQ_MOVES.Requested.includes('Filled'), 'nothing is filled without being opened first');
});

test('the role table', () => {
  const as = (role) => ({ role, active: true });
  assert.ok(roles.can(as('Finance Manager'), 'invoices.issue'));
  assert.ok(!roles.can(as('Recruitment Manager'), 'invoices.issue'));
  assert.ok(!roles.can(as('Recruiter'), 'money.view'));
  assert.ok(!roles.can(as('Finance Manager'), 'requisitions.view'));
  assert.ok(!roles.can({ role: 'Admin', active: false }, 'clients.view'));
  assert.ok(roles.pathAllowed(as('Finance Manager'), '/admin/placements/p1/payments'));
  for (const p of ['/admin/jobs/new', '/admin/applications/a1/placement', '/admin/talent', '/admin/export/applications.csv', '/admin/placements/p1/edit']) assert.ok(!roles.pathAllowed(as('Finance Manager'), p), p);
  assert.deepEqual(roles.tabsAllowed(as('Finance Manager'), ['dashboard', 'applications', 'placements', 'clients', 'reports']), ['placements', 'clients', 'reports']);
});

// ---------- the whole app ----------
const owner = (id, company, email) => ({ id, company, name: email.split('@')[0], email, passwordHash: hashPassword('owner long password'), passwordSetAt: iso(DAY), active: true, createdAt: iso(30 * DAY) });
const job = (id, extra) => ({
  id, title: `Job ${id}`, company: 'A Co', location: 'Pune', mode: 'On-site', type: 'Full-time', category: 'Warehouse & Packing', experience: '',
  posted: ymd(5 * DAY), approvedAt: iso(5 * DAY), skills: [], description: 'A job.', responsibilities: [], status: 'open', closesOn: null, sample: false, employerId: 'emp-a', ...extra,
});
const app = (id, jobId, name, extra = {}) => ({ id, jobId, jobTitle: `Job ${jobId}`, name, email: `${id}@example.in`, phone: '9800000000', status: 'Offered', createdAt: iso(10 * DAY), history: [], ...extra });

let srv;
const p = {};
let ip = 0;
const headers = (extra = {}) => ({ 'x-forwarded-for': `10.9.${Math.floor(++ip / 250)}.${ip % 250}`, ...extra });
const get = (url, cookie) => srv.request(url, { cookie, headers: headers() });
const post = (url, form, cookie) => srv.request(url, { method: 'POST', form, cookie, headers: headers() });
const json = (url, method, body, cookie, extra = {}) => srv.request(url, { method, cookie, body: body === undefined ? undefined : JSON.stringify(body), headers: headers({ 'content-type': 'application/json', accept: 'application/json', ...extra }) });
const api = async (url, cookie) => (await json(url, 'GET', undefined, cookie)).json();
const msg = (res) => decodeURIComponent(res.headers.get('location') || '');
const rec = (collection, fn) => srv.records(collection).find(fn);

async function member(name, email, role) {
  await post('/admin/team', { name, email, role }, p.admin);
  const link = decodeEmail(await srv.waitForEmail((e) => e.includes(`To: ${email}`))).match(/\/admin\/setup\/[a-f0-9]{64}/)[0];
  return srv.cookieFrom(await post(link, { password: `${name} long password`, confirm: `${name} long password` }));
}
const idOf = (email) => rec('team', (u) => u.email === email).id;

before(async () => {
  srv = await startServer({ TRUST_PROXY: '1' }, {
    employers: [owner('emp-a', 'A Co', 'olga@aco.in'), owner('emp-b', 'B Co', 'bob@bco.in')],
    jobs: [job('j1', { title: 'Warehouse Supervisor' }), job('j2', { title: 'Forklift Operator', type: 'Temporary' }), job('j3', { title: 'Packer' }), job('jb', { title: 'B Job', company: 'B Co', employerId: 'emp-b' })],
    applications: [app('a1', 'j1', 'Ravi Patil', { jobTitle: 'Warehouse Supervisor' }), app('a2', 'j2', 'Sunil More', { jobTitle: 'Forklift Operator' }), app('a3', 'j3', 'Meena Shah', { jobTitle: 'Packer' })],
  });
  p.admin = await srv.adminLogin();
  p.rm = await member('Maya', 'maya@hireriv.test', 'Recruitment Manager');
  p.rita = await member('Rita', 'rita@hireriv.test', 'Recruiter');
  p.ravi = await member('Ravi', 'ravi@hireriv.test', 'Recruiter');
  p.am = await member('Arun', 'arun@hireriv.test', 'Account Manager');
  p.fin = await member('Farah', 'farah@hireriv.test', 'Finance Manager');
  p.olga = srv.cookieFrom(await post('/employer/login', { email: 'olga@aco.in', password: 'owner long password' }));
  p.bob = srv.cookieFrom(await post('/employer/login', { email: 'bob@bco.in', password: 'owner long password' }));
}, { timeout: 30000 });
after(() => srv && srv.stop());

test('the team page offers every role, labelled', async () => {
  const html = await (await get('/admin?tab=team', p.admin)).text();
  for (const label of ['Super Admin', 'Recruitment Manager', 'Account Manager', 'Finance Manager']) assert.match(html, new RegExp(`>${label}<`));
  assert.equal(rec('team', (u) => u.email === 'farah@hireriv.test').role, 'Finance Manager');
});

test('a Finance Manager works only on billing', async () => {
  const home = await get('/admin', p.fin);
  assert.equal(home.status, 200);
  const html = await home.text();
  assert.match(html, /Signed in as <b>Farah<\/b> · Finance Manager/);
  assert.doesNotMatch(html, /href="\/admin\?tab=applications"/);
  assert.match(html, /href="\/admin\?tab=placements"/);
  for (const url of ['/admin/jobs/new', '/admin/applications/a1/placement', '/admin/requisitions', '/admin/export/applications.csv']) assert.equal((await get(url, p.fin)).status, 403, url);
  assert.equal((await api('/api/requisitions', p.fin)).ok, false, 'no requisitions (candidates) for Finance');
  // Recruiters still can't bill.
  assert.equal((await get('/admin/invoice-drafts', p.rita)).status, 403);
});

let contractId;
test('account managers and contracts: Admins assign, the account manager writes the terms', async () => {
  assert.equal((await json('/api/clients/emp-a/account-manager', 'PUT', { accountManagerId: idOf('arun@hireriv.test') }, p.am)).status, 403, 'only Admins assign');
  assert.equal((await json('/api/clients/emp-a/account-manager', 'PUT', { accountManagerId: idOf('rita@hireriv.test') }, p.admin)).status, 400, 'a Recruiter is no account manager');
  assert.match(msg(await post('/admin/clients/emp-a/account-manager', { accountManagerId: idOf('arun@hireriv.test') }, p.admin)), /Account manager: Arun/);
  const terms = { reference: 'MSA-2026-01', kind: 'Both', status: 'Active', startsOn: ymd(60 * DAY), feeMode: 'percent', feePercent: '7.5', guaranteeDays: '60', paymentDays: '30' };
  // Arun manages A Co, not B Co.
  assert.equal((await json('/api/clients/emp-b/contracts', 'POST', terms, p.am)).status, 403);
  const missing = await json('/api/clients/emp-a/contracts', 'POST', { ...terms, feePercent: '' }, p.am);
  assert.deepEqual([missing.status, (await missing.json()).errors], [400, ['fee % is required for permanent recruitment']]);
  const made = await json('/api/clients/emp-a/contracts', 'POST', terms, p.am);
  assert.equal(made.status, 201);
  const c = (await made.json()).contract;
  contractId = c.id;
  assert.deepEqual([c.feeBp, c.feePercent, c.guaranteeDays], [750, 7.5, 60]);
  assert.equal((await json('/api/clients/emp-a/contracts', 'POST', terms, p.am)).status, 400, 'same reference twice');
  // Recruiters see the client but not the fee terms.
  const seen = await api('/api/clients/emp-a', p.rita);
  assert.deepEqual(seen.contracts, []);
  const page = await (await get('/admin/clients/emp-a', p.am)).text();
  assert.match(page, /MSA-2026-01/);
  assert.match(page, /7\.5% of annual CTC/);
});

let reqId;
test('requisitions: opened, linked, assigned and moved only as allowed', async () => {
  const body = { clientId: 'emp-a', title: 'Warehouse Supervisor', kind: 'Permanent', openings: '1', location: 'Pune', jobId: 'j1', dueOn: ymd(-20 * DAY), budgetMin: '400000', budgetMax: '600000.50', budgetPeriod: 'year' };
  assert.equal((await json('/api/requisitions', 'POST', body, p.rita)).status, 403, 'recruiters do not open requisitions');
  assert.equal((await json('/api/requisitions', 'POST', { ...body, clientId: 'emp-b' }, p.am)).status, 403, "not Arun's client");
  const bad = await json('/api/requisitions', 'POST', { ...body, jobId: 'jb' }, p.rm);
  assert.deepEqual((await bad.json()).errors, ["job must be one of this client's jobs"]);
  const made = await json('/api/requisitions', 'POST', body, p.rm);
  assert.equal(made.status, 201);
  const r = (await made.json()).requisition;
  reqId = r.id;
  assert.match(r.number, /^REQ-\d{4}$/);
  assert.equal(r.contractId, contractId, "the client's one active contract is used");
  assert.equal(r.status, 'Open');
  assert.equal(r.budget, undefined, 'Maya does not see money');
  assert.deepEqual((await api(`/api/requisitions/${reqId}`, p.am)).requisition.budget.maxPaise, 60000050);
  assert.deepEqual((await (await json('/api/requisitions', 'POST', body, p.rm)).json()).errors, ['that job already belongs to another open requisition']);

  // Assigning recruiters: managers only; recruiters see only their own.
  assert.equal((await json(`/api/requisitions/${reqId}/recruiters`, 'PUT', { recruiterIds: [idOf('rita@hireriv.test')] }, p.am)).status, 403);
  assert.equal((await json(`/api/requisitions/${reqId}/recruiters`, 'PUT', { recruiterIds: [idOf('farah@hireriv.test')] }, p.rm)).status, 400, 'Finance works no requisitions');
  assert.equal((await json(`/api/requisitions/${reqId}/recruiters`, 'PUT', { recruiterIds: [idOf('rita@hireriv.test')] }, p.rm)).status, 200);
  assert.equal((await api(`/api/requisitions/${reqId}`, p.rita)).requisition.number, r.number);
  assert.equal((await json(`/api/requisitions/${reqId}`, 'GET', undefined, p.ravi)).status, 404, 'not assigned to Ravi');
  assert.equal((await api('/api/requisitions', p.ravi)).requisitions.length, 0);
  assert.ok((await api('/api/notifications', p.rita)).notifications.some((n) => n.title === `Requisition assigned to you: ${r.number}`));
  assert.match(await (await get('/admin/workspace', p.rita)).text(), new RegExp(r.number));

  // Status rules.
  assert.deepEqual((await (await json(`/api/requisitions/${reqId}`, 'PATCH', { status: 'Requested' }, p.rm)).json()).errors, ["a requisition can't move from Open to Requested"]);
  assert.deepEqual((await (await json(`/api/requisitions/${reqId}`, 'PATCH', { status: 'Cancelled' }, p.rm)).json()).errors, ['say why the requisition is cancelled']);
  assert.equal((await json(`/api/requisitions/${reqId}`, 'PATCH', { status: 'On hold', note: 'Client paused' }, p.rm)).status, 200);
  assert.equal((await json(`/api/requisitions/${reqId}`, 'PATCH', { status: 'Open' }, p.rm)).status, 200);
  assert.equal((await json(`/api/requisitions/${reqId}`, 'PATCH', { clientId: 'emp-b' }, p.rm)).status, 400);
  assert.equal((await json(`/api/requisitions/${reqId}`, 'PATCH', { openings: '2' }, p.rita)).status, 403, 'recruiters do not change requisitions');
  assert.ok(rec('agency-audit', (e) => e.entityId === reqId && e.action === 'requisition-status' && /On hold/.test(e.detail)));
});

let placementId;
test('a placement for the requisition takes the contract fee and fills it', async () => {
  const form = await (await get('/admin/applications/a1/placement', p.rm)).text();
  assert.match(form, /from contract <b>MSA-2026-01<\/b> for requisition <b>REQ-/);
  assert.match(form, /name="feePercent" inputmode="decimal" value="7.5"/);
  const res = await post('/admin/applications/a1/placement', {
    type: 'Permanent', company: 'A Co', employerId: 'emp-a', billingName: '', billingAddress: '', clientGstin: '', taxType: 'intra', joiningDate: ymd(3 * DAY),
    ctc: '1234567', feeMode: 'percent', feePercent: '7.5', guaranteeDays: '60', status: 'Awaiting joining', notes: '',
  }, p.rm);
  assert.equal(res.status, 302);
  const pl = rec('placements', (x) => x.appId === 'a1');
  placementId = pl.id;
  assert.deepEqual([pl.requisitionId, pl.contractId, pl.fee], [reqId, contractId, 92592.53]);
  assert.equal(pl.recruiterId, idOf('rita@hireriv.test'), "the requisition's recruiter");
  assert.equal(rec('requisitions', (r) => r.id === reqId).status, 'Filled', 'its only opening is placed');
  assert.ok(rec('requisitions', (r) => r.id === reqId).history.some((h) => /every opening has a placement/.test(h.text)));
});

test('invoice drafts: asked for once, issued once, only by Finance', async () => {
  const draft = (cookie, key) => json(`/api/placements/${placementId}/invoices`, 'POST', {}, cookie, key ? { 'idempotency-key': key } : {});
  assert.deepEqual((await (await draft(p.rm)).json()).errors, ['the fee is invoiced once the candidate has joined']);
  await post(`/admin/placements/${placementId}/status`, { status: 'Joined' }, p.rm);
  assert.equal((await draft(p.rita)).status, 403, 'recruiters do not ask for invoices');
  assert.equal((await draft(p.rm, 'bad key!')).status, 400);
  // Two requests at once with the same key make one draft.
  const [one, two] = await Promise.all([draft(p.rm, 'fee-req-0001'), draft(p.rm, 'fee-req-0001')]);
  const statuses = [one.status, two.status].sort();
  assert.deepEqual(statuses, [200, 201]);
  const d = (await one.json()).draft || (await two.json()).draft;
  assert.equal(d.subtotalPaise, 9259253);
  // Asking again without the key still finds the same draft.
  const again = await draft(p.am);
  assert.deepEqual([again.status, (await again.json()).existed], [200, true]);
  assert.equal(srv.records('invoice-drafts').filter((x) => x.placementId === placementId).length, 1);
  assert.equal(rec('placements', (x) => x.id === placementId).invoice, null, 'a draft is not an invoice');

  const issue = (cookie) => json(`/api/placements/${placementId}/invoices/${d.id}/issue`, 'POST', {}, cookie);
  assert.equal((await issue(p.rm)).status, 403);
  assert.equal((await issue(p.am)).status, 403);
  const first = await issue(p.fin);
  assert.equal(first.status, 200);
  const number = (await first.json()).invoiceNumber;
  assert.match(number, /^INV\/\d{4}-\d{2}\/\d{4}$/);
  const repeat = await issue(p.fin);
  assert.deepEqual([(await repeat.json()).invoiceNumber, repeat.status], [number, 200]);
  const inv = rec('placements', (x) => x.id === placementId).invoice;
  assert.deepEqual([inv.number, inv.subtotal, inv.total, inv.status, inv.payments.length], [number, 92592.53, 109259.19, 'Unpaid', 0], 'payment is recorded separately');
  // Finance records the payment on the existing page.
  assert.equal((await get(`/admin/placements/${placementId}/payments`, p.fin)).status, 200);
  assert.equal((await get(`/admin/placements/${placementId}/payments`, p.rm)).status, 403);
  assert.equal((await draft(p.rm)).status, 409, 'the fee is invoiced');
  // The admin's money view shows it; the recruiter's does not.
  assert.ok(typeof (await api('/api/placements', p.fin)).placements.find((x) => x.id === placementId).feePaise === 'number');
  assert.equal((await api('/api/placements', p.rita)).placements.find((x) => x.id === placementId).fee, undefined);
});

let tempPlacement;
let assignmentId;
test('staffing assignments: no overlaps, exact billing per period, issued by Finance', async () => {
  // A temporary requisition and placement billed per assignment.
  const r = await (await json('/api/requisitions', 'POST', { clientId: 'emp-a', title: 'Forklift Operator', kind: 'Temporary', openings: '3', jobId: 'j2', billRate: '850.50', payRate: '700', ratePer: 'day' }, p.am)).json();
  assert.equal(r.requisition.rates.billPaise, 85050);
  await json(`/api/requisitions/${r.requisition.id}/recruiters`, 'PUT', { recruiterIds: [idOf('ravi@hireriv.test')] }, p.rm);
  const form = await (await get('/admin/applications/a2/placement', p.rm)).text();
  assert.match(form, /<option value="assignment" selected>/);
  await post('/admin/applications/a2/placement', { type: 'Temporary', company: 'A Co', employerId: 'emp-a', taxType: 'intra', joiningDate: ymd(20 * DAY), ctc: '', feeMode: 'assignment', guaranteeDays: '0', status: 'Joined' }, p.rm);
  tempPlacement = rec('placements', (x) => x.appId === 'a2');
  assert.deepEqual([tempPlacement.feeMode, tempPlacement.fee, tempPlacement.requisitionId], ['assignment', 0, r.requisition.id]);
  assert.equal((await post('/admin/applications/a3/placement', { type: 'Permanent', company: 'A Co', employerId: 'emp-a', taxType: 'intra', joiningDate: ymd(0), feeMode: 'assignment', guaranteeDays: '0', status: 'Joined' }, p.rm)).status, 400, 'permanent hires are not billed per assignment');

  const body = { placementId: tempPlacement.id, site: 'Chakan warehouse', startsOn: ymd(20 * DAY), endsOn: ymd(-40 * DAY), shift: 'Night', billRate: '850.50', payRate: '700', ratePer: 'day' };
  assert.deepEqual((await (await json('/api/staffing/assignments', 'POST', { ...body, payRate: '900' }, p.ravi)).json()).errors, ['the bill rate must be at least the pay rate']);
  assert.equal((await json('/api/staffing/assignments', 'POST', body, p.rita)).status, 403, "Rita doesn't work this requisition");
  const made = await json('/api/staffing/assignments', 'POST', body, p.ravi);
  assert.equal(made.status, 201);
  const a = (await made.json()).assignment;
  assignmentId = a.id;
  assert.deepEqual([a.role, a.status, a.billRate], ['Forklift Operator', 'Scheduled', undefined], 'Ravi does not see rates');
  assert.deepEqual((await (await json('/api/staffing/assignments', 'POST', { ...body, startsOn: ymd(5 * DAY), endsOn: '' }, p.ravi)).json()).errors, ['this worker already has an assignment in those dates']);
  assert.deepEqual((await (await json(`/api/staffing/assignments/${a.id}`, 'PATCH', { status: 'Completed' }, p.ravi)).json()).errors, ["an assignment can't move from Scheduled to Completed"]);
  assert.equal((await json(`/api/staffing/assignments/${a.id}`, 'PATCH', { status: 'Active' }, p.ravi)).status, 200);

  // Drafting a period: inside the assignment, finished days only, never twice.
  const draft = (from, to, quantity, cookie = p.am) => json(`/api/placements/${tempPlacement.id}/invoices`, 'POST', { assignmentId: a.id, from, to, quantity }, cookie);
  assert.deepEqual((await (await draft(ymd(25 * DAY), ymd(15 * DAY), '5')).json()).errors[0], `the period must be inside the assignment (${ymd(20 * DAY)} to ${ymd(-40 * DAY)})`);
  assert.deepEqual((await (await draft(ymd(2 * DAY), ymd(-1 * DAY), '3')).json()).errors, ['only past or finished days can be billed']);
  assert.deepEqual((await (await draft(ymd(20 * DAY), ymd(14 * DAY), '8')).json()).errors, ['8 days is more than the period allows']);
  const ok = await draft(ymd(20 * DAY), ymd(14 * DAY), '6.5');
  assert.equal(ok.status, 201);
  const d = (await ok.json()).draft;
  assert.equal(d.subtotalPaise, 552825, '6.5 days × ₹850.50 = ₹5,528.25 exactly');
  assert.deepEqual((await (await draft(ymd(15 * DAY), ymd(10 * DAY), '5')).json()).errors, ['part of this period is already billed or drafted']);
  assert.equal((await draft(ymd(20 * DAY), ymd(14 * DAY), '6.5')).status, 200, 'the same period again is the same draft');
  // A billed assignment keeps its rate.
  assert.deepEqual((await (await json(`/api/staffing/assignments/${a.id}`, 'PATCH', { billRate: '900' }, p.am)).json()).errors[0], 'this assignment has invoice drafts or invoices: its bill rate stays as billed (end it and add a new assignment for a new rate)');

  // Finance issues it from the drafts page.
  const page = await (await get('/admin/invoice-drafts', p.fin)).text();
  assert.match(page, /₹5,528\.25/);
  assert.match(msg(await post(`/admin/invoice-drafts/${d.id}/issue`, {}, p.fin)), /^\/admin\/invoice-drafts\?msg=Invoice INV\//);
  const pl = rec('placements', (x) => x.id === tempPlacement.id);
  assert.equal(pl.staffingInvoices.length, 1);
  assert.deepEqual([pl.staffingInvoices[0].subtotal, pl.staffingInvoices[0].total, pl.staffingInvoices[0].sac], [5528.25, 6523.34, '998513']);
  assert.match(msg(await post(`/admin/invoice-drafts/${d.id}/issue`, {}, p.fin)), /Already issued as INV\//);
  assert.equal(rec('placements', (x) => x.id === tempPlacement.id).staffingInvoices.length, 1);
  // The invoice and its payments page work like any other.
  const key = pl.staffingInvoices[0].id;
  assert.equal((await get(`/admin/placements/${tempPlacement.id}/invoice?inv=${key}`, p.fin)).status, 200);
  assert.equal((await get(`/admin/placements/${tempPlacement.id}/payments?inv=${key}`, p.fin)).status, 200);
  assert.match(await (await get('/admin/staffing', p.am)).text(), /Chakan warehouse/);
  assert.equal((await get('/staffing/assignments')).headers.get('location'), '/admin/staffing');
});

test('clients see and request only their own requisitions', async () => {
  const mine = await api('/api/employers/requisitions', p.olga);
  assert.ok(mine.requisitions.length >= 2);
  assert.ok(mine.requisitions.every((r) => r.accountManager === 'Arun'));
  assert.equal(mine.requisitions[0].rates, undefined, 'no pay or bill rates for clients');
  assert.equal((await api('/api/employers/requisitions', p.bob)).requisitions.length, 0);
  assert.equal((await json(`/api/employers/requisitions/${reqId}`, 'GET', undefined, p.bob)).status, 404, "another company's requisition");
  assert.equal((await get(`/employer/requisitions/${reqId}`, p.bob)).status, 404);
  // Asking for people: starts as Requested; no fields the team sets.
  assert.deepEqual((await (await json('/api/employers/requisitions', 'POST', { title: 'Packers', openings: '20', recruiterIds: ['x'] }, p.olga)).json()).errors, ['recruiterIds is not a field you can set']);
  const made = await json('/api/employers/requisitions', 'POST', { title: 'Packers', kind: 'Temporary', openings: '20', location: 'Pune' }, p.olga);
  assert.equal(made.status, 201);
  const r = (await made.json()).requisition;
  assert.equal(r.status, 'Requested');
  assert.ok((await api('/api/notifications', p.rm)).notifications.some((n) => n.title === 'Staffing request from A Co'));
  assert.equal((await post(`/employer/requisitions/${r.id}/cancel`, {}, p.bob)).status, 404);
  // The team confirms it; then the client can no longer cancel it.
  assert.equal((await json(`/api/requisitions/${r.id}`, 'PATCH', { status: 'Open' }, p.am)).status, 200);
  assert.match(msg(await post(`/employer/requisitions/${r.id}/cancel`, {}, p.olga)), /already being worked on/);
  const page = await (await get('/employer/requisitions', p.olga)).text();
  assert.match(page, /Packers/);
  assert.match(page, /Warehouse Supervisor/);
  assert.equal((await get('/client/requisitions')).headers.get('location'), '/employer/requisitions');
});

test('reports and the audit log follow the roles', async () => {
  assert.equal((await json('/api/recruitment/reports', 'GET', undefined, p.rita)).status, 403);
  const rm = (await api('/api/recruitment/reports?period=all', p.rm)).report;
  assert.equal(rm.billedPaise, undefined, 'no money for Recruitment Managers');
  assert.ok(rm.workload.some((w) => w.name === 'Rita'));
  assert.equal(rm.staffing.active, 1);
  const fin = (await api('/api/recruitment/reports?period=all', p.fin)).report;
  assert.equal(fin.billedPaise, 9259253 + 552825);
  assert.equal(fin.placementsByType.Temporary, 1);
  assert.equal((await json('/api/recruitment/reports?period=7', 'GET', undefined, p.fin)).status, 400);
  assert.match(await (await get('/admin/recruitment-reports', p.am)).text(), /Billed before GST/);
  assert.doesNotMatch(await (await get('/admin/recruitment-reports', p.rm)).text(), /Billed before GST/);
  assert.equal((await json('/api/recruitment/audit', 'GET', undefined, p.rita)).status, 403);
  const log = (await api('/api/recruitment/audit', p.admin)).entries.map((e) => e.action);
  for (const a of ['account-manager-set', 'contract-added', 'requisition-opened', 'recruiters-assigned', 'placement-linked', 'invoice-drafted', 'invoice-issued', 'assignment-added', 'requisition-requested']) assert.ok(log.includes(a), a);
  assert.ok(!JSON.stringify(log).includes('@example.in'), 'no candidate contact details in the log');
  assert.equal((await get('/admin/agency-audit', p.fin)).status, 200);
});
