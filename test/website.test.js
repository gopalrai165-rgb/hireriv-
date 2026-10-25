// Step 58: the marketing website, SEO and employer lead generation. Every
// page in the sitemap works and has its own title, description and canonical
// address; job seekers' landing pages by kind of work and industry; valid
// job structured data only for open, real vacancies; robots rules; the
// public API without private data; employer inquiries into the CRM;
// candidate registration; and privacy-friendly conversion counts.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');
const catalog = require('../catalog');

const DAY = 86400000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const ymd = (msAgo) => new Date(Date.now() - msAgo).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const job = (id, extra) => ({
  id, title: 'Accountant', company: 'Hireriv Client', location: 'Pune', mode: 'On-site', type: 'Full-time', category: 'Finance & Accounting', experience: '2-4 years',
  posted: ymd(5 * DAY), approvedAt: iso(5 * DAY), skills: ['Tally'], description: 'Keep the books.', responsibilities: ['Month-end close'], qualifications: [], status: 'open', closesOn: ymd(-20 * DAY), sample: false,
  salary: '₹25,000 – 35,000 per month', pay: { min: 25000, max: 35000, period: 'month' }, ...extra,
});

let srv;
let ip = 0;
const UA = 'Mozilla/5.0 (Test)';
const headers = (extra = {}) => ({ 'x-forwarded-for': `10.58.${Math.floor(++ip / 250)}.${ip % 250}`, 'user-agent': UA, ...extra });
const get = (url, h = {}) => srv.request(url, { headers: headers(h) });
const html = async (url, h) => (await get(url, h)).text();
const call = async (url, method, body, extra = {}) => {
  const r = await srv.request(url, { method, body: JSON.stringify(body), headers: headers({ 'content-type': 'application/json', accept: 'application/json', ...extra }) });
  return { ...(r.status === 204 ? {} : await r.json()), status: r.status };
};
const ld = (page) => [...page.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
const flat = (docs) => docs.flatMap((d) => (d['@graph'] ? d['@graph'] : [d]));
const counts = () => srv.records('site-analytics');
const count = (event, label) => counts().filter((r) => r.event === event && (label === undefined || r.label === label)).reduce((n, r) => n + r.count, 0);

before(async () => {
  srv = await startServer({ TRUST_PROXY: '1', ANALYTICS_FLUSH_MS: '150' }, {
    employers: [{ id: 'emp-v', company: 'Verified Foods Pvt Ltd', name: 'Vina', email: 'vina@verifiedfoods.in', active: true, createdAt: iso(100 * DAY) }],
    jobs: [
      job('acc1'),
      job('dev1', { title: 'React Developer', category: 'Technology', skills: ['React'], salary: '₹12 – 18 LPA', pay: { min: 1200000, max: 1800000, period: 'year' } }),
      job('pick1', { title: 'Warehouse Picker', category: 'Warehouse & Packing', location: 'Chakan', salary: '₹16,000 – 19,000 per month', pay: { min: 16000, max: 19000, period: 'month' }, openings: 40 }),
      job('weld1', { title: 'Welder', category: 'Skilled Trades', location: 'Pune' }),
      job('own1', { title: 'Packing Supervisor', company: 'Verified Foods Pvt Ltd', employerId: 'emp-v', category: 'Factory & Production' }),
      job('old1', { title: 'Store Cashier', category: 'Store & Counter Staff', status: 'closed', closedAt: iso(DAY), closesOn: ymd(2 * DAY) }),
      job('smp1', { title: 'Sample Driver', category: 'Delivery & Driving', sample: true }),
    ],
  });
}, { timeout: 30000 });
after(() => srv && srv.stop());

test('every page in the sitemap works and has its own title, description and canonical address', async () => {
  const xml = await html('/sitemap.xml');
  const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]));
  for (const p of ['/jobs/office-professional', '/jobs/skilled-technical', '/jobs/industrial-field-service', ...catalog.JOB_INDUSTRIES.map((i) => `/jobs/industry/${i.slug}`), '/industries/construction-facility-management', '/industries/hospitality-travel']) {
    assert.ok(urls.some((u) => u.pathname === p), `${p} in the sitemap`);
  }
  assert.ok(!urls.some((u) => /old1|smp1/.test(u.pathname)), 'closed and sample jobs stay out');
  const titles = new Map();
  const descriptions = new Map();
  for (const u of urls) {
    const res = await get(u.pathname);
    assert.equal(res.status, 200, u.pathname);
    const page = await res.text();
    const title = page.match(/<title>([^<]+)<\/title>/)[1];
    const description = page.match(/<meta name="description" content="([^"]*)">/)[1];
    assert.doesNotMatch(page, /<meta name="robots" content="noindex/, `${u.pathname} is indexable`);
    assert.equal(page.match(/<link rel="canonical" href="([^"]+)">/)[1], u.href, `${u.pathname} canonical`);
    assert.ok(!titles.has(title), `${u.pathname} title also on ${titles.get(title)}`);
    assert.ok(!descriptions.has(description), `${u.pathname} description also on ${descriptions.get(description)}`);
    assert.ok(description.length >= 50, `${u.pathname} has a real description`);
    titles.set(title, u.pathname);
    descriptions.set(description, u.pathname);
    ld(page);
    assert.doesNotMatch(page, /(white|blue|grey)[- ]collar/i);
  }
});

