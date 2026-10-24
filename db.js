// SQLite storage (Node's built-in node:sqlite, no native build step).
// Records are JSON documents grouped by collection; `pos` keeps each list in
// the order the app expects (newest first for submissions). Every write runs in
// a transaction, so a crash can never leave a half-written file behind.
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

function open(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS records (
      collection TEXT NOT NULL,
      id         TEXT NOT NULL,
      pos        INTEGER NOT NULL,
      data       TEXT NOT NULL,
      PRIMARY KEY (collection, id)
    );
    CREATE INDEX IF NOT EXISTS records_order ON records (collection, pos);
    CREATE TABLE IF NOT EXISTS sessions (
      kind    TEXT NOT NULL,
      key     TEXT NOT NULL,
      subject TEXT NOT NULL,
      exp     INTEGER NOT NULL,
      PRIMARY KEY (kind, key)
    );
    CREATE INDEX IF NOT EXISTS sessions_subject ON sessions (kind, subject);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  // A per-collection unique key (e.g. one live application per person and job),
  // enforced by SQLite itself. Documents without a key are not constrained.
  if (!db.prepare('PRAGMA table_info(records)').all().some((c) => c.name === 'ukey')) db.exec('ALTER TABLE records ADD COLUMN ukey TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS records_unique ON records (collection, ukey) WHERE ukey IS NOT NULL');
  const keyFns = {};
  const keyOf = (collection, doc) => (keyFns[collection] ? keyFns[collection](doc) || null : null);

  const q = {
    all: db.prepare('SELECT data FROM records WHERE collection = ? ORDER BY pos'),
    count: db.prepare('SELECT COUNT(*) AS n FROM records WHERE collection = ?'),
    clear: db.prepare('DELETE FROM records WHERE collection = ?'),
    put: db.prepare('INSERT INTO records (collection, id, pos, data, ukey) VALUES (?, ?, ?, ?, ?)'),
    minPos: db.prepare('SELECT COALESCE(MIN(pos), 0) AS p FROM records WHERE collection = ?'),
    metaGet: db.prepare('SELECT value FROM meta WHERE key = ?'),
    metaSet: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    sGet: db.prepare('SELECT subject, exp FROM sessions WHERE kind = ? AND key = ?'),
    sSet: db.prepare('INSERT INTO sessions (kind, key, subject, exp) VALUES (?, ?, ?, ?) ON CONFLICT(kind, key) DO UPDATE SET subject = excluded.subject, exp = excluded.exp'),
    sDel: db.prepare('DELETE FROM sessions WHERE kind = ? AND key = ?'),
    sDelSubject: db.prepare('DELETE FROM sessions WHERE kind = ? AND subject = ?'),
    sPurge: db.prepare('DELETE FROM sessions WHERE exp < ?'),
  };

  function tx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (err) {
      db.exec('ROLLBACK');
      if (/UNIQUE constraint failed: records\.collection, records\.ukey/.test(err.message)) err.code = 'ERR_UNIQUE';
      throw err;
    }
  }

  // Documents without an id (e.g. the site settings) get a stable positional one.
  const idOf = (doc, i) => String(doc && doc.id != null ? doc.id : doc && doc.slug != null ? `slug:${doc.slug}` : `#${i}`);

  const store = {
    all: (collection) => q.all.all(collection).map((r) => JSON.parse(r.data)),
    count: (collection) => q.count.get(collection).n,

    // Replace a whole collection atomically, preserving list order.
    replaceAll(collection, list) {
      tx(() => {
        q.clear.run(collection);
        list.forEach((doc, i) => q.put.run(collection, idOf(doc, i), i, JSON.stringify(doc), keyOf(collection, doc)));
      });
    },

    // Add one document at the front (newest first), as submissions expect.
    prepend(collection, doc) {
      tx(() => q.put.run(collection, idOf(doc, 0), q.minPos.get(collection).p - 1, JSON.stringify(doc), keyOf(collection, doc)));
    },

    // Register the unique key for a collection: fn(doc) returns a string, or
    // null for documents the rule doesn't cover. Writes that would break it
    // throw an error with `code === 'ERR_UNIQUE'` and nothing is changed.
    uniqueKey(collection, fn) {
      keyFns[collection] = fn;
    },

    metaGet: (key) => (q.metaGet.get(key) || {}).value,
    metaSet: (key, value) => q.metaSet.run(key, String(value)),

    // Server-side sessions and one-time links, keyed by a hash of the token.
    sessions: {
      get(kind, key) {
        const row = q.sGet.get(kind, key);
        if (!row) return null;
        if (row.exp < Date.now()) {
          q.sDel.run(kind, key);
          return null;
        }
        return { subject: row.subject, exp: row.exp };
      },
      set: (kind, key, subject, exp) => q.sSet.run(kind, key, subject, exp),
      delete: (kind, key) => q.sDel.run(kind, key),
      deleteSubject: (kind, subject) => q.sDelSubject.run(kind, subject),
      purgeExpired: () => q.sPurge.run(Date.now()),
    },

    // Consistent snapshot for backups (safe while the app keeps running).
    backupTo(target) {
      if (fs.existsSync(target)) fs.unlinkSync(target);
      db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    },

    close: () => db.close(),
  };

  // Load legacy JSON files once per collection; the originals are left untouched.
  store.importOnce = (collection, file) => {
    const flag = `imported:${collection}`;
    if (store.metaGet(flag)) return 0;
    let list = [];
    if (fs.existsSync(file) && store.count(collection) === 0) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      list = Array.isArray(parsed) ? parsed : [parsed];
      store.replaceAll(collection, list);
    }
    store.metaSet(flag, new Date().toISOString());
    return list.length;
  };

  return store;
}

module.exports = { open };
