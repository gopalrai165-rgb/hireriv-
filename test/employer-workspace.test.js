// Employer workspaces: company logins moved to people, team members with
// roles, every action checked against the person's role in the company, the
// company's own applicants (status history, interviews), the JSON API, the
// activity log and the /employers/* addresses.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, resumeForm, decodeEmail } = require('./helpers');
const { hashPassword } = require('../employers');
const { can } = require('../employer-team');

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const job = (id, extra) => ({
  id, title: `Job ${id}`, company: 'Old Co', location: 'Bengaluru', mode: 'On-site', type: 'Full-time', category: 'Technology', experience: '2-4 years',
  salary: '', pay: null, posted: today, skills: ['Node.js', 'SQL'], description: 'A real job.', responsibilities: [], status: 'open', closesOn: null, sample: false, ...extra,
});
const OLD = { id: 'emp-old', company: 'Old Co', name: 'Olga Rao', email: 'olga@oldco.in', passwordHash: hashPassword('olga long password'), passwordSetAt: '2026-01-01T00:00:00.000Z', active: true, createdAt: '2026-01-01T00:00:00.000Z' };
const OTHER = { id: 'emp-b', company: 'B Co', name: 'Bob Das', email: 'bob@bco.in', passwordHash: hashPassword('bob long password'), passwordSetAt: '2026-01-01T00:00:00.000Z', active: true, createdAt: '2026-01-01T00:00:00.000Z' };

let srv;
let admin;
const people = {};
before(async () => {
  srv = await startServer({ TRUST_PROXY: '1' }, {
    employers: [OLD, OTHER],
    jobs: [
      job('hr-900', { employerId: 'emp-old', createdBy: 'employer' }),
      job('hr-901', { employerId: 'emp-old', title: 'Team-run job' }),
      job('hr-950', { employerId: 'emp-b', company: 'B Co', createdBy: 'employer' }),
    ],
  });
  admin = await srv.adminLogin();
});
after(() => srv && srv.stop());

let ip = 0;
const headers = (extra = {}) => ({ 'x-forwarded-for': `10.9.${Math.floor(++ip / 250)}.${ip % 250}`, ...extra });
const get = (url, cookie) => srv.request(url, { cookie, headers: headers() });
const post = (url, form, cookie) => srv.request(url, { method: 'POST', form, cookie, headers: headers() });
const json = (url, method, body, cookie) => srv.request(url, { method, cookie, body: body === undefined ? undefined : JSON.stringify(body), headers: headers({ 'content-type': 'application/json', accept: 'application/json' }) });
const msgOf = (res) => decodeURIComponent(res.headers.get('location') || '');
const user = (email) => srv.records('employer-users').find((u) => u.email === email);
const app = (email, jobId) => srv.records('applications').find((a) => a.email === email && a.jobId === jobId);
const audit = (event) => srv.records('employer-audit').filter((e) => e.event === event);

async function login(email, password) {
  const res = await post('/employer/login', { email, password });
  assert.equal(res.status, 302, `${email} signs in`);
  return srv.cookieFrom(res);
}
// The owner invites someone; they set a password from the emailed link.
async function invite(owner, name, email, role, jobIds = []) {
  const res = await srv.request('/employer/team', { method: 'POST', body: new URLSearchParams([['name', name], ['email', email], ['role', role], ...jobIds.map((j) => ['jobIds', j])]).toString(), cookie: owner, headers: headers({ 'content-type': 'application/x-www-form-urlencoded' }) });
  assert.match(msgOf(res), /Invitation sent/);
  await srv.waitForEmail((m) => m.includes(`To: ${email}`));
  const link = decodeEmail(srv.emails().filter((m) => m.includes(`To: ${email}`)).pop()).match(/\/employer\/setup\/[a-f0-9]{64}/)[0];
  const set = await post(link, { password: `${name} long password`, confirm: `${name} long password` });
  assert.equal(set.status, 302);
  return srv.cookieFrom(set);
}

