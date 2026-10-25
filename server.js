const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { createMailer } = require('./mailer');
const { open: openDb } = require('./db');
const seo = require('./seo');
const { skillMatch, buildPool, searchPool, phoneKey, candidateKey } = require('./match');
const search = require('./search');
const uploadSafety = require('./uploads');
const vault = require('./vault');
const privacyModule = require('./privacy');
const securityModule = require('./security');
const subscriptions = require('./subscriptions');
const billingRoutes = require('./billing-routes');
const paymentGateway = require('./payment-gateway');
const pgMirror = require('./pg');
const { jobSlug, jobPath, findJobBySlug, parsePost, parseSettings, SOCIAL, DEFAULT_JOB_CATEGORIES, DEFAULT_JOB_LOCATIONS, SAMPLE_TESTIMONIALS, MAX_TESTIMONIALS, WORK_KINDS, WORK_KEYS, CATEGORY_WORK, workOf, workOfCategory, RESUME_OPTIONS, resumeNeeded, JOB_GROUPS, inGroup } = require('./content');
const interviews = require('./interviews');
const employers = require('./employers');
const candidates = require('./candidates');
const { SHIFTS, INDIAN_STATES } = require('./candidate-profile');
const employerHiring = require('./employer-hiring');
const employerAts = require('./employer-ats');
const placements = require('./placements');
const teamModule = require('./team');
const agencyRoles = require('./agency-roles');
const bulk = require('./bulk');
const reportsModule = require('./reports');
const timesheetsModule = require('./timesheets');
const history = require('./history');
const resumes = require('./resume-parse');
const jobRecommendations = require('./job-recommendations');
const employerDiscovery = require('./employer-discovery');
const agency = require('./agency');
const workforce = require('./workforce');
const clientPortal = require('./client-portal');
const crm = require('./crm');
const trust = require('./trust');
// Request and error counts and background-job runs for the operations view.
const ops = require('./ops-monitor').create();
// Set once trust & safety is registered; job reports become cases.
const trustHooks = { reportJob: () => null, labelsFor: () => null };
// Set once the CRM is registered; website inquiries and sign-ups become leads.
const leadCapture = { capture: () => null };
const { can: employerCan } = require('./employer-team');
const jobMatch = require('./job-match');
const { interviewIcs } = require('./ics');
const ogImages = require('./og');
const retentionModule = require('./retention');
const backupsModule = require('./backups');
const { paginate } = require('./paginate');
const catalog = require('./catalog');
const notifyModule = require('./notify');
const notifyEvents = require('./notify-events');
const notificationCenter = require('./notification-center');
const pushModule = require('./push');
const pwa = require('./pwa');
const analytics = require('./analytics');

const PORT = process.env.PORT || 3004;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || '';
// Public origin used for canonical URLs, sitemap and structured data.
const BASE_URL = (process.env.SITE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

const DATA_DIR = path.join(__dirname, 'data');
const SUBMISSIONS_DIR = path.join(DATA_DIR, 'submissions');
const UPLOADS_DIR = process.env.UPLOADS_DIR ? path.resolve(process.env.UPLOADS_DIR) : path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ---------- database (SQLite) ----------
// All mutable data lives in one SQLite file. data/*.json are seed content for a
// fresh install, and old data/submissions/*.json files are imported once.
const DB_FILE = process.env.DB_FILE ? path.resolve(process.env.DB_FILE) : path.join(DATA_DIR, 'hireriv.db');
const db = openDb(DB_FILE);
// Conversion counts for the website (no personal data; see site-analytics.js).
const siteAnalytics = require('./site-analytics').create({ db });
const flushAnalytics = ops.track('analytics-flush', () => siteAnalytics.flush(), Number(process.env.ANALYTICS_FLUSH_MS) || 60 * 1000);
setInterval(() => { try { flushAnalytics(); } catch (e) { console.error('Analytics flush failed:', e.message); } }, Number(process.env.ANALYTICS_FLUSH_MS) || 60 * 1000).unref();
const FORM_TYPES = ['applications', 'hire-requests', 'contacts', 'newsletter', 'job-alerts', 'job-reports'];
for (const type of [...FORM_TYPES, 'employers']) {
  const n = db.importOnce(type, path.join(SUBMISSIONS_DIR, `${type}.json`));
  if (n) console.log(`Imported ${n} ${type} from data/submissions/${type}.json`);
}
db.importOnce('jobs', path.join(DATA_DIR, 'jobs.json'));

// One live application per person per job, enforced by the database as well as
// by saveApplication. Withdrawn applications don't count, so people can apply
// again after withdrawing.
const applicationKey = (a) => (a.withdrawnAt || a.duplicateOf ? null : `${a.jobId || 'general'}|${candidateKey(a)}`);
db.uniqueKey('applications', applicationKey);
// Before the rule existed, a person could end up with two live applications
// for one job. Once: keep the one furthest along (the earliest if level) and
// mark the others as duplicates of it, so nothing is lost and the rule can apply.
if (!db.metaGet('upgraded:application-unique-v1')) {
  const list = db.all('applications');
  const rank = { Hired: 5, Offered: 4, Interview: 3, Screening: 2, New: 1, Rejected: 0 };
  const groups = new Map();
  for (const a of list) {
    const k = applicationKey(a);
    if (k) groups.set(k, [...(groups.get(k) || []), a]);
  }
  let marked = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((x, y) => (rank[y.status] ?? 1) - (rank[x.status] ?? 1) || String(x.createdAt).localeCompare(String(y.createdAt)));
    for (const dup of group.slice(1)) { dup.duplicateOf = group[0].id; marked++; }
  }
  db.replaceAll('applications', list);
  if (marked) console.log(`Marked ${marked} duplicate application${marked === 1 ? '' : 's'} (kept the furthest along for each person and job)`);
  db.metaSet('upgraded:application-unique-v1', new Date().toISOString());
}

// Resume uploads: real PDF/Word files only, scanned when CLAMAV_HOST is set.
const resumeCheck = uploadSafety.create();
// Resume downloads go through signed links that expire after 15 minutes.
if (!db.metaGet('secret:links')) db.metaSet('secret:links', crypto.randomBytes(32).toString('hex'));
const downloadLinks = uploadSafety.links(() => db.metaGet('secret:links'));
// Uploaded documents are encrypted at rest (vault.js). The key should come
// from FILE_ENCRYPTION_KEY (kept outside the database and its backups); without
// it a key is created once and kept in the database. Keys replaced in a
// rotation go in FILE_ENCRYPTION_KEYS_OLD until the daily sweep has re-sealed every file.
{
  const old = String(process.env.FILE_ENCRYPTION_KEYS_OLD || '').split(',').map((k) => k.trim()).filter(Boolean);
  const stored = db.metaGet('secret:files');
  if (process.env.FILE_ENCRYPTION_KEY) vault.configure([process.env.FILE_ENCRYPTION_KEY, ...old, ...(stored ? [stored] : [])]);
  else {
    if (!stored) db.metaSet('secret:files', vault.newKey());
    if (process.env.NODE_ENV === 'production') console.warn('FILE_ENCRYPTION_KEY is not set: uploaded files are encrypted with a key kept in the database. Set FILE_ENCRYPTION_KEY to keep the key apart from the data.');
    vault.configure([db.metaGet('secret:files'), ...old]);
  }
}
const sealUploads = ops.track('encrypt-uploads', () => vault.sweep(UPLOADS_DIR), 24 * 60 * 60 * 1000);
setTimeout(sealUploads, Number(process.env.UPLOAD_SEAL_DELAY_MS) || 5000).unref();
setInterval(sealUploads, 24 * 60 * 60 * 1000).unref();
db.importOnce('posts', path.join(DATA_DIR, 'posts.json'));
db.importOnce('site', path.join(DATA_DIR, 'site.json'));

const site = db.all('site')[0];
const saveSite = () => db.replaceAll('site', [site]);

// One-time: sites that saved their own category list in Settings get the new
// skilled, industrial and service categories added once. Removing them again
// in Settings sticks, because this never runs twice.
if (!db.metaGet('upgraded:categories-v2')) {
  if (Array.isArray(site.jobCategories)) {
    const have = new Set(site.jobCategories.map((c) => c.toLowerCase()));
    const added = Object.keys(CATEGORY_WORK).filter((c) => !have.has(c.toLowerCase()));
    if (added.length) {
      site.jobCategories = [...site.jobCategories, ...added].slice(0, 50);
      saveSite();
    }
  }
  db.metaSet('upgraded:categories-v2', new Date().toISOString());
}
const mailer = createMailer(site);

// ---------- notifications ----------
// One service for in-app notifications and email delivery (notify.js); which
// events notify whom lives in notify-events.js. Its lookups run when an event
// happens, so the modules registered further down are ready by then.
const notify = notifyModule.create({ db });
// Phone notifications (push.js): new in-app notifications also go to the
// devices people turned them on for, in the areas they chose.
const push = pushModule.create({ db, siteUrl: process.env.SITE_URL || '' });
notify.onNotification((n) => push.deliver(n, notify.pushAllowed));
const events = notifyEvents.create({
  notify, mailer, site, baseUrl: BASE_URL, db, readSubmissions: (t) => db.all(t), getJobs: () => jobs, formatIst: interviews.formatIst, interviewIcs, jobPath,
  appOwner: (a) => appOwner(a), team: { byId: (id) => team.byId(id), members: () => team.members() }, clients: () => clients,
  hasAccount: (email) => db.all('candidates').some((c) => c.email === String(email).toLowerCase()),
});
// Every stage move, from any screen, goes through history.moveStage.
history.onMove((a, entry) => events.stageMoved(a, entry));

// Posts are edited from /admin. The array is mutated in place so every route
// keeps seeing the same list; savePosts() writes it back to the database.
const posts = db.all('posts').map((p) => ({ status: 'published', ...p }));
const sortPosts = () => posts.sort((a, b) => b.date.localeCompare(a.date));
sortPosts();
function savePosts() {
  sortPosts();
  db.replaceAll('posts', posts);
}
const livePosts = () => posts.filter((p) => p.status === 'published');

// One-time upgrade of the starter articles to their fuller versions. A post is
// only replaced while its text is still exactly the original seed, so anything
// edited in Admin → Blog is left alone.
if (!db.metaGet('upgraded:posts-v2')) {
  const ORIGINAL_SEED = {
    'six-stage-screening': '39bcf9d05f00887900ae02f6c44705869feab02c',
    'resume-tips-2026': '23b24525e896a2fa0a1cb2a0a55c72c4b16fcdb3',
    'contract-vs-permanent': '98a0d1008d850fae077e9dd8340770a4ca64e0fb',
  };
  const seed = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'posts.json'), 'utf8'));
  const bodyHash = (body) => crypto.createHash('sha1').update(JSON.stringify(body)).digest('hex');
  let upgraded = 0;
  for (const p of posts) {
    const fresh = seed.find((s) => s.slug === p.slug);
    if (fresh && ORIGINAL_SEED[p.slug] === bodyHash(p.body)) {
      p.body = fresh.body;
      upgraded++;
    }
  }
  if (upgraded) savePosts();
  db.metaSet('upgraded:posts-v2', new Date().toISOString());
}

// ---------- jobs (editable from /admin) ----------
let jobs = db.all('jobs').map((j) => ({ status: 'open', ...j }));

// The starter jobs in data/jobs.json are examples, not real vacancies. They are
// labelled "Sample listing", take no applications, send no job alerts and stay
// out of Google and the sitemap. Editing one makes it a real job. Marked once:
// a job counts as a sample while it still matches its starter text exactly.
if (!db.metaGet('upgraded:sample-jobs')) {
  const seed = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'jobs.json'), 'utf8'));
  let marked = 0;
  for (const j of jobs) {
    const s = seed.find((x) => x.id === j.id);
    if (j.sample === undefined && s && s.title === j.title && s.company === j.company && s.description === j.description) {
      j.sample = true;
      marked++;
    }
  }
  if (marked) db.replaceAll('jobs', jobs);
  db.metaSet('upgraded:sample-jobs', new Date().toISOString());
}
const isSample = (j) => j.sample === true;

// Pay is kept as numbers ({ min, max, period, currency }) so jobs can be
// filtered and sorted by pay. Older jobs only had salary text: read the numbers
// out of it once. The text stays as shown; editing the job rebuilds it.
if (!db.metaGet('upgraded:pay-v1')) {
  let n = 0;
  for (const j of jobs) {
    if (j.pay !== undefined) continue;
    j.pay = search.payFromText(j.salary);
    const extra = String(j.salary || '').match(/\+\s*(.+)$/);
    j.payNote = j.pay ? (extra ? `+ ${extra[1].trim()}` : '') : String(j.salary || '');
    n++;
  }
  if (n) db.replaceAll('jobs', jobs);
  db.metaSet('upgraded:pay-v1', new Date().toISOString());
}
// What job cards and pages show: the pay from its numbers, plus any note.
const salaryText = (pay, note) => [search.payText(pay), note].filter(Boolean).join(' ');
// Jobs that were live before job alerts existed count as already announced.
for (const j of jobs) if (j.status === 'open' && !j.alertsSentAt) j.alertsSentAt = j.posted;
const sortJobs = () => jobs.sort((a, b) => b.posted.localeCompare(a.posted));
sortJobs();

function saveJobs() {
  sortJobs();
  db.replaceAll('jobs', jobs);
}

// Open, and not past its closing date (the hourly check closes it for good).
const isLive = (j) => j.status === 'open' && !(j.closesOn && j.closesOn < todayIst());
// Employer drafts, jobs waiting for the team's review, rejected and paused ones are never public.
const UNPUBLISHED = ['draft', 'pending', 'rejected', 'paused'];
const isPublicJob = (j) => !UNPUBLISHED.includes(j.status);
const openJobs = () => jobs.filter(isLive);
const todayIst = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
// Open jobs with no closing date are flagged in admin after this many days.
const STALE_JOB_DAYS = 60;
const jobAgeDays = (j) => Math.floor((Date.parse(todayIst()) - Date.parse(j.posted)) / 86400000);
const isStaleJob = (j) => j.status === 'open' && !j.closesOn && jobAgeDays(j) >= STALE_JOB_DAYS;

// A job's closing date is the last day to apply (India time). After it, the job
// closes by itself: it leaves the listings and the sitemap and stops taking applications.
function closeExpiredJobs() {
  const today = todayIst();
  const expired = jobs.filter((j) => j.status === 'open' && j.closesOn && j.closesOn < today);
  for (const j of expired) Object.assign(j, { status: 'closed', closedAt: new Date().toISOString(), closedReason: 'Closing date passed' });
  if (expired.length) saveJobs();
  for (const j of expired) events.jobExpired(j);
  return expired.length;
}
setImmediate(closeExpiredJobs);
setInterval(ops.track('close-expired-jobs', closeExpiredJobs, 60 * 60 * 1000), 60 * 60 * 1000).unref();
const categoriesOf = (list) => [...new Set(list.map((j) => j.category))];
// The category list from Settings, plus any older category a job still uses.
const jobCategories = () => [...new Set([...(site.jobCategories || DEFAULT_JOB_CATEGORIES), ...categoriesOf(jobs)])];
// Categories split by kind of work, for grouped dropdowns.
const groupCategories = (list) => WORK_KINDS.map((c) => ({ ...c, categories: list.filter((cat) => workOfCategory(cat) === c.key) })).filter((g) => g.categories.length);
const locationsOf = (list) => [...new Set(list.map((j) => j.location))].sort();
// The location list from Settings plus any a job still uses, A–Z with Remote first.
const jobLocations = () =>
  [...new Set([...(site.jobLocations || DEFAULT_JOB_LOCATIONS), ...locationsOf(jobs)])]
    .sort((a, b) => (a === 'Remote' ? -1 : b === 'Remote' ? 1 : a.localeCompare(b)));
// Remote jobs match every city in job alerts and are marked TELECOMMUTE for Google.
const modes = ['On-site', 'Hybrid', 'Remote', 'Field work', 'Client site'];
const JOB_TYPES = ['Full-time', 'Part-time', 'Contract', 'Temporary', 'Daily wage / Gig', 'Apprenticeship', 'Internship'];

// Application pipeline stages a recruiter moves a candidate through.
// Hiring stages (ats.js): the pipeline, then On hold and Rejected. Withdrawn is kept apart (withdrawnAt).
const APP_STATUSES = require('./ats').STAGES;

// ---------- submissions (one collection per form type, newest first) ----------
const readSubmissions = (type) => db.all(type);
const writeSubmissions = (type, list) => db.replaceAll(type, list);
// Consent records, data requests and the retention policy (privacy.js). The
// erasure journal sits next to the database file, outside it and its backups.
const privacy = privacyModule.create({ db, notify, readSubmissions, writeSubmissions, saveSubmission, journalFile: path.join(path.dirname(DB_FILE), 'erasures.log') });

