const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { createMailer } = require('./mailer');
const { open: openDb } = require('./db');
const seo = require('./seo');
const { skillMatch, buildPool, searchPool, phoneKey } = require('./match');
const { parsePost, parseSettings, SOCIAL, DEFAULT_JOB_CATEGORIES, DEFAULT_JOB_LOCATIONS, SAMPLE_TESTIMONIALS, MAX_TESTIMONIALS, WORK_KINDS, WORK_KEYS, CATEGORY_WORK, workOf, workOfCategory, RESUME_OPTIONS, resumeNeeded, JOB_GROUPS, inGroup } = require('./content');
const interviews = require('./interviews');
const employers = require('./employers');
const candidates = require('./candidates');
const placements = require('./placements');
const teamModule = require('./team');
const bulk = require('./bulk');
const reportsModule = require('./reports');
const timesheetsModule = require('./timesheets');
const history = require('./history');
const resumes = require('./resume-parse');
const { interviewIcs } = require('./ics');
const ogImages = require('./og');
const retentionModule = require('./retention');
const backupsModule = require('./backups');
const { paginate } = require('./paginate');
const catalog = require('./catalog');

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
const FORM_TYPES = ['applications', 'hire-requests', 'contacts', 'newsletter', 'job-alerts'];
for (const type of [...FORM_TYPES, 'employers']) {
  const n = db.importOnce(type, path.join(SUBMISSIONS_DIR, `${type}.json`));
  if (n) console.log(`Imported ${n} ${type} from data/submissions/${type}.json`);
}
db.importOnce('jobs', path.join(DATA_DIR, 'jobs.json'));
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
// Jobs that were live before job alerts existed count as already announced.
for (const j of jobs) if (j.status === 'open' && !j.alertsSentAt) j.alertsSentAt = j.posted;
const sortJobs = () => jobs.sort((a, b) => b.posted.localeCompare(a.posted));
sortJobs();

function saveJobs() {
  sortJobs();
  db.replaceAll('jobs', jobs);
}

const openJobs = () => jobs.filter((j) => j.status === 'open');
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
  return expired.length;
}
closeExpiredJobs();
setInterval(closeExpiredJobs, 60 * 60 * 1000).unref();
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
const APP_STATUSES = ['New', 'Screening', 'Interview', 'Offered', 'Hired', 'Rejected'];

// ---------- submissions (one collection per form type, newest first) ----------
const readSubmissions = (type) => db.all(type);
const writeSubmissions = (type, list) => db.replaceAll(type, list);

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
// Behind a reverse proxy (Nginx, Render, etc.) set TRUST_PROXY=1 so req.ip is the visitor, not the proxy.
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.disable('x-powered-by');
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.use(express.json({ limit: '100kb' }));
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
app.get('/healthz', (req, res) => {
  try {
    db.count('jobs');
    res.set('Cache-Control', 'no-store').json({ ok: true, uptime: Math.round(process.uptime()) });
  } catch (err) {
    res.status(503).json({ ok: false });
  }
});

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

app.locals.site = site;
app.locals.catalog = catalog;
app.locals.workOf = workOf;
app.locals.isSample = (j) => j.sample === true;
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
    workspace: /^\/(admin|employer|account|feedback)(\/|$)/.test(req.path),
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
  const job = jobs.find((j) => j.id === req.params.id);
  if (!job) return next();
  og.job(job, site).then(sendPng(res), next);
});

app.get('/robots.txt', (req, res) =>
  res.type('text/plain').send(`User-agent: *
Disallow: /admin
Disallow: /api/
Disallow: /account
Disallow: /employer
Disallow: /healthz

Sitemap: ${BASE_URL}/sitemap.xml
`)
);

app.get('/sitemap.xml', (req, res) =>
  res.type('application/xml').send(seo.sitemap(BASE_URL, { jobs: openJobs().filter((j) => !isSample(j)), posts: livePosts(), staticPaths: ['/', '/jobs', '/categories', '/hire', '/services', ...catalog.SERVICES.map((x) => `/services/${x.slug}`), '/industries', ...catalog.INDUSTRIES.map((x) => `/industries/${x.slug}`), '/about', '/blog', '/contact', '/privacy', '/terms'] }))
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
  const samples = jobs.filter(isSample).length;
  if (samples) todo.push({ text: `Replace the ${samples} sample job${samples === 1 ? '' : 's'} with real openings: edit one to make it real, or delete it`, href: '/admin?tab=jobs' });
  if (!team.requires2fa()) todo.push({ text: 'Protect team sign-ins: turn on two-step sign-in for yourself, then require it for the team', href: '/admin/security' });
  return todo;
}

