// Two-step sign-in for team logins: set-up, the code step, recovery codes,
// replay protection, Admin resets and requiring it for the whole team.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, decodeEmail, ADMIN_PASS } = require('./helpers');
const tf = require('../twofactor');

let srv;
before(async () => { srv = await startServer(); });
after(() => srv && srv.stop());

// Each use moves forward in time steps, so the app's replay check never trips by accident.
const code = (secret, offset) => tf.codeFor(secret, tf.stepAt() + offset);
const keyFrom = (html) => html.match(/<code class="setup-key">([A-Z2-7 ]+)<\/code>/)[1].replace(/ /g, '');
const codesFrom = (html) => [...html.matchAll(/<li><code>([a-z0-9]{4}-[a-z0-9]{4})<\/code><\/li>/g)].map((m) => m[1]);

async function enable(cookie) {
  assert.equal((await srv.request('/admin/security/start', { method: 'POST', cookie })).status, 302);
  const secret = keyFrom(await (await srv.request('/admin/security', { cookie })).text());
  const res = await srv.request('/admin/security/confirm', { method: 'POST', cookie, form: { code: code(secret, -1) } });
  assert.equal(res.status, 200);
  const html = await res.text();
  return { secret, recovery: codesFrom(html), cookie: srv.cookieFrom(res), html };
}

const passwordStep = (login, password) => srv.request('/admin/login', { method: 'POST', form: { login, password, next: '/admin?tab=jobs' } });
const codeStep = (cookie, value) => srv.request('/admin/login/code', { method: 'POST', cookie, form: { code: value, next: '/admin?tab=jobs' } });

let owner; // { secret, recovery }

test('twofactor: RFC 6238 codes, clock drift and replay', () => {
  const secret = tf.base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(tf.codeFor(secret, 1), '287082'); // RFC 6238 test vector at T=59s
  assert.equal(tf.verifyCode(secret, '287082', { now: 59000 }), 1);
  assert.equal(tf.verifyCode(secret, '287 082', { now: 59000 + 30000 }), 1); // one step late is fine
  assert.equal(tf.verifyCode(secret, '287082', { now: 59000 + 90000 }), null);
  assert.equal(tf.verifyCode(secret, '287082', { now: 59000, lastStep: 1 }), null);
  assert.equal(tf.verifyCode(secret, 'abcdef'), null);
  const { codes, hashes } = tf.newRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(tf.findRecovery(hashes, codes[4].toUpperCase().replace('-', ' ')), 4);
  assert.equal(tf.findRecovery(hashes, 'zzzz-zzzz'), -1);
});

test('setting up shows a QR code, then recovery codes once, and signs out other sessions', async () => {
  const cookie = await srv.adminLogin();
  const other = await srv.adminLogin();
  let html = await (await srv.request('/admin/security', { cookie })).text();
  assert.match(html, /Set up two-step sign-in/);

  const started = await srv.request('/admin/security/start', { method: 'POST', cookie });
  assert.equal(started.status, 302);
  html = await (await srv.request('/admin/security', { cookie })).text();
  assert.match(html, /<svg[^>]*viewBox/);
  assert.match(html, /otpauth:\/\/totp\//);
  assert.equal((await srv.request('/admin/security/confirm', { method: 'POST', cookie, form: { code: '000000' } })).headers.get('location').includes('didn'), true);

  const secret = keyFrom(html);
  const res = await srv.request('/admin/security/confirm', { method: 'POST', cookie, form: { code: code(secret, -1) } });
  assert.equal(res.status, 200);
  const recovery = codesFrom(await res.text());
  assert.equal(recovery.length, 10);
  owner = { secret, recovery };

  const fresh = srv.cookieFrom(res);
  assert.equal((await srv.request('/admin', { cookie: fresh })).status, 200);
  assert.equal((await srv.request('/admin', { cookie: other, headers: { accept: 'text/html' } })).status, 302);
  html = await (await srv.request('/admin/security', { cookie: fresh })).text();
  assert.match(html, /10 of 10 recovery codes unused/);
  assert.doesNotMatch(html, /setup-key/);
  assert.doesNotMatch(html, new RegExp(recovery[0])); // never shown again
});

test('the password alone no longer signs in; the code does, and only once', async () => {
  const pw = await passwordStep('admin', ADMIN_PASS);
  assert.equal(pw.status, 302);
  assert.match(pw.headers.get('location'), /^\/admin\/login\/code\?next=/);
  assert.doesNotMatch(pw.headers.get('set-cookie'), /hr_admin=/);
  const pending = srv.cookieFrom(pw);
  assert.equal((await srv.request('/admin/login/code', { cookie: pending })).status, 200);
  assert.equal((await srv.request('/admin/login/code')).status, 302); // no password first

  assert.equal((await codeStep(pending, '123456')).status, 401);
  assert.equal((await codeStep(pending, code(owner.secret, -1))).status, 401); // already used at set-up
  const ok = await codeStep(pending, code(owner.secret, 0));
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.get('location'), '/admin?tab=jobs');
  assert.equal((await srv.request('/admin', { cookie: srv.cookieFrom(ok) })).status, 200);
  // The half-finished sign-in can't be reused.
  assert.equal((await codeStep(pending, code(owner.secret, 1))).status, 401);
});