// ---------- PostgreSQL copy of the jobs data (only with DATABASE_URL) ----------
// Jobs, their places, categories and skills, applications and saved jobs are
// copied to Postgres moments after each save, and /api/jobs searches there.
// Candidates appear only as a keyed hash, never by name, email or phone.
if (!db.metaGet('secret:pg-hash')) db.metaSet('secret:pg-hash', crypto.randomBytes(32).toString('hex'));
const PG_HASH_SECRET = db.metaGet('secret:pg-hash');
const pg = process.env.DATABASE_URL
  ? pgMirror.create({
    url: process.env.DATABASE_URL,
    schema: process.env.PG_SCHEMA || '',
    source: () => ({ jobs, applications: readSubmissions('applications'), savedJobs: readSubmissions('saved-jobs'), categories: jobCategories() }),
    describe: {
      workOf, workOfCategory, slugOf: jobSlug, stateOf: search.stateOf, monthlyMax: search.monthlyMax, experienceRange: search.experienceRange,
      quickApply: (j) => !resumeNeeded(j), groupKeys: (j) => JOB_GROUPS.filter((g) => inGroup(g, j)).map((g) => g.key),
    },
    candidateHash: (r) => crypto.createHmac('sha256', PG_HASH_SECRET).update(candidateKey(r)).digest('hex'),
    levels: search.EXPERIENCE_LEVELS,
    words: search.words,
    log: (m) => console.log(m),
  })
  : null;
if (pg) {
  db.onChange((collection) => { if (['jobs', 'applications', 'saved-jobs', 'site'].includes(collection)) pg.changed(); });
  pg.start().catch((err) => console.error(`Postgres unavailable (the site keeps working from SQLite): ${err.message}`));
}

function saveSubmission(type, record) {
  const entry = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), ...record };
  db.prepend(type, entry);
  return entry;
}

// ---------- validation helpers ----------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^[+\d][\d\s-]{7,16}$/;

function clean(body, fields) {
  const out = {};
  for (const f of fields) out[f] = String(body[f] ?? '').trim().slice(0, 2000);
  return out;
}

function validate(data, required) {
  const errors = [];
  for (const f of required) if (!data[f]) errors.push(`${f} is required`);
  if (data.email && !EMAIL_RE.test(data.email)) errors.push('email is invalid');
  if (data.phone && !PHONE_RE.test(data.phone)) errors.push('phone is invalid');
  return errors;
}

// Forms are enhanced with fetch (JSON response) but still work as plain HTML posts.
function respond(req, res, errors, message) {
  const wantsJson = (req.get('Accept') || '').includes('application/json');
  if (errors.length) {
    if (wantsJson) return res.status(400).json({ ok: false, errors });
    return res.status(400).render('thanks', { title: 'Please check your details', page: '', ok: false, message: errors.join(', '), noindex: true });
  }
  if (wantsJson) return res.json({ ok: true, message });
  return res.render('thanks', { title: 'Thank you', page: '', ok: true, message, noindex: true });
}

// ---------- spam protection ----------
// Hidden "website" field: people never see it, form-filling bots do. Bots get a
// normal success reply so they have no signal to adapt to, but nothing is kept.
const isBot = (body) => Boolean(body && String(body.website || '').trim());

// Small in-memory sliding-window limiter, keyed by bucket + client IP.
const hits = new Map();
function overLimit(key, max, windowMs) {
  const now = Date.now();
  const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
  recent.push(now);
  hits.set(key, recent);
  return recent.length > max;
}
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [key, times] of hits) if (times[times.length - 1] < cutoff) hits.delete(key);
}, 10 * 60 * 1000).unref();

function limit(bucket, max, windowMs = 10 * 60 * 1000) {
  return (req, res, next) => {
    if (!overLimit(`${bucket}:${req.ip}`, max, windowMs)) return next();
    const message = 'Too many submissions from your connection. Please wait a few minutes and try again.';
    if ((req.get('Accept') || '').includes('application/json')) return res.status(429).json({ ok: false, errors: [message] });
    res.status(429).render('thanks', { title: 'Please slow down', page: '', ok: false, message, noindex: true });
  };
}

// ---------- uploads ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (req, file, cb) =>
      cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['.pdf', '.doc', '.docx'].includes(path.extname(file.originalname).toLowerCase());
    cb(ok ? null : new Error('Resume must be a PDF, DOC or DOCX file'), ok);
  },
});

// ---------- app ----------
const app = express();
// Security log and alerts (security.js): failed sign-ins, refused requests,
// document downloads and exports, privileged changes.
const security = securityModule.create({ db, notify, mailer, getTeam: () => team });
app.use(security.observe);
// Unread notification counts for the header bells (notification-center.js).
app.use((req, res, next) => center.locals(req, res, next));
// Lets the header show "My account" and the page script keep saved jobs in the account.
app.use((req, res, next) => {
  res.locals.candidateSignedIn = /(?:^|;\s*)hr_cand=/.test(req.headers.cookie || '') && Boolean(candidateAccounts.currentEmail(req));
  next();
});
// Behind a reverse proxy (Nginx, Render, etc.) set TRUST_PROXY=1 so req.ip is the visitor, not the proxy.
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.disable('x-powered-by');
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
// Webhook signatures (email and payments) cover the exact bytes sent, so keep them.
app.use(express.json({ limit: '100kb', verify: (req, res, buf) => { if (req.url.startsWith('/webhooks/') || req.url.startsWith('/api/webhooks/')) req.rawBody = Buffer.from(buf); } }));
// Security headers. The CSP only allows our own scripts (no inline JS), Google
// Fonts for type, and never lets another site frame these pages.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
].join('; ');
const HTTPS = /^https:/.test(BASE_URL);
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  });
  if (HTTPS) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

// Health check for hosts and uptime monitors: confirms the database answers.
app.use(ops.middleware);
app.get('/healthz', (req, res) => {
  try {
    db.count('jobs');
    res.set('Cache-Control', 'no-store').json({ ok: true, uptime: Math.round(process.uptime()) });
  } catch (err) {
    res.status(503).json({ ok: false });
  }
});

// Light pages for slow connections: browsers asking to save data (Save-Data)
// skip the web font and use the system font instead.
app.use((req, res, next) => {
  res.locals.saveData = /^on$/i.test(String(req.get('Save-Data') || ''));
  if (req.method === 'GET') res.vary('Save-Data');
  next();
});
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
  // App icons change rarely; a new version gets a new file name.
  setHeaders: (res, file) => { if (file.includes(`${path.sep}icons${path.sep}`)) res.set('Cache-Control', 'public, max-age=604800'); },
}));

app.locals.site = site;
app.locals.catalog = catalog;
app.locals.workOf = workOf;
app.locals.isSample = (j) => j.sample === true;
app.locals.jobPath = jobPath;
app.locals.matchWeights = jobMatch.weightsOf;
app.locals.matchFactors = jobMatch.FACTORS;
app.locals.matchDefaults = jobMatch.DEFAULT_WEIGHTS;
// Resume links in pages are signed and expire, so a copied link stops working.
app.locals.signedLink = (url) => downloadLinks.signed(url);
// Chat link for a candidate's mobile number (10-digit Indian numbers get +91).
app.locals.waLink = (phone) => {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 10) d = `91${d}`;
  return d.length >= 10 ? `https://wa.me/${d}` : '';
};
app.locals.workLabel = (key) => (WORK_KINDS.find((c) => c.key === key) || WORK_KINDS[0]).label;
// The homepage shows these until real testimonials are saved in Settings.
app.locals.testimonialsFor = (s) => (Array.isArray(s.testimonials) ? s.testimonials : SAMPLE_TESTIMONIALS);
app.locals.maxTestimonials = MAX_TESTIMONIALS;
app.locals.formatIst = interviews.formatIst;
// The pill colour for a hiring stage ("On hold" → st-on-hold).
app.locals.stageClass = (s) => `st-${String(s || 'New').toLowerCase().replace(/\s+/g, '-')}`;
app.locals.stageLabel = require('./ats').label;
app.locals.feedbackSummary = interviews.feedbackSummary;
// Fingerprint the CSS/JS so browsers fetch fresh copies after every change,
// despite the 1-hour static cache.
app.locals.assetVersion = crypto
  .createHash('sha1')
  .update(['public/css/style.css', 'public/js/main.js'].map((f) => fs.readFileSync(path.join(__dirname, f))).join(''))
  .digest('hex')
  .slice(0, 10);
app.locals.formatDate = (d) =>
  new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
// "Closes in 3 days" on job cards during a job's last week.
app.locals.closingSoon = (job) => {
  if (job.status !== 'open' || !job.closesOn) return '';
  const left = Math.round((Date.parse(job.closesOn) - Date.parse(todayIst())) / 86400000);
  return left > 7 || left < 0 ? '' : left === 0 ? 'Last day today' : left === 1 ? 'Closes tomorrow' : `Closes in ${left} days`;
};
app.locals.daysAgo = (d) => {
  const days = Math.floor((Date.now() - new Date(d)) / 86400000);
  return days <= 0 ? 'Today' : days === 1 ? '1 day ago' : `${days} days ago`;
};

// Per-page SEO defaults; routes override these through render locals.
app.use((req, res, next) => {
  closeExpiredJobs();
  Object.assign(res.locals, {
    canonical: BASE_URL + req.path,
    // Signed-in areas skip the public-site extras (newsletter band, WhatsApp button).
    workspace: /^\/(admin|employer|account|feedback|notifications)(\/|$)/.test(req.path),
    ogImage: `${BASE_URL}/og/site.png?v=${og.siteVersion(site)}`,
    ogImageAlt: `${site.name}: ${site.tagline}`,
    metaDescription: `${site.name} – ${site.tagline}. Permanent, contract and executive staffing across Technology, Finance, BFSI, Sales, Marketing, Healthcare, Manufacturing, Logistics and more.`,
    jsonLd: null,
    noindex: req.path.startsWith('/admin'),
    toJsonLd: seo.toJsonLd,
  });
  next();
});

// Share preview images for WhatsApp, LinkedIn, Facebook and X.
const og = ogImages.create({ baseUrl: BASE_URL });
const sendPng = (res) => (png) => res.type('image/png').set('Cache-Control', 'public, max-age=604800').send(png);
app.get('/og/site.png', (req, res, next) => og.site(site).then(sendPng(res), next));
app.get('/og/jobs/:id.png', (req, res, next) => {
  const job = jobs.find((j) => j.id === req.params.id && isPublicJob(j));
  if (!job) return next();
  og.job(job, site).then(sendPng(res), next);
});

// The installable app: manifest, service worker and offline page (pwa.js).
pwa.register(app, { site, assetVersion: () => app.locals.assetVersion, analytics: siteAnalytics, push, sameOrigin });

app.get('/robots.txt', (req, res) =>
  res.type('text/plain').send(`User-agent: *
Disallow: /admin
Disallow: /api/
Disallow: /account
Disallow: /candidate
Disallow: /employer
Disallow: /client
Disallow: /crm/
Disallow: /feedback
Disallow: /notifications
Disallow: /saved
Disallow: /staffing
Disallow: /worker
Disallow: /job-alerts/
Disallow: /appeal/
Disallow: /healthz

Sitemap: ${BASE_URL}/sitemap.xml
`)
);

app.get('/sitemap.xml', (req, res) =>
  res.type('application/xml').send(seo.sitemap(BASE_URL, { jobs: openJobs().filter((j) => !isSample(j)), posts: livePosts(), staticPaths: ['/', '/jobs', ...catalog.WORK_PAGES.map((x) => `/jobs/${x.slug}`), ...catalog.JOB_INDUSTRIES.map((x) => `/jobs/industry/${x.slug}`), '/categories', '/hire', '/services', ...catalog.SERVICES.map((x) => `/services/${x.slug}`), '/industries', ...catalog.INDUSTRIES.map((x) => `/industries/${x.slug}`), '/about', '/blog', '/contact', '/privacy', '/terms', '/job-posting-policy'] }))
);

