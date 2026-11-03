// Homepage and header redesign: category groups, Job Categories page, Post a
// Job. A fresh install lists no jobs, no made-up figures and no testimonials.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');
const starter = require('./fixtures/jobs.json');

let srv;
let admin;
before(async () => {
  srv = await startServer({}, { jobs: starter.map((j) => ({ ...j, sample: false })) });
  admin = await srv.adminLogin();
});
after(() => srv && srv.stop());

const page = async (p, opts) => (await srv.request(p, opts)).text();
const found = (html) => Number((html.match(/<b>(\d+)<\/b> jobs? found/) || [])[1]);

test('header: Find Jobs, For Employers, Services, Career Resources, About, Contact, Login and Post a Job', async () => {
  const home = await page('/');
  for (const [href, label] of [['/jobs', 'Find Jobs'], ['/employers', 'For Employers'], ['/services', 'Services'], ['/blog', 'Career Resources'], ['/about', 'About'], ['/contact', 'Contact']]) {
    assert.match(home, new RegExp(`<a href="${href}"[^>]*>${label}</a>`), label);
  }
  assert.match(home, /href="\/account\/login"/);
  assert.match(home, /href="\/employer\/login"/);
  assert.match(home, /href="\/post-a-job"[^>]*>[^<]*Post a Job/);
  // Job seekers first: search by job and city, near me, popular roles, top cities.
  assert.match(home, /HIRERIV<\/b> <span>By Raigozen/);
  assert.match(home, /Find Talent\. Build Careers\. <span class="grad">Grow Faster\./);
  assert.match(home, /recruitment and staffing partner for IT and non-IT hiring across India/);
  assert.match(home, />Hire Employees</);
  assert.match(home, /placeholder="Job title, skill or company"/);
  assert.match(home, /Are you an employer\?[\s\S]*Request Staffing \/ Hire Talent/);
  // The sections below the banner, in order.
  const order = ['Latest verified jobs', 'Search jobs by role or city', 'Popular job categories', 'Recruitment and staffing services', 'Why choose Hireriv', 'How Hireriv works', 'Need staff? Tell us in a minute', 'Looking for a job? Register free', 'Questions, answered'];
  const at = order.map((h) => home.indexOf(h));
  assert.ok(at.every((i, n) => i > 0 && (n === 0 || i > at[n - 1])), JSON.stringify(at));
  for (const svc of ['IT Recruitment', 'Non-IT Recruitment', 'Bulk Hiring', 'Contract Staffing']) assert.match(home, new RegExp(`<h3>${svc}</h3>`));
  assert.match(home, /<input id="hero-q" name="q"[^>]*data-suggest/);
  assert.match(home, /<select id="hero-loc" name="location">/);
  assert.match(home, /data-near-me/);
  assert.match(home, /class="role-tile" href="\/jobs\/role\/delivery"/);
  assert.match(home, /class="city-tile" href="\/jobs\/in\/mumbai"/);
  assert.match(home, /href="\/account\/login\?with=phone"/);
  assert.match(home, /<nav class="bottom-nav"/);
  assert.doesNotMatch(home, /(white|blue|grey)[- ]collar/i);
});

test('Job Categories page and the group filter on Find Jobs', async () => {
  const html = await page('/categories');
  assert.match(html, /Browse jobs by category/);
  assert.match(html, /href="\/jobs\?group=healthcare"/);
  assert.match(html, /href="\/jobs\?category=Delivery%20%26%20Driving"/);
  const all = found(await page('/jobs'));
  const skilled = found(await page('/jobs?group=skilled-field'));
  const office = found(await page('/jobs?group=office'));
  assert.equal(skilled, 6);
  assert.equal(office + skilled, all);
  assert.equal(found(await page('/jobs?group=nonsense')), all);
});

test('Post a Job and Staffing Solutions links go to the right place', async () => {
  const post = await srv.request('/post-a-job');
  assert.equal(post.status, 302);
  assert.equal(post.headers.get('location'), '/employer/register');
  const sol = await srv.request('/staffing-solutions');
  assert.equal(sol.status, 301);
  assert.equal(sol.headers.get('location'), '/services');
});

test('a fresh install lists no jobs, no made-up figures and no testimonials', async () => {
  const fresh = await startServer({}, {}, { sampleJobs: true });
  try {
    assert.equal(fresh.records('jobs').length, 0);
    const home = await (await fresh.request('/')).text();
    assert.match(home, /New opportunities are added regularly/);
    for (const point of ['New opportunities', 'Free registration', 'Recruitment support', 'IT and non-IT']) assert.match(home, new RegExp(point));
    assert.doesNotMatch(home, /Vacancies filled|Professionals placed|Client satisfaction|Recruitment experts/);
    assert.doesNotMatch(home, /What clients and candidates say|Sample listing|Warehouse Associate/);
    const about = await (await fresh.request('/about')).text();
    assert.doesNotMatch(about, /Vacancies filled|data-target="1200"/);
    assert.doesNotMatch(await (await fresh.request('/hire')).text(), /interview-to-offer|avg\. time to shortlist/);
    assert.doesNotMatch(await (await fresh.request('/jobs')).text(), /Sample listing/);
  } finally { fresh.stop(); }
});

