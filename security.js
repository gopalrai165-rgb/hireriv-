// Security monitoring and incident response (Step 62).
//
// - Security log (`security-events`): failed and locked sign-ins, refused
//   requests (403), every sensitive document opened, bulk exports, identity
//   confirmations and privileged team changes. Each entry has the actor, what
//   happened, the target, the time, the IP address and the outcome; never a
//   password, token, email address or file contents. Kept for the retention
//   policy's security-log period (at least 180 days).
// - Alerts: repeated failed sign-ins, repeated refusals, unusual numbers of
//   document downloads or exports, and privileged changes (roles, two-step
//   sign-in, backups, retention) reach the people who watch security, at most
//   once an hour per rule and subject. Alerts never block anyone by themselves.
// - Confirming it's you: bulk exports, backups, erasing an account, changing
//   the retention policy and incident containment need the password (and the
//   authenticator code) again within the last 10 minutes.
// - Incidents (`security-incidents`): the seven steps of the response plan
//   (docs/SECURITY.md), containment actions, preserved log evidence, decisions
//   about notifying CERT-In, the Data Protection Board and affected people,
//   and lessons learned. Every change is in the hash-chained audit trail.
const crypto = require('crypto');
const { paginate } = require('./paginate');
const roles = require('./agency-roles');
const vault = require('./vault');

const EVENTS = 'security-events';
const INCIDENTS = 'security-incidents';
const EVIDENCE = 'security-evidence';
const MIN = 60000;
const HOUR = 60 * MIN;
const CONFIRM_MINUTES = 10;