// Things a new install still needs before it is ready for visitors, shown to
// Admins on the dashboard until they are done.
function setupTodo() {
  const todo = [];
  const settings = '/admin?tab=settings';
  const backupProblem = backups.warning();
  if (backupProblem) todo.push({ text: backupProblem, href: '/admin?tab=settings#backups' });
  if (/0{5}/.test(site.phone) || /^\d{2}0+$/.test(site.whatsapp)) todo.push({ text: 'Add your real phone and WhatsApp numbers', href: settings });
  if (!site.address || /^your office address/i.test(site.address)) todo.push({ text: 'Add your office address', href: settings });
  if (!Object.values(site.social || {}).some((u) => /^https?:\/\//.test(u))) todo.push({ text: 'Add your LinkedIn or other social links (icons stay hidden until you do)', href: settings });
  const b = site.billing || {};
  if (!Array.isArray(site.testimonials)) todo.push({ text: 'Replace the sample testimonials on the homepage with real ones (or hide them)', href: '/admin?tab=settings#testimonials' });
  if (!b.legalName || !b.gstin || !b.bank) todo.push({ text: 'Add your legal name, GSTIN and bank details for invoices', href: settings });
  if (!process.env.SMTP_HOST) todo.push({ text: 'Set up email sending (SMTP_HOST). Until then emails are only saved to data/outbox' });
  if (process.env.NODE_ENV === 'production' && !process.env.SITE_URL) todo.push({ text: 'Set SITE_URL to your live https:// address' });
  for (const problem of notify.problems()) todo.push({ text: `Email delivery: ${problem}`, href: '/admin/notifications' });
  const waitingJobs = jobs.filter((j) => j.status === 'pending').length;
  if (waitingJobs) todo.push({ text: `${waitingJobs} employer job${waitingJobs === 1 ? ' is' : 's are'} waiting for your review`, href: '/admin?tab=jobs' });
  const waitingClients = clients.read().filter((c) => c.active && c.selfSignup && c.emailVerifiedAt && !c.approvedAt).length;
  if (waitingClients) todo.push({ text: `${waitingClients} new employer${waitingClients === 1 ? '' : 's'} signed up and ${waitingClients === 1 ? 'needs' : 'need'} approving`, href: '/admin?tab=clients' });
  const samples = jobs.filter(isSample).length;
  if (samples) todo.push({ text: `Replace the ${samples} sample job${samples === 1 ? '' : 's'} with real openings: edit one to make it real, or delete it`, href: '/admin?tab=jobs' });
  if (!team.requires2fa()) todo.push({ text: 'Protect team sign-ins: turn on two-step sign-in for yourself, then require it for the team', href: '/admin/security' });
  return todo;
}

// ---------- pages ----------
app.get('/', (req, res) => {
  // Opened from the home-screen icon (the manifest's start_url).
  if (req.query.source === 'pwa') siteAnalytics.track('app-launch', /Mobi|Android|iPhone|iPad/.test(req.get('User-Agent') || '') ? 'Phone or tablet' : 'Computer', req);
  const live = openJobs();
  // Real openings first; sample listings only fill the gaps on a new site.
  const featured = [...live.filter((j) => !isSample(j)), ...live.filter(isSample)].slice(0, 6);
  res.render('index', {
    title: 'Find Jobs & Hire Staff Across India', page: 'home', jobs: featured, posts: livePosts().slice(0, 3), locations: jobLocations(),
    categoryGroups: groupCategories(jobCategories()), groups: groupCounts(live), jsonLd: seo.homePage(site, BASE_URL),
  });
});

const groupCounts = (list) => JOB_GROUPS.map((g) => ({ ...g, count: list.filter((j) => inGroup(g, j)).length }));

// Job Categories: the category groups, then every category by kind of work.
app.get('/categories', (req, res) => {
  const live = openJobs();
  res.render('categories', {
    title: 'Job Categories', page: 'categories', groups: groupCounts(live), categoryGroups: groupCategories(jobCategories()),
    categoryCounts: live.reduce((n, j) => ({ ...n, [j.category]: (n[j.category] || 0) + 1 }), {}),
    metaDescription: `Browse jobs by category on ${site.name}: office, IT, finance and sales roles, and skilled, factory, delivery, healthcare, construction, retail and hospitality work across India.`,
  });
});
app.get('/staffing-solutions', (req, res) => res.redirect(301, '/services'));

const JOBS_PAGE_SIZE = 20;
// Search filters from a query string, shared by Find Jobs and /api/jobs. Bad
// values are dropped and listed in `errors`: the page ignores them, the API
// refuses the request. The API's names (keyword, city, employmentType…) work too.
const EMPLOYMENT_KEYS = { full_time: 'Full-time', part_time: 'Part-time', contract: 'Contract', temporary: 'Temporary', gig: 'Daily wage / Gig', apprenticeship: 'Apprenticeship', internship: 'Internship' };
const ARRANGEMENT_KEYS = { on_site: 'On-site', hybrid: 'Hybrid', remote: 'Remote', field: 'Field work', client_site: 'Client site' };
function jobFilters(query) {
  const errors = [];
  const one = (...keys) => {
    for (const k of keys) {
      const v = Array.isArray(query[k]) ? query[k][0] : query[k];
      if (v !== undefined && String(v).trim() !== '') return { key: k, value: String(v).trim().slice(0, 100) };
    }
    return { key: keys[0], value: '' };
  };
  const pick = (keys, ok, map = {}) => {
    const { key, value } = one(...keys);
    const v = map[value] || value;
    if (!v) return '';
    if (ok(v)) return v;
    errors.push(`${key} is invalid`);
    return '';
  };
  const cities = jobLocations();
  const f = {
    q: one('q', 'keyword').value,
    location: pick(['location', 'city', 'state'], (v) => v === 'Remote' || cities.includes(v) || search.statesOf(cities).includes(v)),
    categories: [],
    type: pick(['type', 'employmentType'], (v) => JOB_TYPES.includes(v), EMPLOYMENT_KEYS),
    mode: pick(['mode', 'workArrangement'], (v) => modes.includes(v), ARRANGEMENT_KEYS),
    work: pick(['work'], (v) => WORK_KEYS.includes(v)),
    group: pick(['group'], (v) => JOB_GROUPS.some((g) => g.key === v)),
    experience: pick(['experience'], (v) => search.EXPERIENCE_LEVELS.some((l) => l.key === v)),
    minPay: 0,
    skills: [],
    company: one('company').value,
    shift: pick(['shift'], (v) => SHIFTS.includes(v)),
    sort: pick(['sort'], (v) => search.SORTS.includes(v)),
  };
  // Skills: repeated (?skill=Forklift&skill=Excel) or comma-separated (?skills=Forklift, Excel).
  const skillList = [].concat(query.skill ?? [], String([].concat(query.skills ?? []).join(',')).split(',')).map((x) => String(x).trim()).filter(Boolean);
  for (const sk of skillList) {
    if (sk.length > 40) { errors.push('each skill must be 40 characters or fewer'); continue; }
    if (!f.skills.some((x) => x.toLowerCase() === sk.toLowerCase())) f.skills.push(sk);
  }
  if (f.skills.length > MAX_SKILL_FILTERS) { errors.push(`choose up to ${MAX_SKILL_FILTERS} skills`); f.skills = f.skills.slice(0, MAX_SKILL_FILTERS); }
  const known = jobCategories();
  for (const c of [].concat(query.category ?? [], query.categories ?? []).map(String).filter(Boolean).slice(0, 20)) {
    if (known.includes(c)) { if (!f.categories.includes(c)) f.categories.push(c); } else errors.push('category is invalid');
  }
  const pay = one('minPay').value;
  if (pay) {
    if (/^\d{1,8}$/.test(pay) && Number(pay) > 0) f.minPay = Number(pay);
    else errors.push('minPay is invalid');
  }
  return { filters: f, errors: [...new Set(errors)] };
}
const MAX_SKILL_FILTERS = 5;
// The search itself: live jobs, these filters, the category group and kind of
// work on top. `skipWork` gives the counts for the kind-of-work tabs.
function findJobs(list, f, { skipWork = false } = {}) {
  const group = JOB_GROUPS.find((g) => g.key === f.group);
  return search.searchJobs(list, f, { extra: (j) => (!group || inGroup(group, j)) && (skipWork || !f.work || workOf(j) === f.work) });
}
// Keywords with a typing slip and no results get one more try with the
// closest words from the live jobs ("devloper" → "developer").
function correctedFilters(list, f) {
  const better = f.q ? search.suggest(f.q, search.vocabulary(list)) : '';
  return better ? { ...f, q: better } : null;
}
// The filters as query parameters (repeated for several categories and skills).
const filterQuery = (f) => ({ q: f.q, group: f.group, work: f.work, category: f.categories, location: f.location, mode: f.mode, type: f.type, experience: f.experience, minPay: f.minPay || '', skill: f.skills || [], company: f.company || '', shift: f.shift || '', sort: f.sort });
const hasFilters = (f) => Boolean(f.q || f.group || f.work || f.categories.length || f.location || f.mode || f.type || f.experience || f.minPay || (f.skills || []).length || f.company || f.shift);

app.get('/jobs', (req, res) => {
  const live = openJobs();
  let { filters: f } = jobFilters(req.query);
  const group = JOB_GROUPS.find((g) => g.key === f.group) || null;
  let found = findJobs(live, f);
  let corrected = null;
  if (!found.jobs.length) {
    const better = correctedFilters(live, f);
    const retry = better && findJobs(live, better);
    if (retry && retry.jobs.length) { corrected = { from: f.q, to: better.q }; f = better; found = retry; }
  }
  // Kind-of-work counts follow the other filters, so each tab says what it would show.
  const workCounts = findJobs(live, f, { skipWork: true }).jobs.reduce((n, j) => ({ ...n, [workOf(j)]: (n[workOf(j)] || 0) + 1 }), {});
  const { rows, pager } = paginate(found.jobs, { page: req.query.page, size: JOBS_PAGE_SIZE, query: filterQuery(f), path: '/jobs' });
  // Each active filter, with the link that removes it, for the "no results" help.
  const removeLink = (patch) => paginate([], { size: 1, query: { ...filterQuery(f), ...patch }, path: '/jobs' }).pager.urlFor(1);
  const payLabel = (n) => `₹${n.toLocaleString('en-IN')}+ a month`;
  const active = [
    f.q && { label: `“${f.q}”`, href: removeLink({ q: '' }) },
    group && { label: group.label, href: removeLink({ group: '' }) },
    f.work && { label: WORK_KINDS.find((w) => w.key === f.work).label, href: removeLink({ work: '' }) },
    ...f.categories.map((c) => ({ label: c, href: removeLink({ category: f.categories.filter((x) => x !== c) }) })),
    f.location && { label: f.location, href: removeLink({ location: '' }) },
    f.mode && { label: f.mode, href: removeLink({ mode: '' }) },
    f.type && { label: f.type, href: removeLink({ type: '' }) },
    f.experience && { label: search.EXPERIENCE_LEVELS.find((l) => l.key === f.experience).label, href: removeLink({ experience: '' }) },
    f.minPay && { label: payLabel(f.minPay), href: removeLink({ minPay: '' }) },
    ...f.skills.map((sk) => ({ label: sk, href: removeLink({ skill: f.skills.filter((x) => x !== sk) }) })),
    f.company && { label: f.company, href: removeLink({ company: '' }) },
    f.shift && { label: `${f.shift} shift`, href: removeLink({ shift: '' }) },
  ].filter(Boolean);
  // Signed-in candidates can save this search and get alerts for it.
  const candidateEmail = candidateAccounts.currentEmail(req);
  if (candidateEmail) res.set('Cache-Control', 'private, no-store');
  if (hasFilters(f) && pager.page === 1) siteAnalytics.track(found.jobs.length ? 'job-search' : 'job-search-empty', f.work ? WORK_KINDS.find((w) => w.key === f.work).label : '', req);
  if (hasFilters(f) && !found.jobs.length) siteAnalytics.track('job-search', '', req);
  res.render('jobs', {
    title: pager.page > 1 ? `Find Jobs – page ${pager.page}` : 'Find Jobs',
    page: 'jobs',
    results: rows,
    pager,
    // Pages of the unfiltered list are canonical; filtered views (internal
    // search results) stay out of search engines but their links are followed.
    canonical: `${BASE_URL}/jobs${pager.page > 1 && !hasFilters(f) ? `?page=${pager.page}` : ''}`,
    noindex: hasFilters(f) ? 'follow' : false,
    metaDescription: `Find jobs across India on ${site.name}: ${live.length} open roles in office, IT, finance and sales work, and skilled, factory, warehouse, delivery, retail and hospitality jobs. Salary, location and job type on every listing.`,
    filters: { ...f, category: f.categories[0] || '' },
    sort: found.sort,
    active,
    corrected,
    canSaveSearch: Boolean(candidateEmail),
    savedSearchQuery: filterQuery(f),
    shifts: SHIFTS,
    companies: [...new Set(live.filter((j) => !isSample(j)).map((j) => j.company))].sort((a, b) => a.localeCompare(b)),
    experienceLevels: search.EXPERIENCE_LEVELS,
    minPayOptions: search.MIN_PAY_OPTIONS.map((n) => ({ value: n, label: payLabel(n) })),
    states: search.statesOf(jobLocations()),
    group,
    categories: jobCategories(),
    categoryGroups: groupCategories(jobCategories()),
    workKinds: WORK_KINDS,
    workCounts,
    jobTypes: JOB_TYPES,
    typeCounts: live.reduce((n, j) => ({ ...n, [j.type]: (n[j.type] || 0) + 1 }), {}),
    categoryCounts: live.reduce((n, j) => ({ ...n, [j.category]: (n[j.category] || 0) + 1 }), {}),
    locations: jobLocations(),
    locationCounts: live.reduce((n, j) => ({ ...n, [j.location]: (n[j.location] || 0) + 1 }), {}),
    modes,
    modeCounts: live.reduce((n, j) => ({ ...n, [j.mode]: (n[j.mode] || 0) + 1 }), {}),
  });
});

// Closed jobs keep their page (old links still resolve) but no longer take applications.
// "Apply on WhatsApp" opens a chat with the team, pre-filled with the job.
// Hidden while the WhatsApp number in Settings is still the placeholder.
const realWhatsapp = () => /^\d{10,15}$/.test(site.whatsapp || '') && !/^\d{2}0+$/.test(site.whatsapp);
const whatsappApplyLink = (job) =>
  realWhatsapp() ? `https://wa.me/${site.whatsapp}?text=${encodeURIComponent(`Hi ${site.name}, I want to apply for ${job.title} in ${job.location} (job ${job.id}). My name is `)}` : '';

// Landing pages for job seekers: a kind of work, or an industry (catalog.js).
function jobLanding(req, res, landing, kind) {
  const live = openJobs();
  const list = (kind === 'work' ? live.filter((j) => workOf(j) === landing.work) : live.filter((j) => landing.categories.includes(j.category)))
    .sort((a, b) => Number(isSample(a)) - Number(isSample(b)) || String(b.posted).localeCompare(String(a.posted)));
  const path = kind === 'work' ? `/jobs/${landing.slug}` : `/jobs/industry/${landing.slug}`;
  const { rows, pager } = paginate(list, { page: req.query.page, size: JOBS_PAGE_SIZE, query: {}, path });
  const desk = kind === 'industry' ? catalog.industryBySlug(landing.desk) : null;
  const searchHref = kind === 'work' ? `/jobs?work=${landing.work}` : `/jobs?${landing.categories.map((c) => `category=${encodeURIComponent(c)}`).join('&')}`;
  const trail = [['Home', '/'], ['Jobs', '/jobs'], ...(kind === 'industry' ? [['Industries', '/categories']] : []), [landing.name, path]];
  siteAnalytics.track('landing-view', landing.name, req);
  res.render('jobs-landing', {
    title: `${landing.name} in India${pager.page > 1 ? ` – page ${pager.page}` : ''}`, page: 'jobs', landing, kind, results: rows, pager, openCount: list.length, desk, searchHref,
    metaDescription: landing.description, canonical: `${BASE_URL}${path}${pager.page > 1 ? `?page=${pager.page}` : ''}`,
    jsonLd: seo.jobLandingPage(landing, path, trail, BASE_URL, rows.filter((j) => !isSample(j))),
  });
}
app.get('/jobs/office-professional', (req, res) => jobLanding(req, res, catalog.workPageBySlug('office-professional'), 'work'));
app.get('/jobs/skilled-technical', (req, res) => jobLanding(req, res, catalog.workPageBySlug('skilled-technical'), 'work'));
app.get('/jobs/industrial-field-service', (req, res) => jobLanding(req, res, catalog.workPageBySlug('industrial-field-service'), 'work'));
app.get('/jobs/industry/:slug', (req, res, next) => {
  const landing = catalog.jobIndustryBySlug(req.params.slug);
  if (!landing) return next();
  jobLanding(req, res, landing, 'industry');
});

app.get('/jobs/:id', (req, res, next) => {
  const job = findJobBySlug(jobs.filter(isPublicJob), req.params.id);
  if (!job) return next();
  // Removed by trust & safety: gone, not just closed.
  if (job.moderation && job.moderation.locked && job.moderation.state === 'removed') return res.status(410).render('thanks', { title: 'Listing removed', page: 'jobs', ok: false, message: 'This listing was removed because it did not meet our rules. See open jobs for current vacancies.', noindex: true });
  // An old title in the address (the job was renamed) moves to the current one.
  if (req.params.id !== job.id && req.params.id !== jobPath(job).slice(6)) {
    const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    return res.redirect(301, jobPath(job) + qs);
  }
  const related = openJobs().filter((j) => j.category === job.category && j.id !== job.id).slice(0, 3);
  const open = job.status === 'open';
  // Signed-in candidates get one-click applying with their profile.
  const account = candidateAccounts.accountForJob(req, job);
  if (account) res.set('Cache-Control', 'private, no-store');
  if (open) siteAnalytics.track('job-view', WORK_KINDS.find((w) => w.key === workOf(job)).label, req);
  const verified = verifiedEmployer(job);
  res.render('job', {
    title: `${job.title} – ${job.location}`,
    page: 'jobs',
    job,
    related,
    account,
    match: account && open && !isSample(job) ? recommendations.matchFor(account.email, job) : null,
    msg: account ? String(req.query.msg || '').slice(0, 200) : '',
    live: isLive(job),
    verifiedEmployer: verified,
    trustLabels: trustHooks.labelsFor(job),
    stateName: search.stateOf(job.location),
    reportReasons: REPORT_REASONS,
    quick: !resumeNeeded(job),
    whatsappApply: whatsappApplyLink(job),
    metaDescription: `${job.title} (${job.type}, ${job.mode}) in ${job.location}${job.experience ? `, ${job.experience}` : ''}${job.salary ? `, ${job.salary}` : ''}. ${job.description}`.slice(0, 300),
    // Google requires expired postings to drop their JobPosting markup.
    // A verified employer's own job names that employer; agency jobs name Hireriv.
    jsonLd: open && !isSample(job) ? [seo.jobPosting(job, site, BASE_URL, { employer: verified ? { name: job.company } : null }), seo.jobBreadcrumbs(job, BASE_URL)] : seo.jobBreadcrumbs(job, BASE_URL),
    ogImage: `${BASE_URL}/og/jobs/${job.id}.png?v=${og.jobVersion(job)}`,
    canonical: BASE_URL + jobPath(job),
    ogImageAlt: `${job.title} at ${job.company}, ${job.location}`,
    noindex: !open || isSample(job),
  });
});

// Saved jobs live in the visitor's browser (localStorage); the page asks the
// server to render cards for those ids. Closed jobs stay listed so people see why.
app.get('/saved', (req, res) => res.render('saved', { title: 'Saved jobs', page: 'saved', noindex: true }));

app.get('/saved/cards', (req, res) => {
  const ids = String(req.query.ids || '').split(',').filter((id) => /^[A-Za-z0-9_-]{1,40}$/.test(id)).slice(0, 100);
  const list = ids.map((id) => jobs.find((j) => j.id === id && isPublicJob(j))).filter(Boolean);
  res.set('X-Robots-Tag', 'noindex').render('partials/saved-cards', { list });
});

// ?service=<slug> (from a service page) pre-selects that service on the form.
app.get('/hire', (req, res) => {
  const chosen = catalog.serviceBySlug(String(req.query.service || ''));
  const desk = catalog.industryBySlug(String(req.query.desk || ''));
  res.render('hire', {
    title: 'Hire a Team', page: 'hire', hireOptions: catalog.HIRE_OPTIONS, selectedService: chosen ? chosen.hiringType : '',
    from: chosen ? `service:${chosen.slug}` : desk ? `desk:${desk.slug}` : '',
    metaDescription: `Tell ${site.name} who you need to hire: permanent, contract, bulk or executive roles. A recruiter calls you back within one working day.`,
  });
});
// The service and contact addresses from the website plan, kept as short links.
app.get('/services/recruitment', (req, res) => res.redirect(301, '/services/permanent-staffing'));
app.get('/services/staffing', (req, res) => res.redirect(301, '/services/contract-staffing'));
app.get('/services/bulk-hiring', (req, res) => res.redirect(301, '/services/bulk-rpo-hiring'));
app.get('/employers/contact', (req, res) => res.redirect(301, '/hire'));

// ---------- services and industry desks (content in catalog.js) ----------
const guaranteeDays = () => (site.billing && Number.isInteger(site.billing.guaranteeDays) ? site.billing.guaranteeDays : placements.BILLING_DEFAULTS.guaranteeDays);
app.get('/services', (req, res) =>
  res.render('services', { title: 'Services', page: 'services', services: catalog.SERVICES, industries: catalog.INDUSTRIES, metaDescription: `${site.name} services: permanent staffing, contract staffing, executive search, bulk and RPO hiring, background verification and corporate training.` })
);
app.get('/services/:slug', (req, res, next) => {
  const service = catalog.serviceBySlug(req.params.slug);
  if (!service) return next();
  siteAnalytics.track('service-view', service.name, req);
  res.render('service', {
    title: service.name, page: 'services', service, industries: catalog.INDUSTRIES, others: catalog.SERVICES.filter((s) => s !== service).slice(0, 3),
    guaranteeDays: guaranteeDays(), metaDescription: `${service.name} from ${site.name}: ${service.card}`, jsonLd: seo.servicePage(service, site, BASE_URL),
  });
});
app.get('/industries', (req, res) => {
  const open = openJobs();
  const openCounts = Object.fromEntries(catalog.INDUSTRIES.map((i) => [i.name, open.filter((j) => catalog.deskCategories(i).includes(j.category)).length]));
  const desks = new Set(catalog.INDUSTRIES.flatMap(catalog.deskCategories));
  res.render('industries', {
    title: 'Industries', page: 'industries', industries: catalog.INDUSTRIES, openCounts, otherCategories: jobCategories().filter((c) => !desks.has(c)),
    metaDescription: `Specialist recruitment desks at ${site.name}: ${catalog.INDUSTRIES.map((i) => i.name).join(', ')}.`,
  });
});
app.get('/industries/:slug', (req, res, next) => {
  const industry = catalog.industryBySlug(req.params.slug);
  if (!industry) return next();
  const cats = catalog.deskCategories(industry);
  const open = openJobs().filter((j) => cats.includes(j.category));
  const forSeekers = catalog.JOB_INDUSTRIES.find((x) => x.desk === industry.slug);
  siteAnalytics.track('industry-view', industry.name, req);
  res.render('industry', {
    title: `${industry.name} Recruitment`, page: 'industries', industry, jobs: open.slice(0, 6), openCount: open.length,
    jobsHref: forSeekers ? `/jobs/industry/${forSeekers.slug}` : `/jobs?${cats.map((c) => `category=${encodeURIComponent(c)}`).join('&')}`,
    related: industry.services.map(catalog.serviceBySlug).filter(Boolean), metaDescription: `${industry.name} recruitment by ${site.name}. ${industry.text}`, jsonLd: seo.industryPage(industry, BASE_URL),
  });
});
app.get('/about', (req, res) => res.render('about', { title: 'About Us', page: 'about', metaDescription: `About ${site.name}: a recruitment and staffing company in India hiring for office, skilled and field roles, with pre-screened candidates and one point of contact for employers.` }));
app.get('/contact', (req, res) => res.render('contact', { title: 'Contact Us', page: 'contact', metaDescription: `Contact ${site.name} by phone, WhatsApp or email: questions about jobs, applications, hiring or staffing.` }));
// Bump LEGAL_UPDATED whenever the wording of either page changes.
const LEGAL_UPDATED = '2026-10-25';
app.get('/privacy', (req, res) => res.render('privacy', { title: 'Privacy Policy', page: 'legal', updated: LEGAL_UPDATED, policyVersion: privacyModule.POLICY_VERSION, purposes: privacyModule.PURPOSES, metaDescription: `How ${site.name} collects, uses and protects the personal data of candidates, clients and visitors.` }));
app.get('/job-posting-policy', (req, res) => res.render('job-posting-policy', { title: 'Job posting rules', page: 'legal', updated: LEGAL_UPDATED, metaDescription: `What employers may and may not post on ${site.name}: real vacancies, honest pay, no fees from candidates.` }));
app.get('/terms', (req, res) => res.render('terms', { title: 'Terms of Use', page: 'legal', updated: LEGAL_UPDATED, metaDescription: `The terms for using the ${site.name} website as a job seeker or employer.` }));
app.get('/blog', (req, res) => res.render('blog', { title: 'Career Resources', page: 'blog', posts: livePosts(), metaDescription: `Career and hiring advice from ${site.name}: resumes, interviews, salaries and building teams in India.` }));
app.get('/blog/:slug', (req, res, next) => {
  const post = livePosts().find((p) => p.slug === req.params.slug);
  if (!post) return next();
  res.render('post', { title: post.title, page: 'blog', post, more: livePosts().filter((p) => p !== post).slice(0, 2), metaDescription: post.excerpt, jsonLd: seo.article(post, site, BASE_URL) });
});

// ---------- form endpoints ----------
// Saves an application, or updates this person's earlier one for the same job
// instead of creating a second candidate. People are matched by email, or by
// phone when either application has no email. Someone who withdrew and comes
// back gets a fresh application.
const APPLICATION_FIELDS = ['name', 'email', 'phone', 'skills', 'experience', 'location', 'noticePeriod', 'linkedin', 'message'];
// `announce` sends the candidate's confirmation and the team's copy (forms the
// candidate filled in themselves); the people working on a job always hear.
async function saveApplication(data, file, job, extra = {}, { announce = false } = {}) {
  // Keep the resume text for searching, and its skills for matching. If the
  // candidate left "Key skills" empty, the skills found in the resume fill it.
  const resumeText = file ? await resumes.extractText(file.path, file.originalname) : '';
  const found = resumes.analyze(resumeText, allJobSkills());
  if (!data.skills && found.skills.length) data.skills = found.skills.join(', ');
  const list = readSubmissions('applications');
  const sameJob = (a) => (a.jobId || '') === (job ? job.id : data.jobId || '');
  const email = String(data.email || '').toLowerCase();
  const tel = phoneKey(data.phone);
  const samePerson = (a) => (email && String(a.email || '').toLowerCase() === email) || ((!email || !a.email) && tel && phoneKey(a.phone) === tel);
  const prev = list.find((a) => !a.withdrawnAt && !a.duplicateOf && sameJob(a) && samePerson(a));
  if (prev) {
    for (const k of APPLICATION_FIELDS) if (data[k]) prev[k] = data[k];
    if (file) {
      if (prev.resume) fs.unlink(path.join(UPLOADS_DIR, path.basename(prev.resume)), () => {});
      Object.assign(prev, { resume: file.filename, resumeText, resumeSkills: found.skills });
    }
    const now = new Date().toISOString();
    Object.assign(prev, { updatedAt: now, reapplied: [...(prev.reapplied || []), now].slice(-20) });
    db.transaction(() => {
      writeSubmissions('applications', list);
      if (announce) events.applicationSubmitted(prev, job, { updated: true });
    });
    return { app: prev, updated: true };
  }
  const record = { ...data, jobTitle: job ? job.title : 'General application', resume: file ? file.filename : '', resumeText, resumeSkills: found.skills, status: 'New', notes: '', ...extra };
  try {
    const saved = db.transaction(() => {
      const s = saveSubmission('applications', record);
      if (announce) events.applicationSubmitted(s, job);
      if (job) events.newApplication(s, job, (skillMatch(s, job) || {}).score);
      return s;
    });
    return { app: saved, updated: false };
  } catch (err) {
    // The database's one-application-per-person rule caught a duplicate the
    // check above missed: keep the existing application.
    if (err.code !== 'ERR_UNIQUE') throw err;
    if (file) fs.unlink(file.path, () => {});
    const key = applicationKey({ id: '', ...record });
    return { app: readSubmissions('applications').find((a) => applicationKey(a) === key), updated: true, duplicate: true };
  }
}

app.post('/api/apply', limit('apply', 6), (req, res) => {
  upload.single('resume')(req, res, (err) => {
    if (!err && isBot(req.body)) {
      if (req.file) fs.unlink(req.file.path, () => {});
      return respond(req, res, [], 'Thanks! Your application is in.');
    }
    if (err) return respond(req, res, [err.code === 'LIMIT_FILE_SIZE' ? 'Resume must be under 5 MB' : err.message]);
    const data = clean(req.body, ['jobId', ...APPLICATION_FIELDS, 'source']);
    data.source = reportsModule.cleanSource(data.source);
    const job = jobs.find((j) => j.id === data.jobId);
    // Quick applications (skilled and field jobs): a name and phone number are enough.
    const quick = !resumeNeeded(job);
    const errors = validate(data, quick ? ['name', 'phone'] : ['name', 'email', 'phone']);
    if (!req.file && !quick) errors.push('resume is required');
    if (job && !isLive(job)) errors.push('this job is no longer accepting applications');
    else if (job && isSample(job)) errors.push('this is a sample listing, not a real vacancy. Send us your details with a general application instead');
    if (errors.length) {
      if (req.file) fs.unlink(req.file.path, () => {});
      siteAnalytics.track('form-rejected', 'Application', req);
      return respond(req, res, errors);
    }
    resumeCheck.vet(req.file).then((bad) => {
      if (bad) return respond(req, res, [bad]);
      return saveApplication(data, req.file, job, {}, { announce: true }).then(({ updated }) => {
      if (!updated) siteAnalytics.track('application-submitted', job ? WORK_KINDS.find((w) => w.key === workOf(job)).label : 'General application', req);
      const first = data.name.split(' ')[0];
      if (updated) return respond(req, res, [], `Thanks ${first}! You'd already applied for this job, so we've updated your application with your new details.`);
      respond(req, res, [], `Thanks ${first}! Your application is in. A recruiter will ${data.email ? 'contact you' : `call you on ${data.phone}`} within 2 working days.`);
      });
    }).catch((e) => {
      console.error(e);
      respond(req, res, ['Could not save your application. Please try again.']);
    });
  });
});

const allJobSkills = () => [...new Set(jobs.flatMap((j) => j.skills || []))];

// Read a resume as soon as it's picked on the apply form and send back what we
// found, so the form can fill in empty fields. Nothing is stored.
const peekUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, ['.pdf', '.docx'].includes(path.extname(file.originalname).toLowerCase())),
});
app.post('/api/resume-parse', limit('resume-parse', 20), (req, res) => {
  peekUpload.single('resume')(req, res, async (err) => {
    if (err || !req.file) return res.json({ ok: false, message: err && err.code === 'LIMIT_FILE_SIZE' ? 'Resume must be under 5 MB' : "We couldn't read this file, so please fill in the form yourself." });
    const text = await resumes.extractText(req.file.buffer, req.file.originalname);
    if (!text) return res.json({ ok: false, message: "We couldn't read text from this file (it may be a scan), so please fill in the form yourself." });
    const f = resumes.analyze(text, allJobSkills());
    res.json({ ok: true, fields: { name: f.name, email: f.email, phone: f.phone, linkedin: f.linkedin, experience: f.experience, skills: f.skills.join(', ') } });
  });
});

