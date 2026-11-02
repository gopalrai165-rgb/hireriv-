// The job seekers page: search, the kinds of work, how it works, safety and
// the general resume form, which saves an application with no particular job.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, resumeForm } = require('./helpers');

let srv;
before(async () => { srv = await startServer(); });
after(() => srv && srv.stop());
const page = async (p) => (await srv.request(p)).text();

test('the page has the search, the kinds of work, the steps, safety advice and the resume form', async () => {
  const html = await page('/job-seekers');
  for (const text of ['Find the Right Job. <span class="grad">Faster.</span>', 'Free for job seekers, always.', 'Jobs for every kind of work', 'How it works',
    'Apply to matching jobs in one tap.', 'Stay safe while job hunting', 'Never pay anyone to get an interview or a job', 'Let recruiters find you']) assert.ok(html.includes(text), text);
  assert.match(html, /<form class="seeker-search" action="\/jobs" method="get"/);
  for (const slug of ['office-professional', 'skilled-technical', 'industrial-field-service']) assert.match(html, new RegExp(`href="/jobs/${slug}"`));
  assert.match(html, /name="jobId" value="general"/);
  assert.match(html, /<title>[^<]+<\/title>/);
  for (const old of ['/jobseekers', '/for-job-seekers']) assert.equal((await srv.request(old)).headers.get('location'), '/job-seekers');
  assert.match(await page('/'), /href="\/job-seekers"/, 'the footer links to it');
  assert.match(await page('/sitemap.xml'), /\/job-seekers<\/loc>/);
});
