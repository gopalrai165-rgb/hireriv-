// Step 59: platform trust & safety. Roles that see only their own queues
// and must use two-step sign-in; reports from candidates, employers and
// visitors that never reveal who has an account; automated flags that open
// a case but never unpublish; moderation decisions with history, appeals
// decided by someone else and reversals; employer verification with
// requests for information; case versions against concurrent updates;
// account closure needing two people; a tamper-evident audit trail; and a
// sanitized health view.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { startServer, decodeEmail, ADMIN_PASS } = require('./helpers');
const tf = require('../twofactor');
const { flagsFor, fingerprint } = require('../trust');
const ops = require('../ops-monitor');

let srv;
const p = {};
const id = {};
let ip = 0;
const headers = (extra = {}) => ({ 'x-forwarded-for': `10.7.${Math.floor(++ip / 250)}.${ip % 250}`, ...extra });
const get = (url, cookie, extra = {}) => srv.request(url, { cookie, headers: headers({ accept: 'text/html', ...extra }) });
const post = (url, form, cookie) => srv.request(url, { method: 'POST', form, cookie, headers: headers() });
const call = async (url, method, body, cookie, extra = {}) => {
  const r = await srv.request(url, { method, cookie, body: body === undefined ? undefined : JSON.stringify(body), headers: headers({ 'content-type': 'application/json', accept: 'application/json', ...extra }) });
  const text = await r.text();
  let data = {};
  try { data = JSON.parse(text); } catch (e) { data = { text }; }
  return { ...data, status: r.status };
};
const rec = (collection, fn) => srv.records(collection).find(fn);
const all = (collection, fn = () => true) => srv.records(collection).filter(fn);
const msg = (res) => decodeURIComponent(res.headers.get('location') || '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) { const v = fn(); if (v) return v; }
  return fn();
}

const code = (secret, offset) => tf.codeFor(secret, tf.stepAt() + offset);
async function enable2fa(cookie) {
  assert.equal((await post('/admin/security/start', {}, cookie)).status, 302);
  const html = await (await get('/admin/security', cookie)).text();
  const secret = html.match(/<code class="setup-key">([A-Z2-7 ]+)<\/code>/)[1].replace(/ /g, '');
  const res = await post('/admin/security/confirm', { code: code(secret, -1) }, cookie);
  assert.equal(res.status, 200);
  return srv.cookieFrom(res) || cookie;
}
async function member(name, email, role, { twoStep = true } = {}) {
  await post('/admin/team', { name, email, role }, p.admin);
  const link = decodeEmail(await srv.waitForEmail((e) => e.includes(`To: ${email}`))).match(/\/admin\/setup\/[a-f0-9]{64}/)[0];
  const cookie = srv.cookieFrom(await post(link, { password: `${name} long password`, confirm: `${name} long password` }));
  return twoStep ? enable2fa(cookie) : cookie;
}
// An employer that signs up itself and confirms its email.
async function signup(form) {
  await post('/employer/register', { industry: 'Hospitality & Food', size: '51-200', password: 'long enough phrase', confirm: 'long enough phrase', agree: '1', ...form });
  const mail = await srv.waitForEmail((m) => m.includes(`To: ${form.email}`) && m.includes('Confirm your email'));
  const link = decodeEmail(mail).match(/\/employer\/verify\/[a-f0-9]{64}/)[0];
  const done = await post(link, {});
  assert.equal(done.status, 302);
  return srv.cookieFrom(done);
}
// Subjects can be folded across lines, so match on the decoded text.
const mailTo = (to, text) => srv.waitForEmail((m) => m.includes(`To: ${to}`) && decodeEmail(m).replace(/\s+/g, ' ').includes(text));
const appealLink = async (to, text) => decodeEmail(await mailTo(to, text)).match(/\/appeal\/[a-f0-9]{48}/)[0];

const SCAM = {
  id: 'ts-scam', title: 'Data Entry Work From Home', company: 'Quick Jobs', location: 'Remote', mode: 'Remote', type: 'Part-time', category: 'Customer Support & BPO', experience: '', salary: '',
  posted: '2026-10-01', status: 'open', skills: [], sample: false, responsibilities: [],
  description: 'Guaranteed job, no interview. Pay a registration fee of Rs 2000 to join. Message us on wa.me/919999999999 to start today.',
};