// An employer's inquiry from the "Hire with us" form or POST
// /api/public/employer-inquiries: kept, emailed to the team and added to the
// sales CRM (a repeat from the same person goes to their existing lead).
const INQUIRY_THANKS = 'Thank you! Our client partner will call you within one working day to understand your hiring needs.';
function employerInquiry(req, body) {
  const data = clean(body, ['company', 'name', 'email', 'phone', 'roles', 'headcount', 'hiringType', 'location', 'timeline', 'message']);
  const errors = validate(data, ['company', 'name', 'email', 'phone', 'roles']);
  if (data.hiringType && !catalog.HIRE_OPTIONS.includes(data.hiringType)) errors.push('hiringType is not one we offer');
  if (errors.length) { siteAnalytics.track('form-rejected', 'Employer inquiry', req); return errors; }
  const from = String(body.from || '');
  const service = /^service:/.test(from) && catalog.serviceBySlug(from.slice(8));
  const desk = /^desk:/.test(from) && catalog.industryBySlug(from.slice(5));
  const page = service ? `service page: ${service.name}` : desk ? `industry page: ${desk.name}` : '';
  const entry = saveSubmission('hire-requests', { ...data, ...(page ? { fromPage: page } : {}) });
  mailer.hireRequestReceived(entry);
  events.staffingRequest(entry);
  leadCapture.capture('Website inquiry', data, { sourceRef: entry.id, sourceDetail: `Hire with us form${page ? `, ${page}` : ''}` });
  siteAnalytics.track('employer-inquiry', service ? service.name : desk ? desk.name : data.hiringType || 'Hire page', req);
  return [];
}
app.post('/api/hire', limit('hire', 5), (req, res) => {
  if (isBot(req.body)) return respond(req, res, [], 'Thank you! Our client partner will be in touch.');
  respond(req, res, employerInquiry(req, req.body || {}), INQUIRY_THANKS);
});
app.post('/api/public/employer-inquiries', limit('hire', 5), sameOrigin, (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (isBot(body)) return res.status(202).json({ ok: true, message: INQUIRY_THANKS });
  const errors = employerInquiry(req, body);
  if (errors.length) return res.status(400).json({ ok: false, errors });
  res.status(202).json({ ok: true, message: INQUIRY_THANKS });
});

app.post('/api/contact', limit('contact', 5), (req, res) => {
  if (isBot(req.body)) return respond(req, res, [], "Thanks for reaching out. We'll get back to you shortly.");
  const data = clean(req.body, ['name', 'email', 'phone', 'subject', 'message']);
  const errors = validate(data, ['name', 'email', 'message']);
  if (!errors.length) mailer.contactReceived(saveSubmission('contacts', data));
  respond(req, res, errors, "Thanks for reaching out. We'll get back to you shortly.");
});

// ---------- public jobs API ----------
// Published, open jobs that are still within their application period. Sample
// listings are left out. Same filters and order as the Find Jobs page.
const API_MAX_LIMIT = 50;
// A job's employer is verified when it's linked to an active client account
// (their company and contact checked by the team when the client was added).
function verifiedEmployer(job) {
  const c = job.employerId && clients.read().find((x) => x.id === job.employerId);
  return employers.isApproved(c);
}
const publicJob = (j) => ({
  id: j.id,
  title: j.title,
  company: j.company,
  verifiedEmployer: verifiedEmployer(j),
  location: { city: j.location === 'Remote' ? null : j.location, state: search.stateOf(j.location) || null, country: 'IN', workArrangement: j.mode },
  category: j.category,
  kindOfWork: workOf(j),
  employmentType: j.type,
  experience: j.experience || null,
  pay: j.pay ? { ...j.pay } : null,
  payText: j.salary || null,
  skills: j.skills || [],
  description: j.description,
  responsibilities: j.responsibilities || [],
  qualifications: j.qualifications || [],
  education: j.education || null,
  schedule: j.schedule || null,
  shift: j.shift || null,
  hours: j.hours || null,
  openings: j.openings || null,
  workplaceAddress: j.address || null,
  walkIn: Boolean(j.walkIn),
  eligibility: j.eligibility || [],
  benefits: j.benefits || [],
  requirements: { licences: j.mustHave || [], startsImmediately: Boolean(j.immediate), physical: j.physical || null },
  postedAt: j.posted,
  closesOn: j.closesOn || null,
  quickApply: !resumeNeeded(j),
  url: `${BASE_URL}${jobPath(j)}`,
});

// Also answers GET /api/public/jobs.
async function jobsApi(req, res) {
  const { filters: f, errors } = jobFilters(req.query);
  const int = (k, def, max) => {
    const v = req.query[k];
    if (v === undefined || v === '') return def;
    if (!/^\d{1,4}$/.test(String(v)) || Number(v) < 1 || Number(v) > max) { errors.push(`${k} must be a whole number from 1 to ${max}`); return def; }
    return Number(v);
  };
  const page = int('page', 1, 1000);
  const size = int('limit', JOBS_PAGE_SIZE, API_MAX_LIMIT);
  if (errors.length) return res.status(400).json({ ok: false, errors });
  const live = openJobs().filter((j) => !isSample(j));
  const send = (total, sort, list, corrected) => res.set('Cache-Control', 'public, max-age=60').json({
    ok: true, total, page, limit: size, pages: Math.max(1, Math.ceil(total / size)), sort, ...(corrected ? { correctedQuery: corrected } : {}), jobs: list.map(publicJob),
  });
  // Postgres when it's connected and up to date; the same search in memory otherwise.
  const viaPg = async (filters) => {
    if (!(pg && pg.usable())) return null;
    try {
      await pg.flush();
      const found = pg.usable() && (await pg.search(filters, { page, size }));
      if (!found) return null;
      const byId = new Map(jobs.map((j) => [j.id, j]));
      return { total: found.total, sort: found.sort, list: found.ids.map((id) => byId.get(id)).filter((j) => j && isLive(j) && !isSample(j)) };
    } catch (err) {
      console.error(`Postgres search failed, used the built-in search: ${err.message}`);
      return null;
    }
  };
  const inMemory = (filters) => {
    const found = findJobs(live, filters);
    return { total: found.jobs.length, sort: found.sort, list: found.jobs.slice((page - 1) * size, page * size) };
  };
  const run = async (filters) => (await viaPg(filters)) || inMemory(filters);
  let r = await run(f);
  let corrected = null;
  if (!r.total) {
    const better = correctedFilters(live, f);
    const retry = better && (await run(better));
    if (retry && retry.total) { r = retry; corrected = better.q; }
  }
  send(r.total, r.sort, r.list, corrected);
}
app.get('/api/jobs', limit('job-search', 120, 60 * 1000), (req, res) => jobsApi(req, res));

