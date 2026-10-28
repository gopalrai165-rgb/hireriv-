// Staging mode: kept out of search engines, behind a password, marked on every
// page, and never emailing or texting anyone outside the team's allow lists.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const staging = require('../staging');
const config = require('../config-check');
const { startServer } = require('./helpers');

test('allow lists match whole addresses, domains and numbers', () => {
  const env = { SITE_ENV: 'staging', STAGING_EMAIL_ALLOW: '@hireriv.test, Tester@Gmail.com', STAGING_SMS_ALLOW: '+91 98220 00001' };
  assert.equal(staging.emailAllowed('asha@hireriv.test', env), true);
  assert.equal(staging.emailAllowed('tester@gmail.com', env), true);
  assert.equal(staging.emailAllowed('asha@hireriv.test.evil.in', env), false);
  assert.equal(staging.emailAllowed('other@gmail.com', env), false);
  assert.equal(staging.smsAllowed('9822000001', env), true);
  assert.equal(staging.smsAllowed('+919822000002', env), false);
  assert.deepEqual(staging.splitRecipients('Asha <asha@hireriv.test>, priya@example.in', env), { send: ['Asha <asha@hireriv.test>'], hold: ['priya@example.in'] });
  // Outside staging nothing is held back.
  assert.deepEqual(staging.splitRecipients('priya@example.in', {}), { send: ['priya@example.in'], hold: [] });
});

test('staging settings are checked', () => {
  const base = {
    NODE_ENV: 'production', SITE_URL: 'https://staging.hireriv.com', ADMIN_PASS: 'a-long-owner-password', FILE_ENCRYPTION_KEY: 'a'.repeat(64),
    SMTP_HOST: 'smtp.example.com', SMTP_USER: 'u', SMTP_PASS: 'p', SITE_ENV: 'staging', STAGING_PASSWORD: 'a-long-staging-password',
    RAZORPAY_KEY_ID: 'rzp_test_x', RAZORPAY_KEY_SECRET: 's', RAZORPAY_WEBHOOK_SECRET: 'w',
  };
  const ok = config.check(base);
  assert.deepEqual(ok.errors, []);
  assert.ok(!ok.warnings.some((w) => /sandbox/.test(w)), 'test keys are expected on staging');
  assert.ok(ok.warnings.some((w) => /STAGING_EMAIL_ALLOW/.test(w)));
  for (const [change, re] of [
    [{ STAGING_PASSWORD: '' }, /needs STAGING_PASSWORD/],
    [{ STAGING_PASSWORD: 'short' }, /STAGING_PASSWORD must be/],
    [{ RAZORPAY_KEY_ID: 'rzp_live_x' }, /test keys/],
    [{ SITE_ENV: 'qa' }, /SITE_ENV must be/],
  ]) assert.ok(config.check({ ...base, ...change }).errors.some((e) => re.test(e)), JSON.stringify(change));
  assert.ok(config.check({ ...base, SITE_ENV: '' }).warnings.some((w) => /do nothing here/.test(w)));
});

let srv;
before(async () => {
  srv = await startServer({ SITE_ENV: 'staging', STAGING_PASSWORD: 'staging-pass-1234', STAGING_EMAIL_ALLOW: '@hireriv.test', NOTIFY_EMAIL: 'team@hireriv.test, owner@example.in' });
});
after(() => srv && srv.stop());

test('the staging site asks for its password and stays out of search engines', async () => {
  const home = await srv.request('/');
  assert.equal(home.status, 401);
  assert.equal(home.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.match(await home.text(), /Enter the staging password/);
  // Forms are gated too, not only pages.
  assert.equal((await srv.request('/api/contact', { method: 'POST', form: { name: 'A', email: 'a@b.in', message: 'hi' } })).status, 401);
  // Monitors and the public API's own key check still answer.
  assert.equal((await srv.request('/healthz')).status, 200);
  assert.doesNotMatch(await (await srv.request('/api/v1/jobs')).text(), /staging password/);
  assert.equal(await (await srv.request('/robots.txt')).text(), 'User-agent: *\nDisallow: /\n');

  const wrong = await srv.request('/staging-sign-in', { method: 'POST', form: { password: 'nope', next: '/jobs' } });
  assert.equal(wrong.status, 401);
  assert.equal(srv.cookieFrom(wrong), '');
  const right = await srv.request('/staging-sign-in', { method: 'POST', form: { password: 'staging-pass-1234', next: '//evil.example/x' } });
  assert.equal(right.status, 303);
  assert.equal(right.headers.get('location'), '/', 'never sends people to another site');
  const cookie = srv.cookieFrom(right);
  const page = await srv.request('/jobs', { cookie });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /class="staging-banner"[^>]*>Staging site: for testing only/);
});

test('staging emails only the allowed addresses; the rest wait in the outbox', async () => {
  const right = await srv.request('/staging-sign-in', { method: 'POST', form: { password: 'staging-pass-1234', next: '/' } });
  const cookie = srv.cookieFrom(right);
  const fs = require('node:fs');
  const path = require('node:path');
  const files = () => (fs.existsSync(srv.paths.outbox) ? fs.readdirSync(srv.paths.outbox) : []);
  // The team inbox lists one address on the allow list and one outside it.
  const res = await srv.request('/api/contact', { method: 'POST', form: { name: 'Asha', email: 'asha@example.in', message: 'Testing staging' }, cookie, headers: { accept: 'application/json' } });
  assert.equal(res.status, 200);
  for (const end = Date.now() + 5000; files().length < 2 && Date.now() < end;) await new Promise((r) => setTimeout(r, 50));
  const held = files().filter((f) => f.includes('-staging-held-'));
  const sent = files().filter((f) => !f.includes('-staging-held-'));
  assert.equal(held.length, 1);
  assert.equal(sent.length, 1);
  assert.match(fs.readFileSync(path.join(srv.paths.outbox, held[0]), 'utf8'), /^To: owner@example\.in\s*$/m);
  assert.match(fs.readFileSync(path.join(srv.paths.outbox, sent[0]), 'utf8'), /^To: team@hireriv\.test\s*$/m);
});