test('landing pages for job seekers list the right live jobs, with breadcrumbs and pages', async () => {
  const office = await html('/jobs/office-professional');
  assert.match(office, /<h1>Office &amp; professional jobs in India<\/h1>/);
  assert.match(office, /Accountant/);
  assert.match(office, /React Developer/);
  assert.doesNotMatch(office, /Warehouse Picker|Welder/);
  const field = await html('/jobs/industrial-field-service');
  assert.match(field, /Warehouse Picker/);
  assert.doesNotMatch(field, /Store Cashier/, 'closed jobs are not presented as available');
  assert.match(await html('/jobs/skilled-technical'), /Welder/);
  const logistics = await html('/jobs/industry/warehousing-logistics');
  assert.match(logistics, /Warehouse Picker/);
  assert.match(logistics, /href="\/industries\/logistics-operations"/, 'employers find the recruitment desk');
  const graph = flat(ld(logistics));
  assert.ok(graph.some((x) => x['@type'] === 'BreadcrumbList' && x.itemListElement.length === 4));
  assert.ok(graph.some((x) => x['@type'] === 'CollectionPage' && x.mainEntity.itemListElement[0].url.includes('pick1')));
  const empty = await html('/jobs/industry/healthcare');
  assert.match(empty, /There are no open healthcare jobs right now/);
  assert.equal((await get('/jobs/industry/nope')).status, 404);
  // A page past the end falls back to the first, whose address is canonical.
  const p2 = await html('/jobs/office-professional?page=9');
  assert.match(p2, /<link rel="canonical" href="[^"]+\/jobs\/office-professional">/);
  // The desks cover several categories now.
  const desk = await html('/industries/construction-facility-management');
  assert.match(desk, /href="\/jobs\/industry\/construction-facility-management"/);
  assert.match(desk, /href="\/hire\?desk=construction-facility-management#requirement"/);
  const home = await html('/');
  for (const w of catalog.WORK_PAGES) assert.match(home, new RegExp(`href="/jobs/${w.slug}"`));
  assert.match(home, /href="\/hire"[^>]*>Hire Talent</);
  assert.match(home, /href="\/hire\?service=contract-staffing#requirement"[^>]*>Request Staffing</);
});