test('an older site loses its sample jobs, starter figures and sample testimonials once', async () => {
  const old = await startServer({}, {
    jobs: [...starter.slice(0, 3).map((j) => ({ ...j, sample: true })), { ...starter[3], sample: false }],
    site: [{ ...require('../data/site.json'), testimonials: undefined, stats: [
      { value: 1200, suffix: '+', label: 'Vacancies filled' }, { value: 3500, suffix: '+', label: 'Professionals placed' },
      { value: 98, suffix: '%', label: 'Client satisfaction' }, { value: 45, suffix: '+', label: 'Recruitment experts' },
    ] }],
  });
  try {
    assert.deepEqual(old.records('jobs').map((j) => j.id), [starter[3].id]);
    const [site] = old.records('site');
    assert.deepEqual(site.stats, []);
    assert.deepEqual(site.testimonials, []);
    assert.doesNotMatch(await (await old.request('/')).text(), /Vacancies filled|We needed eight engineers/);
  } finally { old.stop(); }
});

test('real figures and testimonials from Settings are shown', async () => {
  const form = { phone: '+91 98000 00000', whatsapp: '919800000000', email: 'hello@example.com', address: 'Pune', hours: '9-6', jobCategories: 'Technology', jobLocations: 'Pune',
    stat_value_0: '12', stat_suffix_0: '', stat_label_0: 'Placements this year', billing_feePercent: '8.33', billing_guaranteeDays: '90', billing_gstPercent: '18', billing_paymentDays: '15', billing_tdsPercent: '10', retentionMonths: '0',
    testimonial_quote_0: 'They found our accountant in a week.', testimonial_name_0: 'Owner', testimonial_detail_0: 'Pune bakery', testimonial_rating_0: '5' };
  const res = await srv.request('/admin/settings', { method: 'POST', cookie: admin, form });
  assert.equal(res.status, 302);
  const home = await page('/');
  assert.match(home, /Placements this year/);
  assert.match(home, /They found our accountant in a week\./);
  assert.doesNotMatch(home, /Free registration/);
});

test('the homepage enquiry form reaches the team as a hiring request from the homepage', async () => {
  const res = await srv.request('/api/hire', { method: 'POST', headers: { accept: 'application/json' }, form: { from: 'home', company: 'Nova Foods', name: 'Ravi', email: 'ravi@nova.example', phone: '9800000001', roles: '5 packers in Pune' } });
  assert.equal(res.status, 200);
  const req = srv.records('hire-requests').find((r) => r.company === 'Nova Foods');
  assert.equal(req.fromPage, 'homepage');
});

test('service cards lead with a photo, the enquiry says what happens next, and the service links are readable', async () => {
  const home = await page('/');
  for (const photo of ['svc-executive-search', 'svc-permanent-staffing', 'svc-bulk-rpo-hiring', 'svc-contract-staffing']) {
    assert.match(home, new RegExp(`<figure class="employer-photo"><img src="/img/photos/${photo}\.webp" alt="" width="900" height="1000" loading="lazy" decoding="async"></figure>`), photo);
    assert.equal((await srv.request(`/img/photos/${photo}.webp`)).status, 200, photo);
  }
  assert.match(home, /<ol class="next-steps">/);
  for (const step of ['A recruiter calls you back', 'You get a quote', 'You receive a shortlist']) assert.match(home, new RegExp(`<b>${step}</b>`), step);
  assert.match(home, /<a href="\/service-terms">service terms<\/a>/);
  const css = await page('/css/style.css');
  assert.match(css, /\.employer-desks \{ color: var\(--muted\); \}/, 'the links under the services band are not white on a light background');
  assert.match(css, /\.why-grid \{ align-items: stretch; \}/);
  assert.match(css, /\.page-home \.cat-grid \{ grid-template-columns: repeat\(10, 1fr\); \}/);
});

test('phone layout: link lists and contact links are easy to tap, admin bars wrap, figures sit two per row', async () => {
  const css = await page('/css/style.css');
  assert.match(css, /\.toc a, \.dev-toc a, \.salary-table th a, \.company-facts dd a \{ display: inline-block; padding-block: 7px; \}/);
  assert.match(css, /td > a:only-child \{ display: inline-block; padding-block: 6px; min-width: 24px; \}/);
  assert.match(css, /\.admin-userbar \{ flex-wrap: wrap; justify-content: flex-start;/);
  assert.match(css, /\.mini-stats \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(css, /\.dash-card > h2 \{ font-size: 1\.15rem;/);
});

test('latest jobs come first, before the search by role or city', async () => {
  const home = await page('/');
  const jobsAt = home.indexOf('id="latest-jobs"');
  assert.ok(jobsAt > 0 && jobsAt < home.indexOf('id="roles-title"'), 'jobs before role/city search');
  assert.ok(home.indexOf('class="hero') < jobsAt, 'still after the hero');
});