// ---------- public website API (/api/public/*) ----------
// The same data the public pages show; never applications, candidates,
// clients' private details or anything behind a sign-in.
app.get('/api/public/jobs', limit('job-search', 120, 60 * 1000), (req, res) => jobsApi(req, res));
app.get('/api/public/jobs/:slug', limit('job-search', 120, 60 * 1000), (req, res) => {
  const job = findJobBySlug(jobs.filter(isPublicJob), String(req.params.slug).slice(0, 200));
  if (!job || isSample(job)) return res.status(404).json({ ok: false, errors: ['job not found'] });
  if (!isLive(job)) return res.status(410).json({ ok: false, status: 'closed', errors: ['this job is no longer open'] });
  res.json({ ok: true, job: { ...publicJob(job), slug: jobPath(job).slice(6) } });
});
// The same two in the versioned API (integrations.js documents them).
app.get('/api/v1/public/jobs', limit('job-search', 120, 60 * 1000), (req, res) => jobsApi(req, res));
app.get('/api/v1/public/jobs/:slug', limit('job-search', 120, 60 * 1000), (req, res) => {
  const job = findJobBySlug(jobs.filter(isPublicJob), String(req.params.slug).slice(0, 200));
  if (!job || isSample(job)) return res.status(404).json({ error: { code: 'not_found', message: 'job not found' } });
  if (!isLive(job)) return res.status(410).json({ error: { code: 'closed', message: 'this job is no longer open' } });
  res.json({ data: { ...publicJob(job), slug: jobPath(job).slice(6) } });
});
app.get('/api/public/industries', limit('public-api', 120, 60 * 1000), (req, res) => {
  const live = openJobs().filter((j) => !isSample(j));
  res.json({
    ok: true,
    kindsOfWork: catalog.WORK_PAGES.map((w) => ({ slug: w.slug, name: w.name, url: `${BASE_URL}/jobs/${w.slug}`, openJobs: live.filter((j) => workOf(j) === w.work).length })),
    industries: catalog.JOB_INDUSTRIES.map((i) => ({ slug: i.slug, name: i.name, categories: i.categories, url: `${BASE_URL}/jobs/industry/${i.slug}`, openJobs: live.filter((j) => i.categories.includes(j.category)).length })),
    recruitmentDesks: catalog.INDUSTRIES.map((i) => ({ slug: i.slug, name: i.name, url: `${BASE_URL}/industries/${i.slug}` })),
    categories: jobCategories(),
  });
});
app.get('/api/public/site-config', limit('public-api', 120, 60 * 1000), (req, res) => {
  res.json({
    ok: true,
    site: {
      name: site.name, tagline: site.tagline, url: BASE_URL, email: site.email, phone: /0{5}/.test(site.phone) ? null : site.phone, whatsapp: realWhatsapp() ? site.whatsapp : null,
      social: Object.fromEntries(Object.entries(site.social || {}).filter(([, u]) => /^https?:\/\//.test(u))),
    },
    services: catalog.SERVICES.map((s) => ({ slug: s.slug, name: s.name, url: `${BASE_URL}/services/${s.slug}` })),
    hiringTypes: catalog.HIRE_OPTIONS, locations: jobLocations(), employmentTypes: JOB_TYPES, workArrangements: modes, kindsOfWork: WORK_KINDS.map(({ key, label }) => ({ key, label })),
    analytics: { cookies: false, personalData: false, honoursGlobalPrivacyControl: true },
  });
});
// What a browser may report itself (an application form opened). Counted, never stored per person.
app.post('/api/public/events', limit('public-events', 60), sameOrigin, (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const event = String(body.event || '');
  if (!siteAnalytics.CLIENT_EVENTS.includes(event)) return res.status(400).json({ ok: false, errors: ['unknown event'] });
  const job = /^[A-Za-z0-9_-]{1,40}$/.test(String(body.jobId || '')) ? jobs.find((j) => j.id === body.jobId && isLive(j)) : null;
  siteAnalytics.track(event, job ? WORK_KINDS.find((w) => w.key === workOf(job)).label : 'General application', req);
  res.status(204).end();
});

app.get('/api/jobs/:id', limit('job-search', 120, 60 * 1000), (req, res) => {
  const job = jobs.find((j) => j.id === req.params.id);
  if (!job || !isLive(job) || isSample(job)) return res.status(404).json({ ok: false, errors: ['job not found or no longer open'] });
  res.json({ ok: true, job: publicJob(job) });
});

// Anyone can flag a listing that looks fake, asks for money or is misleading.
// The team gets an email and sees it under Inbox → Reported jobs.
// Each report also opens (or adds to) a trust & safety case (trust.js).
const REPORT_REASONS = ['Looks fake or like a scam', 'Asks candidates to pay money', 'Asks for Aadhaar, bank details or an OTP', 'Pretends to be another company', 'Wrong or misleading details', 'Already filled or closed', 'Discriminatory or offensive', 'Has suspicious links or apps', 'Something else'];
app.post('/api/jobs/:id/report', limit('job-report', 5), (req, res, next) => {
  const job = jobs.find((j) => j.id === req.params.id);
  if (!job) return next();
  const thanks = 'Thanks for telling us. Our team will check this job within one working day.';
  if (isBot(req.body)) return respond(req, res, [], thanks);
  const data = clean(req.body, ['reason', 'details', 'email']);
  const errors = validate(data, ['reason']);
  if (data.reason && !REPORT_REASONS.includes(data.reason)) errors.push('reason is invalid');
  if (errors.length) return respond(req, res, errors, thanks);
  const saved = saveSubmission('job-reports', { jobId: job.id, jobTitle: job.title, company: job.company, reason: data.reason, details: data.details.slice(0, 1000), email: data.email.toLowerCase() });
  mailer.jobReported(saved);
  // A reference and a private link to follow the report (trust.js).
  const r = trustHooks.reportJob(req, job, { ...data, details: data.details.slice(0, 1000) }, saved.id);
  const receipt = r && r.receipt;
  if (!receipt) return respond(req, res, [], thanks);
  if ((req.get('Accept') || '').includes('application/json')) return res.json({ ok: true, message: thanks, reference: receipt.reference, trackUrl: receipt.trackUrl, help: receipt.help });
  res.render('thanks', { title: 'Thank you', page: '', ok: true, message: `${thanks} Your reference is ${receipt.reference}. Follow it at ${receipt.trackUrl} (keep this link private). ${receipt.help}`, noindex: true });
});

// ---------- job alerts (double opt-in) ----------
// Alert each job at most once, the first time it goes live: saved searches
// with instant alerts and email-only alerts now, daily and weekly ones in
// their next email (job-recommendations.js).
function sendJobAlerts(job) {
  if (job.status !== 'open' || job.alertsSentAt || isSample(job)) return 0;
  job.alertsSentAt = new Date().toISOString();
  return recommendations.dispatch(job);
}

app.post('/api/job-alerts', limit('job-alerts', 5), (req, res) => {
  if (isBot(req.body)) return respond(req, res, [], 'Almost done! Check your inbox and click the link to switch on your job alert.');
  const data = clean(req.body, ['email', 'category', 'location']);
  const errors = validate(data, ['email']);
  if (data.category && !jobCategories().includes(data.category)) errors.push('category is invalid');
  if (data.location && !jobLocations().includes(data.location)) errors.push('location is invalid');
  // Signed in as a candidate (and it's their own email): the alert is on at
  // once, and the JSON reply includes it.
  const own = candidateAccounts.currentEmail(req);
  if (own && !errors.filter((e) => !/email/.test(e)).length && (!data.email || data.email.toLowerCase() === own)) {
    const r = center.createAlert(own, data.category, data.location);
    if (r.errors) return respond(req, res, r.errors);
    if ((req.get('Accept') || '').includes('application/json')) return res.status(r.status).json({ ok: true, alert: { id: r.alert.id, category: r.alert.category || null, location: r.alert.location || null }, existed: Boolean(r.existed) });
    return respond(req, res, [], r.existed ? 'You already have that job alert.' : 'Job alert on. Manage it in your account.');
  }
  if (!errors.length) {
    const email = data.email.toLowerCase();
    const existing = readSubmissions('job-alerts').find((s) => s.email === email && s.category === data.category && s.location === data.location);
    // Same reply either way, so the form can't be used to discover who is subscribed.
    if (!existing) {
      const sub = saveSubmission('job-alerts', { email, category: data.category, location: data.location, confirmed: false, token: crypto.randomBytes(24).toString('hex') });
      mailer.jobAlertConfirm(sub);
    } else if (!existing.confirmed) {
      mailer.jobAlertConfirm(existing);
    }
  }
  respond(req, res, errors, 'Almost done! Check your inbox and click the link to switch on your job alert.');
});

function findAlert(token) {
  const list = readSubmissions('job-alerts');
  return { list, sub: /^[a-f0-9]{48}$/.test(token) ? list.find((s) => s.token === token) : undefined };
}

app.get('/job-alerts/confirm/:token', (req, res) => {
  const { list, sub } = findAlert(req.params.token);
  if (!sub) return res.status(404).render('thanks', { title: 'Link expired', page: '', ok: false, message: 'This job alert link is no longer valid. You can set up a new alert on the Find Work page.', noindex: true });
  if (!sub.confirmed) {
    Object.assign(sub, { confirmed: true, confirmedAt: new Date().toISOString() });
    writeSubmissions('job-alerts', list);
    privacy.consent(sub.email, 'job-alerts', true, 'job alert confirmation link', { ref: sub.id });
  }
  const what = [sub.category || 'all', 'jobs', sub.location ? `in ${sub.location}` : ''].filter(Boolean).join(' ');
  res.render('thanks', { title: 'Job alert switched on', page: '', ok: true, message: `You'll get an email whenever we post ${what}.`, noindex: true });
});

// GET shows a button (mail scanners prefetch links); POST does the unsubscribe,
// which also serves RFC 8058 one-click List-Unsubscribe.
app.get('/job-alerts/unsubscribe/:token', (req, res) => {
  const { sub } = findAlert(req.params.token);
  res.render('unsubscribe', { title: 'Unsubscribe from job alerts', page: '', sub, noindex: true });
});

app.post('/job-alerts/unsubscribe/:token', (req, res) => {
  const { list, sub } = findAlert(req.params.token);
  // A saved search stays saved, with its emails off; an email-only alert goes.
  if (sub) privacy.consent(sub.email, 'job-alerts', false, 'unsubscribe link', { ref: sub.id });
  if (sub && sub.filters) {
    Object.assign(sub, { alertEnabled: false, pending: [], updatedAt: new Date().toISOString() });
    writeSubmissions('job-alerts', list);
    return res.render('thanks', { title: "You're unsubscribed", page: '', ok: true, message: `You won't get emails for your saved search “${sub.name}” any more. It stays in your account, where you can switch them back on.`, noindex: true });
  }
  if (sub) writeSubmissions('job-alerts', list.filter((s) => s !== sub));
  res.render('thanks', { title: "You're unsubscribed", page: '', ok: true, message: "You won't get this job alert any more. You can set up a new one any time on the Find Work page.", noindex: true });
});

app.post('/api/newsletter', limit('newsletter', 5), (req, res) => {
  if (isBot(req.body)) return respond(req, res, [], "You're subscribed!");
  const data = clean(req.body, ['email']);
  const errors = validate(data, ['email']);
  if (!errors.length && !readSubmissions('newsletter').some((s) => s.email.toLowerCase() === data.email.toLowerCase())) {
    saveSubmission('newsletter', data);
    privacy.consent(data.email, 'marketing-email', true, 'newsletter form');
  }
  respond(req, res, errors, "You're subscribed! Expect hiring insights and new roles in your inbox.");
});

// ---------- admin (team logins; see team.js) ----------
// ADMIN_USER / ADMIN_PASS is the built-in owner account; everyone else is
// invited from the Team tab and signs in with their own email and password.
const team = teamModule.create({ db, mailer, site, baseUrl: BASE_URL, ownerUser: ADMIN_USER, ownerPass: ADMIN_PASS, resetOwner2fa: process.env.RESET_OWNER_2FA === '1' });
const { adminAuth, requireAdmin } = team;
security.watchTeam(team);

// Data retention (off unless switched on in Settings): runs at start and daily.
const retention = retentionModule.create({ db, site, uploadsDir: UPLOADS_DIR, readSubmissions, writeSubmissions, log: team.log });
// The retention policy (privacy.js) adds the security log, team activity,
// consent records, data requests and closed incidents.
let securityDesk = null;
const runRetention = ops.track('data-retention', () => {
  const done = retention.run();
  const p = privacy.policy();
  const more = { ...privacy.prune(p), securityLog: security.prune(p.securityLogDays), teamActivity: team.pruneActivity(p.securityLogDays), incidents: securityDesk ? securityDesk.prune(p.incidentYears) : 0 };
  if (Object.values(more).some(Boolean)) team.log(null, 'Retention policy clean-up', Object.entries(more).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(', '));
  return { ...done, ...more };
}, 24 * 60 * 60 * 1000);
runRetention();
setInterval(runRetention, 24 * 60 * 60 * 1000).unref();

// Daily database backups, kept next to the database unless BACKUP_DIR says otherwise.
const backups = backupsModule.create({ db, dir: process.env.BACKUP_DIR ? path.resolve(process.env.BACKUP_DIR) : path.join(path.dirname(DB_FILE), 'backups'), log: team.log, keep: () => privacy.policy().backupDays });
backups.start();

// Sign-in cookies ride along on cross-site form posts, so every admin write must
// come from a page on this same host.
function sameOrigin(req, res, next) {
  const src = req.get('Origin') || req.get('Referer');
  try {
    if (src && new URL(src).host === req.get('Host')) return next();
  } catch (e) { /* malformed header falls through to 403 */ }
  res.status(403).send('Cross-site request blocked');
}

const ADMIN_PAGE_SIZE = 50;
// The admin navigation, grouped the way the team works (Applications first).
const TAB_GROUPS = [
  ['Overview', ['dashboard', 'reports']],
  ['Recruiting', ['applications', 'jobs', 'talent', 'interviews']],
  ['Clients & billing', ['clients', 'placements']],
  ['Inbox', ['hire-requests', 'contacts', 'job-reports', 'job-alerts', 'newsletter']],
  ['Content', ['blog', 'templates']],
  ['Admin', ['settings', 'team', 'activity']],
];
const TAB_LABELS = { 'hire-requests': 'Hire requests', 'job-alerts': 'Job alerts', 'job-reports': 'Reported jobs' };
const ADMIN_TABS = ['dashboard', 'reports', 'jobs', 'talent', 'interviews', 'placements', 'clients', ...FORM_TYPES, 'templates', 'blog', 'settings', 'team', 'activity'];
// Recruiters don't see these tabs.
const ADMIN_ONLY_TABS = ['settings', 'team', 'activity'];
const tabsFor = (user) => agencyRoles.tabsAllowed(user, ADMIN_TABS.filter((t) => user.role === 'Admin' || !ADMIN_ONLY_TABS.includes(t)));
const adminUrl = (tab, msg) => `/admin?tab=${tab}${msg ? `&msg=${encodeURIComponent(msg)}` : ''}`;

team.register(app, { sameOrigin, adminUrl });

// ----- ownership -----
// Jobs have a recruiter who owns them; an application belongs to its job's
// owner unless someone is assigned to it directly.
const appOwner = (a) => a.ownerId || (jobs.find((j) => j.id === a.jobId) || {}).ownerId || '';
const ownerFilter = (req) => (['me', 'none'].includes(req.query.owner) ? req.query.owner : team.members().some((u) => u.id === req.query.owner) ? req.query.owner : '');
const matchesOwner = (ownerId, filter, user) => (filter === 'me' ? ownerId === user.id : filter === 'none' ? !ownerId : ownerId === filter);
const validOwner = (id) => (team.members().some((u) => u.id === id) ? id : '');

const interviewDesk = interviews.register(app, { adminAuth, sameOrigin, readSubmissions, writeSubmissions, mailer, site, adminUrl, baseUrl: BASE_URL, limit, db, events });
const clients = employers.register(app, {
  db, site, mailer, baseUrl: BASE_URL, adminAuth, sameOrigin, adminUrl, limit, downloadLinks, linkExpired,
  readSubmissions, saveSubmission, getJobs: () => jobs, appStatuses: APP_STATUSES,
  writeSubmissions, uploadsDir: UPLOADS_DIR, skillMatch, placementsFor: (emp) => billing.forClient(emp), timesheetsFor: (emp) => timesheets.forClient(emp),
  sms: require('./sms'), companyContext: () => ({ cities: jobLocations().filter((l) => l !== 'Remote'), states: INDIAN_STATES }), events, notify, leadCapture,
});

// "Post a Job": signed-in clients go to their portal's requirement form;
// everyone else to the hiring form on /hire.
app.get('/post-a-job', (req, res) => res.redirect(clients.currentEmployer(req) ? '/employer/jobs/new' : '/employer/register'));

// ---------- employers hiring for themselves ----------
// Their jobs (draft, the team's check, live, paused, closed), the people who
// applied, status changes and interviews: employer-hiring.js.
const hiring = employerHiring.register(app, {
  site, mailer, baseUrl: BASE_URL, limit, sameOrigin, adminAuth, adminUrl, clients, readSubmissions, writeSubmissions, saveSubmission, uploadsDir: UPLOADS_DIR, downloadLinks, linkExpired,
  getJobs: () => jobs, saveJobs, parseJob, nextJobId, todayIst, publicJob, jobPath, sendJobAlerts, alertedNote: (n) => alertedNote(n),
  appStatuses: APP_STATUSES, moveStage: history.moveStage, interviewDesk, parseInterview: interviews.parseInterview, interviewModes: interviews.MODES, interviewDurations: interviews.DURATIONS,
  formatIst: interviews.formatIst, skillMatch, events,
  jobFormLocals: (job, errors) => ({ job, errors, modes, jobTypes: JOB_TYPES, categoryGroups: groupCategories(jobCategories()), workKinds: WORK_KINDS, jobLocations: jobLocations() }),
});
// The applicant tracking on top of it: pipeline, notes, offers, scorecards, metrics.
const atsDesk = employerAts.register(app, {
  site, mailer, baseUrl: BASE_URL, limit, sameOrigin, clients, hiring, readSubmissions, writeSubmissions, getJobs: () => jobs,
  interviewDesk, moveStage: history.moveStage, formatIst: interviews.formatIst, todayIst, events, db,
});
// Filled in by agency.js: which requisition and contract a new placement belongs to.
const placementHooks = {};
const billing = placements.register(app, {
  db, site, mailer, baseUrl: BASE_URL, adminAuth, requireAdmin, requireBilling: team.requireBilling, sameOrigin, adminUrl, readSubmissions, writeSubmissions,
  getJobs: () => jobs, clients, requireEmployer: clients.requireEmployer, hooks: placementHooks,
});
const templates = bulk.register(app, {
  db, site, mailer, adminAuth, requireAdmin, sameOrigin, adminUrl, readSubmissions, writeSubmissions,
  getJobs: () => jobs, team, appStatuses: APP_STATUSES, uploadsDir: UPLOADS_DIR, events,
});
const reports = reportsModule.create({ readSubmissions, getJobs: () => jobs, getPlacements: () => billing.read(), team, appOwner });
const candidateAccounts = candidates.register(app, {
  db, mailer, baseUrl: BASE_URL, sameOrigin, limit, readSubmissions, writeSubmissions,
  uploadsDir: UPLOADS_DIR, getJobs: () => jobs, formatIst: interviews.formatIst, interviewIcs, site,
  contractsFor: (email) => timesheets.forCandidate(email),
  upload, saveApplication, isBot, isSample, isLive, resumeNeeded, skillMatch, saveSubmission, jobCategories, jobLocations,
  vetUpload: resumeCheck.vet, downloadLinks, linkExpired, jobTypes: JOB_TYPES, modes, stateOf: search.stateOf,
  interviewResponded: (...args) => atsDesk.interviewResponded(...args), events, notify,
  recommendFor: (...args) => recommendations.recommend(...args), analytics: siteAnalytics, push, privacy,
});

// Recommended jobs with match explanations, saved searches with daily or
// weekly alerts, and filling a profile from a resume (job-recommendations.js).
const describeFilters = (f) => {
  const level = search.EXPERIENCE_LEVELS.find((l) => l.key === f.experience);
  const group = JOB_GROUPS.find((g) => g.key === f.group);
  const work = WORK_KINDS.find((w) => w.key === f.work);
  const parts = [
    f.q && `“${f.q}”`, group && group.label, work && work.label, (f.categories || []).join(', '), f.location, f.mode, f.type,
    level && level.label, f.minPay && `₹${Number(f.minPay).toLocaleString('en-IN')}+ a month`, (f.skills || []).length && `Skills: ${f.skills.join(', ')}`,
    f.company, f.shift && `${f.shift} shift`,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ').slice(0, 150) : 'All jobs';
};
const recommendations = jobRecommendations.register(app, {
  readSubmissions, writeSubmissions, saveSubmission, sameOrigin, limit, site, getJobs: () => jobs, isLive, isSample, jobPath, events,
  parseFilters: (input) => jobFilters(input), matchesFilters: (job, f) => findJobs([job], { categories: [], ...f }).jobs.length > 0,
  searchHref: (f) => paginate([], { size: 1, query: filterQuery({ categories: [], ...f, sort: '' }), path: '/jobs' }).pager.urlFor(1), describeFilters,
  upload, vetUpload: resumeCheck.vet, resumes, allJobSkills, uploadsDir: UPLOADS_DIR, candidates: candidateAccounts.helpers,
});
// Daily and weekly saved-search emails that are due, every hour (SAVED_SEARCH_SCAN_MS for tests).
setInterval(() => { try { recommendations.digestScan(); } catch (e) { console.error('Saved search emails failed:', e.message); } }, Number(process.env.SAVED_SEARCH_SCAN_MS) || 60 * 60 * 1000).unref();

// Finding candidates who agreed to be found, for verified employers.
employerDiscovery.register(app, {
  readSubmissions, saveSubmission, sameOrigin, limit, site, getJobs: () => jobs, isLive, isSample, jobPath, clients, events, paginate,
  stateOf: search.stateOf, jobTypes: JOB_TYPES,
});

// Recruitment agency and staffing: contracts, requisitions, assignments, invoice drafts, reports.
const agencyDesk = agency.register(app, {
  db, team, clients, billing, readSubmissions, writeSubmissions, saveSubmission, getJobs: () => jobs, adminAuth, sameOrigin, limit, site, events,
  ownerOf: appOwner, hooks: placementHooks, requireEmployer: clients.requireEmployer, requireEmployerApi: clients.requireEmployerApi, can: employerCan,
});
// Workers after placement: onboarding, documents, shifts, attendance and timesheets.
const workforceDesk = workforce.register(app, {
  team, clients, billing, agency: agencyDesk, candidates: candidateAccounts, readSubmissions, writeSubmissions, saveSubmission, adminAuth, sameOrigin, limit, site, saveSite,
  notify, mailer, baseUrl: BASE_URL, uploadsDir: UPLOADS_DIR, downloadLinks, linkExpired, vetDocument: resumeCheck.vetDocument, hooks: placementHooks,
  requireEmployer: clients.requireEmployer, requireCandidate: candidateAccounts.requireCandidate, can: employerCan,
});
// The client's self-service portal: contract documents to sign, bulk hiring
// requests, shortlist answers, interviews, invoices, reports and the team.
clientPortal.register(app, {
  team, clients, billing, agency: agencyDesk, workforce: workforceDesk, readSubmissions, writeSubmissions, saveSubmission, adminAuth, sameOrigin, limit, site, mailer, baseUrl: BASE_URL,
  requireEmployer: clients.requireEmployer, requireEmployerApi: clients.requireEmployerApi, can: employerCan, getJobs: () => jobs, secret: db.metaGet('secret:links'),
});
// Hireriv's own sales CRM: leads, pipeline, follow-ups, proposals and the
// hand-over of won clients to recruitment.
const crmDesk = crm.register(app, {
  team, clients, billing, agency: agencyDesk, notify, mailer, site, limit, sameOrigin, adminAuth, readSubmissions, writeSubmissions, saveSubmission,
  baseUrl: BASE_URL, secret: db.metaGet('secret:links'), analytics: siteAnalytics,
});
leadCapture.capture = crmDesk.capture;

// Platform trust & safety: company checks, job moderation, complaint cases,
// appeals, the audit history, system health and access control.
const trustDesk = trust.register(app, {
  db, team, clients, hiring, getJobs: () => jobs, saveJobs, jobPath, readSubmissions, writeSubmissions, saveSubmission, adminAuth, sameOrigin, limit, isBot,
  mailer, notify, site, baseUrl: BASE_URL, uploadsDir: UPLOADS_DIR, downloadLinks, linkExpired, vetDocument: resumeCheck.vetDocument,
  candidateEmail: (req) => candidateAccounts.currentEmail(req), ops, backups,
});
trustHooks.reportJob = trustDesk.reportJob;
// Company verification with the representative and documents, public
// company pages and the labels candidates see (company-trust.js).
const companyTrust = require('./company-trust').register(app, {
  db, clients, getJobs: () => jobs, jobPath, readSubmissions, writeSubmissions, saveSubmission, sameOrigin, limit, isBot, mailer, site, baseUrl: BASE_URL,
  uploadsDir: UPLOADS_DIR, vetDocument: resumeCheck.vetDocument, trust: trustDesk, isLive,
});
trustHooks.labelsFor = companyTrust.labelsFor;

// The public API (/api/v1) for companies' own systems: credentials, tokens,
// scopes, signed webhooks, the sandbox and the developer portal (integrations.js).
require('./openapi').register(app, { baseUrl: BASE_URL, site, limit });
const integrationsDesk = require('./integrations').create({
  db, app, clients, hiring, getJobs: () => jobs, readSubmissions, limit, sameOrigin, adminAuth, mailer, site, baseUrl: BASE_URL, record: trustDesk.record, roles: agencyRoles,
  adminNav: (req) => ({ roleLabel: (agencyRoles.ROLE_INFO[req.admin.role] || {}).label || req.admin.role, can: (a) => agencyRoles.can(req.admin, a), strong: team.has2fa(req.admin.id) }),
});
integrationsDesk.tap(events, history);

// Security alerts, incidents, data requests and retention (security.js,
// privacy.js), on the trust & safety pages.
const protectView = (req, res, locals, status = 200) => {
  res.set('Cache-Control', 'no-store');
  res.status(status).render('admin-protect', {
    page: 'admin', noindex: true, admin: req.admin, errors: [], msg: String(req.query.msg || '').slice(0, 300), roleLabel: (agencyRoles.ROLE_INFO[req.admin.role] || {}).label || req.admin.role,
    can: (a) => agencyRoles.can(req.admin, a), strong: team.has2fa(req.admin.id), ...locals,
  });
};
securityDesk = securityModule.register(app, {
  db, security, team, adminAuth, sameOrigin, limit, trust: trustDesk, view: protectView, readSubmissions,
  rotateDownloadLinks: () => db.metaSet('secret:links', crypto.randomBytes(32).toString('hex')),
});
const { requireConfirmed } = securityDesk;
privacyModule.register(app, {
  db, privacy, mailer, notify, site, baseUrl: BASE_URL, team, adminAuth, sameOrigin, limit, isBot, trust: trustDesk, view: protectView, requireConfirmed,
  candidates: candidateAccounts, deleteCandidate: (email) => candidateAccounts.deleteEverything(String(email).toLowerCase()), retention, readSubmissions,
  setCandidateMonths: (months, user) => {
    site.retentionMonths = months;
    saveSite();
    team.log(user, months ? `Turned on data retention: ${months} months` : 'Turned off data retention');
    if (months) retention.run();
  },
});
// Accounts deleted before an older backup was restored are deleted again.
{
  const replayed = privacy.replayErasures((email) => candidateAccounts.deleteEverything(email));
  if (replayed) console.log(`Applied ${replayed} earlier account deletion${replayed === 1 ? '' : 's'} again after a restore`);
}

// Employer plans, online payments, invoices, refunds and reconciliation
// (subscriptions.js, billing-routes.js). The gateway's keys come only from the
// environment and stay on the server.
const gateway = paymentGateway.fromEnv(process.env);
const plansStore = subscriptions.create({ db, site, gateway, validGstin: employers.validGstin });
plansStore.seedPlans();
hiring.hooks.jobLimit = (emp) => plansStore.limitsOf(emp).jobs;
clients.hooks.seatLimit = (emp) => plansStore.limitsOf(emp).seats;
const billingDesk = billingRoutes.register(app, {
  db, site, mailer, notify, store: plansStore, gateway, team, clients, placements: billing, getJobs: () => jobs, adminAuth, sameOrigin, limit, requireConfirmed,
  trust: trustDesk, baseUrl: BASE_URL, sendCsv, ops,
});
if (gateway.ready && process.env.NODE_ENV === 'production' && gateway.sandbox) console.warn('Payments: using the provider sandbox (test keys) on the live site');
if (gateway.ready && !gateway.webhooks) console.warn('Payments: set the webhook secret so payments confirmed by the provider are recorded even if the browser closes');
const runBilling = ops.track('billing-renewals', () => billingDesk.daily(), 6 * 60 * 60 * 1000);
setTimeout(() => runBilling().catch((e) => console.error('Billing renewals:', e.message)), Number(process.env.BILLING_DELAY_MS) || 30000).unref();
setInterval(() => runBilling().catch((e) => console.error('Billing renewals:', e.message)), Number(process.env.BILLING_EVERY_MS) || 6 * 60 * 60 * 1000).unref();

// Recruitment analytics: dashboards for the team and for each employer, the
// /api/analytics/* reports and their CSV exports (analytics.js).
analytics.register(app, {
  readSubmissions, getJobs: () => jobs, billing, team, clients, agency: agencyDesk, appOwner, siteAnalytics, trust: trustDesk, ops,
  limit, adminAuth, requireEmployer: clients.requireEmployer, sendCsv,
});

// Website conversion counts for the team (Admins, recruitment and sales managers).
app.get('/admin/site-analytics', adminAuth, (req, res) => {
  if (!agencyRoles.can(req.admin, 'site.analytics')) return res.status(403).render('thanks', { title: 'Not part of your role', page: '', ok: false, message: 'Your role does not include website analytics.', noindex: true });
  res.render('admin-site-analytics', { title: 'Website analytics', page: 'admin', noindex: true, admin: req.admin, report: siteAnalytics.report(req.query), roleLabel: (agencyRoles.ROLE_INFO[req.admin.role] || {}).label || req.admin.role, can: (a) => agencyRoles.can(req.admin, a) });
});

// The notification center, its API, preferences, job alerts and delivery reports.
const center = notificationCenter.register(app, {
  notify, push, team, clients: () => clients, candidates: () => candidateAccounts, getJobs: () => jobs, sameOrigin, limit, readSubmissions, writeSubmissions, saveSubmission,
  jobCategories, jobLocations, adminAuth, requireAdmin, siteName: site.name, analytics: siteAnalytics, privacy,
});
// The worker sends queued emails (and retries failed ones); scheduled checks
// find feedback that is due and offers about to expire; old records go.
if (process.env.NOTIFY_WORKER !== 'off') notify.start();
const pruneNotifications = ops.track('notification-prune', () => notify.prune(), 24 * 3600000);
pruneNotifications();
setInterval(pruneNotifications, 24 * 3600000).unref();
const scanEvents = ops.track('scheduled-reminders', () => events.scan(todayIst), 60 * 60 * 1000);
setTimeout(scanEvents, 60 * 1000).unref();
setInterval(scanEvents, 60 * 60 * 1000).unref();
// Candidates who turned off "let recruiters find me" stay out of the Talent pool.
const searchableApplications = (list) => {
  const hidden = candidateAccounts.hiddenFromSearch();
  return hidden.size ? list.filter((a) => !hidden.has(String(a.email).toLowerCase())) : list;
};
// Accounts whose applications were all removed (e.g. by data retention) go too.
const pruneAccounts = ops.track('candidate-account-prune', () => candidateAccounts.pruneAccounts(), 24 * 60 * 60 * 1000);
pruneAccounts();
setInterval(pruneAccounts, 24 * 60 * 60 * 1000).unref();
const timesheets = timesheetsModule.register(app, {
  db, mailer, baseUrl: BASE_URL, sameOrigin, limit, adminAuth, requireAdmin, clients,
  requireCandidate: candidateAccounts.requireCandidate, requireEmployer: clients.requireEmployer,
});

// The team adds people who applied by WhatsApp, phone call, walk-in or referral.
const addCandidatePage = (req, res, f, errors, status = 200) =>
  res.status(status).render('admin-add-candidate', { title: 'Add a candidate', page: 'admin', f, errors, jobs: openJobs(), channels: reportsModule.MANUAL_SOURCES });

app.get('/admin/applications/new', adminAuth, (req, res) =>
  addCandidatePage(req, res, { jobId: String(req.query.job || ''), source: 'whatsapp-chat' }, []));

app.post('/admin/applications/new', adminAuth, sameOrigin, (req, res) => {
  upload.single('resume')(req, res, (err) => {
    const f = clean(req.body, ['jobId', ...APPLICATION_FIELDS, 'source', 'notes']);
    const errors = err ? [err.code === 'LIMIT_FILE_SIZE' ? 'resume must be under 5 MB' : err.message] : validate(f, ['name', 'phone']);
    const job = openJobs().find((j) => j.id === f.jobId);
    if (f.jobId && !job) errors.push('pick an open job, or General application');
    if (!reportsModule.MANUAL_SOURCES[f.source]) errors.push('choose how they reached us');
    if (errors.length) {
      if (req.file) fs.unlink(req.file.path, () => {});
      return addCandidatePage(req, res, f, errors, 400);
    }
    const data = { jobId: job ? job.id : 'general', source: f.source };
    for (const k of APPLICATION_FIELDS) data[k] = f[k];
    const extra = { addedBy: req.admin.name, addedById: req.admin.id, addedVia: reportsModule.MANUAL_SOURCES[f.source], notes: f.notes };
    resumeCheck.vet(req.file).then((bad) => {
      if (bad) return addCandidatePage(req, res, f, [bad], 400);
      return saveApplication(data, req.file, job, extra).then(({ app, updated }) => {
      if (updated && f.notes) {
        const list = readSubmissions('applications');
        const a = list.find((x) => x.id === app.id);
        a.notes = [a.notes, f.notes].filter(Boolean).join('\n');
        writeSubmissions('applications', list);
      }
      res.redirect(adminUrl('applications', updated ? `${data.name} had already applied for ${app.jobTitle}, so their application was updated` : `Added ${data.name} for ${app.jobTitle}`));
      });
    }).catch((e) => {
      console.error(e);
      addCandidatePage(req, res, f, ['could not save, please try again'], 500);
    });
  });
});

app.get('/admin', adminAuth, (req, res) => {
  if (agencyRoles.SALES_ROLES.includes(req.admin.role)) return res.redirect('/admin/crm');
  if (agencyRoles.TRUST_ROLES.includes(req.admin.role)) return res.redirect('/admin/overview');
  const tabs = tabsFor(req.admin);
  const tab = tabs.includes(req.query.tab) ? req.query.tab : tabs.includes('dashboard') ? 'dashboard' : tabs[0];
  const applications = readSubmissions('applications');
  const counts = { dashboard: '', reports: '', settings: '', activity: '', templates: templates.read().length, team: team.members().length, blog: posts.length, interviews: interviews.upcoming(applications).length, placements: billing.read().length, clients: clients.read().length, jobs: jobs.length, talent: new Set(applications.map((a) => String(a.email).toLowerCase())).size, ...Object.fromEntries(FORM_TYPES.map((t) => [t, readSubmissions(t).length])) };
  const members = team.members();
  const memberName = Object.fromEntries(members.map((u) => [u.id, u.name]));
  const tabGroups = TAB_GROUPS.map(([label, list]) => [label, list.filter((t) => tabs.includes(t))]).filter(([, list]) => list.length);
  const locals = { title: 'Admin', page: 'admin', tab, tabs, tabGroups, tabLabels: TAB_LABELS, counts, status: '', msg: String(req.query.msg || ''), members, memberName, pager: null };
  // Long tables are shown 50 rows at a time; CSV exports still include everything.
  const pageOf = (list) => paginate(list, { page: req.query.page, size: ADMIN_PAGE_SIZE, query: req.query, path: '/admin' });

  if (tab === 'dashboard') return res.render('admin', { ...locals, rows: [], dash: buildDashboard(applications, req.admin), setupTodo: req.admin.role === 'Admin' ? setupTodo() : [] });
  if (tab === 'team') return res.render('admin', { ...locals, rows: team.list(), roles: team.ROLES, roleInfo: agencyRoles.ROLE_INFO, requires2fa: team.requires2fa(), my2fa: team.has2fa(req.admin.id) });
  if (tab === 'templates') return res.render('admin', { ...locals, rows: templates.read(), placeholders: bulk.PLACEHOLDERS });
  if (tab === 'reports') return res.render('admin', { ...locals, rows: [], report: reports.build({ period: String(req.query.period || ''), isAdmin: agencyRoles.can(req.admin, 'money.view') }), inr: billing.inr });
  if (tab === 'activity') {
    const who = String(req.query.user || '');
    const { rows, pager } = pageOf(team.activity({ userId: who }));
    return res.render('admin', { ...locals, rows, pager, who, people: team.list() });
  }
  if (tab === 'jobs') {
    const applicants = {};
    for (const a of applications) applicants[a.jobId] = (applicants[a.jobId] || 0) + 1;
    const owner = ownerFilter(req);
    const { rows, pager } = pageOf(owner ? jobs.filter((j) => matchesOwner(j.ownerId || '', owner, req.admin)) : jobs);
    return res.render('admin', { ...locals, rows, pager, applicants, owner, isStaleJob, jobAgeDays, staleDays: STALE_JOB_DAYS });
  }
  if (tab === 'applications') {
    const placedApps = new Set(billing.read().map((p) => p.appId));
    const statusOf = (a) => a.status || 'New';
    const statusCounts = Object.fromEntries(APP_STATUSES.map((s) => [s, applications.filter((a) => statusOf(a) === s).length]));
    const status = APP_STATUSES.includes(req.query.status) ? req.query.status : '';
    const sort = req.query.sort === 'match' ? 'match' : '';
    const owner = ownerFilter(req);
    let all = (status ? applications.filter((a) => statusOf(a) === status) : applications)
      .map((a) => ({ ...a, owner: appOwner(a), match: skillMatch(a, jobs.find((j) => j.id === a.jobId)) }))
      .filter((a) => !owner || matchesOwner(a.owner, owner, req.admin));
    if (sort) all = all.sort((a, b) => (b.match?.score ?? -1) - (a.match?.score ?? -1));
    const { rows, pager } = pageOf(all);
    for (const a of rows) a.timeline = history.timeline(a); // only for the rows on screen
    return res.render('admin', { ...locals, rows, pager, owner, statuses: APP_STATUSES, statusCounts, status, sort, clientOptions: clients.read().filter((c) => c.active), placedApps, templates: templates.read(), backUrl: req.originalUrl.replace(/&msg=[^&]*/, ''), jobClient: Object.fromEntries(jobs.map((j) => [j.id, j.employerId || ''])) });
  }
  if (tab === 'blog') return res.render('admin', { ...locals, rows: posts });
  if (tab === 'clients') {
    const money = billing.byClient();
    const rows = clients.read().map((c) => ({ ...c, jobCount: jobs.filter((j) => j.employerId === c.id).length, requestCount: readSubmissions('hire-requests').filter((h) => h.employerId === c.id).length, money: money[c.id] || null }));
    return res.render('admin', { ...locals, rows, inr: billing.inr });
  }
  if (tab === 'interviews') {
    const up = interviews.upcoming(applications);
    const past = interviews.allInterviews(applications).filter((iv) => !up.some((u) => u.id === iv.id)).sort((a, b) => b.at.localeCompare(a.at));
    return res.render('admin', { ...locals, rows: up, past, due: interviews.feedbackDue(applications), formatIst: interviews.formatIst });
  }
  if (tab === 'placements') {
    const all = billing.read().map(billing.describe);
    const view = ['awaiting', 'guarantee', 'to-invoice', 'contracts', 'unpaid', 'overdue'].includes(req.query.view) ? req.query.view : '';
    const test = {
      awaiting: (p) => p.status === 'Awaiting joining',
      guarantee: (p) => p.inGuarantee,
      'to-invoice': billing.needsInvoice,
      unpaid: (p) => p.invoices.some((x) => ['Unpaid', 'Part paid'].includes(x.inv.status)),
      overdue: (p) => p.invoices.some((x) => x.overdue),
      contracts: (p) => p.feeMode === 'monthly',
    }[view];
    const hired = applications.filter((a) => a.status === 'Hired' && !all.some((p) => p.appId === a.id));
    const { rows, pager } = pageOf(test ? all.filter(test) : all);
    return res.render('admin', { ...locals, rows, pager, view, sum: billing.summary(all), statuses: billing.STATUSES, inr: billing.inr, formatYmd: placements.formatYmd, unrecorded: hired, clientById: Object.fromEntries(clients.read().map((c) => [c.id, c])), nameById: Object.fromEntries(all.map((p) => [p.id, p.candidateName])), monthLabel: billing.monthLabel });
  }
  if (tab === 'settings') return res.render('admin', { ...locals, rows: [], form: { ...site, jobCategories: jobCategories(), jobLocations: site.jobLocations || DEFAULT_JOB_LOCATIONS }, errors: [], social: SOCIAL, billingForm: placements.billingOf(site), retentionPreview: retentionPreviews(), backups: { status: backups.status(), list: backups.list(), dir: backups.dir, keep: backups.keep } });
  if (tab === 'talent') {
    const EXPERIENCE = ['Fresher', '0-1 years', '1-3 years', '3-5 years', '5-10 years', '10+ years'];
    const NOTICE = ['Immediate', '15 days', '30 days', '60 days', '90 days'];
    const f = {
      q: String(req.query.q || '').slice(0, 100),
      experience: EXPERIENCE.includes(req.query.experience) ? req.query.experience : '',
      notice: NOTICE.includes(req.query.notice) ? req.query.notice : '',
      status: APP_STATUSES.includes(req.query.status) ? req.query.status : '',
      jobId: String(req.query.job || ''),
    };
    const job = jobs.find((j) => j.id === f.jobId) || null;
    const { rows, pager } = pageOf(searchPool(buildPool(searchableApplications(applications)), { ...f, job }));
    const unread = applications.filter((a) => a.resume && a.resumeText === undefined).length;
    return res.render('admin', { ...locals, rows, pager, f, unread, matchJob: job, jobOptions: jobs, statuses: APP_STATUSES, experienceOptions: EXPERIENCE, noticeOptions: NOTICE });
  }
  const { rows, pager } = pageOf(readSubmissions(tab));
  res.render('admin', { ...locals, rows, pager });
});

// ----- dashboard -----
const DAY_MS = 86400000;
// Day buckets follow India time so "today" matches the recruiters' calendar.
const dayKey = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

function buildDashboard(applications, user) {
  const hires = readSubmissions('hire-requests');
  const contacts = readSubmissions('contacts');
  const alerts = readSubmissions('job-alerts');
  const weekAgo = Date.now() - 7 * DAY_MS;
  const lastWeek = (list) => list.filter((s) => new Date(s.createdAt) >= weekAgo).length;
  const statusOf = (a) => a.status || 'New';

  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * DAY_MS);
    days.push({ key: dayKey(d), label: d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }), count: 0 });
  }
  const byKey = Object.fromEntries(days.map((d) => [d.key, d]));
  for (const a of applications) if (byKey[dayKey(a.createdAt)]) byKey[dayKey(a.createdAt)].count++;

  const perJob = {};
  for (const a of applications) perJob[a.jobId] = (perJob[a.jobId] || 0) + 1;
  const topJobs = Object.entries(perJob)
    .map(([id, count]) => ({ id, count, job: jobs.find((j) => j.id === id) }))
    .filter((t) => t.job)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const recent = [
    ...applications.map((s) => ({ at: s.createdAt, kind: 'Application', text: `${s.name} applied for ${s.jobTitle}`, tab: 'applications' })),
    ...hires.map((s) => ({ at: s.createdAt, kind: 'Hiring request', text: `${s.company} needs ${s.roles}`, tab: 'hire-requests' })),
    ...contacts.map((s) => ({ at: s.createdAt, kind: 'Message', text: `${s.name}: ${s.subject || s.message}`, tab: 'contacts' })),
    ...alerts.filter((s) => s.confirmed).map((s) => ({ at: s.confirmedAt || s.createdAt, kind: 'Job alert', text: `${s.email} subscribed`, tab: 'job-alerts' })),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 8);

  const money = billing.summary();
  const isAdmin = user.role === 'Admin';
  const mine = applications.filter((a) => appOwner(a) === user.id && !['Hired', 'Rejected'].includes(statusOf(a)));
  return {
    kpis: [
      ...(isAdmin ? [] : [{ label: 'My candidates', value: mine.length, note: `${mine.filter((a) => statusOf(a) === 'New').length} new to review`, tab: 'applications&owner=me' }]),
      { label: 'Open jobs', value: openJobs().length, note: jobs.some(isStaleJob) ? `${jobs.filter(isStaleJob).length} open ${STALE_JOB_DAYS}+ days` : `${jobs.length - openJobs().length} closed`, tab: 'jobs', alert: jobs.some(isStaleJob) },
      { label: 'Applications', value: applications.length, note: `+${lastWeek(applications)} this week`, tab: 'applications' },
      { label: 'In progress', value: applications.filter((a) => ['Screening', 'Shortlisted', 'Interview', 'Offered', 'On hold'].includes(statusOf(a))).length, note: `${applications.filter((a) => statusOf(a) === 'New').length} new to review`, tab: 'applications' },
      { label: 'Hired', value: applications.filter((a) => statusOf(a) === 'Hired').length, note: 'placements', tab: 'applications' },
      { label: 'Hiring requests', value: hires.length, note: `+${lastWeek(hires)} this week`, tab: 'hire-requests' },
      { label: 'Alert subscribers', value: alerts.filter((a) => a.confirmed).length, note: `${alerts.filter((a) => !a.confirmed).length} unconfirmed`, tab: 'job-alerts' },
      ...(!isAdmin ? [] : [{ label: `Billed FY ${money.fy}`, value: money.billedFy, display: billing.inr(money.billedFy), note: `${money.toInvoice} placement${money.toInvoice === 1 ? '' : 's'} to invoice`, tab: 'placements' },
      { label: 'Outstanding', value: money.outstanding, display: billing.inr(money.outstanding), note: money.overdueCount ? `${money.overdueCount} overdue` : `${money.unpaidCount} unpaid invoice${money.unpaidCount === 1 ? '' : 's'}`, tab: 'placements&view=unpaid', alert: money.overdueCount > 0 }]),
    ],
    // Recruiters see joinings, guarantees and replacements, not money.
    followUps: billing.followUps().filter((f) => isAdmin || ['Joining', 'Confirm joining', 'Guarantee ends', 'Find replacement'].includes(f.kind)),
    days,
    funnel: APP_STATUSES.map((s) => ({ status: s, count: applications.filter((a) => statusOf(a) === s).length })),
    topJobs,
    recent,
    interviews: interviews.upcoming(applications, 5),
    feedbackDue: interviews.feedbackDue(applications).slice(0, 5),
  };
}

