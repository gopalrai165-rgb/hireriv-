// The applicant tracking system, against the QA checklist: who sees which
// applicants, the pipeline, the stage workflow and its history, corrections,
// interview rules and confirmations, scorecards, notes kept from candidates,
// offers (approval and answer apart), metrics that match the records, company
// isolation, and notifications that are never sent twice.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, decodeEmail } = require('./helpers');
const { hashPassword } = require('../employers');
const ats = require('../ats');

const DAY = 86400000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const istDate = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const job = (id, extra) => ({
  id, title: `Job ${id}`, company: 'A Co', location: 'Pune', mode: 'On-site', type: 'Full-time', category: 'Technology', experience: '2-4 years',
  salary: '', pay: null, posted: istDate(Date.now() - 20 * DAY), approvedAt: iso(20 * DAY), skills: ['Forklift'], description: 'A real job.', responsibilities: [],
  status: 'open', closesOn: null, sample: false, createdBy: 'employer', employerId: 'emp-a', ...extra,
});
const owner = (id, company, email) => ({ id, company, name: email.split('@')[0], email, passwordHash: hashPassword('owner long password'), passwordSetAt: iso(DAY), active: true, createdAt: iso(30 * DAY) });
const app = (id, name, extra) => ({ id, jobId: 'j1', jobTitle: 'Job j1', name, email: `${name.toLowerCase()}@example.in`, phone: '9800000000', status: 'New', notes: '', createdAt: iso(5 * DAY), ...extra });
const pastIv = { id: 'iv-past', at: iso(2 * DAY), duration: 45, mode: 'Phone', where: '9800000000', interviewer: 'Rita', status: 'scheduled', confirmation: 'confirmed', sequence: 0, createdAt: iso(4 * DAY), feedback: [] };

let srv;
const people = {};
before(async () => {
  srv = await startServer({ TRUST_PROXY: '1' }, {
    employers: [owner('emp-a', 'A Co', 'olga@aco.in'), owner('emp-b', 'B Co', 'bob@bco.in')],
    jobs: [job('j1'), job('j2', { title: 'Job j2' }), job('j3', { employerId: 'emp-b', company: 'B Co' }), job('j4', { createdBy: undefined, title: 'Team-run' })],
    applications: [
      app('a1', 'Asha', { skills: 'Forklift, Safety', experience: '2-4 years', location: 'Pune' }),
      app('a2', 'Bala', { status: 'Interview', skills: 'Packing', location: 'Mumbai', history: [{ at: iso(4.5 * DAY), from: 'New', to: 'Shortlisted', by: 'x' }, { at: iso(4 * DAY), from: 'Shortlisted', to: 'Interview', by: 'x' }], interviews: [pastIv] }),
      app('a3', 'Chitra', { status: 'Hired', createdAt: iso(10 * DAY), history: [{ at: iso(9 * DAY), from: 'New', to: 'Interview', by: 'x' }, { at: iso(4 * DAY), from: 'Interview', to: 'Hired', by: 'x' }] }),
      app('a4', 'Dev', { status: 'Rejected', history: [{ at: iso(4 * DAY), from: 'New', to: 'Rejected', by: 'x' }] }),
      app('a5', 'Esha', { withdrawnAt: iso(DAY) }),
      app('a6', 'Farid', { jobId: 'j3', jobTitle: 'Job j3' }),
      app('a7', 'Asha', { duplicateOf: 'a1' }),
      app('a8', 'Gita', { jobId: 'j4', jobTitle: 'Team-run' }),
    ],
  });
}, { timeout: 30000 });
after(() => srv && srv.stop());

let ip = 0;
const headers = (extra = {}) => ({ 'x-forwarded-for': `10.7.${Math.floor(++ip / 250)}.${ip % 250}`, ...extra });
const get = (url, cookie) => srv.request(url, { cookie, headers: headers() });
const post = (url, form, cookie) => srv.request(url, { method: 'POST', form, cookie, headers: headers() });
const json = (url, method, body, cookie) => srv.request(url, { method, cookie, body: body === undefined ? undefined : JSON.stringify(body), headers: headers({ 'content-type': 'application/json', accept: 'application/json' }) });
const rec = (id) => srv.records('applications').find((a) => a.id === id);
const msgOf = (res) => decodeURIComponent(res.headers.get('location') || '');
const userId = (email) => srv.records('employer-users').find((u) => u.email === email).id;

