// Step 61: recruitment analytics. Numbers that reconcile with the records
// they come from (each application counted once per stage, corrections and
// duplicates handled, money only from billing), India-date boundaries,
// dashboards and reports that differ by role, strict company isolation,
// validated filters, CSV exports that follow the filters and are recorded,
// and large data.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');
const { hashPassword } = require('../employers');
const { parseFilters } = require('../analytics');

const DAY = 86400000;
const iso = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString();
const ist = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const ymd = (daysAgo) => ist(Date.now() - daysAgo * DAY);
const TODAY = ymd(0);
const YESTERDAY = ymd(1);

const company = (id, name, email) => ({ id, company: name, name: email.split('@')[0], email, active: true, createdAt: iso(40) });
const person = (id, email, name) => ({ id, email, name, phone: '', passwordHash: hashPassword(`${name} long password`), emailVerifiedAt: iso(1), phoneVerifiedAt: null, createdAt: iso(1), active: true, link: null });
const membership = (id, employerId, userId, role) => ({ id, employerId, userId, role, jobIds: [], createdAt: iso(1) });
const teamUser = (id, name, role) => ({ id, name, email: `${name.toLowerCase()}@hireriv.test`, role, active: true, passwordHash: hashPassword(`${name} long password`), createdAt: iso(50) });
const job = (id, employerId, companyName, category, extra = {}) => ({ id, title: `${category} role ${id}`, company: companyName, employerId, location: 'Pune', mode: 'On-site', type: 'Full-time', category, experience: '', posted: ymd(30), approvedAt: iso(30), skills: [], description: 'A job.', responsibilities: [], status: 'open', closesOn: null, sample: false, ...extra });
const move = (from, to, daysAgo, extra = {}) => ({ at: iso(daysAgo), from, to, by: 'Rita', ...extra });
const app = (id, jobId, daysAgo, extra = {}) => ({ id, jobId, jobTitle: `Job ${jobId}`, name: `Candidate ${id}`, email: `${id}@example.in`, phone: '9800000000', status: 'New', createdAt: typeof daysAgo === 'string' ? daysAgo : iso(daysAgo), history: [], interviews: [], ...extra });
const invoice = (number, daysAgo, total, extra = {}) => ({ number, date: ymd(daysAgo), dueDate: ymd(daysAgo - 15), subtotal: Math.round((total / 1.18) * 100) / 100, total, status: 'Unpaid', payments: [], creditNotes: [], refunds: [], ...extra });
const placement = (id, extra) => ({ id, type: 'Permanent', status: 'Joined', fee: 50000, joiningDate: ymd(3), candidateName: `Placed ${id}`, jobTitle: 'Job', ...extra });

let srv;
const p = {};
let ip = 0;
const headers = (extra = {}) => ({ 'x-forwarded-for': `10.61.${Math.floor(++ip / 250)}.${ip % 250}`, 'user-agent': 'TestBrowser/1.0', ...extra });
const get = (url, cookie) => srv.request(url, { cookie, headers: headers({ accept: 'text/html' }) });
const post = (url, form, cookie) => srv.request(url, { method: 'POST', form, cookie, headers: headers() });
const api = async (url, cookie) => {
  const r = await srv.request(url, { cookie, headers: headers({ accept: 'application/json' }) });
  const text = await r.text();
  let data = {};
  try { data = JSON.parse(text); } catch (e) { data = { text }; }
  return { ...data, status: r.status, headersOf: r.headers, raw: text };
};
const kpi = (r, id) => r.data.kpis.find((k) => k.id === id);
const signIn = async (path, form) => srv.cookieFrom(await post(path, form));