const EVENT_TYPES = {
  'sign-in-failed': 'Sign-in failed',
  'sign-in-locked': 'Sign-in locked out',
  'access-denied': 'Request refused (not allowed)',
  'document-access': 'Document opened',
  'bulk-export': 'Bulk export',
  'identity-confirmed': 'Confirmed it was them',
  'privileged-change': 'Privileged change',
  alert: 'Alert',
};
// Sign-in forms and APIs: 401 is a wrong password or code, 429 a lock-out.
const SIGN_IN_PATHS = ['/admin/login', '/admin/login/code', '/employer/login', '/account/login', '/api/auth/login', '/admin/confirm'];
const RESET_PATHS = [/^\/account\/forgot$/, /^\/account\/reset\//, /^\/employer\/forgot$/, /^\/employer\/reset\//, /^\/api\/auth\/verify-email$/];

const RULES = {
  'sign-ins-ip': { label: 'Repeated failed sign-ins from one address', windowMs: 15 * MIN, threshold: 10, severity: 'medium' },
  'sign-ins-account': { label: 'Repeated failed sign-ins on one account', windowMs: 15 * MIN, threshold: 5, severity: 'medium' },
  'access-denied': { label: 'Repeated refused requests', windowMs: 10 * MIN, threshold: 10, severity: 'medium' },
  'document-downloads': { label: 'Unusual number of document downloads', windowMs: HOUR, threshold: Number(process.env.SECURITY_DOWNLOAD_ALERT) || 40, severity: 'high' },
  'bulk-exports': { label: 'Unusual number of bulk exports', windowMs: HOUR, threshold: Number(process.env.SECURITY_EXPORT_ALERT) || 5, severity: 'high' },
  'privileged-change': { label: 'Privileged change on the team account', windowMs: 0, threshold: 1, severity: 'medium' },
};
// Team activity that always raises an alert (team.js log lines).
const PRIVILEGED = [
  [/ is now (Admin|Recruitment Manager|Recruiter|Account Manager|Staffing Manager|Finance Manager|Sales Manager|Business Development|Verification Reviewer|Job Moderator|Support Agent|Trust & Safety Manager|Operations Admin|Auditor)$/, 'Role changed'],
  [/^Invited .+ as /, 'Team member invited'],
  [/ (re-activated|deactivated and signed out)$/, 'Team member activated or deactivated'],
  [/^Two-step sign-in reset for /, 'Two-step sign-in reset'],
  [/^Two-step sign-in is now optional$/, 'Two-step sign-in no longer required'],
  [/^Turned off two-step sign-in$/, 'Two-step sign-in turned off'],
  [/RESET_OWNER_2FA/, 'Owner two-step sign-in removed'],
  [/^(Turned on|Turned off) data retention/, 'Data retention changed'],
  [/^Changed the retention policy/, 'Retention policy changed'],
  [/^(Took a database backup|Downloaded a database backup|Downloaded the database)/, 'Database backup taken or downloaded'],
];

const SEVERITIES = { low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical' };
const CATEGORIES = {
  'account-takeover': 'Account takeover or stolen sign-in',
  'unauthorised-access': 'Unauthorised access to records',
  'data-exposure': 'Personal data exposed or sent to the wrong person',
  malware: 'Malware or a malicious upload',
  availability: 'Outage or attack on the service',
  insider: 'Misuse by someone with access',
  other: 'Something else',
};
// The response plan, in order (docs/SECURITY.md).
const STEPS = [
  ['detected', 'Detect and classify'],
  ['contained', 'Contain affected accounts, sessions, files or services'],
  ['evidence', 'Preserve evidence and logs'],
  ['investigated', 'Investigate scope and impact'],
  ['notified', 'Notify authorities and affected people where required'],
  ['restored', 'Restore safely and rotate credentials or secrets'],
  ['reviewed', 'Document and put preventive measures in place'],
];
// Who may have to be told. CERT-In expects reportable incidents within 6
// hours of noticing them; whether a report is required is a decision recorded here.
const NOTIFY = {
  'cert-in': { label: 'CERT-In', hours: 6 },
  board: { label: 'Data Protection Board of India', hours: 72 },
  people: { label: 'Affected people', hours: null },
  clients: { label: 'Affected client companies', hours: null },
};
const DECISIONS = { undecided: 'Not decided yet', required: 'Required', 'not-required': 'Not required' };
const CONTAIN = {
  'end-team-sessions': 'Sign a team member out everywhere',
  'end-candidate-sessions': 'Sign a job seeker out everywhere',
  'end-employer-sessions': 'Sign an employer user out everywhere',
  'rotate-download-links': 'Cancel every download link issued so far',
};

const iso = (t = Date.now()) => new Date(t).toISOString();
const clip = (v, n) => String(v ?? '').trim().slice(0, n);
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// Tokens in paths (sign-in links, resets) never reach the log.
// Email addresses in free text (team activity lines) are masked.
const scrub = (s) => String(s).replace(/[^\s@<>()"',;]+@[^\s@<>()"',;]+\.[a-z]{2,}/gi, '[email]');
const cleanPath = (p) => String(p || '').split('?')[0].replace(/[A-Za-z0-9_-]{20,}/g, ':token').slice(0, 200);

function create({ db, notify, mailer, getTeam }) {
  const recent = new Map(); // rule|subject -> [times]
  const alerted = new Map(); // rule|subject -> last alert time

  function actorOf(req) {
    if (!req) return { actorKind: 'system', actorId: '', actorLabel: 'System' };
    if (req.admin) return { actorKind: 'team', actorId: String(req.admin.id), actorLabel: clip(req.admin.name, 80), role: req.admin.role };
    if (req.employerUser) return { actorKind: 'employer', actorId: String(req.employerUser.id), actorLabel: clip(req.employerUser.name, 80), employerId: req.employer ? String(req.employer.id) : '' };
    if (req.candidateEmail) return { actorKind: 'candidate', actorId: notify.candidateRk(req.candidateEmail), actorLabel: 'Job seeker' };
    return { actorKind: 'visitor', actorId: '', actorLabel: 'Not signed in' };
  }

  function record(type, { req = null, actor = null, outcome = 'ok', target = '', detail = '', at = iso() } = {}) {
    const e = {
      id: crypto.randomUUID(), at, type, outcome, ...(actor || actorOf(req)),
      ip: req ? clip(req.ip, 60) : '', path: req ? cleanPath(req.originalUrl || req.path) : '', method: req ? req.method : '',
      target: scrub(clip(target, 160)), detail: scrub(clip(detail, 300)),
    };
    db.prepend(EVENTS, e);
    try { watch(e); } catch (err) { console.error('Security alert check failed:', err.message); }
    return e;
  }

  // ---------- alerts ----------
  function bump(rule, subject, now) {
    const r = RULES[rule];
    const key = `${rule}|${subject}`;
    const list = (recent.get(key) || []).filter((t) => t > now - r.windowMs);
    list.push(now);
    recent.set(key, list);
    return list.length;
  }
  function watch(e) {
    const now = Date.parse(e.at);
    const who = e.actorId ? `${e.actorKind}:${e.actorId}` : `ip:${e.ip}`;
    if (e.type === 'sign-in-failed' || e.type === 'sign-in-locked') {
      const n = bump('sign-ins-ip', e.ip, now);
      if (n >= RULES['sign-ins-ip'].threshold) alert('sign-ins-ip', e.ip, `${n} failed sign-ins from ${e.ip} in 15 minutes (latest at ${e.path})`, e);
      if (e.target) {
        const m = bump('sign-ins-account', e.target, now);
        if (m >= RULES['sign-ins-account'].threshold) alert('sign-ins-account', e.target, `${m} failed sign-ins on one ${e.detail || ''} account in 15 minutes (account ref ${e.target})`, e);
      }
    } else if (e.type === 'access-denied') {
      const n = bump('access-denied', who, now);
      if (n >= RULES['access-denied'].threshold) alert('access-denied', who, `${n} refused requests by ${e.actorLabel}${e.ip ? ` (${e.ip})` : ''} in 10 minutes, latest ${e.method} ${e.path}`, e);
    } else if (e.type === 'document-access' && e.outcome === 'ok') {
      const n = bump('document-downloads', who, now);
      if (n >= RULES['document-downloads'].threshold) alert('document-downloads', who, `${e.actorLabel} opened ${n} documents in an hour`, e);
    } else if (e.type === 'bulk-export' && e.outcome === 'ok') {
      const n = bump('bulk-exports', who, now);
      if (n >= RULES['bulk-exports'].threshold) alert('bulk-exports', who, `${e.actorLabel} made ${n} bulk exports in an hour (latest: ${e.target})`, e);
    } else if (e.type === 'privileged-change') {
      alert('privileged-change', `${who}|${e.target}|${e.detail}`, `${e.actorLabel}: ${e.target}${e.detail ? ` (${e.detail})` : ''}`, e, { force: true });
    }
  }
  const watchers = () => getTeam().members().filter((u) => roles.can(u, 'security.view'));
  function alert(rule, subject, summary, cause, { force = false } = {}) {
    const key = `${rule}|${subject}`;
    const now = Date.parse(cause.at);
    if (!force && alerted.get(key) > now - HOUR) return null;
    alerted.set(key, now);
    const r = RULES[rule];
    // Late at night (India time) a privileged change is more surprising.
    const hourIst = (new Date(now + 5.5 * HOUR)).getUTCHours();
    const severity = rule === 'privileged-change' && (hourIst >= 22 || hourIst < 6) ? 'high' : r.severity;
    const a = {
      id: crypto.randomUUID(), at: iso(now), type: 'alert', outcome: 'raised', actorKind: cause.actorKind, actorId: cause.actorId, actorLabel: cause.actorLabel,
      ip: cause.ip, path: cause.path, method: cause.method, target: rule, detail: clip(summary, 300), severity, rule: r.label, causeId: cause.id,
    };
    db.prepend(EVENTS, a);
    const people = watchers();
    if (people.length) {
      notify.emit({ key: `security-alert:${a.id}`, type: 'security-alert', to: people.map((u) => ({ kind: 'team', userId: u.id })), inApp: { title: `Security alert: ${r.label}`, body: clip(summary, 280), link: '/admin/security-events?type=alert' } });
      for (const u of people) if (EMAIL_RE.test(String(u.email || ''))) mailer.teamSecurityNotice(u, `Security alert: ${r.label}`, `${summary}. Severity: ${SEVERITIES[severity]}. Review it under Security alerts, and open an incident if it needs a response.`);
    }
    return a;
  }

  // Watches every response: failed sign-ins, lock-outs and refusals.
  function observe(req, res, next) {
    res.on('finish', () => {
      try {
        const s = res.statusCode;
        const p = req.path;
        if (req.method === 'POST' && SIGN_IN_PATHS.includes(p) && (s === 401 || s === 429)) {
          const login = clip((req.body && (req.body.login || req.body.email)) || '', 160).toLowerCase();
          const kind = p.startsWith('/admin') ? 'team' : p.startsWith('/employer') ? 'employer' : 'job-seeker';
          // The account is a short hash, so the log never holds the address typed in.
          record(s === 429 ? 'sign-in-locked' : 'sign-in-failed', { req, outcome: 'refused', target: login ? sha256(`${kind}|${login}`).slice(0, 12) : '', detail: kind });
        } else if (req.method === 'POST' && s === 429 && RESET_PATHS.some((re) => re.test(p))) {
          record('sign-in-locked', { req, outcome: 'refused', detail: 'password reset or verification' });
        } else if (s === 403 && !SIGN_IN_PATHS.includes(p)) {
          record('access-denied', { req, outcome: 'refused' });
        }
      } catch (err) {
        console.error('Security log failed:', err.message);
      }
    });
    next();
  }

  // Sensitive documents (vault.send): who opened what, and whether it worked.
  vault.onAccess = (req, what, ok) => record('document-access', { req, outcome: ok ? 'ok' : 'missing', target: what });

  // Records a bulk export once it has been sent.
  const bulkExport = (label) => (req, res, next) => {
    res.on('finish', () => record('bulk-export', { req, outcome: res.statusCode === 200 ? 'ok' : `status ${res.statusCode}`, target: typeof label === 'function' ? label(req) : label }));
    next();
  };

  function prune(days) {
    const cutoff = iso(Date.now() - days * 86400000);
    const list = db.all(EVENTS);
    const keep = list.filter((e) => e.at >= cutoff);
    if (keep.length !== list.length) db.replaceAll(EVENTS, keep);
    return list.length - keep.length;
  }

  // Privileged team changes (team.js activity lines) raise an alert.
  function watchTeam(team) {
    team.onLog((entry, user) => {
      const hit = PRIVILEGED.find(([re]) => re.test(entry.action));
      if (!hit) return;
      const actor = user ? { actorKind: 'team', actorId: String(user.id), actorLabel: clip(user.name, 80), role: user.role } : { actorKind: 'system', actorId: '', actorLabel: 'System' };
      record('privileged-change', { actor, target: hit[1], detail: entry.action });
    });
  }

  return { record, observe, bulkExport, prune, actorOf, cleanPath, watchTeam };
}

// ---------- pages, confirmation and incidents ----------
function register(app, deps) {
  const { db, security, team, adminAuth, sameOrigin, limit, trust, view, rotateDownloadLinks, readSubmissions } = deps;
  const can = (u, a) => roles.can(u, a);
  const json = (req) => (req.get('Accept') || '').includes('json');
  const gate = (action) => (req, res, next) => {
    if (can(req.admin, action)) return next();
    if (json(req)) return res.status(403).json({ ok: false, errors: ['your role does not allow that'] });
    res.status(403).render('thanks', { title: 'Not part of your role', page: '', ok: false, message: 'Your role does not include this page. Ask an Admin on your team if you need it.', noindex: true });
  };
  const back = (res, url, msg) => res.redirect(303, `${url}${url.includes('?') ? '&' : '?'}msg=${encodeURIComponent(msg)}`);
  const safeAdminPath = (p) => (typeof p === 'string' && /^\/(admin|api\/admin|api\/analytics)(\/|$|\?)/.test(p) && !p.startsWith('//') && !/[\r\n\\]/.test(p) ? p : '/admin');

  // ---------- confirming it's you ----------
  const confirmedAt = (req) => {
    const key = team.sessionKey(req);
    const s = key && db.sessions.get('admin-confirm', key);
    return s && req.admin && s.subject === String(req.admin.id);
  };
  function requireConfirmed(req, res, next) {
    if (confirmedAt(req)) return next();
    if (json(req)) return res.status(403).json({ ok: false, errors: ['confirm your password first'], confirm: '/admin/confirm' });
    let from = req.originalUrl;
    if (req.method !== 'GET') {
      try { from = new URL(req.get('Referer') || '', 'http://x').pathname; } catch (e) { from = '/admin'; }
    }
    res.redirect(303, `/admin/confirm?next=${encodeURIComponent(safeAdminPath(from))}${req.method !== 'GET' ? '&again=1' : ''}`);
  }
  app.get('/admin/confirm', adminAuth, (req, res) => {
    view(req, res, { title: 'Confirm it’s you', section: 'confirm', next: safeAdminPath(req.query.next), again: req.query.again === '1', uses2fa: team.has2fa(req.admin.id) });
  });
  app.post('/admin/confirm', adminAuth, limit('admin-confirm', 10), sameOrigin, (req, res) => {
    const next = safeAdminPath(req.body.next);
    const problem = team.confirmIdentity(req.admin, req.body.password, req.body.code);
    if (problem) return view(req, res, { title: 'Confirm it’s you', section: 'confirm', next, again: false, uses2fa: team.has2fa(req.admin.id), errors: [problem] }, 401);
    db.sessions.set('admin-confirm', team.sessionKey(req), String(req.admin.id), Date.now() + CONFIRM_MINUTES * MIN);
    security.record('identity-confirmed', { req, target: next });
    res.redirect(303, next);
  });

  // ---------- security log and alerts ----------
  function events(q = {}) {
    const type = EVENT_TYPES[q.type] ? q.type : '';
    const text = clip(q.q, 80).toLowerCase();
    return db.all(EVENTS).filter((e) => (!type || e.type === type) && (!text || `${e.actorLabel} ${e.ip} ${e.path} ${e.target} ${e.detail}`.toLowerCase().includes(text)));
  }
  function summary() {
    const since = iso(Date.now() - 24 * HOUR);
    const day = db.all(EVENTS).filter((e) => e.at >= since);
    const count = (t) => day.filter((e) => e.type === t).length;
    return {
      alerts24h: count('alert'), failedSignIns24h: count('sign-in-failed') + count('sign-in-locked'), refused24h: count('access-denied'),
      documents24h: count('document-access'), exports24h: count('bulk-export'),
      openIncidents: db.all(INCIDENTS).filter((i) => i.status !== 'closed').length,
    };
  }
  app.get('/admin/security-events', adminAuth, gate('security.view'), (req, res) => {
    const { rows, pager } = paginate(events(req.query), { page: req.query.page, size: 50, query: req.query, path: '/admin/security-events' });
    view(req, res, { title: 'Security alerts & log', section: 'security', rows, pager, q: req.query, s: summary(), EVENT_TYPES, RULES });
  });
  app.get('/api/admin/security-events', adminAuth, gate('security.view'), limit('security-api', 120, 60000), (req, res) => {
    const { rows, pager } = paginate(events(req.query), { page: req.query.page, size: 100, query: req.query, path: '' });
    res.set('Cache-Control', 'no-store').json({ ok: true, summary: summary(), events: rows, page: pager.page, pages: pager.pages, total: pager.total });
  });

  // ---------- incidents ----------
  const incidents = () => db.all(INCIDENTS);
  const byId = (id) => incidents().find((i) => i.id === id);
  function nextNumber() {
    const n = Number(db.metaGet('security:incident-seq') || 0) + 1;
    db.metaSet('security:incident-seq', String(n));
    return `INC-${String(n).padStart(4, '0')}`;
  }
  const deadline = (i, target) => (NOTIFY[target].hours ? iso(Date.parse(i.detectedAt) + NOTIFY[target].hours * HOUR) : null);
  function decorate(i) {
    const now = iso();
    const due = Object.keys(NOTIFY).map((k) => {
      const decision = (i.notify || {})[k] || 'undecided';
      const sent = (i.notifications || []).filter((n) => n.to === k);
      const by = deadline(i, k);
      return { key: k, label: NOTIFY[k].label, decision, sent, by, overdue: decision !== 'not-required' && !sent.length && by && by < now && i.status !== 'closed' };
    });
    const done = STEPS.filter(([k]) => i.steps && i.steps[k]).length;
    return { ...i, due, progress: `${done} of ${STEPS.length}` };
  }
  function change(id, user, expectedVersion, fn) {
    return db.transaction(() => {
      const list = db.all(INCIDENTS);
      const i = list.find((x) => x.id === id);
      if (!i) return { status: 404, errors: ['incident not found'] };
      if (expectedVersion !== undefined && expectedVersion !== '' && Number(expectedVersion) !== i.version) return { status: 409, errors: ['someone else changed this incident; reload it and try again'] };
      const err = fn(i);
      if (err) return { status: 400, errors: [err] };
      i.version += 1;
      i.updatedAt = iso();
      db.replaceAll(INCIDENTS, list);
      return { incident: i };
    });
  }
  const act = (i, user, kind, text) => i.actions.push({ at: iso(), by: user.name, byId: String(user.id), kind, text: clip(text, 1000) });

  function createIncident(user, input) {
    const title = clip(input.title, 160);
    const severity = SEVERITIES[input.severity] ? input.severity : '';
    const category = CATEGORIES[input.category] ? input.category : '';
    const errors = [];
    if (title.length < 5) errors.push('give the incident a short title');
    if (!severity) errors.push('choose a severity');
    if (!category) errors.push('choose a category');
    const detected = clip(input.detectedAt, 30);
    const detectedAt = detected && !Number.isNaN(Date.parse(detected)) ? iso(Date.parse(detected)) : iso();
    if (detectedAt > iso(Date.now() + MIN)) errors.push('the time it was noticed cannot be in the future');
    const alertEvent = input.alertId ? db.all(EVENTS).find((e) => e.id === input.alertId && e.type === 'alert') : null;
    if (input.alertId && !alertEvent) errors.push('that alert was not found');
    if (errors.length) return { status: 400, errors };
    const i = {
      id: crypto.randomUUID(), number: nextNumber(), title, severity, category, summary: clip(input.summary, 2000), affected: clip(input.affected, 1000),
      personalData: input.personalData === true || input.personalData === '1' || input.personalData === 'on',
      status: 'open', detectedAt, reportedBy: user.name, reportedById: String(user.id), ownerId: String(user.id), ownerName: user.name,
      steps: { detected: { at: iso(), by: user.name, note: 'Recorded and classified' } }, actions: [], notify: {}, notifications: [], evidence: [],
      alertIds: alertEvent ? [alertEvent.id] : [], rootCause: '', lessons: '', version: 1, createdAt: iso(), updatedAt: iso(),
    };
    act(i, user, 'created', `${SEVERITIES[severity]} · ${CATEGORIES[category]}${alertEvent ? ` · from alert: ${alertEvent.detail}` : ''}`);
    db.prepend(INCIDENTS, i);
    trust.record(user, 'incident-opened', { entityType: 'incident', entityId: i.number, reason: i.title, detail: `${severity}, ${category}` });
    return { incident: i };
  }

  function updateIncident(user, id, input) {
    const action = clip(input.action, 40);
    const note = clip(input.note, 2000);
    const r = change(id, user, input.version, (i) => {
      if (i.status === 'closed' && action !== 'reopen') return 'this incident is closed; reopen it first';
      if (action === 'note') {
        if (!note) return 'write a note';
        act(i, user, 'note', note);
      } else if (action === 'step') {
        const step = STEPS.find(([k]) => k === input.step);
        if (!step) return 'unknown step';
        if (!note) return 'say what was done for this step';
        if (step[0] === 'evidence' && !i.evidence.length) return 'preserve the logs first (Preserve evidence)';
        if (step[0] === 'notified' && Object.keys(NOTIFY).some((k) => ((i.notify || {})[k] || 'undecided') === 'undecided')) return 'decide for each authority and group whether they must be told';
        if (step[0] === 'notified' && Object.keys(NOTIFY).some((k) => i.notify[k] === 'required' && !i.notifications.some((n) => n.to === k))) return 'record the notifications that are required first';
        i.steps[step[0]] = { at: iso(), by: user.name, note };
        act(i, user, 'step', `${step[1]}: ${note}`);
        const order = ['contained', 'investigated', 'restored'];
        const reached = order.filter((k) => i.steps[k]).pop();
        i.status = reached === 'restored' ? 'recovering' : reached === 'investigated' ? 'investigating' : reached === 'contained' ? 'contained' : i.status;
      } else if (action === 'decide') {
        const target = NOTIFY[input.target] ? input.target : '';
        const decision = DECISIONS[input.decision] ? input.decision : '';
        if (!target || !decision) return 'choose who and the decision';
        if (decision !== 'undecided' && !note) return 'give the reason for this decision';
        i.notify[target] = decision;
        act(i, user, 'decision', `${NOTIFY[target].label}: ${DECISIONS[decision]}${note ? ` — ${note}` : ''}`);
      } else if (action === 'notification') {
        const target = NOTIFY[input.target] ? input.target : '';
        if (!target) return 'choose who was told';
        const at = clip(input.at, 30);
        const when = at && !Number.isNaN(Date.parse(at)) ? iso(Date.parse(at)) : iso();
        if (!note) return 'say how they were told and any reference number';
        i.notifications.push({ to: target, at: when, by: user.name, ref: note });
        if (!i.notify[target] || i.notify[target] === 'undecided') i.notify[target] = 'required';
        act(i, user, 'notification', `${NOTIFY[target].label} told on ${when}: ${note}`);
      } else if (action === 'severity') {
        if (!SEVERITIES[input.severity]) return 'choose a severity';
        if (!note) return 'give the reason for the change';
        act(i, user, 'severity', `${SEVERITIES[i.severity]} → ${SEVERITIES[input.severity]}: ${note}`);
        i.severity = input.severity;
      } else if (action === 'assign') {
        const owner = team.members().find((u) => String(u.id) === String(input.ownerId) && can(u, 'incidents.manage'));
        if (!owner) return 'choose someone who can manage incidents';
        i.ownerId = String(owner.id);
        i.ownerName = owner.name;
        act(i, user, 'assigned', `Owner: ${owner.name}`);
      } else if (action === 'close') {
        const missing = STEPS.filter(([k]) => !i.steps[k]).map(([, label]) => label);
        if (missing.length) return `finish every step first: ${missing.join('; ')}`;
        const rootCause = clip(input.rootCause, 2000);
        const lessons = clip(input.lessons, 2000);
        if (!rootCause || !lessons) return 'write the root cause and the preventive measures';
        Object.assign(i, { rootCause, lessons, status: 'closed', closedAt: iso(), closedBy: user.name });
        act(i, user, 'closed', `Root cause: ${rootCause} · Prevention: ${lessons}`);
      } else if (action === 'reopen') {
        if (i.status !== 'closed') return 'this incident is open';
        if (!note) return 'give the reason for reopening';
        Object.assign(i, { status: 'investigating', closedAt: null });
        act(i, user, 'reopened', note);
      } else return 'unknown action';
      return '';
    });
    if (r.incident) trust.record(user, `incident-${action}`, { entityType: 'incident', entityId: r.incident.number, reason: note, detail: clip([input.step, input.target, input.decision, input.severity].filter(Boolean).join(' '), 200) });
    return r;
  }

  // Containment: each action is recorded on the incident and in the audit trail.
  function contain(user, id, input) {
    const action = CONTAIN[input.action] ? input.action : '';
    if (!action) return { status: 400, errors: ['choose a containment action'] };
    const target = clip(input.target, 160).toLowerCase();
    let done = '';
    if (action === 'end-team-sessions') {
      const u = team.members().find((x) => String(x.id) === target || String(x.email || '').toLowerCase() === target);
      if (!u) return { status: 400, errors: ['no team member with that email'] };
      db.sessions.deleteSubject('admin', String(u.id));
      db.sessions.deleteSubject('admin-confirm', String(u.id));
      done = `Signed ${u.name} out everywhere`;
    } else if (action === 'end-candidate-sessions') {
      if (!EMAIL_RE.test(target)) return { status: 400, errors: ['enter the job seeker’s email'] };
      for (const kind of ['candidate', 'candidate-link', 'candidate-reset']) db.sessions.deleteSubject(kind, target);
      done = `Signed job seeker ${sha256(target).slice(0, 8)} out everywhere`;
    } else if (action === 'end-employer-sessions') {
      const u = readSubmissions('employer-users').find((x) => String(x.email || '').toLowerCase() === target);
      if (!u) return { status: 400, errors: ['no employer user with that email'] };
      for (const m of readSubmissions('employer-members').filter((x) => x.userId === u.id)) db.sessions.deleteSubject('employer', `${u.id}:${m.employerId}`);
      done = `Signed employer user ${u.name} out everywhere`;
    } else if (action === 'rotate-download-links') {
      rotateDownloadLinks();
      done = 'Cancelled every download link issued so far';
    }
    const reason = clip(input.note, 1000);
    if (!reason) return { status: 400, errors: ['give the reason'] };
    const r = change(id, user, undefined, (i) => {
      if (i.status === 'closed') return 'this incident is closed';
      act(i, user, 'containment', `${done}: ${reason}`);
      return '';
    });
    if (r.incident) trust.record(user, 'incident-containment', { entityType: 'incident', entityId: r.incident.number, reason, detail: done });
    return r.incident ? { incident: r.incident, done } : r;
  }

  // Copies the security log around the incident into a sealed snapshot
  // (with its hash), so the evidence survives log retention.
  function preserve(user, id, input) {
    const i = byId(id);
    if (!i) return { status: 404, errors: ['incident not found'] };
    const hours = Math.min(Math.max(Number(input.hours) || 24, 1), 24 * 30);
    const from = iso(Date.parse(i.detectedAt) - hours * HOUR);
    const list = db.all(EVENTS).filter((e) => e.at >= from).slice(0, 5000);
    const body = JSON.stringify(list);
    const ev = { id: crypto.randomUUID(), incidentId: id, at: iso(), by: user.name, from, to: iso(), count: list.length, sha256: sha256(body), events: list };
    db.prepend(EVIDENCE, ev);
    const r = change(id, user, undefined, (k) => {
      k.evidence.push({ id: ev.id, at: ev.at, by: user.name, from, count: list.length, sha256: ev.sha256 });
      act(k, user, 'evidence', `Preserved ${list.length} security log entries from ${from} (sha256 ${ev.sha256.slice(0, 16)})`);
      return '';
    });
    if (r.incident) trust.record(user, 'incident-evidence', { entityType: 'incident', entityId: r.incident.number, detail: `${list.length} entries, sha256 ${ev.sha256.slice(0, 16)}` });
    return r;
  }

  function prune(years) {
    const cutoff = iso(Date.now() - years * 365 * 86400000);
    const list = incidents();
    const gone = new Set(list.filter((i) => i.status === 'closed' && i.closedAt && i.closedAt < cutoff).map((i) => i.id));
    if (gone.size) {
      db.replaceAll(INCIDENTS, list.filter((i) => !gone.has(i.id)));
      db.replaceAll(EVIDENCE, db.all(EVIDENCE).filter((e) => !gone.has(e.incidentId)));
    }
    return gone.size;
  }

  const managers = () => team.members().filter((u) => can(u, 'incidents.manage'));
  const locals = { SEVERITIES, CATEGORIES, STEPS, NOTIFY, DECISIONS, CONTAIN };
  app.get('/admin/incidents', adminAuth, gate('incidents.view'), (req, res) => {
    const status = ['open', 'closed'].includes(req.query.status) ? req.query.status : '';
    const list = incidents().filter((i) => !status || (status === 'closed' ? i.status === 'closed' : i.status !== 'closed')).map(decorate);
    const { rows, pager } = paginate(list, { page: req.query.page, size: 25, query: req.query, path: '/admin/incidents' });
    const alert = req.query.alert ? db.all(EVENTS).find((e) => e.id === req.query.alert && e.type === 'alert') : null;
    view(req, res, { title: 'Security incidents', section: 'incidents', rows, pager, q: req.query, alert, ...locals });
  });
  app.post('/admin/incidents', adminAuth, gate('incidents.manage'), limit('incidents', 30), sameOrigin, (req, res) => {
    const r = createIncident(req.admin, req.body);
    if (r.errors) return back(res, '/admin/incidents', `Not saved: ${r.errors.join('; ')}`);
    back(res, `/admin/incidents/${r.incident.id}`, `${r.incident.number} opened`);
  });
  app.get('/admin/incidents/:id', adminAuth, gate('incidents.view'), (req, res, next) => {
    const i = byId(req.params.id);
    if (!i) return next();
    view(req, res, { title: `${i.number}: ${i.title}`, section: 'incident', i: decorate(i), managers: managers(), ...locals });
  });
  app.post('/admin/incidents/:id/update', adminAuth, gate('incidents.manage'), limit('incidents', 60), sameOrigin, (req, res) => {
    const r = updateIncident(req.admin, req.params.id, req.body);
    if (r.status === 404) return res.status(404).send('Not found');
    back(res, `/admin/incidents/${req.params.id}`, r.errors ? `Not saved: ${r.errors.join('; ')}` : 'Saved');
  });
  app.post('/admin/incidents/:id/contain', adminAuth, gate('incidents.manage'), limit('incidents', 30), sameOrigin, requireConfirmed, (req, res) => {
    const r = contain(req.admin, req.params.id, req.body);
    if (r.status === 404) return res.status(404).send('Not found');
    back(res, `/admin/incidents/${req.params.id}`, r.errors ? `Not done: ${r.errors.join('; ')}` : r.done);
  });
  app.post('/admin/incidents/:id/preserve', adminAuth, gate('incidents.manage'), limit('incidents', 30), sameOrigin, (req, res) => {
    const r = preserve(req.admin, req.params.id, req.body);
    if (r.status === 404) return res.status(404).send('Not found');
    back(res, `/admin/incidents/${req.params.id}`, r.errors ? `Not saved: ${r.errors.join('; ')}` : 'Evidence preserved');
  });
  app.get('/api/admin/incidents', adminAuth, gate('incidents.view'), limit('security-api', 120, 60000), (req, res) => {
    res.set('Cache-Control', 'no-store').json({ ok: true, incidents: incidents().map(decorate).map(({ actions, ...i }) => i) });
  });

  return { requireConfirmed, prune, summary, createIncident, updateIncident };
}

module.exports = { create, register, RULES, EVENT_TYPES, STEPS, NOTIFY, CATEGORIES, SEVERITIES, PRIVILEGED, CONTAIN, cleanPath };
