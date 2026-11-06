// Step 185: second-Admin approval for bulk exports (export-approval.js). Off
// until an Admin turns it on; paused while the team has fewer than two Admins
// who can sign in (so a single owner is never locked out); an approval comes
// from another Admin, is for one person and one download, and lasts 24 hours.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, decodeEmail, ADMIN_PASS } = require('./helpers');

let srv;
const p = {};
const get = (url, cookie) => srv.request(url, { cookie });
const post = (url, form, cookie) => srv.request(url, { method: 'POST', form, cookie });
const confirm = (cookie, password) => post('/admin/confirm', { password, next: '/admin' }, cookie);
const CSV = '/admin/export/applications.csv';

before(async () => {
  srv = await startServer();
  p.owner = await srv.adminLogin();
  await confirm(p.owner, ADMIN_PASS);
}, { timeout: 30000 });
after(() => srv && srv.stop());

test('off by default: an Admin downloads after confirming their password', async () => {
  const r = await get(CSV, p.owner);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /csv/);
});

test('turned on with a single Admin (or an invitation not yet accepted) it waits and blocks nobody', async () => {
  let r = await post('/admin/export-requests/settings', { on: '1' }, p.owner);
  assert.equal(r.status, 303);
  assert.match(decodeURIComponent(r.headers.get('location')), /starts when the team has a second Admin/);
  assert.equal((await get(CSV, p.owner)).status, 200);
  await post('/admin/team', { name: 'Kavya', email: 'kavya@hireriv.test', role: 'Admin' }, p.owner);
  assert.equal((await get(CSV, p.owner)).status, 200, 'Kavya has not accepted yet');
  const link = decodeEmail(await srv.waitForEmail((e) => e.includes('To: kavya@hireriv.test'))).match(/\/admin\/setup\/[a-f0-9]{64}/)[0];
  p.kavya = srv.cookieFrom(await post(link, { password: 'Kavya long password', confirm: 'Kavya long password' }));
  const page = await (await get('/admin/export-requests', p.owner)).text();
  assert.match(page, /On: exports need a second Admin\./);
  assert.match(page, /The team has 2 Admins now\./);
});

test('with two Admins: ask, the other Admin approves, one download, then it is needed again', async () => {
  let r = await get(CSV, p.owner);
  assert.equal(r.status, 403);
  let html = await r.text();
  assert.match(html, /<h1>Approval needed<\/h1>/);
  assert.match(html, /Kavya will be asked/);
  assert.match(html, /<input type="hidden" name="target" value="\/admin\/export\/applications\.csv">/);
  // A reason is required.
  assert.equal((await post('/admin/export-requests', { target: CSV, name: 'applications.csv', reason: '' }, p.owner)).status, 400);
  // Only export addresses can be asked for.
  assert.equal((await post('/admin/export-requests', { target: '/admin/settings', name: 'x', reason: 'y' }, p.owner)).status, 400);
  r = await post('/admin/export-requests', { target: CSV, name: 'applications.csv', reason: 'Monthly copy for the office drive' }, p.owner);
  assert.equal(r.status, 303);
  // Asking twice keeps one request.
  await post('/admin/export-requests', { target: CSV, name: 'applications.csv', reason: 'again' }, p.owner);
  const reqs = srv.records('export-requests');
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].status, 'pending');
  html = await (await get(CSV, p.owner)).text();
  assert.match(html, /Another Admin has to approve it/);

  // Kavya is told, in the app and by email.
  const mail = decodeEmail(await srv.waitForEmail((e) => e.includes('To: kavya@hireriv.test') && decodeEmail(e).includes('waiting for your approval')));
  assert.match(mail, /Monthly copy for the office drive/);
  assert.match(await (await get('/notifications?as=team', p.kavya)).text(), /Approve an export\?/);

  // Nobody approves their own.
  await post(`/admin/export-requests/${reqs[0].id}/approve`, {}, p.owner).then((x) => assert.equal(x.status, 403));
  // Approving needs Kavya's password again.
  r = await post(`/admin/export-requests/${reqs[0].id}/approve`, {}, p.kavya);
  assert.equal(r.status, 303);
  assert.match(r.headers.get('location'), /^\/admin\/confirm/);
  await confirm(p.kavya, 'Kavya long password');
  assert.match(await (await get('/admin/export-requests', p.kavya)).text(), /Monthly copy for the office drive/);
  r = await post(`/admin/export-requests/${reqs[0].id}/approve`, {}, p.kavya);
  assert.equal(r.status, 303);
  assert.match(decodeURIComponent(r.headers.get('location')), /Approved\. Owner can download applications\.csv once/);
  assert.equal(srv.records('export-requests')[0].status, 'approved');

  // One download.
  r = await get(CSV, p.owner);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /csv/);
  assert.equal(srv.records('export-requests')[0].status, 'used');
  assert.equal((await get(CSV, p.owner)).status, 403, 'needed again');
  // The full database needs its own approval.
  assert.equal((await get('/admin/backup', p.owner)).status, 403);
  // The public jobs list never does.
  assert.equal((await get('/admin/export/jobs.csv', p.owner)).status, 200);
});

test('declining, and turning it off again', async () => {
  await post('/admin/export-requests', { target: '/admin/backup', name: 'Full database', reason: 'Testing a restore' }, p.owner);
  const r = srv.records('export-requests').find((x) => x.target === '/admin/backup');
  await post(`/admin/export-requests/${r.id}/decline`, {}, p.kavya);
  assert.equal(srv.records('export-requests').find((x) => x.id === r.id).status, 'declined');
  assert.equal((await get('/admin/backup', p.owner)).status, 403);
  await post('/admin/export-requests/settings', { on: '' }, p.owner);
  assert.equal((await get(CSV, p.owner)).status, 200);
  const log = await (await get('/admin?tab=activity', p.owner)).text();
  assert.match(log, /Turned off second-Admin approval for exports/);
  assert.match(log, /Declined Owner&#39;s export of Full database/);
});
