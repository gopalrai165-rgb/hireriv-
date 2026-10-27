// Automatic database backups. Once a day a consistent snapshot of the SQLite
// database is written to BACKUP_DIR, checked by opening it and running SQLite's
// integrity check, and only the newest copies are kept. Point BACKUP_DIR at a
// different disk (or a synced folder) so a failed disk doesn't take both.
//
// Uploaded files (resumes, documents, evidence) are not in the database, so
// each backup also copies UPLOADS_DIR into BACKUP_DIR/uploads, stored once
// per content (named by SHA-256, so an unchanged file is never copied twice),
// with a list next to the database copy (hireriv-….uploads.json) naming every
// file that backup holds. Files stay encrypted as they are on disk (vault.js):
// restoring them needs the same FILE_ENCRYPTION_KEY.
//
// A backup only counts once it has been restored, so once a week (and on
// demand with `npm run backup:restore-test`) the newest copy is restored into
// a scratch folder the way a real restore is done: copied, opened by the
// app's own db.open, integrity-checked and its records counted, all timed.
// The result is kept for the dashboard and is the evidence behind the
// recovery targets in docs/LAUNCH.md.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const KEEP = 14;
const EVERY_MS = 24 * 60 * 60 * 1000;
// Older than this and the dashboard warns that backups have stopped.
const STALE_MS = 2 * EVERY_MS;
const NAME_RE = /^hireriv-\d{4}-\d{2}-\d{2}-\d{4}\.db$/;
const LIST_RE = /^hireriv-\d{4}-\d{2}-\d{2}-\d{4}\.uploads\.json$/;
const listName = (dbName) => dbName.replace(/\.db$/, '.uploads.json');
// The names the app gives uploads (server.js and the document folders), as
// they appear inside records; used to spot records whose file is missing.
const UPLOAD_REF_RE = /\b(?:\d{13}-[0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(?:pdf|docx?|jpe?g|png)\b/g;
const DRILL_EVERY_MS = 7 * EVERY_MS;
// A restore test older than this (after one has run) is shown as a problem.
const DRILL_STALE_MS = 8 * EVERY_MS;

// ---------- uploaded files ----------
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const blobPath = (store, hash) => path.join(store, hash.slice(0, 2), hash);

// Every upload under `root` with its path relative to it ('/'-separated).
// Dotfiles and files being encrypted right now (vault.js) are skipped.
function walk(root, rel = '') {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return out;
    throw err;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name.endsWith('.sealing')) continue;
    const name = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(root, name));
    else if (e.isFile()) out.push(name);
  }
  return out;
}

