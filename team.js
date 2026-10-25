// Recruiter team: individual admin logins with roles, sessions and an activity log.
// Roles: "Admin" (Super Admin) sees and does everything; "Recruiter" works jobs,
// candidates and clients but can't touch billing, settings, the team, backups or
// deletions. Recruitment Managers, Account Managers and Finance Managers add
// their own permissions (agency-roles.js); a Finance Manager sees billing only.
// The ADMIN_USER / ADMIN_PASS account from the environment is the built-in owner
// (always an Admin), so a fresh install can sign in and invite the team.
// Anyone can add two-step sign-in (an authenticator app code after the
// password), and an Admin can require it for the whole team.
const crypto = require('crypto');
const { hashPassword, checkPassword } = require('./employers');
const tf = require('./twofactor');
const agencyRoles = require('./agency-roles');

const { ROLES } = agencyRoles;
const SESSION_HOURS = 12;
const INVITE_HOURS = 72;
const COOKIE = 'hr_admin';
const OWNER_ID = 'owner';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_ACTIVITY = 2000;
const CODE_COOKIE = 'hr_admin_code';
const CODE_MINUTES = 5; // time allowed to type the code after a correct password
const CODE_TRIES = 5; // wrong codes before the password has to be entered again
const SETUP_MINUTES = 15;
const OWNER_SECURITY = 'owner:security';
const REQUIRE_KEY = 'team:require2fa';

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

