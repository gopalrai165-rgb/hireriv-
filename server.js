const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { createMailer } = require('./mailer');
const seo = require('./seo');
const { skillMatch, buildPool, searchPool } = require('./match');
const { parsePost, parseSettings, SOCIAL } = require('./content');

const PORT = process.env.PORT || 3004;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || '';
// Public origin used for canonical URLs, sitemap and structured data.
const BASE_URL = (process.env.SITE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

const DATA_DIR = path.join(__dirname, 'data');
const SUBMISSIONS_DIR = path.join(DATA_DIR, 'submissions');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(SUBMISSIONS_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const readJson = (file) => JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
const site = readJson('site.json');
const mailer = createMailer(site);
// Posts are edited from /admin and written back to data/posts.json. The array is
// mutated in place so every route keeps seeing the same list.
const POSTS_FILE = path.join(DATA_DIR, 'posts.json');
const posts = readJson('posts.json').map((p) => ({ status: 'published', ...p }));
const sortPosts = () => posts.sort((a, b) => b.date.localeCompare(a.date));
sortPosts();
function savePosts() {
  sortPosts();
  fs.writeFileSync(POSTS_FILE, JSON.stringify(posts, null, 2));
}
const livePosts = () => posts.filter((p) => p.status === 'published');

// ---------- jobs (editable from /admin, persisted back to data/jobs.json) ----------
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');
let jobs = readJson('jobs.json').map((j) => ({ status: 'open', ...j }));
// Jobs that were live before job alerts existed count as already announced.
for (const j of jobs) if (j.status === 'open' && !j.alertsSentAt) j.alertsSentAt = j.posted;
const sortJobs = () => jobs.sort((a, b) => b.posted.localeCompare(a.posted));
sortJobs();

function saveJobs() {
  sortJobs();
  fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2));
}

const openJobs = () => jobs.filter((j) => j.status === 'open');
const categoriesOf = (list) => [...new Set(list.map((j) => j.category))];
const locationsOf = (list) => [...new Set(list.map((j) => j.location))].sort();
const modes = ['On-site', 'Hybrid', 'Remote'];
const JOB_TYPES = ['Full-time', 'Contract', 'Part-time', 'Internship'];

// Application pipeline stages a recruiter moves a candidate through.
const APP_STATUSES = ['New', 'Screening', 'Interview', 'Offered', 'Hired', 'Rejected'];

// ---------- submission storage (JSON files, one per form type) ----------
const FORM_TYPES = ['applications', 'hire-requests', 'contacts', 'newsletter', 'job-alerts'];

