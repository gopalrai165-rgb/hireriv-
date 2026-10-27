// Automatic database backups. Once a day a consistent snapshot of the SQLite
// database is written to BACKUP_DIR, checked by opening it and running SQLite's
// integrity check, and only the newest copies are kept. Point BACKUP_DIR at a
// different disk (or a synced folder) so a failed disk doesn't take both.
// Resumes in UPLOADS_DIR are files, not in the database; back that folder up too.
//
// A backup only counts once it has been restored, so once a week (and on
// demand with `npm run backup:restore-test`) the newest copy is restored into
// a scratch folder the way a real restore is done: copied, opened by the
// app's own db.open, integrity-checked and its records counted, all timed.
// The result is kept for the dashboard and is the evidence behind the
// recovery targets in docs/LAUNCH.md.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const KEEP = 14;
const EVERY_MS = 24 * 60 * 60 * 1000;
// Older than this and the dashboard warns that backups have stopped.
const STALE_MS = 2 * EVERY_MS;
const NAME_RE = /^hireriv-\d{4}-\d{2}-\d{2}-\d{4}\.db$/;
const DRILL_EVERY_MS = 7 * EVERY_MS;
// A restore test older than this (after one has run) is shown as a problem.
const DRILL_STALE_MS = 8 * EVERY_MS;

// Restores one backup file into a scratch folder and checks it. Returns what
// was found and how long it took; never touches the live database.
function restoreCheck(file) {
  const t0 = Date.now();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hireriv-restore-'));
  const target = path.join(scratch, 'hireriv.db');
  try {
    fs.copyFileSync(file, target);
    const read = (fn) => {
      const copy = new DatabaseSync(target, { readOnly: true });
      try {
        return fn(copy);
      } finally {
        copy.close();
      }
    };
    if (read((copy) => copy.prepare('PRAGMA integrity_check').get().integrity_check) !== 'ok') throw new Error('integrity check failed after restore');
    // Opened by the app's own code, as the server would open it after a restore.
    require('./db').open(target).close();
    const collections = read((copy) => copy.prepare('SELECT collection, COUNT(*) AS n FROM records GROUP BY collection').all());
    const records = collections.reduce((a, r) => a + r.n, 0);
    if (!records) throw new Error('the restored copy holds no records');
    return { ok: true, ms: Date.now() - t0, size: fs.statSync(file).size, records, collections: collections.length };
  } catch (err) {
    return { ok: false, ms: Date.now() - t0, error: err.message };
  } finally {
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (e) { /* left for the OS to clear */ }
  }
}

const stamp = (d) => d.toISOString().slice(0, 16).replace('T', '-').replace(':', '');

