// Access control for every route: docs/ACCESS.md must match the code, and each
// protected route must turn away people without the right sign-in or role.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, decodeEmail } = require('./helpers');
const { sourceRoutes, documentedRoutes } = require('./routes');

const key = (r) => `${r.method} ${r.path} ${r.policy}`;
const fill = (p) => p.replace(/:[a-zA-Z]+/g, 'x');
const routes = sourceRoutes();

let srv;
let admin;
let recruiter;
before(async () => {
  srv = await startServer();
  admin = await srv.adminLogin();
  await srv.request('/admin/team', { method: 'POST', cookie: admin, form: { name: 'Rahul Das', email: 'rahul@hireriv.test', role: 'Recruiter' } });
  const link = decodeEmail(await srv.waitForEmail((e) => e.includes('rahul@hireriv.test'))).match(/\/admin\/setup\/[a-f0-9]{64}/)[0];
  recruiter = srv.cookieFrom(await srv.request(link, { method: 'POST', form: { password: 'rahul-long-password', confirm: 'rahul-long-password' } }));
});
after(() => srv && srv.stop());

test('docs/ACCESS.md lists every route with the protection it really has', () => {
  const inCode = new Set(routes.map(key));
  const inDocs = new Set(documentedRoutes().map(key));
  assert.ok(routes.length > 100, 'route parser found too few routes');
  assert.deepEqual([...inCode].filter((k) => !inDocs.has(k)), [], 'routes missing from docs/ACCESS.md (or protection changed)');
  assert.deepEqual([...inDocs].filter((k) => !inCode.has(k)), [], 'docs/ACCESS.md lists routes the code no longer has');
  assert.equal(inCode.size, routes.length, 'a route is defined twice');
});

test('signed out: team, candidate and client routes are all refused', async () => {
  const want = { team: [401], admin: [401], billing: [401], candidate: [302, '/account/login'], employer: [302, '/employer/login'], account: [401], apikey: [401] };
  for (const r of routes.filter((x) => want[x.policy])) {
    const res = await srv.request(fill(r.path), { method: r.method, form: r.method === 'POST' ? {} : undefined });
    // JSON endpoints answer 401 instead of redirecting to a sign-in page.
    const [status, location] = r.path.startsWith('/api/') ? [401] : want[r.policy];
    assert.equal(res.status, status, `${r.method} ${r.path}`);
    // Pages send people back where they were going after signing in.
    if (location) assert.ok([location, `${location}?next=${encodeURIComponent(fill(r.path))}`].includes(res.headers.get('location')), `${r.method} ${r.path}: ${res.headers.get('location')}`);
  }
});

test('Recruiters get 403 on every Admin-only and billing route', async () => {
  for (const r of routes.filter((x) => x.policy === 'admin' || x.policy === 'billing')) {
    const res = await srv.request(fill(r.path), { method: r.method, cookie: recruiter, form: r.method === 'POST' ? {} : undefined });
    assert.equal(res.status, 403, `${r.method} ${r.path}`);
  }
});

test('Recruiters: no Settings, Team or Activity tabs, no billing or activity exports', async () => {
  for (const tab of ['settings', 'team', 'activity']) {
    const html = await (await srv.request(`/admin?tab=${tab}`, { cookie: recruiter })).text();
    assert.doesNotMatch(html, new RegExp(`href="/admin\\?tab=${tab}"`), tab);
    assert.match(html, /Signed in as <b>Rahul Das<\/b> · Recruiter/);
  }
  assert.doesNotMatch(await (await srv.request('/admin?tab=settings', { cookie: recruiter })).text(), /Homepage testimonials/);
  for (const type of ['placements', 'activity']) assert.equal((await srv.request(`/admin/export/${type}.csv`, { cookie: recruiter })).status, 403, type);
  // Exports with personal data ask for the password again first.
  const ask = await srv.request('/admin/export/applications.csv', { cookie: recruiter });
  assert.equal(ask.status, 303);
  assert.equal(ask.headers.get('location'), `/admin/confirm?next=${encodeURIComponent('/admin/export/applications.csv')}`);
  await srv.request('/admin/confirm', { method: 'POST', cookie: recruiter, form: { password: 'rahul-long-password', next: '/admin/export/applications.csv' } });
  assert.equal((await srv.request('/admin/export/applications.csv', { cookie: recruiter })).status, 200);
  // Admins can.
  await srv.request('/admin/confirm', { method: 'POST', cookie: admin, form: { password: 'test-owner-password', next: '/admin' } });
  assert.equal((await srv.request('/admin/export/activity.csv', { cookie: admin })).status, 200);
});

test('a team cookie is no candidate or client sign-in, and the other way round', async () => {
  assert.equal((await srv.request('/account', { cookie: admin })).headers.get('location'), '/account/login');
  assert.equal((await srv.request('/employer', { cookie: admin })).headers.get('location'), '/employer/login');
  await srv.request('/account/login', { method: 'POST', form: { email: 'nobody@example.in' } });
  const forged = 'hr_cand=' + 'a'.repeat(64);
  assert.equal((await srv.request('/admin', { cookie: forged })).status, 401);
  assert.equal((await srv.request('/account', { cookie: forged })).headers.get('location'), '/account/login');
});

test('team forms refuse cross-site posts', async () => {
  const res = await srv.request('/admin/jobs', { method: 'POST', cookie: admin, form: { title: 'x' }, headers: { origin: 'https://evil.example' } });
  assert.equal(res.status, 403);
});
