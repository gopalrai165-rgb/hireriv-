// Employers signing up themselves (email confirmation, team approval) and
// posting their own jobs, in the portal and through the JSON API, with the
// team reviewing every job before it goes live.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, decodeEmail } = require('./helpers');
const { validGstin, gstinCheckChar, isFreeEmail } = require('../employers');

let srv;
let admin;
before(async () => {
  srv = await startServer({ TRUST_PROXY: '1' });
  admin = await srv.adminLogin();
});
after(() => srv && srv.stop());

let ip = 0;
const post = (url, form, opts = {}) => srv.request(url, { method: 'POST', form, ...opts, headers: { 'x-forwarded-for': `10.8.0.${++ip}`, ...(opts.headers || {}) } });
const json = (url, method, body, cookie, headers = {}) =>
  srv.request(url, { method, cookie, body: JSON.stringify(body), headers: { 'content-type': 'application/json', accept: 'application/json', 'x-forwarded-for': `10.8.1.${++ip}`, ...headers } });
const emp = (email) => srv.records('employers').find((e) => e.email === email);
const job = (id) => srv.records('jobs').find((j) => j.id === id);
// The newest matching email (a new link replaces the one before it).
async function linkIn(match, re) {
  await srv.waitForEmail(match);
  const all = srv.emails().filter(match);
  return decodeEmail(all[all.length - 1]).match(re)[0];
}
const GSTIN = '27AAPFU0939F1ZV';
const signup = { company: 'Acme Foods Pvt Ltd', industry: 'Hospitality & Food', size: '51-200', name: 'Meera Shah', email: 'meera@acmefoods.in', phone: '9822000111', gstin: GSTIN, password: 'long enough phrase', confirm: 'long enough phrase', agree: '1' };
const jobForm = {
  title: 'Packing Supervisor', category: 'Warehouse & Packing', location: 'Pune', mode: 'On-site', type: 'Full-time', experience: '2-4 years',
  salaryMin: '22000', salaryMax: '28000', salaryPeriod: 'month', shift: 'Day', hours: '9 am – 6 pm', description: 'Lead a packing team of 20.', responsibilities: 'Plan shifts\nCheck quality', skills: 'Packing, Team leadership',
};
let meera;

test('GSTIN check characters and personal mailboxes', () => {
  assert.equal(gstinCheckChar('27AAPFU0939F1Z'), 'V');
  assert.equal(validGstin(GSTIN), true);
  assert.equal(validGstin('27AAPFU0939F1ZX'), false);
  assert.equal(validGstin('27AAPFU0939F1Z'), false);
  assert.equal(isFreeEmail('a@gmail.com'), true);
  assert.equal(isFreeEmail('a@acmefoods.in'), false);
});

test('signing up checks the details', async () => {
  const res = await post('/employer/register', { ...signup, gstin: '27AAPFU0939F1ZX', password: 'short', confirm: 'short', agree: '' });
  assert.equal(res.status, 400);
  const html = await res.text();
  for (const m of ['That GSTIN doesn', 'Password must be at least 10 characters', 'Please agree to the Terms']) assert.ok(html.includes(m), m);
  assert.equal(srv.records('employers').length, 0);
});

test('an employer signs up, must confirm the email, then lands in the portal awaiting approval', async () => {
  const res = await post('/employer/register', signup);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Check your email/);
  const e = emp('meera@acmefoods.in');
  assert.equal(e.selfSignup, true);
  assert.equal(e.gstin, GSTIN);
  assert.equal(e.freeEmail, false);
  assert.equal(e.passwordHash, undefined, 'the password belongs to the person, not the company');
  const owner = srv.records('employer-users').find((u) => u.email === signup.email);
  assert.match(owner.passwordHash, /^scrypt\$/);
  assert.equal(srv.records('employer-members').find((m) => m.employerId === e.id).role, 'owner');
  assert.equal(e.approvedAt, null);

  // Logging in before confirming sends a new link instead.
  const early = await post('/employer/login', { email: signup.email, password: signup.password });
  assert.equal(early.status, 403);
  assert.match(await early.text(), /Please confirm your email first/);
  // Wait for that second link: it replaces the first.
  for (let i = 0; i < 100 && srv.emails().filter((m) => m.includes('To: meera@acmefoods.in') && m.includes('Confirm your email')).length < 2; i++) await new Promise((r) => setTimeout(r, 50));

  const verify = await linkIn((m) => m.includes('To: meera@acmefoods.in') && m.includes('Confirm your email'), /\/employer\/verify\/[a-f0-9]{64}/);
  assert.match(await (await srv.request(verify)).text(), /Confirm and continue/);
  const done = await post(verify, {});
  assert.equal(done.status, 302);
  assert.equal(done.headers.get('location'), '/employer?welcome=1');
  meera = srv.cookieFrom(done);
  assert.ok(emp('meera@acmefoods.in').emailVerifiedAt);
  await srv.waitForEmail((m) => m.includes('New employer sign-up to approve: Acme Foods'));
  const portal = await (await srv.request('/employer', { cookie: meera })).text();
  assert.match(portal, /Our team is checking your company/);
  // The confirmation link works once.
  assert.equal((await post(verify, {})).status, 410);
});

