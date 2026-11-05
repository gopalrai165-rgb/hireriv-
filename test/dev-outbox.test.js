// Step 166: /dev/outbox shows the sign-in links and codes saved to the outbox
// folder on a computer without email sending, so local sign-in works. Off in
// production and staging.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');
const devOutbox = require('../dev-outbox');

const DAY = 86400000;
let srv;
before(async () => {
  srv = await startServer({}, { candidates: [{ id: 'c-dev', email: 'local@mailinator.com', name: 'Local Tester', emailVerifiedAt: new Date(Date.now() - DAY).toISOString(), createdAt: new Date(Date.now() - DAY).toISOString() }] });
});
after(() => srv && srv.stop());

test('the sign-in link from the outbox opens the account', async () => {
  const sent = await (await srv.request('/account/login', { method: 'POST', form: { email: 'local@mailinator.com' } })).text();
  assert.match(sent, /href="\/dev\/outbox"/);
  let html = '';
  for (const end = Date.now() + 5000; Date.now() < end && !/account\/verify\//.test(html); await new Promise((r) => setTimeout(r, 50))) {
    html = await (await srv.request('/dev/outbox?to=local@mailinator.com')).text();
  }
  assert.match(html, /Local outbox/);
  assert.match(html, /To: local@mailinator\.com/);
  const link = html.match(/href="https?:\/\/[^"]*(\/account\/verify\/[A-Za-z0-9_-]+)"/)[1];
  const res = await srv.request(link, { method: 'POST', form: {} });
  assert.equal(res.status, 302);
  assert.ok(srv.cookieFrom(res));
});

test('a filter for someone else shows none of their messages', async () => {
  const html = await (await srv.request('/dev/outbox?to=nobody@example.com')).text();
  assert.doesNotMatch(html, /local@mailinator\.com<\/p>/);
  assert.match(html, /No messages yet/);
});

test('off in production and on staging', () => {
  assert.equal(devOutbox.enabled({ NODE_ENV: 'production' }), false);
  assert.equal(devOutbox.enabled({ SITE_ENV: 'staging' }), false);
  assert.equal(devOutbox.enabled({ NODE_ENV: 'development' }), true);
});