async function login(email) {
  const res = await post('/employer/login', { email, password: 'owner long password' });
  assert.equal(res.status, 302);
  return srv.cookieFrom(res);
}
async function invite(name, email, role, jobIds) {
  const body = new URLSearchParams([['name', name], ['email', email], ['role', role], ...jobIds.map((j) => ['jobIds', j])]).toString();
  await srv.request('/employer/team', { method: 'POST', body, cookie: people.olga, headers: headers({ 'content-type': 'application/x-www-form-urlencoded' }) });
  await srv.waitForEmail((m) => m.includes(`To: ${email}`));
  const link = decodeEmail(srv.emails().filter((m) => m.includes(`To: ${email}`)).pop()).match(/\/employer\/setup\/[a-f0-9]{64}/)[0];
  return srv.cookieFrom(await post(link, { password: `${name} long password`, confirm: `${name} long password` }));
}

test('the workflow rules', () => {
  const a = (status, extra) => ({ status, ...extra });
  assert.equal(ats.moveProblem(a('New'), 'Shortlisted'), '');
  assert.match(ats.moveProblem(a('New'), 'Hired'), /can't move from Applied to Hired/);
  assert.match(ats.moveProblem(a('Interview'), 'Offered'), /approved first/);
  const approved = { approval: { status: 'approved' }, response: { status: 'awaiting' } };
  assert.equal(ats.moveProblem(a('Interview', { offers: [approved] }), 'Offered'), '');
  assert.match(ats.moveProblem(a('Offered', { offers: [approved] }), 'Hired'), /accepting/);
  assert.equal(ats.moveProblem(a('Offered', { offers: [{ ...approved, response: { status: 'accepted' } }] }), 'Hired'), '');
  assert.match(ats.moveProblem(a('Rejected'), 'Screening'), /company owner can correct/);
  assert.match(ats.moveProblem(a('New', { withdrawnAt: iso(0) }), 'Screening'), /withdrew/);
  assert.deepEqual(ats.allowedMoves(a('Hired')), []);
  assert.equal(ats.median([5, 1, 3]), 3);
  assert.equal(ats.median([1, 2]), 1.5);
});

test('set up: owners, a recruiter and a manager on j1, a viewer', async () => {
  people.olga = await login('olga@aco.in');
  people.bob = await login('bob@bco.in');
  people.rita = await invite('Rita', 'rita@aco.in', 'recruiter', ['j1']);
  people.max = await invite('Max', 'max@aco.in', 'manager', ['j1']);
  people.vic = await invite('Vic', 'vic@aco.in', 'viewer', []);
  people.ron = await invite('Ron', 'ron@aco.in', 'recruiter', ['j2']);
});

test('recruiters see applicants for their assigned vacancies only', async () => {
  const rita = await (await json('/api/ats/jobs/j1/applications', 'GET', undefined, people.rita)).json();
  assert.deepEqual(rita.applications.map((x) => x.name).sort(), ['Asha', 'Bala', 'Chitra', 'Dev', 'Esha'], 'no duplicates, withdrawn shown as such');
  assert.equal(rita.applications.find((x) => x.name === 'Esha').status, 'Withdrawn');
  assert.equal((await json('/api/ats/jobs/j1/applications', 'GET', undefined, people.ron)).status, 404);
  assert.equal((await json('/api/ats/applications/a1', 'GET', undefined, people.ron)).status, 404);
  // Filters: skills, location, stage.
  const f = await (await json('/api/ats/jobs/j1/applications?skills=forklift&location=pune', 'GET', undefined, people.rita)).json();
  assert.deepEqual(f.applications.map((x) => x.id), ['a1']);
  const st = await (await json('/api/ats/jobs/j1/applications?stage=Hired', 'GET', undefined, people.rita)).json();
  assert.deepEqual(st.applications.map((x) => x.id), ['a3']);
});

test('applications appear in the right pipeline column, and the table filters', async () => {
  const board = await (await get('/employer/ats', people.rita)).text();
  const column = (label) => board.split('aria-label="').find((s) => s.startsWith(`${label}"`)) || '';
  assert.match(column('Applied'), /Asha/);
  assert.match(column('Interview'), /Bala/);
  assert.match(column('Hired'), /Chitra/);
  assert.doesNotMatch(board, /Farid|Gita/, 'other companies and team-run jobs stay out');
  const table = await (await get('/employer/ats?view=table&stage=Rejected', people.rita)).text();
  assert.match(table, /Dev/);
  assert.doesNotMatch(table, /Asha/);
  assert.equal((await get('/employers/ats')).headers.get('location'), '/employer/ats');
});

test('valid stage changes update the stage and append history; invalid and unauthorised ones are refused', async () => {
  const before = (rec('a1').history || []).length;
  const ok = await json('/api/ats/applications/a1/stage', 'PATCH', { stage: 'Shortlisted' }, people.rita);
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.application.status, 'Shortlisted');
  assert.equal(body.application.stageLabel, 'Shortlisted');
  const h = rec('a1').history;
  assert.equal(h.length, before + 1);
  assert.deepEqual([h.at(-1).from, h.at(-1).to, h.at(-1).actor, h.at(-1).userId], ['New', 'Shortlisted', 'employer', userId('rita@aco.in')]);
  assert.ok(h.at(-1).at);

  assert.equal((await json('/api/ats/applications/a1/stage', 'PATCH', { stage: 'Hired' }, people.rita)).status, 409, 'skipping the workflow');
  assert.equal((await json('/api/ats/applications/a1/stage', 'PATCH', { stage: 'Teleported' }, people.rita)).status, 400);
  assert.equal((await json('/api/ats/applications/a1/stage', 'PATCH', { stage: 'Screening' }, people.vic)).status, 403, 'viewers can\'t move anyone');
  assert.equal((await json('/api/ats/applications/a1/stage', 'PATCH', { stage: 'Screening' }, people.bob)).status, 404, 'another company');
  assert.equal((await json('/api/ats/applications/a5/stage', 'PATCH', { stage: 'Screening' }, people.rita)).status, 409, 'withdrawn');
  assert.equal((await json('/api/ats/applications/a4/stage', 'PATCH', { stage: 'Screening' }, people.rita)).status, 409, 'rejected is final in the workflow');

  // Corrections: owners only, with a reason; history keeps the mistake.
  assert.equal((await json('/api/ats/applications/a4/stage', 'PATCH', { stage: 'Screening', correction: true, reason: 'Wrong person' }, people.rita)).status, 403);
  assert.equal((await json('/api/ats/applications/a4/stage', 'PATCH', { stage: 'Screening', correction: true, reason: '' }, people.olga)).status, 400);
  const fixed = await json('/api/ats/applications/a4/stage', 'PATCH', { stage: 'Screening', correction: true, reason: 'Rejected the wrong Dev' }, people.olga);
  assert.equal(fixed.status, 200);
  const dh = rec('a4').history;
  assert.deepEqual(dh.map((x) => x.to), ['Rejected', 'Screening']);
  assert.deepEqual([dh[1].correction, dh[1].reason], [true, 'Rejected the wrong Dev']);
  assert.ok(srv.records('employer-audit').some((e) => e.event === 'stage-corrected'));

  // The board's form uses the same rules.
  assert.match(msgOf(await post('/employer/applicants/a1/status', { status: 'Hired', back: 'ats' }, people.rita)), /^\/employer\/ats\?msg=Not changed/);
});

