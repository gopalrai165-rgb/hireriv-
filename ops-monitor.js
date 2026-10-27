// Operational monitoring for the platform team: request and error counts per
// hour, the latest application errors and how each background job last ran.
// Kept in memory and saved to the database every minute and on shutdown
// (`persist`), so a restart or deploy doesn't wipe the last 48 hours. Never
// holds request bodies, cookies, query strings, ids, emails or file paths:
// error messages are cleaned before they are kept, so the health page can be
// shown to an Operations Admin without exposing customer content.
//
// With LOG_FORMAT=json every request and error is also written to stdout as
// one JSON line (route pattern, status, time; cleaned messages), for the
// host's log drain or an off-server log store. `heartbeat` pings an outside
// monitor (HEARTBEAT_URL) while the server and its database work, so the
// monitor alerts when the pings stop.
const HOUR = 3600000;
const KEEP_HOURS = 48;
const MAX_ERRORS = 50;

// Strips anything that could identify a person or unlock something.
function cleanMessage(s) {
  return String(s || '')
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '[email]')
    .replace(/https?:\/\/\S+/g, '[link]')
    .replace(/(?:[A-Za-z]:)?(?:[\\/][\w.-]+){2,}/g, '[path]')
    .replace(/\b[a-f0-9]{16,}\b/gi, '[token]')
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, '[token]')
    .replace(/\+?\d[\d\s-]{6,}\d/g, '[number]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

// Stack frames without folders: `fn (server.js:12:3)`, so a log line shows
// where it broke without the server's paths.
const cleanStack = (stack) => String(stack || '').split('\n').filter((l) => /^\s*at /.test(l)).slice(0, 8)
  .map((l) => l.trim().replace(/^at /, '').replace(/(?:[A-Za-z]:)?[^\s()]*[\\/]([^\\/\s()]+:\d+:\d+)/g, '$1'));

// The route pattern (never the real URL), or the first path segment.
const routeOf = (req) => (req && req.route && req.route.path ? `${req.method} ${req.baseUrl || ''}${req.route.path}` : `${(req && req.method) || ''} /${String((req && req.path) || '').split('/')[1] || ''}`).slice(0, 120);

function create({ now = () => Date.now(), logFormat = process.env.LOG_FORMAT, write = (line) => process.stdout.write(`${line}\n`) } = {}) {
  const startedAt = now();
  const hours = new Map();
  const jobs = new Map();
  const errors = [];
  let errorTotal = 0;
  let countingSince = startedAt;
  let saved = null; // job state from before the restart, by name
  let store = null;
  const json = logFormat === 'json';
  const emit = (level, msg, fields) => { if (json) write(JSON.stringify({ time: new Date(now()).toISOString(), level, msg, ...fields })); };

  const bucket = () => {
    const k = Math.floor(now() / HOUR);
    if (!hours.has(k)) {
      hours.set(k, { requests: 0, clientErrors: 0, serverErrors: 0 });
      for (const old of hours.keys()) if (old < k - KEEP_HOURS) hours.delete(old);
    }
    return hours.get(k);
  };

  // Counts every finished response by its status class.
  function middleware(req, res, next) {
    const t0 = now();
    res.on('finish', () => {
      if (json) emit(res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info', 'request', { route: routeOf(req), status: res.statusCode, ms: now() - t0 });
      const b = bucket();
      b.requests++;
      if (res.statusCode >= 500) b.serverErrors++;
      else if (res.statusCode >= 400) b.clientErrors++;
    });
    next();
  }

  // An unhandled error: the route pattern (never the real URL) and a cleaned message.
  function recordError(req, err) {
    errorTotal++;
    const entry = { at: new Date(now()).toISOString(), route: routeOf(req), message: cleanMessage(err && err.message) || 'Unknown error' };
    errors.unshift(entry);
    errors.length = Math.min(errors.length, MAX_ERRORS);
    emit('error', 'unhandled error', { route: entry.route, error: entry.message, stack: cleanStack(err && err.stack) });
  }

  // Wraps a background job so each run is recorded; errors are kept (cleaned)
  // and re-thrown, so the job behaves exactly as before.
  function track(name, fn, everyMs) {
    const j = { name, everyMs: everyMs || null, runs: 0, failures: 0, lastFailed: false, lastRunAt: null, lastOkAt: null, lastError: '', lastErrorAt: null, lastMs: 0 };
    if (saved && saved[name]) restoreJob(j, saved[name]);
    jobs.set(name, j);
    const done = (t0, err) => {
      j.lastMs = now() - t0;
      j.lastFailed = Boolean(err);
      if (err) {
        j.failures++; j.lastError = cleanMessage(err.message); j.lastErrorAt = new Date(now()).toISOString();
        emit('error', 'background job failed', { job: name, error: j.lastError, stack: cleanStack(err.stack) });
      } else j.lastOkAt = new Date(now()).toISOString();
    };
    return (...args) => {
      const t0 = now();
      j.runs++;
      j.lastRunAt = new Date(t0).toISOString();
      let out;
      try {
        out = fn(...args);
      } catch (err) {
        done(t0, err);
        throw err;
      }
      if (out && typeof out.then === 'function') return out.then((v) => { done(t0); return v; }, (err) => { done(t0, err); throw err; });
      done(t0);
      return out;
    };
  }

  function snapshot() {
    const t = now();
    const from = Math.floor(t / HOUR) - 23;
    const day = { requests: 0, clientErrors: 0, serverErrors: 0 };
    const byHour = [];
    for (let k = from; k <= Math.floor(t / HOUR); k++) {
      const b = hours.get(k) || { requests: 0, clientErrors: 0, serverErrors: 0 };
      byHour.push({ hour: new Date(k * HOUR).toISOString(), ...b });
      day.requests += b.requests; day.clientErrors += b.clientErrors; day.serverErrors += b.serverErrors;
    }
    const jobList = [...jobs.values()].map((j) => ({
      ...j,
      // A job that should have run by now (twice its interval since its last run).
      overdue: Boolean(j.everyMs && j.lastRunAt && t - Date.parse(j.lastRunAt) > 2 * j.everyMs),
      failing: j.lastFailed,
    }));
    return {
      startedAt: new Date(startedAt).toISOString(),
      countingSince: new Date(countingSince).toISOString(),
      uptimeSeconds: Math.round((t - startedAt) / 1000),
      requests24h: day.requests,
      clientErrors24h: day.clientErrors,
      serverErrors24h: day.serverErrors,
      serverErrorPercent: day.requests ? Math.round((day.serverErrors / day.requests) * 10000) / 100 : 0,
      // Share of requests answered without a server error.
      availabilityPercent: day.requests ? Math.round(((day.requests - day.serverErrors) / day.requests) * 10000) / 100 : 100,
      byHour,
      errorsSinceStart: errorTotal,
      recentErrors: errors.slice(0, 20),
      jobs: jobList,
    };
  }

  // ---------- saved across restarts ----------
  const JOB_FIELDS = ['runs', 'failures', 'lastFailed', 'lastRunAt', 'lastOkAt', 'lastError', 'lastErrorAt', 'lastMs'];
  function restoreJob(j, s) { for (const k of JOB_FIELDS) if (s[k] !== undefined) j[k] = s[k]; }

  function save() {
    if (!store) return;
    const jobState = {};
    for (const j of jobs.values()) jobState[j.name] = Object.fromEntries(JOB_FIELDS.map((k) => [k, j[k]]));
    // Jobs not registered since the restart keep their saved state.
    for (const [name, s] of Object.entries(saved || {})) if (!jobState[name]) jobState[name] = s;
    store.set(JSON.stringify({ v: 1, countingSince, errorTotal, hours: [...hours], errors, jobs: jobState }));
  }

  // `get`/`set` read and write one saved string (the database's meta table).
  // Loads what an earlier run saved, then saves every minute.
  function persist({ get, set, everyMs = 60000 }) {
    store = { get, set };
    let s = null;
    try { s = JSON.parse(get() || 'null'); } catch (e) { s = null; }
    if (s && s.v === 1) {
      const oldest = Math.floor(now() / HOUR) - KEEP_HOURS;
      for (const [k, b] of s.hours || []) {
        if (k < oldest) continue;
        const cur = hours.get(k);
        hours.set(k, cur ? { requests: cur.requests + b.requests, clientErrors: cur.clientErrors + b.clientErrors, serverErrors: cur.serverErrors + b.serverErrors } : b);
      }
      errors.push(...(s.errors || []));
      errors.sort((a, b) => (a.at < b.at ? 1 : -1));
      errors.length = Math.min(errors.length, MAX_ERRORS);
      errorTotal += s.errorTotal || 0;
      countingSince = Math.min(countingSince, Number(s.countingSince) || countingSince);
      saved = s.jobs || {};
      for (const j of jobs.values()) if (saved[j.name]) restoreJob(j, saved[j.name]);
    }
    if (everyMs) setInterval(() => { try { save(); } catch (e) { /* tried again next minute */ } }, everyMs).unref();
  }

  // Pings `url` when `healthy()` says so. A monitor that stops hearing from
  // the server raises the alarm.
  async function heartbeat(url, healthy, { timeoutMs = 10000 } = {}) {
    if (!healthy()) throw new Error('not pinging: the database is not answering');
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'Hireriv heartbeat' } });
    if (!res.ok) throw new Error(`the monitor answered ${res.status}`);
    return res.status;
  }

  return { middleware, recordError, track, snapshot, persist, save, heartbeat, log: emit };
}

module.exports = { create, cleanMessage, cleanStack };