before(async () => {
  const bulk = Array.from({ length: 3000 }, (_, i) => app(`bulk-${i}`, 'j9', 200 + (i % 300), { status: i % 7 === 0 ? 'Interview' : 'New', history: i % 7 === 0 ? [move('New', 'Screening', 199), move('Screening', 'Interview', 198)] : [] }));
  srv = await startServer({ TRUST_PROXY: '1', ANALYTICS_FLUSH_MS: '200' }, {
    employers: [company('emp-a', 'A Co', 'olga@aco.in'), company('emp-b', 'B Co', 'bob@bco.in'), { ...company('emp-c', 'C Co', 'cara@cco.in'), selfSignup: true, createdAt: iso(2) }],
    'employer-users': [person('u-olga', 'olga@aco.in', 'Olga'), person('u-mona', 'mona@aco.in', 'Mona'), person('u-vic', 'vic@aco.in', 'Vic'), person('u-bob', 'bob@bco.in', 'Bob')],
    'employer-members': [membership('m1', 'emp-a', 'u-olga', 'owner'), membership('m2', 'emp-a', 'u-mona', 'manager'), membership('m3', 'emp-a', 'u-vic', 'viewer'), membership('m4', 'emp-b', 'u-bob', 'owner')],
    team: [teamUser('t-rita', 'Rita', 'Recruiter'), teamUser('t-ravi', 'Ravi', 'Recruiter'), teamUser('t-rm', 'Rama', 'Recruitment Manager'), teamUser('t-fin', 'Fina', 'Finance Manager'), teamUser('t-sam', 'Sam', 'Sales Manager')],
    jobs: [
      job('j1', 'emp-a', 'A Co', 'Retail', { ownerId: 't-rita' }),
      job('j2', 'emp-b', 'B Co', 'Warehouse & Packing', { ownerId: 't-ravi', type: 'Contract' }),
      job('j3', 'emp-a', 'A Co', 'Retail', { sample: true }),
      job('j9', 'emp-c', 'C Co', 'Technology', { status: 'closed' }),
    ],
    applications: [
      // Hired after interview and an accepted offer.
      app('a1', 'j1', 10, { status: 'Hired', history: [move('New', 'Screening', 9), move('Screening', 'Interview', 8), move('Interview', 'Offered', 6), move('Offered', 'Hired', 5)], interviews: [{ id: 'iv1', createdAt: iso(8.5), at: iso(8), duration: 30, mode: 'Video', status: 'completed' }], offers: [{ id: 'o1', createdAt: iso(6.5), approval: { status: 'approved', at: iso(6) }, response: { status: 'accepted', at: iso(5.5) } }] }),
      // Interview entered twice after a correction: counted once.
      app('a2', 'j1', 9, { status: 'Interview', history: [move('New', 'Screening', 8), move('Screening', 'Interview', 7), move('Interview', 'Screening', 6.5, { correction: true, reason: 'Wrong person' }), move('Screening', 'Interview', 6)], interviews: [{ id: 'iv2', createdAt: iso(1), at: iso(-3), duration: 30, mode: 'Phone', status: 'scheduled' }] }),
      // Moved to Offered by mistake, then corrected back: not an offer.
      app('a3', 'j1', 8, { status: 'Screening', history: [move('New', 'Screening', 7), move('Screening', 'Shortlisted', 6), move('Shortlisted', 'Interview', 5), move('Interview', 'Offered', 4), move('Offered', 'Screening', 3.9, { correction: true, reason: 'Clicked the wrong candidate' })] }),
      app('a4', 'j2', 3, { withdrawnAt: iso(2) }),
      app('a5', 'j2', 3, { duplicateOf: 'a4' }),
      app('a6', 'general', 3),
      app('a7', 'j1', 100, { status: 'Hired', history: [move('New', 'Hired', 90)] }),
      app('a8', 'j3', 2),
      app('a9', 'j2', 5, { ownerId: 't-rm' }),
      app('a10', 'j2', 4, { status: 'Offered', history: [move('New', 'Screening', 3.5), move('Screening', 'Interview', 3), move('Interview', 'Offered', 2.5)], offers: [{ id: 'o2', createdAt: iso(2.6), approval: { status: 'approved', at: iso(2) }, response: { status: 'declined', at: iso(1) } }] }),
      // Either side of India midnight.
      app('a11', 'j2', `${TODAY}T00:01:00+05:30`),
      app('a12', 'j2', `${YESTERDAY}T23:59:00+05:30`),
      ...bulk,
    ],
    placements: [
      placement('p1', { appId: 'a1', jobId: 'j1', employerId: 'emp-a', company: 'A Co', recruiterId: 't-rita', createdAt: iso(4), invoice: invoice('INV-1', 4, 59000, { dueDate: ymd(-10), status: 'Part paid', payments: [{ date: ymd(2), amount: 20000, tds: 5000 }] }) }),
      placement('p2', { jobId: 'j2', employerId: 'emp-b', company: 'B Co', type: 'Contract', recruiterId: 't-ravi', createdAt: iso(1), invoice: invoice('INV-2', 1, 11800, { status: 'Paid', payments: [{ date: ymd(1), amount: 10620, tds: 1180 }], refunds: [{ id: 'r1', date: ymd(1), amount: 1000 }] }) }),
      placement('p3', { appId: 'a7', jobId: 'j1', employerId: 'emp-a', company: 'A Co', recruiterId: 't-rita', createdAt: iso(60), invoice: invoice('INV-3', 60, 23600, { dueDate: ymd(45) }) }),
      placement('p4', { jobId: 'j2', employerId: 'emp-b', company: 'B Co', createdAt: iso(200), invoice: invoice('INV-4', 20, 99999, { status: 'Cancelled' }) }),
      placement('p5', { appId: 'a1', jobId: 'j1', employerId: 'emp-a', company: 'A Co', recruiterId: 't-rita', replacementFor: 'p1', createdAt: iso(2) }),
    ],
    candidates: [{ id: 'c1', email: 'x@example.in', createdAt: iso(3), emailVerifiedAt: iso(3), profile: {}, resumes: [] }, { id: 'c2', email: 'y@example.in', createdAt: iso(90), emailVerifiedAt: iso(90), profile: {}, resumes: [] }],
    'site-analytics': [
      { id: `${TODAY}|job-view|Office & professional`, day: TODAY, event: 'job-view', label: 'Office & professional', count: 80 },
      { id: `${TODAY}|job-view|Industrial, field & service`, day: TODAY, event: 'job-view', label: 'Industrial, field & service', count: 20 },
    ],
  });
  p.admin = await srv.adminLogin();
  for (const [k, name] of [['rita', 'Rita'], ['rm', 'Rama'], ['fin', 'Fina'], ['sam', 'Sam']]) p[k] = await signIn('/admin/login', { login: `${name.toLowerCase()}@hireriv.test`, password: `${name} long password` });
  for (const [k, name] of [['olga', 'Olga'], ['mona', 'Mona'], ['vic', 'Vic'], ['bob', 'Bob']]) p[k] = await signIn('/employer/login', { email: `${k}@${k === 'bob' ? 'bco' : 'aco'}.in`, password: `${name} long password` });
}, { timeout: 60000 });
after(() => srv && srv.stop());