test('job structured data: only open, real vacancies, accurate details; closed jobs say so', async () => {
  const page = await html('/jobs/pick1');
  const posting = flat(ld(page)).find((x) => x['@type'] === 'JobPosting');
  assert.ok(posting);
  assert.equal(posting.title, 'Warehouse Picker');
  assert.equal(posting.employmentType, 'FULL_TIME');
  assert.equal(posting.jobLocation.address.addressLocality, 'Chakan');
  assert.deepEqual(posting.baseSalary.value, { '@type': 'QuantitativeValue', minValue: 16000, maxValue: 19000, unitText: 'MONTH' });
  assert.equal(posting.validThrough, `${ymd(-20 * DAY)}T23:59:59+05:30`);
  assert.equal(posting.totalJobOpenings, 40);
  assert.equal(posting.hiringOrganization.name, 'Hireriv', 'agency jobs keep the client confidential');
  assert.ok(flat(ld(page)).some((x) => x['@type'] === 'BreadcrumbList'));
  assert.doesNotMatch(JSON.stringify(ld(page)), /@[a-z0-9.-]+\.(in|com)/i, 'no email addresses in the markup');
  const own = flat(ld(await html('/jobs/own1'))).find((x) => x['@type'] === 'JobPosting');
  assert.equal(own.hiringOrganization.name, 'Verified Foods Pvt Ltd', "a verified employer's own job names it");
  const closed = await html('/jobs/old1');
  assert.ok(!flat(ld(closed)).some((x) => x['@type'] === 'JobPosting'));
  assert.match(closed, /<meta name="robots" content="noindex/);
  const sample = await html('/jobs/smp1');
  assert.ok(!flat(ld(sample)).some((x) => x['@type'] === 'JobPosting'));
  // The public API agrees.
  assert.equal((await call('/api/public/jobs/old1', 'GET')).status, 410);
  assert.equal((await call('/api/public/jobs/nope', 'GET')).status, 404);
  const slug = (await call('/api/public/jobs/pick1', 'GET')).job.slug;
  assert.equal((await call(`/api/public/jobs/${slug}`, 'GET')).job.title, 'Warehouse Picker');
});

test('indexing rules keep private areas and search variants out', async () => {
  const robots = await html('/robots.txt');
  for (const p of ['/admin', '/api/', '/account', '/employer', '/crm/', '/client', '/notifications', '/saved', '/feedback']) assert.ok(robots.includes(`Disallow: ${p}\n`), p);
  assert.match(robots, /Sitemap: http/);
  const search = await html('/jobs?q=accountant');
  assert.match(search, /<meta name="robots" content="noindex, follow">/);
  assert.doesNotMatch(await html('/jobs'), /<meta name="robots"/);
  for (const p of ['/admin', '/account', '/employer']) {
    const res = await get(p);
    assert.ok([302, 303, 401].includes(res.status) || /noindex/.test(await res.text()), p);
  }
  const missing = await get('/no-such-page');
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /noindex/);
  // The planned addresses lead to the existing pages.
  for (const [from, to] of [['/services/recruitment', '/services/permanent-staffing'], ['/services/staffing', '/services/contract-staffing'], ['/services/bulk-hiring', '/services/bulk-rpo-hiring'], ['/employers/contact', '/hire']]) {
    const res = await get(from);
    assert.equal(res.status, 301, from);
    assert.equal(res.headers.get('location'), to);
  }
});

test('public API: jobs, industries and site settings without private data', async () => {
  const list = await call('/api/public/jobs?limit=50', 'GET');
  assert.equal(list.status, 200);
  const ids = JSON.stringify(list);
  assert.ok(!/old1|smp1/.test(ids), 'only live, real jobs');
  assert.doesNotMatch(ids, /employerId|applications|candidateEmail|"email"/);
  const ind = await call('/api/public/industries', 'GET');
  assert.equal(ind.kindsOfWork.find((w) => w.slug === 'industrial-field-service').openJobs, 2);
  assert.equal(ind.industries.find((i) => i.slug === 'warehousing-logistics').openJobs, 1);
  const cfg = await call('/api/public/site-config', 'GET');
  assert.equal(cfg.site.name, 'Hireriv');
  assert.equal(cfg.analytics.cookies, false);
  assert.doesNotMatch(JSON.stringify(cfg), /gstin|bank|password|smtp|secret|billing|testimonials/i);
});

test('employer inquiries are validated, protected and go into the existing CRM', async () => {
  const bad = await call('/api/public/employer-inquiries', 'POST', { company: 'Delta', name: 'Dev', email: 'nope', phone: '9811100000', roles: 'x' });
  assert.equal(bad.status, 400);
  assert.equal((await call('/api/public/employer-inquiries', 'POST', { company: 'Delta', name: 'Dev', email: 'dev@delta.in', phone: '9811100000', roles: 'x', hiringType: 'Magic' })).status, 400);
  const bot = await call('/api/public/employer-inquiries', 'POST', { company: 'Bot', name: 'Bot', email: 'bot@bot.in', phone: '9811100001', roles: 'x', website: 'http://spam' });
  assert.equal(bot.status, 202);
  assert.ok(!srv.records('crm-leads').some((l) => l.email === 'bot@bot.in'));
  const ok = await call('/api/public/employer-inquiries', 'POST', { company: 'Delta Logistics', name: 'Divya Rao', email: 'divya@deltalogistics.in', phone: '9811100002', roles: '30 loaders', headcount: '21-50', hiringType: 'Bulk / RPO', location: 'Chakan', from: 'service:bulk-rpo-hiring' });
  assert.equal(ok.status, 202);
  assert.deepEqual(Object.keys(ok).filter((k) => k !== 'status').sort(), ['message', 'ok'], 'nothing internal in the reply');
  const lead = srv.records('crm-leads').find((l) => l.email === 'divya@deltalogistics.in');
  assert.equal(lead.source, 'Website inquiry');
  assert.match(lead.sourceDetail, /service page: Bulk & RPO Hiring|service page: /);
  // The same person again updates that lead instead of adding one.
  await call('/api/public/employer-inquiries', 'POST', { company: 'Delta Logistics', name: 'Divya Rao', email: 'divya@deltalogistics.in', phone: '9811100002', roles: '10 drivers' });
  assert.equal(srv.records('crm-leads').filter((l) => l.email === 'divya@deltalogistics.in').length, 1);
  // The form on the website does the same, remembering the page it came from.
  const page = await html('/hire?desk=hospitality-travel');
  assert.match(page, /<input type="hidden" name="from" value="desk:hospitality-travel">/);
  const form = await srv.request('/api/hire', { method: 'POST', form: { company: 'Hotel Aurora', name: 'Asha', email: 'asha@hotelaurora.in', phone: '9811100003', roles: '6 stewards', from: 'desk:hospitality-travel' }, headers: headers({ accept: 'application/json' }) });
  assert.equal(form.status, 200);
  assert.match(srv.records('crm-leads').find((l) => l.email === 'asha@hotelaurora.in').sourceDetail, /industry page: Hospitality & Travel/);
  // Rate limited per address.
  const same = headers();
  let last;
  for (let i = 0; i < 6; i++) last = await srv.request('/api/public/employer-inquiries', { method: 'POST', body: JSON.stringify({}), headers: { ...same, 'content-type': 'application/json' } });
  assert.equal(last.status, 429);
});