test('assigning a recruiter: managers and owners, only to people on the job', async () => {
  assert.equal((await json('/api/ats/applications/a1/assign', 'POST', { userId: userId('rita@aco.in') }, people.rita)).status, 403, 'recruiters don\'t assign');
  assert.equal((await json('/api/ats/applications/a1/assign', 'POST', { userId: userId('ron@aco.in') }, people.max)).status, 400, 'not on this job');
  const ok = await json('/api/ats/applications/a1/assign', 'POST', { userId: userId('rita@aco.in') }, people.max);
  assert.equal((await ok.json()).assignedTo.name, 'Rita');
  assert.equal(rec('a1').assignedTo, userId('rita@aco.in'));
  assert.match(await (await get('/employer/ats?mine=1', people.rita)).text(), /Asha/);
});

test('internal notes: team only, never in candidate-facing data', async () => {
  assert.equal((await json('/api/ats/applications/a1/notes', 'POST', { text: 'Strong forklift licence, check night shifts' }, people.vic)).status, 403);
  assert.equal((await json('/api/ats/applications/a1/notes', 'POST', { text: ' ' }, people.rita)).status, 400);
  const res = await json('/api/ats/applications/a1/notes', 'POST', { text: 'Strong forklift licence, check night shifts' }, people.rita);
  assert.equal(res.status, 201);
  assert.equal((await (await json('/api/ats/applications/a1', 'GET', undefined, people.rita)).json()).application.notes[0].text, 'Strong forklift licence, check night shifts');
  assert.equal((await (await json('/api/ats/applications/a1', 'GET', undefined, people.vic)).json()).application.notes, undefined);
  // The note text isn't copied into the activity log.
  assert.equal(srv.records('employer-audit').some((e) => String(e.detail).includes('night shifts')), false);

  // Asha signs in to her candidate account: no note anywhere.
  const fd = new FormData();
  for (const [k, v] of Object.entries({ name: 'Asha', email: 'asha@example.in', phone: '9845012345', location: 'Pune', agree: '1' })) fd.append(k, v);
  await srv.request('/account/register', { method: 'POST', body: fd, headers: headers() });
  await srv.waitForEmail((m) => m.includes('To: asha@example.in') && decodeEmail(m).includes('/account/verify/'));
  const link = decodeEmail(srv.emails().filter((m) => m.includes('To: asha@example.in')).pop()).match(/\/account\/verify\/[a-f0-9]{64}/)[0];
  people.asha = srv.cookieFrom(await post(link, {}));
  for (const url of ['/account', '/api/candidate/applications', '/account/my-data.json', '/account/interviews']) {
    const text = await (await get(url, people.asha)).text();
    assert.doesNotMatch(text, /night shifts|atsNotes|Shortlisted/, url);
  }
  assert.match(await (await get('/api/candidate/applications', people.asha)).text(), /Under review/);
});

