// Privacy and data governance (Step 62).
//
// - Consent records (`consent-records`): one entry per change, with the
//   purpose, granted or withdrawn, the privacy policy version shown, where it
//   happened and when. Purposes are separate (account, being considered by our
//   recruiters, being findable by employers, job alerts, marketing email,
//   WhatsApp, SMS): agreeing to one never implies another. Append-only; after
//   an account is deleted the entries are kept as evidence under a keyed hash
//   of the email instead of the email, for the retention policy's period.
// - Data requests (`data-requests`): access, correction, deletion, withdrawing
//   consent and grievances, from signed-in job seekers or anyone who confirms
//   their email. Each has a number, a due date, an owner, a history and an
//   outcome; refusals need a reason. Deleting an account from a request needs
//   the team member to confirm it's them.
// - Retention policy: one configurable period per data category, enforced daily.
// - Erasure journal: a file next to the database (never inside it or its
//   backups) with a keyed hash and the time of each account deletion. If an
//   older backup is ever restored, deletions are applied again at start-up.
const crypto = require('crypto');
const fs = require('fs');
const { paginate } = require('./paginate');
const roles = require('./agency-roles');

const POLICY_VERSION = '2026-10-25';
const CONSENTS = 'consent-records';
const REQUESTS = 'data-requests';
const DAY = 86400000;
const RESPONSE_DAYS = 30;
const VERIFY_DAYS = 7;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const PURPOSES = {
  account: { label: 'Your account and applications', text: 'Keeping your profile and resume, sending each application to the employer you applied to, and telling you what happens next. Needed for the service; withdrawn by deleting your account.' },
  'recruiter-visibility': { label: 'Considered for other jobs', text: 'Hireriv recruiters may look at your profile for other jobs that fit and contact you about them.' },
  'employer-discovery': { label: 'Findable by verified employers', text: 'Verified employers on Hireriv may find your profile (without your contact details) and invite you to apply.' },
  'job-alerts': { label: 'Job alert emails', text: 'Emails about new jobs matching an alert or saved search you set up.' },
  'marketing-email': { label: 'News and career tips', text: 'Occasional emails about Hireriv and career advice. Never needed for applying.' },
  whatsapp: { label: 'WhatsApp updates', text: 'Job matches and updates on WhatsApp.' },
  sms: { label: 'SMS reminders', text: 'Interview reminders by SMS.' },
  'ai-assistant': { label: 'AI career assistant', text: 'Your messages to the career assistant, with the skills, experience and place on your profile, are sent to our AI provider to write the answers. Contact details are removed first. Turning it off deletes the conversation.' },
};
const REQUEST_TYPES = {
  access: 'A copy of my personal data',
  correction: 'Correct my personal data',
  deletion: 'Delete my personal data',
  'withdraw-consent': 'Withdraw a consent I gave',
  grievance: 'A complaint about how my data is handled',
};
const REQUEST_STATUS = {
  'awaiting-verification': 'Waiting for email confirmation',
  received: 'Received',
  'in-progress': 'In progress',
  completed: 'Completed',
  refused: 'Refused, with reasons',
};
const OPEN = ['received', 'in-progress'];
const REQUESTER = { 'job-seeker': 'Job seeker', employer: 'Employer user', other: 'Someone else' };

// Configurable periods. Candidate profiles keep their existing setting (Admin → Settings).
const RETENTION = {
  securityLogDays: { label: 'Security log and team activity log', unit: 'days', min: 180, max: 1095, def: 365, note: 'At least 180 days, as the CERT-In directions of April 2022 ask of entities within their scope.' },
  consentYears: { label: 'Consent records after an account is deleted', unit: 'years', min: 1, max: 10, def: 3, note: 'Kept as evidence of what was agreed, under a keyed hash instead of the email.' },
  requestYears: { label: 'Data requests after they are closed', unit: 'years', min: 1, max: 10, def: 3, note: 'Shows how each request was handled. Unconfirmed requests go after 7 days.' },
  incidentYears: { label: 'Closed security incidents and their evidence', unit: 'years', min: 1, max: 10, def: 5, note: 'Includes the preserved log snapshots.' },
  backupDays: { label: 'Daily database backups', unit: 'days', min: 7, max: 35, def: 14, note: 'One copy a day. Deleted data leaves the backups when the last copy holding it is replaced.' },
};
const CANDIDATE_PERIODS = [0, 12, 24, 36];