// ----- jobs -----
function parseJob(body) {
  const data = clean(body, ['title', 'company', 'location', 'mode', 'type', 'category', 'experience', 'salary', 'payNote', 'education', 'schedule', 'shift', 'hours', 'openings', 'address', 'eligibility', 'mustHave', 'physical', 'skills', 'description', 'responsibilities', 'qualifications', 'benefits', 'status', 'overtime', 'workerCosts']);
  const errors = [];
  for (const f of ['title', 'company', 'location', 'category', 'description']) if (!data[f]) errors.push(`${f} is required`);
  if (data.category && !jobCategories().includes(data.category)) errors.push('pick a category from the list (add new ones in Settings)');
  if (data.location && !jobLocations().includes(data.location)) errors.push('pick a location from the list (add new ones in Settings)');
  if (!modes.includes(data.mode)) errors.push('work mode is invalid');
  if (!JOB_TYPES.includes(data.type)) errors.push('job type is invalid');
  // Pay as numbers. A plain salary text (older forms, imports) is still read.
  const typedPay = ['salaryMin', 'salaryMax'].some((k) => String(body[k] ?? '').trim());
  const parsed = typedPay ? search.parsePayFields(body) : { pay: data.salary ? search.payFromText(data.salary) : null, errors: [] };
  errors.push(...parsed.errors);
  const payNote = typedPay || !data.salary || parsed.pay ? data.payNote.slice(0, 120) : data.salary.slice(0, 120);
  const lines = (s) => s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).slice(0, 20);
  const closesOn = String(body.closesOn || '').trim();
  if (closesOn && (!/^\d{4}-\d{2}-\d{2}$/.test(closesOn) || Number.isNaN(Date.parse(closesOn)))) errors.push('closing date is invalid');
  else if (closesOn && data.status !== 'closed' && closesOn < todayIst()) errors.push('closing date is in the past (pick a later date, or leave it blank to keep the job open)');
  if (data.shift && !SHIFTS.includes(data.shift)) errors.push(`shift must be one of: ${SHIFTS.join(', ')}`);
  if (data.openings && !(/^\d{1,4}$/.test(data.openings) && Number(data.openings) >= 1)) errors.push('number of openings must be a whole number from 1 to 9999');
  const walkIn = ['1', 'on', 'true'].includes(String(body.walkIn ?? ''));
  if (walkIn && !data.address) errors.push('add the workplace address for walk-in interviews');
  const job = {
    title: data.title,
    company: data.company,
    location: data.location,
    mode: data.mode,
    type: data.type,
    category: data.category,
    // Empty means "from the category", so re-categorising a job moves it too.
    work: WORK_KEYS.includes(body.work) ? body.work : '',
    // Empty means "from the kind of work": required for office jobs, optional otherwise.
    resume: RESUME_OPTIONS.includes(body.resume) ? body.resume : '',
    experience: data.experience,
    pay: parsed.pay,
    payNote,
    salary: !typedPay && data.salary && parsed.pay ? data.salary : salaryText(parsed.pay, payNote),
    education: data.education.slice(0, 200),
    schedule: data.schedule.slice(0, 200),
    shift: data.shift,
    hours: data.hours.slice(0, 120),
    // Overtime (when and how it is paid) and anything the worker pays for
    // (uniform, tools, food, a room), stated up front.
    overtime: data.overtime.slice(0, 200),
    workerCosts: data.workerCosts.slice(0, 300),
    openings: data.openings ? Number(data.openings) : null,
    address: data.address.slice(0, 300),
    walkIn,
    eligibility: lines(data.eligibility),
    // Must-haves shown apart from the match score: licences or certificates
    // the work legally or practically needs, starting straight away, and
    // physical demands that are genuinely part of the job.
    mustHave: lines(data.mustHave).slice(0, 10).map((x) => x.slice(0, 80)),
    immediate: ['1', 'on', 'true'].includes(String(body.immediate ?? '')),
    physical: data.physical.slice(0, 200),
    qualifications: lines(data.qualifications),
    benefits: lines(data.benefits),
    skills: data.skills.split(',').map((s) => s.trim()).filter(Boolean),
    description: data.description,
    responsibilities: data.responsibilities.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
    status: data.status === 'closed' ? 'closed' : 'open',
    closesOn: closesOn || null,
    employerId: clients.read().some((c) => c.id === body.employerId) ? body.employerId : '',
    ownerId: validOwner(String(body.ownerId || '')),
  };
  // Shown back on the form when there are errors.
  if (errors.length) job.payForm = { salaryMin: String(body.salaryMin ?? ''), salaryMax: String(body.salaryMax ?? ''), salaryPeriod: String(body.salaryPeriod ?? '') };
  return { job, errors };
}