test('the permission rules', () => {
  const m = (role, jobIds = []) => ({ employerId: 'e1', userId: 'u1', role, jobIds });
  const j = { id: 'j1', employerId: 'e1' };
  const other = { id: 'j2', employerId: 'e2' };
  assert.equal(can(m('owner'), 'team.manage'), true);
  assert.equal(can(m('owner'), 'job.edit', other), false, 'never another company\'s job');
  assert.equal(can(m('manager'), 'jobs.create'), true);
  assert.equal(can(m('manager'), 'job.edit', j), false);
  assert.equal(can(m('manager', ['j1']), 'job.edit', j), true);
  assert.equal(can(m('manager'), 'job.edit', { ...j, createdByUser: 'u1' }), true, 'their own job');
  assert.equal(can(m('recruiter', ['j1']), 'applicants.manage', j), true);
  assert.equal(can(m('recruiter', ['j1']), 'job.edit', j), false);
  assert.equal(can(m('recruiter'), 'applicants.view', j), false);
  assert.equal(can(m('viewer'), 'applicants.view', j), true);
  assert.equal(can(m('viewer'), 'applicants.contact', j), false);
  for (const role of ['manager', 'recruiter', 'viewer']) for (const a of ['company.edit', 'team.manage', 'billing.view']) assert.equal(can(m(role, ['j1']), a), false, `${role} ${a}`);
});

test('company logins became people who own the company', async () => {
  const olga = user('olga@oldco.in');
  assert.ok(olga && olga.emailVerifiedAt);
  assert.equal(srv.records('employers').find((e) => e.id === 'emp-old').passwordHash, undefined);
  assert.equal(srv.records('employer-members').find((m) => m.userId === olga.id).role, 'owner');
  people.olga = await login('olga@oldco.in', 'olga long password');
  people.bob = await login('bob@bco.in', 'bob long password');
  const dash = await (await get('/employer', people.olga)).text();
  assert.match(dash, /Company owner/);
  assert.match(dash, /Job hr-900/);
});

test('owners invite their team with roles and assigned jobs', async () => {
  people.rita = await invite(people.olga, 'Rita', 'rita@oldco.in', 'recruiter', ['hr-900', 'hr-950']);
  people.vic = await invite(people.olga, 'Vic', 'vic@oldco.in', 'viewer');
  people.max = await invite(people.olga, 'Max', 'max@oldco.in', 'manager');
  const rita = srv.records('employer-members').find((m) => m.userId === user('rita@oldco.in').id);
  assert.deepEqual(rita.jobIds, ['hr-900'], 'only this company\'s jobs can be assigned');
  assert.equal(audit('member-added').length, 3);
  // Only owners manage the team, the company and billing.
  for (const who of ['rita', 'vic', 'max']) {
    assert.equal((await post('/employer/team', { name: 'X', email: 'x@oldco.in', role: 'owner' }, people[who])).status, 403, who);
    assert.equal((await post('/employer/company', { company: 'Hijack' }, people[who])).status, 403, who);
  }
  assert.equal((await json('/api/employers/me', 'PATCH', { industry: 'Education' }, people.rita)).status, 403);
  // The last owner can't leave.
  const own = srv.records('employer-members').find((m) => m.userId === user('olga@oldco.in').id);
  assert.match(msgOf(await post(`/employer/team/${own.id}/remove`, {}, people.olga)), /at least one owner/);
  assert.match(msgOf(await post(`/employer/team/${own.id}`, { role: 'viewer' }, people.olga)), /at least one owner/);
});

test('applicants to the company\'s own jobs reach the people working on them', async () => {
  for (const jobId of ['hr-900', 'hr-901', 'hr-950']) {
    const res = await srv.request('/api/apply', { method: 'POST', body: resumeForm({ jobId, name: 'Priya Nair', email: 'priya@example.in', phone: '9876500011', skills: 'Node.js' }), headers: headers({ accept: 'application/json' }) });
    assert.equal(res.status, 200, jobId);
  }
  await srv.waitForEmail((m) => m.includes('To: rita@oldco.in') && m.includes('New applicant for Job hr-900'));
  await srv.waitForEmail((m) => m.includes('To: olga@oldco.in') && m.includes('New applicant for Job hr-900'));
  // Nobody is emailed about the team-run job, and viewers aren't emailed.
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(srv.emails().filter((m) => m.includes('New applicant for Team-run job')).length, 0);
  assert.equal(srv.emails().filter((m) => m.includes('To: vic@oldco.in') && m.includes('New applicant')).length, 0);
});

