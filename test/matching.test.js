// Step 53: advanced job search, explainable matching, recommendations, saved
// searches with alert frequencies, resume parsing with candidate review, and
// employer candidate discovery, against the release checklist: search returns
// only published jobs and applies every filter; recommendations follow the
// candidate's preferences; explanations show what counted; saved searches can
// be created, changed and deleted with their alert frequency; parsing copes
// with valid, malformed, oversized and unsafe files; discovery keeps to the
// company's permissions and the candidate's consent.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const JSZip = require('jszip');
const { startServer, decodeEmail } = require('./helpers');
const { hashPassword } = require('../employers');
const jm = require('../job-match');
const search = require('../search');
const resumes = require('../resume-parse');

const DAY = 86400000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const istDate = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

// ---------- matching on its own ----------
const forklift = {
  id: 'w1', title: 'Forklift Operator', company: 'A Co', location: 'Pune', mode: 'On-site', type: 'Full-time', category: 'Warehouse & Packing',
  experience: '1-3 years', shift: 'Night', pay: { min: 20000, max: 25000, period: 'month', currency: 'INR' }, skills: ['Forklift', 'Inventory', 'Safety'],
  mustHave: ['Forklift licence'], immediate: true, physical: 'Lifting up to 20 kg',
};
const ashaProfile = {
  name: 'Asha Kumar', skills: ['Forklift', 'Inventory'], experienceLevel: '1-3 years', city: 'Pune', state: 'Maharashtra',
  preferences: { roles: 'warehouse', categories: ['Warehouse & Packing'], locations: ['Pune'], types: ['Full-time'], arrangements: [], shifts: ['Night'], relocate: false },
  salary: { expected: 22000, period: 'month' }, availability: { noticePeriod: 'Immediate', availableFrom: '' },
  certifications: [{ name: 'Forklift licence', issuer: '', year: '' }], languages: [], experiences: [], education: [],
};

test('the match explains every factor, with must-haves shown apart from the score', () => {
  const m = jm.explain(jm.facts(ashaProfile), forklift);
  // Skills 2 of 3 (40 × ⅔) + experience, location, pay, job type and shift in full.
  assert.equal(m.score, 87);
  assert.equal(m.level, 'strong');
  assert.equal(m.basis, 100);
  assert.deepEqual(m.factors.map((f) => [f.key, f.status]), [['skills', 'partial'], ['experience', 'met'], ['location', 'met'], ['salary', 'met'], ['jobType', 'met']]);
  assert.deepEqual(m.skills, { matched: ['Forklift', 'Inventory'], missing: ['Safety'] });
  assert.match(m.factors[3].detail, /₹25,000 a month; you expect ₹22,000/);
  assert.deepEqual(m.requirements.map((r) => [r.label, r.met]), [['Forklift licence', true], ['Can start straight away', true], ['Lifting up to 20 kg', null]]);
  assert.match(m.note, /not a prediction/);
  assert.equal(m.version, jm.MATCH_VERSION);
});

test('missing details are unknown, never a mismatch', () => {
  // Nothing known at all: no score, rather than a low one.
  const empty = jm.explain(jm.facts({}), forklift);
  assert.equal(empty.score, null);
  assert.equal(empty.label, 'Not enough details yet');
  assert.ok(empty.factors.every((f) => f.status === 'unknown'));
  // Only skills known (all of them): scored on skills alone.
  const skillsOnly = jm.explain(jm.facts({ skills: ['Forklift', 'Inventory', 'Safety'] }), forklift);
  assert.deepEqual([skillsOnly.score, skillsOnly.basis], [100, 40]);
  // A job that doesn't state pay or experience leaves those out for everyone.
  const vague = jm.explain(jm.facts(ashaProfile), { ...forklift, pay: null, experience: '' });
  assert.deepEqual(vague.factors.filter((f) => f.status === 'not-asked').map((f) => f.key), ['experience', 'salary']);
  assert.equal(vague.basis, 65);
  // Below the minimum share of known factors there's no score.
  assert.equal(jm.explain(jm.facts({ city: 'Pune' }), forklift).score, null);
});

test('only work details are used: personal characteristics change nothing', () => {
  const facts = jm.facts(ashaProfile);
  assert.deepEqual(Object.keys(facts).sort(), ['arrangements', 'availableFrom', 'categories', 'certifications', 'city', 'english', 'expectedMonthly', 'locations', 'noticePeriod', 'relocate', 'roles', 'shifts', 'skills', 'state', 'types', 'years'].sort());
  const withPersonal = { ...ashaProfile, name: 'Someone Else', gender: 'female', dateOfBirth: '1990-01-01', religion: 'x', caste: 'y', maritalStatus: 'married', disability: 'yes', photo: 'p.jpg' };
  assert.deepEqual(jm.explain(jm.facts(withPersonal), forklift), jm.explain(jm.facts(ashaProfile), forklift));
});

test('weights are configurable and validated', () => {
  assert.deepEqual(jm.parseWeights({ skills: '40', experience: '20', location: '15', salary: '15', jobType: '10' }).errors, []);
  assert.match(jm.parseWeights({ skills: '40', experience: '20', location: '15', salary: '15', jobType: '0' }).errors[0], /add up to 100 \(they add up to 90\)/);
  assert.match(jm.parseWeights({ skills: '4.5', experience: '20', location: '15', salary: '15', jobType: '10' }).errors[0], /whole number/);
  const skillsHeavy = { skills: 80, experience: 5, location: 5, salary: 5, jobType: 5 };
  assert.equal(jm.explain(jm.facts(ashaProfile), forklift, skillsHeavy).score, 73);
  assert.deepEqual(jm.weightsOf({}), jm.DEFAULT_WEIGHTS);
  assert.deepEqual(jm.weightsOf({ matchWeights: skillsHeavy }), skillsHeavy);
});