before(async () => {
  const starter = require('../data/jobs.json').map((j) => ({ ...j, sample: false }));
  const original = starter[0];
  // The same text as a real listing, under another company's name.
  const copy = { ...original, id: 'ts-copy', company: 'Not The Real Company' };
  srv = await startServer({ TRUST_PROXY: '1', TRUST_SCAN_MS: '300' }, { jobs: [...starter, SCAM, copy] });
  id.first = original.id;
  id.second = starter[1].id;
  p.admin = await srv.adminLogin();
  p.admin = await enable2fa(p.admin);
  p.mo = await member('Mo', 'mo@hireriv.test', 'Job Moderator');
  p.vera = await member('Vera', 'vera@hireriv.test', 'Verification Reviewer');
  p.sue = await member('Sue', 'sue@hireriv.test', 'Support Agent');
  p.tess = await member('Tess', 'tess@hireriv.test', 'Trust & Safety Manager');
  p.opal = await member('Opal', 'opal@hireriv.test', 'Operations Admin');
  p.aud = await member('Aud', 'aud@hireriv.test', 'Auditor');
  p.rita = await member('Rita', 'rita@hireriv.test', 'Recruiter', { twoStep: false });
  for (const n of ['mo', 'vera', 'sue', 'tess']) id[n] = rec('team', (u) => u.email === `${n}@hireriv.test`).id;
}, { timeout: 60000 });
after(() => { if (process.env.SHOW_OUT) console.log(srv.output()); return srv && srv.stop(); });

test('automated checks spot scam signals and copies, and never decide anything themselves', () => {
  const base = { id: 'a', title: 'Warehouse Picker', company: 'Acme', description: 'Pick and pack orders in our Pune warehouse. Day shift.', responsibilities: ['Pick orders'] };
  assert.deepEqual(flagsFor(base, []), []);
  const codes = (job, others = []) => flagsFor(job, others).map((f) => f.code).sort();
  assert.deepEqual(codes({ ...base, description: 'Refundable deposit of Rs 500. Join https://bit.ly/xyz or t.me/jobs' }), ['chat-link', 'payment-request', 'short-link']);
  assert.deepEqual(codes({ ...base, description: 'Please send your Aadhaar and bank details on WhatsApp before the interview.' }), ['personal-data']);
  assert.deepEqual(codes({ ...base, payNote: 'Earn ₹5000 per day, daily payout' }), ['too-good']);
  assert.deepEqual(codes({ ...base, description: 'Apply at http://10.0.0.7/apply' }), ['ip-link']);
  const other = (o) => ({ id: o.id, employerId: o.employerId || '', company: o.company, posted: o.posted || '', fp: fingerprint(o) });
  assert.deepEqual(codes(base, [other({ ...base, id: '0', company: 'Someone Else' })]), ['copied']);
  assert.deepEqual(codes(base, [other({ ...base, id: '0', company: 'Someone Else', posted: '2099-01-01' })]), [], 'only the later copy is flagged');
  assert.deepEqual(codes(base, [other({ ...base, id: '0' })]), ['duplicate']);
  // Severity guides priority; nothing here changes a job.
  assert.equal(flagsFor({ ...base, description: 'Pay registration fee' }, [])[0].severity, 'high');
});

test('operational monitoring keeps no personal data and records background jobs', async () => {
  assert.equal(ops.cleanMessage('Failed for priya@novafoods.in at E:\\Hireriv\\data\\x.db token 9f86d081884c7d659a2feaa0c55ad015 phone +91 98220 00001'), 'Failed for [email] at [path] token [token] phone [number]');
  const m = ops.create();
  let n = 0;
  const job = m.track('demo', () => { n++; if (n === 2) throw new Error('broke for a@b.in'); return n; }, 1000);
  assert.equal(job(), 1);
  assert.throws(() => job(), /broke/);
  const [j] = m.snapshot().jobs;
  assert.equal(j.runs, 2);
  assert.equal(j.failures, 1);
  assert.equal(j.failing, true);
  assert.equal(j.lastError, 'broke for [email]');
  m.recordError({ method: 'GET', route: { path: '/jobs/:id' }, baseUrl: '' }, new Error('Cannot read x of priya@example.in'));
  assert.deepEqual(m.snapshot().recentErrors.map((e) => [e.route, e.message]), [['GET /jobs/:id', 'Cannot read x of [email]']]);
});