// Copies the uploads folder into the store and returns the list of files.
// A file whose size and time match the previous list is not read again.
function snapshotUploads(uploadsDir, store, prev) {
  const known = new Map(((prev && prev.files) || []).map((f) => [f.name, f]));
  const files = [];
  let added = 0;
  let addedBytes = 0;
  for (const name of walk(uploadsDir).sort()) {
    const full = path.join(uploadsDir, ...name.split('/'));
    let st;
    try {
      st = fs.statSync(full);
    } catch (err) {
      if (err.code === 'ENOENT') continue; // deleted while we looked
      throw err;
    }
    const old = known.get(name);
    if (old && old.size === st.size && old.mtimeMs === st.mtimeMs && fs.existsSync(blobPath(store, old.sha256))) {
      files.push(old);
      continue;
    }
    let buf;
    try {
      buf = fs.readFileSync(full);
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    // Hashed and copied from the same read, so a file rewritten meanwhile
    // can't leave a copy that doesn't match its name.
    const hash = sha256(buf);
    const blob = blobPath(store, hash);
    if (!fs.existsSync(blob)) {
      fs.mkdirSync(path.dirname(blob), { recursive: true });
      fs.writeFileSync(`${blob}.tmp`, buf);
      fs.renameSync(`${blob}.tmp`, blob);
      added++;
      addedBytes += buf.length;
    }
    files.push({ name, size: buf.length, mtimeMs: st.mtimeMs, sha256: hash });
  }
  return { files, added, addedBytes, bytes: files.reduce((a, f) => a + f.size, 0) };
}

// Writes the files of one uploads list into `target`, checking each against
// its hash. Existing files are left alone unless `overwrite`. Throws when a
// stored copy is missing or damaged, or a name would leave the folder.
function restoreUploads(list, store, target, { overwrite = true } = {}) {
  const root = path.resolve(target);
  let written = 0;
  let skipped = 0;
  for (const f of list.files) {
    const dest = path.resolve(root, ...String(f.name).split('/'));
    if (!dest.startsWith(root + path.sep)) throw new Error(`unsafe file name in the uploads list: ${f.name}`);
    if (!overwrite && fs.existsSync(dest)) { skipped++; continue; }
    let buf;
    try {
      buf = fs.readFileSync(blobPath(store, f.sha256));
    } catch (err) {
      throw new Error(`the stored copy of ${f.name} is missing`);
    }
    if (buf.length !== f.size || sha256(buf) !== f.sha256) throw new Error(`the stored copy of ${f.name} is damaged`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
    written++;
  }
  return { written, skipped };
}

const readList = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

// Restores one backup file into a scratch folder and checks it, with its
// uploaded files when the backup has a list of them. Returns what was found
// and how long it took; never touches the live database or uploads.
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
    const out = { ok: true, ms: Date.now() - t0, size: fs.statSync(file).size, records, collections: collections.length };
    const listFile = path.join(path.dirname(file), listName(path.basename(file)));
    if (fs.existsSync(listFile)) {
      const t1 = Date.now();
      const list = readList(listFile);
      restoreUploads(list, path.join(path.dirname(file), 'uploads'), path.join(scratch, 'uploads'));
      // Files the restored records name that the copy doesn't hold: they were
      // already missing on the live disk when the backup was taken.
      const held = new Set(list.files.map((f) => path.posix.basename(f.name)));
      const named = new Set();
      read((copy) => {
        for (const r of copy.prepare('SELECT data FROM records').iterate()) for (const m of r.data.match(UPLOAD_REF_RE) || []) named.add(m);
      });
      const missing = [...named].filter((n) => !held.has(n));
      out.uploads = { files: list.files.length, bytes: list.files.reduce((a, f) => a + f.size, 0), ms: Date.now() - t1, missing: missing.length, missingExamples: missing.slice(0, 5) };
      out.ms = Date.now() - t0;
    }
    return out;
  } catch (err) {
    return { ok: false, ms: Date.now() - t0, error: err.message };
  } finally {
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (e) { /* left for the OS to clear */ }
  }
}

const stamp = (d) => d.toISOString().slice(0, 16).replace('T', '-').replace(':', '');