test('interviews: scheduling rules, the candidate confirms, cancellations are sent', async () => {
  const at = (msAhead) => {
    const d = new Date(Date.now() + msAhead);
    return { date: istDate(d), time: d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }) };
  };
  const tomorrow = istDate(Date.now() + DAY);
  const body = { date: tomorrow, time: '11:00', duration: 45, mode: 'In person', where: 'Plot 4, Bhosari, Pune', interviewer: 'Max', interviewerEmail: 'max@aco.in' };
  assert.equal((await json('/api/ats/applications/a1/interviews', 'POST', body, people.vic)).status, 403);
  assert.equal((await json('/api/ats/applications/a1/interviews', 'POST', body, people.bob)).status, 404);
  const soon = await json('/api/ats/applications/a1/interviews', 'POST', { ...body, ...at(30 * 60000) }, people.rita);
  assert.equal(soon.status, 400);
  assert.match((await soon.json()).errors.join(), /2 hours ahead|past|7 am/);
  const late = await json('/api/ats/applications/a1/interviews', 'POST', { ...body, time: '22:30' }, people.rita);
  assert.match((await late.json()).errors.join(), /between 7 am and 9 pm/);

  const ok = await json('/api/ats/applications/a1/interviews', 'POST', body, people.rita);
  assert.equal(ok.status, 201);
  const iv = (await ok.json()).interview;
  assert.equal(iv.confirmation, 'awaiting', 'an invitation is not a confirmed interview');
  assert.equal(rec('a1').status, 'Interview');
  await srv.waitForEmail((m) => m.includes('To: asha@example.in') && m.includes('Interview scheduled'));
  // The same interviewer can't be double-booked.
  const clash = await json('/api/ats/applications/a3/interviews', 'POST', body, people.rita);
  assert.equal(clash.status, 409, 'hired applications get no interviews');
  const clash2 = await json('/api/ats/applications/a4/interviews', 'POST', { ...body, time: '11:30' }, people.olga);
  assert.match((await clash2.json()).errors.join(), /interviewer already has an interview/);

  // Asha confirms from her account; the people on the job hear about it.
  assert.equal((await post(`/account/interviews/a2/iv-past/confirm`, {}, people.asha)).status, 404, 'not her interview');
  const conf = await post(`/account/interviews/a1/${iv.id}/confirm`, {}, people.asha);
  assert.match(msgOf(conf), /confirmed/);
  assert.equal(rec('a1').interviews[0].confirmation, 'confirmed');
  await srv.waitForEmail((m) => m.includes('To: rita@aco.in') && m.includes('Interview confirmed: Asha'));
  const page = await (await get('/employer/applicants/a1', people.rita)).text();
  assert.match(page, /Confirmed by candidate/);

  // Cancelling sends a calendar cancellation, once.
  assert.equal((await post(`/employer/applicants/a1/interviews/${iv.id}/cancel`, {}, people.vic)).status, 403);
  assert.match(msgOf(await post(`/employer/applicants/a1/interviews/${iv.id}/cancel`, {}, people.rita)), /cancelled/);
  assert.match(msgOf(await post(`/employer/applicants/a1/interviews/${iv.id}/cancel`, {}, people.rita)), /not scheduled/);
  await srv.waitForEmail((m) => m.includes('To: asha@example.in') && m.includes('Interview cancelled'));
  assert.equal(srv.emails().filter((m) => m.includes('To: asha@example.in') && m.includes('Interview cancelled')).length, 1);
});