test('trust roles need two-step sign-in and see only their own pages', async () => {
  // Before two-step sign-in is on, only the set-up page opens.
  const newbie = await member('Nia', 'nia@hireriv.test', 'Support Agent', { twoStep: false });
  assert.equal((await get('/admin/reports', newbie)).headers.get('location'), '/admin/security');
  assert.equal((await call('/api/admin/cases', 'GET', undefined, newbie)).status, 403);
  assert.match(await (await get('/admin/security', newbie)).text(), /requires two-step sign-in/);

  assert.equal((await get('/admin', p.mo)).headers.get('location'), '/admin/overview');
  assert.equal((await get('/admin/job-moderation', p.mo)).status, 200);
  assert.equal((await get('/admin?tab=jobs', p.mo)).headers.get('location'), '/admin/overview');
  for (const u of ['/admin/verifications', '/admin/audit-logs', '/admin/system-health', '/admin/access-control', '/admin/jobs/new', '/admin/crm', '/admin/workspace']) assert.equal((await get(u, p.mo)).status, 403, u);
  assert.equal((await get('/admin/audit-logs', p.aud)).status, 200);
  assert.equal((await get('/admin/access-control', p.aud)).status, 200);
  assert.equal((await get('/admin/reports', p.aud)).status, 403);
  assert.equal((await post('/admin/access-control/policy', { unverifiedPendingLimit: '1', flagLevel: 'low', urgentReports: '2', reason: 'testing' }, p.aud)).status, 403);
  assert.equal((await call('/api/admin/cases', 'GET', undefined, p.aud)).status, 403);
  assert.equal((await call('/api/admin/system-health', 'GET', undefined, p.opal)).status, 200);
  assert.equal((await get('/admin/reports', p.opal)).status, 403);
  // Recruiters keep reviewing jobs sent in, but not complaints or trust pages.
  assert.equal((await get('/admin/overview', p.rita)).status, 403);
  assert.equal((await get('/admin/reports', p.rita)).status, 403);
  assert.equal((await call('/api/admin/cases', 'GET')).status, 401);
  assert.equal((await call('/api/admin/system-health', 'GET', undefined, p.rita)).status, 403);
});

test('reports are validated, rate-limited and never reveal who has an account', async () => {
  const fixed = { 'x-forwarded-for': '10.6.0.1' };
  const report = (body, extra = fixed) => call('/api/reports', 'POST', body, undefined, extra);
  assert.equal((await report({ entityType: 'job', entityId: id.first, category: 'nonsense' })).status, 400);
  assert.equal((await report({ entityType: 'robot', entityId: id.first, category: 'scam' })).status, 400);
  // A job that doesn't exist, or a candidate named by a visitor: the same answer, nothing kept.
  const unknown = await report({ entityType: 'job', entityId: 'no-such-job', category: 'scam' });
  const named = await report({ entityType: 'candidate', entityId: 'app-123', category: 'harassment', details: 'Sent rude messages to me' });
  assert.equal(unknown.status, 202);
  assert.deepEqual(named, unknown);
  assert.equal(all('trust-cases').filter((c) => c.source === 'report').length, 0);
  const ok = await report({ entityType: 'job', entityId: id.first, category: 'misleading-terms', details: 'The pay shown is not what they offered', email: 'Ravi@Example.in' });
  assert.deepEqual(ok, unknown);
  // Five a window per address, then 429.
  assert.equal((await report({ entityType: 'job', entityId: id.first, category: 'scam' })).status, 429);

  const c = rec('trust-cases', (x) => x.entityId === id.first && x.source === 'report');
  assert.equal(c.status, 'open');
  assert.equal(c.priority, 'normal');
  assert.equal(c.reports[0].email, 'ravi@example.in');
  assert.equal(c.reports[0].reporterType, 'visitor');
  id.caseFirst = c.id;
  // The same person again doesn't count twice; two more people make it urgent.
  await report({ entityType: 'job', entityId: id.first, category: 'misleading-terms', email: 'ravi@example.in' }, headers());
  assert.equal(rec('trust-cases', (x) => x.id === c.id).reports.length, 1);
  await report({ entityType: 'job', entityId: id.first, category: 'misleading-terms', email: 'meena@example.in' }, headers());
  await report({ entityType: 'job', entityId: id.first, category: 'misleading-terms', email: 'kabir@example.in' }, headers());
  const urgent = rec('trust-cases', (x) => x.id === c.id);
  assert.equal(urgent.reports.length, 3);
  assert.equal(urgent.priority, 'high');
  assert.ok(all('notifications', (n) => n.type === 'trust-case' && n.event === `trust-urgent:${c.id}`).length >= 1, 'managers hear about it');

  // The job page's existing form opens a case too (and keeps its inbox and email).
  const legacy = await srv.request(`/api/jobs/${id.second}/report`, { method: 'POST', form: { reason: 'Asks candidates to pay money', details: 'They asked for 3000 rupees for training' }, headers: headers({ accept: 'application/json' }) });
  assert.equal(legacy.status, 200);
  const paid = await until(() => rec('trust-cases', (x) => x.entityId === id.second));
  assert.equal(paid.category, 'payment-request');
  assert.equal(paid.priority, 'high');
  assert.ok(paid.reports[0].jobReportId);
  assert.ok(rec('job-reports', (r) => r.id === paid.reports[0].jobReportId));

  // The bot trap: accepted silently, nothing kept.
  const before = all('trust-cases').length;
  assert.equal((await report({ entityType: 'job', entityId: 'ts-copy', category: 'scam', website: 'http://spam' }, headers())).status, 202);
  assert.equal(all('trust-cases').length, before);

  // Evidence: only real PDFs and images.
  const upload = (name, bytes) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries({ entityType: 'job', entityId: id.second, category: 'payment-request', details: 'Screenshot of their message' })) fd.append(k, v);
    fd.append('evidence', new Blob([bytes]), name);
    return srv.request('/api/reports', { method: 'POST', body: fd, headers: headers({ accept: 'application/json' }) });
  };
  assert.equal((await upload('payload.exe', 'MZ\x90\x00')).status, 400);
  const fake = await upload('proof.pdf', 'not really a pdf');
  assert.equal(fake.status, 400);
  assert.match(JSON.stringify(await fake.json()), /doesn't look like a real PDF/);
  assert.equal((await upload('proof.pdf', '%PDF-1.4\n%fake but signed\n')).status, 202);
  assert.equal(rec('trust-cases', (x) => x.id === paid.id).evidence.length, 1);
});