// `keep` is a number of copies, or a function giving it (the retention policy).
// `uploadsDir`, when given, is copied with every backup (see the top).
function create({ db, dir, log, keep = KEEP, uploadsDir }) {
  const store = path.join(dir, 'uploads');
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
      result = { ok: true, at: now.toISOString(), name, size: fs.statSync(file).size };
      if (uploadsDir) {
        // A failure here keeps the database copy; the dashboard says so.
        try {
          result.uploads = backUpUploads(name);
        } catch (err) {
          result.uploadsError = err.message;
          console.error(`[backup] Uploaded files not backed up: ${err.message}`);
          log(null, 'Backup of uploaded files failed', err.message);
        }
      }
      for (const old of list().slice(keepCount())) fs.unlinkSync(path.join(dir, old.name));
      pruneUploads();
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

  // Lists of uploads, newest first.
  const lists = () => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => LIST_RE.test(f)).sort().reverse() : []);

  function backUpUploads(name) {
    const prevName = lists()[0];
    const prev = prevName ? readList(path.join(dir, prevName)) : null;
    const snap = snapshotUploads(uploadsDir, store, prev);
    const target = path.join(dir, listName(name));
    fs.writeFileSync(`${target}.tmp`, JSON.stringify({ at: new Date().toISOString(), files: snap.files }));
    fs.renameSync(`${target}.tmp`, target);
    return { files: snap.files.length, bytes: snap.bytes, added: snap.added, addedBytes: snap.addedBytes };
  }

  // Drops the lists whose database copy is gone, then any stored file no
  // remaining list names (so an erased resume leaves with its last backup).
  function pruneUploads() {
    const kept = new Set(list().map((f) => listName(f.name)));
    for (const name of lists()) if (!kept.has(name)) fs.unlinkSync(path.join(dir, name));
    if (!fs.existsSync(store) || !fs.statSync(store).isDirectory()) return;
    const used = new Set();
    for (const name of lists()) for (const f of readList(path.join(dir, name)).files) used.add(f.sha256);
    for (const sub of fs.readdirSync(store)) {
      const folder = path.join(store, sub);
      if (!fs.statSync(folder).isDirectory()) continue;
      for (const blob of fs.readdirSync(folder)) if (!used.has(blob)) fs.rmSync(path.join(folder, blob), { force: true });
      if (!fs.readdirSync(folder).length) fs.rmdirSync(folder);
    }
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
    if (s.uploadsError) return `The last backup did not copy the uploaded files: ${s.uploadsError}`;
    const d = drillStatus();
    if (d && !d.ok) return `The last backup restore test failed: ${d.error}`;
    if (d && now - new Date(d.at) > DRILL_STALE_MS) return 'Backup restore tests have stopped (none in the last 8 days)';
    return null;
  }

  // Resolves a download request to a file in the backup folder, or null.
  const fileFor = (name) => (NAME_RE.test(name) && fs.existsSync(path.join(dir, name)) ? path.join(dir, name) : null);

  return { run, runIfDue, restoreTest, drillStatus, start, status, list, warning, fileFor, dir, get keep() { return keepCount(); } };
}

module.exports = { create, restoreCheck, restoreUploads, snapshotUploads, KEEP, NAME_RE, LIST_RE };

// `npm run backup:restore-test [-- file.db]`: restores the given backup, or the
// newest one in BACKUP_DIR (default: backups/ next to DB_FILE), into a scratch
// folder with its uploaded files and prints what it found. Exits 1 when the
// restore fails.
//
// `npm run backup:restore-uploads -- <folder> [hireriv-….db]`: puts the
// uploaded files of that backup (default: the newest) into <folder>, for a
// real restore; files already there are kept. Exits 1 on a missing or
// damaged copy.
if (require.main === module) {
  const dbFile = path.resolve(process.env.DB_FILE || path.join(__dirname, 'data', 'hireriv.db'));
  const folder = process.env.BACKUP_DIR ? path.resolve(process.env.BACKUP_DIR) : path.join(path.dirname(dbFile), 'backups');
  const newest = fs.existsSync(folder) ? fs.readdirSync(folder).filter((f) => NAME_RE.test(f)).sort().pop() : null;
  let result;
  if (process.argv[2] === 'restore-uploads') {
    const target = process.argv[3];
    const name = process.argv[4] ? path.basename(process.argv[4]) : newest;
    const listFile = name && path.join(folder, listName(name));
    if (!target) result = { ok: false, error: 'name the folder to restore into, e.g. npm run backup:restore-uploads -- /var/data/uploads' };
    else if (!listFile || !fs.existsSync(listFile)) result = { ok: false, error: `no uploads list for ${name || 'any backup'} in ${folder}` };
    else {
      try {
        result = { ok: true, from: listFile, into: path.resolve(target), ...restoreUploads(readList(listFile), path.join(folder, 'uploads'), target, { overwrite: false }) };
      } catch (err) {
        result = { ok: false, error: err.message };
      }
    }
  } else {
    const file = process.argv[2] ? path.resolve(process.argv[2]) : newest && path.join(folder, newest);
    result = file ? { file, ...restoreCheck(file) } : { ok: false, error: `no backups in ${folder}` };
  }
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}
