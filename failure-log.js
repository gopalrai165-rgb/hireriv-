// Failed sign-in counts that survive a restart or deploy (Step 186). Each sign-in
// lock-out (team, employer and job-seeker passwords, team codes by address)
// keeps its recent failure times in the meta table, so restarting the server
// does not hand someone guessing passwords a fresh set of tries. Keys (emails,
// sign-in names, addresses) are stored only as a keyed hash, and times older
// than the window are dropped on every write.
const crypto = require('crypto');

const MAX_KEYS = 5000;

function create(db, name, windowMs) {
  const META = `lockout:${name}`;
  const hash = (key) => crypto.createHash('sha256').update(`${name}|${String(key)}`).digest('hex').slice(0, 32);
  let map = null;
  function load() {
    if (map) return map;
    map = new Map();
    try {
      const saved = JSON.parse(db.metaGet(META) || '{}');
      for (const [k, v] of Object.entries(saved)) if (Array.isArray(v)) map.set(k, v.filter((t) => Number.isFinite(t)));
    } catch (e) { /* a damaged value starts empty */ }
    return map;
  }
  const fresh = (times, now = Date.now()) => (times || []).filter((t) => now - t < windowMs);
  function save() {
    const now = Date.now();
    const out = {};
    for (const [k, v] of map) {
      const keep = fresh(v, now);
      if (keep.length) out[k] = keep; else map.delete(k);
    }
    // Never let a flood of names fill the table: keep the most recent ones.
    const keys = Object.keys(out);
    if (keys.length > MAX_KEYS) {
      keys.sort((a, b) => out[b][out[b].length - 1] - out[a][out[a].length - 1]);
      for (const k of keys.slice(MAX_KEYS)) { delete out[k]; map.delete(k); }
    }
    try { db.metaSet(META, JSON.stringify(out)); } catch (e) { console.error('Saving sign-in failures failed:', e.message); }
  }

  // How many failures in the window.
  const count = (key) => fresh(load().get(hash(key))).length;
  // Notes one more failure and returns the count.
  function note(key) {
    const h = hash(key);
    const list = [...fresh(load().get(h)), Date.now()];
    map.set(h, list);
    save();
    return list.length;
  }
  // A successful sign-in clears the count.
  function clear(key) {
    const h = hash(key);
    if (!load().has(h)) return;
    map.delete(h);
    save();
  }
  return { count, note, clear };
}

module.exports = { create };