test('automated flags open a case for review and leave the listing live', async () => {
  const scam = await until(() => rec('trust-cases', (c) => c.entityId === 'ts-scam' && c.source === 'automated'));
  assert.ok(scam, 'a case was opened');
  assert.deepEqual(scam.flags.map((f) => f.code).sort(), ['chat-link', 'payment-request', 'too-good']);
  assert.equal(scam.priority, 'high');
  assert.equal(rec('jobs', (j) => j.id === 'ts-scam').status, 'open', 'a flag is not a verdict');
  assert.equal((await srv.request('/api/jobs/ts-scam')).status, 200);
  const copied = await until(() => rec('trust-cases', (c) => c.entityId === 'ts-copy' && c.source === 'automated'));
  assert.equal(copied.category, 'impersonation');
  const q = await call('/api/admin/moderation/jobs?kind=flagged', 'GET', undefined, p.mo);
  assert.ok(q.jobs.some((j) => j.id === 'ts-scam' && j.level === 'high'));
  // The moderator removes it: gone from listings, and its page says so.
  assert.equal((await call('/api/admin/moderation/jobs/ts-scam/decision', 'POST', { decision: 'remove' }, p.mo)).status, 400, 'a reason is required');
  const removed = await call('/api/admin/moderation/jobs/ts-scam/decision', 'POST', { decision: 'remove', reason: 'Charges candidates a registration fee', expectedStatus: 'open' }, p.mo);
  assert.equal(removed.status, 200);
  assert.equal(removed.job.moderation.state, 'removed');
  assert.equal((await srv.request('/jobs/ts-scam')).status, 410);
  assert.equal((await srv.request('/api/jobs/ts-scam')).status, 404);
  assert.match(rec('trust-cases', (c) => c.id === scam.id).history.map((h) => h.text).join('|'), /Listing decision: Remove/);
  // Restricted listings can't be switched back on from the Jobs tab.
  assert.match(msg(await post('/admin/jobs/ts-scam/toggle', {}, p.admin)), /removed by trust & safety/);
});

