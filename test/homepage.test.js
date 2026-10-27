// Homepage and header redesign: category groups, Job Categories page, Post a
// Job, and starter jobs labelled as samples (never shown as real vacancies).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

let srv;
let admin;
before(async () => {
  srv = await startServer({}, {}, { sampleJobs: true }); // like a fresh install
  admin = await srv.adminLogin();
});
after(() => srv && srv.stop());

const page = async (p, opts) => (await srv.request(p, opts)).text();
const found = (html) => Number((html.match(/<b>(\d+)<\/b> jobs? found/) || [])[1]);

test('header: Find Jobs, Job Categories, Staffing Solutions, Employers, Career Resources, Login and Post a Job', async () => {
  const home = await page('/');
  for (const [href, label] of [['/jobs', 'Find Jobs'], ['/categories', 'Job Categories'], ['/services', 'Staffing Solutions'], ['/hire', 'Employers'], ['/blog', 'Career Resources']]) {
    assert.match(home, new RegExp(`<a href="${href}"[^>]*>${label}</a>`), label);
  }
  assert.match(home, /href="\/account\/login"/);
  assert.match(home, /href="\/employer\/login"/);
  assert.match(home, /href="\/post-a-job"[^>]*>[^<]*Post a Job/);
  // Job seekers first: search by job and city, near me, popular roles, top cities.
  assert.match(home, /Find jobs near you\./);
  assert.match(home, /<input id="hero-q" name="q"[^>]*data-suggest/);
  assert.match(home, /<select id="hero-loc" name="location">/);
  assert.match(home, /data-near-me/);
  assert.match(home, /class="role-tile" href="\/jobs\?q=delivery"/);
  assert.match(home, /class="city-tile" href="\/jobs\?location=Mumbai"/);
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

test('starter jobs are labelled as samples, take no applications and stay out of Google', async () => {
  assert.ok(srv.records('jobs').every((j) => j.sample === true));
  const html = await page('/jobs/hr-114');
  assert.match(html, /noindex/);
  assert.doesNotMatch(html, /"@type":"JobPosting"/);
  assert.match(await page('/jobs'), /Sample/);

  const fd = new FormData();
  fd.append('jobId', 'hr-114'); fd.append('name', 'Test Person'); fd.append('phone', '9800000000');
  const res = await srv.request('/api/apply', { method: 'POST', body: fd, headers: { accept: 'application/json' } });
  assert.equal(res.status, 400);
  assert.match(JSON.stringify(await res.json()), /sample listing/);
  assert.equal(srv.records('applications').length, 0);

  assert.doesNotMatch(await page('/sitemap.xml'), /-hr-114</);
  assert.match(await page('/admin', { cookie: admin }), /Replace the \d+ sample jobs/);
});

test('editing a sample job makes it a real job', async () => {
  const job = srv.records('jobs').find((j) => j.id === 'hr-114');
  const form = {};
  for (const k of ['title', 'company', 'location', 'mode', 'type', 'category', 'experience', 'salary', 'description']) form[k] = job[k] || '';
  form.skills = (job.skills || []).join(', ');
  form.responsibilities = (job.responsibilities || []).join('\n');
  form.status = 'open';
  const res = await srv.request('/admin/jobs/hr-114', { method: 'POST', cookie: admin, form });
  assert.equal(res.status, 302);
  assert.equal(srv.records('jobs').find((j) => j.id === 'hr-114').sample, false);
  assert.match(await page('/jobs/hr-114'), /"@type":"JobPosting"/);
  assert.match(await page('/sitemap.xml'), /-hr-114</);
});