test('scorecards: people on the job write and read them, after the interview', async () => {
  const fb = { rating: 4, recommendation: 'Hire', strengths: 'Careful with stock', concerns: '' };
  assert.equal((await json('/api/ats/interviews/iv-past/feedback', 'POST', fb, people.vic)).status, 403);
  assert.equal((await json('/api/ats/interviews/iv-past/feedback', 'POST', fb, people.bob)).status, 404);
  assert.equal((await json('/api/ats/interviews/iv-past/feedback', 'POST', { ...fb, rating: 9 }, people.rita)).status, 400);
  assert.equal((await json('/api/ats/interviews/iv-past/feedback', 'POST', fb, people.rita)).status, 201);
  const v = (await (await json('/api/ats/applications/a2', 'GET', undefined, people.max)).json()).application;
  assert.equal(v.interviews[0].feedback[0].recommendation, 'Hire');
  const viewer = (await (await json('/api/ats/applications/a2', 'GET', undefined, people.vic)).json()).application;
  assert.equal(viewer.interviews[0].feedback, undefined, 'viewers don\'t see scorecards');
});

test('offers: made, approved by someone else, answered by the candidate, then hired', async () => {
  assert.equal((await json('/api/ats/applications/a2/stage', 'PATCH', { stage: 'Offered' }, people.rita)).status, 409, 'no offer yet');
  assert.equal((await json('/api/ats/applications/a4/offers', 'POST', { salary: '25000' }, people.rita)).status, 409, 'too early in the pipeline');
  assert.equal((await json('/api/ats/applications/a2/offers', 'POST', { salary: '25000', joiningDate: '2020-01-01' }, people.rita)).status, 400);
  const made = await json('/api/ats/applications/a2/offers', 'POST', { salary: '25,000', salaryPeriod: 'month', joiningDate: istDate(Date.now() + 14 * DAY) }, people.rita);
  assert.equal(made.status, 201);
  const offer = (await made.json()).offer;
  assert.deepEqual([offer.approval.status, offer.response.status, offer.salary.amount], ['pending', 'awaiting', 25000]);
  assert.equal(offer.createdByUserId, undefined);

  assert.equal((await json(`/api/ats/offers/${offer.id}/approve`, 'POST', { approve: true }, people.rita)).status, 403, 'recruiters don\'t approve');
  assert.equal((await json(`/api/ats/offers/${offer.id}/response`, 'POST', { response: 'accepted' }, people.rita)).status, 409, 'not approved yet');
  assert.equal((await json(`/api/ats/offers/${offer.id}/approve`, 'POST', { approve: true }, people.bob)).status, 404);
  const ok = await json(`/api/ats/offers/${offer.id}/approve`, 'POST', { approve: true, note: 'Within budget' }, people.max);
  assert.equal(ok.status, 200);
  const approved = await ok.json();
  assert.equal(approved.stage, 'Offered');
  assert.equal(approved.offer.approval.by, 'Max');
  assert.equal(approved.offer.response.status, 'awaiting', 'approval and the candidate\'s answer are separate');
  await srv.waitForEmail((m) => m.includes('To: bala@example.in') && m.includes('Job offer: Job j1 at A Co'));
  assert.equal((await json(`/api/ats/offers/${offer.id}/approve`, 'POST', { approve: true }, people.olga)).status, 409, 'decided once');

  assert.equal((await json('/api/ats/applications/a2/stage', 'PATCH', { stage: 'Hired' }, people.rita)).status, 409, 'not accepted yet');
  const answer = await json(`/api/ats/offers/${offer.id}/response`, 'POST', { response: 'accepted' }, people.rita);
  assert.equal((await answer.json()).offer.response.status, 'accepted');
  const hired = await json('/api/ats/applications/a2/stage', 'PATCH', { stage: 'Hired' }, people.rita);
  assert.equal((await hired.json()).application.status, 'Hired');
  assert.deepEqual(srv.records('employer-audit').filter((e) => e.event.startsWith('offer-')).map((e) => e.event).sort(), ['offer-accepted', 'offer-approved', 'offer-created']);

  // A manager can't approve their own offer; an owner can.
  await json('/api/ats/applications/a1/stage', 'PATCH', { stage: 'Interview' }, people.rita);
  const own = await (await json('/api/ats/applications/a1/offers', 'POST', { salary: '20000' }, people.max)).json();
  assert.match((await (await json(`/api/ats/offers/${own.offer.id}/approve`, 'POST', { approve: true }, people.max)).json()).errors[0], /someone else/);
  assert.equal((await json(`/api/ats/offers/${own.offer.id}/approve`, 'POST', { approve: false, note: 'Budget' }, people.olga)).status, 200);
  assert.equal(rec('a1').status, 'Interview', 'a declined approval doesn\'t move the stage');
});

