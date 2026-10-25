// Workers after placement: onboarding, documents, shifts, attendance,
// corrections and timesheets, for the temporary and contract staff deployed
// through staffing assignments (agency.js).
//
// A worker is the placed candidate, linked by the placement and their account
// email; their profile is never copied. Three kinds of people use this, each
// with their own sign-in and checked on the server for every request:
//   - the Hireriv team, by role (agency-roles.js workforce.*), Account Managers
//     only for their own clients;
//   - client employers, by membership (employer-team.js workforce.*), site
//     supervisors only for the assignments they supervise;
//   - the worker, only for their own records.
// Times are stored in UTC and shown in the site's time zone. Nothing tracks
// location. Missing check-outs become exceptions, never invented hours;
// corrections and overtime need someone else's approval, nobody approves
// their own timesheet, and an approved timesheet locks its attendance.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const roles = require('./agency-roles');
const { DOCUMENT_TYPES } = require('./uploads');
const { qtyFrom, timesQty } = require('./agency');

const DAY = 86400000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const validDate = (s) => DATE_RE.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
const mondayOf = (ymd) => addDays(ymd, -((new Date(`${ymd}T00:00:00Z`).getUTCDay() + 6) % 7));
const iso = (ms = Date.now()) => new Date(ms).toISOString();
const DEFAULT_ZONE = 'Asia/Kolkata';

// ---------- time zones ----------
// Minutes the zone is ahead of UTC at that instant.
function zoneOffset(ms, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}
// A wall-clock date and time at the site, as a UTC timestamp.
function localToUtc(date, hhmm, tz) {
  const [h, m] = hhmm.split(':').map(Number);
  const guess = Date.parse(`${date}T00:00:00Z`) + (h * 60 + m) * 60000;
  let t = guess - zoneOffset(guess, tz) * 60000;
  t = guess - zoneOffset(t, tz) * 60000;
  return iso(t);
}
const localDate = (at, tz) => new Date(at).toLocaleDateString('en-CA', { timeZone: tz });
const localTime = (at, tz) => new Date(at).toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const showAt = (at, tz) => (at ? `${new Date(at).toLocaleDateString('en-IN', { timeZone: tz, day: 'numeric', month: 'short' })} ${localTime(at, tz)}` : '');
const hours = (min) => `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`;
const zoneOf = (a) => (a && a.timeZone) || DEFAULT_ZONE;

// A time sent by the browser: an ISO timestamp with its offset, or the site's
// wall-clock time from a form ("2026-11-02T09:05").
function parseAt(v, tz) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s) && validDate(s.slice(0, 10)) && TIME_RE.test(s.slice(11))) return localToUtc(s.slice(0, 10), s.slice(11), tz);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(s) && !Number.isNaN(Date.parse(s))) return iso(Date.parse(s));
  return undefined;
}

// Attendance rules; every one can be changed in Settings (site.workforce).
const RULE_DEFAULTS = {
  overtimeAfterMinutes: 0, // minutes past the planned shift before overtime counts
  overtimeMinimumMinutes: 15, // shorter extra time isn't overtime
  standardDayMinutes: 480, // the planned day when an assignment has no shift times
  missingCheckoutHours: 4, // after the shift's end, an open check-in becomes an exception
  maxShiftHours: 20, // a check-out further from the check-in than this is refused
  backdateDays: 7, // how far back supervisors may enter times by hand
  expiryWarnDays: 30,
  onboardingReminderDays: 2,
  timesheetReminderDays: 2,
  assignmentEndingDays: 7,
  contractEndingDays: 30,
};
const RULE_LIMITS = { overtimeAfterMinutes: 240, overtimeMinimumMinutes: 240, standardDayMinutes: 960, missingCheckoutHours: 24, maxShiftHours: 24, backdateDays: 31, expiryWarnDays: 120, onboardingReminderDays: 30, timesheetReminderDays: 30, assignmentEndingDays: 60, contractEndingDays: 120 };
const RULE_MIN = { standardDayMinutes: 60, maxShiftHours: 4, missingCheckoutHours: 1 };

