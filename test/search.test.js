// Job search and listings: pay as numbers, experience levels, states, keyword
// relevance, sorting, the public jobs API, reporting a job, job details and
// saved jobs kept in the candidate's account.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, decodeEmail } = require('./helpers');
const search = require('../search');

// ---------- unit ----------
test('pay: text, validation and reading older salary text', () => {
  assert.equal(search.payText({ min: 18000, max: 24000, period: 'month' }), '₹18,000 – 24,000 a month');
  assert.equal(search.payText({ min: 1400000, max: 2000000, period: 'year' }), '₹14 – 20 LPA');
  assert.equal(search.payText({ min: 800, max: null, period: 'day' }), 'From ₹800 a day');
  assert.equal(search.payText(null), '');
  assert.deepEqual(search.parsePayFields({ salaryMin: '30,000', salaryMax: '20000', salaryPeriod: 'month' }).errors, ['minimum pay cannot be more than the maximum']);
  assert.deepEqual(search.parsePayFields({ salaryMin: '-5', salaryMax: '', salaryPeriod: 'month' }).errors, ['minimum pay must be a positive number']);
  assert.deepEqual(search.parsePayFields({ salaryMin: '100', salaryMax: '', salaryPeriod: 'week' }).errors, ['choose whether the pay is per month, year, day or hour']);
  assert.deepEqual(search.parsePayFields({ salaryMin: '', salaryMax: '' }), { pay: null, errors: [] });
  assert.deepEqual(search.parsePayFields({ salaryMin: '₹15,000', salaryMax: '17000', salaryPeriod: 'month' }).pay, { min: 15000, max: 17000, period: 'month', currency: 'INR' });
  assert.deepEqual(search.payFromText('₹800 – 1,100 per day'), { min: 800, max: 1100, period: 'day', currency: 'INR' });
  assert.equal(search.payFromText('Competitive'), null);
  // Compared a month at a time: 26 days, 208 hours.
  assert.equal(search.monthlyMax({ pay: { min: 800, max: 1100, period: 'day' } }), 28600);
  assert.equal(search.monthlyMax({ pay: { min: 1200000, max: 1200000, period: 'year' } }), 100000);
  assert.equal(search.monthlyMax({ pay: null }), null);
});

test('experience levels and locations', () => {
  assert.deepEqual(search.experienceRange('3-5 years'), [3, 5]);
  assert.deepEqual(search.experienceRange('Freshers welcome'), [0, 0]);
  assert.deepEqual(search.experienceRange('10+ years'), [10, 99]);
  assert.equal(search.experienceRange(''), null);
  assert.equal(search.fitsLevel({ experience: '0-2 years' }, 'fresher'), true);
  assert.equal(search.fitsLevel({ experience: '3-5 years' }, 'fresher'), false);
  assert.equal(search.fitsLevel({ experience: '6-10 years' }, 'senior'), true);
  assert.equal(search.fitsLevel({ experience: '' }, 'senior'), true);
  assert.equal(search.inLocation({ location: 'Pune', mode: 'On-site' }, 'Maharashtra'), true);
  assert.equal(search.inLocation({ location: 'Pune', mode: 'On-site' }, 'Karnataka'), false);
  assert.equal(search.inLocation({ location: 'Remote', mode: 'Remote' }, 'Remote'), true);
  assert.deepEqual(search.statesOf(['Pune', 'Mumbai', 'Remote', 'Kolkata']), ['Maharashtra', 'West Bengal']);
});

test('keyword relevance: every word must match, titles count most; sorting is stable', () => {
  const jobs = [
    { id: 'a-1', title: 'Warehouse Supervisor', skills: [], company: 'X', category: 'Warehouse', description: '', posted: '2026-10-01' },
    { id: 'a-2', title: 'Driver', skills: ['Warehouse'], company: 'Y', category: 'Delivery', description: '', posted: '2026-10-05' },
    { id: 'a-3', title: 'Accountant', skills: ['Tally'], company: 'Z', category: 'Finance', description: 'Our warehouse office', posted: '2026-10-05' },
    { id: 'a-10', title: 'Accountant', skills: [], company: 'Z', category: 'Finance', description: '', posted: '2026-10-05' },
  ];
  assert.deepEqual(search.searchJobs(jobs, { q: 'warehouse' }).jobs.map((j) => j.id), ['a-1', 'a-2', 'a-3']);
  assert.deepEqual(search.searchJobs(jobs, { q: 'warehouse tally' }).jobs.map((j) => j.id), ['a-3']);
  // Same date: higher ids (newer) first, compared as numbers.
  assert.deepEqual(search.searchJobs(jobs, {}).jobs.map((j) => j.id), ['a-10', 'a-3', 'a-2', 'a-1']);
});

