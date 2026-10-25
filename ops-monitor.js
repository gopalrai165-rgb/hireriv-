// Operational monitoring for the platform team: request and error counts per
// hour, the latest application errors and how each background job last ran.
// Kept in memory (it restarts with the server) and never holds request
// bodies, cookies, query strings, ids, emails or file paths: error messages
// are cleaned before they are kept, so the health page can be shown to an
// Operations Admin without exposing customer content.
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

function create({ now = () => Date.now() } = {}) {
  const startedAt = now();
  const hours = new Map();
  const jobs = new Map();
  const errors = [];
  let errorTotal = 0;

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
    res.on('finish', () => {
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
    const route = req && req.route && req.route.path ? `${req.method} ${req.baseUrl || ''}${req.route.path}` : `${(req && req.method) || ''} /${String((req && req.path) || '').split('/')[1] || ''}`;
    errors.unshift({ at: new Date(now()).toISOString(), route: String(route).slice(0, 120), message: cleanMessage(err && err.message) || 'Unknown error' });
    errors.length = Math.min(errors.length, MAX_ERRORS);
  }

  // Wraps a background job so each run is recorded; errors are kept (cleaned)
  // and re-thrown, so the job behaves exactly as before.
  function track(name, fn, everyMs) {
    const j = { name, everyMs: everyMs || null, runs: 0, failures: 0, lastFailed: false, lastRunAt: null, lastOkAt: null, lastError: '', lastErrorAt: null, lastMs: 0 };
    jobs.set(name, j);
    const done = (t0, err) => {
      j.lastMs = now() - t0;
      j.lastFailed = Boolean(err);
      if (err) { j.failures++; j.lastError = cleanMessage(err.message); j.lastErrorAt = new Date(now()).toISOString(); } else j.lastOkAt = new Date(now()).toISOString();
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

  return { middleware, recordError, track, snapshot };
}

module.exports = { create, cleanMessage };
