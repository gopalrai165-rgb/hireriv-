// Step 57: Hireriv's sales CRM. Leads from website inquiries, sign-ups, the
// team and imports, with duplicate checks; who sees and assigns what; the
// pipeline's stage rules; follow-ups with reminders; proposals with versions,
// approval by someone else, sending with unsubscribe, and the client's answer
// with evidence; a controlled conversion of won clients that never duplicates
// companies, activates contracts or issues invoices; reports with revenue
// from recorded payments; retention and the audit log.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startServer, decodeEmail } = require('./helpers');

const DAY = 86400000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const ymd = (msAgo) => new Date(Date.now() - msAgo).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let srv;
const p = {};
const id = {};
let ip = 0;
const headers = (extra = {}) => ({ 'x-forwarded-for': `10.9.${Math.floor(++ip / 250)}.${ip % 250}`, ...extra });
const get = (url, cookie) => srv.request(url, { cookie, headers: headers() });
const post = (url, form, cookie) => srv.request(url, { method: 'POST', form, cookie, headers: headers() });
const call = async (url, method, body, cookie, extra = {}) => {
  const r = await srv.request(url, { method, cookie, body: body === undefined ? undefined : JSON.stringify(body), headers: headers({ 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'TestBrowser/1.0', ...extra }) });
  return { status: r.status, ...(await r.json()) };
};
const rec = (collection, fn) => srv.records(collection).find(fn);
const all = (collection, fn = () => true) => srv.records(collection).filter(fn);
const msg = (res) => decodeURIComponent(res.headers.get('location') || '');

async function member(name, email, role) {
  await post('/admin/team', { name, email, role }, p.admin);
  const link = decodeEmail(await srv.waitForEmail((e) => e.includes(`To: ${email}`))).match(/\/admin\/setup\/[a-f0-9]{64}/)[0];
  return srv.cookieFrom(await post(link, { password: `${name} long password`, confirm: `${name} long password` }));
}
const terms = { kind: 'Permanent recruitment', feeMode: 'percent', feePercent: '8.33', guaranteeDays: '90', paymentDays: '30' };

before(async () => {
  srv = await startServer({ TRUST_PROXY: '1', CRM_SCAN_MS: '400' }, {
    employers: [{ id: 'emp-x', company: 'Existing Industries Pvt Ltd', name: 'Hema', email: 'hema@existing.in', active: true, createdAt: iso(400 * DAY) }],
    placements: [{
      id: 'pl-x', appId: 'app-x', type: 'Permanent', feeMode: 'percent', status: 'Joined', fee: 50000, employerId: 'emp-x', company: 'Existing Industries Pvt Ltd', jobTitle: 'Plant Head',
      candidateName: 'Kiran', candidateEmail: 'kiran@example.in', joiningDate: ymd(60 * DAY), createdAt: iso(60 * DAY), guaranteeDays: 90,
      invoice: { number: 'HR/26/001', date: ymd(40 * DAY), dueDate: ymd(10 * DAY), subtotal: 50000, total: 59000, status: 'Part paid', creditNotes: [],
        payments: [{ id: 'pay1', date: ymd(5 * DAY), amount: 40000, tds: 1000 }, { id: 'pay0', date: ymd(200 * DAY), amount: 999, tds: 0 }], refunds: [{ id: 'rf1', date: ymd(3 * DAY), amount: 500 }] },
    }],
    'crm-leads': [{ id: 'old-lead', companyName: 'Gone Traders', contactName: 'Old Contact', email: 'old@gone.in', phone: '9811111111', status: 'lost', source: 'Manual', createdAt: iso(1000 * DAY), lastActivityAt: iso(900 * DAY), history: [], emailKey: 'old@gone.in', phoneKey: '9811111111', domain: 'gone.in', companyKey: 'gonetraders' }],
  });
  p.admin = await srv.adminLogin();
  p.sam = await member('Sam', 'sam@hireriv.test', 'Sales Manager');
  p.bea = await member('Bea', 'bea@hireriv.test', 'Business Development');
  p.ben = await member('Ben', 'ben@hireriv.test', 'Business Development');
  p.rita = await member('Rita', 'rita@hireriv.test', 'Recruiter');
  p.fin = await member('Fin', 'fin@hireriv.test', 'Finance Manager');
  for (const n of ['sam', 'bea', 'ben']) id[n] = rec('team', (u) => u.email === `${n}@hireriv.test`).id;
}, { timeout: 40000 });
after(() => srv && srv.stop());

