// Load test (docs/PERFORMANCE.md). Builds a throwaway database at launch
// size (jobs, applications, candidates, saved jobs), starts the real server
// on it, and sends the busiest pages concurrently for a few seconds each,
// reporting requests per second and response times. data/ is never touched.
//
//   npm run load:test                         defaults below
//   JOBS=10000 APPS=100000 CONCURRENCY=50 SECONDS=15 npm run load:test
//   ONLY=jobs,search npm run load:test        some scenarios only
//   PROFILE=1 ONLY=home npm run load:test     plus the functions using the most CPU
//   LOAD_TEST_OUT=results.json                also write the numbers as JSON
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { startServer } = require('../test/helpers');
const geo = require('../geo');

const N = (k, d) => Math.max(1, Number(process.env[k]) || d);
const JOBS = N('JOBS', 5000);
const APPS = N('APPS', 50000);
const CANDIDATES = N('CANDIDATES', 20000);
const CONCURRENCY = N('CONCURRENCY', 20);
const SECONDS = N('SECONDS', 8);
const PROFILE = process.env.PROFILE === '1';
const ONLY = String(process.env.ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);

// ---------- data ----------
const ROOT = path.join(__dirname, '..');
const starter = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'jobs.json'), 'utf8'));
const cities = Object.keys(geo.CITIES);
const TITLES = ['Delivery Executive', 'Driver', 'Telecaller', 'Data Entry Operator', 'Security Guard', 'Warehouse Associate', 'Retail Sales Associate', 'Electrician', 'Accountant', 'Customer Support Executive', 'Field Sales Executive', 'Machine Operator', 'Cook', 'Receptionist', 'Software Developer'];
const pick = (list, i) => list[i % list.length];
const day = (n) => new Date(Date.now() - n * 86400000).toISOString();

function seed() {
  const jobs = [];
  for (let i = 0; i < JOBS; i++) {
    const base = pick(starter, i);
    jobs.push({ ...base, id: `lt-${i}`, title: `${pick(TITLES, i * 7)}${i % 3 ? '' : ` (${pick(['Night shift', 'Two-wheeler', 'Freshers', 'Hindi'], i)})`}`, location: pick(cities, i * 13), posted: day(i % 60).slice(0, 10), status: 'open', sample: false });
  }
  const candidates = [];
  for (let i = 0; i < CANDIDATES; i++) {
    candidates.push({ id: `cand-${i}`, email: `person${i}@example.in`, createdAt: day(i % 365), profile: { name: `Person ${i}`, phone: `9${String(800000000 + i).padStart(9, '0')}`, city: pick(cities, i), skills: [], experiences: [], education: [], languages: [], certifications: [] }, resumes: [], comms: {}, privacy: {} });
  }
  const applications = [];
  for (let i = 0; i < APPS; i++) {
    // Each person applies to different jobs (no duplicate applications).
    const j = jobs[(i + Math.floor(i / CANDIDATES) * 97) % jobs.length];
    applications.push({ id: crypto.randomUUID(), createdAt: day(i % 180), jobId: j.id, jobTitle: j.title, name: `Person ${i % CANDIDATES}`, email: `person${i % CANDIDATES}@example.in`, phone: '9876543210', location: j.location, status: pick(['New', 'Screening', 'Interview', 'Rejected'], i), notes: '', resume: '', resumeText: '', resumeSkills: [], source: 'site' });
  }
  const saved = [];
  for (let i = 0; i < Math.min(APPS, 20000); i++) saved.push({ id: `sv-${i}`, email: `person${i % CANDIDATES}@example.in`, jobId: jobs[(i * 17) % jobs.length].id, createdAt: day(i % 90) });
  return { jobs, candidates, applications, 'saved-jobs': saved };
}

