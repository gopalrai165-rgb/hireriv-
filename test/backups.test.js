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

test('uploaded files are copied once, restored and checked, and leave with their last backup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hireriv-bk-'));
  const uploads = path.join(dir, 'uploads');
  const bdir = path.join(dir, 'backups');
  fs.mkdirSync(path.join(uploads, 'worker-documents'), { recursive: true });
  const resume = '1761600000000-0a1b2c3d.pdf';
  const doc = 'worker-documents/0f8fad5b-d9cb-469f-a165-70867728950e.png';
  fs.writeFileSync(path.join(uploads, resume), 'resume one');
  fs.writeFileSync(path.join(uploads, ...doc.split('/')), 'a scan');
  fs.writeFileSync(path.join(uploads, '.gitkeep'), '');
  fs.writeFileSync(path.join(uploads, 'x.pdf.sealing'), 'half written');
  const db = open(path.join(dir, 'live.db'));
  // One record names a file that is not on disk.
  db.replaceAll('applications', [{ id: 'a1', resume }, { id: 'a2', resume: '1761600000001-deadbeef.pdf' }]);
  const logged = [];
  const b = backupsModule.create({ db, dir: bdir, log: (u, a) => logged.push(a), keep: 2, uploadsDir: uploads });

  const first = b.run(new Date('2026-10-01T03:00:00Z'));
  assert.deepEqual(first.uploads, { files: 2, bytes: 16, added: 2, addedBytes: 16 });
  // Nothing changed: nothing copied again.
  assert.equal(b.run(new Date('2026-10-02T03:00:00Z')).uploads.added, 0);

  const drill = b.restoreTest(new Date('2026-10-02T04:00:00Z'));
  assert.equal(drill.ok, true);
  assert.equal(drill.uploads.files, 2);
  assert.equal(drill.uploads.missing, 1);
  assert.deepEqual(drill.uploads.missingExamples, ['1761600000001-deadbeef.pdf']);

  // A real restore into an empty folder gives back the same files.
  const into = path.join(dir, 'restored');
  const list = JSON.parse(fs.readFileSync(path.join(bdir, 'hireriv-2026-10-02-0300.uploads.json'), 'utf8'));
  assert.deepEqual(backupsModule.restoreUploads(list, path.join(bdir, 'uploads'), into), { written: 2, skipped: 0 });
  assert.equal(fs.readFileSync(path.join(into, ...doc.split('/')), 'utf8'), 'a scan');
  // Kept files are not overwritten when asked not to.
  assert.deepEqual(backupsModule.restoreUploads(list, path.join(bdir, 'uploads'), into, { overwrite: false }), { written: 0, skipped: 2 });
  // A name that would leave the folder is refused.
  assert.throws(() => backupsModule.restoreUploads({ files: [{ ...list.files[0], name: '../escape.pdf' }] }, path.join(bdir, 'uploads'), into), /unsafe/);

  // The resume is erased; once no kept backup holds it, its copy goes too.
  fs.unlinkSync(path.join(uploads, resume));
  const blobs = () => fs.readdirSync(path.join(bdir, 'uploads'), { recursive: true }).filter((f) => /[0-9a-f]{64}$/.test(f)).length;
  b.run(new Date('2026-10-03T03:00:00Z'));
  assert.equal(blobs(), 2); // the 10-02 backup still holds it
  b.run(new Date('2026-10-04T03:00:00Z'));
  assert.equal(blobs(), 1);
  assert.deepEqual(fs.readdirSync(bdir).filter((f) => f.endsWith('.json')), ['hireriv-2026-10-03-0300.uploads.json', 'hireriv-2026-10-04-0300.uploads.json']);

  // A damaged stored copy fails the restore test.
  const blob = fs.readdirSync(path.join(bdir, 'uploads'), { recursive: true }).find((f) => /[0-9a-f]{64}$/.test(f));
  fs.writeFileSync(path.join(bdir, 'uploads', blob), 'tampered');
  const bad = b.restoreTest(new Date('2026-10-04T04:00:00Z'));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /damaged/);
  assert.match(b.warning(new Date('2026-10-04T05:00:00Z')), /restore test failed/);

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(logged, ['Backup restore test failed']);
});

test('a failed copy of the uploads keeps the database backup and is reported', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hireriv-bk-'));
  const db = open(path.join(dir, 'live.db'));
  db.replaceAll('jobs', [{ id: 'j1' }]);
  fs.mkdirSync(path.join(dir, 'uploads'));
  fs.writeFileSync(path.join(dir, 'uploads', 'a.pdf'), 'x');
  fs.mkdirSync(path.join(dir, 'backups'));
  fs.writeFileSync(path.join(dir, 'backups', 'uploads'), 'a file where the store should be');
  const logged = [];
  const b = backupsModule.create({ db, dir: path.join(dir, 'backups'), log: (u, a) => logged.push(a), uploadsDir: path.join(dir, 'uploads') });
  const r = b.run();
  assert.equal(r.ok, true);
  assert.ok(r.uploadsError);
  assert.match(b.warning(), /did not copy the uploaded files/);
  assert.deepEqual(logged, ['Backup of uploaded files failed']);
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
  const copies = () => fs.readdirSync(dir).filter((f) => f.endsWith('.db'));
  assert.equal(copies().length, 1);
  // The uploads folder is copied with it.
  assert.ok(fs.existsSync(path.join(dir, copies()[0].replace(/\.db$/, '.uploads.json'))));
  const settings = await (await srv.request('/admin?tab=settings', { cookie: admin })).text();
  assert.match(settings, /Last backup:/);

  const run = await srv.request('/admin/backups/run', { method: 'POST', cookie: admin, form: {} });
  assert.match(decodeURIComponent(run.headers.get('location')), /Backup saved: hireriv-/);

  const name = copies()[0];
  // Downloading a copy asks for the password again first.
  assert.equal((await srv.request(`/admin/backups/${name}`, { cookie: admin })).status, 303);
  await srv.confirm(admin);
  const dl = await srv.request(`/admin/backups/${name}`, { cookie: admin });
  assert.equal(dl.status, 200);
  assert.equal(Buffer.from(await dl.arrayBuffer()).subarray(0, 15).toString(), 'SQLite format 3');
  assert.equal((await srv.request(`/admin/backups/${name}`)).status, 401);
  assert.equal((await srv.request('/admin/backups/..%2Ftest.db', { cookie: admin })).status, 404);
});