test('website inquiries and sign-ups become leads without exposing anything; spam and repeats do not', async () => {
  const hire = (form) => srv.request('/api/hire', { method: 'POST', form, headers: headers({ accept: 'application/json' }) });
  const r = await hire({ company: 'Nova Foods Pvt Ltd', name: 'Priya Shah', email: 'priya@novafoods.in', phone: '9822000001', roles: 'Packers', headcount: '40', location: 'Pune', message: 'Need 40 packers by December.' });
  const body = await r.json();
  assert.deepEqual(Object.keys(body).sort(), ['message', 'ok'], 'the public reply carries nothing internal');
  const lead = rec('crm-leads', (l) => l.email === 'priya@novafoods.in');
  assert.ok(lead);
  assert.equal(lead.source, 'Website inquiry');
  assert.equal(lead.status, 'new');
  assert.equal(lead.ownerId, null);
  assert.equal(lead.companyKey, 'novafoods');
  assert.match(lead.hiringNeeds, /Headcount: 40/);
  id.web = lead.id;
  // Sales Managers hear about it.
  assert.ok(all('notifications', (n) => n.type === 'crm-lead' && n.event === `crm-new:${lead.id}`).length >= 1);

  // The same person again: an activity on the lead, not a second lead.
  await hire({ company: 'Nova Foods', name: 'Priya Shah', email: 'PRIYA@novafoods.in', phone: '9822000001', roles: 'Loaders' });
  assert.equal(all('crm-leads', (l) => l.emailKey === 'priya@novafoods.in').length, 1);
  assert.ok(rec('crm-activities', (a) => a.leadId === lead.id && a.subject === 'Website inquiry again'));

  // Bots (the hidden field) and link-stuffed messages are dropped.
  await hire({ company: 'Spam Co', name: 'Bot', email: 'bot@spam.in', phone: '9822000002', roles: 'x', website: 'http://x' });
  await hire({ company: 'Links Co', name: 'Links', email: 'l@links.in', phone: '9822000003', roles: 'x', message: 'http://a http://b www.c http://d' });
  assert.ok(!rec('crm-leads', (l) => ['bot@spam.in', 'l@links.in'].includes(l.email)));

  // An employer signing up is a lead linked to its new account.
  await srv.request('/employer/register', { method: 'POST', form: { company: 'Signup Logistics', industry: 'Logistics & Warehousing', size: '51-200', name: 'Sanjay', email: 'sanjay@signuplogistics.in', phone: '9822000004', password: 'Signup long password 1', confirm: 'Signup long password 1', agree: 'on' }, headers: headers() });
  const s = rec('crm-leads', (l) => l.email === 'sanjay@signuplogistics.in');
  assert.ok(s, 'sign-up captured');
  assert.equal(s.source, 'Employer registration');
  assert.equal(s.employerId, rec('employers', (e) => e.email === 'sanjay@signuplogistics.in').id);

  // Retention: a long-lost lead lost its contact details at start-up.
  const old = rec('crm-leads', (l) => l.id === 'old-lead');
  assert.ok(old.anonymizedAt);
  assert.equal(old.email, '');
  assert.equal(old.contactName, 'Removed');
  assert.equal(old.companyName, 'Gone Traders');
});