// ---------- profiling (PROFILE=1) ----------
// The server runs with the inspector on a spare port; each scenario is
// recorded with the CPU profiler and the costliest functions are listed by
// their own time.
async function inspector(srv) {
  const m = srv.output().match(/ws:\/\/\S+/);
  if (!m) throw new Error('inspector address not found');
  const ws = new WebSocket(m[0]);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const waiting = new Map();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (waiting.has(msg.id)) { waiting.get(msg.id)(msg.result); waiting.delete(msg.id); }
  };
  const call = (method, params = {}) => new Promise((resolve) => { waiting.set(++id, resolve); ws.send(JSON.stringify({ id, method, params })); });
  await call('Profiler.enable');
  await call('Profiler.setSamplingInterval', { interval: 500 });
  return { start: () => call('Profiler.start'), stop: async () => (await call('Profiler.stop')).profile, close: () => ws.close() };
}
function topFunctions(profile, n = 12) {
  const self = new Map();
  const deltas = profile.timeDeltas || [];
  const byId = new Map(profile.nodes.map((x) => [x.id, x]));
  const parent = new Map();
  for (const x of profile.nodes) for (const c of x.children || []) parent.set(c, x.id);
  (profile.samples || []).forEach((sid, i) => {
    let node = byId.get(sid);
    if (!node.callFrame.url && /^\(/.test(node.callFrame.functionName)) return; // idle, program, garbage collector
    // Built-ins (SQLite's all, JSON.parse…) count against the app code that called them,
    // …and so does the database layer, so the list names what asked for the data.
    while ((!node.callFrame.url || /[\/]db.js$/.test(node.callFrame.url)) && parent.has(node.id)) node = byId.get(parent.get(node.id));
    const f = node.callFrame;
    const file = f.url.split(/[\\/]/).pop();
    const key = `${f.functionName || '(anonymous)'} ${file}:${f.lineNumber + 1}`;
    self.set(key, (self.get(key) || 0) + (deltas[i] || 0));
  });
  const total = [...self.values()].reduce((a, b) => a + b, 0) || 1;
  return [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([k, v]) => `    ${String(Math.round((v / total) * 100)).padStart(3)}%  ${k}`);
}

// ---------- measuring ----------
const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
async function run(srv, name, makePath, headers = {}) {
  const times = [];
  const codes = {};
  const started = Date.now();
  const end = started + SECONDS * 1000;
  let i = 0;
  const worker = async () => {
    while (Date.now() < end) {
      const url = makePath(i++);
      const t0 = performance.now();
      try {
        const res = await fetch(srv.base + url, { headers, signal: AbortSignal.timeout(60000) });
        await res.arrayBuffer();
        codes[res.status] = (codes[res.status] || 0) + 1;
      } catch (err) {
        codes.failed = (codes.failed || 0) + 1;
      }
      times.push(performance.now() - t0);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  times.sort((a, b) => a - b);
  const took = (Date.now() - started) / 1000;
  return { name, requests: times.length, rps: Math.round(times.length / took), p50: Math.round(pct(times, 50)), p95: Math.round(pct(times, 95)), p99: Math.round(pct(times, 99)), max: Math.round(times[times.length - 1]), codes };
}

async function main() {
  const t0 = Date.now();
  const data = seed();
  console.log(`Seeding ${JOBS} jobs, ${APPS} applications, ${CANDIDATES} candidates, ${data['saved-jobs'].length} saved jobs…`);
  const srv = await startServer({ NODE_ENV: 'test', VIEW_CACHE: '1', ...(PROFILE ? { NODE_OPTIONS: '--inspect=127.0.0.1:0' } : {}) }, data, { startSeconds: 120 });
  console.log(`Server up in ${((Date.now() - t0) / 1000).toFixed(1)} s. ${CONCURRENCY} at a time, ${SECONDS} s per page.\n`);
  // Wait out the start-up work (the trust scan of every job, two seconds
  // after start): a pause, then five quick health checks in a row.
  await new Promise((r) => setTimeout(r, 3000));
  for (let quick = 0, tries = 0; quick < 5 && tries < 600; tries++) {
    const t = performance.now();
    await fetch(`${srv.base}/healthz`);
    quick = performance.now() - t < 30 ? quick + 1 : 0;
    await new Promise((r) => setTimeout(r, quick ? 200 : 500));
  }
  console.log(`Warmed up after ${((Date.now() - t0) / 1000).toFixed(1)} s.\n`);
  const prof = PROFILE ? await inspector(srv) : null;
  const admin = await srv.adminLogin();
  const scenarios = [
    ['home', () => '/'],
    ['jobs', (i) => `/jobs?page=${1 + (i % 5)}`],
    ['search', (i) => `/jobs?q=${encodeURIComponent(pick(['delivery', 'driver', 'telecaller', 'accountant', 'security'], i))}`],
    ['city', (i) => `/jobs?location=${encodeURIComponent(pick(cities, i))}`],
    ['near', (i) => `/jobs?near=${pick(['411001', '400001', '560001', '110001'], i)}&within=25`],
    ['job', (i) => `/jobs/lt-${(i * 97) % JOBS}`],
    ['city-page', (i) => `/jobs/in/${geo.citySlug(pick(['Pune', 'Mumbai', 'Delhi', 'Bengaluru'], i))}`],
    ['suggest', (i) => `/api/suggest?q=${pick(['del', 'dri', 'tel', 'acc', 'sec'], i)}`],
    ['sitemap', () => '/sitemap.xml'],
    ['admin-dashboard', () => '/admin', { cookie: admin }],
    ['admin-applications', (i) => `/admin?tab=applications&page=${1 + (i % 5)}`, { cookie: admin }],
  ].filter(([name]) => !ONLY.length || ONLY.includes(name));
  const results = [];
  try {
    for (const [name, make, headers] of scenarios) {
      if (prof) await prof.start();
      const r = await run(srv, name, make, headers);
      const hot = prof ? topFunctions(await prof.stop()) : [];
      results.push(r);
      const odd = Object.entries(r.codes).filter(([c]) => c !== '200').map(([c, n]) => `${c}×${n}`).join(' ');
      console.log(`${name.padEnd(20)} ${String(r.rps).padStart(6)} req/s   p50 ${String(r.p50).padStart(5)} ms   p95 ${String(r.p95).padStart(5)} ms   p99 ${String(r.p99).padStart(5)} ms${odd ? `   (${odd})` : ''}`);
      if (hot.length) console.log(hot.join('\n'));
    }
  } finally {
    if (prof) prof.close();
    await srv.stop();
  }
  if (process.env.LOAD_TEST_OUT) fs.writeFileSync(process.env.LOAD_TEST_OUT, JSON.stringify({ at: new Date().toISOString(), node: process.version, jobs: JOBS, applications: APPS, candidates: CANDIDATES, concurrency: CONCURRENCY, seconds: SECONDS, results }, null, 2));
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