const alertedNote = (n) => (n ? ` · job alert sent to ${n} subscriber${n === 1 ? '' : 's'}` : '');

function nextJobId() {
  const max = jobs.reduce((n, j) => Math.max(n, Number((j.id.match(/^hr-(\d+)$/) || [])[1]) || 0), 100);
  return `hr-${max + 1}`;
}

const jobFormLocals = (job, errors) => ({
  title: job.id ? 'Edit job' : 'Post a job', page: 'admin', job, errors, modes, jobTypes: JOB_TYPES, jobCategories: jobCategories(), categoryGroups: groupCategories(jobCategories()), workKinds: WORK_KINDS, jobLocations: jobLocations(), clientOptions: clients.read(), members: team.members(),
});

app.get('/admin/jobs/new', adminAuth, (req, res) =>
  res.render('admin-job', jobFormLocals({ mode: 'On-site', type: 'Full-time', status: 'open', skills: [], responsibilities: [], ownerId: req.admin.id }, []))
);

app.get('/admin/jobs/:id/edit', adminAuth, (req, res, next) => {
  const job = jobs.find((j) => j.id === req.params.id);
  if (!job) return next();
  res.render('admin-job', jobFormLocals(job, []));
});

app.post('/admin/jobs', adminAuth, sameOrigin, (req, res) => {
  const { job, errors } = parseJob(req.body);
  if (errors.length) return res.status(400).render('admin-job', jobFormLocals(job, errors));
  const created = { id: nextJobId(), ...job, posted: todayIst() };
  jobs.push(created);
  const alerted = sendJobAlerts(created);
  saveJobs();
  res.redirect(adminUrl('jobs', `Posted "${created.title}"${alertedNote(alerted)}`));
});