test('roles: only the sales team works leads; representatives see their own; managers assign', async () => {
  assert.equal((await call('/api/crm/leads', 'GET', undefined, p.rita)).status, 403);
  assert.equal((await call('/api/crm/leads', 'GET', undefined, p.fin)).status, 403);
  assert.equal((await get('/admin/crm', p.rita)).status, 403);
  assert.equal((await get('/api/crm/leads')).status, 401);
  // Sales roles live in the CRM only.
  assert.equal((await get('/admin', p.bea)).headers.get('location'), '/admin/crm');
  assert.equal((await get('/admin/requisitions', p.sam)).status, 403);
  assert.equal((await get('/admin/workforce', p.bea)).status, 403);

  // Adding a lead: validated, a reason to hold the contact, duplicates caught.
  const bad = await call('/api/crm/leads', 'POST', { companyName: 'Orbit Retail', contactName: 'Om', email: 'not-an-email', source: 'Referral' }, p.bea);
  assert.equal(bad.status, 400);
  assert.ok(bad.errors.some((e) => /email is invalid/.test(e)));
  assert.ok(bad.errors.some((e) => /lawfulBasis/.test(e)));
  assert.equal((await call('/api/crm/leads', 'POST', { companyName: 'X', contactName: 'Y', email: 'y@x.in', lawfulBasis: 'Referral with permission', role: 'Admin' }, p.bea)).status, 400, 'unknown fields refused');
  const lead = { companyName: 'Orbit Retail LLP', contactName: 'Om Desai', designation: 'HR Head', email: 'om@orbitretail.in', phone: '+91 98220 00010', industry: 'Retail', location: 'Mumbai', hiringNeeds: '25 store staff', source: 'Referral', lawfulBasis: 'Referral with permission' };
  const made = await call('/api/crm/leads', 'POST', lead, p.bea);
  assert.equal(made.status, 201, JSON.stringify(made.errors));
  assert.equal(made.lead.ownerId, id.bea, 'a representative owns what they add');
  assert.equal(made.lead.emailKey, undefined, 'internal keys stay internal');
  id.orbit = made.lead.id;
  const dup = await call('/api/crm/leads', 'POST', { ...lead, email: 'hr@orbitretail.in', phone: '' }, p.ben);
  assert.equal(dup.status, 409);
  assert.ok(dup.duplicates.leads.some((x) => x.id === id.orbit && x.why.includes('same company email domain')));
  assert.ok(!JSON.stringify(dup).includes('Om Desai'), "another representative's contact stays hidden");
  const client = await call('/api/crm/leads', 'POST', { companyName: 'Existing Industries', contactName: 'Ravi', email: 'ravi@existing.in', source: 'Event', lawfulBasis: 'Met at an event' }, p.ben);
  assert.equal(client.status, 409, 'matches an existing client');
  assert.equal(client.duplicates.clients[0].id, 'emp-x');
  const forced = await call('/api/crm/leads', 'POST', { companyName: 'Existing Industries', contactName: 'Ravi', email: 'ravi@existing.in', source: 'Event', lawfulBasis: 'Met at an event', confirmDuplicate: true }, p.ben);
  assert.equal(forced.status, 201);
  assert.deepEqual(forced.lead.matchingClients, ['emp-x']);
  id.existingLead = forced.lead.id;

  // Visibility.
  assert.equal((await call(`/api/crm/leads/${id.orbit}`, 'GET', undefined, p.ben)).status, 404);
  assert.ok(!(await call('/api/crm/leads', 'GET', undefined, p.ben)).leads.some((l) => l.id === id.orbit));
  assert.equal((await call(`/api/crm/leads/${id.orbit}`, 'PATCH', { notes: 'x' }, p.ben)).status, 404);
  assert.ok((await call('/api/crm/leads?q=orbit', 'GET', undefined, p.sam)).leads.some((l) => l.id === id.orbit), 'managers search everything');
  assert.equal((await call('/api/crm/leads?q=orbit', 'GET', undefined, p.ben)).leads.length, 0);

  // Assigning: managers only, to active sales people, audited.
  assert.equal((await call(`/api/crm/leads/${id.web}/assign`, 'POST', { ownerId: id.ben }, p.bea)).status, 403);
  assert.equal((await call(`/api/crm/leads/${id.web}/assign`, 'POST', { ownerId: rec('team', (u) => u.email === 'rita@hireriv.test').id }, p.sam)).status, 400, 'not to a recruiter');
  const a = await call(`/api/crm/leads/${id.web}/assign`, 'POST', { ownerId: id.ben }, p.sam);
  assert.equal(a.status, 200);
  assert.equal(a.lead.ownerId, id.ben);
  assert.ok(rec('crm-audit', (x) => x.action === 'lead-assigned' && x.entityId === id.web && /Unassigned → Ben|unassigned → Ben/.test(x.detail)));
  assert.ok(all('notifications', (n) => n.type === 'crm-lead' && n.title === 'A lead was assigned to you').length >= 1);
  assert.equal((await call(`/api/crm/leads/${id.web}`, 'GET', undefined, p.ben)).status, 200);

  // Status changes need reasons; converted only comes from converting.
  assert.equal((await call(`/api/crm/leads/${id.web}`, 'PATCH', { status: 'converted' }, p.ben)).status, 400);
  assert.equal((await call(`/api/crm/leads/${id.web}`, 'PATCH', { status: 'unqualified' }, p.ben)).status, 400);
  assert.equal((await call(`/api/crm/leads/${id.web}`, 'PATCH', { industry: 'Food processing' }, p.ben)).lead.industry, 'Food processing');
});

test('pipeline stages follow the rules and the lead follows the pipeline', async () => {
  const o = await call('/api/crm/opportunities', 'POST', { leadId: id.web, title: '40 packers, Pune', estimatedValue: '3,20,000', expectedCloseOn: ymd(-30 * DAY), nextAction: 'Site visit', services: ['Bulk hiring'] }, p.ben);
  assert.equal(o.status, 201, JSON.stringify(o.errors));
  assert.equal(o.opportunity.stage, 'New Lead');
  assert.equal(o.opportunity.valuePaise, 32000000);
  id.opp = o.opportunity.id;
  assert.equal((await call('/api/crm/opportunities', 'POST', { leadId: id.orbit, title: 'Not mine' }, p.ben)).status, 404);
  const stage = (s, body = {}, who = p.ben) => call(`/api/crm/opportunities/${id.opp}/stage`, 'PATCH', { stage: s, ...body }, who);
  assert.equal((await stage('Meeting')).status, 409, 'no skipping stages');
  assert.equal((await stage('Won')).status, 409);
  assert.equal((await stage('Contacted')).opportunity.stage, 'Contacted');
  assert.equal(rec('crm-leads', (l) => l.id === id.web).status, 'contacted');
  assert.equal((await stage('Meeting')).opportunity.stage, 'Meeting');
  assert.equal(rec('crm-leads', (l) => l.id === id.web).status, 'qualified');
  assert.equal((await stage('Lost')).status, 400, 'a reason is required');
  assert.equal((await stage('Lost', { reason: 'Other' })).status, 400, '"Other" needs words');
  const lost = await stage('Lost', { reason: 'Price' });
  assert.equal(lost.opportunity.lostReason, 'Price');
  assert.equal(rec('crm-leads', (l) => l.id === id.web).status, 'lost');
  assert.equal((await stage('New Lead')).status, 403, 'only a manager reopens');
  assert.equal((await stage('New Lead', {}, p.sam)).opportunity.stage, 'New Lead');
  assert.notEqual(rec('crm-leads', (l) => l.id === id.web).status, 'lost');
  for (const s of ['Contacted', 'Meeting', 'Proposal']) assert.equal((await stage(s)).status, 200, s);
  assert.equal((await stage('Won')).status, 409, 'won needs a proposal that was sent');
  const history = rec('crm-opportunities', (x) => x.id === id.opp).stageHistory.map((h) => h.to);
  assert.deepEqual(history, ['New Lead', 'Contacted', 'Meeting', 'Lost', 'New Lead', 'Contacted', 'Meeting', 'Proposal']);
  assert.ok(rec('crm-audit', (x) => x.action === 'opportunity-stage' && /Meeting → Lost \(Price\)/.test(x.detail)));
  // Value changes are audited.
  assert.equal((await call(`/api/crm/opportunities/${id.opp}`, 'PATCH', { estimatedValue: '350000' }, p.ben)).opportunity.valuePaise, 35000000);
  assert.ok(rec('crm-audit', (x) => x.action === 'opportunity-value' && x.entityId === id.opp));
});

