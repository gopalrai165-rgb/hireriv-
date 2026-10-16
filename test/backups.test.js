// Automatic backups: written, checked, pruned, downloadable by Admins only.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { open } = require('../db');
const backupsModule = require('../backups');
const { startServer } = require('./helpers');

test('backups keep the newest copies and pass the integrity check', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hireriv-bk-'));
  const db = open(path.join(dir, 'live.db'));
  db.replaceAll('jobs', [{ id: 'j1', title: 'Dev' }]);
  const logged = [];
  const b = backupsModule.create({ db, dir: path.join(dir, 'backups'), log: (u, a, d) => logged.push(a), keep: 3 });

  assert.equal(b.warning(), 'Automatic backups have not run yet');
  for (let day = 1; day <= 5; day++) assert.equal(b.run(new Date(`2026-10-0${day}T03:00:00Z`)).ok, true);
  assert.deepEqual(b.list().map((f) => f.name), ['hireriv-2026-10-05-0300.db', 'hireriv-2026-10-04-0300.db', 'hireriv-2026-10-03-0300.db']);

  // The copy is a real, readable database.
  const copy = open(path.join(dir, 'backups', 'hireriv-2026-10-05-0300.db'));
  assert.equal(copy.all('jobs')[0].title, 'Dev');
  copy.close();

  // Due again only after a day; stale after two.
  assert.equal(b.runIfDue(new Date('2026-10-05T20:00:00Z')), null);
  assert.equal(b.warning(new Date('2026-10-06T03:00:00Z')), null);
  assert.match(b.warning(new Date('2026-10-08T03:00:00Z')), /stopped/);

  // Only backup file names resolve, so a download can't reach other files.
  assert.equal(b.fileFor('../live.db'), null);
  assert.equal(b.fileFor('hireriv-2026-10-01-0300.db'), null); // pruned
  assert.ok(b.fileFor('hireriv-2026-10-05-0300.db'));

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(logged, []);
});

test('a failed backup is recorded and reported', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hireriv-bk-'));
  const db = open(path.join(dir, 'live.db'));
  const blocker = path.join(dir, 'not-a-folder');
  fs.writeFileSync(blocker, 'x'); // a file where the backup folder should be
  const logged = [];
  const b = backupsModule.create({ db, dir: blocker, log: (u, a) => logged.push(a) });
  const r = b.run();
  assert.equal(r.ok, false);
  assert.match(b.warning(), /^The last automatic backup failed/);
  assert.deepEqual(logged, ['Automatic backup failed']);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

let srv;
let admin;
before(async () => {
  srv = await startServer();
  admin = await srv.adminLogin();
});
after(() => srv && srv.stop());

test('the server backs up on start, and Admins can back up now and download', async () => {
  const dir = path.join(srv.paths.dir, 'backups');
  assert.equal(fs.readdirSync(dir).length, 1);
  const settings = await (await srv.request('/admin?tab=settings', { cookie: admin })).text();
  assert.match(settings, /Last backup:/);

  const run = await srv.request('/admin/backups/run', { method: 'POST', cookie: admin, form: {} });
  assert.match(decodeURIComponent(run.headers.get('location')), /Backup saved: hireriv-/);

  const name = fs.readdirSync(dir)[0];
  const dl = await srv.request(`/admin/backups/${name}`, { cookie: admin });
  assert.equal(dl.status, 200);
  assert.equal(Buffer.from(await dl.arrayBuffer()).subarray(0, 15).toString(), 'SQLite format 3');
  assert.equal((await srv.request(`/admin/backups/${name}`)).status, 401);
  assert.equal((await srv.request('/admin/backups/..%2Ftest.db', { cookie: admin })).status, 404);
});
