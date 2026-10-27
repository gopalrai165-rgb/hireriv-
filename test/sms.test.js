// Text-message providers (Step 72): MSG91, Twilio and a webhook relay, each
// checked against a local stand-in that records what it was sent.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const sms = require('../sms');
const config = require('../config-check');

let server;
let base;
const seen = [];
let answer = { status: 200, body: { type: 'success' } };
before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer.body));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());
const last = () => seen[seen.length - 1];
const quiet = async (fn) => { const e = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = e; } };

test('numbers become +91 and ten digits', () => {
  for (const n of ['98765 43210', '+91-98765-43210', '09876543210', '919876543210']) assert.equal(sms.e164(n), '+919876543210');
  assert.equal(sms.e164('+1 415 555 0100'), '+14155550100');
});

test('which provider, and what it still needs', () => {
  assert.equal(sms.provider({}), '');
  assert.equal(sms.configured({}), false);
  assert.equal(sms.provider({ SMS_WEBHOOK_URL: 'https://relay.example.in' }), 'webhook', 'the older setting still works');
  assert.deepEqual(sms.missing({ SMS_PROVIDER: 'msg91', MSG91_AUTH_KEY: 'k' }), ['MSG91_TEMPLATE_ID']);
  assert.deepEqual(sms.missing({ SMS_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't' }), ['TWILIO_FROM or TWILIO_MESSAGING_SERVICE_SID']);
  assert.deepEqual(sms.missing({ SMS_PROVIDER: 'carrier-pigeon' }), ['SMS_PROVIDER (unknown: carrier-pigeon)']);
  assert.equal(sms.configured({ SMS_PROVIDER: 'msg91', MSG91_AUTH_KEY: 'k', MSG91_TEMPLATE_ID: 't' }), true);
});

test('MSG91: the approved template with only the code filled in', async () => {
  answer = { status: 200, body: { type: 'success', message: 'ok' } };
  const env = { SMS_PROVIDER: 'msg91', MSG91_AUTH_KEY: 'secret-key', MSG91_TEMPLATE_ID: 'tpl-1', MSG91_API_URL: `${base}/flow` };
  assert.equal(await sms.send('98765 43210', '482913 is your Hireriv code.', { code: '482913' }, env), true);
  const r = last();
  assert.equal(r.url, '/flow');
  assert.equal(r.headers.authkey, 'secret-key');
  assert.deepEqual(JSON.parse(r.body), { template_id: 'tpl-1', short_url: '0', recipients: [{ mobiles: '919876543210', OTP: '482913' }] });
  // Another variable name, and refusals.
  await sms.send('9876543210', 'x', { code: '111222' }, { ...env, MSG91_CODE_VAR: 'code' });
  assert.equal(JSON.parse(last().body).recipients[0].code, '111222');
  answer = { status: 200, body: { type: 'error', message: 'Template not approved' } };
  assert.equal(await quiet(() => sms.send('9876543210', 'x', { code: '1' }, env)), false);
  assert.equal(await quiet(() => sms.send('9876543210', 'no code here', {}, env)), false, 'templates only carry a code');
});

test('Twilio: the full text from the sender or messaging service', async () => {
  answer = { status: 201, body: { sid: 'SM1' } };
  const env = { SMS_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'AC123', TWILIO_AUTH_TOKEN: 'tok', TWILIO_FROM: '+15005550006', TWILIO_API_URL: base };
  assert.equal(await sms.send('9876543210', '482913 is your Hireriv code.', { code: '482913' }, env), true);
  const r = last();
  assert.equal(r.url, '/2010-04-01/Accounts/AC123/Messages.json');
  assert.equal(r.headers.authorization, `Basic ${Buffer.from('AC123:tok').toString('base64')}`);
  const form = new URLSearchParams(r.body);
  assert.equal(form.get('To'), '+919876543210');
  assert.equal(form.get('From'), '+15005550006');
  assert.equal(form.get('Body'), '482913 is your Hireriv code.');
  await sms.send('9876543210', 'x', {}, { ...env, TWILIO_FROM: '', TWILIO_MESSAGING_SERVICE_SID: 'MG9' });
  assert.equal(new URLSearchParams(last().body).get('MessagingServiceSid'), 'MG9');
  answer = { status: 400, body: { code: 21211 } };
  assert.equal(await quiet(() => sms.send('9876543210', 'x', {}, env)), false);
});

test('webhook relay, and a half-set provider sends nothing', async () => {
  answer = { status: 200, body: {} };
  assert.equal(await sms.send('9876543210', 'hello', {}, { SMS_WEBHOOK_URL: `${base}/relay`, SMS_WEBHOOK_TOKEN: 'abc' }), true);
  assert.equal(last().headers.authorization, 'Bearer abc');
  assert.deepEqual(JSON.parse(last().body), { to: '+919876543210', message: 'hello' });
  const before = seen.length;
  assert.equal(await quiet(() => sms.send('9876543210', 'x', { code: '1' }, { SMS_PROVIDER: 'msg91', MSG91_API_URL: base })), false);
  assert.equal(seen.length, before);
});

test('launch checks: a half-set provider stops a production start', () => {
  const good = { NODE_ENV: 'production', SITE_URL: 'https://hireriv.example.in', ADMIN_PASS: 'a-long-unique-password', FILE_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), SMTP_HOST: 'smtp.example.in' };
  const none = config.check(good);
  assert.ok(none.warnings.some((w) => /No text-message provider/.test(w)));
  assert.ok(!none.errors.some((e) => /Text messages|SMS_/.test(e)));
  const half = config.check({ ...good, SMS_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'AC1' });
  assert.ok(half.errors.some((e) => /Text messages are half set up \(SMS_PROVIDER=twilio\): TWILIO_AUTH_TOKEN/.test(e)));
  assert.ok(config.check({ ...good, SMS_WEBHOOK_URL: 'http://relay.example.in' }).errors.includes('SMS_WEBHOOK_URL must start with https://'));
  const ready = config.check({ ...good, SMS_PROVIDER: 'msg91', MSG91_AUTH_KEY: 'k', MSG91_TEMPLATE_ID: 't' });
  assert.ok(!ready.errors.some((e) => /Text messages|SMS_/.test(e)) && !ready.warnings.some((w) => /text-message/.test(w)));
});
