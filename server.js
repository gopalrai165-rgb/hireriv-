const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { createMailer } = require('./mailer');
const seo = require('./seo');

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
const posts = readJson('posts.json').sort((a, b) => b.date.localeCompare(a.date));

// ---------- jobs (editable from /admin, persisted back to data/jobs.json) ----------
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');
let jobs = readJson('jobs.json').map((j) => ({ status: 'open', ...j }));
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
const FORM_TYPES = ['applications', 'hire-requests', 'contacts', 'newsletter'];

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
  res.type('application/xml').send(seo.sitemap(BASE_URL, { jobs: openJobs(), posts, staticPaths: ['/', '/jobs', '/hire', '/about', '/blog', '/contact'] }))
);

// ---------- pages ----------
app.get('/', (req, res) => {
  const live = openJobs();
  res.render('index', { title: 'Staffing & Recruitment Solutions', page: 'home', jobs: live.slice(0, 6), posts: posts.slice(0, 3), categories: categoriesOf(live), jsonLd: seo.homePage(site, BASE_URL) });
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

app.get('/hire', (req, res) => res.render('hire', { title: 'Hire a Team', page: 'hire' }));
app.get('/about', (req, res) => res.render('about', { title: 'About Us', page: 'about' }));
app.get('/contact', (req, res) => res.render('contact', { title: 'Contact Us', page: 'contact' }));
app.get('/blog', (req, res) => res.render('blog', { title: 'Blog & Articles', page: 'blog', posts }));
app.get('/blog/:slug', (req, res, next) => {
  const post = posts.find((p) => p.slug === req.params.slug);
  if (!post) return next();
  res.render('post', { title: post.title, page: 'blog', post, more: posts.filter((p) => p !== post).slice(0, 2), metaDescription: post.excerpt, jsonLd: seo.article(post, site, BASE_URL) });
});

// ---------- form endpoints ----------
app.post('/api/apply', (req, res) => {
  upload.single('resume')(req, res, (err) => {
    if (err) return respond(req, res, [err.code === 'LIMIT_FILE_SIZE' ? 'Resume must be under 5 MB' : err.message]);
    const data = clean(req.body, ['jobId', 'name', 'email', 'phone', 'experience', 'location', 'noticePeriod', 'linkedin', 'message']);
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

app.post('/api/hire', (req, res) => {
  const data = clean(req.body, ['company', 'name', 'email', 'phone', 'roles', 'headcount', 'hiringType', 'location', 'timeline', 'message']);
  const errors = validate(data, ['company', 'name', 'email', 'phone', 'roles']);
  if (!errors.length) mailer.hireRequestReceived(saveSubmission('hire-requests', data));
  respond(req, res, errors, 'Thank you! Our client partner will call you within one working day to understand your hiring needs.');
});

app.post('/api/contact', (req, res) => {
  const data = clean(req.body, ['name', 'email', 'phone', 'subject', 'message']);
  const errors = validate(data, ['name', 'email', 'message']);
  if (!errors.length) mailer.contactReceived(saveSubmission('contacts', data));
  respond(req, res, errors, "Thanks for reaching out. We'll get back to you shortly.");
});

app.post('/api/newsletter', (req, res) => {
  const data = clean(req.body, ['email']);
  const errors = validate(data, ['email']);
  if (!errors.length && !readSubmissions('newsletter').some((s) => s.email.toLowerCase() === data.email.toLowerCase())) {
    saveSubmission('newsletter', data);
  }
  respond(req, res, errors, "You're subscribed! Expect hiring insights and new roles in your inbox.");
});

// ---------- admin (HTTP Basic auth, enabled only when ADMIN_PASS is set) ----------
function adminAuth(req, res, next) {
  if (!ADMIN_PASS) return res.status(503).send('Admin is disabled. Set the ADMIN_PASS environment variable to enable it.');
  const [scheme, encoded] = (req.get('Authorization') || '').split(' ');
  if (scheme === 'Basic' && encoded) {
    const [user, ...rest] = Buffer.from(encoded, 'base64').toString().split(':');
    const pass = rest.join(':');
    const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
    if (safeEq(user, ADMIN_USER) && safeEq(pass, ADMIN_PASS)) return next();
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

const ADMIN_TABS = ['jobs', ...FORM_TYPES];
const adminUrl = (tab, msg) => `/admin?tab=${tab}${msg ? `&msg=${encodeURIComponent(msg)}` : ''}`;

app.get('/admin', adminAuth, (req, res) => {
  const tab = ADMIN_TABS.includes(req.query.tab) ? req.query.tab : 'applications';
  const applications = readSubmissions('applications');
  const counts = { jobs: jobs.length, ...Object.fromEntries(FORM_TYPES.map((t) => [t, readSubmissions(t).length])) };
  const locals = { title: 'Admin', page: 'admin', tab, tabs: ADMIN_TABS, counts, status: '', msg: String(req.query.msg || '') };

  if (tab === 'jobs') {
    const applicants = {};
    for (const a of applications) applicants[a.jobId] = (applicants[a.jobId] || 0) + 1;
    return res.render('admin', { ...locals, rows: jobs, applicants });
  }
  if (tab === 'applications') {
    const statusOf = (a) => a.status || 'New';
    const statusCounts = Object.fromEntries(APP_STATUSES.map((s) => [s, applications.filter((a) => statusOf(a) === s).length]));
    const status = APP_STATUSES.includes(req.query.status) ? req.query.status : '';
    const rows = status ? applications.filter((a) => statusOf(a) === status) : applications;
    return res.render('admin', { ...locals, rows, statuses: APP_STATUSES, statusCounts, status });
  }
  res.render('admin', { ...locals, rows: readSubmissions(tab) });
});

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
  saveJobs();
  res.redirect(adminUrl('jobs', `Posted "${created.title}"`));
});

app.post('/admin/jobs/:id', adminAuth, sameOrigin, (req, res, next) => {
  const existing = jobs.find((j) => j.id === req.params.id);
  if (!existing) return next();
  const { job, errors } = parseJob(req.body);
  if (errors.length) return res.status(400).render('admin-job', jobFormLocals({ ...job, id: existing.id }, errors));
  Object.assign(existing, job);
  saveJobs();
  res.redirect(adminUrl('jobs', `Saved "${existing.title}"`));
});

app.post('/admin/jobs/:id/toggle', adminAuth, sameOrigin, (req, res, next) => {
  const job = jobs.find((j) => j.id === req.params.id);
  if (!job) return next();
  job.status = job.status === 'open' ? 'closed' : 'open';
  saveJobs();
  res.redirect(adminUrl('jobs', `${job.status === 'open' ? 'Reopened' : 'Closed'} "${job.title}"`));
});

app.post('/admin/jobs/:id/delete', adminAuth, sameOrigin, (req, res, next) => {
  const job = jobs.find((j) => j.id === req.params.id);
  if (!job) return next();
  jobs = jobs.filter((j) => j !== job);
  saveJobs();
  res.redirect(adminUrl('jobs', `Deleted "${job.title}"`));
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
  const rows = type === 'jobs' ? jobs : readSubmissions(type);
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
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
