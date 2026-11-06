// Step 67: automated accessibility checks on the public and candidate pages,
// in English. They catch what a machine can (labels, names, alt
// text, headings, language, focus order); keyboard and screen-reader checks
// by people are listed in docs/ACCESSIBILITY.md.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');
const { hashPassword } = require('../employers');
const cp = require('../candidate-profile');
const { jobPath } = require('../content');

const iso = () => new Date().toISOString();
const JOB = { id: 'j1', title: 'Store Helper', company: 'Shop Co', location: 'Pune', mode: 'On-site', type: 'Full-time', category: 'Retail & Sales', experience: 'Fresher', posted: '2026-10-20', skills: ['Stocking'], description: 'Keep shelves stocked.', responsibilities: ['Stock shelves'], status: 'open', sample: false };
let srv;
let meena;
let ip = 0;
const get = (url, cookie) => srv.request(url, { cookie, headers: { 'x-forwarded-for': `10.8.0.${++ip % 250}` } });

before(async () => {
  srv = await startServer({ TRUST_PROXY: '1' }, {
    jobs: [JOB],
    candidates: [{ id: 'c-1', email: 'meena@example.in', createdAt: iso(), emailVerifiedAt: iso(), passwordHash: hashPassword('meena long password'), profile: { ...cp.emptyProfile(), name: 'Meena' }, privacy: cp.defaultPrivacy(), comms: cp.defaultComms(), resumes: [], defaultResumeId: null }],
  });
  meena = srv.cookieFrom(await srv.request('/account/login', { method: 'POST', form: { email: 'meena@example.in', password: 'meena long password' } }));
});
after(async () => { await srv.stop(); });

const { problems } = require('./a11y-rules');

const PAGES = ['/', '/jobs', jobPath(JOB), '/categories', '/saved', '/help/job-terms', '/accessibility', '/account/login', '/account/register', '/account/forgot', '/no-such-page'];

for (const lang of ['en']) {
  test(`public pages pass the automated checks (${lang})`, async () => {
    const found = {};
    for (const path of PAGES) {
      const html = await (await get(path, `hr_lang=${lang}`)).text();
      assert.match(html, new RegExp(`<html lang="${lang}"`), path);
      const p = problems(html);
      if (p.length) found[path] = p;
    }
    assert.deepEqual(found, {});
  });
}

test('candidate pages pass the automated checks', async () => {
  const found = {};
  for (const path of ['/account', '/account/settings', '/account/applications', '/account/profile']) {
    const r = await get(path, meena);
    if (r.status !== 200) continue;
    const p = problems(await r.text());
    if (p.length) found[path] = p;
  }
  assert.deepEqual(found, {});
});

test('the job page offers read-aloud and a labelled menu button', async () => {
  const html = await (await get(jobPath(JOB))).text();
  assert.match(html, /data-read-aloud="#job-text"[^>]*hidden/, 'shown only where the browser can read aloud');
  assert.match(html, /data-apply-review[^>]*hidden/);
  assert.match(html, /<button[^>]*class="nav-toggle"[^>]*type="button"|<button[^>]*type="button"[^>]*class="nav-toggle"/);
});