test('follow-ups have owners, due dates, completion and reminders sent once', async () => {
  assert.equal((await call(`/api/crm/leads/${id.web}/activities`, 'POST', { kind: 'call', subject: 'Call Priya' }, p.ben)).status, 400, 'open needs a due date');
  assert.equal((await call(`/api/crm/leads/${id.web}/activities`, 'POST', { kind: 'call', subject: 'x', dueAt: 'tomorrow' }, p.ben)).status, 400);
  assert.equal((await call(`/api/crm/leads/${id.web}/activities`, 'POST', { kind: 'call', subject: 'x', dueAt: ymd(-DAY), ownerId: id.bea }, p.ben)).status, 400, 'reps give follow-ups only to themselves');
  const overdue = await call(`/api/crm/leads/${id.web}/activities`, 'POST', { kind: 'call', subject: 'Call Priya back', dueAt: iso(2 * 3600000), notes: 'Budget is tight' }, p.ben);
  assert.equal(overdue.status, 201);
  assert.equal(overdue.activity.ownerId, id.ben);
  assert.equal(overdue.activity.overdue, true);
  const soon = await call('/api/crm/activities', 'POST', { leadId: id.web, opportunityId: id.opp, kind: 'meeting', subject: 'Site visit', dueAt: iso(-3 * 3600000) }, p.ben);
  assert.equal(soon.status, 201);
  const later = await call('/api/crm/activities', 'POST', { leadId: id.web, kind: 'task', subject: 'Send case study', dueAt: iso(-5 * DAY) }, p.ben);
  await sleep(1500);
  const reminders = all('notifications', (n) => n.type === 'crm-follow-up');
  assert.equal(reminders.filter((n) => n.event.startsWith(`crm-due:${overdue.activity.id}:`) && n.event.endsWith(':overdue')).length, 1, 'once, though the scan ran several times');
  assert.equal(reminders.filter((n) => n.event.startsWith(`crm-due:${soon.activity.id}:`) && n.event.endsWith(':soon')).length, 1);
  assert.equal(reminders.filter((n) => n.event.includes(later.activity.id)).length, 0, 'not due yet');
  assert.ok(all('notification-deliveries', (d) => d.template === 'crm').length >= 1, 'emails go through the queue');
  // Someone else's follow-up can't be closed by a representative.
  assert.equal((await call(`/api/crm/activities/${overdue.activity.id}`, 'PATCH', { status: 'done' }, p.bea)).status, 404);
  const done = await call(`/api/crm/activities/${overdue.activity.id}`, 'PATCH', { status: 'done', outcome: 'Agreed to a visit' }, p.ben);
  assert.equal(done.activity.status, 'done');
  assert.ok(done.activity.completedAt);
  const list = await call('/api/crm/activities?view=overdue', 'GET', undefined, p.ben);
  assert.ok(!list.activities.some((a) => a.id === overdue.activity.id));
});

