// Step 177: the job-seeker account pages are a console like the admin and
// employer portals: a sidebar with the person and their bell, the sections in
// groups with icons and the open one marked, and quick links; the page title
// sits beside it under a "My account · <group>" label.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, resumeForm, decodeEmail } = require('./helpers');

let srv;
let cookie;
before(async () => {
  srv = await startServer();
  await srv.request('/account/register', { method: 'POST', body: resumeForm({ agree: '1', name: 'Asha Rao', email: 'asha@example.in', phone: '9811100011', location: 'Hyderabad', experience: 'Fresher', skills: 'Billing' }) });
  await srv.request('/account/login', { method: 'POST', form: { email: 'asha@example.in' } });
  const mail = decodeEmail(await srv.waitForEmail((e) => e.includes('To: asha@example.in') && decodeEmail(e).includes('/account/verify/')));
  cookie = srv.cookieFrom(await srv.request(mail.match(/\/account\/verify\/[A-Za-z0-9_-]+/)[0], { method: 'POST', form: {} }));
  assert.ok(cookie);
}, { timeout: 30000 });
after(() => srv && srv.stop());

const page = async (url) => (await srv.request(url, { cookie })).text();
const sideOf = (html) => { const i = html.indexOf('<aside class="admin-side emp-side acct-side"'); return i === -1 ? '' : html.slice(i, html.indexOf('</aside>', i)); };

test('every account page has the sidebar with all sections in groups and the open one marked', async () => {
  const PAGES = [['/account', 'Dashboard', 'Overview'], ['/account/recommendations', 'Recommended', 'Overview'], ['/account/saved', 'Saved jobs', 'My jobs'], ['/account/saved-searches', 'Saved searches', 'My jobs'], ['/account/interviews', 'Interviews', 'My jobs'], ['/account/work', 'My work', 'My jobs'], ['/account/profile', 'Profile &amp; resume', 'Profile'], ['/account/settings', 'Settings', 'Account'], ['/account/privacy', 'Privacy &amp; data', 'Account']];
  for (const [url, name, group] of PAGES) {
    const html = await page(url);
    const side = sideOf(html);
    assert.ok(side, url);
    for (const label of ['Overview', 'My jobs', 'Profile', 'Account']) assert.match(side, new RegExp(`<span class="admin-nav-label">${label}</span>`), url);
    for (const [href] of PAGES) assert.ok(side.includes(`href="${href}"`), `${url} links ${href}`);
    const current = side.match(/<a class="tab active" href="([^"]+)" aria-current="page">.*?<span class="tab-name">([^<]+)<\/span><\/a>/);
    assert.ok(current, url);
    assert.equal(current[1], url);
    assert.equal(current[2], name);
    assert.equal((side.match(/aria-current="page"/g) || []).length, 1, url);
    assert.match(html, new RegExp(`<span class="admin-crumb">My account · ${group}</span>`), url);
    assert.match(side, /href="\/notifications\?as=candidate"/, url);
    assert.match(side, /<form method="post" action="\/account\/logout">/, url);
    assert.doesNotMatch(html, /<nav class="account-tabs"/, url);
  }
});

test('the sidebar names the person and links to finding jobs and the resume maker', async () => {
  const side = sideOf(await page('/account'));
  assert.match(side, /<b>Asha Rao<\/b><span>Job seeker<\/span>/);
  assert.match(side, /href="\/jobs">Find jobs</);
  assert.match(side, /href="\/account\/resume-builder">Make a resume</);
  // The resume maker belongs to the Profile section.
  assert.match(sideOf(await page('/account/resume-builder')), /<a class="tab active" href="\/account\/profile"/);
});