// ---------- the running site ----------
let srv;
let admin;
before(async () => {
  srv = await startServer({ TRUST_PROXY: '1' });
  admin = await srv.adminLogin();
});
after(() => srv && srv.stop());

const api = async (qs) => {
  const res = await srv.request(`/api/jobs${qs}`);
  return { status: res.status, body: await res.json() };
};
const ids = (body) => body.jobs.map((j) => j.id);

test('older salary text becomes numbers, keeping the extras as a note', () => {
  const job = (id) => srv.records('jobs').find((j) => j.id === id);
  assert.deepEqual(job('hr-113').pay, { min: 18000, max: 24000, period: 'month', currency: 'INR' });
  assert.equal(job('hr-113').payNote, '+ PF & ESI');
  assert.equal(job('hr-113').salary, '₹18,000 – 24,000 per month + PF & ESI');
  assert.deepEqual(job('hr-101').pay, { min: 1400000, max: 2000000, period: 'year', currency: 'INR' });
});

test('jobs API: published jobs only, with filters that work together', async () => {
  const all = await api('');
  assert.equal(all.status, 200);
  assert.equal(all.body.total, 18);
  assert.equal(all.body.limit, 20);
  assert.equal(all.body.sort, 'newest');
  const one = all.body.jobs.find((j) => j.id === 'hr-113');
  assert.deepEqual(one.location, { city: 'Pune', state: 'Maharashtra', country: 'IN', workArrangement: 'On-site' });
  assert.equal(one.employmentType, 'Full-time');
  assert.equal(one.payText, '₹18,000 – 24,000 per month + PF & ESI');

  assert.deepEqual(ids((await api('?keyword=warehouse')).body), ['hr-115']);
  assert.deepEqual(ids((await api('?keyword=warehouse&city=Navi%20Mumbai&employmentType=temporary&sort=newest&page=1&limit=20')).body), ['hr-115']);
  assert.deepEqual(ids((await api('?state=Maharashtra')).body).sort(), ['hr-104', 'hr-106', 'hr-113', 'hr-115']);
  assert.equal((await api('?location=Remote')).body.total, 2);
  assert.equal((await api('?category=Technology&category=Skilled%20Trades')).body.total, 5);
  assert.deepEqual(ids((await api('?experience=fresher')).body).sort(), ['hr-108', 'hr-112', 'hr-114', 'hr-115', 'hr-117']);
  // ₹20,000 a month or more: day and yearly pay compared a month at a time.
  const pay = ids((await api('?minPay=20000')).body);
  assert.equal(pay.length, 16);
  assert.ok(!pay.includes('hr-115') && !pay.includes('hr-117'));
  assert.equal(ids((await api('?sort=salary')).body)[0], 'hr-102');
  assert.deepEqual(ids((await api('?category=Technology&state=Haryana&experience=mid&minPay=100000')).body), ['hr-103']);
});

test('jobs API: pages never repeat or skip a job, and bad parameters are refused', async () => {
  const seen = [];
  for (let page = 1; page <= 4; page++) seen.push(...ids((await api(`?limit=5&page=${page}`)).body));
  assert.equal(seen.length, 18);
  assert.equal(new Set(seen).size, 18);
  assert.deepEqual((await api('?page=9&limit=5')).body.jobs, []);
  for (const qs of ['?limit=500', '?page=0', '?sort=random', '?employmentType=forever', '?city=Atlantis', '?category=Nope', '?minPay=lots', '?experience=guru']) {
    const r = await api(qs);
    assert.equal(r.status, 400, qs);
    assert.equal(r.body.ok, false, qs);
  }
  const job = await srv.request('/api/jobs/hr-101');
  assert.equal((await job.json()).job.pay.period, 'year');
  assert.equal((await srv.request('/api/jobs/nope')).status, 404);
});