test('who sees which applicants, and contact details', async () => {
  const a = app('priya@example.in', 'hr-900');
  const teamRun = app('priya@example.in', 'hr-901');
  const theirs = app('priya@example.in', 'hr-950');

  const rita = await (await get(`/employer/applicants/${a.id}`, people.rita)).text();
  assert.match(rita, /priya@example\.in/);
  assert.match(rita, /Download resume/);
  const vic = await get(`/employer/applicants/${a.id}`, people.vic);
  assert.equal(vic.status, 200);
  assert.doesNotMatch(await vic.text(), /priya@example\.in|9876500011/, 'viewers see progress, not contact details');
  assert.equal((await get(`/employer/applicants/${a.id}`, people.max)).status, 404, 'not assigned');
  assert.equal((await get(`/employer/applicants/${a.id}`, people.bob)).status, 404, 'another company');
  // Jobs the team runs keep applicants with the team (shortlists only).
  assert.equal((await get(`/employer/applicants/${teamRun.id}`, people.olga)).status, 404);
  assert.equal((await json('/api/employers/jobs/hr-901/applications', 'GET', undefined, people.olga)).status, 404);
  assert.equal((await get(`/employer/applicants/${theirs.id}`, people.olga)).status, 404);
  assert.equal((await json('/api/employers/jobs/hr-900/applications', 'GET', undefined, people.bob)).status, 404);

  const list = await (await json('/api/employers/jobs/hr-900/applications', 'GET', undefined, people.vic)).json();
  assert.equal(list.applications.length, 1);
  assert.equal(list.applications[0].email, undefined);
  const full = await (await json('/api/employers/jobs/hr-900/applications', 'GET', undefined, people.rita)).json();
  assert.equal(full.applications[0].email, 'priya@example.in');
  assert.ok(audit('applicant-viewed').length >= 2);

  // The resume: signed link for people who may contact applicants.
  assert.equal((await get(`/employer/applicants/${a.id}/resume`, people.rita)).status, 410, 'unsigned links are refused');
  const signed = rita.match(/href="(\/employer\/applicants\/[^"]+\/resume\?[^"]+)"/)[1].replace(/&amp;/g, '&');
  assert.equal((await get(signed, people.rita)).status, 200);
  assert.equal((await get(signed, people.vic)).status, 403);
  assert.equal(audit('resume-downloaded').length, 1);
});

test('status changes: permissions, validation and history', async () => {
  const a = app('priya@example.in', 'hr-900');
  const theirs = app('priya@example.in', 'hr-950');
  assert.equal((await json(`/api/employers/applications/${a.id}/status`, 'PATCH', { status: 'Screening' }, people.vic)).status, 403);
  assert.equal((await json(`/api/employers/applications/${a.id}/status`, 'PATCH', { status: 'Screening' }, people.bob)).status, 404);
  assert.equal((await json(`/api/employers/applications/${theirs.id}/status`, 'PATCH', { status: 'Hired' }, people.rita)).status, 404);
  assert.equal((await json(`/api/employers/applications/${a.id}/status`, 'PATCH', { status: 'Teleported' }, people.rita)).status, 400);
  const res = await json(`/api/employers/applications/${a.id}/status`, 'PATCH', { status: 'Screening' }, people.rita);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).application.status, 'Screening');
  const h = app('priya@example.in', 'hr-900').history.pop();
  assert.deepEqual([h.from, h.to], ['New', 'Screening']);
  assert.match(h.by, /Rita \(Old Co\)/);
  assert.equal(audit('status-changed').length, 1);
  // The form does the same.
  assert.match(msgOf(await post(`/employer/applicants/${a.id}/status`, { status: 'Rejected' }, people.olga)), /moved to Rejected/);
  assert.equal(app('priya@example.in', 'hr-900').status, 'Rejected');
  // Out of Rejected only by an owner's correction, with a reason.
  assert.equal((await json(`/api/employers/applications/${a.id}/status`, 'PATCH', { status: 'Screening' }, people.olga)).status, 409);
  assert.equal((await json(`/api/ats/applications/${a.id}/stage`, 'PATCH', { stage: 'Screening', correction: true, reason: 'Rejected by mistake' }, people.olga)).status, 200);
});