test('location, pay, experience and shift rules', () => {
  const f = (extra) => jm.facts({ ...ashaProfile, ...extra });
  const factor = (m, key) => m.factors.find((x) => x.key === key);
  // Same state: half. Open to relocating: half. Elsewhere: not yet.
  assert.equal(factor(jm.explain(f({ city: 'Nagpur', preferences: { ...ashaProfile.preferences, locations: [] } }), forklift), 'location').score, 0.5);
  assert.equal(factor(jm.explain(f({ city: 'Patna', state: 'Bihar', preferences: { ...ashaProfile.preferences, locations: [], relocate: true } }), forklift), 'location').score, 0.5);
  assert.equal(factor(jm.explain(f({ city: 'Patna', state: 'Bihar', preferences: { ...ashaProfile.preferences, locations: [] } }), forklift), 'location').status, 'unmet');
  // Pay a little under what they expect: half; well under: not yet. Yearly pay is compared per month.
  assert.equal(factor(jm.explain(f({ salary: { expected: 28000, period: 'month' } }), forklift), 'salary').score, 0.5);
  assert.equal(factor(jm.explain(f({ salary: { expected: 50000, period: 'month' } }), forklift), 'salary').status, 'unmet');
  assert.equal(factor(jm.explain(f({ salary: { expected: 264000, period: 'year' } }), forklift), 'salary').status, 'met');
  // A year short of the experience asked for: half. More experience: fine.
  assert.equal(factor(jm.explain(f({ experienceLevel: 'Fresher' }), { ...forklift, experience: '1-3 years' }), 'experience').score, 0.5);
  assert.equal(factor(jm.explain(f({ experienceLevel: '10+ years' }), forklift), 'experience').status, 'met');
  // Shift: wrong shift halves the job-type factor; "Flexible" suits any shift.
  assert.equal(factor(jm.explain(f({ preferences: { ...ashaProfile.preferences, shifts: ['Day'] } }), forklift), 'jobType').score, 0.5);
  assert.equal(factor(jm.explain(f({ preferences: { ...ashaProfile.preferences, shifts: ['Flexible'] } }), forklift), 'jobType').score, 1);
  // Remote jobs suit anyone who didn't rule remote work out.
  assert.equal(factor(jm.explain(f({}), { ...forklift, mode: 'Remote', location: 'Remote' }), 'location').status, 'met');
  // Notice period instead of "Immediate": the must-have shows as not met.
  assert.equal(jm.explain(f({ availability: { noticePeriod: '30 days', availableFrom: '' } }), forklift).requirements[1].met, false);
});

test('search filters by skills, company and shift, and corrects typing slips', () => {
  const list = [forklift, { ...forklift, id: 'w2', title: 'Picker', company: 'B Co', shift: 'Day', skills: ['Picking'] }];
  const ids = (f) => search.searchJobs(list, f).jobs.map((j) => j.id);
  assert.deepEqual(ids({ skills: ['forklift', 'SAFETY'] }), ['w1']);
  assert.deepEqual(ids({ skills: ['Forklift', 'Picking'] }), []);
  assert.deepEqual(ids({ company: 'b co' }), ['w2']);
  assert.deepEqual(ids({ shift: 'Night' }), ['w1']);
  const vocab = search.vocabulary(list);
  assert.equal(search.suggest('forklfit operater', vocab), 'forklift operator');
  assert.equal(search.suggest('forklift', vocab), '', 'known words stay');
  assert.equal(search.suggest('pick', vocab), '', 'the start of a word is fine');
  assert.equal(search.suggest('zzzzqqq', vocab), '', 'nothing close');
});

const SAMPLE_RESUME = `Asha Kumar
Pune | asha@example.in | 98450 12345
Work Experience
Warehouse Supervisor at Acme Logistics Pvt Ltd
Jan 2021 – Present
Inventory Executive, Bright Retail | 06/2017 - 12/2020
Forklift Operator
Delta Industries
2015 - 2017
Education
B.Com, Pune University, 2015
12th (HSC) - Maharashtra Board - 2012
Skills
Forklift, Inventory, Excel`;

test('resume text gives skills, job history and education', () => {
  const r = resumes.profileFromText(SAMPLE_RESUME, ['Forklift', 'Inventory']);
  assert.ok(r.skills.includes('Forklift') && r.skills.includes('Excel'));
  assert.deepEqual(r.experiences, [
    { title: 'Warehouse Supervisor', company: 'Acme Logistics Pvt Ltd', from: '2021-01', to: '', current: true },
    { title: 'Inventory Executive', company: 'Bright Retail', from: '2017-06', to: '2020-12', current: false },
    { title: 'Forklift Operator', company: 'Delta Industries', from: '2015-01', to: '2017-12', current: false },
  ]);
  assert.deepEqual(r.education.map((e) => [e.level, e.course, e.institution, e.year]), [['Graduate', 'B.Com', 'Pune University', '2015'], ['12th pass', '12th (HSC)', '', '2012']]);
  // Nothing to read: empty, never an error.
  assert.deepEqual(resumes.profileFromText('', []).experiences, []);
  assert.deepEqual(resumes.profileFromText('just some words\nno dates here', []).education, []);
});

