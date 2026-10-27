// Launch readiness: unsafe production settings stop the server from starting,
// and backups are proved by restoring them.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { open } = require('../db');
const config = require('../config-check');
const backupsModule = require('../backups');

const KEY = 'a'.repeat(64);
const good = {
  NODE_ENV: 'production', SITE_URL: 'https://hireriv.com', ADMIN_PASS: 'a-long-owner-password', FILE_ENCRYPTION_KEY: KEY,
  SMTP_HOST: 'smtp.example.com', SMTP_USER: 'u', SMTP_PASS: 'p', MAIL_FROM: 'jobs@hireriv.com',
  DB_FILE: '/var/lib/hireriv/hireriv.db', UPLOADS_DIR: '/var/lib/hireriv/uploads', BACKUP_DIR: '/mnt/backup/hireriv',
  CLAMAV_HOST: 'clamav', TRUST_PROXY: '1',
  RAZORPAY_KEY_ID: 'rzp_live_x', RAZORPAY_KEY_SECRET: 's', RAZORPAY_WEBHOOK_SECRET: 'w',
  SMS_PROVIDER: 'msg91', MSG91_AUTH_KEY: 'k', MSG91_TEMPLATE_ID: 't',
};

test('a complete production configuration passes', () => {
  const r = config.check(good);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.ok, true);
});

test('each unsafe setting is a blocking error', () => {
  const cases = [
    [{ SITE_URL: '' }, /SITE_URL is not set/],
    [{ SITE_URL: 'http://hireriv.com' }, /https/],
    [{ SITE_URL: 'https://localhost:3004' }, /this computer/],
    [{ ADMIN_PASS: 'change-me-to-a-long-password' }, /placeholder/],
    [{ ADMIN_PASS: 'short' }, /at least 12/],
    [{ FILE_ENCRYPTION_KEY: '' }, /FILE_ENCRYPTION_KEY is not set/],
    [{ FILE_ENCRYPTION_KEY: 'abc' }, /not valid/],
    [{ FILE_ENCRYPTION_KEYS_OLD: `${KEY},nope` }, /KEYS_OLD/],
    [{ SMTP_HOST: '' }, /SMTP_HOST/],
    [{ RAZORPAY_WEBHOOK_SECRET: '' }, /half set up: RAZORPAY_WEBHOOK_SECRET/],
    [{ AI_PROVIDER: 'mock' }, /mock/],
    [{ EMAIL_WEBHOOK_SECRET: 'short' }, /EMAIL_WEBHOOK_SECRET/],
  ];
  for (const [change, re] of cases) {
    const r = config.check({ ...good, ...change });
    assert.equal(r.ok, false, JSON.stringify(change));
    assert.ok(r.errors.some((e) => re.test(e)), `${JSON.stringify(change)}: ${r.errors.join('; ')}`);
  }
});

test('gaps that are not unsafe are warnings only', () => {
  const r = config.check({ ...good, BACKUP_DIR: '', CLAMAV_HOST: '', RAZORPAY_KEY_ID: 'rzp_test_x', RESET_OWNER_2FA: '1' });
  assert.equal(r.ok, true);
  for (const re of [/BACKUP_DIR/, /CLAMAV_HOST/, /sandbox/, /RESET_OWNER_2FA/]) assert.ok(r.warnings.some((w) => re.test(w)), String(re));
  assert.match(config.report(r), /No blocking problems/);
});

test('the server refuses to start in production with unsafe settings', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hireriv-launch-'));
  const run = (env) => spawnSync(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'), timeout: 20000, encoding: 'utf8',
    env: { ...process.env, PORT: '0', DB_FILE: path.join(dir, 'x.db'), UPLOADS_DIR: path.join(dir, 'up'), OUTBOX_DIR: path.join(dir, 'out'), ...env },
  });
  const r = run({ ...good, ADMIN_PASS: 'change-me-to-a-long-password', SITE_URL: 'http://example.com' });
  assert.equal(r.status, 1);
  assert.match(r.stderr + r.stdout, /ADMIN_PASS is still a placeholder/);
  assert.match(r.stderr + r.stdout, /Not starting/);
  // It stopped before opening the database.
  assert.equal(fs.existsSync(path.join(dir, 'x.db')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a backup is restored into a scratch folder, checked, counted and timed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hireriv-drill-'));
  const db = open(path.join(dir, 'live.db'));
  db.replaceAll('jobs', [{ id: 'j1', title: 'Dev' }, { id: 'j2', title: 'Welder' }]);
  db.replaceAll('posts', [{ id: 'p1', title: 'Hello' }]);
  const logged = [];
  const b = backupsModule.create({ db, dir: path.join(dir, 'backups'), log: (u, a, d) => logged.push([a, d]) });

  // Nothing to restore yet.
  assert.equal(b.restoreTest(new Date('2026-10-01T03:00:00Z')).ok, false);
  assert.match(b.warning(new Date('2026-10-01T03:00:00Z')), /not run yet/);

  // runIfDue backs up, then tests the restore.
  b.runIfDue(new Date('2026-10-02T03:00:00Z'));
  const d = b.drillStatus();
  assert.equal(d.ok, true);
  assert.equal(d.name, 'hireriv-2026-10-02-0300.db');
  assert.equal(d.records >= 3, true);
  assert.equal(d.ageHours, 0);
  assert.equal(typeof d.ms, 'number');
  assert.equal(b.warning(new Date('2026-10-02T04:00:00Z')), null);

  // Not again within the week; again after it.
  b.runIfDue(new Date('2026-10-05T03:00:00Z'));
  assert.equal(b.drillStatus().at, '2026-10-02T03:00:00.000Z');
  b.runIfDue(new Date('2026-10-09T03:00:00Z'));
  assert.equal(b.drillStatus().at, '2026-10-09T03:00:00.000Z');

  // A damaged copy fails the test, is logged and shows on the dashboard.
  const newest = path.join(dir, 'backups', b.list()[0].name);
  fs.writeFileSync(newest, 'not a database');
  const bad = b.restoreTest(new Date('2026-10-09T05:00:00Z'));
  assert.equal(bad.ok, false);
  assert.match(b.warning(new Date('2026-10-09T06:00:00Z')), /restore test failed/);
  assert.equal(logged.at(-1)[0], 'Backup restore test failed');

  // The standalone check never touches the live database.
  assert.equal(backupsModule.restoreCheck(path.join(dir, 'backups', b.list()[1].name)).ok, true);
  assert.equal(db.all('jobs').length, 2);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