test('filters are validated: periods, custom ranges, unknown keys and page sizes', async () => {
  const ok = parseFilters({ period: 'custom', from: '2026-01-01', to: '2026-03-31' }, '2026-10-25');
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.f.from, '2026-01-01');
  assert.equal(parseFilters({ period: 'quarter' }, '2026-11-14').f.from, '2026-10-01');
  assert.equal(parseFilters({ period: '7d' }, '2026-10-25').f.from, '2026-10-19');
  assert.equal(parseFilters({}, '2026-10-25').f.period, '30d');
  for (const q of [{ period: 'year' }, { period: 'custom', from: '2026-02-30', to: '2026-03-01' }, { period: 'custom', from: '2026-05-01', to: '2026-04-01' }, { period: 'custom', from: '2020-01-01', to: '2026-01-01' }, { period: 'custom', from: '2026-01-01', to: '2099-01-01' }, { from: '2026-01-01' }, { period: '30d', from: '2026-01-01', to: '2026-01-02' }, { secret: '1' }, { pageSize: '1000' }, { page: '0' }, { work: 'collar' }, { revenueStatus: 'maybe' }, { employer: '../x' }, { work: ['office', 'field'] }]) {
    assert.ok(parseFilters(q, '2026-10-25').errors.length, JSON.stringify(q));
  }
  for (const q of ['period=year', 'period=custom&from=2026-05-01&to=2026-04-01', 'nonsense=1', 'pageSize=500']) {
    const r = await api(`/api/analytics/overview?${q}`, p.admin);
    assert.equal(r.status, 400, q);
    assert.ok(r.errors.length);
  }
});