// ---------- the whole app ----------
const job = (id, extra) => ({
  id, title: `Job ${id}`, company: 'A Co', location: 'Pune', mode: 'On-site', type: 'Full-time', category: 'Warehouse & Packing', experience: '1-3 years',
  salary: '₹20,000 – 25,000 a month', pay: { min: 20000, max: 25000, period: 'month', currency: 'INR' }, posted: istDate(Date.now() - 2 * DAY), approvedAt: iso(2 * DAY),
  skills: ['Forklift', 'Inventory'], description: 'A real job.', responsibilities: [], status: 'open', closesOn: null, sample: false, createdBy: 'employer',
  employerId: 'emp-a', alertsSentAt: iso(2 * DAY), ...extra,
});
const owner = (id, company, email, extra = {}) => ({ id, company, name: email.split('@')[0], email, passwordHash: hashPassword('owner long password'), passwordSetAt: iso(DAY), active: true, createdAt: iso(30 * DAY), ...extra });
const JOBS = [
  job('w1', { title: 'Forklift Operator', shift: 'Night', skills: ['Forklift', 'Inventory', 'Safety'], mustHave: ['Forklift licence'], immediate: true, physical: 'Lifting up to 20 kg' }),
  job('w2', { title: 'Warehouse Picker', company: 'B Co', employerId: 'emp-b', location: 'Mumbai', shift: 'Day', type: 'Temporary', skills: ['Picking', 'Packing'] }),
  job('t1', { title: 'React Developer', company: 'C Tech', location: 'Remote', mode: 'Remote', category: 'Technology', experience: '3-5 years', skills: ['React', 'Node.js'], pay: { min: 60000, max: 90000, period: 'month', currency: 'INR' }, salary: '₹60,000 – 90,000 a month' }),
  job('d1', { title: 'Delivery Rider', category: 'Delivery & Driving', type: 'Daily wage / Gig', shift: 'Flexible', skills: ['Two-Wheeler Driving'], pay: { min: 700, max: 900, period: 'day', currency: 'INR' }, salary: '₹700 – 900 a day' }),
  job('x1', { title: 'Draft Forklift Job', status: 'draft' }),
  job('x2', { title: 'Closed Forklift Job', status: 'closed' }),
  job('s1', { title: 'Sample Forklift Job', sample: true }),
];

let srv;
const people = {};
let ip = 0;
const headers = (extra = {}) => ({ 'x-forwarded-for': `10.8.${Math.floor(++ip / 250)}.${ip % 250}`, ...extra });
const get = (url, cookie) => srv.request(url, { cookie, headers: headers() });
const post = (url, form, cookie) => srv.request(url, { method: 'POST', form, cookie, headers: headers() });
const json = (url, method, body, cookie) => srv.request(url, { method, cookie, body: body === undefined ? undefined : JSON.stringify(body), headers: headers({ 'content-type': 'application/json', accept: 'application/json' }) });
const api = async (url, cookie) => (await json(url, 'GET', undefined, cookie)).json();
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end; await settle(50)) if (await fn()) return true;
  throw new Error('timed out waiting');
};
const loc = (res) => decodeURIComponent(res.headers.get('location') || '');

// A saved search set up two days ago with a daily email, and a weekly one
// emailed yesterday: the first is due as soon as a job arrives, the second not.
const seededAlerts = [
  { id: 'sa-daily', email: 'asha@example.in', name: 'Delivery work', filters: { categories: ['Delivery & Driving'] }, alertEnabled: true, frequency: 'daily', confirmed: true, confirmedAt: iso(2 * DAY), createdAt: iso(2 * DAY), pending: [], lastDigestAt: null, token: 'a'.repeat(48) },
  { id: 'sa-weekly', email: 'asha@example.in', name: 'Pune delivery weekly', filters: { categories: ['Delivery & Driving'], location: 'Pune' }, alertEnabled: true, frequency: 'weekly', confirmed: true, confirmedAt: iso(9 * DAY), createdAt: iso(9 * DAY), pending: [], lastDigestAt: iso(DAY), token: 'b'.repeat(48) },
];

before(async () => {
  srv = await startServer({ TRUST_PROXY: '1', SAVED_SEARCH_SCAN_MS: '300' }, {
    employers: [owner('emp-a', 'A Co', 'olga@aco.in'), owner('emp-b', 'B Co', 'bob@bco.in'), owner('emp-u', 'U Co', 'uma@uco.in', { selfSignup: true, emailVerifiedAt: iso(DAY) })],
    jobs: JOBS,
    'job-alerts': seededAlerts,
  });
  people.olga = srv.cookieFrom(await post('/employer/login', { email: 'olga@aco.in', password: 'owner long password' }));
  people.bob = srv.cookieFrom(await post('/employer/login', { email: 'bob@bco.in', password: 'owner long password' }));
  people.uma = srv.cookieFrom(await post('/employer/login', { email: 'uma@uco.in', password: 'owner long password' }));
  people.admin = await srv.adminLogin();
  // Vik: a viewer at A Co.
  const body = new URLSearchParams([['name', 'Vik'], ['email', 'vik@aco.in'], ['role', 'viewer']]).toString();
  await srv.request('/employer/team', { method: 'POST', body, cookie: people.olga, headers: headers({ 'content-type': 'application/x-www-form-urlencoded' }) });
  const link = decodeEmail(await srv.waitForEmail((m) => m.includes('To: vik@aco.in'))).match(/\/employer\/setup\/[a-f0-9]{64}/)[0];
  people.vik = srv.cookieFrom(await post(link, { password: 'Vik long password', confirm: 'Vik long password' }));
  people.asha = await register('Asha Kumar', 'asha@example.in');
  people.dev = await register('Dev Rao', 'dev@example.in');
}, { timeout: 30000 });
after(() => srv && srv.stop());

async function register(name, email) {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ name, email, phone: '9845012345', location: 'Pune', agree: '1' })) fd.append(k, v);
  await srv.request('/account/register', { method: 'POST', body: fd, headers: headers() });
  const has = (m) => m.includes(`To: ${email}`) && decodeEmail(m).includes('/account/verify/');
  await srv.waitForEmail(has);
  const link = decodeEmail(srv.emails().filter(has).pop()).match(/\/account\/verify\/[a-f0-9]{64}/)[0];
  return srv.cookieFrom(await post(link, {}));
}