function readSubmissions(type) {
  const file = path.join(SUBMISSIONS_DIR, `${type}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
}

function writeSubmissions(type, list) {
  fs.writeFileSync(path.join(SUBMISSIONS_DIR, `${type}.json`), JSON.stringify(list, null, 2));
}

function saveSubmission(type, record) {
  const list = readSubmissions(type);
  const entry = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), ...record };
  list.unshift(entry);
  writeSubmissions(type, list);
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
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

app.locals.site = site;
app.locals.year = new Date().getFullYear();
app.locals.formatDate = (d) =>
  new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
app.locals.daysAgo = (d) => {
  const days = Math.floor((Date.now() - new Date(d)) / 86400000);
  return days <= 0 ? 'Today' : days === 1 ? '1 day ago' : `${days} days ago`;
};

// Per-page SEO defaults; routes override these through render locals.
app.use((req, res, next) => {
  Object.assign(res.locals, {
    canonical: BASE_URL + req.path,
    metaDescription: `${site.name} – ${site.tagline}. Permanent, contract and executive staffing across Technology, Finance, Marketing and Logistics.`,
    jsonLd: null,
    noindex: req.path.startsWith('/admin'),
    toJsonLd: seo.toJsonLd,
  });
  next();
});

app.get('/robots.txt', (req, res) =>
  res.type('text/plain').send(`User-agent: *
Disallow: /admin
Disallow: /api/

Sitemap: ${BASE_URL}/sitemap.xml
`)
);

app.get('/sitemap.xml', (req, res) =>
  res.type('application/xml').send(seo.sitemap(BASE_URL, { jobs: openJobs(), posts: livePosts(), staticPaths: ['/', '/jobs', '/hire', '/about', '/blog', '/contact'] }))
);

// ---------- pages ----------
app.get('/', (req, res) => {
  const live = openJobs();
  res.render('index', { title: 'Staffing & Recruitment Solutions', page: 'home', jobs: live.slice(0, 6), posts: livePosts().slice(0, 3), categories: categoriesOf(live), jsonLd: seo.homePage(site, BASE_URL) });
});

app.get('/jobs', (req, res) => {
  const live = openJobs();
  const q = String(req.query.q || '').trim().toLowerCase();
  const { category = '', location = '', mode = '' } = req.query;
  const results = live.filter(
    (j) =>
      (!q || [j.title, j.company, j.description, ...j.skills].join(' ').toLowerCase().includes(q)) &&
      (!category || j.category === category) &&
      (!location || j.location === location) &&
      (!mode || j.mode === mode)
  );
  res.render('jobs', {
    title: 'Find Work',
    page: 'jobs',
    results,
    filters: { q: req.query.q || '', category, location, mode },
    categories: categoriesOf(live),
    locations: locationsOf(live),
    modes,
  });
});

// Closed jobs keep their page (old links still resolve) but no longer take applications.
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
    metaDescription: `${job.title} (${job.type}, ${job.mode}) in ${job.location}${job.experience ? `, ${job.experience}` : ''}${job.salary ? `, ${job.salary}` : ''}. ${job.description}`.slice(0, 300),
    // Google requires expired postings to drop their JobPosting markup.
    jsonLd: open ? seo.jobPosting(job, site, BASE_URL) : null,
    noindex: !open,
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

app.get('/hire', (req, res) => res.render('hire', { title: 'Hire a Team', page: 'hire' }));
app.get('/about', (req, res) => res.render('about', { title: 'About Us', page: 'about' }));
app.get('/contact', (req, res) => res.render('contact', { title: 'Contact Us', page: 'contact' }));
app.get('/blog', (req, res) => res.render('blog', { title: 'Blog & Articles', page: 'blog', posts: livePosts() }));
app.get('/blog/:slug', (req, res, next) => {
  const post = livePosts().find((p) => p.slug === req.params.slug);
  if (!post) return next();
  res.render('post', { title: post.title, page: 'blog', post, more: livePosts().filter((p) => p !== post).slice(0, 2), metaDescription: post.excerpt, jsonLd: seo.article(post, site, BASE_URL) });
});

// ---------- form endpoints ----------
app.post('/api/apply', limit('apply', 6), (req, res) => {
  upload.single('resume')(req, res, (err) => {
    if (!err && isBot(req.body)) {
      if (req.file) fs.unlink(req.file.path, () => {});
      return respond(req, res, [], 'Thanks! Your application is in.');
    }
    if (err) return respond(req, res, [err.code === 'LIMIT_FILE_SIZE' ? 'Resume must be under 5 MB' : err.message]);
    const data = clean(req.body, ['jobId', 'name', 'email', 'phone', 'skills', 'experience', 'location', 'noticePeriod', 'linkedin', 'message']);
    const errors = validate(data, ['name', 'email', 'phone']);
    if (!req.file) errors.push('resume is required');
    const job = jobs.find((j) => j.id === data.jobId);
    if (job && job.status !== 'open') errors.push('this job is no longer accepting applications');
    if (errors.length) {
      if (req.file) fs.unlink(req.file.path, () => {});
      return respond(req, res, errors);
    }
    const entry = saveSubmission('applications', { ...data, jobTitle: job ? job.title : 'General application', resume: req.file.filename, status: 'New', notes: '' });
    mailer.applicationReceived(entry);
    respond(req, res, [], `Thanks ${data.name.split(' ')[0]}! Your application is in. A recruiter will contact you within 2 working days.`);
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
  if (job.status !== 'open' || job.alertsSentAt) return 0;
  job.alertsSentAt = new Date().toISOString();
  const subs = readSubmissions('job-alerts').filter((s) => alertMatches(s, job));
  for (const sub of subs) mailer.jobAlert(sub, job);
  return subs.length;
}

app.post('/api/job-alerts', limit('job-alerts', 5), (req, res) => {
  if (isBot(req.body)) return respond(req, res, [], 'Almost done! Check your inbox and click the link to switch on your job alert.');
  const data = clean(req.body, ['email', 'category', 'location']);
  const errors = validate(data, ['email']);
  if (data.category && !categoriesOf(jobs).includes(data.category)) errors.push('category is invalid');
  if (data.location && !locationsOf(jobs).includes(data.location)) errors.push('location is invalid');
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

// ---------- admin (HTTP Basic auth, enabled only when ADMIN_PASS is set) ----------
const failedLogins = new Map();

function adminAuth(req, res, next) {
  if (!ADMIN_PASS) return res.status(503).send('Admin is disabled. Set the ADMIN_PASS environment variable to enable it.');
  const fails = (failedLogins.get(req.ip) || []).filter((t) => Date.now() - t < 15 * 60 * 1000);
  if (fails.length >= 10) return res.status(429).send('Too many failed login attempts. Try again in 15 minutes.');
  const [scheme, encoded] = (req.get('Authorization') || '').split(' ');
  if (scheme === 'Basic' && encoded) {
    const [user, ...rest] = Buffer.from(encoded, 'base64').toString().split(':');
    const pass = rest.join(':');
    const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
    if (safeEq(user, ADMIN_USER) && safeEq(pass, ADMIN_PASS)) {
      failedLogins.delete(req.ip);
      return next();
    }
    failedLogins.set(req.ip, [...fails, Date.now()]);
  }
  res.set('WWW-Authenticate', 'Basic realm="Hireriv Admin"').status(401).send('Authentication required');
}

// Basic-auth credentials ride along on cross-site form posts, so every admin write
// must come from a page on this same host.
function sameOrigin(req, res, next) {
  const src = req.get('Origin') || req.get('Referer');
  try {
    if (src && new URL(src).host === req.get('Host')) return next();
  } catch (e) { /* malformed header falls through to 403 */ }
  res.status(403).send('Cross-site request blocked');
}

const ADMIN_TABS = ['dashboard', 'jobs', 'talent', ...FORM_TYPES, 'blog', 'settings'];
const adminUrl = (tab, msg) => `/admin?tab=${tab}${msg ? `&msg=${encodeURIComponent(msg)}` : ''}`;

app.get('/admin', adminAuth, (req, res) => {
  const tab = ADMIN_TABS.includes(req.query.tab) ? req.query.tab : 'dashboard';
  const applications = readSubmissions('applications');
  const counts = { dashboard: '', settings: '', blog: posts.length, jobs: jobs.length, talent: new Set(applications.map((a) => String(a.email).toLowerCase())).size, ...Object.fromEntries(FORM_TYPES.map((t) => [t, readSubmissions(t).length])) };
  const locals = { title: 'Admin', page: 'admin', tab, tabs: ADMIN_TABS, counts, status: '', msg: String(req.query.msg || '') };

  if (tab === 'dashboard') return res.render('admin', { ...locals, rows: [], dash: buildDashboard(applications) });
  if (tab === 'jobs') {
    const applicants = {};
    for (const a of applications) applicants[a.jobId] = (applicants[a.jobId] || 0) + 1;
    return res.render('admin', { ...locals, rows: jobs, applicants });
  }
  if (tab === 'applications') {
    const statusOf = (a) => a.status || 'New';
    const statusCounts = Object.fromEntries(APP_STATUSES.map((s) => [s, applications.filter((a) => statusOf(a) === s).length]));
    const status = APP_STATUSES.includes(req.query.status) ? req.query.status : '';
    const sort = req.query.sort === 'match' ? 'match' : '';
    let rows = (status ? applications.filter((a) => statusOf(a) === status) : applications)
      .map((a) => ({ ...a, match: skillMatch(a, jobs.find((j) => j.id === a.jobId)) }));
    if (sort) rows = rows.sort((a, b) => (b.match?.score ?? -1) - (a.match?.score ?? -1));
    return res.render('admin', { ...locals, rows, statuses: APP_STATUSES, statusCounts, status, sort });
  }
  if (tab === 'blog') return res.render('admin', { ...locals, rows: posts });
  if (tab === 'settings') return res.render('admin', { ...locals, rows: [], form: site, errors: [], social: SOCIAL });
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
    const rows = searchPool(buildPool(applications), { ...f, job });
    return res.render('admin', { ...locals, rows, f, matchJob: job, jobOptions: jobs, statuses: APP_STATUSES, experienceOptions: EXPERIENCE, noticeOptions: NOTICE });
  }
  res.render('admin', { ...locals, rows: readSubmissions(tab) });
});

// ----- dashboard -----
const DAY_MS = 86400000;
// Day buckets follow India time so "today" matches the recruiters' calendar.
const dayKey = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

function buildDashboard(applications) {
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

  return {
    kpis: [
      { label: 'Open jobs', value: openJobs().length, note: `${jobs.length - openJobs().length} closed`, tab: 'jobs' },
      { label: 'Applications', value: applications.length, note: `+${lastWeek(applications)} this week`, tab: 'applications' },
      { label: 'In progress', value: applications.filter((a) => ['Screening', 'Interview', 'Offered'].includes(statusOf(a))).length, note: `${applications.filter((a) => statusOf(a) === 'New').length} new to review`, tab: 'applications' },
      { label: 'Hired', value: applications.filter((a) => statusOf(a) === 'Hired').length, note: 'placements', tab: 'applications' },
      { label: 'Hiring requests', value: hires.length, note: `+${lastWeek(hires)} this week`, tab: 'hire-requests' },
      { label: 'Alert subscribers', value: alerts.filter((a) => a.confirmed).length, note: `${alerts.filter((a) => !a.confirmed).length} unconfirmed`, tab: 'job-alerts' },
    ],
    days,
    funnel: APP_STATUSES.map((s) => ({ status: s, count: applications.filter((a) => statusOf(a) === s).length })),
    topJobs,
    recent,
  };
}

// ----- jobs -----
function parseJob(body) {
  const data = clean(body, ['title', 'company', 'location', 'mode', 'type', 'category', 'experience', 'salary', 'skills', 'description', 'responsibilities', 'status']);
  const errors = [];
  for (const f of ['title', 'company', 'location', 'category', 'description']) if (!data[f]) errors.push(`${f} is required`);
  if (!modes.includes(data.mode)) errors.push('work mode is invalid');
  if (!JOB_TYPES.includes(data.type)) errors.push('job type is invalid');
  const job = {
    title: data.title,
    company: data.company,
    location: data.location,
    mode: data.mode,
    type: data.type,
    category: data.category,
    experience: data.experience,
    salary: data.salary,
    skills: data.skills.split(',').map((s) => s.trim()).filter(Boolean),
    description: data.description,
    responsibilities: data.responsibilities.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
    status: data.status === 'closed' ? 'closed' : 'open',
  };
  return { job, errors };
}

const alertedNote = (n) => (n ? ` · job alert sent to ${n} subscriber${n === 1 ? '' : 's'}` : '');

function nextJobId() {
  const max = jobs.reduce((n, j) => Math.max(n, Number((j.id.match(/^hr-(\d+)$/) || [])[1]) || 0), 100);
  return `hr-${max + 1}`;
}

const jobFormLocals = (job, errors) => ({
  title: job.id ? 'Edit job' : 'Post a job', page: 'admin', job, errors, modes, jobTypes: JOB_TYPES, jobCategories: categoriesOf(jobs),
});

app.get('/admin/jobs/new', adminAuth, (req, res) =>
  res.render('admin-job', jobFormLocals({ mode: 'On-site', type: 'Full-time', status: 'open', skills: [], responsibilities: [] }, []))
);

app.get('/admin/jobs/:id/edit', adminAuth, (req, res, next) => {
  const job = jobs.find((j) => j.id === req.params.id);
  if (!job) return next();
  res.render('admin-job', jobFormLocals(job, []));
});

app.post('/admin/jobs', adminAuth, sameOrigin, (req, res) => {
  const { job, errors } = parseJob(req.body);
  if (errors.length) return res.status(400).render('admin-job', jobFormLocals(job, errors));
  const created = { id: nextJobId(), ...job, posted: new Date().toISOString().slice(0, 10) };
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
  Object.assign(existing, job);
  const alerted = sendJobAlerts(existing);
  saveJobs();
  res.redirect(adminUrl('jobs', `Saved "${existing.title}"${alertedNote(alerted)}`));
});

app.post('/admin/jobs/:id/toggle', adminAuth, sameOrigin, (req, res, next) => {
  const job = jobs.find((j) => j.id === req.params.id);
  if (!job) return next();
  job.status = job.status === 'open' ? 'closed' : 'open';
  const alerted = sendJobAlerts(job);
  saveJobs();
  res.redirect(adminUrl('jobs', `${job.status === 'open' ? 'Reopened' : 'Closed'} "${job.title}"${alertedNote(alerted)}`));
});

app.post('/admin/jobs/:id/delete', adminAuth, sameOrigin, (req, res, next) => {
  const job = jobs.find((j) => j.id === req.params.id);
  if (!job) return next();
  jobs = jobs.filter((j) => j !== job);
  saveJobs();
  res.redirect(adminUrl('jobs', `Deleted "${job.title}"`));
});

// ----- site settings -----
// `site` is shared by every view (app.locals) and the mailer, so it is updated in place.
app.post('/admin/settings', adminAuth, sameOrigin, (req, res) => {
  const { settings, errors } = parseSettings(req.body, site);
  if (errors.length) {
    return res.status(400).render('admin', { title: 'Admin', page: 'admin', tab: 'settings', tabs: ADMIN_TABS, counts: {}, status: '', msg: '', rows: [], form: settings, errors, social: SOCIAL });
  }
  Object.assign(site, settings);
  fs.writeFileSync(path.join(DATA_DIR, 'site.json'), JSON.stringify(site, null, 2));
  res.redirect(adminUrl('settings', 'Settings saved. The website is updated.'));
});

// ----- blog -----
const postFormLocals = (post, errors) => ({ title: post.slug && post._editing ? 'Edit article' : 'Write an article', page: 'admin', post, errors });

app.get('/admin/blog/new', adminAuth, (req, res) =>
  res.render('admin-post', postFormLocals({ date: new Date().toISOString().slice(0, 10), status: 'published', body: [] }, []))
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

app.post('/admin/blog/:slug/delete', adminAuth, sameOrigin, (req, res, next) => {
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
  const { status, notes, notify } = clean(req.body, ['status', 'notes', 'notify']);
  if (!APP_STATUSES.includes(status)) return res.status(400).send('Invalid status');
  const changed = (entry.status || 'New') !== status;
  Object.assign(entry, { status, notes, updatedAt: new Date().toISOString() });
  // Email the candidate only on a real stage change the recruiter opted into.
  const emailed = changed && notify === '1' && mailer.statusChanged(entry);
  if (emailed) entry.lastEmailedStatus = status;
  writeSubmissions('applications', list);
  const back = req.body.filter && APP_STATUSES.includes(req.body.filter) ? `&status=${encodeURIComponent(req.body.filter)}` : '';
  res.redirect(adminUrl('applications', `${entry.name} moved to ${status}${emailed ? ' (candidate emailed)' : ''}`) + back);
});

app.post('/admin/:type/:id/delete', adminAuth, sameOrigin, (req, res, next) => {
  const { type, id } = req.params;
  if (!FORM_TYPES.includes(type)) return next();
  const list = readSubmissions(type);
  const entry = list.find((s) => s.id === id);
  if (!entry) return next();
  writeSubmissions(type, list.filter((s) => s !== entry));
  if (entry.resume) fs.unlink(path.join(UPLOADS_DIR, path.basename(entry.resume)), () => {});
  res.redirect(adminUrl(type, 'Deleted 1 entry'));
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
  if (['dashboard', 'blog', 'settings'].includes(type)) return next();
  const rows =
    type === 'jobs' ? jobs
    : type === 'talent' ? buildPool(readSubmissions('applications')).map(({ skillsAll, ...c }) => ({ ...c, jobsApplied: c.jobsApplied.join('; ') }))
    : readSubmissions(type);
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((c) => c !== 'token');
  const csv = [cols.map(csvCell).join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\r\n');
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.attachment(`hireriv-${type}-${new Date().toISOString().slice(0, 10)}.csv`);
  res.send('﻿' + csv); // BOM so Excel reads ₹ and other UTF-8 correctly
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

app.listen(PORT, () => console.log(`Hireriv running at http://localhost:${PORT} · email: ${mailer.mode}`));