test('Find Jobs page: state, several categories, experience, pay and sort, and help when nothing matches', async () => {
  const count = async (qs) => Number(((await (await srv.request(`/jobs${qs}`)).text()).match(/<b>(\d+)<\/b> jobs? found/) || [])[1]);
  assert.equal(await count('?location=Maharashtra'), 4);
  assert.equal(await count('?category=Technology&category=Skilled%20Trades'), 5);
  assert.equal(await count('?experience=fresher&minPay=20000'), 3);
  const sorted = await (await srv.request('/jobs?sort=salary')).text();
  assert.match(sorted, /<option value="salary" selected>Sort: highest pay<\/option>/);
  assert.ok(sorted.indexOf('Cloud / DevOps Engineer') < sorted.indexOf('Warehouse Picker'));
  // Pager links keep every chosen category.
  const paged = await (await srv.request('/jobs?category=Technology&category=Skilled%20Trades&sort=newest')).text();
  assert.match(paged, /name="category" value="Skilled Trades" checked/);

  const none = await (await srv.request('/jobs?q=zzzz&location=Pune')).text();
  assert.match(none, /No jobs match all of these filters/);
  assert.match(none, /<a href="\/jobs\?location=Pune" aria-label="Remove filter: “zzzz”">/);
  assert.match(none, /Clear all filters/);
  // A bad value in the page's address is ignored rather than breaking the page.
  assert.equal((await srv.request('/jobs?minPay=lots&sort=random')).status, 200);
});

test('job details: pay, workplace, facts, benefits and a report option', async () => {
  const form = {
    title: 'Packing Helper', company: 'Acme Foods', location: 'Pune', mode: 'On-site', type: 'Full-time', category: 'Warehouse & Packing',
    experience: 'Freshers welcome', salaryMin: '30000', salaryMax: '20000', salaryPeriod: 'month', payNote: '+ PF', education: '10th pass',
    schedule: 'Day shift, Mon–Sat', skills: 'Packing', description: 'Pack food products.', responsibilities: 'Pack boxes', qualifications: 'Can lift 15 kg',
    benefits: 'PF and ESI\nFree lunch', status: 'open',
  };
  const bad = await srv.request('/admin/jobs', { method: 'POST', cookie: admin, form });
  assert.equal(bad.status, 400);
  const badHtml = await bad.text();
  assert.match(badHtml, /minimum pay cannot be more than the maximum/);
  assert.match(badHtml, /name="salaryMin" inputmode="numeric" value="30000"/);

  const ok = await srv.request('/admin/jobs', { method: 'POST', cookie: admin, form: { ...form, salaryMin: '20000', salaryMax: '30000' } });
  assert.equal(ok.status, 302);
  const job = srv.records('jobs').find((j) => j.title === 'Packing Helper');
  assert.deepEqual(job.pay, { min: 20000, max: 30000, period: 'month', currency: 'INR' });
  assert.equal(job.salary, '₹20,000 – 30,000 a month + PF');
  assert.deepEqual(job.benefits, ['PF and ESI', 'Free lunch']);

  const html = await (await srv.request(`/jobs/${job.id}`)).text();
  assert.match(html, /Pune, Maharashtra/);
  assert.match(html, /<dt>Education<\/dt><dd>10th pass<\/dd>/);
  assert.match(html, /<dt>Work schedule<\/dt><dd>Day shift, Mon–Sat<\/dd>/);
  assert.match(html, /<li>Free lunch<\/li>/);
  assert.match(html, /<li>Can lift 15 kg<\/li>/);
  assert.match(html, /"minValue":20000,"maxValue":30000,"unitText":"MONTH"/);
  assert.match(html, /Report this job/);
  assert.doesNotMatch(html, /Verified employer/);
});

test('reporting a job reaches the team inbox', async () => {
  const report = (form) => srv.request('/api/jobs/hr-101/report', { method: 'POST', form, headers: { accept: 'application/json', 'x-forwarded-for': '10.9.0.1' } });
  const bad = await report({ reason: 'I just dislike it' });
  assert.equal(bad.status, 400);
  const ok = await report({ reason: 'Asks candidates to pay money', details: 'They asked me for a ₹2,000 registration fee', email: 'Someone@Example.in' });
  assert.equal((await ok.json()).ok, true);
  const [r] = srv.records('job-reports');
  assert.equal(r.jobId, 'hr-101');
  assert.equal(r.email, 'someone@example.in');
  await srv.waitForEmail((e) => e.includes('Job reported: Full-Stack Developer (MERN)'));
  const inbox = await (await srv.request('/admin?tab=job-reports', { cookie: admin })).text();
  assert.match(inbox, /Reported jobs/);
  assert.match(inbox, /registration fee/);
  assert.equal((await srv.request('/api/jobs/nope/report', { method: 'POST', form: { reason: 'Something else' } })).status, 404);
});

