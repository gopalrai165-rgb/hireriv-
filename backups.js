// Automatic database backups. Once a day a consistent snapshot of the SQLite
// database is written to BACKUP_DIR, checked by opening it and running SQLite's
// integrity check, and only the newest copies are kept. Point BACKUP_DIR at a
// different disk (or a synced folder) so a failed disk doesn't take both.
// Resumes in UPLOADS_DIR are files, not in the database; back that folder up too.
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const KEEP = 14;
const EVERY_MS = 24 * 60 * 60 * 1000;
// Older than this and the dashboard warns that backups have stopped.
const STALE_MS = 2 * EVERY_MS;
const NAME_RE = /^hireriv-\d{4}-\d{2}-\d{2}-\d{4}\.db$/;

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

  // Back up when the last good copy is a day old (also right after a restart).
  function runIfDue(now = new Date()) {
    const s = status();
    const lastOk = s && (s.ok ? s.at : s.lastOk);
    if (!lastOk || now - new Date(lastOk) >= EVERY_MS - 60000) return run(now);
    return null;
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
    return null;
  }

  // Resolves a download request to a file in the backup folder, or null.
  const fileFor = (name) => (NAME_RE.test(name) && fs.existsSync(path.join(dir, name)) ? path.join(dir, name) : null);

  return { run, runIfDue, start, status, list, warning, fileFor, dir, get keep() { return keepCount(); } };
}

module.exports = { create, KEEP, NAME_RE };
