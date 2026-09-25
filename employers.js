// Employer (client) accounts: invites, password login, sessions and the portal.
// Accounts live in data/submissions/employers.json (git-ignored, like all submissions).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SESSION_DAYS = 7;
const INVITE_HOURS = 72;
const RESET_HOURS = 2;
const COOKIE = 'hr_emp';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// ---------- passwords & tokens ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function checkPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

// Only a SHA-256 of each emailed link token is stored, so a leaked data file
// cannot be used to take over accounts.
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('hex');

function passwordProblem(pw, confirm) {
  if (pw.length < 10) return 'password must be at least 10 characters';
  if (pw.length > 200) return 'password is too long';
  if (pw !== confirm) return "passwords don't match";
  return '';
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function register(app, deps) {
  const { dataDir, site, mailer, baseUrl, adminAuth, sameOrigin, adminUrl, limit, readSubmissions, saveSubmission, getJobs, appStatuses } = deps;
  const FILE = path.join(dataDir, 'submissions', 'employers.json');
  const read = () => (fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : []);
  const write = (list) => fs.writeFileSync(FILE, JSON.stringify(list, null, 2));
  const secureCookie = /^https:/.test(baseUrl);

  // ---------- sessions (in memory: a restart just asks clients to log in again) ----------
  const sessions = new Map();
  function startSession(res, employerId) {
    const token = newToken();
    sessions.set(sha(token), { employerId, exp: Date.now() + SESSION_DAYS * 86400000 });
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: secureCookie, maxAge: SESSION_DAYS * 86400000, path: '/' });
  }
  function endSession(req, res) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) sessions.delete(sha(token));
    res.clearCookie(COOKIE, { path: '/' });
  }
  function currentEmployer(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return null;
    const s = sessions.get(sha(token));
    if (!s || s.exp < Date.now()) return null;
    const emp = read().find((e) => e.id === s.employerId);
    return emp && emp.active ? emp : null;
  }
  const requireEmployer = (req, res, next) => {
    const emp = currentEmployer(req);
    if (!emp) return res.redirect('/employer/login');
    req.employer = emp;
    res.locals.employer = emp;
    next();
  };
  setInterval(() => { for (const [k, s] of sessions) if (s.exp < Date.now()) sessions.delete(k); }, 3600000).unref();

  // One link kind at a time per account; issuing a new link voids the old one.
  function issueLink(emp, kind, hours) {
    const token = newToken();
    emp.link = { kind, hash: sha(token), exp: Date.now() + hours * 3600000 };
    return `${baseUrl}/employer/${kind === 'invite' ? 'setup' : 'reset'}/${token}`;
  }
  function findByLink(token, kind) {
    const list = read();
    const emp = /^[a-f0-9]{64}$/.test(token) ? list.find((e) => e.link && e.link.kind === kind && e.link.hash === sha(token)) : null;
    if (!emp || emp.link.exp < Date.now() || !emp.active) return { list, emp: null };
    return { list, emp };
  }

  const page = (res, view, locals, status = 200) => res.status(status).render(view, { page: 'employer', noindex: true, errors: [], ...locals });

  // ---------- admin: manage clients ----------
  app.post('/admin/clients', adminAuth, sameOrigin, (req, res) => {
    const company = String(req.body.company || '').trim().slice(0, 120);
    const name = String(req.body.name || '').trim().slice(0, 120);
    const email = String(req.body.email || '').trim().toLowerCase().slice(0, 160);
    const list = read();
    const errors = [];
    if (!company) errors.push('company is required');
    if (!name) errors.push('contact name is required');
    if (!EMAIL_RE.test(email)) errors.push('email is invalid');
    if (list.some((e) => e.email === email)) errors.push('a client with this email already exists');
    if (errors.length) return res.redirect(adminUrl('clients', `Could not add client: ${errors.join(', ')}`));
    const emp = { id: crypto.randomUUID(), company, name, email, active: true, createdAt: new Date().toISOString(), passwordHash: null };
    const link = issueLink(emp, 'invite', INVITE_HOURS);
    list.push(emp);
    write(list);
    mailer.employerInvite(emp, link, INVITE_HOURS);
    res.redirect(adminUrl('clients', `Invited ${name} (${company}) · setup link emailed`));
  });

  app.post('/admin/clients/:id/invite', adminAuth, sameOrigin, (req, res, next) => {
    const list = read();
    const emp = list.find((e) => e.id === req.params.id);
    if (!emp) return next();
    const link = issueLink(emp, emp.passwordHash ? 'reset' : 'invite', INVITE_HOURS);
    write(list);
    if (emp.passwordHash) mailer.employerReset(emp, link, INVITE_HOURS);
    else mailer.employerInvite(emp, link, INVITE_HOURS);
    res.redirect(adminUrl('clients', `New ${emp.passwordHash ? 'password reset' : 'invite'} link emailed to ${emp.email}`));
  });

  app.post('/admin/clients/:id/toggle', adminAuth, sameOrigin, (req, res, next) => {
    const list = read();
    const emp = list.find((e) => e.id === req.params.id);
    if (!emp) return next();
    emp.active = !emp.active;
    write(list);
    // Deactivating signs the client out everywhere.
    if (!emp.active) for (const [k, s] of sessions) if (s.employerId === emp.id) sessions.delete(k);
    res.redirect(adminUrl('clients', `${emp.company} ${emp.active ? 're-activated' : 'deactivated'}`));
  });

  // ---------- employer: set password (invite) / reset ----------
  for (const kind of ['invite', 'reset']) {
    const route = `/employer/${kind === 'invite' ? 'setup' : 'reset'}/:token`;
    app.get(route, (req, res) => {
      const { emp } = findByLink(req.params.token, kind);
      if (!emp) return page(res, 'employer-message', { title: 'Link expired', heading: 'This link has expired', message: 'Set-up and reset links work once and expire. Ask your Hireriv account manager for a new one, or use "Forgot password" on the login page.' }, 410);
      page(res, 'employer-password', { title: kind === 'invite' ? 'Set up your account' : 'Choose a new password', emp, kind });
    });
    app.post(route, limit('employer-password', 10), sameOrigin, (req, res) => {
      const { list, emp } = findByLink(req.params.token, kind);
      if (!emp) return page(res, 'employer-message', { title: 'Link expired', heading: 'This link has expired', message: 'Ask your Hireriv account manager for a new link.' }, 410);
      const pw = String(req.body.password || '');
      const problem = passwordProblem(pw, String(req.body.confirm || ''));
      if (problem) return page(res, 'employer-password', { title: 'Set your password', emp, kind, errors: [problem] }, 400);
      emp.passwordHash = hashPassword(pw);
      emp.link = null;
      emp.passwordSetAt = new Date().toISOString();
      write(list);
      // A password change ends every other session for this account.
      for (const [k, s] of sessions) if (s.employerId === emp.id) sessions.delete(k);
      startSession(res, emp.id);
      res.redirect(kind === 'invite' ? '/employer?welcome=1' : '/employer?msg=' + encodeURIComponent('Password updated. You are signed in.'));
    });
  }

  // ---------- employer: login / logout / forgot ----------
  app.get('/employer/login', (req, res) => {
    if (currentEmployer(req)) return res.redirect('/employer');
    page(res, 'employer-login', { title: 'Client login', email: '' });
  });

  app.post('/employer/login', limit('employer-login', 10, 15 * 60 * 1000), sameOrigin, (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const pw = String(req.body.password || '');
    const emp = read().find((e) => e.email === email);
    // Same message and similar work for unknown emails, so accounts can't be probed.
    const ok = emp && emp.active && emp.passwordHash ? checkPassword(pw, emp.passwordHash) : (hashPassword(pw), false);
    if (!ok) return page(res, 'employer-login', { title: 'Client login', email, errors: ['Email or password is incorrect.'] }, 401);
    startSession(res, emp.id);
    res.redirect('/employer');
  });

  app.post('/employer/logout', sameOrigin, (req, res) => {
    endSession(req, res);
    res.redirect('/employer/login');
  });

  app.get('/employer/forgot', (req, res) => page(res, 'employer-forgot', { title: 'Reset your password', sent: false }));

  app.post('/employer/forgot', limit('employer-forgot', 5), sameOrigin, (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const list = read();
    const emp = list.find((e) => e.email === email && e.active);
    if (emp && emp.passwordHash) {
      const link = issueLink(emp, 'reset', RESET_HOURS);
      write(list);
      mailer.employerReset(emp, link, RESET_HOURS);
    }
    page(res, 'employer-forgot', { title: 'Reset your password', sent: true });
  });

  // ---------- employer portal ----------
  app.get('/employer', requireEmployer, (req, res) => {
    const emp = req.employer;
    const apps = readSubmissions('applications');
    const statusOf = (a) => a.status || 'New';
    const myJobs = getJobs()
      .filter((j) => j.employerId === emp.id)
      .map((j) => {
        const forJob = apps.filter((a) => a.jobId === j.id);
        return { ...j, total: forJob.length, stages: Object.fromEntries(appStatuses.map((s) => [s, forJob.filter((a) => statusOf(a) === s).length])) };
      });
    const requirements = readSubmissions('hire-requests').filter((h) => h.employerId === emp.id);
    page(res, 'employer-dashboard', { title: `${emp.company} · Client portal`, myJobs, requirements, stages: appStatuses, welcome: req.query.welcome === '1', msg: String(req.query.msg || '') });
  });

  app.post('/employer/requirements', requireEmployer, limit('employer-req', 10), sameOrigin, (req, res) => {
    const emp = req.employer;
    const get = (k, max = 2000) => String(req.body[k] ?? '').trim().slice(0, max);
    const data = { roles: get('roles', 300), headcount: get('headcount', 10), hiringType: get('hiringType', 40), location: get('location', 120), timeline: get('timeline', 60), budget: get('budget', 120), message: get('message') };
    if (!data.roles) return res.redirect('/employer?msg=' + encodeURIComponent('Please describe the role(s) you need.'));
    const entry = saveSubmission('hire-requests', { company: emp.company, name: emp.name, email: emp.email, phone: '', ...data, employerId: emp.id, source: 'Client portal', status: 'Received' });
    mailer.hireRequestReceived(entry);
    res.redirect('/employer?msg=' + encodeURIComponent('Requirement sent. Your account manager will be in touch within one working day.'));
  });

  return { read, currentEmployer };
}

module.exports = { register, hashPassword, checkPassword };