test('closed and expired jobs take no applications and leave search', async () => {
  const exp = await startServer({}, { jobs: [{ id: 'hr-201', title: 'Old Role', company: 'X', location: 'Pune', mode: 'On-site', type: 'Full-time', category: 'Technology', experience: '', salary: '', posted: '2026-01-01', closesOn: '2026-02-01', status: 'open', skills: [], description: 'Old', responsibilities: [], sample: false }] });
  try {
    assert.equal((await (await exp.request('/api/jobs')).json()).total, 0);
    assert.equal((await exp.request('/api/jobs/hr-201')).status, 404);
    const fd = new FormData();
    for (const [k, v] of Object.entries({ jobId: 'hr-201', name: 'A', email: 'a@example.in', phone: '9800000001' })) fd.append(k, v);
    fd.append('resume', new Blob(['%PDF-1.4'], { type: 'application/pdf' }), 'cv.pdf');
    const res = await exp.request('/api/apply', { method: 'POST', body: fd, headers: { accept: 'application/json' } });
    assert.equal(res.status, 400);
    assert.match(JSON.stringify(await res.json()), /no longer accepting applications/);
    assert.match(await (await exp.request('/jobs/hr-201')).text(), /This role is closed/);
  } finally {
    exp.stop();
  }
});

test('saved jobs and applications in the account, for the signed-in candidate only', async () => {
  assert.equal((await srv.request('/api/candidate/saved-jobs')).status, 401);
  assert.equal((await srv.request('/api/candidate/saved-jobs/hr-101', { method: 'PUT' })).status, 401);
  assert.equal((await srv.request('/api/candidate/applications')).status, 401);

  const fd = new FormData();
  for (const [k, v] of Object.entries({ name: 'Kiran Rao', email: 'kiran@example.in', phone: '9844455566', agree: '1' })) fd.append(k, v);
  await srv.request('/account/register', { method: 'POST', body: fd, headers: { 'x-forwarded-for': '10.9.0.2' } });
  const mail = decodeEmail(await srv.waitForEmail((e) => e.includes('To: kiran@example.in') && e.includes('Welcome to')));
  const cookie = srv.cookieFrom(await srv.request(mail.match(/\/account\/verify\/[A-Za-z0-9_-]+/)[0], { method: 'POST', form: {} }));

  const home = await (await srv.request('/', { cookie })).text();
  assert.match(home, /data-account="1"/);
  assert.match(home, />My account<\/a>/);
  assert.doesNotMatch(await (await srv.request('/')).text(), /data-account/);

  assert.equal((await srv.request('/api/candidate/saved-jobs/hr-101', { method: 'PUT', cookie })).status, 200);
  await srv.request('/api/candidate/saved-jobs/hr-101', { method: 'PUT', cookie });
  await srv.request('/api/candidate/saved-jobs/hr-113', { method: 'PUT', cookie });
  assert.equal((await srv.request('/api/candidate/saved-jobs/nope', { method: 'PUT', cookie })).status, 404);
  assert.deepEqual((await (await srv.request('/api/candidate/saved-jobs', { cookie })).json()).jobIds.sort(), ['hr-101', 'hr-113']);
  await srv.request('/api/candidate/saved-jobs/hr-101', { method: 'DELETE', cookie });
  assert.deepEqual((await (await srv.request('/api/candidate/saved-jobs', { cookie })).json()).jobIds, ['hr-113']);
  // Cross-site requests are refused.
  assert.equal((await srv.request('/api/candidate/saved-jobs/hr-102', { method: 'PUT', cookie, headers: { origin: 'https://evil.example' } })).status, 403);

  const apps = (await (await srv.request('/api/candidate/applications', { cookie })).json()).applications;
  assert.deepEqual(apps.map((a) => [a.job, a.status]), [['General application', 'Received']]);
  assert.ok(apps.every((a) => !('email' in a) && !('phone' in a)));

  const data = await (await srv.request('/account/my-data.json', { cookie })).json();
  assert.deepEqual(data.savedJobs.map((s) => s.jobId), ['hr-113']);
  await srv.request('/account/delete', { method: 'POST', cookie, form: { confirm: 'DELETE' } });
  assert.equal(srv.records('saved-jobs').filter((s) => s.email === 'kiran@example.in').length, 0);
});