let token1;
let token2;
test('proposals keep versions, need someone else to approve, go out with unsubscribe and record the answer with evidence', async () => {
  const draft = await call('/api/crm/proposals', 'POST', { opportunityId: id.opp, title: 'Bulk hiring: 40 packers', services: ['Bulk hiring', 'Permanent recruitment'], ...terms, validUntil: ymd(-20 * DAY), estimatedValue: '350000', scope: 'Sourcing, screening and joining support.', internalNotes: 'Can go to 7.5% if pushed' }, p.ben);
  assert.equal(draft.status, 201, JSON.stringify(draft.errors));
  const pr = draft.proposal;
  id.prop = pr.id;
  assert.match(pr.number, /^PRO-\d{4}$/);
  assert.equal(pr.status, 'draft');
  assert.equal(pr.current.version, 1);
  assert.match(pr.current.text, /8\.33% of the hire's annual CTC/);
  assert.doesNotMatch(pr.current.text, /7\.5%/, 'internal notes stay out of what the client reads');
  assert.equal(pr.current.sha256, crypto.createHash('sha256').update(pr.current.text).digest('hex'));
  assert.equal((await call('/api/crm/proposals', 'POST', { opportunityId: id.opp, title: 'Another', services: ['Bulk hiring'], ...terms, validUntil: ymd(-20 * DAY) }, p.ben)).status, 409, 'one in progress per opportunity');
  assert.equal((await call('/api/crm/proposals', 'POST', { opportunityId: id.opp, title: 'Bad', services: ['Window cleaning'], ...terms, feePercent: '', validUntil: ymd(5 * DAY) }, p.sam)).status, 409);

  const act = (a, body = {}, who = p.sam) => call(`/api/crm/proposals/${id.prop}/${a}`, 'POST', body, who);
  assert.equal((await act('send')).status, 409, 'approved before it is sent');
  assert.equal((await act('approve', {}, p.ben)).status, 403, 'representatives do not approve');
  assert.equal((await act('approve')).proposal.status, 'approved');
  // A change is a new version and needs approving again.
  const v2 = await call(`/api/crm/proposals/${id.prop}`, 'PATCH', { feePercent: '8' }, p.sam);
  assert.equal(v2.status, 200, JSON.stringify(v2.errors));
  assert.equal(v2.proposal.versions.length, 2);
  assert.equal(v2.proposal.status, 'draft');
  assert.match(v2.proposal.versions[0].text, /8\.33%/, 'earlier versions are kept as they were');
  assert.match(v2.proposal.current.text, /8% of the hire's annual CTC/);
  assert.equal((await act('approve')).status, 403, 'not by the author of this version');
  assert.equal((await act('approve', {}, p.admin)).proposal.status, 'approved');
  const sent = await act('send');
  assert.equal(sent.status, 200);
  assert.equal(sent.emailed, true);
  assert.equal(sent.proposal.tokenHash, undefined, 'the link token is never returned');
  const mail = decodeEmail(await srv.waitForEmail((e) => e.includes('To: priya@novafoods.in') && e.includes('proposal')));
  assert.match(mail, /List-Unsubscribe:\s+<http:\/\/[^>]+\/crm\/unsubscribe\//);
  token1 = mail.match(/\/crm\/proposal\/([A-Za-z0-9_-]{20,64})/)[1];
  id.unsub = mail.match(/\/crm\/unsubscribe\/([A-Za-z0-9.-]+)/)[1];
  assert.equal(rec('crm-proposals', (x) => x.id === id.prop).tokenHash, crypto.createHash('sha256').update(token1).digest('hex'), 'stored hashed');
  assert.equal(rec('crm-opportunities', (x) => x.id === id.opp).stage, 'Proposal');

  // The client's page shows the text, never internal notes.
  const page = await get(`/crm/proposal/${token1}`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /8% of the hire&#39;s annual CTC/);
  assert.doesNotMatch(html, /7\.5%|Can go to/);
  // Revising after sending kills the old link.
  await call(`/api/crm/proposals/${id.prop}`, 'PATCH', { guaranteeDays: '60' }, p.ben);
  assert.equal((await get(`/crm/proposal/${token1}`)).status, 404);
  await act('approve');
  await act('send');
  token2 = decodeEmail(await srv.waitForEmail((e) => { const d = decodeEmail(e); return d.includes('To: priya@novafoods.in') && /\/crm\/proposal\//.test(d) && !d.includes(token1); })).match(/\/crm\/proposal\/([A-Za-z0-9_-]{20,64})/)[1];
  assert.notEqual(token1, token2);
  const v3 = rec('crm-proposals', (x) => x.id === id.prop).versions[2];

  // Accepting: name, designation, agreement and the exact version's hash.
  const accept = (form) => srv.request(`/crm/proposal/${token2}/accept`, { method: 'POST', form, headers: headers({ 'user-agent': 'ClientBrowser/2.0' }) });
  assert.equal((await accept({ name: 'Priya Shah', designation: 'HR Head', sha256: v3.sha256 })).status, 400, 'agreement ticked');
  assert.equal((await accept({ name: 'Priya Shah', designation: 'HR Head', agree: '1', sha256: 'f'.repeat(64) })).status, 400, 'the version they read');
  assert.equal((await accept({ name: 'Priya Shah', designation: 'HR Head', agree: '1', sha256: v3.sha256 })).status, 200);
  const done = rec('crm-proposals', (x) => x.id === id.prop);
  assert.equal(done.status, 'accepted');
  assert.equal(done.response.version, 3);
  assert.equal(done.response.sha256, v3.sha256);
  assert.equal(done.response.userAgent, 'ClientBrowser/2.0');
  assert.match(done.response.ipHash, /^[a-f0-9]{32}$/);
  assert.ok(!JSON.stringify(done).includes('10.9.'), 'no raw IP address kept');
  assert.equal(done.tokenHash, null, 'the link works once');
  assert.equal(rec('crm-opportunities', (x) => x.id === id.opp).stage, 'Negotiation');
  assert.equal((await call(`/api/crm/proposals/${id.prop}`, 'PATCH', { title: 'Late change' }, p.sam)).status, 409, 'answered proposals are final');
  assert.ok(rec('crm-audit', (x) => x.action === 'proposal-accepted' && x.entityId === id.prop));
  assert.ok(rec('crm-audit', (x) => x.action === 'proposal-approved' && x.entityId === id.prop && x.actorName === 'Sam'));

  // Unsubscribing stops further sales emails to the contact.
  assert.equal((await get(`/crm/unsubscribe/${id.unsub}x`)).status, 404);
  assert.equal((await get(`/crm/unsubscribe/${id.unsub}`)).status, 200);
  assert.equal((await post(`/crm/unsubscribe/${id.unsub}`, {})).status, 200);
  assert.ok(rec('crm-leads', (l) => l.id === id.web).unsubscribedAt);
  const o2 = await call('/api/crm/opportunities', 'POST', { leadId: id.web, title: 'Seasonal staff' }, p.ben);
  const pr2 = await call('/api/crm/proposals', 'POST', { opportunityId: o2.opportunity.id, title: 'Seasonal', services: ['Temporary & contract staffing'], kind: 'Temporary & contract staffing', markupPercent: '12', paymentDays: '15', validUntil: ymd(-10 * DAY) }, p.ben);
  assert.equal(pr2.status, 201, JSON.stringify(pr2.errors));
  await call(`/api/crm/proposals/${pr2.proposal.id}/approve`, 'POST', {}, p.sam);
  const blocked = await call(`/api/crm/proposals/${pr2.proposal.id}/send`, 'POST', {}, p.sam);
  assert.equal(blocked.status, 409);
  assert.match(blocked.errors[0], /asked us not to email/);
  // The team can still record an answer they got another way.
  assert.equal((await call(`/api/crm/proposals/${pr2.proposal.id}/withdraw`, 'POST', { reason: 'Client paused seasonal hiring' }, p.ben)).proposal.status, 'withdrawn');
});

test('conversion is controlled: asked by reps, done by managers once, linking existing clients, no duplicate companies, contracts stay Draft, no invoices', async () => {
  const before = { employers: all('employers').length, contracts: all('client-contracts').length, placements: JSON.stringify(all('placements')) };
  assert.equal((await call(`/api/crm/opportunities/${id.opp}/convert`, 'POST', { createNew: true }, p.sam)).status, 409, 'only won opportunities');
  assert.equal((await call(`/api/crm/opportunities/${id.opp}/stage`, 'PATCH', { stage: 'Won' }, p.ben)).opportunity.stage, 'Won');
  assert.equal(rec('crm-leads', (l) => l.id === id.web).status, 'qualified');
  // A representative asks.
  const ask = await call(`/api/crm/opportunities/${id.opp}/convert`, 'POST', { note: 'Signed off by their CFO' }, p.ben);
  assert.equal(ask.status, 202);
  assert.equal(ask.conversion.status, 'requested');
  assert.equal((await call(`/api/crm/opportunities/${id.opp}/convert`, 'POST', {}, p.ben)).existed, true);
  assert.equal(all('employers').length, before.employers);
  // A manager decides how.
  assert.equal((await call(`/api/crm/opportunities/${id.opp}/convert`, 'POST', {}, p.sam)).status, 400, 'no match: a new account must be confirmed');
  const noRef = await call(`/api/crm/opportunities/${id.opp}/convert`, 'POST', { createNew: true, contract: true, startsOn: ymd(0) }, p.sam);
  assert.equal(noRef.status, 400);
  assert.equal(all('employers').length, before.employers, 'nothing created when the contract details are wrong');
  const key = crypto.randomUUID();
  const body = { createNew: true, contract: true, contractReference: 'MSA-NOVA-01', startsOn: ymd(0) };
  const [a, b] = await Promise.all([
    call(`/api/crm/opportunities/${id.opp}/convert`, 'POST', body, p.sam, { 'idempotency-key': key }),
    call(`/api/crm/opportunities/${id.opp}/convert`, 'POST', body, p.sam, { 'idempotency-key': key }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 201], JSON.stringify([a, b]));
  const conv = (a.status === 201 ? a : b).conversion;
  assert.equal(conv.createdClient, true);
  assert.equal(all('employers').length, before.employers + 1, 'exactly one client account');
  const emp = rec('employers', (e) => e.id === conv.employerId);
  assert.equal(emp.company, 'Nova Foods Pvt Ltd');
  assert.equal(emp.email, 'priya@novafoods.in');
  const contract = rec('client-contracts', (c) => c.id === conv.contractId);
  assert.equal(contract.status, 'Draft', 'never activated by the CRM');
  assert.equal(contract.feeBp, 800);
  assert.equal(contract.guaranteeDays, 60, 'the accepted version\'s terms');
  assert.equal(all('client-contracts').length, before.contracts + 1);
  assert.equal(JSON.stringify(all('placements')), before.placements, 'no invoices');
  const lead = rec('crm-leads', (l) => l.id === id.web);
  assert.equal(lead.status, 'converted');
  assert.equal(lead.employerId, emp.id);
  await srv.waitForEmail((e) => e.includes('To: priya@novafoods.in') && /\/employer\/setup\//.test(decodeEmail(e)));
  const again = await call(`/api/crm/opportunities/${id.opp}/convert`, 'POST', body, p.sam);
  assert.equal(again.status, 200);
  assert.equal(again.existed, true);
  assert.equal(all('employers').length, before.employers + 1);
  assert.ok(rec('crm-audit', (x) => x.action === 'converted' && x.entityId === id.opp));

  // A lead that matches an existing client is linked, not duplicated.
  const o = await call('/api/crm/opportunities', 'POST', { leadId: id.existingLead, title: 'Plant staffing' }, p.ben);
  const st = (s, who = p.ben) => call(`/api/crm/opportunities/${o.opportunity.id}/stage`, 'PATCH', { stage: s }, who);
  for (const s of ['Contacted', 'Meeting']) await st(s);
  const pr = await call('/api/crm/proposals', 'POST', { opportunityId: o.opportunity.id, title: 'Plant staffing', services: ['Permanent recruitment'], ...terms, validUntil: ymd(-15 * DAY) }, p.ben);
  await call(`/api/crm/proposals/${pr.proposal.id}/approve`, 'POST', {}, p.sam);
  await call(`/api/crm/proposals/${pr.proposal.id}/send`, 'POST', {}, p.sam);
  assert.equal((await call(`/api/crm/proposals/${pr.proposal.id}/response`, 'POST', { decision: 'accepted', channel: 'Phone', note: 'Hema said yes' }, p.ben)).status, 403, 'a manager records an acceptance');
  assert.equal((await call(`/api/crm/proposals/${pr.proposal.id}/response`, 'POST', { decision: 'accepted', channel: 'Phone', note: 'Hema (CHRO) said yes on the phone' }, p.sam)).proposal.response.recordedByName, 'Sam');
  assert.equal((await st('Won')).status, 200);
  const choose = await call(`/api/crm/opportunities/${o.opportunity.id}/convert`, 'POST', {}, p.sam);
  assert.equal(choose.status, 409);
  assert.equal(choose.matches[0].id, 'emp-x');
  const linked = await call(`/api/crm/opportunities/${o.opportunity.id}/convert`, 'POST', { employerId: 'emp-x' }, p.sam);
  assert.equal(linked.status, 201, JSON.stringify(linked.errors));
  assert.equal(linked.conversion.createdClient, false);
  assert.equal(linked.conversion.contractId, null);
  assert.equal(all('employers').length, before.employers + 1);
  assert.equal(rec('crm-leads', (l) => l.id === id.existingLead).employerId, 'emp-x');
});

test('reports: funnel, pipeline, by representative and source; revenue only from recorded payments, only for finance and managers', async () => {
  const r = (await call('/api/crm/reports', 'GET', undefined, p.sam)).report;
  assert.equal(r.scope, 'everyone');
  assert.ok(r.leads.received >= 4);
  assert.ok(r.leads.converted >= 2);
  assert.ok(r.proposals.sent >= 2);
  assert.ok(r.proposals.accepted >= 2);
  assert.equal(r.opportunities.won, 2);
  assert.equal(typeof r.opportunities.medianSalesCycleDays, 'number');
  assert.ok(r.byRepresentative.some((x) => x.name === 'Ben' && x.won === 2));
  assert.ok(r.bySource.some((x) => x.source === 'Website inquiry' && x.converted === 1));
  // 40,000 + 1,000 TDS − 500 refund in the period; the old payment is outside it; estimates never count.
  assert.equal(r.revenue.receivedPaise, 4050000);
  assert.equal(r.revenue.byClient[0].company, 'Existing Industries');
  const fin = await call('/api/crm/reports', 'GET', undefined, p.fin);
  assert.equal(fin.report.revenue.receivedPaise, 4050000);
  const bea = (await call('/api/crm/reports', 'GET', undefined, p.bea)).report;
  assert.equal(bea.revenue, undefined);
  assert.equal(bea.scope, 'yours');
  assert.ok(!bea.byRepresentative.some((x) => x.name === 'Ben'), 'a representative sees their own numbers');
  assert.equal((await call('/api/crm/reports', 'GET', undefined, p.rita)).status, 403);
  assert.equal((await get('/admin/crm/reports', p.fin)).status, 200, 'finance opens the sales reports page');
  assert.equal((await get('/admin/crm/leads', p.fin)).status, 403);
});

test('imports: managers only, validated and normalised, duplicates skipped, a lawful basis required', async () => {
  const csv = 'Company,Contact name,Email,Phone,City\nKestrel Mills,Kavya Iyer,KAVYA@kestrelmills.in, 98220 00020 ,Coimbatore\nOrbit Retail,Someone,new@orbitretail.in,,Mumbai\nBad Row,No Email,not-an-email,,\nKestrel Mills,Kavya again,kavya@kestrelmills.in,,\n';
  assert.equal((await call('/api/crm/leads/import', 'POST', { csv, lawfulBasis: 'Met at an event' }, p.bea)).status, 403);
  assert.equal((await call('/api/crm/leads/import', 'POST', { csv }, p.sam)).status, 400);
  assert.equal((await call('/api/crm/leads/import', 'POST', { rows: Array.from({ length: 501 }, (_, i) => ({ companyName: `C${i}`, contactName: 'X', email: `x${i}@c${i}.in` })), lawfulBasis: 'Met at an event' }, p.sam)).status, 400);
  const r = await call('/api/crm/leads/import', 'POST', { csv, lawfulBasis: 'Met at an event', sourceDetail: 'HR summit Pune', ownerId: id.bea }, p.sam);
  assert.equal(r.status, 201, JSON.stringify(r.errors));
  assert.equal(r.created.length, 1);
  assert.deepEqual(r.skipped.map((x) => x.row).sort(), [2, 4]);
  assert.equal(r.failed[0].row, 3);
  const k = rec('crm-leads', (l) => l.companyName === 'Kestrel Mills');
  assert.equal(k.email, 'kavya@kestrelmills.in');
  assert.equal(k.phoneKey, '9822000020');
  assert.equal(k.source, 'Import');
  assert.equal(k.lawfulBasis, 'Met at an event');
  assert.equal(k.ownerId, id.bea);
  assert.equal(k.consent.marketing, false, 'imported contacts have not agreed to sales emails');
  assert.ok(rec('crm-audit', (x) => x.action === 'leads-imported' && /1 imported, 2 duplicates skipped, 1 with errors/.test(x.detail)));
});

test('pages: the CRM renders for the sales team, forms work, short links and the drag-and-drop board', async () => {
  for (const path of ['/admin/crm', '/admin/crm/leads', `/admin/crm/leads/${id.web}`, '/admin/crm/pipeline', '/admin/crm/activities?view=all', '/admin/crm/proposals', `/admin/crm/proposals/${id.prop}`, '/admin/crm/companies', '/admin/crm/reports', '/admin/crm/import']) {
    const res = await get(path, p.sam);
    assert.equal(res.status, 200, path);
  }
  const board = await (await get('/admin/crm/pipeline', p.ben)).text();
  assert.match(board, /data-crm-board/);
  assert.match(board, /\/js\/crm-pipeline\.js/);
  assert.equal((await get('/js/crm-pipeline.js')).status, 200);
  assert.equal((await get('/admin/crm/import', p.bea)).status, 403);
  assert.equal((await get(`/admin/crm/leads/${id.orbit}`, p.ben)).status, 404);
  assert.equal((await get('/crm/leads')).headers.get('location'), '/admin/crm/leads');
  assert.equal((await get('/crm/dashboard')).headers.get('location'), '/admin/crm');

  // The add-lead form shows duplicates and needs confirming.
  const dupe = await post('/admin/crm/leads', { companyName: 'Kestrel Mills Ltd', contactName: 'Arjun', email: 'arjun@kestrelmills.in', source: 'Referral', lawfulBasis: 'Referral with permission' }, p.bea);
  assert.equal(dupe.status, 409);
  assert.match(await dupe.text(), /I checked: this is a different lead/);
  const added = await post('/admin/crm/leads', { companyName: 'Lumen Labs', contactName: 'Lata', email: 'lata@lumenlabs.in', source: 'Referral', lawfulBasis: 'Referral with permission' }, p.bea);
  assert.equal(added.status, 303);
  const lumen = rec('crm-leads', (l) => l.email === 'lata@lumenlabs.in');
  assert.equal(msg(added), `/admin/crm/leads/${lumen.id}?msg=Lead added.`);
  const opp = await post('/admin/crm/opportunities', { leadId: lumen.id, title: 'Lab technicians', services: 'Permanent recruitment' }, p.bea);
  assert.match(msg(opp), /Opportunity added/);
  const o = rec('crm-opportunities', (x) => x.leadId === lumen.id);
  assert.match(msg(await post(`/admin/crm/opportunities/${o.id}/stage`, { stage: 'Contacted', back: '/admin/crm/pipeline' }, p.bea)), /^\/admin\/crm\/pipeline\?msg=Moved to Contacted/);
  assert.match(msg(await post(`/admin/crm/opportunities/${o.id}/stage`, { stage: 'Won', back: 'https://evil.example/' }, p.bea)), /^\/admin\/crm\/leads\/.*moves from Contacted only to/, 'back only to CRM pages');
  assert.match(msg(await post(`/admin/crm/leads/${lumen.id}/activities`, { kind: 'call', subject: 'Intro call', status: 'done' }, p.bea)), /Logged/);
  assert.equal(rec('crm-leads', (l) => l.id === lumen.id).status, 'contacted');
});