// ---------- onboarding requirements ----------
const TASK_KINDS = { document: 'Upload a document', contact: 'Emergency contact', acknowledge: 'Read and accept' };
// What every worker is asked for unless a client or role has its own list.
// The photo ID is any government photo ID the worker chooses: never one
// particular card, and never bank details (pay runs outside Hireriv).
const DEFAULT_ITEMS = [
  { key: 'photo-id', label: 'Photo ID (any government photo ID you choose)', kind: 'document', required: true, expires: false },
  { key: 'emergency-contact', label: 'Emergency contact', kind: 'contact', required: true, expires: false },
  { key: 'site-rules', label: 'Site safety rules and code of conduct', kind: 'acknowledge', required: true, expires: false },
];
const SENSITIVE_RE = /aadha?ar|\buid\b|bank|account number|ifsc|pan card|passport number/i;
function parseItems(input) {
  const errors = [];
  if (!Array.isArray(input) || !input.length) return { errors: ['items must be a list of 1 to 15 requirements'], items: [] };
  if (input.length > 15) errors.push('at most 15 requirements');
  const keys = new Set();
  const items = input.slice(0, 15).map((it, i) => {
    const o = it && typeof it === 'object' ? it : {};
    const label = String(o.label ?? '').trim().replace(/\s+/g, ' ');
    const kind = String(o.kind ?? 'document');
    const required = o.required === true || o.required === 'true' || o.required === '1' || o.required === 'on';
    if (!label || label.length > 80) errors.push(`item ${i + 1}: a label of 1–80 characters is needed`);
    if (!TASK_KINDS[kind]) errors.push(`item ${i + 1}: kind must be document, contact or acknowledge`);
    // Identity numbers and bank details are never a condition of joining here.
    if (SENSITIVE_RE.test(label) && required) errors.push(`item ${i + 1}: "${label}" can't be required. Ask for "any government photo ID" instead, and keep bank details out of Hireriv`);
    let key = String(o.key || label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || `item-${i + 1}`;
    while (keys.has(key)) key = `${key}-${i + 1}`;
    keys.add(key);
    return { key, label, kind, required, expires: kind === 'document' && (o.expires === true || o.expires === 'true' || o.expires === '1' || o.expires === 'on') };
  });
  return { errors: [...new Set(errors)], items };
}

const WORKER_STATUSES = ['Onboarding', 'Ready to join', 'Joined', 'Left'];
const DONE = ['Done', 'Waived'];

function register(app, deps) {
  const {
    team, clients, billing, agency, candidates, readSubmissions, writeSubmissions, saveSubmission, adminAuth, sameOrigin, limit, site, saveSite,
    notify, mailer, baseUrl, uploadsDir, downloadLinks, linkExpired, vetDocument, hooks, requireEmployer, requireCandidate, can: employerCan,
  } = deps;
  const rules = () => ({ ...RULE_DEFAULTS, ...((site && site.workforce) || {}) });

  const workers = () => readSubmissions('workers');
  const documents = () => readSubmissions('worker-documents');
  const requirementSets = () => readSubmissions('onboarding-requirements');
  const shifts = () => readSubmissions('work-shifts');
  const records = () => readSubmissions('attendance-records');
  const corrections = () => readSubmissions('attendance-corrections');
  const timesheets = () => readSubmissions('workforce-timesheets');
  const replacements = () => readSubmissions('replacement-requests');
  const assignments = () => readSubmissions('staffing-assignments');
  const update = (collection, id, fn) => {
    const list = readSubmissions(collection);
    const rec = list.find((x) => x.id === id);
    if (!rec) return null;
    fn(rec);
    rec.updatedAt = iso();
    writeSubmissions(collection, list);
    return rec;
  };
  const clientById = (id) => clients.read().find((c) => c.id === id) || null;
  const assignmentById = (id) => assignments().find((a) => a.id === id) || null;
  const placementById = (id) => billing.read().find((p) => p.id === id) || null;
  const workerOf = (a) => (a ? workers().find((w) => w.placementId === a.placementId && w.status !== 'Left') || null : null);
  const assignmentsOf = (w) => assignments().filter((a) => a.placementId === w.placementId && a.status !== 'Cancelled');

  // ---------- who is asking ----------
  // From the session only. `as` picks one when someone is signed in as more
  // than one kind of person in the same browser.
  function actorOf(req) {
    const as = String((req.query && req.query.as) || (req.body && req.body.as) || '');
    if (!as || as === 'team') {
      const u = team.currentUser(req);
      if (u && !(team.requires2fa() && !team.has2fa(u.id))) return { kind: 'team', id: `t:${u.id}`, userId: u.id, name: u.name, user: u };
      if (as) return null;
    }
    if (!as || as === 'employer') {
      const c = clients.context(req);
      if (c) return { kind: 'employer', id: `e:${c.user.id}`, userId: c.user.id, name: c.user.name, member: c.member, employer: c.employer };
      if (as) return null;
    }
    if (!as || as === 'worker') {
      const email = candidates.currentEmail(req);
      if (email) return { kind: 'worker', id: `c:${email}`, email, name: (workers().find((w) => w.email === email) || {}).name || email };
    }
    return null;
  }
  const isAccountManagerOf = (u, employerId) => { const c = clientById(employerId); return Boolean(c && c.accountManagerId === u.id); };
  const teamScope = (u, employerId) => u.role !== 'Account Manager' || isAccountManagerOf(u, employerId);
  // What this person may do with one assignment's workforce records.
  function rights(act, a) {
    const none = { see: false, supervise: false, own: false, documents: false, payroll: false, status: false };
    if (!act || !a) return none;
    if (act.kind === 'team') {
      const u = act.user;
      const scoped = teamScope(u, a.employerId);
      const manage = scoped && roles.can(u, 'workforce.manage');
      return { see: manage, supervise: manage, own: false, documents: scoped && roles.can(u, 'workforce.documents'), payroll: roles.can(u, 'workforce.payroll'), status: scoped && roles.can(u, 'workforce.view') };
    }
    if (act.kind === 'employer') {
      if (a.employerId !== act.employer.id || !employerCan(act.member, 'workforce.view')) return none;
      const mine = act.member.role !== 'supervisor' || a.supervisorId === act.userId;
      return { ...none, see: mine, supervise: mine && employerCan(act.member, 'workforce.supervise'), status: mine };
    }
    const w = workerOf(a);
    const own = Boolean(w && w.email === act.email);
    return { ...none, see: own, own, status: own };
  }
  const visibleAssignments = (act) => assignments().filter((a) => a.status !== 'Cancelled' && rights(act, a).see);

  function audit(act, action, entity, entityId, detail = '', employerId = '') {
    saveSubmission('workforce-audit', { actorKind: act ? act.kind : 'system', actorId: act ? act.id : 'system', actorName: act ? act.name : 'Hireriv', action, entity, entityId, employerId, detail: String(detail).slice(0, 300) });
  }

  // ---------- notifications ----------
  // Recipients come from the records; the email is rebuilt from them when it
  // goes out (template "workforce"), so someone who lost access gets nothing.
  const TYPE = {
    onboarding: 'work-onboarding', 'document-review': 'work-onboarding', shift: 'work-shift', 'missing-in': 'work-attendance', 'missing-out': 'work-attendance',
    'timesheet-waiting': 'work-timesheet', 'timesheet-returned': 'work-timesheet', 'document-expiring': 'work-document', 'assignment-changed': 'work-assignment',
    'assignment-ending': 'work-assignment', 'contract-ending': 'work-assignment', replacement: 'work-assignment',
  };
  const teamFor = (employerId) => {
    const c = clientById(employerId);
    const people = team.members().filter((u) => u.active !== false && (u.role === 'Staffing Manager' || (u.role === 'Account Manager' && c && c.accountManagerId === u.id)));
    return (people.length ? people : team.members().filter((u) => u.active !== false && u.role === 'Admin')).map((u) => ({ kind: 'team', userId: u.id }));
  };
  const supervisorOf = (a) => (a && a.supervisorId ? [{ kind: 'employer', userId: a.supervisorId, employerId: a.employerId }] : []);
  const workerTo = (w) => (w && w.email ? [{ kind: 'candidate', email: w.email }] : []);
  const LINKS = { candidate: '/account/work', employer: '/employer/workforce', team: '/admin/workforce' };
  function tell(kind, key, to, title, body, refs = {}) {
    if (!notify) return;
    try {
      notify.emit({ key: `wf:${kind}:${key}`, type: TYPE[kind], to, inApp: (r) => ({ title, body, link: refs.link && r.kind === 'team' ? refs.link : LINKS[r.kind] }), email: { template: 'workforce', refs: { kind, ...refs } } });
    } catch (e) { console.error('Workforce notification failed:', e.message); }
  }
  // The person behind a recipient, if they may still see this assignment or worker.
  function recipient(refs, to) {
    const a = refs.assignmentId ? assignmentById(refs.assignmentId) : null;
    const w = refs.workerId ? workers().find((x) => x.id === refs.workerId) : workerOf(a);
    if (to.kind === 'candidate') return w && notify.candidateRk(w.email) === to.rk ? { name: w.name, email: w.email, kind: 'candidate' } : null;
    if (to.kind === 'team') {
      const u = team.byId(to.userId);
      const employerId = (a || w || {}).employerId;
      return u && u.active !== false && u.email && roles.can(u, 'workforce.view') && (!employerId || teamScope(u, employerId)) ? { name: u.name, email: u.email, kind: 'team' } : null;
    }
    if (to.kind === 'employer') {
      const store = clients.team;
      const u = store.userById(to.userId);
      const m = u && store.membership(u.id, to.employerId);
      if (!u || !u.active || !u.emailVerifiedAt || !m || !employerCan(m, 'workforce.view')) return null;
      if (a && (a.employerId !== to.employerId || (m.role === 'supervisor' && a.supervisorId !== u.id))) return null;
      return { name: u.name, email: u.email, kind: 'employer' };
    }
    return null;
  }
  const NOTICE_TEXT = {
    onboarding: ['Finish joining', 'You have joining steps left', 'a few joining steps are still open for your new assignment. They take a few minutes from your account.', 'Open my work'],
    'document-review': ['A joining document to review', 'A document is waiting for review', 'a worker uploaded a joining document that needs checking.', 'Review it'],
    shift: ['Your next shift', 'Your next shift is coming up', 'here are the details of your next shift.', 'Open my work'],
    'missing-in': ['No check-in yet', 'A shift has no check-in', 'a shift started but nobody has checked in. If the worker is there, check them in by hand; otherwise record the absence.', 'Open'],
    'missing-out': ['A check-out is missing', 'A check-out is missing', 'a shift has a check-in but no check-out. No hours are counted until a correction with the real time is approved.', 'Open'],
    'timesheet-waiting': ['A timesheet is waiting for approval', 'A timesheet needs your approval', 'a timesheet was submitted and is waiting for approval.', 'Review it'],
    'timesheet-returned': ['Your timesheet was sent back', 'A timesheet was sent back', 'a timesheet was sent back for changes. Ask for corrections where needed, then submit it again.', 'Open'],
    'document-expiring': ['A document is expiring', 'A document is about to expire', 'a joining document expires soon. Upload a new one before it does.', 'Open'],
    'assignment-changed': ['Your assignment changed', 'An assignment changed', 'the details of an assignment changed. Please check the dates, site and shift.', 'Open'],
    'assignment-ending': ['An assignment ends soon', 'An assignment ends soon', 'an assignment reaches its end date soon. Extend it or plan the next one.', 'Open'],
    'contract-ending': ['A client contract ends soon', 'A client contract ends soon', 'a client contract reaches its end date soon.', 'Open'],
    replacement: ['A replacement was requested', 'A client asked for a replacement worker', 'a client asked for a replacement on an assignment.', 'Open'],
  };
  if (notify) notify.template('workforce', {
    version: 1,
    resolve: (refs, to) => {
      const text = NOTICE_TEXT[refs.kind];
      const who = text && recipient(refs, to);
      if (!who) return null;
      // Stale reminders aren't sent: the timesheet was decided, the record fixed.
      if (refs.timesheetId) { const ts = timesheets().find((t) => t.id === refs.timesheetId); if (!ts || (refs.kind === 'timesheet-waiting' && ts.status !== 'Submitted')) return null; }
      if (refs.recordId && refs.kind === 'missing-out') { const r = records().find((x) => x.id === refs.recordId); if (!r || r.status !== 'Exception') return null; }
      const a = refs.assignmentId ? assignmentById(refs.assignmentId) : null;
      const rows = a ? [['Role', a.role], ['Site', a.site], ['Dates', `${a.startsOn} to ${a.endsOn || 'open-ended'}`]] : [];
      if (refs.when) rows.push(['When', refs.when]);
      const link = `${baseUrl}${who.kind === 'team' ? refs.link || LINKS.team : LINKS[who.kind]}`;
      return { to: who.email, send: () => mailer.notice(who, { subject: text[0], heading: text[1], intro: text[2], rows, link, label: text[3], why: 'work, shifts and attendance' }) };
    },
  });

  // ---------- onboarding ----------
  function requirementsFor(employerId, role) {
    const sets = requirementSets();
    const r = String(role || '').toLowerCase();
    return (sets.find((s) => s.employerId === employerId && s.role && s.role.toLowerCase() === r)
      || sets.find((s) => s.employerId === employerId && !s.role)
      || sets.find((s) => !s.employerId && !s.role) || { items: DEFAULT_ITEMS }).items;
  }
  function refreshStatus(w) {
    if (!['Onboarding', 'Ready to join'].includes(w.status)) return;
    const ready = w.tasks.filter((t) => t.required).every((t) => DONE.includes(t.status));
    const next = ready ? 'Ready to join' : 'Onboarding';
    if (next !== w.status) { w.history.push({ at: iso(), by: 'Hireriv', text: `${w.status} → ${next}` }); w.status = next; }
  }
  // One worker per placement: asking again returns the same worker.
  function createWorker(act, placementId) {
    if (act.kind !== 'team' || !roles.can(act.user, 'workforce.manage')) return { status: 403, errors: ['only the staffing team adds workers'] };
    const p = placementById(String(placementId || ''));
    if (!p) return { status: 400, errors: ['placementId must be a placement'] };
    if (!teamScope(act.user, p.employerId)) return { status: 403, errors: ["only this client's account manager or the staffing team adds its workers"] };
    if (p.type === 'Permanent' || p.feeMode !== 'assignment') return { status: 409, errors: ['only temporary and contract placements billed per assignment have workers to onboard'] };
    if (!['Awaiting joining', 'Joined'].includes(p.status)) return { status: 409, errors: [`the placement is "${p.status}"`] };
    const same = workers().find((w) => w.placementId === p.id);
    if (same) return { status: 200, worker: same, existed: true };
    const email = String(p.candidateEmail || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return { status: 409, errors: ["the placement has no email for the worker: add it to the placement first so they can sign in"] };
    const role = (assignments().find((a) => a.placementId === p.id) || {}).role || p.jobTitle;
    const tasks = requirementsFor(p.employerId, role).map((it) => ({ ...it, status: 'To do', note: '', updatedAt: iso() }));
    const w = saveSubmission('workers', {
      placementId: p.id, applicationId: p.applicationId || null, employerId: p.employerId, email, name: p.candidateName, status: 'Onboarding', tasks, contact: null, joinedOn: null,
      history: [{ at: iso(), by: act.name, text: 'Onboarding started' }], createdBy: act.userId, updatedAt: iso(),
    });
    refreshStatus(w);
    writeWorker(w);
    audit(act, 'worker-added', 'worker', w.id, `${w.name} for ${(clientById(p.employerId) || {}).company || p.company}`, p.employerId);
    tell('onboarding', `${w.id}:start`, workerTo(w), 'Welcome: finish joining', 'A few joining steps are waiting in your account.', { workerId: w.id });
    return { status: 201, worker: w };
  }
  function writeWorker(w) {
    const list = workers();
    const i = list.findIndex((x) => x.id === w.id);
    w.updatedAt = iso();
    list[i] = w;
    writeSubmissions('workers', list);
    return w;
  }
  const workerRights = (act, w) => {
    const as = assignments().filter((a) => a.placementId === w.placementId);
    if (act.kind === 'worker') return { see: w.email === act.email, own: w.email === act.email };
    if (act.kind === 'team') {
      const u = act.user;
      const scoped = teamScope(u, w.employerId);
      return { see: scoped && roles.can(u, 'workforce.view'), manage: scoped && roles.can(u, 'workforce.manage'), documents: scoped && roles.can(u, 'workforce.documents'), full: scoped && roles.can(u, 'workforce.manage') };
    }
    return { see: as.some((a) => rights(act, a).see) };
  };
  // What each person sees of a worker. Recruiters: the onboarding status only.
  function workerJson(w, act) {
    const r = workerRights(act, w);
    const done = w.tasks.filter((t) => DONE.includes(t.status)).length;
    const base = { id: w.id, name: w.name, status: w.status, progress: { done, total: w.tasks.length }, clientId: w.employerId, company: (clientById(w.employerId) || {}).company || '', joinedOn: w.joinedOn };
    if (act.kind === 'employer') return base;
    if (act.kind === 'team' && !r.full && !r.documents) return base;
    const docs = documents().filter((d) => d.workerId === w.id && d.status !== 'Replaced');
    return {
      ...base, placementId: w.placementId, email: w.email,
      tasks: w.tasks.map((t) => ({ key: t.key, label: t.label, kind: t.kind, required: t.required, status: t.status, note: t.note, expiresOn: t.expiresOn || null, documentId: t.documentId || null })),
      contact: w.contact, history: w.history,
      documents: docs.map((d) => ({ id: d.id, task: d.taskKey, name: d.originalName, size: d.size, sha256: d.sha256, expiresOn: d.expiresOn, status: d.status, uploadedAt: d.createdAt })),
      assignments: assignmentsOf(w).map((a) => ({ id: a.id, role: a.role, site: a.site, startsOn: a.startsOn, endsOn: a.endsOn, status: a.status })),
    };
  }
  const yes = (v) => v === true || v === 'true' || v === '1' || v === 'on';
  // The worker completes their steps; the team reviews, waives, marks joined or left.
  function onboardingAction(act, workerId, input) {
    const w = workers().find((x) => x.id === workerId);
    const r = w ? workerRights(act, w) : {};
    if (!w || !r.see) return { status: 404, errors: ['worker not found'] };
    const body = input && typeof input === 'object' ? input : {};
    const allowed = ['task', 'contact', 'contactName', 'contactPhone', 'contactRelation', 'accept', 'decision', 'note', 'status', 'joinedOn', 'reason'];
    const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
    if (unknown.length) return { status: 400, errors: unknown.map((k) => `${k} is not a field you can set`) };
    if (body.status !== undefined) {
      if (!r.manage) return { status: 403, errors: ['only the staffing team changes a worker\'s status'] };
      const next = String(body.status);
      if (next === 'Joined') {
        if (w.status !== 'Ready to join') return { status: 409, errors: [w.status === 'Joined' ? 'already joined' : 'finish the required joining steps first'] };
        const on = String(body.joinedOn || '').trim() || localDate(iso(), DEFAULT_ZONE);
        if (!validDate(on)) return { status: 400, errors: ['joinedOn must be a date like 2026-11-02'] };
        w.joinedOn = on;
      } else if (next === 'Left') {
        const reason = String(body.reason || '').trim().slice(0, 200);
        if (!reason) return { status: 400, errors: ['give a reason when a worker leaves'] };
        if (w.status === 'Left') return { status: 409, errors: ['already left'] };
        w.leftReason = reason;
      } else return { status: 400, errors: ['status can be Joined or Left; the rest follows the joining steps'] };
      w.history.push({ at: iso(), by: act.name, text: `${w.status} → ${next}${next === 'Left' ? `: ${w.leftReason}` : ''}` });
      w.status = next;
      writeWorker(w);
      audit(act, `worker-${next.toLowerCase()}`, 'worker', w.id, w.name, w.employerId);
      return { status: 200, worker: w };
    }
    const t = w.tasks.find((x) => x.key === String(body.task || ''));
    if (!t) return { status: 400, errors: ['task must be one of this worker\'s joining steps'] };
    if (body.decision !== undefined) {
      const decision = String(body.decision);
      if (!['approve', 'reject', 'waive'].includes(decision)) return { status: 400, errors: ['decision must be approve, reject or waive'] };
      if (!(t.kind === 'document' ? r.documents : r.manage)) return { status: 403, errors: [t.kind === 'document' ? 'only Admins and Staffing Managers review documents' : 'only the staffing team reviews joining steps'] };
      if (decision === 'approve' && t.status !== 'Submitted') return { status: 409, errors: ['nothing submitted to approve yet'] };
      const note = String(body.note || '').trim().slice(0, 200);
      if (decision !== 'approve' && !note) return { status: 400, errors: ['add a note saying why'] };
      const before = t.status;
      Object.assign(t, { status: { approve: 'Done', reject: 'Rejected', waive: 'Waived' }[decision], note, decidedBy: act.name, updatedAt: iso() });
      if (t.documentId) update('worker-documents', t.documentId, (d) => { d.status = t.status === 'Done' ? 'Approved' : t.status; d.history.push({ at: iso(), by: act.name, text: `${before} → ${t.status}${note ? `: ${note}` : ''}` }); });
      w.history.push({ at: iso(), by: act.name, text: `${t.label}: ${before} → ${t.status}${note ? ` (${note})` : ''}` });
      refreshStatus(w);
      writeWorker(w);
      audit(act, `onboarding-${decision}`, 'worker', w.id, `${w.name}: ${t.label}`, w.employerId);
      if (decision === 'reject') tell('onboarding', `${w.id}:${t.key}:rejected:${t.updatedAt}`, workerTo(w), `Please redo: ${t.label}`, note, { workerId: w.id });
      return { status: 200, worker: w };
    }
    if (!r.own) return { status: 403, errors: ['only the worker completes their joining steps'] };
    if (DONE.includes(t.status)) return { status: 409, errors: ['this step is already done'] };
    if (t.kind === 'document') return { status: 400, errors: ['upload documents with POST /api/staffing/workers/:id/documents'] };
    if (t.kind === 'acknowledge') {
      if (!yes(body.accept)) return { status: 400, errors: ['tick that you have read and accept it'] };
      Object.assign(t, { status: 'Done', acceptedAt: iso(), note: '', updatedAt: iso() });
    } else {
      // JSON sends contact: {name, phone, relation}; the form sends flat fields.
      const c = body.contact && typeof body.contact === 'object' ? body.contact : { name: body.contactName, phone: body.contactPhone, relation: body.contactRelation };
      const name = String(c.name || '').trim().slice(0, 81);
      const phone = String(c.phone || '').replace(/[\s-]/g, '');
      const relation = String(c.relation || '').trim().slice(0, 41);
      const errors = [];
      if (!name || name.length > 80) errors.push('contact name is needed (up to 80 characters)');
      if (!/^\+?\d{8,15}$/.test(phone)) errors.push('contact phone must be 8–15 digits');
      if (relation.length > 40) errors.push('relation must be 40 characters or fewer');
      if (errors.length) return { status: 400, errors };
      w.contact = { name, phone, relation };
      Object.assign(t, { status: 'Done', note: '', updatedAt: iso() });
    }
    w.history.push({ at: iso(), by: w.name, text: `${t.label}: done` });
    refreshStatus(w);
    writeWorker(w);
    return { status: 200, worker: w };
  }

  // ---------- documents ----------
  // Kept outside the public folder, named at random, read only through
  // short-lived signed links by the worker and the people allowed to review.
  const docsDir = path.join(uploadsDir, 'worker-documents');
  fs.mkdirSync(docsDir, { recursive: true });
  const docUpload = multer({
    storage: multer.diskStorage({ destination: docsDir, filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`) }),
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => {
      const ok = DOCUMENT_TYPES.includes(path.extname(file.originalname).toLowerCase());
      cb(ok ? null : Object.assign(new Error('Documents must be a PDF, JPG or PNG file'), { status: 400 }), ok);
    },
  });
  async function addDocument(act, workerId, file, input) {
    const drop = () => file && fs.unlink(file.path, () => {});
    const w = workers().find((x) => x.id === workerId);
    if (!w || !workerRights(act, w).own) { drop(); return { status: 404, errors: ['worker not found'] }; }
    const t = w.tasks.find((x) => x.key === String((input && input.task) || ''));
    if (!t || t.kind !== 'document') { drop(); return { status: 400, errors: ['task must be one of your document steps'] }; }
    if (t.status === 'Done' && !t.expires) { drop(); return { status: 409, errors: ['this document is already approved'] }; }
    if (!file) return { status: 400, errors: ['choose a PDF, JPG or PNG file'] };
    const expiresOn = String((input && input.expiresOn) || '').trim();
    if (expiresOn && !validDate(expiresOn)) { drop(); return { status: 400, errors: ['expiresOn must be a date like 2028-03-31'] }; }
    if (t.expires && !expiresOn) { drop(); return { status: 400, errors: ['give the date this document expires'] }; }
    if (expiresOn && expiresOn <= localDate(iso(), DEFAULT_ZONE)) { drop(); return { status: 400, errors: ['this document has already expired'] }; }
    const bad = await vetDocument(file);
    if (bad) return { status: 400, errors: [bad] };
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(file.path)).digest('hex');
    // A newer upload replaces the older one; the old file goes.
    for (const old of documents().filter((d) => d.workerId === w.id && d.taskKey === t.key && d.status !== 'Replaced')) {
      update('worker-documents', old.id, (d) => { d.status = 'Replaced'; d.history.push({ at: iso(), by: w.name, text: 'Replaced by a newer upload' }); });
      fs.unlink(path.join(docsDir, old.file), () => {});
    }
    const d = saveSubmission('worker-documents', {
      workerId: w.id, employerId: w.employerId, taskKey: t.key, label: t.label, file: path.basename(file.filename), originalName: String(file.originalname).slice(0, 120), size: file.size,
      contentType: file.mimetype, sha256, expiresOn: expiresOn || null, status: 'Submitted', history: [{ at: iso(), by: w.name, text: 'Uploaded' }],
    });
    const before = t.status;
    Object.assign(t, { status: 'Submitted', documentId: d.id, expiresOn: d.expiresOn, note: '', updatedAt: iso() });
    w.history.push({ at: iso(), by: w.name, text: `${t.label}: ${before} → Submitted` });
    refreshStatus(w);
    writeWorker(w);
    tell('document-review', `${d.id}`, teamFor(w.employerId), `Document to review: ${w.name}`, t.label, { workerId: w.id, link: `/admin/workforce/workers/${w.id}` });
    return { status: 201, document: d };
  }
  function sendDocument(act, req, res, back) {
    if (!downloadLinks.valid(req)) return linkExpired(res, back);
    const d = documents().find((x) => x.id === req.params.id && x.status !== 'Replaced');
    const w = d && workers().find((x) => x.id === d.workerId);
    const r = w ? workerRights(act, w) : {};
    if (!d || !(r.own || r.documents)) return res.status(404).send('Not found');
    const file = path.join(docsDir, path.basename(d.file));
    if (!fs.existsSync(file)) return res.status(404).send('Not found');
    audit(act, 'document-viewed', 'worker-document', d.id, `${w.name}: ${d.label}`, d.employerId);
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" });
    res.download(file, `${d.label.replace(/[^\w.-]+/g, '-').slice(0, 40)}${path.extname(d.file)}`);
  }

  // ---------- shifts ----------
  // The planned shift on a date: one scheduled for that day, else the
  // assignment's usual times; null when neither is set.
  function planFor(a, date) {
    const s = shifts().find((x) => x.assignmentId === a.id && x.date === date && x.status !== 'Cancelled');
    const start = s ? s.start : a.shiftStart;
    const end = s ? s.end : a.shiftEnd;
    if (!start || !end) return null;
    const tz = zoneOf(a);
    const startAt = localToUtc(date, start, tz);
    const endAt = localToUtc(end <= start ? addDays(date, 1) : date, end, tz);
    const breakMinutes = s && s.breakMinutes !== undefined ? s.breakMinutes : a.breakMinutes || 0;
    return { shiftId: s ? s.id : null, date, start, end, startAt, endAt, breakMinutes, minutes: Math.round((Date.parse(endAt) - Date.parse(startAt)) / 60000) - breakMinutes };
  }
  const inAssignment = (a, date) => date >= a.startsOn && (!a.endsOn || date <= a.endsOn);
  const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  function planShifts(act, input) {
    const body = input && typeof input === 'object' ? input : {};
    const unknown = Object.keys(body).filter((k) => !['assignmentId', 'from', 'to', 'start', 'end', 'breakMinutes', 'days'].includes(k));
    if (unknown.length) return { status: 400, errors: unknown.map((k) => `${k} is not a field you can set`) };
    const a = assignmentById(String(body.assignmentId || ''));
    if (!a || !rights(act, a).see) return { status: 404, errors: ['assignment not found'] };
    if (!rights(act, a).supervise) return { status: 403, errors: ['your role does not allow planning shifts'] };
    if (!['Scheduled', 'Active'].includes(a.status)) return { status: 409, errors: [`the assignment is ${a.status.toLowerCase()}`] };
    const errors = [];
    const from = String(body.from || '').trim();
    const to = String(body.to || from).trim();
    if (!validDate(from) || !validDate(to)) errors.push('from and to must be dates like 2026-11-02');
    const start = String(body.start || a.shiftStart || '').trim();
    const end = String(body.end || a.shiftEnd || '').trim();
    if (!TIME_RE.test(start) || !TIME_RE.test(end)) errors.push('start and end must be times like 09:00 (or set them on the assignment)');
    if (start && start === end) errors.push('a shift needs a length');
    const brk = body.breakMinutes === undefined || body.breakMinutes === '' ? a.breakMinutes || 0 : Number(body.breakMinutes);
    if (!Number.isInteger(brk) || brk < 0 || brk > 180) errors.push('breakMinutes must be 0 to 180');
    const days = body.days === undefined || body.days === '' ? WEEKDAYS : [].concat(body.days).flatMap((d) => String(d).toLowerCase().split(',')).map((d) => d.trim().slice(0, 3)).filter(Boolean);
    if (days.some((d) => !WEEKDAYS.includes(d))) errors.push('days must be weekdays like mon, tue');
    if (!errors.length) {
      if (to < from) errors.push('to is before from');
      else if (daysBetween(from, to) > 62) errors.push('plan at most 63 days at a time');
      if (from < a.startsOn || (a.endsOn && to > a.endsOn)) errors.push(`the dates must be inside the assignment (${a.startsOn} to ${a.endsOn || 'open-ended'})`);
    }
    if (errors.length) return { status: 400, errors };
    const tz = zoneOf(a);
    const w = workerOf(a);
    const theirs = w ? new Set(assignments().filter((x) => x.id !== a.id && x.status !== 'Cancelled' && placementById(x.placementId) && String(placementById(x.placementId).candidateEmail || '').toLowerCase() === w.email).map((x) => x.id)) : new Set();
    const existing = shifts().filter((s) => s.status !== 'Cancelled');
    const added = [];
    const skipped = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      if (!days.includes(WEEKDAYS[new Date(`${d}T00:00:00Z`).getUTCDay()])) continue;
      if (existing.some((s) => s.assignmentId === a.id && s.date === d)) { skipped.push({ date: d, reason: 'already planned' }); continue; }
      const startAt = localToUtc(d, start, tz);
      const endAt = localToUtc(end <= start ? addDays(d, 1) : d, end, tz);
      // The same person can't be on two shifts at once, at any client.
      if (existing.some((s) => theirs.has(s.assignmentId) && s.startAt < endAt && s.endAt > startAt)) { skipped.push({ date: d, reason: 'the worker has another shift then' }); continue; }
      added.push(saveSubmission('work-shifts', { assignmentId: a.id, employerId: a.employerId, date: d, start, end, startAt, endAt, breakMinutes: brk, status: 'Planned', createdBy: act.id, createdByName: act.name }));
    }
    if (added.length) audit(act, 'shifts-planned', 'assignment', a.id, `${added.length} shift(s) ${from} to ${to}, ${start}–${end}`, a.employerId);
    return { status: added.length ? 201 : 200, shifts: added, skipped };
  }
  function cancelShift(act, id, reason) {
    const s = shifts().find((x) => x.id === id);
    const a = s && assignmentById(s.assignmentId);
    if (!s || !rights(act, a).see) return { status: 404, errors: ['shift not found'] };
    if (!rights(act, a).supervise) return { status: 403, errors: ['your role does not allow changing shifts'] };
    if (s.status === 'Cancelled') return { status: 409, errors: ['already cancelled'] };
    if (records().some((r) => r.assignmentId === a.id && r.date === s.date && r.kind !== 'absence')) return { status: 409, errors: ['someone already checked in for this shift'] };
    const saved = update('work-shifts', id, (x) => Object.assign(x, { status: 'Cancelled', cancelledBy: act.name, cancelReason: String(reason || '').slice(0, 200) }));
    audit(act, 'shift-cancelled', 'shift', id, `${s.date} ${s.start}–${s.end}`, a.employerId);
    return { status: 200, shift: saved };
  }
  const shiftJson = (s) => ({ id: s.id, assignmentId: s.assignmentId, date: s.date, start: s.start, end: s.end, startAt: s.startAt, endAt: s.endAt, breakMinutes: s.breakMinutes, status: s.status });

  // ---------- attendance ----------
  const workedOf = (r) => {
    if (!r.checkInAt || !r.checkOutAt) return null;
    const total = Math.round((Date.parse(r.checkOutAt) - Date.parse(r.checkInAt)) / 60000);
    const brk = (r.breaks || []).filter((b) => b.endAt).reduce((n, b) => n + Math.round((Date.parse(b.endAt) - Date.parse(b.startAt)) / 60000), 0);
    return Math.max(0, total - brk);
  };
  // Late minutes, worked minutes and overtime, from the times only.
  function compute(r, a) {
    const plan = planFor(a, r.date);
    const R = rules();
    const grace = a.graceMinutes === undefined ? 10 : a.graceMinutes;
    const late = plan && r.checkInAt ? Math.round((Date.parse(r.checkInAt) - Date.parse(plan.startAt)) / 60000) : 0;
    r.lateMinutes = late > grace ? late : 0;
    r.plannedMinutes = plan ? plan.minutes : R.standardDayMinutes;
    r.workedMinutes = workedOf(r);
    if (r.workedMinutes === null) { r.overtimeMinutes = 0; return r; }
    const extra = r.workedMinutes - r.plannedMinutes - R.overtimeAfterMinutes;
    const ot = extra >= R.overtimeMinimumMinutes ? extra : 0;
    if (ot !== r.overtimeMinutes) { r.overtimeMinutes = ot; r.overtimeStatus = ot ? 'Pending' : 'None'; r.overtimeDecision = null; }
    if (!r.overtimeStatus) r.overtimeStatus = 'None';
    return r;
  }
  const openRecordOf = (w) => records().find((r) => r.kind !== 'absence' && r.status === 'Open' && workers().some((x) => x.id === r.workerId && x.email === w.email));
  // A time someone else enters for a worker: not in the future, at most
  // backdateDays back. Workers always use the server's clock.
  function timeFrom(act, body, a) {
    if (body.at === undefined || body.at === '') return { at: iso(), manual: false };
    if (act.kind === 'worker') return { error: 'workers check in and out at the current time; ask your supervisor to correct a time' };
    const at = parseAt(body.at, zoneOf(a));
    if (!at) return { error: 'at must be a time like 2026-11-02T09:05 (site time) or an ISO timestamp' };
    if (Date.parse(at) > Date.now() + 60000) return { error: 'at is in the future' };
    if (Date.parse(at) < Date.now() - rules().backdateDays * DAY) return { error: `at is more than ${rules().backdateDays} days ago: ask for a correction instead` };
    return { at, manual: true };
  }
  const strictBody = (input, allowed) => {
    const body = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
    return { body, errors: unknown.map((k) => (/^(lat|lng|latitude|longitude|location|coords|gps)$/i.test(k) ? `${k}: location is not collected` : `${k} is not a field you can set`)) };
  };
  const lockedMsg = (r) => (r.locked ? 'this attendance is in an approved timesheet and can no longer change' : r.timesheetId ? 'this attendance is in a submitted timesheet: send the timesheet back first' : '');
  function checkIn(act, input, requestKey) {
    const { body, errors } = strictBody(input, ['assignmentId', 'at', 'note']);
    if (errors.length) return { status: 400, errors };
    const a = assignmentById(String(body.assignmentId || ''));
    const rt = rights(act, a);
    if (!a || !rt.see) return { status: 404, errors: ['assignment not found'] };
    if (!rt.own && !rt.supervise) return { status: 403, errors: ['only the worker, their supervisor or the staffing team records attendance'] };
    if (requestKey) {
      const same = records().find((r) => r.requestKey === `${act.id}:${requestKey}`);
      if (same) return { status: 200, record: same, existed: true };
    }
    if (a.status !== 'Active') return { status: 409, errors: [`the assignment is ${a.status.toLowerCase()}: attendance starts once it is active`] };
    const w = workerOf(a);
    if (!w || w.status !== 'Joined') return { status: 409, errors: ['the worker has not joined yet: finish onboarding first'] };
    const t = timeFrom(act, body, a);
    if (t.error) return { status: 400, errors: [t.error] };
    const date = localDate(t.at, zoneOf(a));
    if (!inAssignment(a, date)) return { status: 409, errors: [`${date} is outside the assignment (${a.startsOn} to ${a.endsOn || 'open-ended'})`] };
    const open = openRecordOf(w);
    if (open) return { status: 409, errors: ['already checked in: check out first'], record: open };
    if (records().some((r) => r.assignmentId === a.id && r.date === date && r.kind === 'absence')) return { status: 409, errors: [`${date} is recorded as an absence: correct that first`] };
    const by = { kind: act.kind, id: act.id, name: act.name };
    const rec = compute({
      kind: 'shift', assignmentId: a.id, workerId: w.id, employerId: a.employerId, date, checkInAt: t.at, checkOutAt: null, breaks: [],
      source: act.kind === 'worker' ? 'self' : t.manual ? 'manual' : act.kind === 'employer' ? 'supervisor' : 'team', enteredBy: by, checkOutBy: null, note: String(body.note || '').slice(0, 200),
      status: 'Open', exception: '', overtimeMinutes: 0, overtimeStatus: 'None', timesheetId: null, locked: false, requestKey: requestKey ? `${act.id}:${requestKey}` : null,
      history: [{ at: iso(), by: act.name, text: `Checked in at ${showAt(t.at, zoneOf(a))}${t.manual ? ' (entered by hand)' : ''}` }],
    }, a);
    const saved = saveSubmission('attendance-records', rec);
    if (t.manual) audit(act, 'attendance-entered', 'attendance', saved.id, `${w.name}: in ${showAt(t.at, zoneOf(a))}`, a.employerId);
    return { status: 201, record: saved };
  }
  function findOpen(act, body) {
    const r = body.recordId ? records().find((x) => x.id === String(body.recordId)) : null;
    const a = assignmentById(String(body.assignmentId || (r && r.assignmentId) || ''));
    const rt = rights(act, a);
    if (!a || !rt.see) return { status: 404, errors: ['assignment not found'] };
    if (!rt.own && !rt.supervise) return { status: 403, errors: ['only the worker, their supervisor or the staffing team records attendance'] };
    const rec = r && r.assignmentId === a.id ? r : records().find((x) => x.assignmentId === a.id && x.status === 'Open' && x.kind !== 'absence') || records().find((x) => x.assignmentId === a.id && x.status === 'Exception');
    if (!rec || rec.status !== 'Open') return { status: 409, errors: [rec && rec.status === 'Exception' ? 'this check-in has no check-out and is an exception now: ask for a correction with the real time' : 'not checked in'] };
    return { a, rec };
  }
  function checkOut(act, input) {
    const { body, errors } = strictBody(input, ['assignmentId', 'recordId', 'at', 'note']);
    if (errors.length) return { status: 400, errors };
    const f = findOpen(act, body);
    if (f.errors) return f;
    const { a, rec } = f;
    const t = timeFrom(act, body, a);
    if (t.error) return { status: 400, errors: [t.error] };
    if (t.at <= rec.checkInAt) return { status: 400, errors: ['check-out must be after check-in'] };
    if (Date.parse(t.at) - Date.parse(rec.checkInAt) > rules().maxShiftHours * 3600000) return { status: 409, errors: [`more than ${rules().maxShiftHours} hours after check-in: ask for a correction with the real times instead`] };
    const saved = update('attendance-records', rec.id, (r) => {
      for (const b of r.breaks) if (!b.endAt) b.endAt = t.at;
      r.checkOutAt = t.at;
      r.checkOutBy = { kind: act.kind, id: act.id, name: act.name };
      if (body.note) r.note = `${r.note ? `${r.note} · ` : ''}${String(body.note).slice(0, 200)}`.slice(0, 400);
      r.status = 'Complete';
      compute(r, a);
      r.history.push({ at: iso(), by: act.name, text: `Checked out at ${showAt(t.at, zoneOf(a))}${t.manual ? ' (entered by hand)' : ''}${r.overtimeMinutes ? `; ${hours(r.overtimeMinutes)} overtime waiting for approval` : ''}` });
    });
    if (t.manual) audit(act, 'attendance-entered', 'attendance', rec.id, `out ${showAt(t.at, zoneOf(a))}`, a.employerId);
    return { status: 200, record: saved };
  }
  function breakAction(act, id, input) {
    const { body, errors } = strictBody(input, ['action', 'at']);
    if (errors.length) return { status: 400, errors };
    const f = findOpen(act, { recordId: id, assignmentId: (records().find((x) => x.id === id) || {}).assignmentId });
    if (f.errors) return f;
    const { a, rec } = f;
    const action = String(body.action || '');
    if (!['start', 'end'].includes(action)) return { status: 400, errors: ['action must be start or end'] };
    const t = timeFrom(act, body, a);
    if (t.error) return { status: 400, errors: [t.error] };
    if (t.at <= rec.checkInAt) return { status: 400, errors: ['a break starts after check-in'] };
    const open = rec.breaks.find((b) => !b.endAt);
    if (action === 'start' && open) return { status: 409, errors: ['a break is already running'] };
    if (action === 'end' && !open) return { status: 409, errors: ['no break is running'] };
    if (action === 'end' && t.at <= open.startAt) return { status: 400, errors: ['a break ends after it starts'] };
    if (rec.breaks.length >= 10 && action === 'start') return { status: 409, errors: ['at most 10 breaks a shift'] };
    const saved = update('attendance-records', rec.id, (r) => {
      if (action === 'start') r.breaks.push({ startAt: t.at, endAt: null });
      else r.breaks.find((b) => !b.endAt).endAt = t.at;
      r.history.push({ at: iso(), by: act.name, text: `Break ${action === 'start' ? 'started' : 'ended'} at ${showAt(t.at, zoneOf(a))}` });
    });
    return { status: 200, record: saved };
  }
  // An absence on a planned day (leave, sickness, no-show), recorded by the
  // supervisor or the team. It counts no hours.
  const ABSENCE_REASONS = ['Leave', 'Sick', 'No show', 'Holiday', 'Site closed'];
  function recordAbsence(act, input) {
    const { body, errors } = strictBody(input, ['assignmentId', 'date', 'reason', 'note']);
    if (errors.length) return { status: 400, errors };
    const a = assignmentById(String(body.assignmentId || ''));
    if (!a || !rights(act, a).see) return { status: 404, errors: ['assignment not found'] };
    if (!rights(act, a).supervise) return { status: 403, errors: ['only the supervisor or the staffing team records absences'] };
    const w = workerOf(a);
    const date = String(body.date || '').trim();
    if (!validDate(date)) return { status: 400, errors: ['date must be a date like 2026-11-02'] };
    if (!inAssignment(a, date)) return { status: 409, errors: ['that date is outside the assignment'] };
    if (!ABSENCE_REASONS.includes(String(body.reason))) return { status: 400, errors: [`reason must be one of ${ABSENCE_REASONS.join(', ')}`] };
    if (records().some((r) => r.assignmentId === a.id && r.date === date)) return { status: 409, errors: ['attendance is already recorded for that day'] };
    const rec = saveSubmission('attendance-records', {
      kind: 'absence', assignmentId: a.id, workerId: w ? w.id : null, employerId: a.employerId, date, reason: String(body.reason), note: String(body.note || '').slice(0, 200),
      checkInAt: null, checkOutAt: null, breaks: [], workedMinutes: 0, overtimeMinutes: 0, overtimeStatus: 'None', lateMinutes: 0, status: 'Complete', exception: '',
      source: 'manual', enteredBy: { kind: act.kind, id: act.id, name: act.name }, timesheetId: null, locked: false, history: [{ at: iso(), by: act.name, text: `Absence: ${body.reason}` }],
    });
    audit(act, 'absence-recorded', 'attendance', rec.id, `${date}: ${body.reason}`, a.employerId);
    return { status: 201, record: rec };
  }
  // Overtime counts once someone other than the worker, and other than whoever
  // entered the times, approves it.
  function decideOvertime(act, id, input) {
    const { body, errors } = strictBody(input, ['decision', 'note']);
    if (errors.length) return { status: 400, errors };
    const r = records().find((x) => x.id === id);
    const a = r && assignmentById(r.assignmentId);
    if (!r || !rights(act, a).see) return { status: 404, errors: ['attendance not found'] };
    if (!rights(act, a).supervise) return { status: 403, errors: ['only the supervisor or the staffing team approves overtime'] };
    if (r.overtimeStatus !== 'Pending') return { status: 409, errors: ['no overtime waiting for a decision'] };
    if ([r.enteredBy && r.enteredBy.id, r.checkOutBy && r.checkOutBy.id].includes(act.id)) return { status: 403, errors: ['you entered these times: someone else approves the overtime'] };
    if (lockedMsg(r)) return { status: 409, errors: [lockedMsg(r)] };
    const decision = String(body.decision || '');
    if (!['approve', 'reject'].includes(decision)) return { status: 400, errors: ['decision must be approve or reject'] };
    const saved = update('attendance-records', id, (x) => {
      x.overtimeStatus = decision === 'approve' ? 'Approved' : 'Rejected';
      x.overtimeDecision = { by: act.id, byName: act.name, at: iso(), note: String(body.note || '').slice(0, 200) };
      x.history.push({ at: iso(), by: act.name, text: `Overtime of ${hours(x.overtimeMinutes)} ${x.overtimeStatus.toLowerCase()}` });
    });
    audit(act, `overtime-${decision}`, 'attendance', id, hours(r.overtimeMinutes), a.employerId);
    return { status: 200, record: saved };
  }

  // ---------- corrections ----------
  // Anyone who sees the record asks; someone else who supervises it decides.
  // Requests and decisions are never edited, and the record keeps its
  // original times and every change in its history.
  function requestCorrection(act, id, input) {
    const { body, errors } = strictBody(input, ['checkInAt', 'checkOutAt', 'breakMinutes', 'reason']);
    if (errors.length) return { status: 400, errors };
    const r = records().find((x) => x.id === id);
    const a = r && assignmentById(r.assignmentId);
    const rt = rights(act, a);
    if (!r || !rt.see) return { status: 404, errors: ['attendance not found'] };
    if (!rt.own && !rt.supervise) return { status: 403, errors: ['your role does not allow that'] };
    if (r.kind === 'absence') return { status: 409, errors: ['absences are changed by the supervisor'] };
    if (lockedMsg(r)) return { status: 409, errors: [lockedMsg(r)] };
    if (corrections().some((c) => c.recordId === r.id && c.status === 'Pending')) return { status: 409, errors: ['a correction is already waiting for this record'] };
    const tz = zoneOf(a);
    const errs = [];
    const proposed = {};
    for (const k of ['checkInAt', 'checkOutAt']) {
      if (body[k] === undefined || body[k] === '') continue;
      const v = parseAt(body[k], tz);
      if (!v) errs.push(`${k} must be a time like 2026-11-02T09:05 (site time) or an ISO timestamp`);
      else if (Date.parse(v) > Date.now() + 60000) errs.push(`${k} is in the future`);
      else proposed[k] = v;
    }
    if (body.breakMinutes !== undefined && body.breakMinutes !== '') {
      const b = Number(body.breakMinutes);
      if (!Number.isInteger(b) || b < 0 || b > 600) errs.push('breakMinutes must be 0 to 600');
      else proposed.breakMinutes = b;
    }
    const reason = String(body.reason || '').trim().slice(0, 300);
    if (!reason) errs.push('give a reason for the correction');
    if (!Object.keys(proposed).length) errs.push('give the corrected check-in, check-out or break minutes');
    const inAt = proposed.checkInAt || r.checkInAt;
    const outAt = proposed.checkOutAt || r.checkOutAt;
    if (!errs.length && outAt && outAt <= inAt) errs.push('check-out must be after check-in');
    if (!errs.length && outAt && Date.parse(outAt) - Date.parse(inAt) > rules().maxShiftHours * 3600000) errs.push(`more than ${rules().maxShiftHours} hours between check-in and check-out`);
    if (!errs.length && proposed.checkInAt && localDate(proposed.checkInAt, tz) !== r.date) errs.push(`check-in must stay on ${r.date}; record another day separately`);
    if (errs.length) return { status: 400, errors: errs };
    const before = { checkInAt: r.checkInAt, checkOutAt: r.checkOutAt, breakMinutes: (r.breaks || []).filter((b) => b.endAt).reduce((n, b) => n + Math.round((Date.parse(b.endAt) - Date.parse(b.startAt)) / 60000), 0) };
    const c = saveSubmission('attendance-corrections', { recordId: r.id, assignmentId: a.id, employerId: a.employerId, proposed, before, reason, status: 'Pending', requestedBy: act.id, requestedByName: act.name, requestedByKind: act.kind });
    update('attendance-records', r.id, (x) => x.history.push({ at: iso(), by: act.name, text: `Correction asked: ${reason}` }));
    audit(act, 'correction-requested', 'attendance', r.id, reason, a.employerId);
    return { status: 201, correction: c };
  }
  function decideCorrection(act, id, input) {
    const { body, errors } = strictBody(input, ['decision', 'note']);
    if (errors.length) return { status: 400, errors };
    const c = corrections().find((x) => x.id === id);
    const r = c && records().find((x) => x.id === c.recordId);
    const a = r && assignmentById(r.assignmentId);
    if (!c || !r || !rights(act, a).see) return { status: 404, errors: ['correction not found'] };
    if (!rights(act, a).supervise) return { status: 403, errors: ['only the supervisor or the staffing team decides corrections'] };
    if (c.requestedBy === act.id) return { status: 403, errors: ['you asked for this correction: someone else decides it'] };
    if (c.status !== 'Pending') return { status: 409, errors: [`already ${c.status.toLowerCase()}`] };
    if (lockedMsg(r)) return { status: 409, errors: [lockedMsg(r)] };
    const decision = String(body.decision || '');
    if (!['approve', 'reject'].includes(decision)) return { status: 400, errors: ['decision must be approve or reject'] };
    const note = String(body.note || '').trim().slice(0, 200);
    if (decision === 'reject' && !note) return { status: 400, errors: ['say why it is rejected'] };
    const saved = update('attendance-corrections', id, (x) => Object.assign(x, { status: decision === 'approve' ? 'Approved' : 'Rejected', decidedBy: act.id, decidedByName: act.name, decidedAt: iso(), note }));
    if (decision === 'approve') {
      const tz = zoneOf(a);
      update('attendance-records', r.id, (x) => {
        if (!x.original) x.original = { checkInAt: x.checkInAt, checkOutAt: x.checkOutAt, breaks: x.breaks };
        if (c.proposed.checkInAt) x.checkInAt = c.proposed.checkInAt;
        if (c.proposed.checkOutAt) x.checkOutAt = c.proposed.checkOutAt;
        if (c.proposed.breakMinutes !== undefined) x.breaks = c.proposed.breakMinutes ? [{ startAt: x.checkInAt, endAt: iso(Date.parse(x.checkInAt) + c.proposed.breakMinutes * 60000), corrected: true }] : [];
        if (x.checkOutAt) { x.status = 'Complete'; x.exception = ''; }
        compute(x, a);
        x.history.push({ at: iso(), by: act.name, text: `Correction approved: in ${showAt(c.before.checkInAt, tz) || '—'} → ${showAt(x.checkInAt, tz)}, out ${showAt(c.before.checkOutAt, tz) || '—'} → ${showAt(x.checkOutAt, tz) || '—'}`, correctionId: c.id });
      });
    } else update('attendance-records', r.id, (x) => x.history.push({ at: iso(), by: act.name, text: `Correction rejected: ${note}`, correctionId: c.id }));
    audit(act, `correction-${decision}`, 'attendance', r.id, note || c.reason, a.employerId);
    return { status: 200, correction: saved, record: records().find((x) => x.id === r.id) };
  }
  const recordJson = (r, a) => ({
    id: r.id, kind: r.kind, assignmentId: r.assignmentId, workerId: r.workerId, date: r.date, timeZone: zoneOf(a), checkInAt: r.checkInAt, checkOutAt: r.checkOutAt,
    checkIn: r.checkInAt ? localTime(r.checkInAt, zoneOf(a)) : null, checkOut: r.checkOutAt ? localTime(r.checkOutAt, zoneOf(a)) : null,
    breaks: (r.breaks || []).map((b) => ({ startAt: b.startAt, endAt: b.endAt })), source: r.source, status: r.status, exception: r.exception || '', reason: r.reason || '',
    lateMinutes: r.lateMinutes || 0, workedMinutes: r.workedMinutes, overtimeMinutes: r.overtimeMinutes || 0, overtimeStatus: r.overtimeStatus || 'None',
    timesheetId: r.timesheetId || null, locked: Boolean(r.locked), original: r.original || null, history: r.history,
  });
  function listAttendance(act, q) {
    const from = validDate(String(q.from || '')) ? q.from : '';
    const to = validDate(String(q.to || '')) ? q.to : '';
    const as = visibleAssignments(act).filter((a) => !q.assignmentId || a.id === q.assignmentId);
    const ids = new Map(as.map((a) => [a.id, a]));
    return records().filter((r) => ids.has(r.assignmentId) && (!from || r.date >= from) && (!to || r.date <= to) && (!q.status || r.status === q.status))
      .sort((x, y) => (y.date + (y.checkInAt || '')).localeCompare(x.date + (x.checkInAt || ''))).slice(0, 500).map((r) => recordJson(r, ids.get(r.assignmentId)));
  }

  // ---------- timesheets ----------
  function totalsOf(list) {
    const shiftsDone = list.filter((r) => r.kind !== 'absence');
    const worked = shiftsDone.reduce((n, r) => n + (r.workedMinutes || 0), 0);
    const ot = shiftsDone.filter((r) => r.overtimeStatus === 'Approved').reduce((n, r) => n + r.overtimeMinutes, 0);
    const rejectedOt = shiftsDone.filter((r) => r.overtimeStatus === 'Rejected').reduce((n, r) => n + r.overtimeMinutes, 0);
    return {
      daysWorked: new Set(shiftsDone.filter((r) => r.workedMinutes > 0).map((r) => r.date)).size, absences: list.filter((r) => r.kind === 'absence').length,
      lateArrivals: shiftsDone.filter((r) => r.lateMinutes > 0).length, workedMinutes: worked, overtimeMinutes: ot, payableMinutes: worked - rejectedOt,
    };
  }
  // What stops a period from being submitted: open check-ins, exceptions,
  // corrections and overtime still waiting.
  function blockers(list) {
    const out = [];
    for (const r of list) {
      if (r.status === 'Open') out.push(`${r.date}: still checked in`);
      if (r.status === 'Exception') out.push(`${r.date}: ${r.exception || 'exception'} (ask for a correction)`);
      if (r.overtimeStatus === 'Pending') out.push(`${r.date}: overtime waiting for approval`);
      if (corrections().some((c) => c.recordId === r.id && c.status === 'Pending')) out.push(`${r.date}: a correction is waiting`);
    }
    return out;
  }
  function submitTimesheet(act, input) {
    const { body, errors } = strictBody(input, ['assignmentId', 'from', 'to', 'note']);
    if (errors.length) return { status: 400, errors };
    const a = assignmentById(String(body.assignmentId || ''));
    const rt = rights(act, a);
    if (!a || !rt.see) return { status: 404, errors: ['assignment not found'] };
    if (!rt.own && !rt.supervise) return { status: 403, errors: ['only the worker, their supervisor or the staffing team submits timesheets'] };
    const from = String(body.from || '').trim();
    const to = String(body.to || '').trim();
    const errs = [];
    if (!validDate(from) || !validDate(to)) errs.push('from and to must be dates like 2026-11-02');
    else {
      if (to < from) errs.push('to is before from');
      if (daysBetween(from, to) > 30) errs.push('a timesheet covers at most 31 days');
      if (from < a.startsOn || (a.endsOn && to > a.endsOn)) errs.push(`the period must be inside the assignment (${a.startsOn} to ${a.endsOn || 'open-ended'})`);
      if (to >= localDate(iso(), zoneOf(a))) errs.push('submit finished days only (up to yesterday)');
    }
    if (errs.length) return { status: 400, errors: errs };
    const live = timesheets().filter((t) => t.assignmentId === a.id && t.status !== 'Returned');
    const same = live.find((t) => t.from === from && t.to === to);
    if (same) return { status: 200, timesheet: same, existed: true };
    if (live.some((t) => t.from <= to && t.to >= from)) return { status: 409, errors: ['part of this period is in another timesheet'] };
    const list = records().filter((r) => r.assignmentId === a.id && r.date >= from && r.date <= to);
    if (!list.length) return { status: 409, errors: ['no attendance in this period'] };
    const stop = blockers(list);
    if (stop.length) return { status: 409, errors: stop };
    const ts = saveSubmission('workforce-timesheets', {
      assignmentId: a.id, workerId: (workerOf(a) || {}).id || null, employerId: a.employerId, from, to, recordIds: list.map((r) => r.id), totals: totalsOf(list), status: 'Submitted',
      submittedBy: { kind: act.kind, id: act.id, name: act.name }, submittedAt: iso(), note: String(body.note || '').slice(0, 300), approvedBy: null, history: [{ at: iso(), by: act.name, text: 'Submitted' }],
    });
    const ids = new Set(ts.recordIds);
    const all = records();
    for (const r of all) if (ids.has(r.id)) r.timesheetId = ts.id;
    writeSubmissions('attendance-records', all);
    audit(act, 'timesheet-submitted', 'timesheet', ts.id, `${from} to ${to}: ${hours(ts.totals.workedMinutes)}`, a.employerId);
    const others = [...supervisorOf(a), ...teamFor(a.employerId)].filter((r) => `${r.kind === 'team' ? 't' : 'e'}:${r.userId}` !== act.id);
    tell('timesheet-waiting', `${ts.id}:submitted`, others, `Timesheet to approve: ${a.workerName}`, `${from} to ${to}, ${hours(ts.totals.workedMinutes)}`, { assignmentId: a.id, timesheetId: ts.id, link: '/admin/workforce/timesheets' });
    return { status: 201, timesheet: ts };
  }
  // The automatic invoice request for an approved timesheet; Finance issues it.
  const SYSTEM = { id: 'workforce', name: 'Approved timesheet', role: 'Staffing Manager', active: true };
  function draftFor(ts, a) {
    const p = placementById(a.placementId);
    if (!p || p.feeMode !== 'assignment' || !agency || !agency.createDraft) return { note: 'not billed per assignment' };
    if (a.rate.per === 'month') return { note: 'monthly rate: ask for the invoice from Staffing' };
    const qty = a.rate.per === 'day' ? String(ts.totals.daysWorked) : (ts.totals.payableMinutes / 60).toFixed(2);
    if (!(Number(qty) > 0)) return { note: 'nothing to bill' };
    const r = agency.createDraft(SYSTEM, p.id, { assignmentId: a.id, from: ts.from, to: ts.to, quantity: qty, note: `Timesheet ${ts.from} to ${ts.to}` });
    return r.errors ? { note: r.errors.join('; ') } : { draftId: r.draft.id };
  }
  function decideTimesheet(act, id, input, decision) {
    const { body, errors } = strictBody(input, ['note', 'reason']);
    if (errors.length) return { status: 400, errors };
    const ts = timesheets().find((x) => x.id === id);
    const a = ts && assignmentById(ts.assignmentId);
    if (!ts || !rights(act, a).see) return { status: 404, errors: ['timesheet not found'] };
    if (!rights(act, a).supervise) return { status: 403, errors: ['only the supervisor or the staffing team approves timesheets'] };
    const w = workerOf(a);
    // Nobody approves a timesheet they submitted, or their own work.
    if (ts.submittedBy.id === act.id || (w && act.kind === 'worker')) return { status: 403, errors: ['you submitted this timesheet: someone else approves it'] };
    if (ts.status !== 'Submitted') return ts.status === 'Approved' && decision === 'approve' ? { status: 200, timesheet: ts, existed: true } : { status: 409, errors: [`this timesheet is ${ts.status.toLowerCase()}`] };
    const list = records().filter((r) => ts.recordIds.includes(r.id));
    if (decision === 'approve') {
      const stop = blockers(list);
      if (stop.length) return { status: 409, errors: stop };
      const totals = totalsOf(list);
      let saved = update('workforce-timesheets', id, (x) => Object.assign(x, { status: 'Approved', totals, approvedBy: { kind: act.kind, id: act.id, name: act.name }, approvedAt: iso() }, { history: [...x.history, { at: iso(), by: act.name, text: 'Approved' }] }));
      const all = records();
      for (const r of all) if (ts.recordIds.includes(r.id)) { r.locked = true; r.history.push({ at: iso(), by: act.name, text: 'Locked: timesheet approved' }); }
      writeSubmissions('attendance-records', all);
      const d = draftFor(saved, a);
      saved = update('workforce-timesheets', id, (x) => Object.assign(x, { draftId: d.draftId || null, draftNote: d.note || '' }));
      audit(act, 'timesheet-approved', 'timesheet', id, `${ts.from} to ${ts.to}: ${hours(totals.workedMinutes)}${d.draftId ? ', invoice draft made' : ''}`, a.employerId);
      return { status: 200, timesheet: saved };
    }
    const reason = String(body.reason || body.note || '').trim().slice(0, 300);
    if (!reason) return { status: 400, errors: ['say what needs changing'] };
    const saved = update('workforce-timesheets', id, (x) => Object.assign(x, { status: 'Returned', returnedBy: { kind: act.kind, id: act.id, name: act.name }, returnReason: reason }, { history: [...x.history, { at: iso(), by: act.name, text: `Sent back: ${reason}` }] }));
    const all = records();
    for (const r of all) if (r.timesheetId === id) r.timesheetId = null;
    writeSubmissions('attendance-records', all);
    audit(act, 'timesheet-returned', 'timesheet', id, reason, a.employerId);
    tell('timesheet-returned', `${id}`, [...workerTo(w), ...supervisorOf(a)], 'Timesheet sent back', reason, { assignmentId: a.id, timesheetId: id });
    return { status: 200, timesheet: saved };
  }
  function timesheetJson(ts, act) {
    const a = assignmentById(ts.assignmentId) || {};
    const out = { id: ts.id, assignmentId: ts.assignmentId, worker: a.workerName, role: a.role, site: a.site, from: ts.from, to: ts.to, status: ts.status, totals: ts.totals, submittedBy: ts.submittedBy.name, mine: ts.submittedBy.id === act.id, submittedAt: ts.submittedAt, approvedBy: ts.approvedBy ? ts.approvedBy.name : null, approvedAt: ts.approvedAt || null, returnReason: ts.returnReason || '', history: ts.history };
    if (act.kind === 'team' && roles.can(act.user, 'money.view')) Object.assign(out, { draftId: ts.draftId || null, draftNote: ts.draftNote || '' });
    return out;
  }
  function listTimesheets(act, q = {}) {
    let list = timesheets();
    // Finance sees approved timesheets (for payroll and billing) and nothing else here.
    const payrollOnly = act.kind === 'team' && !roles.can(act.user, 'workforce.manage') && roles.can(act.user, 'workforce.payroll');
    if (payrollOnly) list = list.filter((t) => t.status === 'Approved');
    else { const ids = new Set(visibleAssignments(act).map((a) => a.id)); list = list.filter((t) => ids.has(t.assignmentId)); }
    if (q.status) list = list.filter((t) => t.status === q.status);
    if (q.assignmentId) list = list.filter((t) => t.assignmentId === q.assignmentId);
    return list.sort((x, y) => y.from.localeCompare(x.from));
  }
  // Payroll lines for approved timesheets: hours and pay at the agreed pay rate.
  function payroll(from, to) {
    return timesheets().filter((t) => t.status === 'Approved' && (!from || t.to >= from) && (!to || t.from <= to)).map((t) => {
      const a = assignmentById(t.assignmentId) || { rate: {} };
      const rate = a.rate || {};
      const qty = rate.per === 'day' ? t.totals.daysWorked * 100 : rate.per === 'hour' ? qtyFrom((t.totals.payableMinutes / 60).toFixed(2)) : null;
      return {
        timesheetId: t.id, worker: a.workerName, client: (clientById(t.employerId) || {}).company || '', role: a.role, site: a.site, from: t.from, to: t.to,
        daysWorked: t.totals.daysWorked, payableHours: (t.totals.payableMinutes / 60).toFixed(2), overtimeHours: (t.totals.overtimeMinutes / 60).toFixed(2), absences: t.totals.absences,
        payRatePaise: rate.payPaise ?? null, per: rate.per || '', payPaise: qty !== null && rate.payPaise !== null && rate.payPaise !== undefined ? timesQty(rate.payPaise, qty) : null, approvedBy: t.approvedBy ? t.approvedBy.name : '',
      };
    });
  }
  const csvCell = (v) => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

  // ---------- replacement requests ----------
  function requestReplacement(act, id, input) {
    const { body, errors } = strictBody(input, ['reason', 'from']);
    if (errors.length) return { status: 400, errors };
    const a = assignmentById(id);
    if (!a || !rights(act, a).see) return { status: 404, errors: ['assignment not found'] };
    if (!rights(act, a).supervise) return { status: 403, errors: ['only the client\'s supervisors and managers or the staffing team ask for replacements'] };
    if (!['Scheduled', 'Active'].includes(a.status)) return { status: 409, errors: [`the assignment is ${a.status.toLowerCase()}`] };
    const reason = String(body.reason || '').trim().slice(0, 500);
    const from = String(body.from || '').trim();
    if (!reason) return { status: 400, errors: ['say why a replacement is needed'] };
    if (from && !validDate(from)) return { status: 400, errors: ['from must be a date like 2026-11-02'] };
    if (replacements().some((r) => r.assignmentId === a.id && r.status === 'Open')) return { status: 409, errors: ['a replacement is already requested for this assignment'] };
    const r = saveSubmission('replacement-requests', { assignmentId: a.id, employerId: a.employerId, reason, from: from || null, status: 'Open', requestedBy: act.id, requestedByName: act.name, requestedByKind: act.kind });
    audit(act, 'replacement-requested', 'assignment', a.id, reason, a.employerId);
    tell('replacement', r.id, teamFor(a.employerId), `Replacement requested: ${a.workerName}`, reason, { assignmentId: a.id, link: '/admin/workforce' });
    return { status: 201, replacement: r };
  }
  function resolveReplacement(act, id, input) {
    const { body, errors } = strictBody(input, ['status', 'note']);
    if (errors.length) return { status: 400, errors };
    const r = replacements().find((x) => x.id === id);
    const a = r && assignmentById(r.assignmentId);
    if (!r || act.kind !== 'team' || !rights(act, a).supervise) return { status: r ? 403 : 404, errors: [r ? 'only the staffing team resolves replacement requests' : 'request not found'] };
    if (r.status !== 'Open') return { status: 409, errors: [`already ${r.status.toLowerCase()}`] };
    if (!['Arranged', 'Declined'].includes(String(body.status))) return { status: 400, errors: ['status must be Arranged or Declined'] };
    const saved = update('replacement-requests', id, (x) => Object.assign(x, { status: String(body.status), note: String(body.note || '').slice(0, 300), resolvedBy: act.name, resolvedAt: iso() }));
    audit(act, `replacement-${saved.status.toLowerCase()}`, 'assignment', a.id, saved.note, a.employerId);
    return { status: 200, replacement: saved };
  }

  // ---------- client sites ----------
  function setSites(act, employerId, input) {
    const c = clientById(employerId);
    if (!c) return { status: 404, errors: ['client not found'] };
    if (act.kind !== 'team' || !roles.can(act.user, 'workforce.manage') || !teamScope(act.user, employerId)) return { status: 403, errors: ['only the staffing team or this client\'s account manager changes its sites'] };
    const list = input && Array.isArray(input.sites) ? input.sites : null;
    if (!list || list.length > 30) return { status: 400, errors: ['sites must be a list of up to 30 sites'] };
    const errors = [];
    const seen = new Set();
    const sites = list.map((s, i) => {
      const name = String((s && s.name) || '').trim().replace(/\s+/g, ' ');
      const address = String((s && s.address) || '').trim().slice(0, 200);
      const timeZone = String((s && s.timeZone) || DEFAULT_ZONE).trim();
      if (!name || name.length > 80) errors.push(`site ${i + 1}: a name of 1–80 characters is needed`);
      if (seen.has(name.toLowerCase())) errors.push(`site ${i + 1}: "${name}" is listed twice`);
      seen.add(name.toLowerCase());
      try { new Intl.DateTimeFormat('en', { timeZone }); } catch (e) { errors.push(`site ${i + 1}: timeZone must be a time zone like Asia/Kolkata`); }
      return { name, address, timeZone };
    });
    if (errors.length) return { status: 400, errors };
    const all = clients.read();
    const rec = all.find((x) => x.id === employerId);
    rec.sites = sites;
    clients.write(all);
    audit(act, 'sites-changed', 'client', employerId, sites.map((s) => s.name).join(', '), employerId);
    return { status: 200, sites };
  }
  function setRequirements(act, input) {
    const body = input && typeof input === 'object' ? input : {};
    const employerId = String(body.clientId || '') || null;
    const role = String(body.role || '').trim().slice(0, 80);
    if (act.kind !== 'team' || !roles.can(act.user, 'workforce.manage')) return { status: 403, errors: ['only the staffing team sets joining requirements'] };
    if (employerId && !clientById(employerId)) return { status: 400, errors: ['clientId must be a client'] };
    if (employerId ? !teamScope(act.user, employerId) : act.user.role === 'Account Manager') return { status: 403, errors: ['Account Managers set requirements for their own clients'] };
    if (role && !employerId) return { status: 400, errors: ['a role-specific list needs a client'] };
    const { errors, items } = parseItems(body.items);
    if (errors.length) return { status: 400, errors };
    const list = requirementSets();
    const same = list.find((s) => (s.employerId || null) === employerId && (s.role || '').toLowerCase() === role.toLowerCase());
    if (same) { Object.assign(same, { items, updatedAt: iso(), updatedBy: act.name }); writeSubmissions('onboarding-requirements', list); } else saveSubmission('onboarding-requirements', { employerId, role, items, updatedBy: act.name });
    audit(act, 'requirements-changed', 'requirements', employerId || 'default', `${role || 'all roles'}: ${items.map((i) => i.label).join(', ')}`, employerId || '');
    return { status: 200, requirements: { clientId: employerId, role, items } };
  }

  // ---------- reminders ----------
  // Runs every hour (WORKFORCE_SCAN_MS): marks missing check-outs as
  // exceptions and queues reminders. Each reminder has a stable key, so
  // running the scan again never sends it twice.
  function scan(nowMs = Date.now()) {
    const R = rules();
    const out = { exceptions: 0, reminders: 0, expired: 0 };
    const as = new Map(assignments().map((a) => [a.id, a]));
    // Missing check-outs: open past the shift's end + grace, or past the longest shift.
    const list = records();
    let changed = false;
    for (const r of list) {
      if (r.status !== 'Open') continue;
      const a = as.get(r.assignmentId);
      if (!a) continue;
      const plan = planFor(a, r.date);
      const due = Math.min(plan ? Date.parse(plan.endAt) + R.missingCheckoutHours * 3600000 : Infinity, Date.parse(r.checkInAt) + R.maxShiftHours * 3600000);
      if (nowMs < due) continue;
      Object.assign(r, { status: 'Exception', exception: 'Missing check-out', workedMinutes: null, updatedAt: iso(nowMs) });
      r.history.push({ at: iso(nowMs), by: 'Hireriv', text: 'No check-out: marked as an exception (no hours counted until corrected)' });
      changed = true;
      out.exceptions++;
      tell('missing-out', r.id, [...workerTo(workerOf(a)), ...supervisorOf(a)], 'Missing check-out', `${a.workerName} on ${r.date}: ask for a correction with the real time.`, { assignmentId: a.id, recordId: r.id });
    }
    if (changed) writeSubmissions('attendance-records', list);
    const recs = records();
    for (const a of as.values()) {
      if (a.status !== 'Active') continue;
      const w = workerOf(a);
      if (!w || w.status !== 'Joined') continue;
      const tz = zoneOf(a);
      const today = localDate(iso(nowMs), tz);
      // Missing check-ins: the shift started more than grace + 30 minutes ago.
      const plan = inAssignment(a, today) && planFor(a, today);
      if (plan && nowMs > Date.parse(plan.startAt) + ((a.graceMinutes ?? 10) + 30) * 60000 && nowMs < Date.parse(plan.endAt) && !recs.some((r) => r.assignmentId === a.id && r.date === today)) {
        tell('missing-in', `${a.id}:${today}`, [...workerTo(w), ...supervisorOf(a)], 'No check-in yet', `${a.workerName}'s shift started at ${plan.start}.`, { assignmentId: a.id, when: `${today} ${plan.start}` });
        out.reminders++;
      }
      // Assignments ending soon.
      if (a.endsOn && daysBetween(today, a.endsOn) >= 0 && daysBetween(today, a.endsOn) <= R.assignmentEndingDays) {
        tell('assignment-ending', `${a.id}:${a.endsOn}`, [...supervisorOf(a), ...teamFor(a.employerId)], `Assignment ends ${a.endsOn}`, `${a.workerName} as ${a.role}`, { assignmentId: a.id, link: '/admin/staffing' });
        out.reminders++;
      }
    }
    // Shifts in the next 24 hours.
    for (const s of shifts()) {
      if (s.status !== 'Planned' || Date.parse(s.startAt) < nowMs || Date.parse(s.startAt) > nowMs + DAY) continue;
      const a = as.get(s.assignmentId);
      const w = a && a.status !== 'Cancelled' && workerOf(a);
      if (!w) continue;
      tell('shift', `${s.id}:${s.startAt}`, workerTo(w), `Next shift: ${s.date} ${s.start}–${s.end}`, `${a.role}${a.site ? ` at ${a.site}` : ''}`, { assignmentId: a.id, when: `${s.date} ${s.start}–${s.end}` });
      out.reminders++;
    }
    // Joining steps still open.
    for (const w of workers()) {
      if (w.status !== 'Onboarding') continue;
      const days = Math.floor((nowMs - Date.parse(w.createdAt)) / DAY);
      if (days < R.onboardingReminderDays) continue;
      tell('onboarding', `${w.id}:reminder:${Math.floor(days / R.onboardingReminderDays)}`, workerTo(w), 'Finish joining', 'Some joining steps are still open.', { workerId: w.id });
      out.reminders++;
    }
    // Timesheets waiting too long.
    for (const t of timesheets()) {
      if (t.status !== 'Submitted' || nowMs - Date.parse(t.submittedAt) < R.timesheetReminderDays * DAY) continue;
      const a = as.get(t.assignmentId);
      if (!a) continue;
      tell('timesheet-waiting', `${t.id}:reminder`, [...supervisorOf(a), ...teamFor(a.employerId)].filter((r) => `${r.kind === 'team' ? 't' : 'e'}:${r.userId}` !== t.submittedBy.id), `Timesheet still waiting: ${a.workerName}`, `${t.from} to ${t.to}`, { assignmentId: a.id, timesheetId: t.id, link: '/admin/workforce/timesheets' });
      out.reminders++;
    }
    // Documents expiring soon, and expired ones.
    const today = localDate(iso(nowMs), DEFAULT_ZONE);
    for (const d of documents()) {
      if (!d.expiresOn || ['Replaced', 'Expired', 'Rejected'].includes(d.status)) continue;
      const w = workers().find((x) => x.id === d.workerId);
      if (!w || w.status === 'Left') continue;
      if (d.expiresOn <= today) {
        update('worker-documents', d.id, (x) => { x.status = 'Expired'; x.history.push({ at: iso(nowMs), by: 'Hireriv', text: 'Expired' }); });
        const t = w.tasks.find((x) => x.documentId === d.id);
        if (t) { const before = t.status; Object.assign(t, { status: 'Expired', updatedAt: iso(nowMs) }); w.history.push({ at: iso(nowMs), by: 'Hireriv', text: `${t.label}: ${before} → Expired` }); refreshStatus(w); writeWorker(w); }
        out.expired++;
      } else if (daysBetween(today, d.expiresOn) <= R.expiryWarnDays) {
        tell('document-expiring', `${d.id}:${d.expiresOn}`, [...workerTo(w), ...teamFor(w.employerId)], `Document expires ${d.expiresOn}`, `${w.name}: ${d.label}`, { workerId: w.id, link: `/admin/workforce/workers/${w.id}` });
        out.reminders++;
      }
    }
    // Client contracts ending soon.
    for (const c of readSubmissions('client-contracts')) {
      if (c.status !== 'Active' || !c.endsOn || daysBetween(today, c.endsOn) < 0 || daysBetween(today, c.endsOn) > R.contractEndingDays) continue;
      const client = clientById(c.employerId);
      const to = client && client.accountManagerId ? [{ kind: 'team', userId: client.accountManagerId }] : teamFor(c.employerId);
      tell('contract-ending', `${c.id}:${c.endsOn}`, to, `Contract ends ${c.endsOn}`, `${(client || {}).company || 'A client'}: ${c.reference}`, { link: `/admin/clients/${c.employerId}` });
      out.reminders++;
    }
    return out;
  }
  // Assignment changes made in agency.js reach the worker and supervisor.
  if (hooks) hooks.assignmentChanged = (saved, before) => {
    const changed = ['startsOn', 'endsOn', 'site', 'shiftStart', 'shiftEnd', 'status', 'supervisorId'].some((k) => saved[k] !== before[k]);
    if (!changed) return;
    tell('assignment-changed', `${saved.id}:${saved.updatedAt}`, [...workerTo(workerOf(saved)), ...supervisorOf(saved)], `Assignment changed: ${saved.role}`, `${saved.site || ''} ${saved.startsOn} to ${saved.endsOn || 'open-ended'} (${saved.status})`.trim(), { assignmentId: saved.id });
  };

  // ---------- JSON API ----------
  const apiLimit = limit('workforce-api', 300, 60 * 1000);
  const clockLimit = limit('workforce-clock', 30, 60 * 1000);
  const BACK_RE = /^\/(admin\/workforce|employer\/workforce|account\/work)(\/[\w-]+)*\/?(\?[\w=&%.-]*)?$/;
  // Plain HTML forms post to the same endpoints with a `back` page; JSON
  // callers get JSON. Either way the same checks run.
  const formBack = (req) => (req.body && typeof req.body.back === 'string' && BACK_RE.test(req.body.back) && !req.is('application/json') ? req.body.back : '');
  // Someone must be signed in (team, client employer or worker); what they
  // may do with each record is checked by rights() in the handler.
  function anyAccount(req, res, next) {
    req.act = actorOf(req);
    res.set('Cache-Control', 'no-store');
    if (req.act) return next();
    return formBack(req) ? res.redirect(303, '/') : res.status(401).json({ ok: false, errors: ['sign in first'] });
  }
  async function api(req, res, handler, okMsg = 'Saved.') {
    const back = formBack(req);
    const input = { ...(req.body || {}) };
    delete input.back;
    delete input.as;
    let r;
    try { r = await handler(req.act, req, input); } catch (e) { console.error('Workforce:', e); r = { status: 500, errors: ['something went wrong'] }; }
    if (back) return res.redirect(303, `${back}${back.includes('?') ? '&' : '?'}msg=${encodeURIComponent(r.errors ? r.errors.join(' ') : typeof okMsg === 'function' ? okMsg(r) : okMsg)}`);
    if (r.errors) return res.status(r.status).json({ ok: false, errors: r.errors });
    const { status, existed, ...rest } = r;
    res.status(status).json({ ok: true, ...(existed ? { existed: true } : {}), ...rest });
  }
  app.get('/api/staffing/workers', anyAccount, apiLimit, (req, res) => api(req, res, (act) => {
    if (act.kind === 'team' && !roles.can(act.user, 'workforce.view')) return { status: 403, errors: ['your role does not allow that'] };
    const list = workers().filter((w) => workerRights(act, w).see);
    return { status: 200, workers: list.map((w) => workerJson(w, act)) };
  }));
  app.post('/api/staffing/workers', anyAccount, sameOrigin, apiLimit, (req, res) => api(req, res, (act, req, input) => {
    const extra = Object.keys(input).filter((k) => k !== 'placementId');
    if (extra.length) return { status: 400, errors: extra.map((k) => `${k} is not a field you can set`) };
    const r = createWorker(act, input.placementId);
    return r.worker ? { ...r, worker: workerJson(r.worker, act) } : r;
  }, 'Worker added: onboarding started.'));
  app.get('/api/staffing/workers/:id', anyAccount, apiLimit, (req, res) => api(req, res, (act, req) => {
    const w = workers().find((x) => x.id === req.params.id);
    if (!w || !workerRights(act, w).see) return { status: 404, errors: ['worker not found'] };
    return { status: 200, worker: workerJson(w, act) };
  }));
  app.get('/api/staffing/workers/:id/onboarding', anyAccount, apiLimit, (req, res) => api(req, res, (act, req) => {
    const w = workers().find((x) => x.id === req.params.id);
    if (!w || !workerRights(act, w).see) return { status: 404, errors: ['worker not found'] };
    const j = workerJson(w, act);
    return { status: 200, onboarding: { status: j.status, progress: j.progress, ...(j.tasks ? { tasks: j.tasks } : {}) } };
  }));
  app.post('/api/staffing/workers/:id/onboarding', anyAccount, sameOrigin, apiLimit, (req, res) => api(req, res, (act, req, input) => {
    const r = onboardingAction(act, req.params.id, input);
    return r.worker ? { ...r, worker: workerJson(r.worker, act) } : r;
  }));
  app.post('/api/staffing/workers/:id/documents', anyAccount, sameOrigin, apiLimit, (req, res, next) => docUpload.single('file')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'documents must be 5 MB or smaller' : err.message;
      const back = req.body && BACK_RE.test(String(req.body.back || '')) ? req.body.back : '';
      return back ? res.redirect(303, `${back}?msg=${encodeURIComponent(msg)}`) : res.status(400).json({ ok: false, errors: [msg] });
    }
    next();
  }), (req, res) => api(req, res, async (act, req, input) => {
    const r = await addDocument(act, req.params.id, req.file, input);
    return r.document ? { status: r.status, document: { id: r.document.id, task: r.document.taskKey, name: r.document.originalName, size: r.document.size, sha256: r.document.sha256, expiresOn: r.document.expiresOn, status: r.document.status } } : r;
  }, 'Uploaded. The team will check it.'));

  app.get('/api/staffing/assignments/:id/workforce', anyAccount, apiLimit, (req, res) => api(req, res, (act, req) => {
    const a = assignmentById(req.params.id);
    if (!a || !rights(act, a).see) return { status: 404, errors: ['assignment not found'] };
    return { status: 200, assignment: { id: a.id, role: a.role, site: a.site, startsOn: a.startsOn, endsOn: a.endsOn, status: a.status, shiftStart: a.shiftStart || '', shiftEnd: a.shiftEnd || '', breakMinutes: a.breakMinutes || 0, graceMinutes: a.graceMinutes ?? 10, timeZone: zoneOf(a), supervisorId: a.supervisorId || null } };
  }));
  app.post('/api/staffing/assignments/:id/replacement', anyAccount, sameOrigin, apiLimit, (req, res) => api(req, res, (act, req, input) => requestReplacement(act, req.params.id, input), 'Replacement requested: the staffing team will be in touch.'));
  app.post('/api/staffing/replacements/:id', anyAccount, sameOrigin, apiLimit, (req, res) => api(req, res, (act, req, input) => resolveReplacement(act, req.params.id, input)));
  app.put('/api/staffing/clients/:id/sites', anyAccount, sameOrigin, apiLimit, (req, res) => api(req, res, (act, req, input) => setSites(act, req.params.id, input)));
  app.get('/api/staffing/requirements', anyAccount, apiLimit, (req, res) => api(req, res, (act) => {
    if (act.kind !== 'team' || !roles.can(act.user, 'workforce.view')) return { status: 403, errors: ['your role does not allow that'] };
    return { status: 200, default: DEFAULT_ITEMS, requirements: requirementSets().filter((s) => !s.employerId || teamScope(act.user, s.employerId)).map((s) => ({ clientId: s.employerId, role: s.role, items: s.items, updatedAt: s.updatedAt || s.createdAt })) };
  }));
  app.put('/api/staffing/requirements', anyAccount, sameOrigin, apiLimit, (req, res) => api(req, res, (act, req, input) => setRequirements(act, input)));

  app.get('/api/staffing/shifts', anyAccount, apiLimit, (req, res) => api(req, res, (act, req) => {
    const ids = new Set(visibleAssignments(act).map((a) => a.id));
    const q = req.query;
    return { status: 200, shifts: shifts().filter((s) => ids.has(s.assignmentId) && (!q.assignmentId || s.assignmentId === q.assignmentId) && (!q.from || s.date >= q.from) && (!q.to || s.date <= q.to)).sort((x, y) => x.startAt.localeCompare(y.startAt)).slice(0, 500).map(shiftJson) };
  }));
  app.post('/api/staffing/shifts', anyAccount, sameOrigin, apiLimit, (req, res) => api(req, res, (act, req, input) => { const r = planShifts(act, input); return r.shifts ? { ...r, shifts: r.shifts.map(shiftJson) } : r; }, (r) => `${r.shifts.length} shift(s) planned${r.skipped.length ? `, ${r.skipped.length} skipped` : ''}.`));
  app.post('/api/staffing/shifts/:id/cancel', anyAccount, sameOrigin, apiLimit, (req, res) => api(req, res, (act, req, input) => cancelShift(act, req.params.id, input.reason), 'Shift cancelled.'));

  const withRecord = (r) => (r.record ? { ...r, record: recordJson(r.record, assignmentById(r.record.assignmentId)) } : r);
  app.post('/api/staffing/attendance/check-in', anyAccount, sameOrigin, clockLimit, (req, res) => api(req, res, (act, req, input) => withRecord(checkIn(act, input, req.get('Idempotency-Key'))), 'Checked in.'));
  app.post('/api/staffing/attendance/check-out', anyAccount, sameOrigin, clockLimit, (req, res) => api(req, res, (act, req, input) => withRecord(checkOut(act, input)), 'Checked out.'));
  app.post('/api/staffing/attendance/:id/breaks', anyAccount, sameOrigin, clockLimit, (req, res) => api(req, res, (act, req, input) => withRecord(breakAction(act, req.params.id, input)), 'Break recorded.'));
  app.post('/api/staffing/attendance/absences', anyAccount, sameOrigin, apiLimit, (req, res) => api(req, res, (act, req, input) => withRecord(recordAbsence(act, input)), 'Absence recorded.'));
  app.get('/api/staffing/attendance', anyAccount, apiLimit, (req, res) => api(req, res, (act, req) => {
    if (act.kind === 'team' && !roles.can(act.user, 'workforce.manage')) return { status: 403, errors: ['your role does not allow that'] };
    return { status: 200, attendance: listAttendance(act, req.query) };
  }));
  app.post('/api/staffing/attendance/:id/overtime', anyAccount, sameOrigin, apiLimit, (req, res) => api(req, res, (act, req, input) => withRecord(decideOvertime(act, req.params.id, input)), 'Overtime decided.'));
  app.post('/api/staffing/attendance/:id/corrections', anyAccount, sameOrigin, apiLimit, (req, res) => api(req, res, (act, req, input) => requestCorrection(act, req.params.id, input), 'Correction requested: someone else approves it.'));
  app.get('/api/staffing/attendance/corrections', anyAccount, apiLimit, (req, res) => api(req, res, (act) => {
    const ids = new Set(visibleAssignments(act).map((a) => a.id));
    if (act.kind === 'team' && !roles.can(act.user, 'workforce.manage')) return { status: 403, errors: ['your role does not allow that'] };
    return { status: 200, corrections: corrections().filter((c) => ids.has(c.assignmentId)).map((c) => ({ id: c.id, recordId: c.recordId, assignmentId: c.assignmentId, proposed: c.proposed, before: c.before, reason: c.reason, status: c.status, requestedBy: c.requestedByName, decidedBy: c.decidedByName || null, note: c.note || '', createdAt: c.createdAt })) };
  }));
  app.post('/api/staffing/attendance/corrections/:id/approve', anyAccount, sameOrigin, apiLimit, (req, res) => api(req, res, (act, req, input) => decideCorrection(act, req.params.id, { ...input, decision: 'approve' }), 'Correction approved.'));
  app.post('/api/staffing/attendance/corrections/:id/reject', anyAccount, sameOrigin, apiLimit, (req, res) => api(req, res, (act, req, input) => decideCorrection(act, req.params.id, { ...input, decision: 'reject' }), 'Correction rejected.'));

  app.get('/api/staffing/timesheets', anyAccount, apiLimit, (req, res) => api(req, res, (act, req) => {
    if (act.kind === 'team' && !roles.can(act.user, 'workforce.manage') && !roles.can(act.user, 'workforce.payroll')) return { status: 403, errors: ['your role does not allow that'] };
    return { status: 200, timesheets: listTimesheets(act, req.query).map((t) => timesheetJson(t, act)) };
  }));
  app.post('/api/staffing/timesheets', anyAccount, sameOrigin, apiLimit, (req, res) => api(req, res, (act, req, input) => { const r = submitTimesheet(act, input); return r.timesheet ? { ...r, timesheet: timesheetJson(r.timesheet, act) } : r; }, 'Timesheet submitted for approval.'));
  app.post('/api/staffing/timesheets/:id/approve', anyAccount, sameOrigin, apiLimit, (req, res) => api(req, res, (act, req, input) => { const r = decideTimesheet(act, req.params.id, input, 'approve'); return r.timesheet ? { ...r, timesheet: timesheetJson(r.timesheet, act) } : r; }, 'Timesheet approved.'));
  app.post('/api/staffing/timesheets/:id/reject', anyAccount, sameOrigin, apiLimit, (req, res) => api(req, res, (act, req, input) => { const r = decideTimesheet(act, req.params.id, input, 'reject'); return r.timesheet ? { ...r, timesheet: timesheetJson(r.timesheet, act) } : r; }, 'Timesheet sent back.'));

  // ---------- pages ----------
  const teamAct = (req) => ({ kind: 'team', id: `t:${req.admin.id}`, userId: req.admin.id, name: req.admin.name, user: req.admin });
  const need = (action) => (req, res, next) => (roles.can(req.admin, action) ? next() : res.status(403).render('thanks', { title: 'Not part of your role', page: '', ok: false, message: 'Your role does not include this. Ask an Admin on your team if you need it.', noindex: true }));
  const helpers = { showAt, localTime, hours, zoneOf, TASK_KINDS, ABSENCE_REASONS, WORKER_STATUSES, signed: (u) => downloadLinks.signed(u) };
  const SECTIONS = ['workers', 'onboarding', 'shifts', 'attendance', 'timesheets', 'rules', 'payroll', 'activity'];
  function adminPage(req, res, section) {
    const act = teamAct(req);
    const u = req.admin;
    const tz = DEFAULT_ZONE;
    const visible = workers().filter((w) => workerRights(act, w).see);
    const as = visibleAssignments(act);
    const today = localDate(iso(), tz);
    const placements = billing.read().filter((p) => p.type !== 'Permanent' && p.feeMode === 'assignment' && ['Awaiting joining', 'Joined'].includes(p.status) && !workers().some((w) => w.placementId === p.id) && teamScope(u, p.employerId));
    const data = {
      section, act, workers: visible.map((w) => workerJson(w, act)), placements, today,
      assignments: as.map((a) => ({ ...a, worker: workerOf(a), plan: planFor(a, today), open: records().find((r) => r.assignmentId === a.id && r.status === 'Open') })),
      shifts: section === 'shifts' ? shifts().filter((s) => as.some((a) => a.id === s.assignmentId) && s.date >= addDays(today, -7)).sort((x, y) => x.startAt.localeCompare(y.startAt)).slice(0, 300) : [],
      attendance: section === 'attendance' && roles.can(u, 'workforce.manage') ? listAttendance(act, { from: String(req.query.from || addDays(today, -14)), to: String(req.query.to || today), status: String(req.query.status || '') }) : [],
      corrections: roles.can(u, 'workforce.manage') ? corrections().filter((c) => c.status === 'Pending' && as.some((a) => a.id === c.assignmentId)) : [],
      timesheets: ['timesheets', 'payroll'].includes(section) && (roles.can(u, 'workforce.manage') || roles.can(u, 'workforce.payroll')) ? listTimesheets(act, { status: String(req.query.status || '') }).slice(0, 200).map((t) => timesheetJson(t, act)) : [],
      weekly: section === 'timesheets' && roles.can(u, 'workforce.manage') ? weekly(act, today) : [],
      payroll: section === 'payroll' && roles.can(u, 'workforce.payroll') ? payroll(String(req.query.from || ''), String(req.query.to || '')) : [],
      requirements: requirementSets(), defaults: DEFAULT_ITEMS, rules: rules(), ruleLimits: RULE_LIMITS,
      replacements: replacements().filter((r) => r.status === 'Open' && as.some((a) => a.id === r.assignmentId)),
      activity: section === 'activity' && roles.can(u, 'audit.view') ? readSubmissions('workforce-audit').slice(0, 200) : [],
      clientsList: clients.read().filter((c) => teamScope(u, c.id)),
      assignmentById, clientById,
    };
    res.render('admin-workforce', { title: 'Workforce', page: 'admin', noindex: true, errors: [], msg: String(req.query.msg || ''), can: (a) => roles.can(u, a), roleInfo: roles.ROLE_INFO, tab: 'workforce', ...helpers, ...data });
  }
  // Hours by worker and week, from attendance (approved or not).
  function weekly(act, today) {
    const as = visibleAssignments(act);
    const since = mondayOf(addDays(today, -27));
    const out = [];
    for (const a of as) {
      const list = records().filter((r) => r.assignmentId === a.id && r.date >= since);
      const weeks = [...new Set(list.map((r) => mondayOf(r.date)))].sort().reverse();
      for (const wk of weeks) { const inWeek = list.filter((r) => mondayOf(r.date) === wk); out.push({ worker: a.workerName, role: a.role, site: a.site, week: wk, ...totalsOf(inWeek), exceptions: inWeek.filter((r) => r.status === 'Exception').length, pendingOvertime: inWeek.filter((r) => r.overtimeStatus === 'Pending').length }); }
    }
    return out;
  }
  app.get('/admin/workforce', adminAuth, need('workforce.view'), (req, res) => adminPage(req, res, 'workers'));
  app.get('/admin/workforce/payroll', adminAuth, need('workforce.payroll'), (req, res) => adminPage(req, res, 'payroll'));
  app.get('/admin/workforce/payroll.csv', adminAuth, need('workforce.payroll'), (req, res) => {
    const rows = payroll(String(req.query.from || ''), String(req.query.to || ''));
    const head = ['Worker', 'Client', 'Role', 'Site', 'From', 'To', 'Days worked', 'Payable hours', 'Overtime hours (approved)', 'Absences', 'Pay rate (INR)', 'Per', 'Pay (INR)', 'Approved by'];
    const lines = rows.map((r) => [r.worker, r.client, r.role, r.site, r.from, r.to, r.daysWorked, r.payableHours, r.overtimeHours, r.absences, r.payRatePaise === null ? '' : (r.payRatePaise / 100).toFixed(2), r.per, r.payPaise === null ? '' : (r.payPaise / 100).toFixed(2), r.approvedBy]);
    audit(teamAct(req), 'payroll-exported', 'payroll', '-', `${rows.length} timesheet(s)`);
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="hireriv-payroll.csv"', 'Cache-Control': 'no-store' });
    res.send(`﻿${[head, ...lines].map((l) => l.map(csvCell).join(',')).join('\r\n')}\r\n`);
  });
  app.get('/admin/workforce/:section', adminAuth, need('workforce.view'), (req, res, next) => {
    const s = req.params.section;
    if (!SECTIONS.includes(s) || s === 'payroll') return next();
    if (['shifts', 'attendance', 'timesheets', 'rules'].includes(s) && !roles.can(req.admin, 'workforce.manage')) return need('workforce.manage')(req, res, next);
    if (s === 'activity' && !roles.can(req.admin, 'audit.view')) return need('audit.view')(req, res, next);
    adminPage(req, res, s);
  });
  app.get('/admin/workforce/workers/:id', adminAuth, need('workforce.view'), (req, res, next) => {
    const act = teamAct(req);
    const w = workers().find((x) => x.id === req.params.id);
    if (!w || !workerRights(act, w).see) return next();
    res.render('admin-worker', { title: `${w.name} · Workforce`, page: 'admin', noindex: true, errors: [], msg: String(req.query.msg || ''), can: (a) => roles.can(req.admin, a), tab: 'workforce', w: workerJson(w, act), rights: workerRights(act, w), ...helpers });
  });
  app.get('/admin/workforce/documents/:id/file', adminAuth, need('workforce.documents'), (req, res) => sendDocument(teamAct(req), req, res, '/admin/workforce'));
  app.post('/admin/workforce/rules', adminAuth, sameOrigin, (req, res) => {
    if (req.admin.role !== 'Admin') return res.status(403).render('thanks', { title: 'Not part of your role', page: '', ok: false, message: 'Only an Admin changes the attendance rules.', noindex: true });
    const next = {};
    const errors = [];
    for (const k of Object.keys(RULE_DEFAULTS)) {
      const v = String(req.body[k] ?? '').trim();
      if (!/^\d{1,4}$/.test(v) || Number(v) > RULE_LIMITS[k] || Number(v) < (RULE_MIN[k] || 0)) errors.push(`${k} must be a whole number from ${RULE_MIN[k] || 0} to ${RULE_LIMITS[k]}`);
      else next[k] = Number(v);
    }
    if (errors.length) return res.redirect(303, `/admin/workforce/rules?msg=${encodeURIComponent(errors.join(' '))}`);
    site.workforce = next;
    saveSite();
    audit(teamAct(req), 'rules-changed', 'rules', '-', Object.entries(next).map(([k, v]) => `${k}=${v}`).join(', '));
    res.redirect(303, '/admin/workforce/rules?msg=Attendance%20rules%20saved.');
  });
  // Runs the hourly checks now (missing check-outs, reminders, expiries).
  app.post('/admin/workforce/scan', adminAuth, sameOrigin, (req, res) => {
    if (!roles.can(req.admin, 'workforce.manage')) return need('workforce.manage')(req, res);
    const r = scan();
    res.redirect(303, `/admin/workforce/attendance?msg=${encodeURIComponent(`Checked: ${r.exceptions} missing check-out(s), ${r.reminders} reminder(s), ${r.expired} expired document(s).`)}`);
  });
  // Short links from the planned routes.
  app.get('/staffing/workers', (req, res) => res.redirect('/admin/workforce'));
  app.get('/staffing/onboarding', (req, res) => res.redirect('/admin/workforce/onboarding'));
  app.get('/staffing/shifts', (req, res) => res.redirect('/admin/workforce/shifts'));
  app.get('/staffing/attendance', (req, res) => res.redirect('/admin/workforce/attendance'));
  app.get('/staffing/timesheets', (req, res) => res.redirect('/admin/workforce/timesheets'));
  app.get('/worker/dashboard', (req, res) => res.redirect('/account/work'));
  app.get('/client/workforce', (req, res) => res.redirect('/employer/workforce'));

  // The client's people: workers on their assignments (supervisors: only theirs).
  app.get('/employer/workforce', requireEmployer, (req, res) => {
    if (!employerCan(req.member, 'workforce.view')) return clients.forbid(req, res);
    const act = { kind: 'employer', id: `e:${req.employerUser.id}`, userId: req.employerUser.id, name: req.employerUser.name, member: req.member, employer: req.employer };
    const as = visibleAssignments(act).filter((a) => ['Scheduled', 'Active'].includes(a.status) || records().some((r) => r.assignmentId === a.id && !r.locked));
    const ids = new Set(as.map((a) => a.id));
    const rows = as.map((a) => {
      const today = localDate(iso(), zoneOf(a));
      return { a, w: workerOf(a), today, plan: planFor(a, today), open: records().find((r) => r.assignmentId === a.id && r.status === 'Open'), canSupervise: rights(act, a).supervise };
    });
    res.render('employer-workforce', {
      title: `${req.employer.company} · Workforce`, page: 'employer', noindex: true, tab: 'workforce', errors: [], msg: String(req.query.msg || ''), rows, ...helpers,
      attendance: listAttendance(act, { from: addDays(localDate(iso(), DEFAULT_ZONE), -14) }),
      corrections: corrections().filter((c) => c.status === 'Pending' && ids.has(c.assignmentId)),
      timesheets: listTimesheets(act).slice(0, 50).map((t) => timesheetJson(t, act)), me: act.id, assignmentById,
    });
  });

  // The worker's own page: joining steps, assignments, today's shift, attendance and timesheets.
  app.get('/account/work', requireCandidate, (req, res) => {
    const act = { kind: 'worker', id: `c:${req.candidateEmail}`, email: req.candidateEmail, name: req.candidateEmail };
    const mine = workers().filter((w) => w.email === req.candidateEmail).map((w) => workerJson(w, act));
    const as = visibleAssignments(act);
    const rows = as.map((a) => { const today = localDate(iso(), zoneOf(a)); return { a, today, plan: planFor(a, today), open: records().find((r) => r.assignmentId === a.id && r.status === 'Open'), next: shifts().filter((s) => s.assignmentId === a.id && s.status === 'Planned' && s.endAt > iso()).sort((x, y) => x.startAt.localeCompare(y.startAt)).slice(0, 7) }; });
    res.set('Cache-Control', 'no-store');
    res.render('account-work', {
      title: 'My work', page: 'account', noindex: true, errors: [], msg: String(req.query.msg || ''), email: req.candidateEmail, tab: 'work', mine, rows, ...helpers,
      attendance: listAttendance(act, { from: addDays(localDate(iso(), DEFAULT_ZONE), -31) }), timesheets: listTimesheets(act).slice(0, 30).map((t) => timesheetJson(t, act)),
      pendingCorrections: new Set(corrections().filter((c) => c.status === 'Pending').map((c) => c.recordId)), assignmentById,
    });
  });
  app.get('/account/work/documents/:id/file', requireCandidate, (req, res) => sendDocument({ kind: 'worker', id: `c:${req.candidateEmail}`, email: req.candidateEmail, name: req.candidateEmail }, req, res, '/account/work'));

  const scanMs = Number(process.env.WORKFORCE_SCAN_MS) || 60 * 60 * 1000;
  setInterval(() => { try { scan(); } catch (e) { console.error('Workforce scan failed:', e.message); } }, scanMs).unref();

  return { scan, workers, records, timesheets, createWorker, checkIn, checkOut, planShifts, submitTimesheet, decideTimesheet, requestCorrection, decideCorrection, payroll, localToUtc };
}

module.exports = { register, parseItems, parseAt, localToUtc, zoneOffset, DEFAULT_ITEMS, RULE_DEFAULTS };