// `keep` is a number of copies, or a function giving it (the retention policy).
function create({ db, dir, log, keep = KEEP }) {
  const keepCount = () => Math.max(1, Number(typeof keep === 'function' ? keep() : keep) || KEEP);
  const status = () => {
    try {
      return JSON.parse(db.metaGet('backup:last') || 'null');
    } catch (e) {
      return null;
    }
  };

  // Newest first.
  function list() {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => NAME_RE.test(f))
      .sort()
      .reverse()
      .map((name) => ({ name, size: fs.statSync(path.join(dir, name)).size }));
  }

  function check(file) {
    const copy = new DatabaseSync(file, { readOnly: true });
    try {
      return copy.prepare('PRAGMA integrity_check').get().integrity_check === 'ok';
    } finally {
      copy.close();
    }
  }

  function run(now = new Date()) {
    const name = `hireriv-${stamp(now)}.db`;
    const file = path.join(dir, name);
    let result;
    try {
      fs.mkdirSync(dir, { recursive: true });
      db.backupTo(file);
      if (!check(file)) throw new Error('integrity check failed');
      for (const old of list().slice(keepCount())) fs.unlinkSync(path.join(dir, old.name));
      result = { ok: true, at: now.toISOString(), name, size: fs.statSync(file).size };
    } catch (err) {
      fs.rm(file, { force: true }, () => {});
      const prev = status();
      result = { ok: false, at: now.toISOString(), error: err.message, lastOk: prev ? (prev.ok ? prev.at : prev.lastOk) : null };
      console.error(`[backup] Failed: ${err.message}`);
      log(null, 'Automatic backup failed', err.message);
    }
    db.metaSet('backup:last', JSON.stringify(result));
    return result;
  }

  const drillStatus = () => {
    try {
      return JSON.parse(db.metaGet('backup:restore-test') || 'null');
    } catch (e) {
      return null;
    }
  };

  // Restores the newest backup (or the one named) into a scratch folder and
  // records the result, including how old the copy was (the data a restore
  // would lose) and how long it took.
  function restoreTest(now = new Date(), name) {
    const pick = name ? list().find((f) => f.name === name) : list()[0];
    let result;
    if (!pick) result = { ok: false, at: now.toISOString(), error: 'no backup to restore' };
    else {
      const m = /^hireriv-(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})\.db$/.exec(pick.name);
      const takenAt = new Date(`${m[1]}T${m[2]}:${m[3]}:00Z`);
      result = { at: now.toISOString(), name: pick.name, ageHours: Math.max(0, Math.round((now - takenAt) / 3600000)), ...restoreCheck(path.join(dir, pick.name)) };
    }
    if (!result.ok) {
      console.error(`[backup] Restore test failed: ${result.error}`);
      log(null, 'Backup restore test failed', result.error);
    }
    db.metaSet('backup:restore-test', JSON.stringify(result));
    return result;
  }

  // Back up when the last good copy is a day old (also right after a restart),
  // then test a restore when the last test is a week old (a day, if it failed).
  function runIfDue(now = new Date()) {
    const s = status();
    const lastOk = s && (s.ok ? s.at : s.lastOk);
    const out = !lastOk || now - new Date(lastOk) >= EVERY_MS - 60000 ? run(now) : null;
    const d = drillStatus();
    if (list().length && (!d || now - new Date(d.at) >= (d.ok ? DRILL_EVERY_MS : EVERY_MS) - 60000)) restoreTest(now);
    return out;
  }

  function start() {
    runIfDue();
    setInterval(runIfDue, 60 * 60 * 1000).unref();
  }

  // For the dashboard: a problem worth showing, or null.
  function warning(now = new Date()) {
    const s = status();
    if (!s) return 'Automatic backups have not run yet';
    if (!s.ok) return `The last automatic backup failed: ${s.error}`;
    if (now - new Date(s.at) > STALE_MS) return 'Automatic backups have stopped (none in the last 2 days)';
    const d = drillStatus();
    if (d && !d.ok) return `The last backup restore test failed: ${d.error}`;
    if (d && now - new Date(d.at) > DRILL_STALE_MS) return 'Backup restore tests have stopped (none in the last 8 days)';
    return null;
  }

  // Resolves a download request to a file in the backup folder, or null.
  const fileFor = (name) => (NAME_RE.test(name) && fs.existsSync(path.join(dir, name)) ? path.join(dir, name) : null);

  return { run, runIfDue, restoreTest, drillStatus, start, status, list, warning, fileFor, dir, get keep() { return keepCount(); } };
}

module.exports = { create, restoreCheck, KEEP, NAME_RE };

// `npm run backup:restore-test [-- file.db]`: restores the given backup, or the
// newest one in BACKUP_DIR (default: backups/ next to DB_FILE), into a scratch
// folder and prints what it found. Exits 1 when the restore fails.
if (require.main === module) {
  const dbFile = path.resolve(process.env.DB_FILE || path.join(__dirname, 'data', 'hireriv.db'));
  const folder = process.env.BACKUP_DIR ? path.resolve(process.env.BACKUP_DIR) : path.join(path.dirname(dbFile), 'backups');
  const newest = fs.existsSync(folder) ? fs.readdirSync(folder).filter((f) => NAME_RE.test(f)).sort().pop() : null;
  const file = process.argv[2] ? path.resolve(process.argv[2]) : newest && path.join(folder, newest);
  const result = file ? { file, ...restoreCheck(file) } : { ok: false, error: `no backups in ${folder}` };
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}