test('metrics match the records', async () => {
  const res = await json('/api/ats/analytics', 'GET', undefined, people.olga);
  const { metrics: m, definitions } = await res.json();
  const apps = srv.records('applications').filter((a) => ['j1', 'j2'].includes(a.jobId) && !a.duplicateOf);
  assert.equal(m.applications, apps.length);
  assert.equal(m.hires, apps.filter((a) => a.status === 'Hired' && !a.withdrawnAt).length);
  assert.equal(m.hires, 2);
  assert.equal(m.withdrawn, 1);
  assert.equal(m.activeVacancies, 2, 'own live jobs only');
  assert.equal(m.offersIssued, 1);
  assert.equal(m.funnel.find((s) => s.stage === 'Hired').count, 2);
  assert.equal(m.funnel[0].count, apps.length);
  assert.equal(m.timeToHireDays, ats.median([6, (Date.parse(rec('a2').history.at(-1).at) - Date.parse(rec('a2').createdAt)) / DAY].map((d) => Math.round(d * 10) / 10)));
  assert.ok(m.timeToFillDays >= 15 && m.timeToFillDays <= 16.1, String(m.timeToFillDays));
  assert.equal(m.perJob.find((j) => j.jobId === 'j1').hired, 2);
  assert.ok(definitions.timeToHireDays);
  assert.ok(m.workload.find((w) => w.name === 'Rita'), 'owners see workload');
  const rita = (await (await json('/api/ats/analytics', 'GET', undefined, people.rita)).json()).metrics;
  assert.deepEqual(rita.workload, [], 'recruiters don\'t');
  const bob = (await (await json('/api/ats/analytics', 'GET', undefined, people.bob)).json()).metrics;
  assert.equal(bob.applications, 1, 'B Co sees only its own');
  assert.equal((await json('/api/ats/analytics', 'GET', undefined)).status, 401);
  assert.match(await (await get('/employer/ats/reports', people.olga)).text(), /Team workload/);
});

test('notifications are recorded once per event', async () => {
  const list = srv.records('notifications');
  const keys = list.map((n) => n.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(keys.some((k) => k.startsWith('interview-invite:')));
  assert.ok(keys.some((k) => k.startsWith('offer-made:')));
  assert.ok(list.every((n) => !('to' in n) && !('email' in n)), 'the ledger keeps no addresses');
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(srv.records('notifications').every((n) => ['sent', 'failed'].includes(n.status)));
  assert.equal(srv.emails().filter((m) => m.includes('Job offer: Job j1')).length, 1);
});

test('other companies, signed-out users and team-run jobs get nothing', async () => {
  for (const [method, url, body] of [['GET', '/api/ats/applications/a1'], ['PATCH', '/api/ats/applications/a1/stage', { stage: 'Rejected' }], ['POST', '/api/ats/applications/a1/notes', { text: 'x' }], ['POST', '/api/ats/applications/a1/assign', {}], ['GET', '/api/ats/jobs/j1/applications']]) {
    assert.equal((await json(url, method, body, people.bob)).status, 404, `${method} ${url}`);
    assert.equal((await json(url, method, body)).status, 401, `${method} ${url} signed out`);
  }
  assert.equal((await get('/employer/applicants/a1', people.bob)).status, 404);
  assert.equal((await json('/api/ats/applications/a8', 'GET', undefined, people.olga)).status, 404, 'team-run job');
});