test('employer verification: ask for more, the answer comes back, one decision, a declined company can appeal', async () => {
  p.shady = await signup({ company: 'Shady Traders', name: 'Sham Rao', email: 'sham@shadytraders.in', phone: '9822000222', gstin: '27AAPFU0939F1ZV' });
  const empId = rec('employers', (e) => e.email === 'sham@shadytraders.in').id;
  assert.equal((await call('/api/admin/verifications', 'GET', undefined, p.mo)).status, 403);
  const list = await call('/api/admin/verifications', 'GET', undefined, p.vera);
  const check = list.verifications.find((v) => v.employerId === empId);
  assert.ok(check);
  assert.equal(check.status, 'pending');
  assert.ok(check.signals.includes('No website'));

  const decide = (body, cookie = p.vera) => call(`/api/admin/verifications/${check.id}/decision`, 'POST', body, cookie);
  assert.equal((await decide({ decision: 'maybe' })).status, 400);
  assert.equal((await decide({ decision: 'request-info' })).status, 400);
  const asked = await decide({ decision: 'request-info', reason: 'Please add your company website or a CIN.' });
  assert.equal(asked.status, 200);
  assert.equal(asked.verification.status, 'info-requested');
  assert.equal((await decide({ decision: 'request-info', reason: 'Again please' })).status, 409);
  await mailTo('sham@shadytraders.in', 'We need more information to verify your company');
  assert.match(await (await get('/employer/company', p.shady)).text(), /Our team needs more information/);

  // The company answers; the check is back in the queue with the answer.
  await post('/employer/company/verify', { reply: 'Our website is being built; the GSTIN is on our invoices.' }, p.shady);
  const back = rec('employer-verifications', (v) => v.id === check.id);
  assert.equal(back.status, 'pending');
  assert.match(back.reply, /GSTIN is on our invoices/);

  // Two reviewers at once: one decision counts.
  const [a, b] = await Promise.all([decide({ decision: 'decline', reason: 'Could not confirm the company exists.', expectedStatus: 'pending' }), decide({ decision: 'decline', reason: 'No trace of this company online.', expectedStatus: 'pending' }, p.tess)]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const done = rec('employer-verifications', (v) => v.id === check.id);
  assert.equal(done.status, 'declined');
  assert.ok(done.reviewedBy && done.reviewedById && done.reviewedAt, 'reviewer and time are recorded');
  assert.equal((await decide({ decision: 'verify' })).status, 409, 'decided once');
  assert.equal(rec('employers', (e) => e.id === empId).active, false);
  assert.ok(rec('trust-audit', (e) => e.action === 'verification-declined' && e.entityId === empId && e.actorName === done.reviewedBy));

  const link = await appealLink('sham@shadytraders.in', 'We could not approve your account');
  assert.equal((await post(link, { statement: 'Too short' })).status, 400);
  assert.equal((await post(link, { statement: 'We are a registered trading firm since 2019. Our GSTIN is valid and we can share the registration certificate.' })).status, 200);
  assert.equal((await post(link, { statement: 'Sending this a second time to be sure it arrived with you.' })).status, 409);
  const appeal = rec('trust-appeals', (x) => x.entityId === empId && x.status === 'pending');
  // Not for verification reviewers, and never the person who decided.
  assert.equal((await call(`/api/admin/appeals/${appeal.id}/decision`, 'POST', { outcome: 'overturned', reason: 'Looks fine' }, p.vera)).status, 403);
  // Whoever declined can't decide the appeal; someone else with the role can.
  const [mine, theirs] = done.reviewedById === id.tess ? [p.tess, p.admin] : [p.admin, p.tess];
  if (done.reviewedById === id.tess) assert.equal((await call(`/api/admin/appeals/${appeal.id}/decision`, 'POST', { outcome: 'overturned', reason: 'Looks fine to me' }, mine)).status, 403);
  const over = await call(`/api/admin/appeals/${appeal.id}/decision`, 'POST', { outcome: 'overturned', reason: 'The GSTIN checks out on the GST portal.' }, theirs);
  assert.equal(over.status, 200);
  assert.equal(over.appeal.status, 'overturned');
  assert.equal(rec('employers', (e) => e.id === empId).active, true);
  assert.ok(all('employer-verifications', (v) => v.employerId === empId && v.status === 'pending').length, 'back in the queue');
  await mailTo('sham@shadytraders.in', 'We changed our decision');
});

test('moderating an employer job: approve, restrict with history and appeal, someone else overturns', async () => {
  p.acme = await signup({ company: 'Acme Foods Pvt Ltd', name: 'Meera Shah', email: 'meera@acmefoods.in', phone: '9822000111', gstin: '27AAPFU0939F1ZV', website: 'https://acmefoods.in' });
  id.acme = rec('employers', (e) => e.email === 'meera@acmefoods.in').id;
  await srv.verifyEmployerMobile(p.acme, headers());
  // The Clients tab still verifies, and the decision lands in the audit trail.
  assert.equal((await post(`/admin/clients/${id.acme}/approve`, {}, p.rita)).status, 403, 'recruiters no longer verify companies');
  await post(`/admin/clients/${id.acme}/approve`, {}, p.admin);
  assert.ok(rec('trust-audit', (e) => e.action === 'verification-verified' && e.entityId === id.acme));
  await post('/employer/jobs', { title: 'Packing Supervisor', category: 'Warehouse & Packing', location: 'Pune', mode: 'On-site', type: 'Full-time', salaryMin: '22000', salaryMax: '28000', salaryPeriod: 'month', shift: 'Day', description: 'Lead a packing team of 20 people on the day shift.', responsibilities: 'Plan the packing line\nCheck quality', action: 'publish' }, p.acme);
  const job = rec('jobs', (j) => j.title === 'Packing Supervisor');
  id.acmeJob = job.id;
  assert.equal(job.status, 'pending');
  const decide = (body, cookie = p.mo) => call(`/api/admin/moderation/jobs/${job.id}/decision`, 'POST', body, cookie);
  assert.equal((await decide({ decision: 'approve', expectedStatus: 'open' })).status, 409);
  assert.equal((await decide({ decision: 'approve', expectedStatus: 'pending' })).status, 200);
  assert.equal(rec('jobs', (j) => j.id === job.id).status, 'open');

  // Two moderators restrict at the same moment: one wins.
  const [r1, r2] = await Promise.all([
    decide({ decision: 'restrict', reason: 'The pay shown is far below what candidates were told', expectedStatus: 'open' }, p.tess),
    decide({ decision: 'restrict', reason: 'Duplicate decision', expectedStatus: 'open' }),
  ]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);
  const locked = rec('jobs', (j) => j.id === job.id);
  assert.equal(locked.status, 'closed');
  assert.equal(locked.moderation.state, 'restricted');
  assert.equal(locked.moderation.prevStatus, 'open');
  assert.equal(locked.moderationHistory.length, 1);
  assert.equal((await srv.request(`/api/jobs/${job.id}`)).status, 404);
  // The employer can't send it straight back; the email offers an appeal.
  assert.match(msg(await post(`/employer/jobs/${job.id}/publish`, {}, p.acme)), /restricted by our moderators/);
  const link = await appealLink('meera@acmefoods.in', 'We unpublished a listing');
  assert.match(await (await srv.request(link)).text(), /Why is the decision wrong/);
  assert.equal((await post(link, { statement: 'We corrected the pay range in our offer letters; the listing matches what we pay now.' })).status, 200);
  const appeal = rec('trust-appeals', (a) => a.entityId === job.id && a.status === 'pending');
  const decider = locked.moderation.byId;
  const deciderCookie = decider === id.tess ? p.tess : p.admin;
  const other = decider === id.tess ? p.admin : p.tess;
  if (decider === id.tess) assert.equal((await call(`/api/admin/appeals/${appeal.id}/decision`, 'POST', { outcome: 'overturned', reason: 'Fine by me' }, deciderCookie)).status, 403, 'not the person who decided');
  const over = await call(`/api/admin/appeals/${appeal.id}/decision`, 'POST', { outcome: 'overturned', reason: 'The pay now matches the offer letters.', version: appeal.version }, other);
  assert.equal(over.status, 200);
  const restored = rec('jobs', (j) => j.id === job.id);
  assert.equal(restored.status, 'open');
  assert.equal(restored.moderation, undefined);
  assert.equal(restored.moderationHistory.length, 2, 'the decision and its reversal both stay in the history');
  assert.equal((await call(`/api/admin/appeals/${appeal.id}/decision`, 'POST', { outcome: 'upheld', reason: 'Changed my mind' }, other)).status, 409);
  for (const action of ['job-restricted', 'appeal-submitted', 'appeal-overturned', 'job-restored']) assert.ok(rec('trust-audit', (e) => e.action === action && e.entityId === job.id), action);
});

test('cases: versions stop overwrites, support agents see only theirs, escalation and closing with a reason', async () => {
  const caseUrl = `/api/admin/cases/${id.caseFirst}`;
  assert.equal((await call(caseUrl, 'GET', undefined, p.sue)).status, 404, 'not assigned to Sue');
  assert.equal((await call(caseUrl, 'GET', undefined, p.aud)).status, 403);
  const start = await call(caseUrl, 'GET', undefined, p.tess);
  assert.equal(start.case.reports.length, 3);
  const v = start.case.version;
  assert.equal((await call(caseUrl, 'PATCH', { assigneeId: id.sue }, p.tess)).status, 400, 'version is required');
  assert.equal((await call(caseUrl, 'PATCH', { assigneeId: 'nobody-real', version: v }, p.tess)).status, 400);
  assert.equal((await call(caseUrl, 'PATCH', { assigneeId: id.sue, version: v - 1 }, p.tess)).status, 409);
  const [x, y] = await Promise.all([call(caseUrl, 'PATCH', { assigneeId: id.sue, version: v }, p.tess), call(caseUrl, 'PATCH', { status: 'under_review', version: v }, p.admin)]);
  assert.deepEqual([x.status, y.status].sort(), [200, 409]);
  if (x.status !== 200) assert.equal((await call(caseUrl, 'PATCH', { assigneeId: id.sue, version: y.case.version }, p.tess)).status, 200);
  assert.ok(all('notifications', (n) => n.type === 'trust-case' && n.event.startsWith(`trust-assign:${id.caseFirst}`)).length);

  const mine = await call(caseUrl, 'GET', undefined, p.sue);
  assert.equal(mine.status, 200);
  assert.equal((await call(caseUrl, 'PATCH', { assigneeId: id.mo, version: mine.case.version }, p.sue)).status, 400, 'only managers assign');
  assert.equal((await call(`${caseUrl}/actions`, 'POST', { action: 'suspend-employer', reason: 'Trying it' }, p.sue)).status, 403);
  assert.equal((await call(`${caseUrl}/actions`, 'POST', { action: 'note', reason: 'Called the employer, waiting to hear back.' }, p.sue)).status, 200);
  assert.equal((await call(`${caseUrl}/actions`, 'POST', { action: 'escalate', reason: 'Three people say the pay is wrong.' }, p.sue)).status, 200);
  assert.ok(all('notifications', (n) => n.type === 'trust-case' && n.event.startsWith(`trust-escalate:${id.caseFirst}`)).length);
  assert.equal((await call(`${caseUrl}/actions`, 'POST', { action: 'resolve', reason: '' }, p.sue)).status, 400);
  const resolved = await call(`${caseUrl}/actions`, 'POST', { action: 'resolve', reason: 'The employer corrected the pay on the listing.', notifyReporter: true }, p.sue);
  assert.equal(resolved.status, 200);
  assert.equal(resolved.case.status, 'resolved');
  assert.equal(resolved.case.resolution.by, 'Sue');
  const told = decodeEmail(await srv.waitForEmail((m) => m.includes('To: ravi@example.in') && m.includes('Your report TS-')));
  assert.doesNotMatch(told, /corrected the pay/, 'reporters are not told what happened to the other party');
  assert.equal((await call(`${caseUrl}/actions`, 'POST', { action: 'escalate', reason: 'Once more' }, p.sue)).status, 409);
  assert.equal((await call(caseUrl, 'PATCH', { status: 'under_review', version: resolved.case.version }, p.sue)).status, 400, 'only managers reopen');
  // Moderators see job cases; the list API pages.
  const listed = await call('/api/admin/cases?status=all', 'GET', undefined, p.mo);
  assert.ok(listed.cases.every((c) => c.entityType === 'job'));
  assert.ok(listed.total >= 3);
});

test('suspending is reversible; closing an account needs a second person with two-step sign-in', async () => {
  await call('/api/reports', 'POST', { entityType: 'employer', entityId: id.acmeJob, category: 'impersonation', details: 'They said they were hiring for a famous brand they do not work for.' }, undefined, headers());
  const c = await until(() => rec('trust-cases', (x) => x.entityType === 'employer' && x.entityId === id.acme));
  const act = (body, cookie = p.tess) => call(`/api/admin/cases/${c.id}/actions`, 'POST', body, cookie);

  // An Admin without two-step sign-in can't take strong actions.
  const ann = await member('Ann', 'ann@hireriv.test', 'Admin', { twoStep: false });
  assert.match(JSON.stringify(await act({ action: 'suspend-employer', reason: 'Testing' }, ann)), /two-step sign-in/);

  assert.equal((await act({ action: 'suspend-employer', reason: 'Investigating an impersonation report' })).status, 200);
  const suspended = rec('employers', (e) => e.id === id.acme);
  assert.equal(suspended.active, false);
  assert.ok(suspended.suspension);
  assert.equal(rec('jobs', (j) => j.id === id.acmeJob).moderation.state, 'account-suspended');
  assert.notEqual((await get('/employer', p.acme)).status, 200, 'the company is signed out');
  assert.match(msg(await post(`/admin/clients/${id.acme}/toggle`, {}, p.admin)), /suspended by trust & safety/);
  await mailTo('meera@acmefoods.in', 'Your company account is suspended');

  assert.equal((await act({ action: 'reinstate-employer', reason: 'The brand confirmed they are an authorised agency' })).status, 200);
  assert.equal(rec('employers', (e) => e.id === id.acme).active, true);
  assert.equal(rec('jobs', (j) => j.id === id.acmeJob).status, 'open');

  assert.equal((await act({ action: 'terminate-employer', reason: 'Repeated fake listings after a warning' })).status, 200);
  assert.equal(rec('employers', (e) => e.id === id.acme).active, true, 'nothing happens until someone else approves');
  assert.equal((await act({ action: 'terminate-employer', reason: 'Again' })).status, 409);
  assert.equal((await act({ action: 'approve-pending', reason: 'Approving my own request' })).status, 403);
  assert.ok(all('notifications', (n) => n.type === 'trust-case' && n.event.startsWith('trust-closure:')).length);
  const ok = await act({ action: 'approve-pending', reason: 'Checked the evidence; agree to close.' }, p.admin);
  assert.equal(ok.status, 200);
  const closed = rec('employers', (e) => e.id === id.acme);
  assert.equal(closed.active, false);
  assert.ok(closed.terminatedAt);
  assert.match(closed.terminatedBy, /Tess, approved by/);
  assert.equal(rec('jobs', (j) => j.id === id.acmeJob).status, 'closed');
  assert.equal((await act({ action: 'reinstate-employer', reason: 'Undo this closure' })).status, 409);
  const entry = rec('trust-audit', (e) => e.action === 'employer-closed' && e.entityId === id.acme);
  assert.match(entry.detail, /asked by Tess, approved by/);
  await mailTo('meera@acmefoods.in', 'Your company account is closed');
});

test('policy changes need a reason and change the limit for companies not yet verified', async () => {
  assert.match(msg(await post('/admin/access-control/policy', { unverifiedPendingLimit: '1', flagLevel: 'medium', urgentReports: '3' }, p.admin)), /give a reason/);
  assert.match(msg(await post('/admin/access-control/policy', { unverifiedPendingLimit: '1', flagLevel: 'medium', urgentReports: '3', reason: 'Too many fake sign-ups this week' }, p.admin)), /Policy saved/);
  assert.match(rec('trust-audit', (e) => e.action === 'policy-changed').detail, /unverifiedPendingLimit: 5 → 1/);
  assert.match(await (await get('/admin/verifications', p.vera)).text(), /up to <b>1<\/b> job waiting/);
});

test('system health shows status without secrets or customer data', async () => {
  const h = await call('/api/admin/system-health', 'GET', undefined, p.opal);
  assert.equal(h.status, 200);
  assert.ok(['ok', 'degraded'].includes(h.health.status));
  assert.equal(h.health.database.ok, true);
  assert.ok(h.health.backgroundJobs.some((j) => j.name === 'trust-scan' && j.runs > 0));
  const text = JSON.stringify(h);
  for (const bad of [ADMIN_PASS, '@', 'hireriv-test-', 'secret', 'passwordHash', 'sessions']) assert.ok(!text.includes(bad), `no ${bad}`);
  assert.equal((await get('/admin/system-health', p.opal)).status, 200);
  assert.match(msg(await post('/admin/system-health/deliveries/nope/retry', {}, p.opal)), /not waiting/);
  assert.equal((await get('/admin/overview', p.opal)).status, 200);
});

test('the audit trail is read-only and shows tampering', async () => {
  const log = await call('/api/admin/audit-logs?source=trust', 'GET', undefined, p.aud);
  assert.equal(log.status, 200);
  assert.equal(log.chain.ok, true);
  assert.ok(log.entries.length >= 10);
  assert.ok(log.entries.every((e) => e.source === 'trust'));
  const everything = await call('/api/admin/audit-logs?q=Tess', 'GET', undefined, p.aud);
  assert.ok(everything.total >= 1);
  // No route edits or deletes entries.
  const e = srv.records('trust-audit')[0];
  assert.equal((await post(`/admin/trust-audit/${e.id}/delete`, {}, p.admin)).status, 404);
  // Changing a stored entry directly breaks the chain.
  const db = new DatabaseSync(srv.paths.db);
  try {
    const row = db.prepare("SELECT id, data FROM records WHERE collection = 'trust-audit' ORDER BY pos DESC LIMIT 1").get();
    const data = JSON.parse(row.data);
    data.reason = 'quietly changed';
    db.prepare("UPDATE records SET data = ? WHERE collection = 'trust-audit' AND id = ?").run(JSON.stringify(data), row.id);
  } finally { db.close(); }
  const broken = await call('/api/admin/audit-logs', 'GET', undefined, p.aud);
  assert.equal(broken.chain.ok, false);
  assert.match(broken.chain.problem, /was changed/);
});