test('interviews: booking emails the candidate and shows in the portal', async () => {
  const a = app('priya@example.in', 'hr-900');
  const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const body = { applicationId: a.id, date: tomorrow, time: '11:00', duration: 45, mode: 'In person', where: 'Plot 4, Whitefield, Bengaluru', interviewer: 'Rita' };
  assert.equal((await json('/api/employers/interviews', 'POST', body, people.vic)).status, 403);
  assert.equal((await json('/api/employers/interviews', 'POST', body, people.bob)).status, 404);
  assert.equal((await json('/api/employers/interviews', 'POST', { ...body, where: '' }, people.rita)).status, 400);
  const res = await json('/api/employers/interviews', 'POST', body, people.rita);
  assert.equal(res.status, 201);
  assert.equal((await res.json()).interview.mode, 'In person');
  await srv.waitForEmail((m) => m.includes('To: priya@example.in') && /interview/i.test(m));
  assert.equal(app('priya@example.in', 'hr-900').status, 'Interview');
  assert.match(await (await get('/employer/interviews', people.vic)).text(), /Priya Nair/);
  assert.doesNotMatch(await (await get('/employer/interviews', people.bob)).text(), /Priya Nair/);
  assert.equal(audit('interview-scheduled').length, 1);
});

test('jobs: managers post and edit their own, recruiters can\'t edit, pause hides a job', async () => {
  const created = await json('/api/employers/jobs', 'POST', { title: 'Site Engineer', category: 'Technology', location: 'Bengaluru', description: 'Run the site.', responsibilities: ['Run daily site checks'], payNote: 'Fixed monthly salary, discussed at interview', openings: 3, shift: 'Day', address: 'Plot 4, Whitefield', walkIn: true }, people.max);
  assert.equal(created.status, 201);
  const j = (await created.json()).job;
  assert.deepEqual([j.openings, j.shift, j.workplaceAddress, j.walkIn], [3, 'Day', 'Plot 4, Whitefield', true]);
  assert.equal((await json(`/api/employers/jobs/${j.id}`, 'PATCH', { hours: '9 am – 6 pm' }, people.max)).status, 200);
  assert.equal((await json('/api/employers/jobs', 'POST', { title: 'X' }, people.rita)).status, 403);
  assert.equal((await json('/api/employers/jobs/hr-900', 'PATCH', { title: 'X' }, people.rita)).status, 403);
  assert.equal((await json('/api/employers/jobs/hr-900', 'PATCH', { title: 'X' }, people.max)).status, 404, 'not assigned: not visible');
  assert.equal((await post('/employer/jobs/hr-900/pause', {}, people.rita)).status, 403);
  assert.equal((await json('/api/employers/jobs', 'POST', { title: 'Bad', category: 'Technology', location: 'Bengaluru', description: 'x', shift: 'Midnight', openings: 0, walkIn: true }, people.olga)).status, 400);

  assert.match(msgOf(await post('/employer/jobs/hr-900/pause', {}, people.olga)), /paused/);
  assert.equal((await get('/jobs/hr-900')).status, 404);
  assert.match(msgOf(await post('/employer/jobs/hr-900/resume', {}, people.olga)), /live again/);
  assert.equal((await get('/jobs/hr-900')).status, 200);
  const closed = await json('/api/employers/jobs/hr-900/close', 'POST', {}, people.olga);
  assert.equal((await closed.json()).job.status, 'closed');
  assert.deepEqual(audit('job-paused').length + audit('job-resumed').length + audit('job-closed').length, 3);
  const listed = await (await json('/api/employers/jobs', 'GET', undefined, people.vic)).json();
  assert.deepEqual(listed.jobs.map((x) => x.id).sort(), ['hr-900', 'hr-901', j.id].sort(), 'viewers see every job of the company');
  assert.equal(listed.jobs.find((x) => x.id === 'hr-901').managedBy, 'hireriv');
  const rita = await (await json('/api/employers/jobs', 'GET', undefined, people.rita)).json();
  assert.deepEqual(rita.jobs.map((x) => x.id), ['hr-900']);
});

