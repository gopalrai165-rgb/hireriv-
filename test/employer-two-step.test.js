// Two-step sign-in for employer logins: set up with an authenticator app,
// a code after the password, recovery codes, a company-wide requirement,
// and a reset by the Hireriv team for a lost phone.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, decodeEmail } = require('./helpers');
const { hashPassword } = require('../employers');
const tf = require('../twofactor');
const vault = require('../vault');

// Keys are stored encrypted with the file key (Step 187); the test holds the
// same key so it can make codes from the stored record.
const KEY = vault.newKey();
vault.configure([KEY]);

const EMP = { id: 'emp-old', company: 'Old Co', name: 'Olga Rao', email: 'olga@oldco.in', passwordHash: hashPassword('olga long password'), passwordSetAt: '2026-01-01T00:00:00.000Z', active: true, createdAt: '2026-01-01T00:00:00.000Z' };
const TWO = { ...EMP, id: 'emp-two', company: 'Two Co', name: 'Tara Sen', email: 'tara@two.in', require2fa: true };
let srv; let cookie; let secret; let recovery;
before(async () => { srv = await startServer({ FILE_ENCRYPTION_KEY: KEY }, { employers: [EMP, TWO] }); });
after(() => srv && srv.stop());
const user = (email = 'olga@oldco.in') => srv.records('employer-users').find((u) => u.email === email);
const login = (email = 'olga@oldco.in', password = 'olga long password') => srv.request('/employer/login', { method: 'POST', form: { email, password } });
const post = (p, form = {}, c = cookie) => srv.request(p, { method: 'POST', cookie: c, form });
const page = async (p, c = cookie) => (await srv.request(p, { cookie: c })).text();
// A code the account hasn't used yet (codes can't be replayed).
const freshCode = (email = 'olga@oldco.in') => {
  const t = user(email).twoFactor;
  return tf.codeFor(t.secret, Math.max(tf.stepAt() - 1, (t.lastStep ?? -2) + 1));
};

test('setting it up: QR code, a wrong code is refused, the right one turns it on with 10 recovery codes', async () => {
  cookie = srv.cookieFrom(await login());
  assert.match(await page('/employer/settings'), /Set up two-step sign-in/);
  await post('/employer/settings/two-step/start');
  secret = user().twoFactorPending.secret;
  assert.ok(tf.isSealedSecret(secret), 'the key is stored encrypted');
  assert.match(tf.unseal(secret), /^[A-Z2-7]{32}$/);
  const setup = await page('/employer/settings');
  assert.ok(setup.includes(tf.groupSecret(secret)), 'the page shows the key itself, to type into the app');
  assert.ok(!setup.includes('enc:'));
  assert.match(setup, /<svg/, 'QR code shown');
  assert.match(setup, /action="\/employer\/settings\/two-step\/confirm"/);
  assert.match(decodeURIComponent((await post('/employer/settings/two-step/confirm', { code: '000000' === tf.codeFor(secret, tf.stepAt()) ? '111111' : '000000' })).headers.get('location')), /didn't match/);
  const on = await post('/employer/settings/two-step/confirm', { code: tf.codeFor(secret, tf.stepAt() - 1) });
  assert.equal(on.status, 200);
  const html = await on.text();
  recovery = [...html.matchAll(/<li><code>([^<]+)<\/code><\/li>/g)].map((m) => m[1]);
  assert.equal(recovery.length, 10);
  assert.ok(user().twoFactor && user().twoFactor.secret === secret);
  assert.equal((await srv.request('/employer', { cookie, redirect: 'manual' })).status, 302, 'the password-only session was ended');
  cookie = srv.cookieFrom(on);
  assert.equal((await srv.request('/employer', { cookie })).status, 200, 'this browser carries on');
  await srv.waitForEmail((m) => m.includes('To: olga@oldco.in') && m.includes('Two-step sign-in is on'));
});

test('signing in: the password alone is not enough; a wrong code is refused; the right one signs in', async () => {
  const res = await login();
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/employer/login/code');
  assert.ok(!res.headers.getSetCookie().some((c) => c.startsWith('hr_emp=')), 'no session yet');
  const pending = srv.cookieFrom(res);
  const wrong = await post('/employer/login/code', { code: '12345a' }, pending);
  assert.equal(wrong.status, 401);
  const ok = await post('/employer/login/code', { code: freshCode() }, pending);
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.get('location'), '/employer');
  assert.equal((await srv.request('/employer', { cookie: srv.cookieFrom(ok) })).status, 200);
  assert.equal((await post('/employer/login/code', { code: freshCode() }, pending)).status, 401, 'the code step is used up');
});

