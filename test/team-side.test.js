// Step 184: the team's tool pages (analytics, agency and staffing, billing,
// security, trust, CRM, job and article forms…) show the same sidebar as /admin:
// the person and their bell, the admin sections their role allows, and the
// tools with the open one marked. /admin keeps its counts.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, decodeEmail } = require('./helpers');

let srv;
const p = {};
const page = async (url, cookie) => (await srv.request(url, { cookie })).text();
const sideOf = (html) => { const i = html.indexOf('<aside class="admin-side team-side"'); return i === -1 ? '' : html.slice(i, html.indexOf('</aside>', i)); };

before(async () => {
  srv = await startServer();
  p.admin = await srv.adminLogin();
  await srv.request('/admin/team', { method: 'POST', form: { name: 'Rekha', email: 'rekha@hireriv.test', role: 'Recruiter' }, cookie: p.admin });
  const link = decodeEmail(await srv.waitForEmail((e) => e.includes('To: rekha@hireriv.test'))).match(/\/admin\/setup\/[a-f0-9]{64}/)[0];
  p.rec = srv.cookieFrom(await srv.request(link, { method: 'POST', form: { password: 'Rekha long password', confirm: 'Rekha long password' } }));
}, { timeout: 30000 });
after(() => srv && srv.stop());

test('every team tool page has the team sidebar, with the open tool marked', async () => {
  for (const [url, tool] of [['/admin/analytics', 'Analytics'], ['/admin/workspace', 'Agency &amp; staffing'], ['/admin/notifications', 'Email delivery'], ['/admin/billing', 'Plans &amp; payments'], ['/admin/security-events', 'Security &amp; privacy'], ['/admin/overview', 'Trust &amp; safety'], ['/admin/security', 'Sign-in security'], ['/admin/site-analytics', 'Website analytics'], ['/admin/crm', 'Sales CRM']]) {
    const html = await page(url, p.admin);
    const side = sideOf(html);
    assert.ok(side, url);
    assert.match(side, /<span class="admin-nav-label">/, url);
    assert.match(side, /href="\/admin\?tab=applications"/, url);
    const open = side.match(/<a class="small active" href="([^"]+)" aria-current="page">([^<]+)<\/a>/);
    assert.ok(open, `${url} marks its tool`);
    assert.equal(open[2], tool, url);
    assert.equal((side.match(/aria-current="page"/g) || []).length, 1, url);
    assert.match(html, /<section class="section admin admin-console/, url);
  }
  for (const url of ['/admin/jobs/new', '/admin/blog/new', '/admin/applications/new']) assert.ok(sideOf(await page(url, p.admin)), url);
});

test('/admin keeps its counts and its open section', async () => {
  const side = sideOf(await page('/admin?tab=jobs', p.admin));
  assert.match(side, /<a class="tab active" href="\/admin\?tab=jobs" aria-current="page">.*<span class="tab-name">Jobs<\/span> <span class="count">\d+<\/span><\/a>/);
});

test('a recruiter sees only their sections and tools', async () => {
  const side = sideOf(await page('/admin/analytics', p.rec));
  assert.ok(side);
  assert.doesNotMatch(side, /href="\/admin\?tab=(settings|team|activity)"/);
  assert.doesNotMatch(side, /Email delivery|Plans &amp; payments|Security &amp; privacy/);
  assert.match(side, /href="\/admin\/analytics"/);
  // Not signed in to the team: no sidebar anywhere.
  assert.equal(sideOf(await page('/jobs')), '');
});