const iso = (t = Date.now()) => new Date(t).toISOString();
const clip = (v, n) => String(v ?? '').trim().slice(0, n);
const lower = (s) => String(s || '').trim().toLowerCase();
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function create({ db, notify, readSubmissions, writeSubmissions, saveSubmission, journalFile }) {
  if (!db.metaGet('secret:privacy')) db.metaSet('secret:privacy', crypto.randomBytes(32).toString('hex'));
  const keyed = (email) => crypto.createHmac('sha256', db.metaGet('secret:privacy')).update(lower(email)).digest('hex');

  // ---------- consent ----------
  const all = () => db.all(CONSENTS);
  const historyOf = (email) => all().filter((r) => r.subject === lower(email));
  function latest(email, purpose, ref = '') {
    return historyOf(email).find((r) => r.purpose === purpose && (r.ref || '') === ref) || null;
  }
  // Records a change. Repeating the current state adds nothing.
  function consent(email, purpose, granted, source, { ref = '', at = iso() } = {}) {
    if (!PURPOSES[purpose] || !EMAIL_RE.test(lower(email))) return null;
    const status = granted ? 'granted' : 'withdrawn';
    const last = latest(email, purpose, ref);
    if (last ? last.status === status : !granted) return null;
    const r = { id: crypto.randomUUID(), subject: lower(email), purpose, status, policyVersion: POLICY_VERSION, source: clip(source, 80), ...(ref ? { ref: clip(ref, 60) } : {}), at };
    db.prepend(CONSENTS, r);
    return r;
  }
  // What the person agreed to now, per purpose (job alerts: any alert on).
  function current(email) {
    const out = {};
    for (const key of Object.keys(PURPOSES)) {
      const rows = historyOf(email).filter((r) => r.purpose === key);
      const refs = new Map();
      for (const r of rows) if (!refs.has(r.ref || '')) refs.set(r.ref || '', r);
      const latestRows = [...refs.values()];
      const on = latestRows.filter((r) => r.status === 'granted');
      out[key] = { granted: on.length > 0, since: (on[0] || latestRows[0] || {}).at || null, policyVersion: (on[0] || latestRows[0] || {}).policyVersion || null };
    }
    return out;
  }
  // Marketing email: the preference, the newsletter list and the record move together.
  function setMarketing(email, on, how) {
    const rk = notify.candidateRk(email);
    notify.setPrefs(rk, { marketing: on, how });
    const list = readSubmissions('newsletter');
    const mine = (s) => lower(s.email) === lower(email);
    if (!on && list.some(mine)) writeSubmissions('newsletter', list.filter((s) => !mine(s)));
    if (on && !list.some(mine)) saveSubmission('newsletter', { email: lower(email), source: how });
    consent(email, 'marketing-email', on, how);
  }

  // ---------- after an account is deleted ----------
  function erased(email) {
    const subject = lower(email);
    const key = keyed(subject);
    const list = all();
    let changed = false;
    for (const r of list) if (r.subject === subject) { r.subject = `erased:${key}`; r.erasedAt = iso(); changed = true; }
    if (changed) db.replaceAll(CONSENTS, list);
    if (journalFile) {
      try { fs.appendFileSync(journalFile, `${iso()} ${key}\n`, { mode: 0o600 }); } catch (e) { console.error(`Erasure journal not written: ${e.message}`); }
    }
  }
  // After a restore from an older backup: delete again whatever had been
  // deleted, unless the person signed up again since (nothing older remains).
  function replayErasures(deleteCandidate) {
    if (!journalFile || !fs.existsSync(journalFile)) return 0;
    const when = new Map();
    for (const line of fs.readFileSync(journalFile, 'utf8').split('\n')) {
      const [at, key] = line.trim().split(' ');
      if (at && key && (!when.has(key) || when.get(key) < at)) when.set(key, at);
    }
    if (!when.size) return 0;
    const seen = new Map();
    const note = (email, createdAt) => {
      const e = lower(email);
      if (!e) return;
      const k = keyed(e);
      if (!when.has(k)) return;
      const s = seen.get(e) || { before: false, after: false };
      if ((createdAt || '') <= when.get(k)) s.before = true; else s.after = true;
      seen.set(e, s);
    };
    for (const c of readSubmissions('candidates')) note(c.email, c.createdAt);
    for (const a of readSubmissions('applications')) note(a.email, a.createdAt);
    let n = 0;
    for (const [email, s] of seen) {
      if (s.before && !s.after) { deleteCandidate(email); n++; }
    }
    return n;
  }

  // ---------- retention policy ----------
  function policy() {
    let saved = {};
    try { saved = JSON.parse(db.metaGet('privacy:retention') || '{}'); } catch (e) { saved = {}; }
    return Object.fromEntries(Object.entries(RETENTION).map(([k, d]) => {
      const v = Number(saved[k]);
      return [k, Number.isInteger(v) && v >= d.min && v <= d.max ? v : d.def];
    }));
  }
  function validatePolicy(input) {
    const out = {};
    const errors = [];
    for (const [k, d] of Object.entries(RETENTION)) {
      const v = Number(input[k]);
      if (!Number.isInteger(v) || v < d.min || v > d.max) errors.push(`${d.label}: a whole number of ${d.unit} from ${d.min} to ${d.max}`);
      else out[k] = v;
    }
    return { values: out, errors };
  }
  const savePolicy = (values) => db.metaSet('privacy:retention', JSON.stringify(values));

  // Deletes what the policy says is past its time. Returns the counts.
  function prune(p = policy()) {
    const now = Date.now();
    const done = { consents: 0, requests: 0, unverified: 0 };
    const consents = all();
    const cCut = iso(now - p.consentYears * 365 * DAY);
    const keepC = consents.filter((r) => !(r.erasedAt && r.erasedAt < cCut));
    if (keepC.length !== consents.length) { db.replaceAll(CONSENTS, keepC); done.consents = consents.length - keepC.length; }
    const reqs = db.all(REQUESTS);
    const rCut = iso(now - p.requestYears * 365 * DAY);
    const vCut = iso(now - VERIFY_DAYS * DAY);
    const keepR = reqs.filter((r) => {
      if (r.status === 'awaiting-verification' && r.createdAt < vCut) { done.unverified++; return false; }
      if (r.closedAt && r.closedAt < rCut) { done.requests++; return false; }
      return true;
    });
    if (keepR.length !== reqs.length) db.replaceAll(REQUESTS, keepR);
    return done;
  }

  return { POLICY_VERSION, PURPOSES, consent, current, historyOf, setMarketing, erased, replayErasures, policy, validatePolicy, savePolicy, prune, keyed };
}