test('the numbers reconcile with the records they come from', async () => {
  const r = await api('/api/analytics/overview', p.admin);
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.period.timezone, 'Asia/Kolkata');
  assert.equal(r.period.to, TODAY);
  // a1, a2, a3, a4 (withdrawn), a9, a10, a11, a12; not the duplicate, the profile, the old one, the sample job or bulk.
  assert.equal(kpi(r, 'applications').value, 8);
  assert.equal(kpi(r, 'interviewRate').numerator, 3);
  assert.equal(kpi(r, 'interviewRate').value, 37.5);
  assert.deepEqual([kpi(r, 'offerAcceptance').numerator, kpi(r, 'offerAcceptance').denominator], [1, 2]);
  assert.equal(kpi(r, 'timeToHire').value, 5);
  assert.equal(kpi(r, 'placements').value, 2, 'p1 and p2; the replacement and older ones are not');
  assert.equal(kpi(r, 'placementRate').value, 12.5);
  assert.equal(kpi(r, 'applicationConversion').value, 8, '8 applications ÷ 100 job-page views');
  // Money from billing, in paise: 59,000 + 11,800 invoiced; 25,000 + 11,800 − 1,000 collected.
  assert.equal(kpi(r, 'invoiced').value, 7080000);
  assert.equal(kpi(r, 'revenueCollected').value, 3580000);
  assert.equal(kpi(r, 'outstandingInvoices').value, 5760000, '34,000 left on INV-1 and 23,600 on INV-3');
  assert.equal(kpi(r, 'outstandingInvoices').overduePaise, 2360000);
  for (const k of r.data.kpis) assert.ok(r.definitions[k.id] && k.definition.timezone === 'Asia/Kolkata' && k.definition.formula, k.id);

  const funnel = await api('/api/analytics/recruitment-funnel', p.admin);
  assert.deepEqual(funnel.data.stages.map((s) => s.count), [8, 4, 3, 3, 2, 1]);
  assert.equal(funnel.data.stages[0].label, 'Applied');
  assert.equal(funnel.data.stages[3].count, 3, 'a2 entered Interview twice and counts once');
  assert.equal(funnel.data.stages[4].count, 2, "a3's mistaken offer was corrected and doesn't count");
  assert.equal(funnel.data.outcomes.withdrawn, 1);
  assert.deepEqual(funnel.data.byWork.find((w) => w.key === 'field'), { key: 'field', label: 'Industrial, field & service', applied: 5, interviewed: 1, hired: 0 });

  const pl = await api('/api/analytics/placements', p.admin);
  assert.equal(pl.data.count, 2);
  assert.equal(pl.data.replacements, 1);
  assert.deepEqual(pl.data.byType.map((x) => x.count), [1, 0, 1]);
  const rev = await api('/api/analytics/revenue', p.admin);
  assert.equal(rev.data.collectedPaise, 3580000);
  assert.equal(rev.data.refundedPaise, 100000);
  assert.ok(!rev.data.invoices.rows.some((x) => x.number === 'INV-4'), 'cancelled invoices count nowhere');
  assert.equal(rev.data.series.rows.reduce((n, x) => n + x.collectedPaise, 0), rev.data.collectedPaise, 'the chart adds up to the total');
  const paid = await api('/api/analytics/revenue?revenueStatus=overdue', p.admin);
  assert.deepEqual(paid.data.invoices.rows.map((x) => x.number), ['INV-3']);

  const tth = await api('/api/analytics/time-to-hire', p.admin);
  assert.equal(tth.data.timeToHire.hires, 1);
  assert.equal(tth.data.timeToFill.jobs, 0, "j1's first hire was 90 days ago");
});

test('India dates: today runs from midnight to midnight in India', async () => {
  const today = await api('/api/analytics/overview?period=today', p.admin);
  assert.equal(today.status, 200);
  assert.equal(today.period.from, TODAY);
  assert.equal(kpi(today, 'applications').value, 1, 'a11 (00:01 today) but not a12 (23:59 yesterday)');
  const y = await api(`/api/analytics/overview?period=custom&from=${YESTERDAY}&to=${YESTERDAY}`, p.admin);
  assert.equal(kpi(y, 'applications').value, 1);
  const bucket = (await api('/api/analytics/overview?period=7d', p.admin)).data.activity;
  assert.equal(bucket.unit, 'day');
  assert.equal(bucket.rows.length, 7);
  assert.equal(bucket.rows.find((x) => x.key === TODAY).applications, 1);
});

