// Step 179: the notifications and notification settings pages open inside the
// console of the account they are for (the job seeker's account menu or the
// employer portal menu); the team's pages stand alone. The header bells keep
// their unread counts on the notifications page.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, resumeForm, decodeEmail } = require('./helpers');
const { hashPassword } = require('../employers');

const iso = (ago = 0) => new Date(Date.now() - ago).toISOString();
const EMP = { id: 'emp-n', company: 'Bell Co', name: 'Nisha Paul', email: 'nisha@bellco.in', phone: '9800000004', passwordHash: hashPassword('nisha long password 1'), passwordSetAt: iso(86400000), active: true, approvedAt: iso(86400000), createdAt: iso(86400000) };

let srv;
const p = {};
const page = async (url, cookie) => (await srv.request(url, { cookie })).text();

before(async () => {
  srv = await startServer({}, { employers: [EMP] });
  p.admin = await srv.adminLogin();
  p.employer = srv.cookieFrom(await srv.request('/employer/login', { method: 'POST', form: { email: EMP.email, password: 'nisha long password 1' } }));
  await srv.request('/account/register', { method: 'POST', body: resumeForm({ agree: '1', name: 'Ravi Kumar', email: 'ravi@example.in', phone: '9811100022', location: 'Pune', experience: 'Fresher', skills: 'Sales' }) });
  await srv.request('/account/login', { method: 'POST', form: { email: 'ravi@example.in' } });
  const mail = decodeEmail(await srv.waitForEmail((e) => e.includes('To: ravi@example.in') && decodeEmail(e).includes('/account/verify/')));
  p.seeker = srv.cookieFrom(await srv.request(mail.match(/\/account\/verify\/[A-Za-z0-9_-]+/)[0], { method: 'POST', form: {} }));
}, { timeout: 30000 });
after(() => srv && srv.stop());

test('a job seeker sees notifications inside their account menu', async () => {
  for (const [url, title] of [['/notifications', 'Notifications'], ['/notifications/settings', 'Notification settings']]) {
    const html = await page(url, p.seeker);
    assert.match(html, /<aside class="admin-side emp-side acct-side"/, url);
    assert.match(html, /<b>Ravi Kumar<\/b>/, url);
    assert.match(html, new RegExp(`<span class="admin-crumb">My account</span>\\s*<h1>${title}</h1>`), url);
    assert.equal((html.match(/<h1>/g) || []).length, 1, url);
  }
  assert.match(await page('/notifications/settings?msg=Notification+settings+saved.', p.seeker), /<p class="notice" role="status">Notification settings saved\.<\/p>/);
  assert.equal(((await page('/notifications/settings?msg=Saved.', p.seeker)).match(/class="notice" role="status"/g) || []).length, 1);
});

test('an employer sees notifications inside the employer portal menu', async () => {
  for (const [url, title] of [['/notifications', 'Notifications'], ['/notifications/settings', 'Notification settings']]) {
    const html = await page(url, p.employer);
    assert.match(html, /<aside class="admin-side emp-side" aria-label="Employer portal menu">/, url);
    assert.match(html, /<b>Bell Co<\/b>/, url);
    assert.match(html, new RegExp(`<span class="admin-crumb">Employer portal</span>\\s*<h1>${title}</h1>`), url);
    assert.doesNotMatch(html, /acct-side/, url);
  }
});

test('the team page stands alone, and the header bell keeps its count on the notifications page', async () => {
  const html = await page('/notifications', p.admin);
  assert.doesNotMatch(html, /<aside class="admin-side/);
  assert.match(html, /<h1>Notifications<\/h1>/);
  assert.match(html, /Back to your dashboard/);
  // The page's own unread number no longer hides the bells' counts.
  assert.match(html, /\d+ unread/);
  assert.doesNotMatch(html, /data-unread="NaN"|data-unread="undefined"/);
});