test('signing up again with the same email gives the same reply and a heads-up email', async () => {
  const res = await post('/employer/register', { ...signup, company: 'Someone Else' });
  assert.match(await res.text(), /Check your email/);
  assert.equal(srv.records('employers').filter((e) => e.email === signup.email).length, 1);
  await srv.waitForEmail((m) => m.includes('To: meera@acmefoods.in') && m.includes('already have a'));
});

test('jobs from an employer stay hidden until the company and the job are approved', async () => {
  assert.equal((await srv.request('/post-a-job', { cookie: meera })).headers.get('location'), '/employer/jobs/new');
  // A company that signed up itself needs a verified mobile before sending jobs for review.
  const early = await post('/employer/jobs', { ...jobForm, title: 'Early Draft', action: 'publish' }, { cookie: meera });
  assert.match(decodeURIComponent(early.headers.get('location')), /verify your mobile number/);
  assert.equal(srv.records('jobs').find((x) => x.title === 'Early Draft').status, 'draft');
  await srv.verifyEmployerMobile(meera, { 'x-forwarded-for': '10.8.2.1' });
  const res = await post('/employer/jobs', { ...jobForm, minEducation: '12th', perks: ['food', 'stay'], action: 'publish' }, { cookie: meera });
  assert.equal(res.status, 302);
  const j = srv.records('jobs').find((x) => x.title === 'Packing Supervisor');
  assert.equal(j.status, 'pending');
  assert.equal(j.company, 'Acme Foods Pvt Ltd');
  assert.equal(j.employerId, emp(signup.email).id);
  assert.deepEqual(j.pay, { min: 22000, max: 28000, period: 'month', currency: 'INR' });
  assert.deepEqual([j.minEducation, j.perks], ['12th', ['food', 'stay']], 'minimum education and perks are kept');
  await srv.waitForEmail((m) => m.includes('Job to review: Packing Supervisor'));

  assert.equal((await srv.request(`/jobs/${j.id}`)).status, 404);
  assert.equal((await srv.request(`/api/jobs/${j.id}`)).status, 404);
  assert.doesNotMatch(await (await srv.request('/sitemap.xml')).text(), new RegExp(`-${j.id}<`));
  assert.match(await (await srv.request('/admin?tab=jobs', { cookie: admin })).text(), /Needs review/);

  // The company isn't approved yet, so the job can't go live.
  const tooSoon = await post(`/admin/jobs/${j.id}/approve`, {}, { cookie: admin });
  assert.match(decodeURIComponent(tooSoon.headers.get('location')), /Verify Acme Foods Pvt Ltd under Clients first/);
  assert.equal(job(j.id).status, 'pending');

  assert.match(await (await srv.request('/admin?tab=clients', { cookie: admin })).text(), /Awaiting approval/);
  await post(`/admin/clients/${emp(signup.email).id}/approve`, {}, { cookie: admin });
  assert.ok(emp(signup.email).approvedAt);
  await srv.waitForEmail((m) => m.includes('Acme Foods Pvt Ltd is approved'));

  await post(`/admin/jobs/${j.id}/approve`, {}, { cookie: admin });
  assert.equal(job(j.id).status, 'open');
  await srv.waitForEmail((m) => m.includes('Your job is live: Packing Supervisor'));
  const page = await srv.request(`/jobs/${j.id}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Verified employer/);
  assert.equal((await (await srv.request(`/api/jobs/${j.id}`)).json()).job.verifiedEmployer, true);
});

test('jobs API for employers: create, edit, publish, with ownership and validation', async () => {
  assert.equal((await json('/api/jobs', 'POST', jobForm)).status, 401);
  const bad = await json('/api/jobs', 'POST', { ...jobForm, pay: { min: 30000, max: 20000, period: 'month' } }, meera);
  assert.equal(bad.status, 400);
  assert.deepEqual((await bad.json()).errors, ['minimum pay cannot be more than the maximum']);

  const created = await json('/api/jobs', 'POST', { ...jobForm, title: 'Forklift Operator', company: 'Fake Co', skills: ['Forklift', 'Safety'], responsibilities: ['Move pallets'] }, meera);
  assert.equal(created.status, 201);
  const body = (await created.json()).job;
  assert.equal(body.status, 'draft');
  assert.equal(body.company, 'Acme Foods Pvt Ltd', 'the company is always the account\'s own');
  assert.deepEqual(body.skills, ['Forklift', 'Safety']);

  const patched = await json(`/api/jobs/${body.id}`, 'PATCH', { title: 'Forklift Operator (Night Shift)', schedule: 'Night shift' }, meera);
  assert.equal(patched.status, 200);
  assert.equal((await patched.json()).job.title, 'Forklift Operator (Night Shift)');
  assert.equal(job(body.id).description, jobForm.description, 'fields not sent are kept');

  const published = await json(`/api/jobs/${body.id}/publish`, 'POST', {}, meera);
  assert.equal((await published.json()).job.status, 'pending');

  // The team sends it back; the employer fixes it and sends it again.
  await post(`/admin/jobs/${body.id}/reject`, { reason: 'Please add the shift timings' }, { cookie: admin });
  assert.equal(job(body.id).status, 'rejected');
  await srv.waitForEmail((m) => m.includes('Changes needed: Forklift Operator'));
  await json(`/api/jobs/${body.id}`, 'PATCH', { schedule: 'Night shift, 10 pm – 6 am' }, meera);
  assert.equal(job(body.id).status, 'draft');
  await json(`/api/jobs/${body.id}/publish`, 'POST', {}, meera);
  assert.equal(job(body.id).status, 'pending');

  // Cross-site requests are refused.
  assert.equal((await json(`/api/jobs/${body.id}`, 'PATCH', { title: 'X' }, meera, { origin: 'https://evil.example' })).status, 403);
});

test('changing a live job sends it back for review', async () => {
  const live = srv.records('jobs').find((x) => x.title === 'Packing Supervisor');
  const res = await json(`/api/jobs/${live.id}`, 'PATCH', { salaryMax: 30000 }, meera);
  assert.equal((await res.json()).job.status, 'pending');
  assert.equal((await srv.request(`/jobs/${live.id}`)).status, 404);
  await srv.waitForEmail((m) => m.includes('Changed job to review: Packing Supervisor'));
});

test('employers can only touch their own jobs', async () => {
  await post('/admin/clients', { company: 'Other Co', name: 'Ravi', email: 'ravi@other.in' }, { cookie: admin });
  const setup = await linkIn((m) => m.includes('To: ravi@other.in'), /\/employer\/setup\/[a-f0-9]{64}/);
  const ravi = srv.cookieFrom(await post(setup, { password: 'another long phrase', confirm: 'another long phrase' }));
  const theirs = srv.records('jobs').find((x) => x.title === 'Packing Supervisor');
  assert.equal((await srv.request(`/employer/jobs/${theirs.id}/edit`, { cookie: ravi })).status, 404);
  assert.equal((await post(`/employer/jobs/${theirs.id}`, jobForm, { cookie: ravi })).status, 404);
  assert.equal((await json(`/api/jobs/${theirs.id}`, 'PATCH', { title: 'Hijacked' }, ravi)).status, 404);
  assert.equal((await json(`/api/jobs/${theirs.id}/publish`, 'POST', {}, ravi)).status, 404);
  assert.equal(job(theirs.id).title, 'Packing Supervisor');
  // Clients the team added are approved already.
  assert.doesNotMatch(await (await srv.request('/employer', { cookie: ravi })).text(), /Our team is checking your company/);
});

test('the team can decline a sign-up, which closes the account', async () => {
  await post('/employer/register', { ...signup, company: 'Shady Ltd', email: 'boss@gmail.com', gstin: '' });
  assert.equal(emp('boss@gmail.com').freeEmail, true);
  const verify = await linkIn((m) => m.includes('To: boss@gmail.com'), /\/employer\/verify\/[a-f0-9]{64}/);
  const cookie = srv.cookieFrom(await post(verify, {}));
  assert.match(await (await srv.request('/admin?tab=clients', { cookie: admin })).text(), /Personal email/);
  await post(`/admin/clients/${emp('boss@gmail.com').id}/reject`, { reason: 'Could not verify' }, { cookie: admin });
  assert.equal(emp('boss@gmail.com').active, false);
  assert.equal((await srv.request('/employer', { cookie })).headers.get('location'), '/employer/login');
  const login = await post('/employer/login', { email: 'boss@gmail.com', password: signup.password });
  assert.equal(login.status, 403);
  assert.match(await login.text(), /not linked to an active company/);
  assert.equal(login.headers.get('set-cookie'), null);
});

test('Step 108: "Post similar" fills a new job form from one of the company\'s own jobs', async () => {
  const list = await (await srv.request('/employer/jobs', { cookie: meera })).text();
  const from = list.match(/href="\/employer\/jobs\/new\?from=([^"]+)"[^>]*>Post similar<\/a>/);
  assert.ok(from, 'each of the company\'s own jobs has "Post similar"');
  const mine = job(from[1]);
  assert.equal(mine.employerId, emp('meera@acmefoods.in').id);
  const count = srv.records('jobs').length;
  const html = await (await srv.request(`/employer/jobs/new?from=${mine.id}`, { cookie: meera })).text();
  assert.match(html, new RegExp(`Copied from "${mine.title}"`));
  assert.match(html, /action="\/employer\/jobs"/, 'it posts as a new job');
  assert.match(html, new RegExp(`name="title"[^>]*value="${mine.title}"`));
  assert.doesNotMatch(html, /name="closesOn"[^>]*value="\d/, 'no closing date is copied');
  // Someone else's job, the team's jobs or a made-up id give an empty form.
  const other = srv.records('jobs').find((j) => j.employerId !== mine.employerId);
  const blank = await (await srv.request(`/employer/jobs/new?from=${other ? other.id : 'hr-nope'}`, { cookie: meera })).text();
  assert.doesNotMatch(blank, /Copied from/);
  assert.equal(srv.records('jobs').length, count, 'nothing is saved until the employer saves it');
});