test('each role gets its own dashboard and only the reports it may see', async () => {
  // A recruiter: only their own work, no money, no one else's numbers.
  const rita = await api('/api/analytics/overview', p.rita);
  assert.equal(rita.status, 200);
  assert.equal(rita.scope.allRecruiters, false);
  assert.equal(kpi(rita, 'applications').value, 3, 'a1, a2 and a3 on her job');
  assert.equal(kpi(rita, 'revenueCollected'), undefined);
  assert.equal(rita.data.platform, undefined);
  assert.equal((await api('/api/analytics/revenue', p.rita)).status, 403);
  assert.equal((await api('/api/analytics/overview?recruiter=t-rm', p.rita)).status, 403);
  const mine = await api('/api/analytics/recruiter-performance', p.rita);
  assert.deepEqual(mine.data.recruiters.rows.map((x) => x.name), ['Rita']);
  assert.equal(mine.data.recruiters.rows[0].placements, 1);
  assert.equal(mine.data.recruiters.rows[0].offersMade, 1);
  assert.equal(mine.data.recruiters.rows[0].upcomingInterviews, 1);

  // A Recruitment Manager: everyone, any recruiter; still no money.
  const rm = await api('/api/analytics/recruiter-performance', p.rm);
  assert.ok(rm.data.recruiters.rows.length >= 3);
  assert.equal(rm.data.recruiters.rows.find((x) => x.name === 'Rama').overdueFollowUps, 1, 'a9 has waited 5 days in New');
  assert.equal(kpi(await api('/api/analytics/overview?recruiter=t-rita', p.rm), 'applications').value, 3);
  assert.equal((await api('/api/analytics/overview?recruiter=nobody', p.rm)).status, 404);
  assert.equal((await api('/api/analytics/revenue', p.rm)).status, 403);

  // Finance: money, and the page opens despite their limited pages.
  assert.equal((await api('/api/analytics/revenue', p.fin)).status, 200);
  assert.equal((await get('/admin/analytics', p.fin)).status, 200);
  // Sales and signed-out people: nothing.
  assert.equal((await api('/api/analytics/overview', p.sam)).status, 403);
  assert.equal((await api('/api/analytics/overview')).status, 401);
  assert.equal((await api('/api/analytics/reports/overview/export')).status, 401);

  // The Admin sees the platform.
  const admin = await api('/api/analytics/overview', p.admin);
  assert.equal(admin.data.platform.candidatesRegistered, 1);
  assert.equal(admin.data.platform.employersRegistered, 1);
  assert.equal(admin.data.platform.employers.pending, 1);
  assert.ok(admin.data.platform.moderationBacklog);
  assert.ok(Array.isArray(admin.data.platform.failedBackgroundJobs));

  const pages = { admin: await (await get('/admin/analytics', p.admin)).text(), rita: await (await get('/admin/analytics', p.rita)).text() };
  assert.match(pages.admin, /<h1>Platform and recruitment analytics<\/h1>/);
  assert.match(pages.admin, /id="revenue"/);
  assert.match(pages.rita, /<h1>Your recruitment numbers<\/h1>/);
  assert.doesNotMatch(pages.rita, /id="revenue"|id="platform"|Rama/);
});

test('employers see only their own company, whatever ids they send', async () => {
  const olga = await api('/api/analytics/overview', p.olga);
  assert.equal(olga.status, 200);
  assert.equal(olga.scope.as, 'employer');
  assert.equal(kpi(olga, 'applications').value, 3);
  assert.equal(kpi(olga, 'invoiced').value, 5900000, 'only A Co invoices');
  assert.equal(kpi(olga, 'outstandingInvoices').value, 5760000);
  assert.equal(kpi(olga, 'applicationConversion').value, null, 'site-wide views are not shown to employers');
  assert.equal(olga.data.perVacancy.total, 1, 'the sample job is left out');
  // Per vacancy: every application the job has had, and those new in the range.
  assert.deepEqual([olga.data.perVacancy.rows[0].applications, olga.data.perVacancy.rows[0].newInRange, olga.data.perVacancy.rows[0].hired], [4, 3, 2]);
  assert.ok(!olga.raw.includes('B Co') && !olga.raw.includes('INV-2') && !olga.raw.includes('Ravi'));
  for (const url of ['/api/analytics/overview?employer=emp-b', '/api/analytics/placements?employer=emp-b', '/api/analytics/reports/placements/export?employer=emp-b', '/api/analytics/overview?recruiter=u-bob']) {
    assert.equal((await api(url, p.olga)).status, 404, url);
  }
  assert.equal((await api('/api/analytics/overview?employer=emp-a', p.bob)).status, 404);
  const bob = await api('/api/analytics/placements', p.bob);
  assert.deepEqual(bob.data.list.rows.map((x) => x.id), ['p2']);
  // A hiring manager sees only the jobs they work on (none yet); a viewer sees all but no money.
  assert.equal(kpi(await api('/api/analytics/overview', p.mona), 'applications').value, 0);
  const vic = await api('/api/analytics/overview', p.vic);
  assert.equal(kpi(vic, 'applications').value, 3);
  assert.equal(kpi(vic, 'invoiced'), undefined);
  assert.equal((await api('/api/analytics/revenue', p.vic)).status, 403);
  // The page.
  const page = await get('/employer/analytics', p.olga);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Applications per vacancy/);
  assert.doesNotMatch(html, /B Co|Platform/);
  assert.equal((await get('/employer/analytics')).headers.get('location'), '/employer/login');
});

