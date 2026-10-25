// The notification center (/notifications) and its JSON API, notification
// preferences, the job-alert API for signed-in candidates, the email
// provider's delivery webhook, and the team's delivery monitor.
//
// Whoever is signed in — a candidate, an employer person or the team — sees
// only their own notifications. The recipient comes from the session, never
// from the browser; employer people see the notifications of the company
// they're signed in to that their current role still allows. A person signed
// in to more than one kind of account picks which one with ?as=.
const crypto = require('crypto');
const { can } = require('./employer-team');

const AUDIENCES = ['candidate', 'employer', 'team'];
const PAGE_SIZE = 20;
// What each audience is emailed about, per preference category (only the
// categories a person can switch off are listed).
const PREF_TEXT = {
  candidate: {
    applications: 'Updates when your recruiter tells you your application moved on',
    interviews: 'Interview emails are always sent: they are part of the interview you agreed to',
    jobs: 'Job alerts and new jobs that match the alerts you set up',
    work: 'If you work through Hireriv: joining steps, shift reminders, missing check-outs and timesheets',
  },
  employer: {
    applications: 'New applications, applicants assigned to you, offers to approve and hiring milestones',
    interviews: 'Candidates confirming or asking to move an interview, and feedback that is due',
    jobs: 'Your jobs closing on their last day to apply',
    work: 'Hireriv workers you supervise: missing check-ins, timesheets to approve and assignment changes',
  },
  team: {
    applications: 'Applicants assigned to you',
    interviews: 'Candidates answering interview invitations and feedback that is due',
    jobs: 'Jobs waiting for review and staffing requests',
    work: 'Documents to review, timesheets waiting, assignments and contracts ending, replacement requests',
  },
};
// Always sent, whatever the settings (shown so people know).
const ESSENTIAL_TEXT = {
  candidate: ['Your application confirmations', 'Interview invitations, new times, cancellations and reminders', 'Job offers and offer deadlines', 'Sign-in links, password and security messages'],
  employer: ['Decisions on jobs you sent for review', 'Invitations, sign-in and security messages'],
  team: ['Sign-in and security messages', 'The shared team inbox gets every application and request'],
};

