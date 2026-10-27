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
  // Lookups by recipient and by delivery status (notifications), without
  // reading a whole collection.
  db.exec("CREATE INDEX IF NOT EXISTS records_rk ON records (collection, json_extract(data, '$.rk'))");
  db.exec("CREATE INDEX IF NOT EXISTS records_status ON records (collection, json_extract(data, '$.status'))");
  const keyFns = {};
  const whereCache = {};
  // Called with the collection's name after each committed write.
  const listeners = [];
  const changed = (collection) => listeners.forEach((fn) => fn(collection));
  const keyOf = (collection, doc) => (keyFns[collection] ? keyFns[collection](doc) || null : null);

  const q = {
    all: db.prepare('SELECT data FROM records WHERE collection = ? ORDER BY pos'),
    count: db.prepare('SELECT COUNT(*) AS n FROM records WHERE collection = ?'),
    clear: db.prepare('DELETE FROM records WHERE collection = ?'),
    put: db.prepare('INSERT INTO records (collection, id, pos, data, ukey) VALUES (?, ?, ?, ?, ?)'),
    minPos: db.prepare('SELECT COALESCE(MIN(pos), 0) AS p FROM records WHERE collection = ?'),
    update: db.prepare('UPDATE records SET data = ?, ukey = ? WHERE collection = ? AND id = ?'),
    remove: db.prepare('DELETE FROM records WHERE collection = ? AND id = ?'),
    metaGet: db.prepare('SELECT value FROM meta WHERE key = ?'),
    metaSet: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    sGet: db.prepare('SELECT subject, exp FROM sessions WHERE kind = ? AND key = ?'),
    sSet: db.prepare('INSERT INTO sessions (kind, key, subject, exp) VALUES (?, ?, ?, ?) ON CONFLICT(kind, key) DO UPDATE SET subject = excluded.subject, exp = excluded.exp'),
    sDel: db.prepare('DELETE FROM sessions WHERE kind = ? AND key = ?'),
    sDelSubject: db.prepare('DELETE FROM sessions WHERE kind = ? AND subject = ?'),
    sPurge: db.prepare('DELETE FROM sessions WHERE exp < ?'),
  };

  // Transactions nest: an inner one joins the outer, so several writes (a
  // business change and the notifications it causes) commit or fail together.
  let depth = 0;
  function tx(fn) {
    if (depth) {
      depth++;
      try {
        return fn();
      } catch (err) {
        if (/UNIQUE constraint failed: records\.collection, records\.ukey/.test(err.message)) err.code = 'ERR_UNIQUE';
        throw err;
      } finally {
        depth--;
      }
    }
    db.exec('BEGIN IMMEDIATE');
    depth = 1;
    try {
      const out = fn();
      depth = 0;
      db.exec('COMMIT');
      return out;
    } catch (err) {
      depth = 0;
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
      changed(collection);
    },

    // Add one document at the front (newest first), as submissions expect.
    prepend(collection, doc) {
      tx(() => q.put.run(collection, idOf(doc, 0), q.minPos.get(collection).p - 1, JSON.stringify(doc), keyOf(collection, doc)));
      changed(collection);
    },

    // Replace one document in place (same position), or remove some by id.
    // Both return how many documents changed.
    update(collection, doc) {
      const n = tx(() => Number(q.update.run(JSON.stringify(doc), keyOf(collection, doc), collection, String(doc.id)).changes));
      if (n) changed(collection);
      return n;
    },
    remove(collection, ids) {
      const n = tx(() => ids.reduce((sum, id) => sum + Number(q.remove.run(collection, String(id)).changes), 0));
      if (n) changed(collection);
      return n;
    },

    // Documents whose top-level `field` equals `value`, in list order. Only
    // `rk` and `status` are indexed; other fields scan the collection in SQLite.
    where(collection, field, value, { limit = -1, offset = 0 } = {}) {
      if (!/^[A-Za-z]+$/.test(field)) throw new Error(`bad field ${field}`);
      const sql = `SELECT data FROM records WHERE collection = ? AND json_extract(data, '$.${field}') = ? ORDER BY pos LIMIT ? OFFSET ?`;
      const stmt = whereCache[sql] || (whereCache[sql] = db.prepare(sql));
      return stmt.all(collection, value, limit, offset).map((r) => JSON.parse(r.data));
    },

    // Swaps exact strings in every document and session subject, in one
    // transaction (moving a mobile-only account onto a real email,
    // identity.js). Only for values that belong to one person and can't occur
    // by chance, such as a placeholder address or a hash of it. `skip` lists
    // collections that must never be edited (the hash-chained audit trail).
    replaceEverywhere(pairs, { skip = [] } = {}) {
      const touched = new Set();
      let sessions = 0;
      const find = db.prepare('SELECT collection, id, data FROM records WHERE instr(data, ?) > 0');
      const move = db.prepare('UPDATE records SET id = ?, data = ?, ukey = ? WHERE collection = ? AND id = ?');
      const subj = db.prepare('UPDATE sessions SET subject = ? WHERE subject = ?');
      tx(() => {
        for (const [from, to] of pairs) {
          if (!from || from === to) continue;
          for (const r of find.all(from)) {
            if (skip.includes(r.collection)) continue;
            const doc = JSON.parse(r.data.split(from).join(to));
            move.run(r.id.split(from).join(to), JSON.stringify(doc), keyOf(r.collection, doc), r.collection, r.id);
            touched.add(r.collection);
          }
          sessions += Number(subj.run(to, from).changes);
        }
      });
      touched.forEach((c) => changed(c));
      return { collections: [...touched].sort(), sessions };
    },

    // Runs fn inside one transaction (see tx above).
    transaction: (fn) => tx(fn),

    // fn(collection) runs after every write that commits (e.g. to copy it elsewhere).
    onChange: (fn) => listeners.push(fn),

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