function create({ db, mailer, baseUrl, ownerUser, ownerPass, site = {}, resetOwner2fa = false }) {
  const read = () => db.all('team');
  const write = (list) => db.replaceAll('team', list);
  const secureCookie = /^https:/.test(baseUrl);
  const owner = { id: OWNER_ID, name: 'Owner', email: ownerUser, role: 'Admin', active: true, builtIn: true };
  const enabled = () => Boolean(ownerPass) || read().some((u) => u.active && u.passwordHash);
  const byId = (id) => (id === OWNER_ID && ownerPass ? owner : read().find((u) => u.id === id && u.active));

  // ---------- two-step sign-in state ----------
  // Team members keep it on their record; the owner account lives in the
  // environment, so its copy is kept in the meta table.
  function securityOf(userId) {
    if (userId === OWNER_ID) {
      try { return JSON.parse(db.metaGet(OWNER_SECURITY) || '{}'); } catch (e) { return {}; }
    }
    const u = read().find((x) => x.id === userId);
    return u ? { twoFactor: u.twoFactor || null, twoFactorPending: u.twoFactorPending || null } : {};
  }
  function saveSecurity(userId, patch) {
    if (userId === OWNER_ID) return db.metaSet(OWNER_SECURITY, JSON.stringify({ ...securityOf(OWNER_ID), ...patch }));
    const list = read();
    const u = list.find((x) => x.id === userId);
    if (u) {
      Object.assign(u, patch);
      write(list);
    }
  }
  const has2fa = (userId) => Boolean(securityOf(userId).twoFactor);
  const requires2fa = () => db.metaGet(REQUIRE_KEY) === '1';
  const recoveryLeft = (t) => (t && t.recovery ? t.recovery.filter(Boolean).length : 0);

  // Checks an authenticator code or an unused recovery code and records its use.
  function useSecondFactor(userId, input) {
    const t = securityOf(userId).twoFactor;
    if (!t) return null;
    const step = tf.verifyCode(t.secret, input, { lastStep: t.lastStep });
    if (step !== null) {
      saveSecurity(userId, { twoFactor: { ...t, lastStep: step } });
      return { how: 'code' };
    }
    const i = tf.findRecovery(t.recovery, input);
    if (i < 0) return null;
    const recovery = t.recovery.slice();
    recovery[i] = null;
    saveSecurity(userId, { twoFactor: { ...t, recovery } });
    return { how: 'recovery', left: recovery.filter(Boolean).length };
  }

  // Security emails only go to real addresses (the owner may sign in as "admin").
  function notify(user, subject, message) {
    if (EMAIL_RE.test(String(user.email || ''))) mailer.teamSecurityNotice(user, subject, message);
  }

  // ---------- activity log ----------
  function log(user, action, detail = '') {
    const entry = { id: crypto.randomUUID(), at: new Date().toISOString(), userId: user ? user.id : '', userName: user ? user.name : 'System', action: String(action).slice(0, 300), detail: String(detail).slice(0, 200) };
    db.prepend('activity', entry);
    // Keep the log bounded; the oldest entries fall off.
    if (db.count('activity') > MAX_ACTIVITY + 100) db.replaceAll('activity', db.all('activity').slice(0, MAX_ACTIVITY));
  }

  // Way back in for an owner who lost their phone and their recovery codes.
  if (resetOwner2fa && securityOf(OWNER_ID).twoFactor) {
    db.metaSet(OWNER_SECURITY, '{}');
    log(null, 'Owner two-step sign-in removed (RESET_OWNER_2FA)', 'owner');
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
    res.locals.canBill = agencyRoles.canBill(user);
    res.locals.agencyCan = (action) => agencyRoles.can(user, action);
    res.locals.roleLabel = (agencyRoles.ROLE_INFO[user.role] || { label: user.role }).label;
    if (!agencyRoles.pathAllowed(user, req.path)) {
      if (!wantsHtml(req)) return res.status(403).send('Your role does not include this page.');
      return res.status(403).render('thanks', { title: 'Not part of your role', page: '', ok: false, message: 'Your role covers billing only. Ask an Admin on your team if you need this page.', noindex: true });
    }
    // When the team requires two-step sign-in, people without it can only set it up.
    if (requires2fa() && !has2fa(user.id) && !req.path.startsWith('/admin/security')) {
      if (wantsHtml(req)) return res.redirect('/admin/security');
      return res.status(403).send('Your team requires two-step sign-in. Set it up at /admin/security first.');
    }
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
  // Invoices, payments and credit notes: Admins and Finance Managers.
  function requireBilling(req, res, next) {
    if (agencyRoles.canBill(req.admin)) return next();
    res.status(403).render('thanks', { title: 'Billing only', page: '', ok: false, message: 'Only an Admin or a Finance Manager can do this.', noindex: true });
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
      if (has2fa(user.id)) {
        // Password is right; the session only starts once the code is too.
        const token = newToken();
        db.sessions.set('admin-code', sha(token), user.id, Date.now() + CODE_MINUTES * 60000);
        res.cookie(CODE_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: secureCookie, maxAge: CODE_MINUTES * 60000, path: '/admin/login' });
        return res.redirect(`/admin/login/code?next=${encodeURIComponent(next)}`);
      }
      failed.delete(req.ip);
      startSession(res, user.id);
      log(user, 'Signed in');
      res.redirect(next);
    });

    // ---------- second step: the authenticator code ----------
    const codeTries = new Map();
    function pendingLogin(req) {
      const token = parseCookies(req.headers.cookie)[CODE_COOKIE];
      const key = token && sha(token);
      const s = key && db.sessions.get('admin-code', key);
      const user = s && byId(s.subject);
      return user ? { key, user } : null;
    }
    function endPending(res, key) {
      db.sessions.delete('admin-code', key);
      codeTries.delete(key);
      res.clearCookie(CODE_COOKIE, { path: '/admin/login' });
    }
    const timedOut = (res, next) => page(res, 'admin-login', { title: 'Team sign in', login: '', next, errors: ['Your sign-in timed out. Enter your password again.'] }, 401);

    app.get('/admin/login/code', (req, res) => {
      const next = safeNext(req.query.next);
      if (!pendingLogin(req)) return res.redirect(`/admin/login?next=${encodeURIComponent(next)}`);
      page(res, 'admin-code', { title: 'Two-step sign-in', next });
    });

    app.post('/admin/login/code', sameOrigin, (req, res) => {
      const next = safeNext(req.body.next);
      const p = pendingLogin(req);
      if (!p) return timedOut(res, next);
      if (tooMany(req.ip)) return page(res, 'admin-code', { title: 'Two-step sign-in', next, errors: ['Too many failed attempts. Try again in 15 minutes.'] }, 429);
      if (!has2fa(p.user.id)) {
        // Reset by an Admin in the meantime: start again from the password.
        endPending(res, p.key);
        return timedOut(res, next);
      }
      const used = useSecondFactor(p.user.id, String(req.body.code || '').slice(0, 40));
      if (!used) {
        failed.set(req.ip, [...(failed.get(req.ip) || []), Date.now()]);
        const tries = (codeTries.get(p.key) || 0) + 1;
        codeTries.set(p.key, tries);
        if (tries >= CODE_TRIES) {
          endPending(res, p.key);
          return page(res, 'admin-login', { title: 'Team sign in', login: '', next, errors: ['Too many wrong codes. Enter your password again.'] }, 401);
        }
        return page(res, 'admin-code', { title: 'Two-step sign-in', next, errors: ["That code didn't work. Codes change every 30 seconds, so use the one showing now."] }, 401);
      }
      endPending(res, p.key);
      failed.delete(req.ip);
      startSession(res, p.user.id);
      if (used.how === 'recovery') {
        log(p.user, `Signed in with a recovery code (${used.left} left)`);
        notify(p.user, 'A recovery code was used to sign in', `Someone signed in to your ${site.name} team account with one of your recovery codes. ${used.left} unused code${used.left === 1 ? '' : 's'} left. If this wasn't you, ask an Admin to reset your two-step sign-in and change your password straight away.`);
      } else log(p.user, 'Signed in');
      res.redirect(next);
    });

    // ---------- your own sign-in security (everyone on the team) ----------
    const secUrl = (msg) => `/admin/security${msg ? `?msg=${encodeURIComponent(msg)}` : ''}`;
    function securityPage(req, res, extra = {}) {
      const s = securityOf(req.admin.id);
      const pending = s.twoFactorPending && s.twoFactorPending.exp > Date.now() ? s.twoFactorPending : null;
      const account = EMAIL_RE.test(req.admin.email) ? req.admin.email : `${req.admin.email} (owner)`;
      let setup = null;
      if (!s.twoFactor && pending) {
        const url = tf.otpauthUrl({ issuer: site.name || 'Hireriv', account, secret: pending.secret });
        setup = { qr: tf.qrSvg(url), key: tf.groupSecret(pending.secret), url };
      }
      res.set('Cache-Control', 'no-store');
      page(res, 'admin-security', {
        title: 'Sign-in security', on: Boolean(s.twoFactor), enabledAt: s.twoFactor ? s.twoFactor.enabledAt : '', recoveryLeft: recoveryLeft(s.twoFactor),
        required: requires2fa(), setup, codes: null, msg: String(req.query.msg || '').slice(0, 300), ...extra,
      });
    }
    function issueRecovery(userId) {
      const { codes, hashes } = tf.newRecoveryCodes();
      const t = securityOf(userId).twoFactor;
      saveSecurity(userId, { twoFactor: { ...t, recovery: hashes } });
      return codes;
    }

    app.get('/admin/security', adminAuth, (req, res) => securityPage(req, res));

    app.post('/admin/security/start', adminAuth, sameOrigin, (req, res) => {
      if (has2fa(req.admin.id)) return res.redirect(secUrl());
      saveSecurity(req.admin.id, { twoFactorPending: { secret: tf.newSecret(), exp: Date.now() + SETUP_MINUTES * 60000 } });
      res.redirect(secUrl('Started setting up two-step sign-in'));
    });

    app.post('/admin/security/confirm', adminAuth, sameOrigin, (req, res) => {
      const s = securityOf(req.admin.id);
      const pending = s.twoFactorPending && s.twoFactorPending.exp > Date.now() ? s.twoFactorPending : null;
      if (s.twoFactor) return res.redirect(secUrl());
      if (!pending) return res.redirect(secUrl('The set-up timed out. Start again and scan the new QR code.'));
      const step = tf.verifyCode(pending.secret, req.body.code);
      if (step === null) return res.redirect(secUrl("That code didn't match. Check the app shows a code for this account and try the one showing now."));
      saveSecurity(req.admin.id, { twoFactor: { secret: pending.secret, lastStep: step, recovery: [], enabledAt: new Date().toISOString() }, twoFactorPending: null });
      const codes = issueRecovery(req.admin.id);
      // Other sessions were opened with only a password; sign them out.
      db.sessions.deleteSubject('admin', req.admin.id);
      startSession(res, req.admin.id);
      log(req.admin, 'Turned on two-step sign-in');
      notify(req.admin, 'Two-step sign-in is on', `Two-step sign-in is now on for your ${site.name} team account. From now on you'll enter a code from your authenticator app after your password. Keep your recovery codes somewhere safe.`);
      securityPage(req, res, { codes, msg: 'Two-step sign-in is on. Save your recovery codes now.' });
    });

    app.post('/admin/security/recovery', adminAuth, sameOrigin, (req, res) => {
      if (!has2fa(req.admin.id)) return res.redirect(secUrl());
      if (!useSecondFactor(req.admin.id, String(req.body.code || '').slice(0, 40))) return res.redirect(secUrl("That code didn't work, so your recovery codes were not changed."));
      const codes = issueRecovery(req.admin.id);
      log(req.admin, 'Made new recovery codes');
      securityPage(req, res, { codes, msg: 'New recovery codes made. The old ones no longer work.' });
    });

    app.post('/admin/security/off', adminAuth, sameOrigin, (req, res) => {
      if (!has2fa(req.admin.id)) return res.redirect(secUrl());
      if (requires2fa()) return res.redirect(secUrl('Your team requires two-step sign-in, so it cannot be turned off. Ask an Admin to reset it if you changed phones.'));
      if (!useSecondFactor(req.admin.id, String(req.body.code || '').slice(0, 40))) return res.redirect(secUrl("That code didn't work, so two-step sign-in is still on."));
      saveSecurity(req.admin.id, { twoFactor: null, twoFactorPending: null });
      notify(req.admin, 'Two-step sign-in was turned off', `Two-step sign-in was turned off for your ${site.name} team account, so only your password is needed to sign in. If this wasn't you, change your password and tell an Admin.`);
      res.redirect(secUrl('Two-step sign-in turned off'));
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

    // Lost phone: clears their two-step sign-in so they set it up again.
    app.post('/admin/team/:id/reset-2fa', adminAuth, requireAdmin, sameOrigin, (req, res, next) => {
      const u = req.params.id === OWNER_ID ? (ownerPass ? owner : null) : read().find((x) => x.id === req.params.id);
      if (!u) return next();
      if (u.id === req.admin.id) return res.redirect(adminUrl('team', 'Manage your own two-step sign-in from Sign-in security'));
      if (!has2fa(u.id)) return res.redirect(adminUrl('team', `${u.name} doesn't use two-step sign-in`));
      saveSecurity(u.id, { twoFactor: null, twoFactorPending: null });
      db.sessions.deleteSubject('admin', u.id);
      notify(u, 'Your two-step sign-in was reset', `${req.admin.name} reset two-step sign-in for your ${site.name} team account and you were signed out. Sign in with your password${requires2fa() ? ' and set up your authenticator app again' : '. You can set up your authenticator app again under Sign-in security'}.`);
      res.redirect(adminUrl('team', `Two-step sign-in reset for ${u.name} · they were signed out`));
    });

    app.post('/admin/team/require-2fa', adminAuth, requireAdmin, sameOrigin, (req, res) => {
      const on = req.body.require === '1';
      if (on && !has2fa(req.admin.id)) return res.redirect(adminUrl('team', 'Turn on two-step sign-in for your own account first (Sign-in security)'));
      db.metaSet(REQUIRE_KEY, on ? '1' : '0');
      res.redirect(`${adminUrl('team', on ? 'Two-step sign-in is now required for everyone on the team' : 'Two-step sign-in is now optional')}#two-step`);
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
    ...(ownerPass ? [{ ...owner, twoFactorOn: has2fa(OWNER_ID) }] : []),
    ...read().map(({ passwordHash, link, twoFactor, twoFactorPending, ...u }) => ({ ...u, pending: !passwordHash, linkExpired: Boolean(link && link.exp < Date.now()), twoFactorOn: Boolean(twoFactor) })),
  ];
  const members = () => list().filter((u) => u.active);
  const activity = ({ userId = '', limit = 200 } = {}) => db.all('activity').filter((a) => !userId || a.userId === userId).slice(0, limit);

  return { adminAuth, requireAdmin, requireBilling, register, log, list, members, activity, byId, currentUser, has2fa, requires2fa, ROLES, OWNER_ID };
}

module.exports = { create, ROLES };