test('filters by kind of work, recruitment type and status narrow every report', async () => {
  const field = await api('/api/analytics/overview?work=field', p.admin);
  assert.equal(kpi(field, 'applications').value, 5);
  assert.equal(kpi(field, 'applicationConversion').value, 25, '5 ÷ 20 views of field jobs');
  assert.equal(kpi(await api('/api/analytics/overview?work=office', p.admin), 'applications').value, 3);
  const contract = await api('/api/analytics/placements?hiringType=contract', p.admin);
  assert.deepEqual(contract.data.list.rows.map((x) => x.id), ['p2']);
  assert.equal(kpi(await api('/api/analytics/overview?applicationStatus=Withdrawn', p.admin), 'applications').value, 1);
  assert.equal(kpi(await api('/api/analytics/overview?jobStatus=closed', p.admin), 'applications').value, 0);
  assert.equal(kpi(await api('/api/analytics/overview?employer=emp-b', p.admin), 'applications').value, 5);
  assert.equal(kpi(await api('/api/analytics/overview?location=Mumbai', p.admin), 'applications').value, 0);
  assert.equal(kpi(await api('/api/analytics/overview?location=Pune', p.admin), 'applicationConversion').value, null, 'views are not counted by location');
  // Pagination.
  const pg = await api('/api/analytics/recruiter-performance?pageSize=1&page=2', p.admin);
  assert.equal(pg.data.recruiters.rows.length, 1);
  assert.equal(pg.data.recruiters.page, 2);
});

test('CSV exports follow the filters and permissions and are recorded', async () => {
  const r = await srv.request('/api/analytics/reports/placements/export?hiringType=contract', { cookie: p.admin, headers: headers() });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/csv/);
  const csv = (await r.text()).replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(csv.length, 2);
  assert.match(csv[1], /^p2,/);
  const funnel = (await (await srv.request('/api/analytics/reports/recruitment-funnel/export', { cookie: p.admin, headers: headers() })).text()).replace(/^﻿/, '');
  assert.match(funnel, /^stage,applications,percentOfApplied,toNextStage,from,to\r\nApplied,8,100,50,/);
  assert.equal((await srv.request('/api/analytics/reports/revenue/export', { cookie: p.rita, headers: headers() })).status, 403);
  assert.equal((await srv.request('/api/analytics/reports/salaries/export', { cookie: p.admin, headers: headers() })).status, 404);
  const empty = await (await srv.request('/api/analytics/reports/placements/export?location=Nowhere', { cookie: p.admin, headers: headers() })).text();
  assert.match(empty, /No records match these filters/);
  const rev = await (await srv.request('/api/analytics/reports/revenue/export', { cookie: p.olga, headers: headers() })).text();
  assert.match(rev, /INV-1/);
  assert.doesNotMatch(rev, /INV-2/);
  // Recorded: in the team activity log and the company's audit log.
  assert.ok(srv.records('activity').some((e) => /^Exported analytics: placements \(1 rows\)/.test(e.action) && /hiringType=contract/.test(e.detail)));
  assert.ok(srv.records('activity').some((e) => e.action === 'Viewed the revenue report'));
  assert.ok(srv.records('employer-audit').some((e) => e.employerId === 'emp-a' && /^Exported analytics: revenue/.test(e.event)));
});

test('large data: three years and thousands of applications answer quickly', async () => {
  const from = ymd(1000);
  const t0 = Date.now();
  const r = await api(`/api/analytics/recruitment-funnel?period=custom&from=${from}&to=${TODAY}`, p.admin);
  assert.equal(r.status, 200);
  assert.ok(r.data.cohort.applications > 3000);
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
  const o = await api(`/api/analytics/overview?period=custom&from=${from}&to=${TODAY}`, p.admin);
  assert.equal(o.data.activity.unit, 'month');
  assert.ok(o.tookMs < 3000);
  // Empty ranges are fine too.
  const none = await api('/api/analytics/overview?period=custom&from=2001-01-01&to=2001-01-31', p.admin);
  assert.equal(kpi(none, 'applications').value, 0);
  assert.equal(kpi(none, 'interviewRate').value, null);
  const page = await get('/admin/analytics?period=custom&from=2001-01-01&to=2001-01-31', p.admin);
  assert.match(await page.text(), /No applications in this range\./);
  const bad = await get('/admin/analytics?period=never', p.admin);
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /These filters could not be used/);
});