test('a recovery code works once, and the owner is emailed', async () => {
  const pending = srv.cookieFrom(await login());
  const ok = await post('/employer/login/code', { code: recovery[0] }, pending);
  assert.equal(ok.headers.get('location'), '/employer');
  await srv.waitForEmail((m) => m.includes('To: olga@oldco.in') && m.includes('A recovery code was used'));
  const again = srv.cookieFrom(await login());
  assert.equal((await post('/employer/login/code', { code: recovery[0] }, again)).status, 401);
});

test('a password reset link does not skip the code', async () => {
  const seen = srv.emails().length;
  await srv.request('/employer/forgot', { method: 'POST', form: { email: 'olga@oldco.in' } });
  let link;
  for (let i = 0; i < 100 && !link; i++) {
    await new Promise((r) => setTimeout(r, 50));
    const m = srv.emails().slice(seen).map(decodeEmail).find((e) => e.includes('/employer/reset/'));
    if (m) link = m.match(/\/employer\/reset\/[A-Za-z0-9_-]+/)[0];
  }
  assert.ok(link, 'reset email sent');
  const res = await srv.request(link, { method: 'POST', form: { password: 'olga newer password', confirm: 'olga newer password' } });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Sign in with it and the code from your authenticator app/);
  assert.ok(!res.headers.getSetCookie().some((c) => c.startsWith('hr_emp=')), 'no session from the link alone');
  const code = await login('olga@oldco.in', 'olga newer password');
  assert.equal(code.headers.get('location'), '/employer/login/code');
});

test('a company that requires it sends members without it to set it up; it then cannot be turned off', async () => {
  const tara = srv.cookieFrom(await login('tara@two.in', 'olga long password'));
  const blocked = await srv.request('/employer/jobs', { cookie: tara, redirect: 'manual' });
  assert.equal(blocked.status, 302);
  assert.match(decodeURIComponent(blocked.headers.get('location')), /^\/employer\/settings\?msg=Two Co requires two-step sign-in/);
  assert.equal((await srv.request('/api/employers/me', { cookie: tara })).status, 403);
  assert.match(await page('/employer/settings', tara), /Two Co requires two-step sign-in\. Set it up below/);
  // Olga's company: she requires it for everyone, then can't turn hers off.
  const step2 = await login('olga@oldco.in', 'olga newer password');
  const signed = await post('/employer/login/code', { code: freshCode() }, srv.cookieFrom(step2));
  cookie = srv.cookieFrom(signed);
  assert.match(await page('/employer/team'), /Require two-step sign-in/);
  await post('/employer/team/require-two-step', { on: '1' });
  assert.equal(srv.records('employers').find((e) => e.id === 'emp-old').require2fa, true);
  assert.match(decodeURIComponent((await post('/employer/settings/two-step/off', { code: freshCode() })).headers.get('location')), /Old Co requires two-step sign-in, so it can't be turned off/);
  assert.ok(user().twoFactor);
  const cross = await srv.request('/employer/team/require-two-step', { method: 'POST', cookie, headers: { origin: 'https://evil.example' }, form: { on: '0' } });
  assert.equal(cross.status, 403);
});

test('the Hireriv team can reset it for a lost phone; only for a login of that company', async () => {
  const admin = await srv.adminLogin();
  const wrong = await srv.request('/admin/clients/emp-two/reset-two-step', { method: 'POST', cookie: admin, form: { email: 'olga@oldco.in' } });
  assert.match(decodeURIComponent(wrong.headers.get('location')), /is not a login at Two Co/);
  assert.ok(user().twoFactor, 'unchanged');
  const res = await srv.request('/admin/clients/emp-old/reset-two-step', { method: 'POST', cookie: admin, form: { email: 'olga@oldco.in' } });
  assert.match(decodeURIComponent(res.headers.get('location')), /Two-step sign-in reset for olga@oldco\.in/);
  assert.equal(user().twoFactor, null);
  assert.equal((await srv.request('/employer', { cookie, redirect: 'manual' })).status, 302, 'signed out everywhere');
  await srv.waitForEmail((m) => m.includes('To: olga@oldco.in') && m.includes('Your two-step sign-in was reset'));
});