test('candidate registration works through the public API and the account stays private', async () => {
  const r = await call('/api/public/candidate-registrations', 'POST', { name: 'Kiran Patil', email: 'kiran@example.in', phone: '9822200001', password: 'Kiran long password 1', agree: true });
  assert.equal(r.status, 202, JSON.stringify(r.errors));
  await srv.waitForEmail((e) => e.includes('To: kiran@example.in'));
  assert.equal((await call('/api/public/candidate-registrations', 'POST', { name: 'X', email: 'bad' })).status, 400);
  assert.equal((await get('/account')).status, 302, 'the account needs signing in');
});

test('conversion counts: aggregated, no personal data, bots and opt-outs skipped, visible to the right team roles', async () => {
  await sleep(400);
  const views = count('job-view', 'Industrial, field & service');
  const started = count('application-started', 'Industrial, field & service');
  await get('/jobs/pick1');
  await get('/jobs/pick1', { 'user-agent': 'Googlebot/2.1 (+http://www.google.com/bot.html)' });
  await get('/jobs/pick1', { 'sec-gpc': '1' });
  await get('/jobs?q=accountant');
  await get('/jobs?q=zzzzqqq');
  await get('/services/permanent-staffing');
  assert.equal((await call('/api/public/events', 'POST', { event: 'application-started', jobId: 'pick1' })).status, 204);
  assert.equal((await call('/api/public/events', 'POST', { event: 'employer-inquiry' })).status, 400, 'browsers cannot report server-side events');
  await sleep(400);
  assert.equal(count('job-view', 'Industrial, field & service') - views, 1, 'one person, not the bot or the opted-out browser');
  assert.ok(count('job-search') >= 2);
  assert.ok(count('job-search-empty') >= 1);
  assert.ok(count('service-view', 'Permanent Staffing') >= 1 || count('service-view') >= 1);
  assert.equal(count('application-started', 'Industrial, field & service') - started, 1);
  assert.ok(count('employer-inquiry') >= 2);
  assert.ok(count('candidate-registration') >= 1);
  assert.ok(count('form-rejected', 'Employer inquiry') >= 1);
  const stored = JSON.stringify(counts());
  assert.doesNotMatch(stored, /@|98\d{8}|10\.58\.|Mozilla|Divya|Kiran/, 'no personal data in the counts');
  for (const r of counts()) assert.deepEqual(Object.keys(r).sort(), ['count', 'day', 'event', 'id', 'label']);

  // A won-over inquiry counts as qualified once, from the CRM.
  const admin = await srv.adminLogin();
  const lead = srv.records('crm-leads').find((l) => l.email === 'divya@deltalogistics.in');
  const patch = (status) => srv.request(`/api/crm/leads/${lead.id}`, { method: 'PATCH', cookie: admin, body: JSON.stringify({ status }), headers: headers({ 'content-type': 'application/json', accept: 'application/json' }) });
  assert.equal((await patch('qualified')).status, 200);
  await patch('contacted');
  await patch('qualified');
  await sleep(400);
  assert.equal(count('inquiry-qualified', 'Website inquiry'), 1);

  const page = await srv.request('/admin/site-analytics', { cookie: admin, headers: headers() });
  assert.equal(page.status, 200);
  const text = await page.text();
  assert.match(text, /Employer inquiries submitted/);
  assert.match(text, /no cookies, no IP addresses/);
  assert.ok([302, 401].includes((await get('/admin/site-analytics')).status), 'signed out');
});