// ---------- pages ----------
app.get('/', (req, res) => {
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
app.get('/jobs', (req, res) => {
  const live = openJobs();
  const q = String(req.query.q || '').trim().toLowerCase();
  const { category = '', location = '', mode = '', type = '' } = req.query;
  const work = WORK_KEYS.includes(req.query.work) ? req.query.work : '';
  const group = JOB_GROUPS.find((g) => g.key === req.query.group) || null;
  const matches = (j, skip) =>
    (!q || [j.title, j.company, j.description, ...j.skills].join(' ').toLowerCase().includes(q)) &&
    (!category || j.category === category) &&
    (!location || j.location === location) &&
    (!mode || j.mode === mode) &&
    (!type || j.type === type) &&
    (!group || inGroup(group, j)) &&
    (skip === 'work' || !work || workOf(j) === work);
  const results = live.filter((j) => matches(j));
  // Kind-of-work counts follow the other filters, so each tab says what it would show.
  const workCounts = live.filter((j) => matches(j, 'work')).reduce((n, j) => ({ ...n, [workOf(j)]: (n[workOf(j)] || 0) + 1 }), {});
  const { rows, pager } = paginate(results, { page: req.query.page, size: JOBS_PAGE_SIZE, query: { q: req.query.q, group: group ? group.key : '', work, category, location, mode, type }, path: '/jobs' });
  res.render('jobs', {
    title: pager.page > 1 ? `Find Work – page ${pager.page}` : 'Find Work',
    page: 'jobs',
    results: rows,
    pager,
    // Pages of the unfiltered list are canonical; filtered views point to /jobs.
    canonical: `${BASE_URL}/jobs${pager.page > 1 && !(q || group || work || category || location || mode || type) ? `?page=${pager.page}` : ''}`,
    filters: { q: req.query.q || '', group: group ? group.key : '', work, category, location, mode, type },
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

app.get('/jobs/:id', (req, res, next) => {
  const job = jobs.find((j) => j.id === req.params.id);
  if (!job) return next();
  const related = openJobs().filter((j) => j.category === job.category && j.id !== job.id).slice(0, 3);
  const open = job.status === 'open';
  res.render('job', {
    title: `${job.title} – ${job.location}`,
    page: 'jobs',
    job,
    related,
    quick: !resumeNeeded(job),
    whatsappApply: whatsappApplyLink(job),
    metaDescription: `${job.title} (${job.type}, ${job.mode}) in ${job.location}${job.experience ? `, ${job.experience}` : ''}${job.salary ? `, ${job.salary}` : ''}. ${job.description}`.slice(0, 300),
    // Google requires expired postings to drop their JobPosting markup.
    jsonLd: open && !isSample(job) ? seo.jobPosting(job, site, BASE_URL) : null,
    ogImage: `${BASE_URL}/og/jobs/${job.id}.png?v=${og.jobVersion(job)}`,
    ogImageAlt: `${job.title} at ${job.company}, ${job.location}`,
    noindex: !open || isSample(job),
  });
});

// Saved jobs live in the visitor's browser (localStorage); the page asks the
// server to render cards for those ids. Closed jobs stay listed so people see why.
app.get('/saved', (req, res) => res.render('saved', { title: 'Saved jobs', page: 'saved', noindex: true }));

app.get('/saved/cards', (req, res) => {
  const ids = String(req.query.ids || '').split(',').filter((id) => /^[A-Za-z0-9_-]{1,40}$/.test(id)).slice(0, 100);
  const list = ids.map((id) => jobs.find((j) => j.id === id)).filter(Boolean);
  res.set('X-Robots-Tag', 'noindex').render('partials/saved-cards', { list });
});

// ?service=<slug> (from a service page) pre-selects that service on the form.
app.get('/hire', (req, res) => {
  const chosen = catalog.serviceBySlug(String(req.query.service || ''));
  res.render('hire', { title: 'Hire a Team', page: 'hire', hireOptions: catalog.HIRE_OPTIONS, selectedService: chosen ? chosen.hiringType : '' });
});

// ---------- services and industry desks (content in catalog.js) ----------
const guaranteeDays = () => (site.billing && Number.isInteger(site.billing.guaranteeDays) ? site.billing.guaranteeDays : placements.BILLING_DEFAULTS.guaranteeDays);
app.get('/services', (req, res) =>
  res.render('services', { title: 'Services', page: 'services', services: catalog.SERVICES, industries: catalog.INDUSTRIES, metaDescription: `${site.name} services: permanent staffing, contract staffing, executive search, bulk and RPO hiring, background verification and corporate training.` })
);
app.get('/services/:slug', (req, res, next) => {
  const service = catalog.serviceBySlug(req.params.slug);
  if (!service) return next();
  res.render('service', {
    title: service.name, page: 'services', service, industries: catalog.INDUSTRIES, others: catalog.SERVICES.filter((s) => s !== service).slice(0, 3),
    guaranteeDays: guaranteeDays(), metaDescription: `${service.name} from ${site.name}: ${service.card}`, jsonLd: seo.servicePage(service, site, BASE_URL),
  });
});
app.get('/industries', (req, res) => {
  const open = openJobs();
  const openCounts = open.reduce((n, j) => ({ ...n, [j.category]: (n[j.category] || 0) + 1 }), {});
  const desks = new Set(catalog.INDUSTRIES.map((i) => i.name));
  res.render('industries', {
    title: 'Industries', page: 'industries', industries: catalog.INDUSTRIES, openCounts, otherCategories: jobCategories().filter((c) => !desks.has(c)),
    metaDescription: `Specialist recruitment desks at ${site.name}: ${catalog.INDUSTRIES.map((i) => i.name).join(', ')}.`,
  });
});
app.get('/industries/:slug', (req, res, next) => {
  const industry = catalog.industryBySlug(req.params.slug);
  if (!industry) return next();
  const open = openJobs().filter((j) => j.category === industry.name);
  res.render('industry', {
    title: `${industry.name} Recruitment`, page: 'industries', industry, jobs: open.slice(0, 6), openCount: open.length,
    related: industry.services.map(catalog.serviceBySlug).filter(Boolean), metaDescription: `${industry.name} recruitment by ${site.name}. ${industry.text}`, jsonLd: seo.industryPage(industry, BASE_URL),
  });
});
app.get('/about', (req, res) => res.render('about', { title: 'About Us', page: 'about' }));
app.get('/contact', (req, res) => res.render('contact', { title: 'Contact Us', page: 'contact' }));
// Bump LEGAL_UPDATED whenever the wording of either page changes.
const LEGAL_UPDATED = '2026-10-24';
app.get('/privacy', (req, res) => res.render('privacy', { title: 'Privacy Policy', page: 'legal', updated: LEGAL_UPDATED, metaDescription: `How ${site.name} collects, uses and protects the personal data of candidates, clients and visitors.` }));
app.get('/terms', (req, res) => res.render('terms', { title: 'Terms of Use', page: 'legal', updated: LEGAL_UPDATED, metaDescription: `The terms for using the ${site.name} website as a job seeker or employer.` }));
app.get('/blog', (req, res) => res.render('blog', { title: 'Career Resources', page: 'blog', posts: livePosts() }));
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
async function saveApplication(data, file, job, extra = {}) {
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
  const prev = list.find((a) => !a.withdrawnAt && sameJob(a) && samePerson(a));
  if (prev) {
    for (const k of APPLICATION_FIELDS) if (data[k]) prev[k] = data[k];
    if (file) {
      if (prev.resume) fs.unlink(path.join(UPLOADS_DIR, path.basename(prev.resume)), () => {});
      Object.assign(prev, { resume: file.filename, resumeText, resumeSkills: found.skills });
    }
    const now = new Date().toISOString();
    Object.assign(prev, { updatedAt: now, reapplied: [...(prev.reapplied || []), now].slice(-20) });
    writeSubmissions('applications', list);
    return { app: prev, updated: true };
  }
  const entry = saveSubmission('applications', { ...data, jobTitle: job ? job.title : 'General application', resume: file ? file.filename : '', resumeText, resumeSkills: found.skills, status: 'New', notes: '', ...extra });
  return { app: entry, updated: false };
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
    if (job && job.status !== 'open') errors.push('this job is no longer accepting applications');
    else if (job && isSample(job)) errors.push('this is a sample listing, not a real vacancy. Send us your details with a general application instead');
    if (errors.length) {
      if (req.file) fs.unlink(req.file.path, () => {});
      return respond(req, res, errors);
    }
    saveApplication(data, req.file, job).then(({ app, updated }) => {
      const first = data.name.split(' ')[0];
      if (updated) {
        mailer.applicationUpdated(app);
        return respond(req, res, [], `Thanks ${first}! You'd already applied for this job, so we've updated your application with your new details.`);
      }
      mailer.applicationReceived(app);
      respond(req, res, [], `Thanks ${first}! Your application is in. A recruiter will ${data.email ? 'contact you' : `call you on ${data.phone}`} within 2 working days.`);
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

app.post('/api/hire', limit('hire', 5), (req, res) => {
  if (isBot(req.body)) return respond(req, res, [], 'Thank you! Our client partner will be in touch.');
  const data = clean(req.body, ['company', 'name', 'email', 'phone', 'roles', 'headcount', 'hiringType', 'location', 'timeline', 'message']);
  const errors = validate(data, ['company', 'name', 'email', 'phone', 'roles']);
  if (!errors.length) mailer.hireRequestReceived(saveSubmission('hire-requests', data));
  respond(req, res, errors, 'Thank you! Our client partner will call you within one working day to understand your hiring needs.');
});

app.post('/api/contact', limit('contact', 5), (req, res) => {
  if (isBot(req.body)) return respond(req, res, [], "Thanks for reaching out. We'll get back to you shortly.");
  const data = clean(req.body, ['name', 'email', 'phone', 'subject', 'message']);
  const errors = validate(data, ['name', 'email', 'message']);
  if (!errors.length) mailer.contactReceived(saveSubmission('contacts', data));
  respond(req, res, errors, "Thanks for reaching out. We'll get back to you shortly.");
});

// ---------- job alerts (double opt-in) ----------
const alertMatches = (sub, job) =>
  sub.confirmed &&
  (!sub.category || sub.category === job.category) &&
  (!sub.location || sub.location === job.location || job.mode === 'Remote');

// Alert each job at most once, the first time it goes live.
function sendJobAlerts(job) {
  if (job.status !== 'open' || job.alertsSentAt || isSample(job)) return 0;
  job.alertsSentAt = new Date().toISOString();
  const subs = readSubmissions('job-alerts').filter((s) => alertMatches(s, job));
  for (const sub of subs) mailer.jobAlert(sub, job);
  return subs.length;
}

app.post('/api/job-alerts', limit('job-alerts', 5), (req, res) => {
  if (isBot(req.body)) return respond(req, res, [], 'Almost done! Check your inbox and click the link to switch on your job alert.');
  const data = clean(req.body, ['email', 'category', 'location']);
  const errors = validate(data, ['email']);
  if (data.category && !jobCategories().includes(data.category)) errors.push('category is invalid');
  if (data.location && !jobLocations().includes(data.location)) errors.push('location is invalid');
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
  if (sub) writeSubmissions('job-alerts', list.filter((s) => s !== sub));
  res.render('thanks', { title: "You're unsubscribed", page: '', ok: true, message: "You won't get this job alert any more. You can set up a new one any time on the Find Work page.", noindex: true });
});

app.post('/api/newsletter', limit('newsletter', 5), (req, res) => {
  if (isBot(req.body)) return respond(req, res, [], "You're subscribed!");
  const data = clean(req.body, ['email']);
  const errors = validate(data, ['email']);
  if (!errors.length && !readSubmissions('newsletter').some((s) => s.email.toLowerCase() === data.email.toLowerCase())) {
    saveSubmission('newsletter', data);
  }
  respond(req, res, errors, "You're subscribed! Expect hiring insights and new roles in your inbox.");
});

// ---------- admin (team logins; see team.js) ----------
// ADMIN_USER / ADMIN_PASS is the built-in owner account; everyone else is
// invited from the Team tab and signs in with their own email and password.
const team = teamModule.create({ db, mailer, site, baseUrl: BASE_URL, ownerUser: ADMIN_USER, ownerPass: ADMIN_PASS, resetOwner2fa: process.env.RESET_OWNER_2FA === '1' });
const { adminAuth, requireAdmin } = team;

// Data retention (off unless switched on in Settings): runs at start and daily.
const retention = retentionModule.create({ db, site, uploadsDir: UPLOADS_DIR, readSubmissions, writeSubmissions, log: team.log });
retention.run();
setInterval(retention.run, 24 * 60 * 60 * 1000).unref();

// Daily database backups, kept next to the database unless BACKUP_DIR says otherwise.
const backups = backupsModule.create({ db, dir: process.env.BACKUP_DIR ? path.resolve(process.env.BACKUP_DIR) : path.join(path.dirname(DB_FILE), 'backups'), log: team.log });
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
  ['Inbox', ['hire-requests', 'contacts', 'job-alerts', 'newsletter']],
  ['Content', ['blog', 'templates']],
  ['Admin', ['settings', 'team', 'activity']],
];
const TAB_LABELS = { 'hire-requests': 'Hire requests', 'job-alerts': 'Job alerts' };
const ADMIN_TABS = ['dashboard', 'reports', 'jobs', 'talent', 'interviews', 'placements', 'clients', ...FORM_TYPES, 'templates', 'blog', 'settings', 'team', 'activity'];
// Recruiters don't see these tabs.
const ADMIN_ONLY_TABS = ['settings', 'team', 'activity'];
const tabsFor = (user) => ADMIN_TABS.filter((t) => user.role === 'Admin' || !ADMIN_ONLY_TABS.includes(t));
const adminUrl = (tab, msg) => `/admin?tab=${tab}${msg ? `&msg=${encodeURIComponent(msg)}` : ''}`;

team.register(app, { sameOrigin, adminUrl });

// ----- ownership -----
// Jobs have a recruiter who owns them; an application belongs to its job's
// owner unless someone is assigned to it directly.
const appOwner = (a) => a.ownerId || (jobs.find((j) => j.id === a.jobId) || {}).ownerId || '';
const ownerFilter = (req) => (['me', 'none'].includes(req.query.owner) ? req.query.owner : team.members().some((u) => u.id === req.query.owner) ? req.query.owner : '');
const matchesOwner = (ownerId, filter, user) => (filter === 'me' ? ownerId === user.id : filter === 'none' ? !ownerId : ownerId === filter);
const validOwner = (id) => (team.members().some((u) => u.id === id) ? id : '');

interviews.register(app, { adminAuth, sameOrigin, readSubmissions, writeSubmissions, mailer, site, adminUrl, baseUrl: BASE_URL, limit });
const clients = employers.register(app, {
  db, site, mailer, baseUrl: BASE_URL, adminAuth, sameOrigin, adminUrl, limit,
  readSubmissions, saveSubmission, getJobs: () => jobs, appStatuses: APP_STATUSES,
  writeSubmissions, uploadsDir: UPLOADS_DIR, skillMatch, placementsFor: (emp) => billing.forClient(emp), timesheetsFor: (emp) => timesheets.forClient(emp),
});

// "Post a Job": signed-in clients go to their portal's requirement form;
// everyone else to the hiring form on /hire.
app.get('/post-a-job', (req, res) => res.redirect(clients.currentEmployer(req) ? '/employer#new-requirement' : '/hire#requirement'));
const billing = placements.register(app, {
  db, site, mailer, baseUrl: BASE_URL, adminAuth, requireAdmin, sameOrigin, adminUrl, readSubmissions, writeSubmissions,
  getJobs: () => jobs, clients, requireEmployer: clients.requireEmployer,
});
const templates = bulk.register(app, {
  db, site, mailer, adminAuth, requireAdmin, sameOrigin, adminUrl, readSubmissions, writeSubmissions,
  getJobs: () => jobs, team, appStatuses: APP_STATUSES, uploadsDir: UPLOADS_DIR,
});
const reports = reportsModule.create({ readSubmissions, getJobs: () => jobs, getPlacements: () => billing.read(), team, appOwner });
const candidateAccounts = candidates.register(app, {
  db, mailer, baseUrl: BASE_URL, sameOrigin, limit, readSubmissions, writeSubmissions,
  uploadsDir: UPLOADS_DIR, getJobs: () => jobs, formatIst: interviews.formatIst, interviewIcs, site,
  contractsFor: (email) => timesheets.forCandidate(email),
});
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
    saveApplication(data, req.file, job, extra).then(({ app, updated }) => {
      if (updated && f.notes) {
        const list = readSubmissions('applications');
        const a = list.find((x) => x.id === app.id);
        a.notes = [a.notes, f.notes].filter(Boolean).join('\n');
        writeSubmissions('applications', list);
      }
      res.redirect(adminUrl('applications', updated ? `${data.name} had already applied for ${app.jobTitle}, so their application was updated` : `Added ${data.name} for ${app.jobTitle}`));
    }).catch((e) => {
      console.error(e);
      addCandidatePage(req, res, f, ['could not save, please try again'], 500);
    });
  });
});

app.get('/admin', adminAuth, (req, res) => {
  const tabs = tabsFor(req.admin);
  const tab = tabs.includes(req.query.tab) ? req.query.tab : 'dashboard';
  const applications = readSubmissions('applications');
  const counts = { dashboard: '', reports: '', settings: '', activity: '', templates: templates.read().length, team: team.members().length, blog: posts.length, interviews: interviews.upcoming(applications).length, placements: billing.read().length, clients: clients.read().length, jobs: jobs.length, talent: new Set(applications.map((a) => String(a.email).toLowerCase())).size, ...Object.fromEntries(FORM_TYPES.map((t) => [t, readSubmissions(t).length])) };
  const members = team.members();
  const memberName = Object.fromEntries(members.map((u) => [u.id, u.name]));
  const tabGroups = TAB_GROUPS.map(([label, list]) => [label, list.filter((t) => tabs.includes(t))]).filter(([, list]) => list.length);
  const locals = { title: 'Admin', page: 'admin', tab, tabs, tabGroups, tabLabels: TAB_LABELS, counts, status: '', msg: String(req.query.msg || ''), members, memberName, pager: null };
  // Long tables are shown 50 rows at a time; CSV exports still include everything.
  const pageOf = (list) => paginate(list, { page: req.query.page, size: ADMIN_PAGE_SIZE, query: req.query, path: '/admin' });

  if (tab === 'dashboard') return res.render('admin', { ...locals, rows: [], dash: buildDashboard(applications, req.admin), setupTodo: req.admin.role === 'Admin' ? setupTodo() : [] });
  if (tab === 'team') return res.render('admin', { ...locals, rows: team.list(), roles: team.ROLES, requires2fa: team.requires2fa(), my2fa: team.has2fa(req.admin.id) });
  if (tab === 'templates') return res.render('admin', { ...locals, rows: templates.read(), placeholders: bulk.PLACEHOLDERS });
  if (tab === 'reports') return res.render('admin', { ...locals, rows: [], report: reports.build({ period: String(req.query.period || ''), isAdmin: req.admin.role === 'Admin' }), inr: billing.inr });
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
    const { rows, pager } = pageOf(searchPool(buildPool(applications), { ...f, job }));
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
      { label: 'In progress', value: applications.filter((a) => ['Screening', 'Interview', 'Offered'].includes(statusOf(a))).length, note: `${applications.filter((a) => statusOf(a) === 'New').length} new to review`, tab: 'applications' },
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
  const data = clean(body, ['title', 'company', 'location', 'mode', 'type', 'category', 'experience', 'salary', 'skills', 'description', 'responsibilities', 'status']);
  const errors = [];
  for (const f of ['title', 'company', 'location', 'category', 'description']) if (!data[f]) errors.push(`${f} is required`);
  if (data.category && !jobCategories().includes(data.category)) errors.push('pick a category from the list (add new ones in Settings)');
  if (data.location && !jobLocations().includes(data.location)) errors.push('pick a location from the list (add new ones in Settings)');
  if (!modes.includes(data.mode)) errors.push('work mode is invalid');
  if (!JOB_TYPES.includes(data.type)) errors.push('job type is invalid');
  const closesOn = String(body.closesOn || '').trim();
  if (closesOn && (!/^\d{4}-\d{2}-\d{2}$/.test(closesOn) || Number.isNaN(Date.parse(closesOn)))) errors.push('closing date is invalid');
  else if (closesOn && data.status !== 'closed' && closesOn < todayIst()) errors.push('closing date is in the past (pick a later date, or leave it blank to keep the job open)');
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
    salary: data.salary,
    skills: data.skills.split(',').map((s) => s.trim()).filter(Boolean),
    description: data.description,
    responsibilities: data.responsibilities.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
    status: data.status === 'closed' ? 'closed' : 'open',
    closesOn: closesOn || null,
    employerId: clients.read().some((c) => c.id === body.employerId) ? body.employerId : '',
    ownerId: validOwner(String(body.ownerId || '')),
  };
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
  job.status = job.status === 'open' ? 'closed' : 'open';
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
  if (errors.length) {
    return res.status(400).render('admin', { title: 'Admin', page: 'admin', tab: 'settings', tabs: tabsFor(req.admin), counts: {}, members: team.members(), memberName: {}, status: '', msg: '', rows: [], form: settings, errors, social: SOCIAL, retentionPreview: retentionPreviews(), backups: { status: backups.status(), list: backups.list(), dir: backups.dir, keep: backups.keep }, billingForm: Object.fromEntries(Object.entries(placements.billingOf(settings)).map(([k, v]) => [k, Number.isNaN(v) ? '' : v])) });
  }
  const retentionChanged = settings.retentionMonths !== (site.retentionMonths || 0);
  Object.assign(site, settings);
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
  const changed = history.moveStage(entry, status, req.admin.name);
  Object.assign(entry, { notes, updatedAt: new Date().toISOString() });
  // "job" means follow the job's owner; otherwise a named team member.
  if (ownerId !== undefined && req.body.ownerId !== undefined) entry.ownerId = ownerId === 'job' ? '' : validOwner(ownerId) || entry.ownerId || '';
  // Email the candidate only on a real stage change the recruiter opted into.
  const emailed = changed && notify === '1' && mailer.statusChanged(entry);
  if (emailed) entry.lastEmailedStatus = status;
  writeSubmissions('applications', list);
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
app.get('/admin/backup', adminAuth, requireAdmin, (req, res) => {
  const file = path.join(require('os').tmpdir(), `hireriv-backup-${Date.now()}.db`);
  db.backupTo(file);
  res.download(file, `hireriv-${new Date().toISOString().slice(0, 10)}.db`, () => fs.unlink(file, () => {}));
});

// Automatic backups: download any kept copy, or take one now.
app.get('/admin/backups/:name', adminAuth, requireAdmin, (req, res, next) => {
  const file = backups.fileFor(req.params.name);
  if (!file) return next();
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

app.get('/admin/export/:type.csv', adminAuth, (req, res, next) => {
  const { type } = req.params;
  if (!ADMIN_TABS.includes(type)) return next();
  if (['dashboard', 'reports', 'blog', 'settings', 'interviews', 'clients', 'team', 'templates'].includes(type)) return next();
  // Billing and the activity log are for Admins only.
  if (['placements', 'activity'].includes(type) && req.admin.role !== 'Admin') return requireAdmin(req, res, next);
  const rows =
    type === 'jobs' ? jobs
    : type === 'placements' ? billing.csvRows()
    : type === 'activity' ? team.activity({ limit: 5000 })
    : type === 'talent' ? buildPool(readSubmissions('applications')).map(({ skillsAll, resumeText, history: h, interviews: ivs, emails, shared, ...c }) => ({ ...c, jobsApplied: c.jobsApplied.join('; '), resumeSkills: (c.resumeSkills || []).join(', ') }))
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

app.get('/admin/resume/:file', adminAuth, (req, res) => {
  const file = path.basename(req.params.file);
  res.download(path.join(UPLOADS_DIR, file), file, (err) => err && !res.headersSent && res.status(404).end());
});

// ---------- 404 / errors ----------
app.use((req, res) => res.status(404).render('404', { title: 'Page not found', page: '', noindex: true }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('thanks', { title: 'Something went wrong', page: '', ok: false, message: 'Something went wrong on our side. Please try again.', noindex: true });
});

// Flush and close the database cleanly on shutdown.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
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