test('one person in several companies switches between them', async () => {
  const res = await srv.request('/employer/team', { method: 'POST', form: { name: 'Olga Rao', email: 'olga@oldco.in', role: 'viewer' }, cookie: people.bob, headers: headers() });
  assert.match(msgOf(res), /can now open B Co/);
  await srv.waitForEmail((m) => m.includes('To: olga@oldco.in') && m.includes('B Co'));
  const page = await (await get('/employer', people.olga)).text();
  assert.match(page, /name="employerId"/);
  const bId = 'emp-b';
  const sw = await post('/employer/switch', { employerId: bId }, people.olga);
  assert.match(msgOf(sw), /Now working in B Co/);
  const inB = srv.cookieFrom(sw);
  const me = await (await json('/api/employers/me', 'GET', undefined, inB)).json();
  assert.equal(me.company.company, 'B Co');
  assert.equal(me.you.role, 'viewer');
  assert.deepEqual(me.companies.map((c) => c.company).sort(), ['B Co', 'Old Co']);
  // Viewer in B: no changes there.
  assert.equal((await json('/api/employers/jobs/hr-950', 'PATCH', { title: 'X' }, inB)).status, 403);
  // A company they aren't in can't be opened by asking for it.
  assert.match(msgOf(await post('/employer/switch', { employerId: 'emp-nope' }, inB)), /not a member/);
  // Switching replaces the session; switch back for the next tests.
  assert.equal((await get('/employer', people.olga)).headers.get('location'), '/employer/login');
  people.olga = srv.cookieFrom(await post('/employer/switch', { employerId: 'emp-old' }, inB));
  assert.equal((await json('/api/employers/me', 'GET', undefined, people.olga)).status, 200);
});

test('company profile, the JSON profile and verification requests', async () => {
  assert.equal((await json('/api/employers/me', 'PATCH', { passwordHash: 'x' }, people.olga)).status, 400);
  assert.equal((await json('/api/employers/me', 'PATCH', { industry: 'Rocketry' }, people.olga)).status, 400);
  const ok = await json('/api/employers/me', 'PATCH', { industry: 'IT & Software', size: '11-50', website: 'https://oldco.in' }, people.olga);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).company.industry, 'IT & Software');
  assert.equal(srv.records('employers').find((e) => e.id === 'emp-old').website, 'https://oldco.in');
  assert.match(await (await get('/employer/company', people.vic)).text(), /Only company owners can change these/);
  assert.equal((await json('/api/employers/me', 'GET', undefined)).status, 401);
});

test('/employers/* addresses lead to the portal', async () => {
  for (const [from, to] of [['/employers/dashboard', '/employer'], ['/employers/company-profile', '/employer/company'], ['/employers/jobs/create', '/employer/jobs/new'], ['/employers/jobs/hr-900/edit', '/employer/jobs/hr-900/edit'], ['/employers/register', '/employer/register']]) {
    const res = await get(from);
    assert.equal(res.status, 301, from);
    assert.equal(res.headers.get('location'), to);
  }
  assert.match(await (await get('/job-posting-policy')).text(), /Never charge candidates/);
});

test('the team approving a job tells its poster and the owners', async () => {
  const j = srv.records('jobs').find((x) => x.title === 'Site Engineer');
  const sent = await json(`/api/employers/jobs/${j.id}/submit`, 'POST', {}, people.max);
  assert.equal((await sent.json()).job.status, 'pending');
  await post(`/admin/jobs/${j.id}/approve`, {}, admin);
  await srv.waitForEmail((m) => m.includes('To: max@oldco.in') && m.includes('Your job is live: Site Engineer'));
  await srv.waitForEmail((m) => m.includes('To: olga@oldco.in') && m.includes('Your job is live: Site Engineer'));
  assert.equal(srv.emails().filter((m) => m.includes('To: rita@oldco.in') && m.includes('Your job is live: Site Engineer')).length, 0);
  assert.equal(audit('job-published').length, 1);
  // Admin can't flip a draft live with the open/close toggle.
  const draft = (await (await json('/api/employers/jobs', 'POST', { title: 'Draft only', category: 'Technology', location: 'Bengaluru', description: 'x' }, people.olga)).json()).job;
  await post(`/admin/jobs/${draft.id}/toggle`, {}, admin);
  assert.equal(srv.records('jobs').find((x) => x.id === draft.id).status, 'draft');
});
