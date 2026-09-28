// Recruiter team: individual admin logins with roles, sessions and an activity log.
// Roles: "Admin" sees and does everything; "Recruiter" works jobs, candidates and
// clients but can't touch billing, settings, the team, backups or deletions.
// The ADMIN_USER / ADMIN_PASS account from the environment is the built-in owner
// (always an Admin), so a fresh install can sign in and invite the team.
const crypto = require('crypto');
const { hashPassword, checkPassword } = require('./employers');

const ROLES = ['Admin', 'Recruiter'];
const SESSION_HOURS = 12;
const INVITE_HOURS = 72;
const COOKIE = 'hr_admin';
const OWNER_ID = 'owner';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_ACTIVITY = 2000;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('hex');
const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function create({ db, mailer, baseUrl, ownerUser, ownerPass }) {
  const read = () => db.all('team');
  const write = (list) => db.replaceAll('team', list);
  const secureCookie = /^https:/.test(baseUrl);
  const owner = { id: OWNER_ID, name: 'Owner', email: ownerUser, role: 'Admin', active: true, builtIn: true };
  const enabled = () => Boolean(ownerPass) || read().some((u) => u.active && u.passwordHash);
  const byId = (id) => (id === OWNER_ID && ownerPass ? owner : read().find((u) => u.id === id && u.active));

  // ---------- activity log ----------
  function log(user, action, detail = '') {
    const entry = { id: crypto.randomUUID(), at: new Date().toISOString(), userId: user ? user.id : '', userName: user ? user.name : 'System', action: String(action).slice(0, 300), detail: String(detail).slice(0, 200) };
    db.prepend('activity', entry);
    // Keep the log bounded; the oldest entries fall off.
    if (db.count('activity') > MAX_ACTIVITY + 100) db.replaceAll('activity', db.all('activity').slice(0, MAX_ACTIVITY));
  }

  // ---------- sessions ----------
  function startSession(res, userId) {
    const token = newToken();
    db.sessions.set('admin', sha(token), userId, Date.now() + SESSION_HOURS * 3600000);
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: secureCookie, maxAge: SESSION_HOURS * 3600000, path: '/' });
  }
  function currentUser(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    const s = token && db.sessions.get('admin', sha(token));
    return s ? byId(s.subject) || null : null;
  }
  function endSession(req, res) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) db.sessions.delete('admin', sha(token));
    res.clearCookie(COOKIE, { path: '/' });
  }

  // ---------- middleware ----------
  const wantsHtml = (req) => req.method === 'GET' && (req.get('Accept') || '').includes('text/html');

  function adminAuth(req, res, next) {
    if (!enabled()) return res.status(503).send('Admin is disabled. Set the ADMIN_PASS environment variable to enable it.');
    const user = currentUser(req);
    if (!user) {
      if (wantsHtml(req)) return res.redirect(`/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
      return res.status(401).send('Please sign in again at /admin/login');
    }
    req.admin = user;
    res.locals.admin = user;
    res.locals.isAdmin = user.role === 'Admin';
    // Every admin change ends in a redirect whose ?msg= says what happened in
    // plain words ("Posted ...", "Invoice ... issued"), so that becomes the log line.
    if (req.method === 'POST') {
      const redirect = res.redirect.bind(res);
      res.redirect = (...args) => {
        const url = String(args[args.length - 1]);
        const m = /[?&]msg=([^&]*)/.exec(url);
        let text = '';
        try { text = m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : ''; } catch (e) { text = ''; }
        log(user, text || `${req.method} ${req.path}`, req.path);
        return redirect(...args);
      };
    }
    next();
  }

  function requireAdmin(req, res, next) {
    if (req.admin && req.admin.role === 'Admin') return next();
    res.status(403).render('thanks', { title: 'Admins only', page: '', ok: false, message: 'Only an Admin can do this. Ask an Admin on your team if you need it.', noindex: true });
  }

  // ---------- login ----------
  const failed = new Map();
  const tooMany = (ip) => (failed.get(ip) || []).filter((t) => Date.now() - t < 15 * 60000).length >= 10;
  const safeNext = (n) => (/^\/admin(\/|\?|$)/.test(String(n || '')) ? String(n) : '/admin');
  const page = (res, view, locals, status = 200) => res.status(status).render(view, { page: 'admin', noindex: true, errors: [], ...locals });

  function register(app, { sameOrigin, adminUrl }) {
    app.get('/admin/login', (req, res) => {
      if (!enabled()) return res.status(503).send('Admin is disabled. Set the ADMIN_PASS environment variable to enable it.');
      if (currentUser(req)) return res.redirect(safeNext(req.query.next));
      page(res, 'admin-login', { title: 'Team sign in', login: '', next: safeNext(req.query.next) });
    });

    app.post('/admin/login', sameOrigin, (req, res) => {
      const login = String(req.body.login || '').trim().toLowerCase().slice(0, 160);
      const pw = String(req.body.password || '');
      const next = safeNext(req.body.next);
      if (tooMany(req.ip)) return page(res, 'admin-login', { title: 'Team sign in', login, next, errors: ['Too many failed attempts. Try again in 15 minutes.'] }, 429);
      let user = null;
      if (ownerPass && safeEq(sha(login), sha(ownerUser.toLowerCase())) && safeEq(sha(pw), sha(ownerPass))) user = owner;
      else {
        const u = read().find((x) => x.email === login);
        // Same work and message for unknown emails, so accounts can't be probed.
        const ok = u && u.active && u.passwordHash ? checkPassword(pw, u.passwordHash) : (hashPassword(pw), false);
        if (ok) user = u;
      }
      if (!user) {
        failed.set(req.ip, [...(failed.get(req.ip) || []), Date.now()]);
        return page(res, 'admin-login', { title: 'Team sign in', login, next, errors: ['Email or password is incorrect.'] }, 401);
      }
      failed.delete(req.ip);
      startSession(res, user.id);
      log(user, 'Signed in');
      res.redirect(next);
    });

    app.post('/admin/logout', sameOrigin, (req, res) => {
      const user = currentUser(req);
      if (user) log(user, 'Signed out');
      endSession(req, res);
      res.redirect('/admin/login');
    });

    // ---------- team management (Admins) ----------
    function issueLink(u) {
      const token = newToken();
      u.link = { hash: sha(token), exp: Date.now() + INVITE_HOURS * 3600000 };
      return `${baseUrl}/admin/setup/${token}`;
    }
    const activeAdmins = (list) => list.filter((u) => u.active && u.role === 'Admin').length + (ownerPass ? 1 : 0);

    app.post('/admin/team', adminAuth, requireAdmin, sameOrigin, (req, res) => {
      const name = String(req.body.name || '').trim().slice(0, 120);
      const email = String(req.body.email || '').trim().toLowerCase().slice(0, 160);
      const role = ROLES.includes(req.body.role) ? req.body.role : 'Recruiter';
      const list = read();
      const errors = [];
      if (!name) errors.push('name is required');
      if (!EMAIL_RE.test(email)) errors.push('email is invalid');
      if (list.some((u) => u.email === email) || email === ownerUser.toLowerCase()) errors.push('someone on the team already uses this email');
      if (errors.length) return res.redirect(adminUrl('team', `Could not add: ${errors.join(', ')}`));
      const u = { id: crypto.randomUUID(), name, email, role, active: true, passwordHash: null, createdAt: new Date().toISOString(), invitedBy: req.admin.name };
      const link = issueLink(u);
      list.push(u);
      write(list);
      mailer.teamInvite(u, req.admin, link, INVITE_HOURS);
      res.redirect(adminUrl('team', `Invited ${name} as ${role} · set-up link emailed to ${email}`));
    });

    app.post('/admin/team/:id/role', adminAuth, requireAdmin, sameOrigin, (req, res, next) => {
      const list = read();
      const u = list.find((x) => x.id === req.params.id);
      if (!u) return next();
      const role = ROLES.includes(req.body.role) ? req.body.role : u.role;
      if (u.role === 'Admin' && role !== 'Admin' && activeAdmins(list) <= 1) return res.redirect(adminUrl('team', 'The team needs at least one Admin'));
      u.role = role;
      write(list);
      res.redirect(adminUrl('team', `${u.name} is now ${role}`));
    });

    app.post('/admin/team/:id/toggle', adminAuth, requireAdmin, sameOrigin, (req, res, next) => {
      const list = read();
      const u = list.find((x) => x.id === req.params.id);
      if (!u) return next();
      if (u.id === req.admin.id) return res.redirect(adminUrl('team', "You can't deactivate your own account"));
      if (u.active && u.role === 'Admin' && activeAdmins(list) <= 1) return res.redirect(adminUrl('team', 'The team needs at least one Admin'));
      u.active = !u.active;
      write(list);
      // Deactivating signs them out everywhere at once.
      if (!u.active) db.sessions.deleteSubject('admin', u.id);
      res.redirect(adminUrl('team', `${u.name} ${u.active ? 're-activated' : 'deactivated and signed out'}`));
    });

    app.post('/admin/team/:id/invite', adminAuth, requireAdmin, sameOrigin, (req, res, next) => {
      const list = read();
      const u = list.find((x) => x.id === req.params.id && x.active);
      if (!u) return next();
      const link = issueLink(u);
      write(list);
      mailer.teamInvite(u, req.admin, link, INVITE_HOURS);
      res.redirect(adminUrl('team', `New ${u.passwordHash ? 'password reset' : 'set-up'} link emailed to ${u.email}`));
    });

    // ---------- set password from an emailed link ----------
    function findByLink(token) {
      const list = read();
      const u = /^[a-f0-9]{64}$/.test(token) ? list.find((x) => x.active && x.link && x.link.hash === sha(token)) : null;
      return { list, u: u && u.link.exp > Date.now() ? u : null };
    }
    const expired = (res) => page(res, 'employer-message', { title: 'Link expired', heading: 'This link has expired', message: 'Set-up links work once and expire after 3 days. Ask an Admin on your team to send a new one.' }, 410);

    app.get('/admin/setup/:token', (req, res) => {
      const { u } = findByLink(req.params.token);
      if (!u) return expired(res);
      page(res, 'admin-password', { title: 'Choose your password', u });
    });

    app.post('/admin/setup/:token', sameOrigin, (req, res) => {
      const { list, u } = findByLink(req.params.token);
      if (!u) return expired(res);
      const pw = String(req.body.password || '');
      const problem = pw.length < 10 ? 'password must be at least 10 characters' : pw.length > 200 ? 'password is too long' : pw !== String(req.body.confirm || '') ? "passwords don't match" : '';
      if (problem) return page(res, 'admin-password', { title: 'Choose your password', u, errors: [problem] }, 400);
      Object.assign(u, { passwordHash: hashPassword(pw), link: null, passwordSetAt: new Date().toISOString() });
      write(list);
      db.sessions.deleteSubject('admin', u.id);
      startSession(res, u.id);
      log(u, 'Set a password and signed in');
      res.redirect('/admin');
    });
  }

  // For the Team tab: never expose hashes or link tokens.
  const list = () => [
    ...(ownerPass ? [owner] : []),
    ...read().map(({ passwordHash, link, ...u }) => ({ ...u, pending: !passwordHash, linkExpired: Boolean(link && link.exp < Date.now()) })),
  ];
  const members = () => list().filter((u) => u.active);
  const activity = ({ userId = '', limit = 200 } = {}) => db.all('activity').filter((a) => !userId || a.userId === userId).slice(0, limit);

  return { adminAuth, requireAdmin, register, log, list, members, activity, byId, ROLES, OWNER_ID };
}

module.exports = { create, ROLES };