app.post('/admin/jobs/:id', adminAuth, sameOrigin, (req, res, next) => {
  const existing = jobs.find((j) => j.id === req.params.id);
  if (!existing) return next();
  const { job, errors } = parseJob(req.body);
  if (errors.length) return res.status(400).render('admin-job', jobFormLocals({ ...job, id: existing.id }, errors));
  Object.assign(existing, job, { sample: false }); // edited by the team, so a real job now
  if (existing.status === 'open') delete existing.closedReason;
  const alerted = sendJobAlerts(existing);
  saveJobs();
  res.redirect(adminUrl('jobs', `Saved "${existing.title}"${alertedNote(alerted)}`));
});

app.post('/admin/jobs/:id/toggle', adminAuth, sameOrigin, (req, res, next) => {
  const job = jobs.find((j) => j.id === req.params.id);
  if (!job) return next();
  // Restricted or removed by trust & safety: changed only from its case or an appeal.
  if (job.moderation && job.moderation.locked) return res.redirect(adminUrl('jobs', `"${job.title}" was ${job.moderation.state === 'removed' ? 'removed' : 'restricted'} by trust & safety: change it from Job moderation`));
  // Drafts and jobs waiting for review go live through approval, not here.
  if (['draft', 'pending', 'rejected'].includes(job.status)) return res.redirect(adminUrl('jobs', `"${job.title}" is ${job.status === 'pending' ? 'waiting for review: approve or send it back' : 'not published yet'}`));
  job.status = job.status === 'open' ? 'closed' : 'open';
  if (job.status === 'open') delete job.pausedAt;
  // Reopening a job whose closing date has passed would close it again at once.
  const clearedDate = job.status === 'open' && job.closesOn && job.closesOn < todayIst();
  if (clearedDate) job.closesOn = null;
  if (job.status === 'open') delete job.closedReason;
  const alerted = sendJobAlerts(job);
  saveJobs();
  res.redirect(adminUrl('jobs', `${job.status === 'open' ? 'Reopened' : 'Closed'} "${job.title}"${clearedDate ? ' and removed its past closing date (set a new one with Edit)' : ''}${alertedNote(alerted)}`));
});

app.post('/admin/jobs/:id/delete', adminAuth, requireAdmin, sameOrigin, (req, res, next) => {
  const job = jobs.find((j) => j.id === req.params.id);
  if (!job) return next();
  jobs = jobs.filter((j) => j !== job);
  saveJobs();
  res.redirect(adminUrl('jobs', `Deleted "${job.title}"`));
});

// ----- site settings -----
// `site` is shared by every view (app.locals) and the mailer, so it is updated in place.
app.post('/admin/settings', adminAuth, requireAdmin, sameOrigin, (req, res) => {
  const { settings, errors } = parseSettings(req.body, site);
  // Matching weights, when the form includes them (older forms keep the current ones).
  if (req.body.match_skills !== undefined) {
    const w = jobMatch.parseWeights(Object.fromEntries(jobMatch.FACTORS.map((f) => [f.key, req.body[`match_${f.key}`]])));
    errors.push(...w.errors);
    settings.matchWeights = w.weights;
  }
  if (errors.length) {
    return res.status(400).render('admin', { title: 'Admin', page: 'admin', tab: 'settings', tabs: tabsFor(req.admin), counts: {}, members: team.members(), memberName: {}, status: '', msg: '', rows: [], form: settings, errors, social: SOCIAL, retentionPreview: retentionPreviews(), backups: { status: backups.status(), list: backups.list(), dir: backups.dir, keep: backups.keep }, billingForm: Object.fromEntries(Object.entries(placements.billingOf(settings)).map(([k, v]) => [k, Number.isNaN(v) ? '' : v])) });
  }
  const retentionChanged = settings.retentionMonths !== (site.retentionMonths || 0);
  const weightsChanged = JSON.stringify(jobMatch.weightsOf(settings)) !== JSON.stringify(jobMatch.weightsOf(site));
  Object.assign(site, settings);
  if (weightsChanged) team.log(req.admin, `Changed job matching weights: ${jobMatch.FACTORS.map((f) => `${f.label} ${site.matchWeights[f.key]}%`).join(', ')}`);
  saveSite();
  if (retentionChanged) team.log(req.admin, site.retentionMonths ? `Turned on data retention: ${site.retentionMonths} months` : 'Turned off data retention');
  const cleaned = retentionChanged && site.retentionMonths ? retention.run() : null;
  res.redirect(adminUrl('settings', `Settings saved. The website is updated.${cleaned ? ` Data retention removed ${cleaned.candidates} candidate${cleaned.candidates === 1 ? '' : 's'}, ${cleaned.messages} message${cleaned.messages === 1 ? '' : 's'} and ${cleaned.requests} hiring request${cleaned.requests === 1 ? '' : 's'}.` : ''}`));
});

// What each retention period would delete today, shown next to the choice.
const retentionPreviews = () => Object.fromEntries(retentionModule.PERIODS.filter(Boolean).map((m) => [m, retention.preview(m)]));

// ----- blog -----
const postFormLocals = (post, errors) => ({ title: post.slug && post._editing ? 'Edit article' : 'Write an article', page: 'admin', post, errors });

app.get('/admin/blog/new', adminAuth, (req, res) =>
  res.render('admin-post', postFormLocals({ date: todayIst(), status: 'published', body: [] }, []))
);

app.get('/admin/blog/:slug/edit', adminAuth, (req, res, next) => {
  const post = posts.find((p) => p.slug === req.params.slug);
  if (!post) return next();
  res.render('admin-post', postFormLocals({ ...post, _editing: post.slug }, []));
});

app.post('/admin/blog', adminAuth, sameOrigin, (req, res) => {
  const { post, errors } = parsePost(req.body, posts, null);
  if (errors.length) return res.status(400).render('admin-post', postFormLocals(post, errors));
  posts.push(post);
  savePosts();
  res.redirect(adminUrl('blog', `${post.status === 'draft' ? 'Saved draft' : 'Published'} "${post.title}"`));
});

app.post('/admin/blog/:slug', adminAuth, sameOrigin, (req, res, next) => {
  const existing = posts.find((p) => p.slug === req.params.slug);
  if (!existing) return next();
  const { post, errors } = parsePost(req.body, posts, existing.slug);
  if (errors.length) return res.status(400).render('admin-post', postFormLocals({ ...post, _editing: existing.slug }, errors));
  Object.assign(existing, post);
  savePosts();
  res.redirect(adminUrl('blog', `Saved "${existing.title}"`));
});

app.post('/admin/blog/:slug/delete', adminAuth, requireAdmin, sameOrigin, (req, res, next) => {
  const i = posts.findIndex((p) => p.slug === req.params.slug);
  if (i === -1) return next();
  const [removed] = posts.splice(i, 1);
  savePosts();
  res.redirect(adminUrl('blog', `Deleted "${removed.title}"`));
});

// ----- submissions -----
app.post('/admin/applications/:id/status', adminAuth, sameOrigin, (req, res, next) => {
  const list = readSubmissions('applications');
  const entry = list.find((a) => a.id === req.params.id);
  if (!entry) return next();
  const { status, notes, notify, ownerId } = clean(req.body, ['status', 'notes', 'notify', 'ownerId']);
  if (!APP_STATUSES.includes(status)) return res.status(400).send('Invalid status');
  const changed = history.moveStage(entry, status, req.admin.name, undefined, { actor: 'team', userId: req.admin.id });
  Object.assign(entry, { notes, updatedAt: new Date().toISOString() });
  // "job" means follow the job's owner; otherwise a named team member.
  const before = entry.ownerId || '';
  if (ownerId !== undefined && req.body.ownerId !== undefined) entry.ownerId = ownerId === 'job' ? '' : validOwner(ownerId) || entry.ownerId || '';
  let emailed = false;
  db.transaction(() => {
    // Email the candidate only on a real stage change the recruiter opted into.
    emailed = changed && notify === '1' && events.statusEmail(entry);
    if (emailed) entry.lastEmailedStatus = status;
    writeSubmissions('applications', list);
    const job = jobs.find((j) => j.id === entry.jobId);
    if (job && entry.ownerId && entry.ownerId !== before) events.assigned(entry, job, entry.ownerId, req.admin.id);
  });
  const back = req.body.filter && APP_STATUSES.includes(req.body.filter) ? `&status=${encodeURIComponent(req.body.filter)}` : '';
  res.redirect(adminUrl('applications', `${entry.name} moved to ${status}${emailed ? ' (candidate emailed)' : ''}`) + back);
});

app.post('/admin/:type/:id/delete', adminAuth, requireAdmin, sameOrigin, (req, res, next) => {
  const { type, id } = req.params;
  if (!FORM_TYPES.includes(type)) return next();
  const list = readSubmissions(type);
  const entry = list.find((s) => s.id === id);
  if (!entry) return next();
  writeSubmissions(type, list.filter((s) => s !== entry));
  if (entry.resume) fs.unlink(path.join(UPLOADS_DIR, path.basename(entry.resume)), () => {});
  res.redirect(adminUrl(type, 'Deleted 1 entry'));
});

// Full database snapshot (VACUUM INTO) for backups; safe while the site runs.
app.get('/admin/backup', adminAuth, requireAdmin, requireConfirmed, security.bulkExport('Full database'), (req, res) => {
  team.log(req.admin, 'Downloaded the database');
  const file = path.join(require('os').tmpdir(), `hireriv-backup-${Date.now()}.db`);
  db.backupTo(file);
  res.download(file, `hireriv-${new Date().toISOString().slice(0, 10)}.db`, () => fs.unlink(file, () => {}));
});

// Automatic backups: download any kept copy, or take one now.
app.get('/admin/backups/:name', adminAuth, requireAdmin, requireConfirmed, security.bulkExport((req) => `Backup ${req.params.name}`), (req, res, next) => {
  const file = backups.fileFor(req.params.name);
  if (!file) return next();
  team.log(req.admin, 'Downloaded a database backup', req.params.name);
  res.download(file, req.params.name);
});
app.post('/admin/backups/run', adminAuth, requireAdmin, sameOrigin, (req, res) => {
  const r = backups.run();
  team.log(req.admin, 'Took a database backup', r.ok ? r.name : r.error);
  res.redirect(`${adminUrl('settings', r.ok ? `Backup saved: ${r.name}` : `Backup failed: ${r.error}`)}#backups`);
});

app.get('/admin/reports/:section.csv', adminAuth, (req, res, next) => {
  const report = reports.build({ period: String(req.query.period || ''), isAdmin: req.admin.role === 'Admin' });
  const rows = reports.csv(req.params.section, report);
  if (!rows) return next();
  sendCsv(res, `report-${req.params.section}-${report.period.key}`, rows);
});

// Leading = + - @ would be run as a formula by Excel/Sheets, so neutralise it.
function csvCell(v) {
  let s = Array.isArray(v) ? v.join('; ') : String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Exports with personal data need the password again (security.js), are
// limited, and each one is in the security log.
const exportGuard = (req, res, next) => (req.params.type === 'jobs' ? next() : requireConfirmed(req, res, next));
app.get('/admin/export/:type.csv', adminAuth, (req, res, next) => {
  const { type } = req.params;
  if (!ADMIN_TABS.includes(type)) return next();
  if (['dashboard', 'reports', 'blog', 'settings', 'interviews', 'clients', 'team', 'templates'].includes(type)) return next();
  // Billing and the activity log are for Admins only.
  if (['placements', 'activity'].includes(type) && req.admin.role !== 'Admin') return requireAdmin(req, res, next);
  next();
}, exportGuard, limit('bulk-export', 20, 60 * 60 * 1000), security.bulkExport((req) => `${req.params.type}.csv`), (req, res, next) => {
  const { type } = req.params;
  const rows =
    type === 'jobs' ? jobs
    : type === 'placements' ? billing.csvRows()
    : type === 'activity' ? team.activity({ limit: 5000 })
    : type === 'talent' ? buildPool(searchableApplications(readSubmissions('applications'))).map(({ skillsAll, resumeText, history: h, interviews: ivs, emails, shared, ...c }) => ({ ...c, jobsApplied: c.jobsApplied.join('; '), resumeSkills: (c.resumeSkills || []).join(', ') }))
    : type === 'applications' ? readSubmissions('applications').map(applicationCsvRow)
    : readSubmissions(type);
  sendCsv(res, type, rows);
});

// Nested details (history, interviews, emails, client sharing) as readable text.
const csvDate = (d) => (d ? new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '');
function applicationCsvRow(a) {
  const { history: h = [], interviews: ivs = [], emails = [], shared, resumeText, resumeSkills = [], ...rest } = a;
  return {
    ...rest,
    stageHistory: h.map((x) => `${csvDate(x.at)}: ${x.from} → ${x.to} (${x.by})`).join(' | '),
    interviews: ivs.map((iv) => `${csvDate(iv.at)} ${iv.mode} (${iv.status})`).join(' | '),
    emails: emails.map((m) => `${csvDate(m.at)}: ${m.subject} (${m.by})`).join(' | '),
    sharedWithClient: shared ? `${csvDate(shared.sharedAt)}${shared.feedback ? ` · ${shared.feedback.decision}` : ''}` : '',
    skillsFromResume: resumeSkills.join(', '),
  };
}

function sendCsv(res, name, rows) {
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((c) => c !== 'token');
  const csv = [cols.map(csvCell).join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\r\n');
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.attachment(`hireriv-${name}-${new Date().toISOString().slice(0, 10)}.csv`);
  res.send('﻿' + csv); // BOM so Excel reads ₹ and other UTF-8 correctly
}

app.post('/admin/resumes/reindex', adminAuth, requireAdmin, sameOrigin, async (req, res) => {
  const todo = readSubmissions('applications').filter((a) => a.resume && a.resumeText === undefined).slice(0, 300);
  // Reading files can take a while; collect the text first, then apply it to a
  // fresh copy of the list so applications, stage moves and deletions made in
  // the meantime are not overwritten.
  const found = new Map();
  for (const a of todo) found.set(a.id, { resume: a.resume, text: await resumes.extractText(path.join(UPLOADS_DIR, path.basename(a.resume)), a.resume) });
  const list = readSubmissions('applications');
  let read = 0;
  for (const a of list) {
    const f = found.get(a.id);
    if (!f || a.resume !== f.resume) continue; // deleted, or a new resume arrived meanwhile
    a.resumeText = f.text;
    a.resumeSkills = resumes.analyze(f.text, allJobSkills()).skills;
    if (f.text) read++;
  }
  writeSubmissions('applications', list);
  res.redirect(adminUrl('talent', `Read ${read} of ${todo.length} older resume${todo.length === 1 ? '' : 's'}${todo.length - read ? ` (${todo.length - read} couldn't be read: scans or old .doc files)` : ''}`));
});

// A resume link opened after it expired: the page it came from makes a fresh one.
function linkExpired(res, back) {
  res.status(410).set('Cache-Control', 'no-store').render('thanks', { title: 'Link expired', page: '', ok: false, noindex: true, message: `This download link has expired (they last ${uploadSafety.LINK_MINUTES} minutes). Go back and refresh the page for a new one.` });
}

app.get('/admin/resume/:file', adminAuth, (req, res) => {
  if (!downloadLinks.valid(req)) return linkExpired(res, '/admin?tab=applications');
  const file = path.basename(req.params.file);
  vault.send(res, path.join(UPLOADS_DIR, file), file, 'Resume');
});

// ---------- 404 / errors ----------
app.use((req, res) => res.status(404).render('404', { title: 'Page not found', page: '', noindex: true }));
app.use((err, req, res, next) => {
  // Unreadable or oversized request bodies are the sender's mistake, not a server error.
  if (err.type && err.status >= 400 && err.status < 500) {
    if (req.path.startsWith('/api/') || req.accepts(['html', 'json']) === 'json') return res.status(err.status).json({ ok: false, errors: [err.status === 413 ? 'the request is too large' : 'the request body could not be read'] });
    return res.status(err.status).render('thanks', { title: 'Something was wrong with that request', page: '', ok: false, message: 'Please go back and try again.', noindex: true });
  }
  console.error(err);
  ops.recordError(req, err);
  siteAnalytics.track('server-error', `/${String(req.path).split('/')[1] || ''}`);
  res.status(500).render('thanks', { title: 'Something went wrong', page: '', ok: false, message: 'Something went wrong on our side. Please try again.', noindex: true });
});

// Flush and close the database cleanly on shutdown.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    try { siteAnalytics.flush(); } catch (e) { console.error(e.message); }
    db.close();
    process.exit(0);
  });
}

// Warn loudly about settings a live site needs.
if (process.env.NODE_ENV === 'production') {
  const missing = [];
  if (!process.env.SITE_URL) missing.push('SITE_URL (links, sitemap and Google data will say localhost)');
  if (!ADMIN_PASS && !team.members().length) missing.push('ADMIN_PASS (admin panel is disabled until the owner account can sign in)');
  if (!process.env.SMTP_HOST) missing.push('SMTP_HOST (emails are only saved to data/outbox)');
  if (process.env.SITE_URL && !HTTPS) missing.push('SITE_URL should use https://');
  for (const m of missing) console.warn(`[config] Missing or insecure: ${m}`);
}

app.listen(PORT, () => console.log(`Hireriv running at http://localhost:${PORT} · email: ${mailer.mode}`));