test('job search returns only published jobs and applies the new filters', async () => {
  const ids = async (q) => {
    const r = await api(`/api/jobs${q}`);
    assert.equal(r.ok, true, `${q}: ${JSON.stringify(r.errors)}`);
    return r.jobs.map((j) => j.id).sort();
  };
  assert.deepEqual(await ids(''), ['d1', 't1', 'w1', 'w2'], 'no drafts, closed or sample jobs');
  assert.deepEqual(await ids('?skill=Forklift'), ['w1']);
  assert.deepEqual(await ids('?skills=forklift,%20safety'), ['w1']);
  assert.deepEqual(await ids('?skill=Forklift&skill=Picking'), []);
  assert.deepEqual(await ids('?company=b%20co'), ['w2']);
  assert.deepEqual(await ids('?shift=Night'), ['w1']);
  assert.deepEqual(await ids('?employmentType=gig'), ['d1']);
  assert.deepEqual(await ids('?type=Temporary&location=Maharashtra'), ['w2']);
  assert.deepEqual(await ids('?location=Remote'), ['t1']);
  assert.deepEqual(await ids('?minPay=50000'), ['t1']);
  assert.deepEqual(await ids('?experience=mid'), ['t1', 'w1', 'w2', 'd1'].filter((id) => id !== 'w1' && id !== 'w2' && id !== 'd1').concat(['d1', 'w1', 'w2']).sort());
  // Typing slips: one more try with the closest words, and the API says so.
  const fixed = await api('/api/jobs?q=forklfit%20operater');
  assert.deepEqual([fixed.correctedQuery, fixed.jobs.map((j) => j.id)], ['forklift operator', ['w1']]);
  assert.equal((await api('/api/jobs?q=forklift')).correctedQuery, undefined);
  // Bad filters are refused with a reason.
  const bad = async (q) => (await json(`/api/jobs${q}`, 'GET')).json();
  assert.deepEqual((await bad('?shift=Evening')).errors, ['shift is invalid']);
  assert.deepEqual((await bad('?skills=a,b,c,d,e,f')).errors, ['choose up to 5 skills']);
  assert.deepEqual((await bad(`?skill=${'x'.repeat(41)}`)).errors, ['each skill must be 40 characters or fewer']);
  // Injection attempts are just text that matches nothing.
  assert.equal((await api("/api/jobs?company=A%20Co'%20OR%201%3D1--")).total, 0);

  // The page: filters, chips to remove them, the correction, and saving for signed-in candidates.
  const page = await (await get('/jobs?shift=Night&skills=Forklift')).text();
  assert.match(page, /Forklift Operator/);
  assert.doesNotMatch(page, /Warehouse Picker/);
  assert.match(page, /Night shift<\/option>/);
  assert.match(page, /Sign in to save this search/);
  assert.match(await (await get('/jobs?q=forklfit')).text(), /No jobs for “forklfit”. Showing results for <b>“forklift”<\/b>/);
  assert.match(await (await get('/jobs?shift=Night', people.asha)).text(), /Save this search/);

  // The job page shows its must-haves; the API includes them.
  const w1 = await (await get('/jobs/w1')).text();
  assert.match(w1, /<h2>Requirements<\/h2>/);
  assert.match(w1, /Forklift licence/);
  assert.match(w1, /Can start straight away/);
  assert.match(w1, /Physical work: Lifting up to 20 kg/);
  assert.doesNotMatch(w1, /How you match/, 'signed out: no match box');
  assert.deepEqual((await api('/api/jobs/w1')).job.requirements, { licences: ['Forklift licence'], startsImmediately: true, physical: 'Lifting up to 20 kg' });
});

test('recommendations follow the profile, preferences and saved jobs, with reasons', async () => {
  const patch = { ...ashaProfile, certifications: ['Forklift licence'] };
  delete patch.languages; delete patch.experiences; delete patch.education;
  const saved = await json('/api/candidate/profile', 'PATCH', patch, people.asha);
  assert.equal(saved.status, 200, await saved.text());
  const recs = (await api('/api/candidate/recommendations', people.asha)).recommendations;
  // The forklift job first; the delivery job for her saved search; the picker
  // job for the category she chose, though she has none of its skills; the
  // React job not at all.
  assert.deepEqual(recs.map((r) => r.job.id), ['w1', 'd1', 'w2']);
  assert.ok(recs[1].reasons.some((x) => /saved search/.test(x)), recs[1].reasons.join());
  assert.equal(recs[0].match.score, 87);
  assert.equal(recs[0].match.label, 'Strong match');
  assert.ok(recs[0].reasons.includes('In Warehouse & Packing, a category you chose'));
  assert.ok(recs[2].reasons.includes('Close to the roles you want'), 'she wants "warehouse" roles: Warehouse Picker');
  assert.ok(!recs[0].reasons.includes('Close to the roles you want'));
  assert.ok(recs[2].reasons.includes('In Warehouse & Packing, a category you chose'));
  assert.deepEqual(recs[0].match.factors.map((f) => f.key), ['skills', 'experience', 'location', 'salary', 'jobType']);
  assert.ok(!JSON.stringify(recs).includes('asha@'), 'no personal data in the reply');

  // Saved jobs drop out; changing preferences changes the result.
  assert.equal((await json('/api/candidate/saved-jobs/w2', 'PUT', {}, people.asha)).status, 200);
  assert.deepEqual((await api('/api/candidate/recommendations', people.asha)).recommendations.map((r) => r.job.id), ['w1', 'd1']);
  await json('/api/candidate/profile', 'PATCH', { preferences: { ...ashaProfile.preferences, types: ['Temporary'] } }, people.asha);
  assert.ok((await api('/api/candidate/recommendations', people.asha)).recommendations[0].match.score < 87);
  await json('/api/candidate/profile', 'PATCH', { preferences: ashaProfile.preferences }, people.asha);
  await json('/api/candidate/saved-jobs/w2', 'DELETE', undefined, people.asha);

  // Validation and sign-in.
  assert.equal((await json('/api/candidate/recommendations?limit=0', 'GET', undefined, people.asha)).status, 400);
  assert.equal((await json('/api/candidate/recommendations', 'GET')).status, 401);
  // Someone with an empty profile gets an empty list and help on the page.
  assert.deepEqual((await api('/api/candidate/recommendations', people.dev)).recommendations, []);
  assert.match(await (await get('/account/recommendations', people.dev)).text(), /No recommendations yet/);

  // Pages: the recommendations, the dashboard and the job page explain the match.
  const page = await (await get('/account/recommendations', people.asha)).text();
  assert.match(page, /Forklift Operator/);
  assert.match(page, /Why this job/);
  assert.match(page, /counts 40%/);
  assert.match(await (await get('/account', people.asha)).text(), /Strong match<\/b> \(87%\)/);
  const w1 = await (await get('/jobs/w1', people.asha)).text();
  assert.match(w1, /How you match/);
  assert.match(w1, /2 of 3 skills: Forklift, Inventory/);
  assert.match(w1, /Must-haves for this job/);
  assert.equal((await get('/candidate/recommendations')).headers.get('location'), '/account/recommendations');
});