test('recovery codes work once each and the activity log says so', async () => {
  const pending = srv.cookieFrom(await passwordStep('admin', ADMIN_PASS));
  const ok = await codeStep(pending, owner.recovery[0].toUpperCase());
  assert.equal(ok.status, 302);
  const cookie = srv.cookieFrom(ok);
  assert.match(await (await srv.request('/admin/security', { cookie })).text(), /9 of 10 recovery codes unused/);
  assert.ok(srv.records('activity').some((a) => a.action === 'Signed in with a recovery code (9 left)'));

  const again = srv.cookieFrom(await passwordStep('admin', ADMIN_PASS));
  assert.equal((await codeStep(again, owner.recovery[0])).status, 401);
  owner.cookie = cookie;
});

test('five wrong codes send you back to the password', async () => {
  const pending = srv.cookieFrom(await passwordStep('admin', ADMIN_PASS));
  for (let i = 0; i < 4; i++) assert.equal((await codeStep(pending, '000000')).status, 401);
  const last = await codeStep(pending, '000000');
  assert.match(await last.text(), /Too many wrong codes/);
  assert.equal((await codeStep(pending, owner.recovery[1])).status, 401);
  // A correct sign-in clears the per-IP failure count again.
  const ok = await codeStep(srv.cookieFrom(await passwordStep('admin', ADMIN_PASS)), owner.recovery[1]);
  assert.equal(ok.status, 302);
});

test('requiring it for the team, and resetting someone who lost their phone', async () => {
  const admin = owner.cookie;
  await srv.request('/admin/team', { method: 'POST', cookie: admin, form: { name: 'Riya Sen', email: 'riya@hireriv.test', role: 'Recruiter' } });
  const invite = decodeEmail(await srv.waitForEmail((e) => e.includes('riya@hireriv.test')));
  const link = invite.match(/\/admin\/setup\/[a-f0-9]{64}/)[0];
  const setup = await srv.request(link, { method: 'POST', form: { password: 'riya-long-password', confirm: 'riya-long-password' } });
  let riya = srv.cookieFrom(setup);

  let team = await (await srv.request('/admin?tab=team', { cookie: admin })).text();
  assert.match(team, /1 of 2 active members sign in with a code/);
  assert.doesNotMatch(team, new RegExp(owner.secret));

  await srv.request('/admin/team/require-2fa', { method: 'POST', cookie: admin, form: { require: '1' } });
  // Riya can only reach Sign-in security until she sets it up.
  const blocked = await srv.request('/admin?tab=jobs', { cookie: riya, headers: { accept: 'text/html' } });
  assert.equal(blocked.status, 302);
  assert.equal(blocked.headers.get('location'), '/admin/security');
  assert.equal((await srv.request('/admin/jobs', { method: 'POST', cookie: riya, form: { title: 'x' } })).status, 403);
  assert.match(await (await srv.request('/admin/security', { cookie: riya })).text(), /Your team requires two-step sign-in/);

  const r = await enable(riya);
  riya = r.cookie;
  assert.equal((await srv.request('/admin?tab=jobs', { cookie: riya })).status, 200);
  // Can't be turned off while the team requires it.
  const off = await srv.request('/admin/security/off', { method: 'POST', cookie: riya, form: { code: r.recovery[0] } });
  assert.match(decodeURIComponent(off.headers.get('location')), /cannot be turned off/);

  // Lost phone: an Admin resets it, Riya is signed out and told by email.
  const id = srv.records('team').find((u) => u.email === 'riya@hireriv.test').id;
  await srv.request(`/admin/team/${id}/reset-2fa`, { method: 'POST', cookie: admin });
  assert.equal(srv.records('team').find((u) => u.id === id).twoFactor, null);
  assert.equal((await srv.request('/admin', { cookie: riya, headers: { accept: 'text/html' } })).headers.get('location'), '/admin/login?next=%2Fadmin');
  await srv.waitForEmail((e) => e.includes('riya@hireriv.test') && e.includes('two-step sign-in was reset'));
  // Password signs her straight in, but only to set it up again.
  const back = await passwordStep('riya@hireriv.test', 'riya-long-password');
  assert.equal(back.headers.get('location'), '/admin?tab=jobs');
  assert.equal((await srv.request('/admin?tab=jobs', { cookie: srv.cookieFrom(back), headers: { accept: 'text/html' } })).headers.get('location'), '/admin/security');

  // Recruiters can't change the team rule.
  await srv.request('/admin/team/require-2fa', { method: 'POST', cookie: srv.cookieFrom(back), form: { require: '0' } });
  team = await (await srv.request('/admin?tab=team', { cookie: admin })).text();
  assert.match(team, /Required for everyone/);
});