function register(app, deps) {
  const { notify, team, clients, candidates, getJobs, sameOrigin, limit, readSubmissions, writeSubmissions, saveSubmission, jobCategories, jobLocations, adminAuth, requireAdmin, adminUrl } = deps;
  const jobById = (id) => getJobs().find((j) => j.id === id) || null;

  // ---------- who is asking ----------
  function viewers(req) {
    const out = [];
    const email = candidates().currentEmail(req);
    if (email) out.push({ as: 'candidate', rk: notify.candidateRk(email), email, label: 'Job seeker account', home: '/account' });
    const c = clients().context(req);
    if (c) {
      const { user, member, employer } = c;
      out.push({
        as: 'employer', rk: `e:${user.id}`, employerId: employer.id, userId: user.id, label: employer.company, home: '/employer',
        // Still allowed by the person's current role in this company.
        visible: (n) => {
          if (!n.perm) return true;
          const job = n.jobId ? jobById(n.jobId) : null;
          if (n.jobId && !job) return false;
          return can(member, n.perm, job);
        },
      });
    }
    const admin = team.currentUser(req);
    if (admin && !(team.requires2fa() && !team.has2fa(admin.id))) out.push({ as: 'team', rk: `t:${admin.id}`, userId: admin.id, label: `${deps.siteName} team`, home: '/admin' });
    return out;
  }
  const pick = (req, list) => {
    const want = String((req.query && req.query.as) || (req.body && req.body.as) || '');
    return list.find((v) => v.as === want) || list[0] || null;
  };
  const asQuery = (v, list) => (list.length > 1 ? `as=${v.as}` : '');

  // Unread counts for the header bells (pages only, and only when signed in).
  function locals(req, res, next) {
    res.locals.unread = {};
    if (req.method === 'GET' && /hr_/.test(req.headers.cookie || '') && !req.path.startsWith('/api/')) {
      try {
        for (const v of viewers(req)) res.locals.unread[v.as] = notify.unreadCount(v);
      } catch (e) { /* the bell is optional */ }
    }
    next();
  }

  const view = (n) => ({ id: n.id, type: n.type, category: n.category, title: n.title, body: n.body, link: n.link || null, read: Boolean(n.readAt), readAt: n.readAt, createdAt: n.createdAt });
  const filtersOf = (q) => ({
    unread: q.filter === 'unread' || q.unread === 'true' || q.unread === '1',
    category: Object.keys(notify.CATEGORIES).includes(q.category) ? q.category : '',
    offset: Math.max(0, Math.min(10000, Number.parseInt(q.offset, 10) || 0)),
    limit: Math.max(1, Math.min(100, Number.parseInt(q.limit, 10) || PAGE_SIZE)),
  });

  // ---------- pages ----------
  const page = (res, viewName, locals, status = 200) => res.status(status).set('Cache-Control', 'no-store').render(viewName, { page: 'notifications', noindex: true, msg: '', ...locals });
  function anyAccount(req, res, next) {
    const list = viewers(req);
    if (!list.length) return page(res, 'notifications-signin', { title: 'Notifications' }, 401);
    req.viewers = list;
    req.viewer = pick(req, list);
    next();
  }
  const backTo = (req, msg, extra = {}) => {
    const q = new URLSearchParams(Object.entries({ as: req.viewers.length > 1 ? req.viewer.as : '', filter: req.body.filter === 'unread' ? 'unread' : '', category: filtersOf(req.body).category, msg, ...extra }).filter(([, v]) => v));
    return `/notifications${q.toString() ? `?${q}` : ''}`;
  };

  app.get('/notifications', anyAccount, (req, res) => {
    const f = filtersOf(req.query);
    const r = notify.list(req.viewer, f);
    page(res, 'notifications', {
      title: 'Notifications', viewer: req.viewer, viewers: req.viewers, f, items: r.items.map(view), total: r.total, unread: r.unread,
      categories: notify.CATEGORIES, msg: String(req.query.msg || '').slice(0, 200),
      link: (patch) => `/notifications?${new URLSearchParams(Object.entries({ as: req.viewers.length > 1 ? req.viewer.as : '', filter: f.unread ? 'unread' : '', category: f.category, ...patch }).filter(([, v]) => v !== '' && v != null))}`,
    });
  });
  // Opening a notification marks it read and goes to what it's about.
  app.get('/notifications/:id/open', anyAccount, (req, res) => {
    const n = notify.markRead(req.viewer, req.params.id);
    res.redirect(n && notify.safeLink(n.link) ? n.link : `/notifications${asQuery(req.viewer, req.viewers) ? `?${asQuery(req.viewer, req.viewers)}` : ''}`);
  });
  app.post('/notifications/read-all', anyAccount, limit('notifications', 120), sameOrigin, (req, res) => {
    const n = notify.markAllRead(req.viewer, filtersOf(req.body).category);
    res.redirect(backTo(req, n ? `Marked ${n} as read.` : 'Nothing unread.'));
  });
  app.post('/notifications/:id/read', anyAccount, limit('notifications', 120), sameOrigin, (req, res, next) => {
    if (!notify.markRead(req.viewer, req.params.id)) return next();
    res.redirect(backTo(req, ''));
  });

  // ---------- preferences ----------
  const prefsView = (v) => {
    const p = notify.prefsOf(v.rk);
    return { email: p.email, categories: notify.OPTIONAL_CATEGORIES.map((c) => ({ key: c, label: notify.CATEGORIES[c], text: PREF_TEXT[v.as][c], on: p.email[c] !== false })), essential: ESSENTIAL_TEXT[v.as] };
  };
  app.get('/notifications/settings', anyAccount, (req, res) => {
    const alerts = req.viewer.as === 'candidate' ? readSubmissions('job-alerts').filter((s) => s.email === req.viewer.email && s.confirmed) : [];
    page(res, 'notification-settings', { title: 'Notification settings', viewer: req.viewer, viewers: req.viewers, prefs: prefsView(req.viewer), alerts, msg: String(req.query.msg || '').slice(0, 200) });
  });
  app.post('/notifications/settings', anyAccount, limit('notification-settings', 30), sameOrigin, (req, res) => {
    const email = Object.fromEntries(notify.OPTIONAL_CATEGORIES.map((c) => [c, req.body[`email_${c}`] === '1']));
    notify.setPrefs(req.viewer.rk, { email });
    res.redirect(`/notifications/settings?${new URLSearchParams(Object.entries({ as: req.viewers.length > 1 ? req.viewer.as : '', msg: 'Notification settings saved.' }).filter(([, v]) => v))}`);
  });

  // ---------- JSON API ----------
  function anyAccountApi(req, res, next) {
    const list = viewers(req);
    if (!list.length) return res.status(401).json({ ok: false, errors: ['sign in first'] });
    req.viewers = list;
    req.viewer = pick(req, list);
    res.set('Cache-Control', 'no-store');
    next();
  }
  app.get('/api/notifications', anyAccountApi, (req, res) => {
    const f = filtersOf(req.query);
    const r = notify.list(req.viewer, f);
    res.json({ ok: true, as: req.viewer.as, notifications: r.items.map(view), total: r.total, unread: r.unread, offset: f.offset, limit: f.limit });
  });
  app.get('/api/notifications/unread-count', anyAccountApi, (req, res) => res.json({ ok: true, as: req.viewer.as, unread: notify.unreadCount(req.viewer) }));
  app.patch('/api/notifications/:id/read', anyAccountApi, limit('notifications', 120), sameOrigin, (req, res) => {
    const n = notify.markRead(req.viewer, req.params.id);
    // Someone else's notification is simply "not found".
    if (!n) return res.status(404).json({ ok: false, errors: ['notification not found'] });
    res.json({ ok: true, notification: view(n) });
  });
  app.post('/api/notifications/read-all', anyAccountApi, limit('notifications', 120), sameOrigin, (req, res) => {
    const category = filtersOf(req.body || {}).category;
    res.json({ ok: true, marked: notify.markAllRead(req.viewer, category) });
  });
  app.get('/api/notification-preferences', anyAccountApi, (req, res) => {
    const p = prefsView(req.viewer);
    res.json({ ok: true, as: req.viewer.as, email: p.email, alwaysSent: p.essential, channels: { inApp: 'always on', email: 'per category', sms: 'not used for notifications yet', whatsapp: 'not used for notifications yet', push: 'not available yet' } });
  });
  app.patch('/api/notification-preferences', anyAccountApi, limit('notification-settings', 30), sameOrigin, (req, res) => {
    const input = (req.body || {}).email;
    if (!input || typeof input !== 'object' || Array.isArray(input)) return res.status(400).json({ ok: false, errors: ['send { email: { applications, interviews, jobs } } with true or false'] });
    const unknown = Object.keys(input).filter((k) => !notify.OPTIONAL_CATEGORIES.includes(k));
    const bad = Object.values(input).some((v) => typeof v !== 'boolean');
    if (unknown.length || bad) return res.status(400).json({ ok: false, errors: [unknown.length ? `these can't be changed: ${unknown.join(', ')}` : 'use true or false'] });
    res.json({ ok: true, email: notify.setPrefs(req.viewer.rk, { email: input }).email });
  });

  // ---------- job alerts for signed-in candidates ----------
  // (POST /api/job-alerts in server.js serves both: signed in, the alert is on
  // at once; otherwise it is confirmed by email.)
  const alertView = (s) => ({ id: s.id, category: s.category || null, location: s.location || null, createdAt: s.confirmedAt || s.createdAt });
  function requireCandidateApi(req, res, next) {
    const email = candidates().currentEmail(req);
    if (!email) return res.status(401).json({ ok: false, errors: ['sign in to your job seeker account first'] });
    req.candidateEmail = email;
    res.set('Cache-Control', 'no-store');
    next();
  }
  app.get('/api/job-alerts', requireCandidateApi, (req, res) => {
    res.json({ ok: true, alerts: readSubmissions('job-alerts').filter((s) => s.email === req.candidateEmail && s.confirmed).map(alertView) });
  });
  app.delete('/api/job-alerts/:id', requireCandidateApi, limit('account-alerts', 20), sameOrigin, (req, res) => {
    const subs = readSubmissions('job-alerts');
    const rest = subs.filter((s) => !(s.id === req.params.id && s.email === req.candidateEmail));
    if (rest.length === subs.length) return res.status(404).json({ ok: false, errors: ['job alert not found'] });
    writeSubmissions('job-alerts', rest);
    res.json({ ok: true });
  });
  // Creates a confirmed alert for the signed-in candidate (no email round trip).
  function createAlert(email, category, location) {
    if ((category && !jobCategories().includes(category)) || (location && !jobLocations().includes(location))) return { status: 400, errors: ['choose a category and city from the lists'] };
    const subs = readSubmissions('job-alerts');
    const existing = subs.find((s) => s.email === email && s.category === category && s.location === location);
    const now = new Date().toISOString();
    if (existing && existing.confirmed) return { status: 200, alert: existing, existed: true };
    if (existing) {
      Object.assign(existing, { confirmed: true, confirmedAt: now });
      writeSubmissions('job-alerts', subs);
      return { status: 201, alert: existing };
    }
    return { status: 201, alert: saveSubmission('job-alerts', { email, category, location, confirmed: true, confirmedAt: now, token: crypto.randomBytes(24).toString('hex') }) };
  }

  // ---------- the email provider's delivery reports ----------
  // Server to server only: signed with EMAIL_WEBHOOK_SECRET (see notify.js for
  // the format). Unsigned, stale or tampered requests are refused, and each
  // event id is processed once.
  app.post('/webhooks/email', limit('email-webhook', 600, 60000), (req, res) => {
    const secret = process.env.EMAIL_WEBHOOK_SECRET || '';
    if (!secret) return res.status(404).json({ ok: false });
    const raw = req.rawBody;
    if (!raw || !notify.verifySignature(raw, req.get('x-hireriv-signature'), secret)) return res.status(401).json({ ok: false, errors: ['bad signature'] });
    let body;
    try { body = JSON.parse(raw.toString('utf8')); } catch (e) { return res.status(400).json({ ok: false, errors: ['invalid JSON'] }); }
    res.json({ ok: true, ...notify.applyWebhook(body && body.events) });
  });

  // ---------- the team's delivery monitor (Admins) ----------
  app.get('/admin/notifications', adminAuth, requireAdmin, (req, res) => {
    const status = ['queued', 'sent', 'delivered', 'failed', 'bounced', 'complained', 'skipped'].includes(req.query.status) ? req.query.status : '';
    res.set('Cache-Control', 'no-store').render('admin-notifications', {
      title: 'Email delivery', page: 'admin', noindex: true, stats: notify.stats(), problems: notify.problems(), status,
      deliveries: notify.recentDeliveries(status, 100), suppressions: notify.suppressions().slice(0, 100), msg: String(req.query.msg || ''), types: notify.TYPES,
    });
  });
  app.post('/admin/notifications/:id/retry', adminAuth, requireAdmin, sameOrigin, (req, res) => {
    res.redirect(`/admin/notifications?msg=${encodeURIComponent(notify.retry(req.params.id) ? 'Queued to send again.' : 'Only failed emails can be retried.')}`);
  });
  app.post('/admin/notifications/suppressions/:id/delete', adminAuth, requireAdmin, sameOrigin, (req, res) => {
    notify.unsuppress(req.params.id);
    res.redirect(`/admin/notifications?msg=${encodeURIComponent('The address can receive emails again.')}`);
  });

  return { locals, viewers, createAlert, AUDIENCES };
}

module.exports = { register, PREF_TEXT, ESSENTIAL_TEXT };
