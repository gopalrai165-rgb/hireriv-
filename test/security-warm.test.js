// Step 186: security alert counts survive a restart. The counts live in memory,
// so a new process builds them again from the last hour of the stored log:
// a burst of failed sign-ins that spans a restart still raises its alert, and
// an alert already raised in the last hour is not raised again.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const security = require('../security');

function memoryDb() {
  const data = {};
  return {
    all: (c) => (data[c] || []).slice(),
    prepend: (c, x) => { data[c] = [x, ...(data[c] || [])]; },
    replaceAll: (c, list) => { data[c] = list.slice(); },
    metaGet: () => null,
    metaSet: () => {},
  };
}
function start(db, sent) {
  const notify = { candidateRk: (e) => e, emit: (x) => sent.push(x) };
  const mailer = { teamSecurityNotice: () => {} };
  const team = { members: () => [{ id: 't1', name: 'Owner', role: 'Admin', email: 'owner@hireriv.test' }] };
  return security.create({ db, notify, mailer, getTeam: () => team });
}
const alerts = (db) => db.all('security-events').filter((e) => e.type === 'alert');

// record() takes the address from req; give it one.
function failedFrom(s, ip, at) {
  return s.record('sign-in-failed', { req: { ip, originalUrl: '/admin/login', method: 'POST' }, outcome: 'refused', at: new Date(at).toISOString() });
}

test('a burst of failed sign-ins split by a restart still raises its alert', () => {
  const db = memoryDb();
  const sent = [];
  const t0 = Date.now() - 5 * 60000;
  const first = start(db, sent);
  for (let i = 0; i < 6; i++) failedFrom(first, '10.9.0.1', t0 + i * 1000);
  assert.equal(alerts(db).length, 0);
  // The server restarts: a new instance, same stored log.
  const second = start(db, sent);
  for (let i = 0; i < 4; i++) failedFrom(second, '10.9.0.1', t0 + 10000 + i * 1000);
  const raised = alerts(db).filter((a) => a.target === 'sign-ins-ip');
  assert.equal(raised.length, 1);
  assert.match(raised[0].detail, /10 failed sign-ins from 10\.9\.0\.1/);
  assert.equal(raised[0].alertKey, 'sign-ins-ip|10.9.0.1');
  assert.equal(sent.filter((x) => x.type === 'security-alert').length, 1);
});

test('an alert raised before the restart is not raised again within the hour, and old events do not count', () => {
  const db = memoryDb();
  const sent = [];
  const t0 = Date.now() - 10 * 60000;
  const first = start(db, sent);
  for (let i = 0; i < 10; i++) failedFrom(first, '10.9.0.2', t0 + i * 1000);
  assert.equal(alerts(db).length, 1);
  const second = start(db, sent);
  for (let i = 0; i < 10; i++) failedFrom(second, '10.9.0.2', t0 + 20000 + i * 1000);
  assert.equal(alerts(db).filter((a) => a.target === 'sign-ins-ip').length, 1, 'still one alert this hour');
  assert.equal(sent.length, 1);

  // Failed sign-ins from two hours ago are outside every window.
  const db2 = memoryDb();
  const old = start(db2, []);
  for (let i = 0; i < 9; i++) failedFrom(old, '10.9.0.3', Date.now() - 2 * 3600000 + i * 1000);
  const fresh = start(db2, []);
  failedFrom(fresh, '10.9.0.3', Date.now());
  assert.equal(alerts(db2).length, 0);
});

// Sign-in lock-outs (failure-log.js) are saved in the meta table.
const failureLog = require('../failure-log');
function metaDb() {
  const meta = {};
  return { metaGet: (k) => meta[k] ?? null, metaSet: (k, v) => { meta[k] = v; }, meta };
}

test('sign-in lock-outs survive a restart, keep no addresses and forget old failures', () => {
  const db = metaDb();
  const before = failureLog.create(db, 'employer-login', 15 * 60000);
  for (let i = 0; i < 9; i++) before.note('someone@company.test');
  assert.equal(before.count('someone@company.test'), 9);
  assert.doesNotMatch(db.meta['lockout:employer-login'], /someone|company\.test/, 'only hashes are stored');
  // After a restart the count is still there.
  const after = failureLog.create(db, 'employer-login', 15 * 60000);
  assert.equal(after.count('someone@company.test'), 9);
  assert.equal(after.note('someone@company.test'), 10);
  assert.equal(after.count('other@company.test'), 0);
  // Another lock-out keeps its own counts.
  assert.equal(failureLog.create(db, 'team-login', 15 * 60000).count('someone@company.test'), 0);
  // A good sign-in clears it.
  after.clear('someone@company.test');
  assert.equal(failureLog.create(db, 'employer-login', 15 * 60000).count('someone@company.test'), 0);
  // Failures older than the window are dropped when read again.
  const old = Date.now() - 20 * 60000;
  const h = Object.keys(JSON.parse(db.meta['lockout:employer-login'] || '{}'));
  assert.equal(h.length, 0);
  db.meta['lockout:candidate-login'] = JSON.stringify({ abc: [old, old] });
  assert.equal(failureLog.create(db, 'candidate-login', 15 * 60000).count('x'), 0);
  db.meta['lockout:broken'] = '{not json';
  assert.equal(failureLog.create(db, 'broken', 15 * 60000).count('x'), 0);
});
