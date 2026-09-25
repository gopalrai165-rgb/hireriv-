const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || '';

const DATA_DIR = path.join(__dirname, 'data');
const SUBMISSIONS_DIR = path.join(DATA_DIR, 'submissions');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(SUBMISSIONS_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const readJson = (file) => JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
const site = readJson('site.json');
const jobs = readJson('jobs.json').sort((a, b) => b.posted.localeCompare(a.posted));
const posts = readJson('posts.json').sort((a, b) => b.date.localeCompare(a.date));

const categories = [...new Set(jobs.map((j) => j.category))];
const locations = [...new Set(jobs.map((j) => j.location))].sort();
const modes = ['On-site', 'Hybrid', 'Remote'];

// ---------- submission storage (JSON files, one per form type) ----------
const FORM_TYPES = ['applications', 'hire-requests', 'contacts', 'newsletter'];

function readSubmissions(type) {
  const file = path.join(SUBMISSIONS_DIR, `${type}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
}

function saveSubmission(type, record) {
  const list = readSubmissions(type);
  const entry = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), ...record };
  list.unshift(entry);
  fs.writeFileSync(path.join(SUBMISSIONS_DIR, `${type}.json`), JSON.stringify(list, null, 2));
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
    return res.status(400).render('thanks', { title: 'Please check your details', page: '', ok: false, message: errors.join(', ') });
  }
  if (wantsJson) return res.json({ ok: true, message });
  return res.render('thanks', { title: 'Thank you', page: '', ok: true, message });
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

// ---------- pages ----------
app.get('/', (req, res) =>
  res.render('index', { title: 'Staffing & Recruitment Solutions', page: 'home', jobs: jobs.slice(0, 6), posts: posts.slice(0, 3), categories })
);

app.get('/jobs', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const { category = '', location = '', mode = '' } = req.query;
  const results = jobs.filter(
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
    categories,
    locations,
    modes,
  });
});

app.get('/jobs/:id', (req, res, next) => {
  const job = jobs.find((j) => j.id === req.params.id);
  if (!job) return next();
  const related = jobs.filter((j) => j.category === job.category && j.id !== job.id).slice(0, 3);
  res.render('job', { title: job.title, page: 'jobs', job, related });
});

app.get('/hire', (req, res) => res.render('hire', { title: 'Hire a Team', page: 'hire' }));
app.get('/about', (req, res) => res.render('about', { title: 'About Us', page: 'about' }));
app.get('/contact', (req, res) => res.render('contact', { title: 'Contact Us', page: 'contact' }));
app.get('/blog', (req, res) => res.render('blog', { title: 'Blog & Articles', page: 'blog', posts }));
app.get('/blog/:slug', (req, res, next) => {
  const post = posts.find((p) => p.slug === req.params.slug);
  if (!post) return next();
  res.render('post', { title: post.title, page: 'blog', post, more: posts.filter((p) => p !== post).slice(0, 2) });
});

// ---------- form endpoints ----------
app.post('/api/apply', (req, res) => {
  upload.single('resume')(req, res, (err) => {
    if (err) return respond(req, res, [err.code === 'LIMIT_FILE_SIZE' ? 'Resume must be under 5 MB' : err.message]);
    const data = clean(req.body, ['jobId', 'name', 'email', 'phone', 'experience', 'location', 'noticePeriod', 'linkedin', 'message']);
    const errors = validate(data, ['name', 'email', 'phone']);
    if (!req.file) errors.push('resume is required');
    if (errors.length) {
      if (req.file) fs.unlink(req.file.path, () => {});
      return respond(req, res, errors);
    }
    const job = jobs.find((j) => j.id === data.jobId);
    saveSubmission('applications', { ...data, jobTitle: job ? job.title : 'General application', resume: req.file.filename });
    respond(req, res, [], `Thanks ${data.name.split(' ')[0]}! Your application is in. A recruiter will contact you within 2 working days.`);
  });
});

app.post('/api/hire', (req, res) => {
  const data = clean(req.body, ['company', 'name', 'email', 'phone', 'roles', 'headcount', 'hiringType', 'location', 'timeline', 'message']);
  const errors = validate(data, ['company', 'name', 'email', 'phone', 'roles']);
  if (!errors.length) saveSubmission('hire-requests', data);
  respond(req, res, errors, 'Thank you! Our client partner will call you within one working day to understand your hiring needs.');
});

app.post('/api/contact', (req, res) => {
  const data = clean(req.body, ['name', 'email', 'phone', 'subject', 'message']);
  const errors = validate(data, ['name', 'email', 'message']);
  if (!errors.length) saveSubmission('contacts', data);
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

app.get('/admin', adminAuth, (req, res) => {
  const tab = FORM_TYPES.includes(req.query.tab) ? req.query.tab : 'applications';
  const counts = Object.fromEntries(FORM_TYPES.map((t) => [t, readSubmissions(t).length]));
  res.render('admin', { title: 'Admin', page: 'admin', tab, tabs: FORM_TYPES, counts, rows: readSubmissions(tab) });
});

app.get('/admin/resume/:file', adminAuth, (req, res) => {
  const file = path.basename(req.params.file);
  res.download(path.join(UPLOADS_DIR, file), file, (err) => err && !res.headersSent && res.status(404).end());
});

// ---------- 404 / errors ----------
app.use((req, res) => res.status(404).render('404', { title: 'Page not found', page: '' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('thanks', { title: 'Something went wrong', page: '', ok: false, message: 'Something went wrong on our side. Please try again.' });
});

app.listen(PORT, () => console.log(`Hireriv running at http://localhost:${PORT}`));
