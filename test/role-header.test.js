// Step 174: after signing in, the team and employers get their own work links
// in the header and the phone bar instead of the visitor menu (Login,
// Register, Saved jobs, Find Jobs…), and only for the sections they may open.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, decodeEmail } = require('./helpers');
const { hashPassword } = require('../employers');

const iso = (ago = 0) => new Date(Date.now() - ago).toISOString();
const EMP = { id: 'emp-r', company: 'Role Co', name: 'Rhea Sen', email: 'rhea@roleco.in', phone: '9800000003', passwordHash: hashPassword('rhea long password 1'), passwordSetAt: iso(86400000), active: true, approvedAt: iso(86400000), createdAt: iso(86400000) };

let srv;
const p = {};
const post = (url, form, cookie) => srv.request(url, { method: 'POST', form, cookie });
const page = async (url, cookie) => (await srv.request(url, { cookie })).text();
const headerOf = (html) => html.slice(html.indexOf('<header'), html.indexOf('</header>'));
const barOf = (html) => { const i = html.indexOf('<nav class="bottom-nav"'); return i === -1 ? '' : html.slice(i, html.indexOf('</nav>', i)); };
const VISITOR = /class="nav-login"|href="\/account\/register"|class="nav-saved|class="mobile-saved|href="\/jobs"|href="\/blog"|href="\/about"|href="\/contact"|href="\/employers"/;

before(async () => {
  srv = await startServer({}, { employers: [EMP] });
  p.admin = await srv.adminLogin();
  await post('/admin/team', { name: 'Farah', email: 'farah@hireriv.test', role: 'Finance Manager' }, p.admin);
  const link = decodeEmail(await srv.waitForEmail((e) => e.includes('To: farah@hireriv.test'))).match(/\/admin\/setup\/[a-f0-9]{64}/)[0];
  p.fin = srv.cookieFrom(await post(link, { password: 'Farah long password', confirm: 'Farah long password' }));
  p.owner = srv.cookieFrom(await post('/employer/login', { email: EMP.email, password: 'rhea long password 1' }));
  await post('/employer/team', { name: 'Bina', email: 'bina@roleco.in', role: 'billing' }, p.owner);
  const invite = decodeEmail(await srv.waitForEmail((e) => e.includes('To: bina@roleco.in'))).match(/\/employer\/setup\/[a-f0-9]{64}/)[0];
  p.billing = srv.cookieFrom(await post(invite, { password: 'Bina long password 1', confirm: 'Bina long password 1' }));
}, { timeout: 30000 });
after(() => srv && srv.stop());

test('the admin sees the team menu on every page, with Post a Job opening the admin form', async () => {
  for (const url of ['/', '/jobs', '/admin']) {
    const h = headerOf(await page(url, p.admin));
    assert.match(h, /<a href="\/admin" class="[^"]*"[^>]*>Dashboard<\/a><a href="\/admin\?tab=applications" class="[^"]*"[^>]*>Applications<\/a><a href="\/admin\?tab=jobs" class="[^"]*"[^>]*>Jobs<\/a><a href="\/admin\?tab=hire-requests" class="[^"]*"[^>]*>Hire requests<\/a>/, url);
    assert.match(h, /href="\/notifications\?as=team"/, url);
    assert.match(h, /<a href="\/admin\/jobs\/new" class="btn btn-primary btn-sm nav-cta">Post a Job<\/a>/, url);
    assert.doesNotMatch(h, VISITOR, url);
    assert.doesNotMatch(h, /href="\/post-a-job"/, url);
  }
  assert.match(headerOf(await page('/admin?tab=jobs', p.admin)), /<a href="\/admin\?tab=jobs" class="active" aria-current="page">Jobs<\/a>/);
  assert.match(headerOf(await page('/admin', p.admin)), /<a href="\/admin" class="active" aria-current="page">Dashboard<\/a>/);
  // Phones: the team's own bottom bar on public pages.
  const bar = barOf(await page('/', p.admin));
  assert.match(bar, /href="\/admin"[\s\S]*href="\/admin\?tab=applications"[\s\S]*href="\/admin\?tab=jobs"[\s\S]*href="\/admin\?tab=hire-requests"[\s\S]*href="\/admin\/jobs\/new"/);
  assert.doesNotMatch(bar, /href="\/saved"|href="\/account/);
});

test('a Finance Manager gets only the links their role opens', async () => {
  const h = headerOf(await page('/admin', p.fin));
  assert.doesNotMatch(h, /tab=applications|tab=jobs|tab=hire-requests|\/admin\/jobs\/new/);
  assert.doesNotMatch(h, VISITOR);
  assert.match(h, /href="\/notifications\?as=team"/);
});

test('an employer owner gets the employer menu; a billing member only billing', async () => {
  const h = headerOf(await page('/', p.owner));
  assert.match(h, /href="\/employer"[^>]*>Dashboard<\/a><a href="\/employer\/jobs"[^>]*>Jobs<\/a><a href="\/employer\/applicants"[^>]*>Applicants<\/a><a href="\/employer\/interviews"[^>]*>Interviews<\/a><a href="\/employer\/billing"[^>]*>Plans &amp; billing<\/a>/);
  assert.match(h, /<a href="\/employer\/jobs\/new" class="btn btn-primary btn-sm nav-cta">Post a Job<\/a>/);
  assert.doesNotMatch(h, VISITOR);
  assert.match(headerOf(await page('/employer/applicants', p.owner)), /<a href="\/employer\/applicants" class="active" aria-current="page">Applicants<\/a>/);
  const bar = barOf(await page('/', p.owner));
  assert.match(bar, /href="\/employer"[\s\S]*href="\/employer\/jobs"[\s\S]*href="\/employer\/applicants"[\s\S]*href="\/employer\/interviews"[\s\S]*href="\/employer\/jobs\/new"/);

  const b = headerOf(await page('/employer/billing', p.billing));
  assert.match(b, /href="\/employer\/billing"[^>]*>Plans &amp; billing<\/a><a href="\/employer\/invoices"[^>]*>Staffing invoices<\/a><a href="\/employer\/settings"[^>]*>Settings<\/a>/);
  assert.doesNotMatch(b, /href="\/employer\/jobs|href="\/employer\/applicants|nav-cta/);
});

test('visitors and job seekers keep the public menu', async () => {
  const h = headerOf(await page('/'));
  assert.match(h, /class="nav-login"[\s\S]*href="\/account\/register"/);
  assert.match(h, /href="\/post-a-job"/);
  assert.match(barOf(await page('/')), /href="\/saved"/);
});
