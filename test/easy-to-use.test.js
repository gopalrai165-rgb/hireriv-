// Step 87: easier on a phone. Nothing widens the page, job lists show at once
// in compact cards with the pay in bold, the job search leaves room for the
// first jobs, the homepage speaks to job seekers (employer sections live on
// /hire), empty numbers are never shown, long link lists fold away, and the
// "add to home screen" banner waits until someone has looked around.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(ROOT, 'public/css/style.css'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'public/js/main.js'), 'utf8');

let srv;
before(async () => { srv = await startServer(); });
after(() => srv && srv.stop());
const html = async (url) => (await srv.request(url)).text();

test('nothing can make a page wider than the phone', () => {
  assert.match(css, /html \{ overflow-x: hidden; \}/);
  assert.match(css, /@supports \(overflow: clip\) \{ html, body \{ overflow-x: clip; \} \}/);
});

test('job lists: no fade-in, compact cards on phones, pay in bold', async () => {
  const page = await html('/jobs');
  assert.match(page, /<article class="job-card">/);
  assert.doesNotMatch(page, /class="job-card reveal/);
  assert.match(page, /<li class="job-pay">/);
  assert.match(page, /<section class="page-hero page-hero-search">/);
  assert.match(page, /Type a job, skill or company\. Small spelling mistakes are fine\./);
  assert.match(css, /\.page-hero-search \.eyebrow, \.page-hero-search \.lead/);
  assert.match(css, /\.job-card \{ padding: 16px; \}/);
});

test('the homepage is for job seekers; the employer story is on /hire', async () => {
  const home = await html('/');
  for (const gone of ['Recruiters who know your industry', 'A shortlist you can trust', 'One partner for both sides', 'Your extended HR department']) assert.ok(!home.includes(gone), gone);
  assert.match(home, /Hiring\? We&#39;ll find the right people|Hiring\? We'll find the right people/);
  assert.match(home, /Specialist recruiters for: <a href="\/industries\//);
  const hire = await html('/hire');
  for (const here of ['Recruiters who know your industry', 'A shortlist you can trust, every time', 'Your extended HR department']) assert.ok(hire.includes(here), here);
  assert.match(hire, /id="industries"/);
});

test('no empty numbers: "See jobs" instead of 0 jobs, no stats of zero', async () => {
  const home = await html('/');
  assert.doesNotMatch(home, />0 jobs</);
  assert.doesNotMatch(home, /data-target="0"/);
});

test('long link lists fold away, popular searches stay in view', async () => {
  const home = await html('/');
  const links = home.slice(home.indexOf('class="landing-links"'));
  assert.ok(links.indexOf('Popular searches') < links.indexOf('<details class="landing-more">'));
  assert.match(links, /<summary>More ways to find jobs: by kind of work, role, pay, city or industry<\/summary>/);
});

test('the install banner waits until the third page', () => {
  assert.match(js, /const VIEWS = 'hireriv:pages-seen';/);
  assert.match(js, /seen < 3 \|\|/);
});

test('job page: an Apply bar on phones while the details are read', async () => {
  const page = await html('/jobs/hr-101');
  const bar = page.match(/<div class="sticky-apply" data-sticky-apply hidden>[\s\S]*?<\/div>/);
  assert.ok(bar, 'the bar is on the page, hidden until main.js shows it');
  assert.match(bar[0], /<a href="#apply" class="btn btn-primary">Apply now<\/a>/);
  assert.match(js, /const onScreen = new Map\(\[\[top, true\], \[form, false\]\]\);/);
  assert.match(css, /\.sticky-apply:not\(\[hidden\]\)/);
});

test('forms: big tick boxes, sign-up form sooner on phones, red marks clear when fixed', () => {
  assert.match(css, /\.check-row input\[type="checkbox"\], \.check-row input\[type="radio"\] \{ width: 22px; height: 22px;/);
  assert.match(css, /form \.check-row \{ min-height: 44px;/);
  assert.match(css, /\.register-intro \.checks \{ display: none; \}/);
  assert.match(js, /document\.addEventListener\('input', \(e\) => \{ if \(e\.target\.getAttribute && e\.target\.getAttribute\('aria-invalid'\) === 'true'\)/);
});

test('account pages: tabs that fit, two columns of choices, no single-language picker, helpful empty pages', () => {
  assert.match(js, /document\.querySelectorAll\('\.account-tabs'\)\.forEach\(\(nav\) => \{/);
  assert.match(css, /\.account-tabs\[data-more="right"\]/);
  assert.match(css, /\.check-grid \.check-row:has\(input:checked\)/);
  const settings = fs.readFileSync(path.join(ROOT, 'views/account-settings.ejs'), 'utf8');
  assert.match(settings, /<% if \(languages\.length > 1\) \{ %>\n      <section class="dash-card" id="language"/);
  const saved = fs.readFileSync(path.join(ROOT, 'views/account-saved.ejs'), 'utf8');
  assert.ok(!saved.includes('☆'), 'the save button is a bookmark, not a star');
  assert.match(saved, /<a class="btn btn-primary" href="\/jobs">Find jobs<\/a>/);
  assert.match(fs.readFileSync(path.join(ROOT, 'views/account.ejs'), 'utf8'), /You haven&#39;t applied for a job yet/);
});