test('the match API explains one open job for the signed-in candidate only', async () => {
  const r = await api('/api/jobs/w1/match', people.asha);
  assert.equal(r.ok, true);
  assert.deepEqual(r.match.matchedSkills, ['Forklift', 'Inventory']);
  assert.deepEqual(r.match.missingSkills, ['Safety']);
  assert.deepEqual(r.match.factors.map((f) => f.status), ['partial', 'met', 'met', 'met', 'met']);
  assert.deepEqual(r.match.requirements.map((x) => x.met), [true, true, null]);
  for (const id of ['x1', 'x2', 's1', 'nope']) assert.equal((await json(`/api/jobs/${id}/match`, 'GET', undefined, people.asha)).status, 404, id);
  assert.equal((await json('/api/jobs/w1/match', 'GET')).status, 401);
  // An employer session is not a candidate session.
  assert.equal((await json('/api/jobs/w1/match', 'GET', undefined, people.olga)).status, 401);
});

test('saved searches: create, list, change, delete, with validation and ownership', async () => {
  const create = (body, cookie = people.asha) => json('/api/candidate/saved-searches', 'POST', body, cookie);
  const made = await create({ name: 'Night forklift', filters: { skills: 'Forklift', shift: 'Night' }, frequency: 'weekly' });
  assert.equal(made.status, 201);
  const s = (await made.json()).savedSearch;
  assert.deepEqual([s.name, s.filters, s.frequency, s.alertEnabled], ['Night forklift', { skills: ['Forklift'], shift: 'Night' }, 'weekly', true]);
  assert.match(s.url, /^\/jobs\?skill=Forklift&shift=Night$/);
  // The same filters again: the existing one.
  const again = await create({ filters: { shift: 'Night', skill: 'forklift' } });
  assert.deepEqual([again.status, (await again.json()).existed], [200, true]);
  // Validation.
  for (const [body, msg] of [
    [{ filters: { shift: 'Evening' } }, 'shift is invalid'],
    [{ filters: { bogus: 1 } }, 'filters.bogus is not a search filter'],
    [{ filters: 'x' }, 'filters must be an object of search filters'],
    [{ frequency: 'hourly', filters: {} }, 'frequency must be one of: instant, daily, weekly'],
    [{ alertEnabled: 'maybe', filters: {} }, 'alertEnabled must be true or false'],
    [{ name: 'x'.repeat(151), filters: {} }, 'name must be 150 characters or fewer'],
    [{ owner: 'dev@example.in', filters: {} }, 'owner is not a saved search field'],
  ]) {
    const r = await create(body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.ok((await r.json()).errors.includes(msg), msg);
  }
  const list = await api('/api/candidate/saved-searches', people.asha);
  assert.ok(list.savedSearches.some((x) => x.id === s.id));
  assert.ok(list.savedSearches.some((x) => x.id === 'sa-daily'), 'the seeded ones too');
  assert.equal((await api('/api/candidate/saved-searches', people.dev)).savedSearches.length, 0, 'only your own');

  // Changing: only your own; frequency and alerts checked.
  assert.equal((await json(`/api/candidate/saved-searches/${s.id}`, 'PATCH', { alertEnabled: false }, people.dev)).status, 404);
  assert.equal((await json(`/api/candidate/saved-searches/${s.id}`, 'PATCH', { frequency: 'monthly' }, people.asha)).status, 400);
  const changed = await (await json(`/api/candidate/saved-searches/${s.id}`, 'PATCH', { alertEnabled: false, frequency: 'instant', name: 'Nights' }, people.asha)).json();
  assert.deepEqual([changed.savedSearch.alertEnabled, changed.savedSearch.frequency, changed.savedSearch.name], [false, 'instant', 'Nights']);
  assert.equal((await json(`/api/candidate/saved-searches/${s.id}`, 'PATCH', { filters: { categories: ['Delivery & Driving'] } }, people.asha)).status, 409, 'same filters as another of hers');

  // Deleting: only your own.
  assert.equal((await json(`/api/candidate/saved-searches/${s.id}`, 'DELETE', undefined, people.dev)).status, 404);
  assert.equal((await json(`/api/candidate/saved-searches/${s.id}`, 'DELETE', undefined, people.asha)).status, 200);
  assert.ok(!(await api('/api/candidate/saved-searches', people.asha)).savedSearches.some((x) => x.id === s.id));
  assert.equal((await json('/api/candidate/saved-searches', 'GET')).status, 401);

  // From the Find Jobs page: the current filters are saved, then managed on the page.
  const saved = await post('/account/saved-searches', { q: 'picker', location: 'Mumbai', type: 'Temporary', frequency: 'daily' }, people.dev);
  assert.match(loc(saved), /Search saved/);
  const page = await (await get('/account/saved-searches', people.dev)).text();
  assert.match(page, /“picker” · Mumbai · Temporary/);
  assert.match(page, /See 1 job/);
  const id = srv.records('job-alerts').find((x) => x.email === 'dev@example.in').id;
  assert.match(loc(await post(`/account/saved-searches/${id}`, { name: 'Mumbai pickers', frequency: 'weekly' }, people.dev)), /Saved search updated/);
  const rec = srv.records('job-alerts').find((x) => x.id === id);
  assert.deepEqual([rec.name, rec.frequency, rec.alertEnabled], ['Mumbai pickers', 'weekly', false], 'an unticked box switches emails off');
  assert.equal((await post(`/account/saved-searches/${id}/delete`, {}, people.asha)).status, 404, "someone else's");
  assert.match(loc(await post(`/account/saved-searches/${id}/delete`, {}, people.dev)), /deleted/);

  // Up to 20 each.
  for (let i = 0; i < 20; i++) await create({ filters: { q: `role${i}` } }, people.dev);
  const over = await create({ filters: { q: 'one more' } }, people.dev);
  assert.equal(over.status, 409);
  for (const x of (await api('/api/candidate/saved-searches', people.dev)).savedSearches) await json(`/api/candidate/saved-searches/${x.id}`, 'DELETE', undefined, people.dev);
});

test('alerts go out as chosen: instantly, or in a daily email; weekly waits; unsubscribing keeps the search', async () => {
  // Dev wants instant alerts for delivery work.
  await json('/api/candidate/saved-searches', 'POST', { filters: { categories: ['Delivery & Driving'] }, frequency: 'instant' }, people.dev);
  const before = srv.emails().length;
  const form = { title: 'Bike Courier', company: 'Acme', location: 'Pune', mode: 'On-site', type: 'Daily wage / Gig', category: 'Delivery & Driving', experience: '', salary: '', description: 'Deliveries around Pune.', skills: 'Two-Wheeler Driving' };
  assert.equal((await srv.request('/admin/jobs', { method: 'POST', form, cookie: people.admin, headers: headers() })).status, 302);
  const courier = srv.records('jobs').find((j) => j.title === 'Bike Courier');
  await srv.waitForEmail((m) => m.includes('To: dev@example.in') && m.includes('New job: Bike Courier'));
  // Asha's daily search sends a summary; her weekly one keeps the job for later.
  const digest = decodeEmail(await srv.waitForEmail((m) => m.includes('To: asha@example.in') && m.includes('new job for Delivery work')));
  assert.match(digest, /Bike Courier/);
  assert.match(digest, /List-Unsubscribe:\s+<[^>]*\/job-alerts\/unsubscribe\/a{48}>/);
  assert.equal(srv.emails().slice(before).filter((m) => m.includes('To: asha@example.in') && m.includes('New job: Bike Courier')).length, 0, 'no instant email for her');
  await until(() => srv.records('job-alerts').find((x) => x.id === 'sa-daily').pending.length === 0);
  const weekly = srv.records('job-alerts').find((x) => x.id === 'sa-weekly');
  assert.deepEqual(weekly.pending, [courier.id]);
  assert.ok((await api('/api/notifications?category=jobs', people.asha)).notifications.some((n) => n.title === '1 new job for “Delivery work”'));
  await settle(800);
  assert.equal(srv.emails().filter((m) => m.includes('To: asha@example.in') && m.includes('Pune delivery weekly')).length, 0, 'weekly not due yet');

  // Unsubscribing from the email turns the alerts off and keeps the search.
  const res = await srv.request(`/job-alerts/unsubscribe/${'a'.repeat(48)}`, { method: 'POST', headers: headers() });
  assert.match(await res.text(), /stays in your account/);
  const sub = srv.records('job-alerts').find((x) => x.id === 'sa-daily');
  assert.equal(sub.alertEnabled, false);
  // My data includes the saved searches.
  const mine = JSON.parse(await (await get('/account/my-data.json', people.asha)).text());
  assert.ok(mine.jobAlerts.some((a) => a.savedSearch === 'Delivery work' && a.alerts === 'off'));
});

// A real Word resume, built in memory.
async function docx(lines) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${lines.map((t) => `<w:p><w:r><w:t>${esc(t)}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}
const fileForm = (buf, name) => {
  const fd = new FormData();
  fd.append('resume', new Blob([buf]), name);
  return fd;
};
const parse = (fd, cookie) => srv.request('/api/candidate/resumes/parse', { method: 'POST', body: fd, cookie, headers: headers({ accept: 'application/json' }) });

test('resume parsing reads valid files and refuses malformed, oversized and unsafe ones', async () => {
  const good = await docx(SAMPLE_RESUME.split('\n'));
  const files = () => fs.readdirSync(srv.paths.uploads).length;
  const before = files();
  const ok = await parse(fileForm(good, 'asha.docx'), people.asha);
  assert.equal(ok.status, 200);
  const r = await ok.json();
  assert.equal(r.saved, false);
  assert.ok(r.extracted.skills.includes('Excel'), 'skills not yet on her profile');
  assert.ok(!r.extracted.skills.includes('Forklift'), 'skills she already has are left out');
  assert.deepEqual(r.extracted.experiences.map((e) => e.title), ['Warehouse Supervisor', 'Inventory Executive', 'Forklift Operator']);
  assert.equal(r.extracted.education[0].level, 'Graduate');
  assert.equal((await api('/api/candidate/profile', people.asha)).profile.experiences.length, 0, 'nothing saved');
  await settle(300);
  assert.equal(files(), before, 'a file sent only for reading is not kept');

  const fail = async (buf, name) => {
    const res = await parse(fileForm(buf, name), people.asha);
    return [res.status, ((await res.json()).errors || [])[0]];
  };
  assert.deepEqual(await fail(Buffer.from('%PDF-1.4 not really a pdf'), 'scan.pdf'), [422, "We couldn't read text from this resume (it may be a scan or an old .doc file). You can fill in your profile yourself."]);
  assert.deepEqual(await fail(Buffer.from('PK\u0003\u0004 broken zip'), 'broken.docx'), [422, "We couldn't read text from this resume (it may be a scan or an old .doc file). You can fill in your profile yourself."]);
  assert.equal((await fail(Buffer.alloc(5 * 1024 * 1024 + 10, 0x20), 'huge.pdf'))[0], 413);
  assert.deepEqual(await fail(Buffer.from('MZ\u0090\u0000 a program'), 'cv.pdf'), [400, "That file doesn't look like a real PDF or Word document. Please upload your resume as a PDF, DOC or DOCX."]);
  assert.deepEqual(await fail(Buffer.from('MZ program'), 'cv.exe'), [400, 'Resume must be a PDF, DOC or DOCX file']);
  await settle(300);
  assert.equal(files(), before, 'refused files are not kept either');
  assert.equal((await parse(fileForm(good, 'asha.docx'))).status, 401);
  assert.equal((await json('/api/candidate/resumes/parse', 'POST', { resumeId: 'nope' }, people.asha)).status, 404);
});

test('a stored resume fills the profile only with what the candidate checked, and stays unchanged', async () => {
  const fd = fileForm(await docx(SAMPLE_RESUME.split('\n')), 'asha.docx');
  const up = await srv.request('/api/candidate/resumes', { method: 'POST', body: fd, cookie: people.asha, headers: headers({ accept: 'application/json' }) });
  assert.equal(up.status, 201);
  const { resume } = await up.json();
  const stored = srv.records('candidates').find((c) => c.email === 'asha@example.in').resumes.find((x) => x.id === resume.id);
  const hash = () => crypto.createHash('sha256').update(fs.readFileSync(path.join(srv.paths.uploads, stored.file))).digest('hex');
  const original = hash();
  assert.equal((await json('/api/candidate/resumes/parse', 'POST', { resumeId: resume.id }, people.asha)).status, 200);

  const review = await (await get(`/account/resumes/${resume.id}/review`, people.asha)).text();
  assert.match(review, /value="Warehouse Supervisor"/);
  assert.match(review, /value="Acme Logistics Pvt Ltd"/);
  assert.match(review, /Nothing is saved yet/);
  assert.equal((await get(`/account/resumes/${resume.id}/review`, people.dev)).status, 404, "someone else's resume");

  // A mistake is shown back, nothing saved.
  const wrong = await post(`/account/resumes/${resume.id}/review`, { exp0_keep: '1', exp0_title: 'Supervisor', exp0_from: '2024-13' }, people.asha);
  assert.equal(wrong.status, 400);
  assert.match(await wrong.text(), /must look like 2024-06/);
  // She corrects the title, keeps one job and her degree, and one new skill.
  const res = await post(`/account/resumes/${resume.id}/review`, {
    skills: 'Excel', exp0_keep: '1', exp0_title: 'Senior Warehouse Supervisor', exp0_company: 'Acme Logistics Pvt Ltd', exp0_from: '2021-01', exp0_current: '1',
    exp1_title: 'Inventory Executive', edu0_keep: '1', edu0_level: 'Graduate', edu0_course: 'B.Com', edu0_institution: 'Pune University', edu0_year: '2015',
  }, people.asha);
  assert.match(loc(res), /updated from your resume/);
  const p = (await api('/api/candidate/profile', people.asha)).profile;
  assert.deepEqual(p.experiences.map((e) => [e.title, e.current]), [['Senior Warehouse Supervisor', true]]);
  assert.deepEqual(p.education.map((e) => e.course), ['B.Com']);
  assert.ok(p.skills.includes('Excel') && p.skills.includes('Forklift'));
  assert.equal(hash(), original, 'the resume file is untouched');
  // She can still edit her profile by hand.
  assert.equal((await json('/api/candidate/profile', 'PATCH', { experiences: [] }, people.asha)).status, 200);
});

test('employers find only candidates who agreed, without contact details, within their permissions', async () => {
  const list = async (q, cookie = people.olga) => {
    const res = await json(`/api/employers/candidates${q}`, 'GET', undefined, cookie);
    return [res.status, await res.json()];
  };
  // Off by default.
  assert.equal((await list(''))[1].total, 0);
  assert.equal((await json('/api/candidate/profile', 'PATCH', { privacy: { discoverable: true }, experiences: [{ title: 'Supervisor', company: 'Secret Employer Ltd', from: '2021-01', current: true }] }, people.asha)).status, 200);
  const [, all] = await list('');
  assert.equal(all.total, 1);
  const card = all.candidates[0];
  assert.equal(card.displayName, 'Asha K.');
  assert.deepEqual(card.recentRoles, ['Supervisor']);
  const text = JSON.stringify(all);
  for (const secret of ['asha@', '9845012345', 'Kumar', 'Secret Employer', 'resume']) assert.ok(!text.includes(secret), secret);

  // Filters.
  const count = async (q) => (await list(q))[1].total;
  assert.equal(await count('?skill=Forklift'), 1);
  assert.equal(await count('?skill=React'), 0);
  assert.equal(await count('?location=Pune'), 1);
  assert.equal(await count('?location=Maharashtra'), 1);
  assert.equal(await count('?location=Delhi'), 0);
  assert.equal(await count('?available=now&shift=Night&experience=1-3%20years&type=Full-time'), 1);
  assert.equal(await count('?q=forklift'), 1);
  assert.deepEqual((await list('?shift=Evening'))[0], 400);
  // Sorted by match with one of the company's own jobs; another company's job is refused.
  const [, byJob] = await list('?job=w1');
  assert.deepEqual([byJob.sort, byJob.job.id, typeof byJob.candidates[0].match.score], ['match', 'w1', 'number']);
  assert.deepEqual((await list('?job=w2'))[1].errors, ['job must be one of your open jobs']);
  assert.deepEqual((await list('?job=x1'))[1].errors, ['job must be one of your open jobs']);

  // Who may search: owners, hiring managers and recruiters of verified companies.
  assert.deepEqual((await list('', people.vik))[0], 403, 'viewer');
  assert.deepEqual((await list('', people.uma))[0], 403, 'company not verified yet');
  assert.match(await (await get('/employer/candidates', people.uma)).text(), /opens once the Hireriv team has verified your company/);
  assert.equal((await json('/api/employers/candidates', 'GET')).status, 401);
  assert.equal((await json('/api/employers/candidates', 'GET', undefined, people.asha)).status, 401, 'a candidate session is not an employer');
  assert.equal((await get('/employer/candidates')).headers.get('location'), '/employer/login');
  const page = await (await get('/employer/candidates?job=w1', people.olga)).text();
  assert.match(page, /Asha K\./);
  assert.match(page, /How they match Forklift Operator/);
  assert.doesNotMatch(page, /asha@example\.in|9845012345/);

  // Inviting: to the company's own open job, once, recorded, and the candidate decides.
  const invite = (id, jobId, cookie = people.olga) => json(`/api/employers/candidates/${id}/invites`, 'POST', { jobId }, cookie);
  assert.equal((await invite(card.id, 'w2')).status, 400, "another company's job");
  assert.equal((await invite(card.id, 'w1', people.bob)).status, 400, 'bob can see her but not invite her to A Co jobs');
  assert.equal((await invite(card.id, 'w1', people.vik)).status, 403);
  assert.equal((await invite('nobody', 'w1')).status, 404);
  assert.equal((await invite(card.id, 'w1')).status, 201);
  const twice = await invite(card.id, 'w1');
  assert.deepEqual([twice.status, (await twice.json()).existed], [200, true]);
  await settle();
  const notes = (await api('/api/notifications?category=jobs', people.asha)).notifications.filter((n) => n.title === 'A Co invites you to apply: Forklift Operator');
  assert.equal(notes.length, 1);
  const mail = decodeEmail(await srv.waitForEmail((m) => m.includes('To: asha@example.in') && m.includes('Invitation to apply: Forklift Operator at A Co')));
  assert.match(mail, /haven't seen your name, phone number, email or resume/);
  assert.ok(srv.records('employer-audit').some((e) => e.employerId === 'emp-a' && e.event === 'candidate-invited'), 'recorded in the activity log');
  assert.equal((await api('/api/employers/candidates', people.olga)).candidates[0].invitedTo[0], 'w1');
  const mine = JSON.parse(await (await get('/account/my-data.json', people.asha)).text());
  assert.deepEqual(mine.invitationsFromEmployers.map((i) => [i.job, i.company]), [['Forklift Operator', 'A Co']]);

  // She switches it off: gone at once, and can't be invited.
  await json('/api/candidate/profile', 'PATCH', { privacy: { discoverable: false } }, people.asha);
  assert.equal((await list(''))[1].total, 0);
  assert.equal((await invite(card.id, 'w1')).status, 404);
});

test('employers can sort their applicants by skill match', async () => {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ jobId: 'w1', name: 'Ravi Patil', email: 'ravi@example.in', phone: '9822233344', skills: 'Forklift, Inventory, Safety' })) fd.append(k, v);
  fd.append('resume', new Blob(['%PDF-1.4 test'], { type: 'application/pdf' }), 'cv.pdf');
  assert.equal((await srv.request('/api/apply', { method: 'POST', body: fd, headers: headers({ accept: 'application/json' }) })).status, 200);
  const fd2 = new FormData();
  for (const [k, v] of Object.entries({ jobId: 'w1', name: 'Sunil More', email: 'sunil@example.in', phone: '9822233345', skills: 'Cooking' })) fd2.append(k, v);
  fd2.append('resume', new Blob(['%PDF-1.4 test'], { type: 'application/pdf' }), 'cv.pdf');
  assert.equal((await srv.request('/api/apply', { method: 'POST', body: fd2, headers: headers({ accept: 'application/json' }) })).status, 200);
  const order = (html) => ['Ravi Patil', 'Sunil More'].sort((a, b) => html.indexOf(a) - html.indexOf(b));
  assert.deepEqual(order(await (await get('/employer/applicants?job=w1&sort=match', people.olga)).text()), ['Ravi Patil', 'Sunil More']);
  assert.deepEqual(order(await (await get('/employer/applicants?job=w1&sort=newest', people.olga)).text()), ['Sunil More', 'Ravi Patil']);
});

test('Admins set the matching weights; they must add up to 100', async () => {
  const settings = {
    tagline: 'Hiring', phone: '+91 98765 43210', whatsapp: '919812345678', email: 'hello@hireriv.com', address: 'Kolkata', hours: '9-6',
    stat_value_0: '10', stat_label_0: 'Hires', jobCategories: 'Warehouse & Packing\nTechnology\nDelivery & Driving', jobLocations: 'Pune\nMumbai\nRemote',
    billing_feePercent: '8.33', billing_guaranteeDays: '90', billing_gstPercent: '18', billing_paymentDays: '15', billing_tdsPercent: '10',
  };
  const w = (skills, experience, location, salary, jobType) => ({ match_skills: skills, match_experience: experience, match_location: location, match_salary: salary, match_jobType: jobType });
  const bad = await srv.request('/admin/settings', { method: 'POST', cookie: people.admin, form: { ...settings, ...w('50', '20', '15', '15', '10') } });
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /matching weights must add up to 100 \(they add up to 110\)/);
  assert.equal((await srv.request('/admin/settings', { method: 'POST', cookie: people.admin, form: { ...settings, ...w('80', '5', '5', '5', '5') } })).status, 302);
  assert.equal((await api('/api/jobs/w1/match', people.asha)).match.factors[0].weight, 80);
  assert.match(await (await srv.request('/admin?tab=settings', { cookie: people.admin })).text(), /name="match_skills"[^>]*value="80"/);
  // A settings form without the weights keeps them.
  assert.equal((await srv.request('/admin/settings', { method: 'POST', cookie: people.admin, form: settings })).status, 302);
  assert.equal((await api('/api/jobs/w1/match', people.asha)).match.factors[0].weight, 80);
});
