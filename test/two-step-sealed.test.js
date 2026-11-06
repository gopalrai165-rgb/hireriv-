// Step 187: authenticator keys are stored encrypted with the file key
// (twofactor.js seal, FILE_ENCRYPTION_KEY). Keys saved before this step are
// sealed when the server starts and keep working; a database copy alone does
// not hold a usable key.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');
const { hashPassword } = require('../employers');
const tf = require('../twofactor');
const vault = require('../vault');

const KEY = vault.newKey();
const PLAIN = tf.newSecret();
const MEMBER = {
  id: 'tm-ravi', name: 'Ravi', email: 'ravi@hireriv.test', role: 'Recruiter', active: true,
  passwordHash: hashPassword('Ravi long password'), createdAt: '2026-01-01T00:00:00.000Z',
  twoFactor: { secret: PLAIN, lastStep: -1, recovery: [], enabledAt: '2026-01-01T00:00:00.000Z' },
};
let srv;
before(async () => { srv = await startServer({ FILE_ENCRYPTION_KEY: KEY }, { team: [MEMBER] }); });
after(() => srv && srv.stop());

test('a key saved in plain text before Step 187 is sealed at start and still signs in', async () => {
  const stored = srv.records('team').find((u) => u.id === 'tm-ravi').twoFactor.secret;
  assert.ok(tf.isSealedSecret(stored), 'sealed at start');
  assert.ok(!stored.includes(PLAIN));
  // Without the file key the stored value cannot be opened.
  vault.configure([vault.newKey()]);
  assert.throws(() => tf.unseal(stored));
  vault.configure([KEY]);
  assert.equal(tf.unseal(stored), PLAIN);

  const pw = await srv.request('/admin/login', { method: 'POST', form: { login: 'ravi@hireriv.test', password: 'Ravi long password', next: '/admin' } });
  assert.equal(pw.status, 302);
  assert.match(pw.headers.get('location'), /^\/admin\/login\/code/);
  const pending = srv.cookieFrom(pw);
  const ok = await srv.request('/admin/login/code', { method: 'POST', cookie: pending, form: { code: tf.codeFor(PLAIN, tf.stepAt()), next: '/admin' } });
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.get('location'), '/admin');
  assert.equal((await srv.request('/admin', { cookie: srv.cookieFrom(ok) })).status, 200);
});

test('sealing is idempotent and moves keys to a new file key after a rotation', () => {
  vault.configure([KEY]);
  const rec = [{ twoFactor: { secret: PLAIN }, twoFactorPending: { secret: tf.newSecret() } }, { name: 'no two-step' }];
  assert.equal(tf.sealRecords(rec), 2);
  const once = rec[0].twoFactor.secret;
  assert.equal(tf.sealRecords(rec), 0, 'already sealed with the current key');
  const NEW = vault.newKey();
  vault.configure([NEW, KEY]);
  assert.equal(tf.sealRecords(rec), 2, 'resealed with the new key');
  assert.notEqual(rec[0].twoFactor.secret, once);
  vault.configure([NEW]);
  assert.equal(tf.unseal(rec[0].twoFactor.secret), PLAIN, 'readable with the new key alone');
  assert.equal(tf.codeFor(rec[0].twoFactor.secret, 100), tf.codeFor(PLAIN, 100));
});