// ---------- requests and pages ----------
function register(app, deps) {
  const { db, privacy, mailer, site, baseUrl, team, adminAuth, sameOrigin, limit, isBot, trust, view, requireConfirmed } = deps;
  const { candidates, deleteCandidate, retention, setCandidateMonths, readSubmissions } = deps;
  const can = (u, a) => roles.can(u, a);
  const json = (req) => (req.get('Accept') || '').includes('json');
  const gate = (action) => (req, res, next) => {
    if (can(req.admin, action)) return next();
    if (json(req)) return res.status(403).json({ ok: false, errors: ['your role does not allow that'] });
    res.status(403).render('thanks', { title: 'Not part of your role', page: '', ok: false, message: 'Your role does not include this page. Ask an Admin on your team if you need it.', noindex: true });
  };
  const back = (res, url, msg) => res.redirect(303, `${url}${url.includes('?') ? '&' : '?'}msg=${encodeURIComponent(msg)}`);

  const requests = () => db.all(REQUESTS);
  const byId = (id) => requests().find((r) => r.id === id);
  function nextNumber() {
    const n = Number(db.metaGet('privacy:request-seq') || 0) + 1;
    db.metaSet('privacy:request-seq', String(n));
    return `DR-${String(n).padStart(4, '0')}`;
  }
  const hist = (r, by, action, note = '') => r.history.push({ at: iso(), by, action, note: clip(note, 2000) });
  const tell = (r, subject, intro, rows = []) => mailer.notice({ email: r.email, name: r.name || 'there', kind: 'other' }, { subject, heading: subject, intro, rows: [['Request', r.number], ['Type', REQUEST_TYPES[r.type]], ...rows] });

  function validate(input) {
    const type = REQUEST_TYPES[input.type] ? input.type : '';
    const details = clip(input.details, 2000);
    const errors = [];
    if (!type) errors.push('choose what you are asking for');
    if (['correction', 'grievance', 'withdraw-consent'].includes(type) && details.length < 10) errors.push('tell us what to correct, which consent, or what went wrong');
    return { type, details, errors };
  }
  function open(input, { email, name, role, verifiedHow }) {
    const r = {
      id: crypto.randomUUID(), number: nextNumber(), type: input.type, details: input.details, email: lower(email), name: clip(name, 120), role: REQUESTER[role] ? role : 'other',
      status: verifiedHow ? 'received' : 'awaiting-verification', verifiedAt: verifiedHow ? iso() : null, verifiedHow: verifiedHow || '',
      dueAt: verifiedHow ? iso(Date.now() + RESPONSE_DAYS * DAY) : null, assigneeId: '', assigneeName: '', history: [], resolution: '', retained: '', version: 1, createdAt: iso(), closedAt: null,
    };
    hist(r, verifiedHow ? 'Requester' : 'Requester (not yet confirmed)', 'opened', verifiedHow ? `Confirmed: ${verifiedHow}` : '');
    db.prepend(REQUESTS, r);
    return r;
  }
  function received(r) {
    tell(r, `We received your data request ${r.number}`, `we have your request and will answer by ${new Date(r.dueAt).toLocaleDateString('en-IN', { dateStyle: 'long', timeZone: 'Asia/Kolkata' })}. We may ask you for details to be sure it is you.`);
    const people = team.members().filter((u) => can(u, 'privacy.requests'));
    if (people.length) deps.notify.emit({ key: `data-request:${r.id}`, type: 'data-request', to: people.map((u) => ({ kind: 'team', userId: u.id })), inApp: { title: `Data request ${r.number}`, body: `${REQUEST_TYPES[r.type]} · answer by ${r.dueAt.slice(0, 10)}`, link: `/admin/data-requests/${r.id}` } });
  }

  // ---------- public form (anyone; the email is confirmed by a link) ----------
  const publicPage = (res, locals, status = 200) => res.status(status).render('privacy-request', { title: 'Your data rights', page: '', noindex: true, errors: [], values: {}, sent: false, TYPES: REQUEST_TYPES, REQUESTER, signedIn: '', ...locals });
  app.get('/privacy/requests', (req, res) => {
    const email = candidates.currentEmail(req);
    if (email) return res.redirect('/account/privacy');
    publicPage(res, { values: { type: REQUEST_TYPES[req.query.type] ? req.query.type : '' } });
  });
  app.post('/privacy/requests', limit('privacy-request', 5), sameOrigin, (req, res) => {
    const v = validate(req.body);
    const email = lower(clip(req.body.email, 160));
    const name = clip(req.body.name, 120);
    if (!EMAIL_RE.test(email)) v.errors.push('enter the email your data is held under');
    if (v.errors.length) return publicPage(res, { values: { ...req.body }, errors: v.errors }, 400);
    // Same answer every time, so the form never reveals who has an account.
    if (!isBot(req.body)) {
      const r = open(v, { email, name, role: req.body.role });
      const token = crypto.randomBytes(24).toString('base64url');
      db.sessions.set('privacy-request', sha(token), r.id, Date.now() + VERIFY_DAYS * DAY);
      mailer.notice({ email, name: name || 'there', kind: 'other' }, {
        subject: `Confirm your data request ${r.number}`, heading: 'Confirm your data request',
        intro: `someone asked ${site.name} about the personal data held under this email address: "${REQUEST_TYPES[r.type]}". If it was you, confirm it with the button below within ${VERIFY_DAYS} days. If not, ignore this email and nothing happens.`,
        link: `${baseUrl}/privacy/requests/verify/${token}`, label: 'Confirm my request',
      });
    }
    publicPage(res, { sent: true });
  });
  // GET shows a button (mail scanners open links); POST confirms.
  const pendingFor = (token) => {
    const s = db.sessions.get('privacy-request', sha(String(token).slice(0, 100)));
    const r = s && byId(s.subject);
    return r && r.status === 'awaiting-verification' ? r : null;
  };
  app.get('/privacy/requests/verify/:token', (req, res) => {
    const r = pendingFor(req.params.token);
    if (!r) return res.status(410).render('thanks', { title: 'Link expired', page: '', ok: false, noindex: true, message: 'This confirmation link has expired or was already used. You can send the request again from the Privacy Policy page.' });
    res.set('Cache-Control', 'no-store').render('privacy-request', { title: 'Confirm your data request', page: '', noindex: true, confirm: r, token: req.params.token, TYPES: REQUEST_TYPES, REQUESTER, errors: [], values: {}, sent: false, signedIn: '' });
  });
  app.post('/privacy/requests/verify/:token', limit('privacy-request-verify', 20), sameOrigin, (req, res) => {
    const r0 = pendingFor(req.params.token);
    if (!r0) return res.status(410).render('thanks', { title: 'Link expired', page: '', ok: false, noindex: true, message: 'This confirmation link has expired or was already used.' });
    db.sessions.delete('privacy-request', sha(String(req.params.token).slice(0, 100)));
    const r = change(r0.id, null, (x) => {
      Object.assign(x, { status: 'received', verifiedAt: iso(), verifiedHow: 'email link', dueAt: iso(Date.now() + RESPONSE_DAYS * DAY) });
      hist(x, 'Requester', 'confirmed', 'Confirmed by email link');
    }).request;
    received(r);
    res.render('thanks', { title: 'Request confirmed', page: '', ok: true, noindex: true, message: `Thank you. Your request ${r.number} is with our team, and we will answer by email by ${r.dueAt.slice(0, 10)}.` });
  });

  // ---------- job seekers' own page and API ----------
  const C = candidates.helpers;
  const mineOf = (email) => requests().filter((r) => r.email === lower(email) && r.status !== 'awaiting-verification');
  const publicView = (r) => ({ id: r.id, number: r.number, type: r.type, typeLabel: REQUEST_TYPES[r.type], status: r.status, statusLabel: REQUEST_STATUS[r.status], details: r.details, createdAt: r.createdAt, dueAt: r.dueAt, closedAt: r.closedAt, resolution: r.resolution, retained: r.retained });
  app.get('/account/privacy', C.requireCandidate, (req, res) => {
    const email = req.candidateEmail;
    C.page(res, 'account-privacy', {
      title: 'Privacy & data', ...C.shell(email, 'privacy'), consents: privacy.current(email), history: privacy.historyOf(email).slice(0, 50), PURPOSES: privacy.PURPOSES, POLICY_VERSION: privacy.POLICY_VERSION,
      requests: mineOf(email).map(publicView), TYPES: REQUEST_TYPES, values: {}, msg: clip(req.query.msg, 300),
    });
  });
  app.post('/account/privacy/requests', C.requireCandidate, limit('privacy-request', 5), sameOrigin, (req, res) => {
    const email = req.candidateEmail;
    const v = validate(req.body);
    if (v.errors.length) {
      return C.page(res, 'account-privacy', {
        title: 'Privacy & data', ...C.shell(email, 'privacy'), consents: privacy.current(email), history: privacy.historyOf(email).slice(0, 50), PURPOSES: privacy.PURPOSES, POLICY_VERSION: privacy.POLICY_VERSION,
        requests: mineOf(email).map(publicView), TYPES: REQUEST_TYPES, values: req.body, errors: v.errors, msg: '',
      }, 400);
    }
    const c = C.candidateOf(email);
    const r = open(v, { email, name: c && c.profile && c.profile.name, role: 'job-seeker', verifiedHow: 'signed in' });
    received(r);
    res.redirect(303, `/account/privacy?msg=${encodeURIComponent(`Request ${r.number} sent. We will answer by ${r.dueAt.slice(0, 10)}.`)}#requests`);
  });
  app.get('/api/me/consents', C.requireCandidateApi, (req, res) => {
    res.set('Cache-Control', 'no-store').json({ ok: true, policyVersion: privacy.POLICY_VERSION, current: privacy.current(req.candidateEmail), history: privacy.historyOf(req.candidateEmail).map(({ subject, ...r }) => r) });
  });
  app.get('/api/me/data-requests', C.requireCandidateApi, (req, res) => {
    res.set('Cache-Control', 'no-store').json({ ok: true, requests: mineOf(req.candidateEmail).map(publicView) });
  });
  app.post('/api/me/data-requests', C.requireCandidateApi, limit('privacy-request', 5), sameOrigin, (req, res) => {
    const v = validate(req.body || {});
    if (v.errors.length) return res.status(400).json({ ok: false, errors: v.errors });
    const c = C.candidateOf(req.candidateEmail);
    const r = open(v, { email: req.candidateEmail, name: c && c.profile && c.profile.name, role: 'job-seeker', verifiedHow: 'signed in' });
    received(r);
    res.status(201).json({ ok: true, request: publicView(r) });
  });

  // ---------- the team's queue ----------
  function change(id, expectedVersion, fn) {
    return db.transaction(() => {
      const list = db.all(REQUESTS);
      const r = list.find((x) => x.id === id);
      if (!r) return { status: 404, errors: ['request not found'] };
      if (expectedVersion !== null && expectedVersion !== undefined && expectedVersion !== '' && Number(expectedVersion) !== r.version) return { status: 409, errors: ['someone else changed this request; reload it and try again'] };
      const err = fn(r);
      if (err) return { status: 400, errors: [err] };
      r.version += 1;
      db.replaceAll(REQUESTS, list);
      return { request: r };
    });
  }
  // What we hold under the email (for the team, before deciding).
  function footprint(email) {
    const e = lower(email);
    const has = (type) => readSubmissions(type).filter((s) => lower(s.email) === e).length;
    const placements = db.all('placements').filter((p) => lower(p.candidateEmail) === e).length;
    return {
      account: readSubmissions('candidates').some((c) => c.email === e), applications: has('applications'), jobAlerts: has('job-alerts'), newsletter: has('newsletter'),
      employerUser: readSubmissions('employer-users').some((u) => lower(u.email) === e), placements, consentRecords: privacy.historyOf(e).length,
    };
  }
  function act(user, id, input) {
    const action = clip(input.action, 30);
    const note = clip(input.note, 2000);
    let mail = null;
    const r = change(id, input.version, (x) => {
      if (x.status === 'awaiting-verification') return 'the requester has not confirmed their email yet';
      const closed = !OPEN.includes(x.status);
      if (closed && action !== 'note') return 'this request is closed';
      if (action === 'assign') {
        const who = team.members().find((u) => String(u.id) === String(input.assigneeId) && can(u, 'privacy.requests'));
        if (!who) return 'choose someone who handles data requests';
        Object.assign(x, { assigneeId: String(who.id), assigneeName: who.name });
        hist(x, user.name, 'assigned', who.name);
      } else if (action === 'note') {
        if (!note) return 'write a note';
        hist(x, user.name, 'note', note);
      } else if (action === 'start') {
        x.status = 'in-progress';
        if (!x.assigneeId) Object.assign(x, { assigneeId: String(user.id), assigneeName: user.name });
        hist(x, user.name, 'started', note);
      } else if (action === 'complete') {
        if (!note) return 'say what was done (this goes to the requester)';
        Object.assign(x, { status: 'completed', resolution: note, retained: clip(input.retained, 1000), closedAt: iso() });
        hist(x, user.name, 'completed', note);
        mail = ['completed', `we have completed your request: ${note}`];
      } else if (action === 'refuse') {
        if (!note) return 'give the reasons (they go to the requester)';
        Object.assign(x, { status: 'refused', resolution: note, closedAt: iso() });
        hist(x, user.name, 'refused', note);
        mail = ['refused', `we could not do what you asked, for these reasons: ${note}. If you are not satisfied, you can reply to this email, and you may complain to the Data Protection Board of India.`];
      } else return 'unknown action';
      return '';
    });
    if (r.request) {
      trust.record(user, `data-request-${action}`, { entityType: 'data-request', entityId: r.request.number, reason: note, detail: REQUEST_TYPES[r.request.type] });
      if (mail) tell(r.request, `Your data request ${r.request.number} is ${mail[0]}`, mail[1], r.request.retained ? [['Kept', r.request.retained]] : []);
    }
    return r;
  }
  // Deletion: everything held for a job seeker under that email, through the
  // same code as "Delete my account". Placements and invoices stay (tax law).
  function erase(user, id, input) {
    const r0 = byId(id);
    if (!r0) return { status: 404, errors: ['request not found'] };
    if (r0.type !== 'deletion') return { status: 400, errors: ['only deletion requests can erase an account'] };
    if (!OPEN.includes(r0.status)) return { status: 400, errors: ['this request is not open'] };
    const before = footprint(r0.email);
    deleteCandidate(r0.email);
    const kept = before.placements ? `${before.placements} placement record${before.placements === 1 ? '' : 's'} and their invoices (kept as Indian tax law requires)` : '';
    const note = `Deleted the job-seeker account, ${before.applications} application${before.applications === 1 ? '' : 's'} with resumes, job alerts, newsletter, saved jobs, notifications and sign-ins.`;
    return act(user, id, { action: 'complete', note: clip(`${note} ${clip(input.note, 500)}`, 2000), retained: [kept, before.employerUser ? 'an employer login under this email, which its company manages' : ''].filter(Boolean).join('; '), version: '' });
  }

  const queue = (q = {}) => {
    const status = REQUEST_STATUS[q.status] ? q.status : '';
    const now = iso();
    return requests().filter((r) => (status ? r.status === status : r.status !== 'awaiting-verification'))
      .map((r) => ({ ...r, overdue: OPEN.includes(r.status) && r.dueAt && r.dueAt < now }));
  };
  const locals = { TYPES: REQUEST_TYPES, STATUS: REQUEST_STATUS, REQUESTER, OPEN };
  app.get('/admin/data-requests', adminAuth, gate('privacy.requests'), (req, res) => {
    const { rows, pager } = paginate(queue(req.query), { page: req.query.page, size: 25, query: req.query, path: '/admin/data-requests' });
    const all = requests();
    const counts = { open: all.filter((r) => OPEN.includes(r.status)).length, overdue: all.filter((r) => OPEN.includes(r.status) && r.dueAt < iso()).length };
    view(req, res, { title: 'Data requests', section: 'requests', rows, pager, q: req.query, counts, ...locals });
  });
  app.get('/admin/data-requests/:id', adminAuth, gate('privacy.requests'), (req, res, next) => {
    const r = byId(req.params.id);
    if (!r || r.status === 'awaiting-verification') return next();
    trust.record(req.admin, 'data-request-viewed', { entityType: 'data-request', entityId: r.number });
    view(req, res, { title: `${r.number}: ${REQUEST_TYPES[r.type]}`, section: 'request', r: { ...r, overdue: OPEN.includes(r.status) && r.dueAt < iso() }, held: footprint(r.email), consents: privacy.current(r.email), handlers: team.members().filter((u) => can(u, 'privacy.requests')), ...locals });
  });
  app.post('/admin/data-requests/:id', adminAuth, gate('privacy.requests'), limit('data-requests', 60), sameOrigin, (req, res) => {
    const r = act(req.admin, req.params.id, req.body);
    if (r.status === 404) return res.status(404).send('Not found');
    back(res, `/admin/data-requests/${req.params.id}`, r.errors ? `Not saved: ${r.errors.join('; ')}` : 'Saved');
  });
  app.post('/admin/data-requests/:id/erase', adminAuth, gate('privacy.erase'), limit('data-requests', 30), sameOrigin, requireConfirmed, (req, res) => {
    const r = erase(req.admin, req.params.id, req.body);
    if (r.status === 404) return res.status(404).send('Not found');
    back(res, `/admin/data-requests/${req.params.id}`, r.errors ? `Not done: ${r.errors.join('; ')}` : 'Account deleted and the request completed');
  });
  app.get('/api/admin/data-requests', adminAuth, gate('privacy.requests'), limit('security-api', 120, 60000), (req, res) => {
    res.set('Cache-Control', 'no-store').json({ ok: true, requests: queue(req.query).map(({ history, ...r }) => r) });
  });

  // ---------- retention ----------
  const schedule = () => {
    const p = privacy.policy();
    return [
      ['Job-seeker profiles, applications and resumes', site.retentionMonths ? `${site.retentionMonths} months after the last activity` : 'Until the person deletes them (automatic deletion off)', 'Active placements and upcoming interviews are never deleted. Resumes and identity documents go with the account, and their files are encrypted until deleted.'],
      ['Unconfirmed job alerts', '30 days', ''],
      ['Contact messages and hiring requests', site.retentionMonths ? `${site.retentionMonths} months` : 'Until deleted', 'Follows the candidate period.'],
      ['Worker onboarding and identity documents', 'While the worker is engaged; replaced files are deleted', 'Only Admins and Staffing Managers can open them; every opening is logged.'],
      ['Placements, invoices, payments and credit notes', 'Kept', 'Tax law requires them (GST records: at least 72 months). Not deleted with an account.'],
      ['Consent records', `${p.consentYears} years after the account is deleted`, 'Kept under a keyed hash of the email.'],
      ['Data requests', `${p.requestYears} years after closing`, 'Unconfirmed requests: 7 days.'],
      ['Security log and team activity', `${p.securityLogDays} days`, 'At least 180 days.'],
      ['Employer account activity', '2 years', ''],
      ['Trust & safety case details and evidence', '2 years after closing', 'The outline and the hash-chained audit trail stay.'],
      ['Hash-chained audit trail', 'Kept', 'Never edited or deleted, so the chain can be checked.'],
      ['Security incidents and preserved evidence', `${p.incidentYears} years after closing`, ''],
      ['In-app notifications / delivery records', '365 days / 90 days', ''],
      ['Sessions and sign-in links', 'Until they expire (team 12 hours, others 7 days)', 'Ended at sign-out.'],
      ['Database backups', `${p.backupDays} daily copies`, 'Deleted data leaves backups as copies are replaced. After any restore, deletions are applied again from the erasure journal.'],
    ];
  };
  app.get('/admin/retention', adminAuth, gate('retention.view'), (req, res) => {
    view(req, res, { title: 'Data retention', section: 'retention', pol: privacy.policy(), RETENTION, schedule: schedule(), candidateMonths: site.retentionMonths || 0, CANDIDATE_PERIODS, preview: retention.preview() });
  });
  app.post('/admin/retention', adminAuth, gate('retention.manage'), limit('retention', 20), sameOrigin, requireConfirmed, (req, res) => {
    const reason = clip(req.body.reason, 500);
    const { values, errors } = privacy.validatePolicy(req.body);
    const months = Number(req.body.candidateMonths);
    if (!CANDIDATE_PERIODS.includes(months)) errors.push('choose a period for job-seeker data');
    if (!reason) errors.push('give the reason for the change');
    if (errors.length) return back(res, '/admin/retention', `Not saved: ${errors.join('; ')}`);
    const before = { ...privacy.policy(), candidateMonths: site.retentionMonths || 0 };
    privacy.savePolicy(values);
    if (months !== (site.retentionMonths || 0)) setCandidateMonths(months, req.admin);
    const changes = Object.entries({ ...values, candidateMonths: months }).filter(([k, v]) => before[k] !== v).map(([k, v]) => `${k} ${before[k]} → ${v}`);
    if (changes.length) {
      trust.record(req.admin, 'retention-policy-changed', { entityType: 'policy', entityId: 'retention', reason, detail: changes.join(', ') });
      team.log(req.admin, `Changed the retention policy: ${changes.join(', ')}`.slice(0, 300), reason);
    }
    back(res, '/admin/retention', changes.length ? 'Retention policy saved' : 'Nothing changed');
  });

  return { footprint, act, erase, schedule };
}

module.exports = { create, register, POLICY_VERSION, PURPOSES, REQUEST_TYPES, REQUEST_STATUS, RETENTION, RESPONSE_DAYS };
