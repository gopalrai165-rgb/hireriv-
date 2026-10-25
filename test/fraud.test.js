// Step 64: employer verification, fraud prevention and job quality. An
// explainable risk engine that only opens and escalates cases, pauses a
// listing that copies another company's text and holds bursts of postings;
// company verification with a representative and encrypted business
// documents opened through logged links; checks again when a verified
// company changes its identity; quality checks before a job goes for review;
// reports of jobs and companies with a reference and a private tracking page;
// a posting hold a company can appeal; the combined queue; and public labels
// that say exactly what was checked, never a guarantee.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, decodeEmail } = require('./helpers');
const tf = require('../twofactor');
const risk = require('../risk');

let srv;
const p = {};
const id = {};
let ip = 0;
const headers = (extra = {}) => ({ 'x-forwarded-for': `10.9.${Math.floor(++ip / 250)}.${ip % 250}`, ...extra });
const get = (url, cookie, extra = {}) => srv.request(url, { cookie, headers: headers({ accept: 'text/html', ...extra }) });
const post = (url, form, cookie) => srv.request(url, { method: 'POST', form, cookie, headers: headers() });
const call = async (url, method, body, cookie, extra = {}) => {
  const r = await srv.request(url, { method, cookie, body: body === undefined ? undefined : JSON.stringify(body), headers: headers({ 'content-type': 'application/json', accept: 'application/json', ...extra }) });
  const text = await r.text();
  let data = {};
  try { data = JSON.parse(text); } catch (e) { data = { text }; }
  return { ...data, status: r.status };
};
const multipart = async (url, fields, files, cookie) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const x of [].concat(v)) fd.append(k, x);
  for (const f of files) fd.append(f.field, new Blob([f.bytes]), f.name);
  const r = await srv.request(url, { method: 'POST', body: fd, cookie, headers: headers({ accept: 'application/json' }) });
  return { ...(await r.json()), status: r.status };
};
const rec = (collection, fn) => srv.records(collection).find(fn);
const all = (collection, fn = () => true) => srv.records(collection).filter(fn);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) {
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
async function member(name, email, role) {
  await post('/admin/team', { name, email, role }, p.admin);
  const link = decodeEmail(await srv.waitForEmail((e) => e.includes(`To: ${email}`))).match(/\/admin\/setup\/[a-f0-9]{64}/)[0];
  return enable2fa(srv.cookieFrom(await post(link, { password: `${name} long password`, confirm: `${name} long password` })));
}
async function signup(form) {
  await post('/employer/register', { industry: 'Hospitality & Food', size: '51-200', password: 'long enough phrase', confirm: 'long enough phrase', agree: '1', ...form });
  const mail = await srv.waitForEmail((m) => m.includes(`To: ${form.email}`) && m.includes('Confirm your email'));
  const done = await post(decodeEmail(mail).match(/\/employer\/verify\/[a-f0-9]{64}/)[0], {});
  return srv.cookieFrom(done);
}
const mailTo = (to, text) => srv.waitForEmail((m) => m.includes(`To: ${to}`) && decodeEmail(m).replace(/\s+/g, ' ').includes(text));
const PDF = '%PDF-1.4\n%business registration\n';
const FIELD_JOB = { title: 'Warehouse Loader', category: 'Warehouse & Packing', location: 'Pune', description: 'Load and unload trucks at our Pune warehouse.' };

before(async () => {
  const starter = require('../data/jobs.json').map((j) => ({ ...j, sample: false }));
  const original = starter[0];
  // Nearly the same words as a real listing, under another company's name.
  const near = { ...original, id: 'fr-near', company: 'Lookalike Ventures', posted: '2026-10-05', description: original.description.replace(/^\w+/, 'Design') };
  srv = await startServer({ TRUST_PROXY: '1', TRUST_SCAN_MS: '300' }, { jobs: [...starter, near] });
  id.original = original.id;
  p.admin = await enable2fa(await srv.adminLogin());
  p.mo = await member('Mo', 'mo@hireriv.test', 'Job Moderator');
  p.vera = await member('Vera', 'vera@hireriv.test', 'Verification Reviewer');
  p.tess = await member('Tess', 'tess@hireriv.test', 'Trust & Safety Manager');
  p.acme = await signup({ company: 'Acme Foods Pvt Ltd', name: 'Meera Shah', email: 'meera@acmefoods.in', phone: '9822000111', gstin: '27AAPFU0939F1ZV', website: 'https://acmefoods.in' });
  id.acme = rec('employers', (e) => e.email === 'meera@acmefoods.in').id;
  await srv.verifyEmployerMobile(p.acme, headers());
}, { timeout: 90000 });
after(() => { if (process.env.SHOW_OUT) console.log(srv.output()); return srv && srv.stop(); });

test('the risk rules explain themselves, ignore weak signals and never suspend anyone', () => {
  // Only actions a person can undo or review; nothing that suspends or bans.
  assert.deepEqual(Object.keys(risk.ACTIONS).filter((k) => /suspend|ban|terminate|close/.test(k)), []);
  // Weak signals are context, never counted.
  const emp = { company: 'Tiny Co', freeEmail: true, website: '', gstin: '' };
  assert.deepEqual(risk.employerRules(emp, { policy: { postingBurst: 10, urgentReports: 3 } }), []);
  assert.deepEqual(risk.employerContext(emp), ['Signed up with a personal mailbox', 'No GSTIN, CIN or Udyam number', 'No website']);
  // Independent reports and upheld decisions do count, with their evidence.
  const r = risk.employerRules(emp, { policy: { postingBurst: 10, urgentReports: 3 }, reporters: 3, upheldViolations: 2, recentSubmissions: 12 });
  assert.deepEqual(r.map((x) => [x.code, x.severity, x.action]), [['posting-burst', 'medium', 'posting-limit'], ['many-reports', 'high', 'escalate'], ['repeat-violations', 'high', 'restrict-capabilities']]);
  assert.equal(risk.summarize(r).level, 'high');
  // Short texts that look alike are not called impersonation.
  const short = { id: 'b', title: 'Helper', company: 'B', description: 'Helper needed.', posted: '2026-10-02' };
  const other = { id: 'a', employerId: 'x', company: 'A', posted: '2026-10-01', shingles: risk.shingles({ ...short }) };
  assert.equal(risk.jobRules(short, { flags: [], others: [other] }).length, 0);
  // Applying to a personal mailbox outside the site.
  assert.match(risk.offPlatform({ description: 'Send your CV to hr.acme.jobs@gmail.com today' }, { website: 'https://acmefoods.in' }), /email address/);
  assert.equal(risk.offPlatform({ description: 'Send your CV to jobs@acmefoods.in' }, { website: 'https://acmefoods.in' }), null);
  // Big pay and place changes after publication.
  const ch = risk.changesOf({ pay: { min: 20000, max: 30000 }, salary: '₹20k', location: 'Pune', company: 'Acme' }, { pay: { min: 40000, max: 50000 }, salary: '₹40k', location: 'Mumbai' }, { company: 'Acme' });
  assert.deepEqual(ch.map((c) => c.code), ['pay', 'location']);
});

test('a listing copying another company is paused for a moderator, who decides; the verdict feeds the false-positive rate', async () => {
  const job = await until(() => rec('jobs', (j) => j.id === 'fr-near' && j.reviewHold));
  assert.ok(job, 'paused for a check');
  assert.equal(job.status, 'pending');
  assert.equal(rec('jobs', (j) => j.id === id.original).status, 'open', 'the original stays live');
  const c = rec('trust-cases', (x) => x.entityId === 'fr-near');
  assert.equal(c.category, 'impersonation');
  assert.equal(c.priority, 'high');
  assert.ok(rec('trust-audit', (e) => e.action === 'job-review-hold' && e.entityId === 'fr-near'));
  const a = await call('/api/admin/risk/jobs/fr-near', 'GET', undefined, p.mo);
  assert.equal(a.status, 200);
  assert.equal(a.current.level, 'critical');
  assert.match(a.note, /not proof/);
  assert.ok(a.current.rules.some((r) => r.code === 'impersonation' && r.evidence.includes(id.original)));
  assert.ok(a.current.actions.some((x) => x.code === 'review-hold'));
  assert.equal((await call('/api/admin/risk/jobs/fr-near', 'GET', undefined, p.vera)).status, 404, 'verification reviewers do not see listing assessments');
  const review = await (await get('/admin/job-moderation/fr-near', p.mo)).text();
  assert.match(review, /Paused for a check/);
  assert.match(review, /Risk assessment[\s\S]*Level: critical/);
  // The moderator finds it is a legitimate partner listing and approves it.
  const d = await call('/api/admin/moderation/jobs/fr-near/decision', 'POST', { decision: 'approve' }, p.mo);
  assert.equal(d.status, 200);
  const back = rec('jobs', (j) => j.id === 'fr-near');
  assert.equal(back.status, 'open');
  assert.equal(back.reviewHold, undefined);
  assert.equal(back.reviewHoldHistory[0].releasedBy, 'Mo');
  assert.equal(rec('risk-assessments', (x) => x.entityId === 'fr-near' && !x.supersededAt).review.verdict, 'false-positive');
  const overview = await (await get('/admin/overview', p.tess)).text();
  assert.match(overview, /Risk signals/);
  assert.match(overview, /<b>1<\/b> false positives \(100%\)/);
});

test('job quality: what candidates need is asked for before review, and later changes are flagged', async () => {
  const created = await call('/api/employers/jobs', 'POST', FIELD_JOB, p.acme);
  assert.equal(created.status, 201);
  const sent = await call(`/api/employers/jobs/${created.job.id}/submit`, 'POST', {}, p.acme);
  assert.equal(sent.status, 400);
  assert.match(sent.errors[0], /responsibilities.*pay.*working hours or shift/);
  const fixed = await call(`/api/employers/jobs/${created.job.id}`, 'PATCH', { responsibilities: ['Load trucks safely'], pay: { min: 18000, max: 22000, period: 'month' }, shift: 'Day', overtime: 'Up to 2 hours, paid at double rate', workerCosts: 'None' }, p.acme);
  assert.equal(fixed.status, 200);
  // Not verified yet: it waits, but the company check comes first.
  assert.equal((await call(`/api/employers/jobs/${created.job.id}/submit`, 'POST', {}, p.acme)).status, 200);
  id.loader = created.job.id;
  const stored = rec('jobs', (j) => j.id === id.loader);
  assert.deepEqual([stored.overtime, stored.workerCosts], ['Up to 2 hours, paid at double rate', 'None']);
});

test('company verification: representative and documents, opened only through logged links, escalation and review history', async () => {
  // The address names another company: not found, and nothing kept.
  const other = await multipart('/api/companies/emp-someone-else/verification', { repName: 'Meera Shah' }, [], p.acme);
  assert.equal(other.status, 404);
  const bad = await multipart(`/api/companies/${id.acme}/verification`, { repName: 'M', repDesignation: 'HR', repEmail: 'nope', repPhone: '123' }, [], p.acme);
  assert.equal(bad.status, 400);
  assert.equal(bad.errors.length, 3);
  const untyped = await multipart(`/api/companies/${id.acme}/verification`, {}, [{ field: 'documents', name: 'gst.pdf', bytes: PDF }], p.acme);
  assert.equal(untyped.status, 400);
  assert.match(untyped.errors[0], /Choose what document 1 is/);
  const ok = await multipart(`/api/companies/${id.acme}/verification`, { repName: 'Meera Shah', repDesignation: 'HR Manager', repEmail: 'meera@acmefoods.in', repPhone: '9822000111', docType: ['', 'gst-certificate'] }, [{ field: 'documents', name: 'gst.pdf', bytes: PDF }], p.acme);
  assert.equal(ok.status, 202);
  assert.equal(ok.verification.documents[0].typeLabel, 'GST registration certificate');
  assert.deepEqual(ok.verification.representative, { name: 'Meera Shah', designation: 'HR Manager' }, 'contact details are not sent back');
  const check = rec('employer-verifications', (v) => v.employerId === id.acme && v.status === 'pending');
  const doc = check.documents[0];
  assert.equal(doc.sha256.length, 64);
  // The reviewer sees it with a signed link; each opening is recorded.
  const html = await (await get('/admin/verifications', p.vera)).text();
  assert.match(html, /Meera Shah, HR Manager/);
  assert.match(html, /work email is on the company&#39;s website domain/);
  const link = html.match(/href="(\/admin\/verifications\/[^"]+\/documents\/[^"]+)"/)[1].replace(/&amp;/g, '&');
  assert.equal((await get(link, p.mo)).status, 403, 'job moderators cannot open company documents');
  const file = await get(link, p.vera);
  assert.equal(file.status, 200);
  assert.match(file.headers.get('content-disposition'), /attachment/);
  assert.match(file.headers.get('cache-control'), /no-store/);
  assert.ok(rec('trust-audit', (e) => e.action === 'verification-document-viewed' && e.entityId === id.acme));
  const unsigned = await get(link.split('?')[0], p.vera);
  assert.notEqual(unsigned.status, 200);
  // Escalated for a manager, then verified: both kept in the history.
  assert.equal((await call(`/api/admin/verification/${check.id}/decision`, 'POST', { decision: 'escalate' }, p.vera)).status, 400);
  const esc = await call(`/api/admin/verification/${check.id}/decision`, 'POST', { decision: 'escalate', reason: 'The GST certificate address differs from the signup' }, p.vera);
  assert.equal(esc.status, 200);
  assert.ok(esc.verification.escalated.caseId);
  assert.equal(rec('trust-cases', (c) => c.id === esc.verification.escalated.caseId).escalated, true);
  assert.equal((await call(`/api/admin/verification/${check.id}/decision`, 'POST', { decision: 'escalate', reason: 'again please' }, p.vera)).status, 409);
  const ver = await call(`/api/admin/verification/${check.id}/decision`, 'POST', { decision: 'verify' }, p.tess);
  assert.equal(ver.status, 200);
  assert.deepEqual(ver.verification.reviews.map((x) => x.decision), ['escalate', 'verify']);
  const mine = await call(`/api/companies/${id.acme}/verification`, 'GET', undefined, p.acme);
  assert.equal(mine.verificationStatus, 'verified');
  assert.equal(mine.label.label, 'Verified employer');
  assert.match(mine.label.explain, /registration details and business documents/);
  assert.match(mine.label.note, /not a guarantee/);
  assert.equal((await call('/api/companies/emp-someone-else/verification', 'GET', undefined, p.acme)).status, 404);
});

test('changing the name or registration numbers after verification is checked again', async () => {
  const company = rec('employers', (e) => e.id === id.acme);
  const res = await post('/employer/company', { company: 'Acme Foods India Pvt Ltd', industry: company.industry, size: company.size, website: company.website, gstin: company.gstin }, p.acme);
  assert.equal(res.status, 302);
  const emp = rec('employers', (e) => e.id === id.acme);
  assert.deepEqual(emp.recheck.fields, ['company']);
  assert.ok(emp.approvedAt, 'still verified while the team checks');
  const check = rec('employer-verifications', (v) => v.employerId === id.acme && v.kind === 'recheck' && v.status === 'pending');
  assert.ok(check);
  assert.match((await call(`/api/companies/${id.acme}/verification`, 'GET', undefined, p.acme)).label.label, /new details being checked/);
  assert.equal((await call(`/api/admin/verification/${check.id}/decision`, 'POST', { decision: 'decline', reason: 'Name does not match' }, p.vera)).status, 400);
  assert.equal((await call(`/api/admin/verification/${check.id}/decision`, 'POST', { decision: 'verify' }, p.vera)).status, 200);
  assert.equal(rec('employers', (e) => e.id === id.acme).recheck, undefined);
  assert.ok(rec('trust-audit', (e) => e.action === 'verification-reconfirmed' && e.entityId === id.acme));
});

test('changes to a live job are assessed, and a burst of postings waits for review', async () => {
  // The loader job goes live, then its pay and place change a lot.
  assert.equal((await call(`/api/admin/moderation/jobs/${id.loader}/decision`, 'POST', { decision: 'approve' }, p.mo)).status, 200);
  assert.equal(rec('jobs', (j) => j.id === id.loader).status, 'open');
  const edited = await call(`/api/employers/jobs/${id.loader}`, 'PATCH', { pay: { min: 40000, max: 50000, period: 'month' }, location: 'Mumbai' }, p.acme);
  assert.equal(edited.status, 200);
  assert.deepEqual(rec('jobs', (j) => j.id === id.loader).changeSignals.map((c) => c.code), ['pay', 'location']);
  const a = await until(() => rec('risk-assessments', (x) => x.entityId === id.loader && !x.supersededAt && x.rules.some((r) => r.code === 'changed-pay')));
  assert.ok(a.rules.some((r) => r.code === 'changed-location'));
  // Three in 24 hours at most (policy), then new ones wait.
  assert.equal((await post('/admin/access-control/policy', { unverifiedPendingLimit: '5', flagLevel: 'medium', urgentReports: '3', postingBurst: '3', reason: 'Tighter during a spam wave' }, p.admin)).status, 303);
  const send = async (title) => {
    const c = await call('/api/employers/jobs', 'POST', { ...FIELD_JOB, title, responsibilities: ['Load trucks'], payNote: 'Fixed monthly salary', shift: 'Night' }, p.acme);
    return call(`/api/employers/jobs/${c.job.id}/submit`, 'POST', {}, p.acme);
  };
  assert.equal((await send('Loader B')).status, 200);
  assert.equal((await send('Loader C')).status, 200);
  const held = await send('Loader D');
  assert.equal(held.status, 400);
  assert.match(held.errors[0], /3 jobs for review in the last 24 hours/);
  const ea = await until(() => rec('risk-assessments', (x) => x.entityId === id.acme && x.entityType === 'employer' && !x.supersededAt && x.rules.some((r) => r.code === 'posting-burst')));
  assert.ok(ea.actions.some((x) => x.code === 'posting-limit'));
  assert.ok(!all('trust-audit', (e) => e.entityId === id.acme && /suspend|closed/.test(e.action)).length, 'nothing automatic against the account');
});

test('reports of a job or a company get a reference and a private tracking page, without revealing anything', async () => {
  // Make the loader job live again so the company has a public page.
  assert.equal((await call(`/api/admin/moderation/jobs/${id.loader}/decision`, 'POST', { decision: 'approve' }, p.mo)).status, 200);
  const page = await get(`/companies/${id.acme}`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Verified employer/);
  assert.match(html, /not a guarantee/);
  assert.match(html, /Report this company/);
  assert.match(html, /cybercrime\.gov\.in/);
  assert.doesNotMatch(html, /meera@acmefoods\.in|9822000111/);
  assert.equal((await get('/companies/no-such-company')).status, 404);
  const jobPage = await (await get(`/jobs/${id.loader}`)).text();
  assert.match(jobPage, /What we checked/);
  assert.match(jobPage, /Listing checked by/);
  assert.match(jobPage, /Costs you pay/);

  const report = (url, body) => call(url, 'POST', body, undefined, { 'x-forwarded-for': `10.99.0.${++ip % 250}` });
  const real = await report(`/api/companies/${id.acme}/reports`, { reason: 'Asks candidates to pay money', details: 'They asked me for a ₹2,000 uniform fee', email: 'ravi@example.in' });
  const fake = await report('/api/companies/no-such-company/reports', { reason: 'Asks candidates to pay money', details: 'They asked me for a ₹2,000 uniform fee' });
  assert.equal(real.status, 202);
  assert.deepEqual(Object.keys(real).sort(), Object.keys(fake).sort(), 'the same reply either way');
  assert.match(real.reference, /^R-[0-9A-F]{10}$/);
  assert.match(real.help, /1930/);
  const c = rec('trust-cases', (x) => x.entityType === 'employer' && x.entityId === id.acme && x.reports.length);
  assert.equal(c.reports.find((r) => r.email === 'ravi@example.in').category, 'payment-request');
  const jobReport = await report(`/api/jobs/${id.loader}/reports`, { category: 'suspicious-links', details: 'Sends people to a Telegram group' });
  assert.equal(jobReport.status, 202);
  assert.equal(rec('job-reports', (r) => r.reference === jobReport.reference).jobId, id.loader);
  assert.equal(rec('report-receipts', (r) => r.reference === jobReport.reference).tokenHash.length, 64);
  // The tracking page shows where it has got to, and nothing about the reviewer.
  const track = async (r) => (await get(new URL(r.trackUrl).pathname)).text();
  // This company was already being looked at (the verification escalation), so the report joined that case.
  assert.match(await track(real), new RegExp(`${real.reference}[\\s\\S]*Under review`));
  assert.match(await track(fake), /New/);
  assert.equal((await get(`/reports/track/${'0'.repeat(48)}`)).status, 404);
  id.companyCase = c.id;
  id.realReport = real;
});

test('a moderator can hold new postings; the company appeals and someone else lifts it', async () => {
  const act = (body, cookie = p.tess) => call(`/api/admin/cases/${id.companyCase}/actions`, 'POST', body, cookie);
  assert.equal((await act({ action: 'hold-postings', reason: 'Uniform fee reports from candidates' }, p.mo)).status, 404, 'job moderators handle job cases only');
  const r = await act({ action: 'hold-postings', reason: 'Uniform fee reports from candidates' });
  assert.equal(r.status, 200);
  assert.equal(rec('employers', (e) => e.id === id.acme).postingHold.by, 'Tess');
  assert.equal(rec('employers', (e) => e.id === id.acme).active, true, 'the company can still sign in');
  assert.equal((await act({ action: 'hold-postings', reason: 'again' })).status, 409);
  const c2 = await call('/api/employers/jobs', 'POST', { ...FIELD_JOB, title: 'Loader E', responsibilities: ['Load trucks'], payNote: 'Fixed monthly salary', shift: 'Day' }, p.acme);
  const blocked = await call(`/api/employers/jobs/${c2.job.id}/submit`, 'POST', {}, p.acme);
  assert.equal(blocked.status, 400);
  assert.match(blocked.errors[0], /on hold/);
  // The person who reported sees progress.
  assert.match(await (await get(new URL(id.realReport.trackUrl).pathname)).text(), /Under review/);
  // The owners are told, with an appeal link; Tess decided, so the admin reviews it.
  const mail = await mailTo('meera@acmefoods.in', 'New job postings are on hold');
  const token = decodeEmail(mail).match(/\/appeal\/([a-f0-9]{48})/)[1];
  assert.equal((await post(`/appeal/${token}`, { statement: 'The uniform deposit is refunded in full and we have removed it from our listings.' })).status, 200);
  const ap = rec('trust-appeals', (a) => a.kind === 'employer-postings-held' && a.status === 'pending');
  assert.equal((await call(`/api/admin/appeals/${ap.id}/decision`, 'POST', { outcome: 'overturned', reason: 'Deposit is refundable and removed' }, p.tess)).status, 403);
  assert.equal((await call(`/api/admin/appeals/${ap.id}/decision`, 'POST', { outcome: 'overturned', reason: 'Deposit is refundable and removed' }, p.admin)).status, 200);
  assert.equal(rec('employers', (e) => e.id === id.acme).postingHold, undefined);
});

test('one queue for the team, limited by role, and case updates under a version', async () => {
  const tess = await call('/api/admin/trust/queue', 'GET', undefined, p.tess);
  assert.equal(tess.status, 200);
  assert.ok(tess.items.some((i) => i.kind === 'case' && i.entityId === id.acme));
  assert.ok(tess.items.every((i) => ['case', 'listing', 'verification'].includes(i.kind)));
  const mo = await call('/api/admin/trust/queue', 'GET', undefined, p.mo);
  assert.ok(mo.items.every((i) => i.entityType === 'job'), 'job moderators see listings and job cases only');
  assert.equal((await call('/api/admin/trust/queue', 'GET')).status, 401);
  const c = rec('trust-cases', (x) => x.id === id.companyCase);
  assert.equal((await call(`/api/admin/trust/cases/${c.id}`, 'PATCH', { assigneeId: rec('team', (u) => u.email === 'tess@hireriv.test').id }, p.tess)).status, 400, 'a version is required');
  const ok = await call(`/api/admin/trust/cases/${c.id}`, 'PATCH', { version: c.version, assigneeId: rec('team', (u) => u.email === 'tess@hireriv.test').id }, p.tess);
  assert.equal(ok.status, 200);
  assert.equal(ok.case.assigneeName, 'Tess');
  assert.equal((await call(`/api/admin/trust/cases/${c.id}`, 'PATCH', { version: c.version, priority: 'low' }, p.tess)).status, 409);
});

test('the new pages and code never use the collar words', () => {
  const files = ['risk.js', 'company-trust.js', 'trust.js', 'views/company.ejs', 'views/report-track.ejs', 'views/partials/risk-panel.ejs', 'docs/TRUST.md'];
  for (const f of files) {
    const file = path.join(__dirname, '..', f);
    if (fs.existsSync(file)) assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /(white|blue|grey|gray)[- ]collar/i, f);
  }
});
