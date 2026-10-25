// Platform trust & safety: checking employer companies, moderating job
// listings, complaint cases with evidence and assignment, appeals against
// adverse decisions, a tamper-evident audit trail, and the operations view
// (service health, background jobs, email delivery). It sits on top of what
// already exists and reuses it: company checks and their emails
// (employers.js), the review of jobs employers send in (employer-hiring.js),
// "Report this job" (server.js), the team's roles and two-step sign-in
// (agency-roles.js, team.js), notifications (notify.js) and private uploads
// (uploads.js).
//
// Rules: every page and API call checks the signed-in team member's role on
// the server; automated flags only open a case for a person to review, they
// never unpublish or ban anything; every decision records who, when and
// why; adverse decisions about a company come with an appeal decided by
// someone else; closing an account needs a second person.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const vault = require('./vault');
const roles = require('./agency-roles');
const { paginate } = require('./paginate');
const { DOCUMENT_TYPES } = require('./uploads');
const { cleanMessage } = require('./ops-monitor');
const risk = require('./risk');

const DAY = 86400000;
const iso = (ms = Date.now()) => new Date(ms).toISOString();
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
// Plain text: no control characters, trimmed, bounded.
const clip = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, n);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const urlCount = (s) => (String(s || '').match(/https?:\/\/|www\./gi) || []).length;
const hoursBetween = (a, b) => (Date.parse(b) - Date.parse(a)) / 3600000;
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return Math.round((s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) * 10) / 10; };

const CASES = 'trust-cases';
const APPEALS = 'trust-appeals';
const AUDIT = 'trust-audit';
const CHECKS = 'employer-verifications';

const CATEGORIES = {
  scam: 'Scam or fake job',
  'payment-request': 'Asks candidates to pay money',
  'personal-data': 'Asks for Aadhaar, bank details or an OTP',
  impersonation: 'Pretends to be another company or person',
  harassment: 'Harassment or abuse',
  'misleading-terms': 'Misleading pay or job terms',
  discrimination: 'Discriminatory or offensive',
  stale: 'Already filled or closed',
  spam: 'Spam or duplicate listing',
  'suspicious-links': 'Links to suspicious sites, apps or chat groups',
  other: 'Something else',
};
const HIGH_RISK = ['scam', 'payment-request', 'personal-data', 'impersonation', 'harassment'];
// The reasons on the job page's "Report this job" form.
const REASON_CATEGORY = {
  'Looks fake or like a scam': 'scam',
  'Asks candidates to pay money': 'payment-request',
  'Asks for Aadhaar, bank details or an OTP': 'personal-data',
  'Pretends to be another company': 'impersonation',
  'Wrong or misleading details': 'misleading-terms',
  'Already filled or closed': 'stale',
  'Discriminatory or offensive': 'discrimination',
  'Has suspicious links or apps': 'suspicious-links',
  'Something else': 'other',
};
// What someone who reported sees on the tracking page: never the reviewer,
// the escalation or the evidence, only where the report has got to.
const PUBLIC_STATUS = { open: 'New', under_review: 'Under review', awaiting_information: 'Action required', resolved: 'Resolved', dismissed: 'Resolved' };
// Shown wherever someone reports a job or a company.
const CYBERCRIME_HELP = 'If you have lost money or shared bank details, an OTP or a UPI PIN, report it at once on the National Cyber Crime Reporting Portal (cybercrime.gov.in) or call the helpline 1930, and tell your bank.';
const ENTITY_TYPES = ['job', 'employer', 'candidate'];
const ENTITY_LABEL = { job: 'Job listing', employer: 'Employer', candidate: 'Candidate' };
const STATUSES = ['open', 'under_review', 'awaiting_information', 'resolved', 'dismissed'];
const STATUS_LABEL = { open: 'Open', under_review: 'Under review', awaiting_information: 'Awaiting information', resolved: 'Resolved', dismissed: 'Dismissed' };
const CLOSED = ['resolved', 'dismissed'];
// Where a case may go next; reopening a closed case is for managers.
const MOVES = {
  open: ['under_review', 'awaiting_information', 'resolved', 'dismissed'],
  under_review: ['awaiting_information', 'resolved', 'dismissed'],
  awaiting_information: ['under_review', 'resolved', 'dismissed'],
  resolved: ['under_review'],
  dismissed: ['under_review'],
};
const PRIORITIES = ['high', 'normal', 'low'];
const LEVELS = { low: 1, medium: 2, high: 3, critical: 4 };
const APPEAL_DAYS = 30;
const RETENTION_MONTHS = 24;
const POLICY_DEFAULTS = { unverifiedPendingLimit: 5, flagLevel: 'medium', urgentReports: 3, postingBurst: 10 };
const RECEIPTS = 'report-receipts';

// What a reviewer may do on a case. `perm` is checked on the server;
// `strong` actions need two-step sign-in; `entity` limits where it applies.
const CASE_ACTIONS = {
  note: { label: 'Add a note', perm: 'cases.view' },
  'request-information': { label: 'Ask the person who reported for more information', perm: 'cases.view' },
  escalate: { label: 'Escalate to a Trust & Safety Manager', perm: 'cases.view' },
  'request-correction': { label: 'Send the listing back with what to correct', perm: 'jobs.moderate', entity: ['job'] },
  'restrict-job': { label: 'Unpublish the listing (restrict)', perm: 'jobs.moderate', entity: ['job'] },
  'remove-job': { label: 'Remove the listing', perm: 'jobs.moderate', entity: ['job'] },
  'lift-job': { label: 'Lift the restriction on the listing', perm: 'jobs.moderate', entity: ['job'] },
  'clear-flags': { label: 'Mark the automated flags as checked', perm: 'jobs.moderate', entity: ['job'] },
  'suspend-employer': { label: 'Suspend the company (reversible)', perm: 'accounts.restrict', entity: ['job', 'employer'], strong: true },
  'reinstate-employer': { label: 'Lift the company suspension', perm: 'accounts.restrict', entity: ['job', 'employer'], strong: true },
  'terminate-employer': { label: 'Close the company account (needs a second person)', perm: 'accounts.restrict', entity: ['job', 'employer'], strong: true },
  'approve-pending': { label: 'Approve the waiting account closure', perm: 'accounts.restrict', strong: true },
  'hold-postings': { label: 'Hold new job postings by the company (the company can appeal)', perm: 'jobs.moderate', entity: ['job', 'employer'], strong: true },
  'lift-postings': { label: 'Lift the hold on new job postings', perm: 'jobs.moderate', entity: ['job', 'employer'], strong: true },
  'reject-pending': { label: 'Reject the waiting account closure', perm: 'accounts.restrict' },
  resolve: { label: 'Resolve the case', perm: 'cases.view' },
  dismiss: { label: 'Dismiss the case (no breach found)', perm: 'cases.view' },
  reopen: { label: 'Reopen the case', perm: 'cases.manage' },
};
const MODERATION_DECISIONS = {
  approve: 'Approve (goes live)',
  clear: 'Checked: the flags are not a problem',
  'request-correction': 'Send back with what to correct',
  restrict: 'Unpublish (restrict)',
  remove: 'Remove',
  lift: 'Lift a restriction',
};

// ---------- automated checks on listings ----------
// Signals for a person to look at, never proof: each opens or adds to a
// case, and nothing is unpublished until a moderator decides.
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"')]+/gi;
const RULES = [
  { code: 'payment-request', severity: 'high', label: 'Asks candidates to pay a fee or deposit',
    re: /\b(registration|security|joining|training|processing|interview|application|kit|uniform|documentation|document|verification)\s+(fee|fees|charge|charges|deposit|amount)\b|\brefundable\s+deposit\b|\bpay\s+(rs\.?|inr|₹)\s*\d|(rs\.?|inr|₹)\s*\d[\d,]*\s*(to|for)\s+(register|apply|join)/i },
  { code: 'personal-data', severity: 'high', label: 'Asks for Aadhaar, PAN, bank details or an OTP up front',
    re: /\b(send|share|submit|whatsapp|provide|give)\b[^.\n]{0,40}\b(aadhaa?r|pan card|bank (account|details)|otp|atm|upi pin|cvv)\b/i },
  { code: 'too-good', severity: 'medium', label: 'Promises often used by scams (guaranteed job, no interview, pay per day)',
    re: /\b(100% (job|placement) guarantee|guaranteed (job|placement|income)|no interview|without interview|work from home and earn|daily payout|easy money|earn (rs\.?|₹|inr)?\s?\d[\d,]*\s?(per|a|\/)\s?(day|hour))\b/i },
  { code: 'chat-link', severity: 'medium', label: 'Sends candidates to a WhatsApp or Telegram link', re: /\b(wa\.me|chat\.whatsapp\.com|api\.whatsapp\.com|t\.me|telegram\.me)\b/i },
  { code: 'short-link', severity: 'medium', label: 'Uses a link shortener that hides where it goes', re: /\b(bit\.ly|tinyurl\.com|goo\.gl|t\.co|cutt\.ly|rb\.gy|is\.gd|ow\.ly|shorturl\.at|tiny\.cc)\//i },
];
const TEXT_FIELDS = ['title', 'company', 'description', 'payNote', 'address', 'physical'];
const LIST_FIELDS = ['responsibilities', 'qualifications', 'benefits', 'eligibility', 'mustHave'];
const textOf = (job) => [...TEXT_FIELDS.map((k) => job[k] || ''), ...LIST_FIELDS.flatMap((k) => (Array.isArray(job[k]) ? job[k] : [job[k] || '']))].join('\n');
const normal = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const fingerprint = (job) => sha256(`${normal(job.title)}|${normal(job.description).slice(0, 600)}`);

function flagsFor(job, others) {
  const text = textOf(job);
  const out = [];
  for (const r of RULES) {
    const m = r.re.exec(text);
    if (m) out.push({ code: r.code, severity: r.severity, label: r.label, detail: clip(m[0], 80) });
  }
  for (const u of new Set(text.match(URL_RE) || [])) {
    const host = u.replace(/^https?:\/\//i, '').split(/[/?#:]/)[0];
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) out.push({ code: 'ip-link', severity: 'medium', label: 'Links to a bare IP address', detail: clip(host, 80) });
    else if (/^http:\/\//i.test(u)) out.push({ code: 'insecure-link', severity: 'low', label: 'Links to a site without HTTPS', detail: clip(host, 80) });
  }
  // Same title and description as an earlier live listing (the later one is flagged).
  const fp = fingerprint(job);
  const earlier = (o) => String(o.posted || '') < String(job.posted || '') || (String(o.posted || '') === String(job.posted || '') && o.id < job.id);
  const same = others.filter((o) => o.id !== job.id && o.fp === fp && earlier(o));
  const sameCompany = (o) => (job.employerId ? o.employerId === job.employerId : !o.employerId && normal(o.company) === normal(job.company));
  if (same.some((o) => !sameCompany(o))) out.push({ code: 'copied', severity: 'high', label: "Same text as another company's listing (possible impersonation)", detail: same.filter((o) => !sameCompany(o)).map((o) => o.id).slice(0, 3).join(', ') });
  else if (same.length) out.push({ code: 'duplicate', severity: 'low', label: 'Posted more than once', detail: same.map((o) => o.id).slice(0, 3).join(', ') });
  const seen = new Set();
  return out.filter((f) => (seen.has(f.code) ? false : seen.add(f.code)));
}
const levelOf = (flags) => flags.reduce((m, f) => (LEVELS[f.severity] > LEVELS[m] ? f.severity : m), 'low');

function register(app, deps) {
  const { db, team, clients, hiring, getJobs, saveJobs, jobPath, readSubmissions, saveSubmission, adminAuth, sameOrigin, limit, isBot } = deps;
  const { mailer, notify, site, baseUrl, uploadsDir, downloadLinks, linkExpired, vetDocument, candidateEmail, ops, backups } = deps;
  const verification = clients.verification;

  // ---------- the audit trail ----------
  // Append-only and hash-chained: each entry carries the hash of the one
  // before it, and the newest hash is kept separately, so editing, removing
  // or reordering entries shows up when the chain is checked. No route
  // changes or deletes these entries.
  const HEAD = 'trust:audit-head';
  const hashOf = (e) => sha256(JSON.stringify([e.seq, e.at, e.actorId, e.actorName, e.role, e.action, e.entityType, e.entityId, e.caseId, e.reason, e.detail, e.prevHash]));
  function record(user, action, { entityType = '', entityId = '', caseId = '', reason = '', detail = '' } = {}) {
    return db.transaction(() => {
      let head = { seq: 0, hash: '' };
      try { head = JSON.parse(db.metaGet(HEAD) || '') || head; } catch (e) { /* first entry */ }
      const e = {
        id: crypto.randomUUID(), seq: head.seq + 1, at: iso(), actorId: user ? String(user.id || '') : '', actorName: user ? clip(user.name, 120) : 'System', role: user ? clip(user.role || '', 60) : '',
        action, entityType, entityId: String(entityId || ''), caseId: String(caseId || ''), reason: clip(reason, 500), detail: clip(detail, 300), prevHash: head.hash,
      };
      e.hash = hashOf(e);
      db.prepend(AUDIT, e);
      db.metaSet(HEAD, JSON.stringify({ seq: e.seq, hash: e.hash }));
      return e;
    });
  }
  function verifyChain() {
    const list = db.all(AUDIT).slice().reverse();
    let prev = '';
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.seq !== i + 1) return { ok: false, entries: list.length, problem: `entry ${i + 1} is missing or out of order` };
      if (e.prevHash !== prev || hashOf(e) !== e.hash) return { ok: false, entries: list.length, problem: `entry ${e.seq} was changed` };
      prev = e.hash;
    }
    let head = { seq: 0, hash: '' };
    try { head = JSON.parse(db.metaGet(HEAD) || '') || head; } catch (e) { /* none yet */ }
    if (head.seq !== list.length || head.hash !== prev) return { ok: false, entries: list.length, problem: 'the newest entries were removed' };
    return { ok: true, entries: list.length };
  }

  // ---------- policy ----------
  function policy() {
    try { return { ...POLICY_DEFAULTS, ...JSON.parse(db.metaGet('trust:policy') || '{}') }; } catch (e) { return { ...POLICY_DEFAULTS }; }
  }
  function setPolicy(user, input) {
    const errors = [];
    const n = (k, lo, hi) => { const v = Number.parseInt(String(input[k] ?? ''), 10); if (!Number.isInteger(v) || v < lo || v > hi) errors.push(`${k} must be a whole number from ${lo} to ${hi}`); return v; };
    const next = { unverifiedPendingLimit: n('unverifiedPendingLimit', 0, 50), urgentReports: n('urgentReports', 2, 20), flagLevel: String(input.flagLevel || ''), postingBurst: input.postingBurst === undefined ? policy().postingBurst : n('postingBurst', 3, 100) };
    if (!LEVELS[next.flagLevel]) errors.push('flagLevel must be low, medium, high or critical');
    const reason = clip(input.reason, 500);
    if (reason.length < 5) errors.push('give a reason for the change');
    if (errors.length) return { status: 400, errors };
    const before = policy();
    db.metaSet('trust:policy', JSON.stringify(next));
    record(user, 'policy-changed', { entityType: 'policy', reason, detail: Object.keys(next).filter((k) => before[k] !== next[k]).map((k) => `${k}: ${before[k]} → ${next[k]}`).join('; ') || 'no change' });
    return { status: 200, policy: next };
  }
  if (hiring.hooks) hiring.hooks.waitingLimit = () => policy().unverifiedPendingLimit;

  // ---------- who may see what ----------
  const can = (user, action) => roles.can(user, action);
  const strongOk = (user) => team.has2fa(user.id);
  function seesCase(user, c) {
    if (!c || !can(user, 'cases.view')) return false;
    if (can(user, 'cases.manage')) return true;
    if (c.assigneeId && c.assigneeId === user.id) return true;
    if (user.role === 'Job Moderator') return c.entityType === 'job';
    if (user.role === 'Verification Reviewer') return c.entityType === 'employer';
    return false;
  }
  const reviewers = () => team.members().filter((u) => can(u, 'cases.view'));
  const managers = () => team.members().filter((u) => can(u, 'cases.manage'));
  function tell(key, people, title, body, link) {
    const to = people.map((u) => ({ kind: 'team', userId: u.id }));
    if (to.length) notify.emit({ key, type: 'trust-case', to, inApp: { title, body, link } });
  }

  // ---------- cases ----------
  const cases = () => db.all(CASES);
  const caseById = (id) => cases().find((c) => c.id === id) || null;
  const openCaseFor = (type, id) => cases().find((c) => c.entityType === type && c.entityId === id && !CLOSED.includes(c.status)) || null;
  function nextNumber() {
    return db.transaction(() => {
      const n = (Number(db.metaGet('trust:case-seq')) || 0) + 1;
      db.metaSet('trust:case-seq', String(n));
      return `TS-${String(n).padStart(5, '0')}`;
    });
  }
  function priorityOf(c) {
    const pol = policy();
    if (c.escalated) return 'high';
    if (c.reports.some((r) => HIGH_RISK.includes(r.category)) || HIGH_RISK.includes(c.category)) return 'high';
    if (c.flags.some((f) => f.severity === 'high' || f.severity === 'critical')) return 'high';
    if (new Set(c.reports.map((r) => r.reporterKey || r.id)).size >= pol.urgentReports) return 'high';
    if (c.reports.length && c.reports.every((r) => r.category === 'stale')) return 'low';
    return c.priorityOverride || 'normal';
  }
  function openCase({ source, entity, category, report, flags = [], by = null, text }) {
    const c = {
      id: crypto.randomUUID(), number: nextNumber(), source, entityType: entity.type, entityId: entity.id, entityLabel: clip(entity.label, 160), employerId: entity.employerId || '',
      category, priority: 'normal', status: 'open', assigneeId: '', assigneeName: '', version: 1, escalated: false,
      reports: report ? [report] : [], flags, evidence: [], actions: [], pending: null,
      history: [{ at: iso(), by: by ? by.name : 'System', role: by ? by.role : '', action: 'opened', text: text || '' }],
      createdAt: iso(), updatedAt: iso(), firstResponseAt: null, resolvedAt: null, resolution: null,
    };
    c.priority = priorityOf(c);
    db.prepend(CASES, c);
    if (c.priority === 'high') tell(`trust-new:${c.id}`, managers(), `Urgent case ${c.number}`, `${CATEGORIES[c.category] || c.category}: ${c.entityLabel}`, `/admin/cases/${c.id}`);
    return c;
  }
  // Saves a change to a case under its version, so two people working on it
  // at once can't overwrite each other: the second gets a conflict.
  function changeCase(id, version, fn) {
    return db.transaction(() => {
      const c = caseById(id);
      if (!c) return { status: 404, errors: ['case not found'] };
      if (version !== undefined && version !== null && version !== '' && Number(version) !== c.version) return { status: 409, errors: ['someone else changed this case: reload it and try again'], case: c };
      const r = fn(c);
      if (r && r.errors) return r;
      c.version++;
      c.updatedAt = iso();
      c.priority = priorityOf(c);
      db.update(CASES, c);
      return { status: 200, case: c, ...(r || {}) };
    });
  }
  const note = (c, user, action, text) => c.history.push({ at: iso(), by: user ? user.name : 'System', role: user ? user.role || '' : '', action, text: clip(text, 1000) });
  // Adds a moderation or verification decision to every open case about it.
  function noteOpenCases(entityType, entityId, user, text) {
    for (const c of cases().filter((x) => x.entityType === entityType && x.entityId === entityId && !CLOSED.includes(x.status))) {
      changeCase(c.id, null, (k) => { note(k, user, 'decision', text); if (!k.firstResponseAt) k.firstResponseAt = iso(); });
    }
  }

  // ---------- reports from candidates, employers and visitors ----------
  // Who is reporting, from their session; nothing the browser claims.
  function reporterOf(req, email) {
    const ctx = clients.context(req);
    if (ctx) return { type: 'employer', id: ctx.user.id, employerId: ctx.employer.id, key: sha256(`employer:${ctx.user.id}`) };
    const own = candidateEmail(req);
    if (own) return { type: 'candidate', key: sha256(`candidate:${own}`), email: own };
    return { type: 'visitor', key: email ? sha256(`email:${email}`) : '' };
  }
  // The thing reported, only when this reporter may name it. Anything else
  // gets the same reply, so the form says nothing about who has an account.
  function entityFor(type, id, reporter) {
    const jobs = getJobs();
    // A job id: the listing, or (type employer) the company that posted it.
    const job = (type === 'job' || type === 'employer') && jobs.find((j) => j.id === id && !j.sample && j.status !== 'draft');
    if (type === 'job' && !job) return null;
    if (job) {
      if (type === 'employer' && job.employerId) {
        const emp = clients.read().find((e) => e.id === job.employerId);
        if (emp) return { type: 'employer', id: emp.id, label: emp.company, employerId: emp.id, jobId: job.id };
      }
      return { type: 'job', id: job.id, label: `${job.title} · ${job.company}`, employerId: job.employerId || '' };
    }
    // A company by its own id, when its profile is public (company-trust.js).
    if (type === 'employer') {
      const emp = clients.read().find((e) => e.id === id && e.active && !e.terminatedAt);
      if (emp && jobs.some((j) => j.employerId === emp.id && j.status === 'open' && !j.sample)) return { type: 'employer', id: emp.id, label: emp.company, employerId: emp.id };
    }
    if (type === 'candidate') {
      if (reporter.type !== 'employer') return null;
      const a = readSubmissions('applications').find((x) => x.id === id);
      if (!a) return null;
      const job = a.jobId && jobs.find((j) => j.id === a.jobId);
      const visible = (a.shared && a.shared.employerId === reporter.employerId) || (job && job.employerId === reporter.employerId);
      return visible ? { type: 'candidate', id: a.id, label: `${a.name} (applied for ${a.jobTitle || (job && job.title) || 'a job'})`, employerId: '' } : null;
    }
    return null;
  }
  // A reference and a private tracking link for every report of a valid
  // shape, whether or not it led anywhere, so the reply never tells the
  // person anything about accounts or listings they could not see.
  function issueReceipt(category, caseId, reportId) {
    const token = crypto.randomBytes(24).toString('hex');
    const reference = `R-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
    saveSubmission(RECEIPTS, { reference, tokenHash: sha256(token), category, caseId: caseId || '', reportId: reportId || '' });
    return { reference, trackUrl: `${baseUrl}/reports/track/${token}`, help: CYBERCRIME_HELP };
  }
  const receiptByToken = (token) => (/^[a-f0-9]{48}$/.test(token) ? db.all(RECEIPTS).find((r) => r.tokenHash === sha256(token)) || null : null);
  // Where a report has got to, in words for the person who sent it.
  function trackingOf(receipt) {
    const c = receipt.caseId ? caseById(receipt.caseId) : null;
    const steps = [{ at: receipt.createdAt, label: 'Report received' }];
    let status = 'New';
    if (!c) {
      // Nothing to follow (a duplicate, or something we could not match): closed after a week.
      if (Date.parse(receipt.createdAt) < Date.now() - 7 * DAY) { status = 'Resolved'; steps.push({ at: iso(Date.parse(receipt.createdAt) + 7 * DAY), label: 'Closed' }); }
    } else {
      status = PUBLIC_STATUS[c.status] || 'Under review';
      if (status === 'New' && c.firstResponseAt) status = 'Under review';
      if (c.firstResponseAt) steps.push({ at: c.firstResponseAt, label: 'Our team started looking into it' });
      if (c.status === 'awaiting_information') steps.push({ at: c.updatedAt, label: 'We asked for more information by email' });
      if (c.resolvedAt && CLOSED.includes(c.status)) steps.push({ at: c.resolvedAt, label: c.status === 'dismissed' ? 'Closed: we did not find a breach of our rules' : 'Closed: we took the action our rules call for' });
    }
    return { reference: receipt.reference, category: CATEGORIES[receipt.category] || receipt.category, status, steps };
  }
  // { status, errors?, receipt? }. Valid shapes always answer the same way.
  function submitReport(req, input, file) {
    const drop = () => file && fs.unlink(file.path, () => {});
    const entityType = String(input.entityType || '');
    const entityId = clip(input.entityId, 80);
    const category = String(input.category || '');
    const details = clip(input.details, 1000);
    const email = clip(input.email, 160).toLowerCase();
    const errors = [];
    if (!ENTITY_TYPES.includes(entityType)) errors.push(`entityType must be one of: ${ENTITY_TYPES.join(', ')}`);
    if (!entityId) errors.push('entityId is required');
    if (!CATEGORIES[category]) errors.push(`category must be one of: ${Object.keys(CATEGORIES).join(', ')}`);
    if (String(input.details || '').length > 1000) errors.push('details must be 1000 characters or fewer');
    if (email && !EMAIL_RE.test(email)) errors.push('email is invalid');
    if (['impersonation', 'harassment', 'other'].includes(category) && details.length < 10) errors.push('please describe what happened');
    if (errors.length) { drop(); return { status: 400, errors }; }
    // Link-stuffed text is treated as spam: same reply, nothing kept.
    if (urlCount(details) > 3) { drop(); return { status: 202, receipt: issueReceipt(category) }; }
    const reporter = reporterOf(req, email);
    const entity = entityFor(entityType, entityId, reporter);
    if (!entity) { drop(); return { status: 202, receipt: issueReceipt(category) }; }
    const report = {
      id: crypto.randomUUID(), at: iso(), category, details, reporterType: reporter.type, reporterKey: reporter.key,
      ...(reporter.employerId ? { reporterEmployerId: reporter.employerId } : {}), email: email || reporter.email || '', ...(input.jobReportId ? { jobReportId: input.jobReportId } : {}), ...(entity.jobId ? { jobId: entity.jobId } : {}),
    };
    const ev = file ? { id: crypto.randomUUID(), file: path.basename(file.filename), originalName: clip(file.originalname, 120), size: file.size, sha256: sha256(vault.readSync(file.path)), by: `Reporter (${reporter.type})`, at: iso(), fromReport: report.id } : null;
    const existing = openCaseFor(entity.type, entity.id);
    let caseId = existing ? existing.id : '';
    if (existing) {
      changeCase(existing.id, null, (c) => {
        // The same person reporting again adds nothing new to the count.
        if (report.reporterKey && c.reports.some((r) => r.reporterKey === report.reporterKey)) { if (report.details) note(c, null, 'report', `Same reporter again: ${report.details}`); }
        else { c.reports.push(report); note(c, null, 'report', `Another report: ${CATEGORIES[category]}`); }
        if (ev) c.evidence.push(ev);
        const was = c.priority;
        c.priority = priorityOf(c);
        if (was !== 'high' && c.priority === 'high') tell(`trust-urgent:${c.id}`, managers(), `Case ${c.number} is now urgent`, `${c.reports.length} reports: ${c.entityLabel}`, `/admin/cases/${c.id}`);
      });
    } else {
      const c = openCase({ source: 'report', entity, category, report, text: `Reported by a ${reporter.type}: ${CATEGORIES[category]}` });
      caseId = c.id;
      if (ev) changeCase(c.id, null, (k) => { k.evidence.push(ev); });
    }
    return { status: 202, receipt: issueReceipt(category, caseId, report.id) };
  }
  // The job page's existing form (server.js keeps its email and inbox).
  function reportJob(req, job, data, jobReportId) {
    return submitReport(req, { entityType: 'job', entityId: job.id, category: REASON_CATEGORY[data.reason] || 'other', details: data.details || (data.reason === 'Something else' ? 'Something else (no details given)' : ''), email: data.email, jobReportId });
  }

  // ---------- scanning listings and companies (risk.js) ----------
  // Every listing and company gets an explainable assessment. What is done
  // automatically is limited to opening or escalating a case, raising its
  // priority, pausing a live listing that copies another company's text until
  // a moderator checks it, and holding a burst of new postings for review.
  const assessments = risk.store(db);
  const CATEGORY_OF = [['payment-request', 'payment-request'], ['personal-data', 'personal-data'], ['impersonation', 'impersonation'], ['copied', 'impersonation'], ['chat-link', 'suspicious-links'], ['short-link', 'suspicious-links'], ['ip-link', 'suspicious-links'], ['changed-pay', 'misleading-terms'], ['changed-location', 'misleading-terms'], ['changed-employer', 'impersonation']];
  const categoryOf = (flags) => (CATEGORY_OF.find(([code]) => flags.some((f) => f.code === code)) || [null, 'scam'])[1];
  const toFlags = (rules) => rules.map((r) => ({ code: r.code, severity: r.severity, label: r.label, detail: r.evidence }));
  // A live listing that looks like impersonation waits for a moderator.
  function holdForReview(j, a) {
    if (j.status !== 'open' || j.reviewHold || (j.moderation && j.moderation.locked)) return false;
    const rule = a.rules.find((r) => r.action === 'review-hold');
    j.reviewHold = { at: iso(), reason: rule ? rule.label : 'Automated checks', assessmentId: a.id, prevStatus: j.status };
    Object.assign(j, { status: 'pending', submittedAt: iso(), updatedAt: iso() });
    assessments.noteAction(a, 'review-hold', { detail: j.id });
    record(null, 'job-review-hold', { entityType: 'job', entityId: j.id, reason: 'Automated checks (for review, not proof)', detail: `${j.title} · ${j.company}: ${j.reviewHold.reason}` });
    if (j.employerId) tellOwners(j.employerId, { subject: `We are checking "${j.title}" before it shows again`, heading: 'A listing is waiting for a quick check', lines: [`Our automated checks asked a moderator to look at "${j.title}" (${j.id}) before it shows to candidates again. This is a routine check, not a finding against your company, and it usually takes less than one working day.`, 'You do not need to do anything. If the moderator needs something, we will email you.'] });
    return true;
  }
  function scan() {
    const jobs = getJobs();
    const live = jobs.filter((j) => ['open', 'pending', 'paused'].includes(j.status) && !j.sample);
    const others = live.map((j) => ({ id: j.id, employerId: j.employerId || '', company: j.company, posted: j.posted || '', fp: fingerprint(j), shingles: risk.shingles(j) }));
    const emps = new Map(clients.read().map((e) => [e.id, e]));
    const pol = policy();
    let changed = false;
    let opened = 0;
    for (const j of live) {
      const rules = risk.jobRules(j, { flags: flagsFor(j, others), others, employer: emps.get(j.employerId) || null });
      const flags = toFlags(rules);
      const fp = sha256(`${textOf(j)}|${flags.map((f) => `${f.code}:${f.detail}`).join(',')}`);
      if (!j.trustScan || j.trustScan.fp !== fp) {
        const { assessment } = assessments.save('job', j.id, { employerId: j.employerId || '', rules });
        j.trustScan = { ...(j.trustScan || {}), fp, at: iso(), flags, level: flags.length ? levelOf(flags) : '', assessmentId: assessment.id };
        changed = true;
      }
      const s = j.trustScan;
      if (!s.flags.length || s.clearedFp === fp || s.caseFp === fp || LEVELS[s.level] < LEVELS[pol.flagLevel]) continue;
      const a = assessments.latest('job', j.id);
      if (s.level === 'critical' && a && holdForReview(j, a)) changed = true;
      const entity = { type: 'job', id: j.id, label: `${j.title} · ${j.company}`, employerId: j.employerId || '' };
      const existing = openCaseFor('job', j.id);
      const text = `Automated checks (for review, not proof): ${s.flags.map((f) => f.label).join('; ')}`;
      if (existing) changeCase(existing.id, null, (c) => { c.flags = s.flags; note(c, null, 'flagged', text); });
      else { openCase({ source: 'automated', entity, category: categoryOf(s.flags), flags: s.flags, text }); opened++; }
      if (a) assessments.noteAction(a, existing ? 'urgent-review' : 'urgent-review', { detail: existing ? existing.number : 'case opened' });
      s.caseFp = fp;
      changed = true;
    }
    if (changed) saveJobs();
    for (const emp of emps.values()) if (emp.active && !emp.terminatedAt) opened += assessEmployer(emp, jobs, pol);
    return { scanned: live.length, opened };
  }
  // The company as a whole: bursts of postings, independent reports, decisions
  // that stood, identity changes after verification and risky listings.
  function assessEmployer(emp, jobs, pol) {
    const mine = jobs.filter((j) => j.employerId === emp.id && !j.sample);
    const dayAgo = iso(Date.now() - DAY);
    const openCases = cases().filter((c) => (c.entityId === emp.id || c.employerId === emp.id) && !CLOSED.includes(c.status));
    const reporters = new Set(openCases.flatMap((c) => c.reports.map((r) => r.reporterKey || r.id))).size;
    const since180 = iso(Date.now() - 180 * DAY);
    const upheld = appeals().filter((a) => a.employerId === emp.id && ['job-restricted', 'job-removed'].includes(a.kind) && a.decidedAt >= since180 && a.status !== 'overturned').length;
    const rules = risk.employerRules(emp, {
      policy: pol, reporters, upheldViolations: upheld,
      recentSubmissions: mine.filter((j) => j.status === 'pending' && j.submittedAt && j.submittedAt >= dayAgo).length,
      identityChanged: emp.recheck ? `${(emp.recheck.fields || []).join(', ')} on ${String(emp.recheck.at).slice(0, 10)}` : '',
      highRiskJobs: mine.filter((j) => ['open', 'pending', 'paused'].includes(j.status) && j.trustScan && ['high', 'critical'].includes(j.trustScan.level) && j.trustScan.clearedFp !== j.trustScan.fp).length,
    });
    if (!rules.length && !assessments.latest('employer', emp.id)) return 0;
    const { assessment: a, changed } = assessments.save('employer', emp.id, { employerId: emp.id, rules, context: risk.employerContext(emp) });
    if (!changed || !rules.length) return 0;
    for (const r of rules.filter((x) => ['posting-limit', 'reverification', 'restrict-capabilities'].includes(x.action))) assessments.noteAction(a, r.action, { detail: r.code === 'restrict-capabilities' ? 'recommended to a moderator' : '' });
    if (risk.SEVERITY[a.level] < risk.SEVERITY.high) return 0;
    const flags = toFlags(rules);
    const escalate = rules.some((r) => r.action === 'escalate');
    const text = `Automated checks on the company (for review, not proof): ${rules.map((r) => `${r.label} (${r.evidence})`).join('; ')}`;
    const existing = openCaseFor('employer', emp.id);
    if (existing) changeCase(existing.id, null, (c) => { c.flags = flags; note(c, null, 'flagged', text); if (escalate && !c.escalated) { c.escalated = true; c.escalatedAt = iso(); } });
    else {
      const c = openCase({ source: 'automated', entity: { type: 'employer', id: emp.id, label: emp.company, employerId: emp.id }, category: 'other', flags, text });
      if (escalate) changeCase(c.id, null, (k) => { k.escalated = true; k.escalatedAt = iso(); note(k, null, 'escalate', 'Escalated automatically: reported by several different people'); });
    }
    if (escalate) assessments.noteAction(a, 'escalate');
    return existing ? 0 : 1;
  }
  // Before an employer's job goes for review: holds a burst of new postings,
  // and a hold a moderator placed on the company.
  function postingProblem(emp, job) {
    if (emp.postingHold) return 'sending new jobs for review is on hold while our team looks into a concern about your account (we emailed your company owners how to appeal)';
    const burst = policy().postingBurst;
    const dayAgo = iso(Date.now() - DAY);
    const recent = getJobs().filter((j) => j.employerId === emp.id && j.id !== job.id && j.status === 'pending' && j.submittedAt && j.submittedAt >= dayAgo).length;
    if (recent >= burst) return `you have sent ${recent} jobs for review in the last 24 hours; more can be sent once our team has checked these`;
    return '';
  }
  if (hiring.hooks) {
    hiring.hooks.postingProblem = postingProblem;
    // Pay, place or company changed on a live listing: kept for the checks.
    hiring.hooks.changed = (before, job) => {
      const emp = job.employerId ? clients.read().find((e) => e.id === job.employerId) : null;
      const found = before.status === 'open' || before.approvedAt ? risk.changesOf(before, job, emp) : [];
      if (found.length) job.changeSignals = [...(job.changeSignals || []), ...found].slice(-6);
    };
    // Each job sent for review is checked straight away.
    hiring.hooks.submitted = () => { try { scan(); } catch (e) { console.error('Trust scan failed:', e.message); } };
  }
  // Confirmed sign-ups without an open check (older data) get one in the queue.
  function syncChecks() {
    const checks = readSubmissions(CHECKS);
    for (const e of clients.read().filter((x) => x.selfSignup && x.emailVerifiedAt && !x.approvedAt && !x.rejectedAt && x.active)) {
      if (!checks.some((v) => v.employerId === e.id && verification.OPEN_CHECKS.includes(v.status))) {
        saveSubmission(CHECKS, { employerId: e.id, status: 'pending', submittedBy: 'sign-up', signedUpAt: e.createdAt || '', details: Object.fromEntries(['company', 'gstin', 'cin', 'udyam', 'website', 'industry', 'addressLine', 'city', 'state', 'pincode'].map((k) => [k, e[k] || ''])) });
      }
    }
  }
  const scanJob = ops ? ops.track('trust-scan', () => { syncChecks(); return scan(); }, Number(process.env.TRUST_SCAN_MS) || 10 * 60 * 1000) : () => { syncChecks(); return scan(); };

  // ---------- appeals ----------
  function issueAppeal({ kind, entityType, entityId, employerId, caseId = '', by, reason, label }) {
    const token = crypto.randomBytes(24).toString('hex');
    db.transaction(() => {
      for (const a of db.all(APPEALS).filter((x) => x.entityType === entityType && x.entityId === entityId && x.status === 'available')) db.update(APPEALS, { ...a, status: 'superseded' });
      saveSubmission(APPEALS, {
        tokenHash: sha256(token), kind, entityType, entityId, employerId, caseId, label: clip(label, 160), decisionById: by.id, decisionBy: by.name, decisionReason: clip(reason, 500),
        decidedAt: iso(), status: 'available', expiresAt: iso(Date.now() + APPEAL_DAYS * DAY), statement: '', version: 1, history: [],
      });
    });
    return `${baseUrl}/appeal/${token}`;
  }
  const appeals = () => db.all(APPEALS);
  const ownersOf = (employerId) => {
    const emp = clients.read().find((e) => e.id === employerId);
    if (!emp) return [];
    return clients.team.owners(emp.id).map((m) => clients.team.userById(m.userId)).filter(Boolean).map((u) => clients.addressed(emp, u));
  };
  function tellOwners(employerId, message) { for (const o of ownersOf(employerId)) mailer.trustDecision(o, message); }
  function closeAppeals(entityType, entityId, why) {
    for (const a of appeals().filter((x) => x.entityType === entityType && x.entityId === entityId && ['available', 'pending'].includes(x.status))) {
      db.update(APPEALS, { ...a, status: 'withdrawn', history: [...a.history, { at: iso(), text: why }] });
    }
  }

  // ---------- listings: restrict, remove, lift ----------
  function lockJob(job, user, state, reason, caseId = '') {
    if (!job || job.sample) return { status: 404, errors: ['job not found'] };
    if (job.moderation && job.moderation.locked && job.moderation.state === state) return { status: 409, errors: [`this listing is already ${state}`] };
    const prevStatus = job.moderation && job.moderation.locked ? job.moderation.prevStatus : job.status;
    job.moderation = { locked: true, state, reason: clip(reason, 500), by: user.name, byId: user.id, at: iso(), caseId, prevStatus };
    job.moderationHistory = [...(job.moderationHistory || []), { at: iso(), by: user.name, decision: state, reason: clip(reason, 500) }].slice(-30);
    job.status = 'closed';
    job.closedReason = state === 'removed' ? 'Removed by Hireriv moderators' : state === 'restricted' ? 'Unpublished by Hireriv moderators' : 'The company account is on hold';
    job.closedAt = iso();
    job.updatedAt = iso();
    return { status: 200, job, prevStatus };
  }
  function moderateJob(user, job, state, reason, caseId = '') {
    const r = lockJob(job, user, state, reason, caseId);
    if (r.errors) return r;
    saveJobs();
    if (job.employerId) {
      const appealUrl = issueAppeal({ kind: `job-${state}`, entityType: 'job', entityId: job.id, employerId: job.employerId, caseId, by: user, reason, label: `${job.title} (${job.id})` });
      tellOwners(job.employerId, { subject: `Your job "${job.title}" was ${state === 'removed' ? 'removed' : 'unpublished'}`, heading: state === 'removed' ? 'We removed a listing' : 'We unpublished a listing', lines: [`Our moderators ${state === 'removed' ? 'removed' : 'unpublished'} "${job.title}" (${job.id}) because it does not meet our listing rules.`, `Reason: ${clip(reason, 500)}`], appealUrl });
    }
    record(user, `job-${state}`, { entityType: 'job', entityId: job.id, caseId, reason, detail: `${job.title} · ${job.company} (was ${r.prevStatus})` });
    return { status: 200, job };
  }
  function unlockJob(user, job, reason, { restore = false } = {}) {
    if (!job || !job.moderation || !job.moderation.locked) return { status: 409, errors: ['this listing is not restricted'] };
    const prev = job.moderation.prevStatus;
    job.moderationHistory = [...(job.moderationHistory || []), { at: iso(), by: user.name, decision: restore ? 'restored' : 'lifted', reason: clip(reason, 500) }].slice(-30);
    delete job.moderation;
    if (restore && ['open', 'paused', 'pending'].includes(prev)) job.status = prev;
    // Lifted by a moderator: an employer's job comes back to fix and send again.
    else if (job.employerId && prev !== 'closed') Object.assign(job, { status: 'rejected', rejectedReason: clip(reason, 500), rejectedAt: iso(), rejectedBy: user.name });
    else job.status = prev === 'draft' ? 'draft' : 'closed';
    if (job.status !== 'closed') delete job.closedReason;
    job.updatedAt = iso();
    saveJobs();
    record(user, restore ? 'job-restored' : 'job-lifted', { entityType: 'job', entityId: job.id, caseId: '', reason, detail: `${job.title} → ${job.status}` });
    return { status: 200, job };
  }
  // A company's live jobs while its account is suspended or closed.
  function holdCompanyJobs(user, employerId, state, reason, caseId) {
    for (const j of getJobs().filter((x) => x.employerId === employerId && ['open', 'paused', 'pending'].includes(x.status))) lockJob(j, user, state, reason, caseId);
    saveJobs();
  }
  function releaseCompanyJobs(user, employerId, reason) {
    for (const j of getJobs().filter((x) => x.employerId === employerId && x.moderation && x.moderation.locked && ['account-suspended', 'account-closed'].includes(x.moderation.state))) {
      const prev = j.moderation.prevStatus;
      j.moderationHistory = [...(j.moderationHistory || []), { at: iso(), by: user.name, decision: 'restored', reason: clip(reason, 500) }].slice(-30);
      delete j.moderation;
      j.status = ['open', 'paused', 'pending'].includes(prev) ? prev : 'closed';
      if (j.status !== 'closed') delete j.closedReason;
    }
    saveJobs();
  }

  // ---------- the moderation queue ----------
  function moderationQueue(q = {}) {
    const openCases = cases().filter((c) => c.entityType === 'job' && !CLOSED.includes(c.status));
    const caseOf = new Map(openCases.map((c) => [c.entityId, c]));
    const rows = getJobs().filter((j) => !j.sample).map((j) => {
      const s = j.trustScan || { flags: [] };
      const flagged = s.flags && s.flags.length && s.clearedFp !== s.fp && ['open', 'pending', 'paused'].includes(j.status);
      const c = caseOf.get(j.id) || null;
      const kinds = [j.status === 'pending' ? 'pending' : '', flagged ? 'flagged' : '', c && c.reports.length ? 'reported' : '', j.moderation && j.moderation.locked ? 'restricted' : ''].filter(Boolean);
      return { job: j, flags: flagged ? s.flags : [], level: flagged ? s.level : '', case: c, kinds, since: j.submittedAt || (c && c.createdAt) || s.at || j.updatedAt || '' };
    }).filter((r) => r.kinds.length && (r.kinds.length > 1 || r.kinds[0] !== 'restricted' || q.kind === 'restricted'));
    const kind = ['pending', 'flagged', 'reported', 'restricted'].includes(q.kind) ? q.kind : '';
    const text = normal(q.q);
    return rows
      .filter((r) => !kind || r.kinds.includes(kind))
      .filter((r) => !text || normal(`${r.job.title} ${r.job.company} ${r.job.id}`).includes(text))
      .sort((a, b) => (LEVELS[b.level] || 0) - (LEVELS[a.level] || 0) || String(a.since).localeCompare(String(b.since)));
  }
  // One decision on a listing; `expectedStatus` guards against two people deciding at once.
  function decideJob(user, jobId, input) {
    const job = getJobs().find((j) => j.id === jobId && !j.sample);
    if (!job) return { status: 404, errors: ['job not found'] };
    const decision = String(input.decision || '');
    const reason = clip(input.reason, 500);
    if (!MODERATION_DECISIONS[decision]) return { status: 400, errors: [`decision must be one of: ${Object.keys(MODERATION_DECISIONS).join(', ')}`] };
    if (input.expectedStatus && input.expectedStatus !== job.status) return { status: 409, errors: ['this listing changed since you opened it: reload and check again'] };
    const reviewOnly = decision === 'approve' || (decision === 'request-correction' && job.status === 'pending');
    if (!can(user, reviewOnly ? 'jobs.review' : 'jobs.moderate')) return { status: 403, errors: ['your role does not allow that decision'] };
    if (['request-correction', 'restrict', 'remove', 'lift'].includes(decision) && reason.length < 5) return { status: 400, errors: ['give the reason (the employer sees it)'] };
    const caseId = String(input.caseId || '');
    let r;
    if (decision === 'approve') r = hiring.approveJob(job, user);
    else if (decision === 'request-correction') r = hiring.sendBackJob(job, user, reason, { live: true });
    else if (decision === 'restrict') r = moderateJob(user, job, 'restricted', reason, caseId);
    else if (decision === 'remove') r = moderateJob(user, job, 'removed', reason, caseId);
    else if (decision === 'lift') r = unlockJob(user, job, reason);
    else {
      if (!job.trustScan || !job.trustScan.flags.length) return { status: 409, errors: ['this listing has no flags to clear'] };
      job.trustScan.clearedFp = job.trustScan.fp;
      job.trustScan.clearedBy = user.name;
      job.trustScan.clearedAt = iso();
      saveJobs();
      r = { status: 200, job };
    }
    if (r.errors) return r;
    if (['approve', 'request-correction', 'clear'].includes(decision)) record(user, `job-${decision}`, { entityType: 'job', entityId: job.id, caseId, reason, detail: `${job.title} · ${job.company}` });
    noteOpenCases('job', job.id, user, `Listing decision: ${MODERATION_DECISIONS[decision]}${reason ? ` (${reason})` : ''}`);
    afterListingDecision(user, job, decision, reason);
    return { status: 200, job };
  }
  // A moderator's decision is also the verdict on the automated signals:
  // cleared or approved means they were a false positive, acted on means confirmed.
  function afterListingDecision(user, job, decision, reason) {
    const a = assessments.latest('job', job.id);
    if (a && a.rules.length && !a.review) {
      const verdict = ['clear', 'approve'].includes(decision) ? 'false-positive' : ['restrict', 'remove', 'request-correction'].includes(decision) ? 'confirmed' : '';
      if (verdict) assessments.review(a, { by: user.name, verdict, note: `${MODERATION_DECISIONS[decision]}${reason ? `: ${reason}` : ''}` });
    }
    if (['approve', 'clear'].includes(decision)) {
      if (job.reviewHold) { job.reviewHoldHistory = [...(job.reviewHoldHistory || []), { ...job.reviewHold, releasedAt: iso(), releasedBy: user.name }].slice(-10); delete job.reviewHold; }
      if (job.changeSignals) delete job.changeSignals;
      saveJobs();
    }
  }
  // The admin Jobs tab's approve and send-back buttons.
  if (hiring.hooks) hiring.hooks.decided = (user, decision, job, reason) => {
    record(user, `job-${decision}`, { entityType: 'job', entityId: job.id, reason, detail: `${job.title} · ${job.company}` });
    noteOpenCases('job', job.id, user, `Listing decision: ${MODERATION_DECISIONS[decision]}${reason ? ` (${reason})` : ''}`);
    afterListingDecision(user, job, decision, reason);
  };

  // ---------- verification ----------
  function verificationQueue(q = {}) {
    syncChecks();
    const emps = new Map(clients.read().map((e) => [e.id, e]));
    const status = ['pending', 'info-requested', 'verified', 'declined'].includes(q.status) ? q.status : 'open';
    const text = normal(q.q);
    const caseCount = (id) => cases().filter((c) => (c.entityId === id || c.employerId === id) && !CLOSED.includes(c.status)).length;
    return readSubmissions(CHECKS)
      .filter((v) => (status === 'open' ? verification.OPEN_CHECKS.includes(v.status) : v.status === status))
      .map((v) => {
        const e = emps.get(v.employerId) || {};
        const signals = [];
        if (e.freeEmail) signals.push('Signed up with a personal mailbox');
        if (!e.gstin && !e.cin && !e.udyam) signals.push('No GSTIN, CIN or Udyam number');
        if (!e.website) signals.push('No website');
        const n = caseCount(v.employerId);
        if (n) signals.push(`${n} open case${n === 1 ? '' : 's'}`);
        if (v.kind === 'recheck') signals.push('Verified company whose name or registration numbers changed');
        const rep = v.representative;
        const site = String(e.website || '').replace(/^https?:\/\//i, '').split(/[/?#:]/)[0].replace(/^www\./, '').toLowerCase();
        if (rep && rep.email && site) signals.push(rep.email.toLowerCase().endsWith(`@${site}`) ? "Representative's work email is on the company's website domain" : "Representative's email is not on the company's website domain");
        if (v.escalated) signals.push(`Escalated by ${v.escalated.by}`);
        const a = assessments.latest('employer', v.employerId);
        return { check: v, employer: e, signals, risk: a && a.rules.length ? { level: a.level, rules: a.rules.map((r) => r.label) } : null, waitingSince: v.resubmittedAt || v.signedUpAt || v.createdAt };
      })
      .filter((r) => !text || normal(`${r.employer.company} ${r.employer.email} ${r.employer.gstin}`).includes(text))
      .sort((a, b) => String(a.waitingSince).localeCompare(String(b.waitingSince)));
  }
  const VERIFY_DECISIONS = { verify: 'Verify', decline: 'Decline (closes the sign-up)', 'request-info': 'Ask for more information', escalate: 'Escalate to a Trust & Safety Manager' };
  // Each decision on a check is added to its review history; nothing is overwritten.
  function addReview(checkId, entry) {
    const cur = db.where(CHECKS, 'id', checkId)[0];
    if (cur) db.update(CHECKS, { ...cur, reviews: [...(cur.reviews || []), { at: iso(), ...entry }] });
  }
  function decideVerification(user, checkId, input) {
    if (!can(user, 'verify.review')) return { status: 403, errors: ['your role does not allow that'] };
    const check = readSubmissions(CHECKS).find((v) => v.id === checkId);
    if (!check) return { status: 404, errors: ['verification not found'] };
    const decision = String(input.decision || '');
    const reason = clip(input.reason, 500);
    if (!VERIFY_DECISIONS[decision]) return { status: 400, errors: [`decision must be one of: ${Object.keys(VERIFY_DECISIONS).join(', ')}`] };
    if (!verification.OPEN_CHECKS.includes(check.status)) return { status: 409, errors: [`this check was already decided (${check.status})`] };
    if (input.expectedStatus && input.expectedStatus !== check.status) return { status: 409, errors: ['this check changed since you opened it: reload and look again'] };
    if (decision !== 'verify' && reason.length < 5) return { status: 400, errors: [decision === 'decline' ? 'give the reason (the company sees it)' : decision === 'escalate' ? 'say why it needs a manager' : 'say what the company needs to send'] };
    if (decision === 'decline' && check.kind === 'recheck') return { status: 400, errors: ['this company is already verified: escalate it, and a manager can suspend it from the case if needed'] };
    let r;
    if (decision === 'escalate') {
      const emp = clients.read().find((e) => e.id === check.employerId);
      if (!emp) return { status: 404, errors: ['company not found'] };
      if (check.escalated) return { status: 409, errors: ['this check is already escalated'] };
      const existing = openCaseFor('employer', emp.id);
      const c = existing || openCase({ source: 'verification', entity: { type: 'employer', id: emp.id, label: emp.company, employerId: emp.id }, category: 'other', by: user, text: `Verification escalated: ${reason}` });
      changeCase(c.id, null, (k) => { k.escalated = true; k.escalatedAt = iso(); note(k, user, 'escalate', `Verification check: ${reason}`); });
      tell(`trust-escalate:${c.id}:verification`, managers().filter((u) => u.id !== user.id), `Escalated verification: ${emp.company}`, `${user.name}: ${reason}`, `/admin/cases/${c.id}`);
      const cur = db.where(CHECKS, 'id', check.id)[0];
      db.update(CHECKS, { ...cur, escalated: { by: user.name, byId: user.id, at: iso(), reason, caseId: c.id } });
      addReview(check.id, { decision, by: user.name, byId: user.id, reason, caseId: c.id });
      record(user, 'verification-escalated', { entityType: 'employer', entityId: emp.id, caseId: c.id, reason, detail: emp.company });
      return { status: 200, employer: emp, check: readSubmissions(CHECKS).find((v) => v.id === checkId) };
    }
    if (decision === 'verify') r = verification.verifyCompany(check.employerId, user);
    else if (decision === 'request-info') r = verification.requestCompanyInfo(check.employerId, user, reason);
    else {
      r = verification.declineCompany(check.employerId, user, reason);
      if (!r.errors) afterDecline(user, r.employer, reason, r.owners);
    }
    if (r.errors) return r;
    addReview(check.id, { decision, by: user.name, byId: user.id, reason });
    if (decision !== 'decline') record(user, `verification-${decision === 'verify' ? (check.kind === 'recheck' ? 'reconfirmed' : 'verified') : 'info-requested'}`, { entityType: 'employer', entityId: check.employerId, reason, detail: r.employer.company });
    noteOpenCases('employer', check.employerId, user, `Verification: ${VERIFY_DECISIONS[decision]}${reason ? ` (${reason})` : ''}`);
    return { status: 200, employer: r.employer, check: readSubmissions(CHECKS).find((v) => v.id === checkId) };
  }
  function afterDecline(user, emp, reason, owners) {
    const appealUrl = issueAppeal({ kind: 'verification-declined', entityType: 'employer', entityId: emp.id, employerId: emp.id, by: user, reason, label: emp.company });
    for (const o of owners || ownersOf(emp.id)) mailer.employerRejected(o, reason, appealUrl);
    record(user, 'verification-declined', { entityType: 'employer', entityId: emp.id, reason, detail: emp.company });
  }
  // The Clients tab's approve and decline buttons.
  clients.hooks.decided = (user, decision, emp, reason) => {
    if (decision === 'decline') afterDecline(user, emp, reason);
    else record(user, 'verification-verified', { entityType: 'employer', entityId: emp.id, detail: emp.company });
    noteOpenCases('employer', emp.id, user, `Verification: ${decision === 'decline' ? 'declined' : 'verified'}${reason ? ` (${reason})` : ''}`);
  };

  // ---------- case actions ----------
  const employerOfCase = (c) => (c.entityType === 'employer' ? c.entityId : c.entityType === 'job' ? c.employerId : '');
  function caseAction(user, id, input) {
    const c0 = caseById(id);
    if (!seesCase(user, c0)) return { status: 404, errors: ['case not found'] };
    const action = String(input.action || '');
    const spec = CASE_ACTIONS[action];
    if (!spec) return { status: 400, errors: [`action must be one of: ${Object.keys(CASE_ACTIONS).join(', ')}`] };
    if (!can(user, spec.perm)) return { status: 403, errors: ['your role does not allow that action'] };
    if (spec.strong && !strongOk(user)) return { status: 403, errors: ['turn on two-step sign-in (Sign-in security) before taking this action'] };
    if (spec.entity && !spec.entity.includes(c0.entityType)) return { status: 400, errors: ['that action does not apply to this case'] };
    if (CLOSED.includes(c0.status) && !['note', 'reopen'].includes(action)) return { status: 409, errors: ['this case is closed: reopen it first'] };
    const reason = clip(input.reason, 1000);
    if (reason.length < (action === 'note' ? 1 : 5)) return { status: 400, errors: [action === 'note' ? 'write the note' : 'give a reason (it is kept in the case history)'] };
    if (input.version !== undefined && input.version !== '' && Number(input.version) !== c0.version) return { status: 409, errors: ['someone else changed this case: reload it and try again'] };
    const job = c0.entityType === 'job' ? getJobs().find((j) => j.id === c0.entityId) : null;
    const empId = employerOfCase(c0);
    const emp = empId ? clients.read().find((e) => e.id === empId) : null;
    if (spec.entity && action.endsWith('-employer') && !emp) return { status: 409, errors: ['this case is not about a company account'] };
    if (spec.entity && action.endsWith('-job') && !job) return { status: 409, errors: ['the listing no longer exists'] };
    let effect = null;
    // Effects on the listing or the account first; the case records them after.
    if (action === 'request-correction') effect = decideJob(user, job.id, { decision: 'request-correction', reason, caseId: c0.id });
    else if (action === 'restrict-job') effect = decideJob(user, job.id, { decision: 'restrict', reason, caseId: c0.id });
    else if (action === 'remove-job') effect = decideJob(user, job.id, { decision: 'remove', reason, caseId: c0.id });
    else if (action === 'lift-job') effect = decideJob(user, job.id, { decision: 'lift', reason, caseId: c0.id });
    else if (action === 'clear-flags') effect = decideJob(user, job.id, { decision: 'clear', reason, caseId: c0.id });
    else if (action === 'suspend-employer') {
      if (emp.terminatedAt) return { status: 409, errors: ['this company account is closed'] };
      if (emp.suspension) return { status: 409, errors: ['this company is already suspended'] };
      verification.restrictCompany(emp.id, { suspension: { at: iso(), by: user.name, byId: user.id, reason, caseId: c0.id } });
      holdCompanyJobs(user, emp.id, 'account-suspended', reason, c0.id);
      const appealUrl = issueAppeal({ kind: 'employer-suspended', entityType: 'employer', entityId: emp.id, employerId: emp.id, caseId: c0.id, by: user, reason, label: emp.company });
      tellOwners(emp.id, { subject: `${emp.company}'s ${site.name} account is suspended`, heading: 'Your company account is suspended', lines: [`We have suspended ${emp.company}'s employer account while we look into a concern. Your jobs are hidden and nobody at the company can sign in for now.`, `Reason: ${reason}`], appealUrl });
      record(user, 'employer-suspended', { entityType: 'employer', entityId: emp.id, caseId: c0.id, reason, detail: emp.company });
    } else if (action === 'reinstate-employer') {
      if (emp.terminatedAt) return { status: 409, errors: ['a closed account comes back only through an appeal'] };
      if (!emp.suspension) return { status: 409, errors: ['this company is not suspended'] };
      verification.reinstateCompany(emp.id, user);
      releaseCompanyJobs(user, emp.id, reason);
      closeAppeals('employer', emp.id, 'Suspension lifted');
      tellOwners(emp.id, { subject: `${emp.company}'s ${site.name} account is active again`, heading: 'Your company account is active again', lines: [`We have lifted the suspension on ${emp.company}. You can sign in again and your jobs are back as they were.`] });
      record(user, 'employer-reinstated', { entityType: 'employer', entityId: emp.id, caseId: c0.id, reason, detail: emp.company });
    } else if (action === 'terminate-employer') {
      if (emp.terminatedAt) return { status: 409, errors: ['this company account is already closed'] };
      if (c0.pending) return { status: 409, errors: ['an account closure is already waiting for approval'] };
    } else if (action === 'approve-pending' || action === 'reject-pending') {
      if (!c0.pending) return { status: 409, errors: ['nothing is waiting for approval'] };
      if (action === 'approve-pending' && c0.pending.byId === user.id) return { status: 403, errors: ['someone other than the person who asked must approve this'] };
      if (action === 'approve-pending') {
        const target = clients.read().find((e) => e.id === c0.pending.employerId);
        if (!target || target.terminatedAt) return { status: 409, errors: ['this company account is already closed'] };
        verification.restrictCompany(target.id, { terminatedAt: iso(), terminatedBy: `${c0.pending.byName}, approved by ${user.name}`, terminationReason: c0.pending.reason, suspension: target.suspension || null });
        holdCompanyJobs(user, target.id, 'account-closed', c0.pending.reason, c0.id);
        const appealUrl = issueAppeal({ kind: 'employer-closed', entityType: 'employer', entityId: target.id, employerId: target.id, caseId: c0.id, by: { id: c0.pending.byId, name: c0.pending.byName }, reason: c0.pending.reason, label: target.company });
        tellOwners(target.id, { subject: `${target.company}'s ${site.name} account is closed`, heading: 'Your company account is closed', lines: [`We have closed ${target.company}'s employer account because it broke our rules.`, `Reason: ${c0.pending.reason}`], appealUrl });
        record(user, 'employer-closed', { entityType: 'employer', entityId: target.id, caseId: c0.id, reason: c0.pending.reason, detail: `asked by ${c0.pending.byName}, approved by ${user.name}: ${reason}` });
      } else record(user, 'closure-rejected', { entityType: 'employer', entityId: c0.pending.employerId, caseId: c0.id, reason, detail: `asked by ${c0.pending.byName}` });
    } else if (action === 'hold-postings') {
      if (emp.postingHold) return { status: 409, errors: ['new postings by this company are already on hold'] };
      if (emp.terminatedAt) return { status: 409, errors: ['this company account is closed'] };
      verification.setPostingHold(emp.id, { at: iso(), by: user.name, byId: user.id, reason, caseId: c0.id });
      const appealUrl = issueAppeal({ kind: 'employer-postings-held', entityType: 'employer', entityId: emp.id, employerId: emp.id, caseId: c0.id, by: user, reason, label: emp.company });
      tellOwners(emp.id, { subject: `New job postings by ${emp.company} are on hold`, heading: 'New job postings are on hold', lines: [`While we look into a concern, ${emp.company} cannot send new jobs for review. Jobs already live stay as they are, and you can still reply to candidates.`, `Reason: ${reason}`], appealUrl });
      record(user, 'employer-postings-held', { entityType: 'employer', entityId: emp.id, caseId: c0.id, reason, detail: emp.company });
      const a = assessments.latest('employer', emp.id);
      if (a) assessments.noteAction(a, 'restrict-capabilities', { by: user.name, detail: 'new postings held' });
    } else if (action === 'lift-postings') {
      if (!emp.postingHold) return { status: 409, errors: ['new postings by this company are not on hold'] };
      verification.setPostingHold(emp.id, null, user);
      closeAppeals('employer', emp.id, 'Posting hold lifted');
      tellOwners(emp.id, { subject: `${emp.company} can send new jobs again`, heading: 'New job postings are open again', lines: [`We have lifted the hold on new job postings for ${emp.company}.`] });
      record(user, 'employer-postings-released', { entityType: 'employer', entityId: emp.id, caseId: c0.id, reason, detail: emp.company });
    } else if (action === 'request-information') {
      const emails = [...new Set(c0.reports.map((r) => r.email).filter(Boolean))];
      if (!emails.length) return { status: 409, errors: ['nobody who reported this left an email address'] };
      for (const e of emails) mailer.trustReporterUpdate(e, { number: c0.number, kind: 'question', text: reason });
    }
    if (effect && effect.errors) return effect;
    const r = changeCase(c0.id, null, (c) => {
      if (!c.firstResponseAt && action !== 'note') c.firstResponseAt = iso();
      note(c, user, action, reason);
      if (action === 'terminate-employer') c.pending = { id: crypto.randomUUID(), action, employerId: emp.id, byId: user.id, byName: user.name, reason, at: iso() };
      if (action === 'approve-pending' || action === 'reject-pending') c.pending = null;
      if (!['note', 'resolve', 'dismiss', 'reopen', 'request-information'].includes(action) && c.status === 'open') c.status = 'under_review';
      if (action === 'request-information') c.status = 'awaiting_information';
      if (action === 'escalate') { c.escalated = true; c.escalatedAt = iso(); }
      if (action === 'reopen') { c.status = 'under_review'; c.resolvedAt = null; }
      if (action === 'resolve' || action === 'dismiss') {
        c.status = action === 'resolve' ? 'resolved' : 'dismissed';
        c.resolvedAt = iso();
        c.resolution = { outcome: c.status, reason, by: user.name, byId: user.id, at: iso() };
      }
      if (!['note', 'request-information', 'escalate', 'resolve', 'dismiss', 'reopen'].includes(action)) c.actions.push({ action, at: iso(), by: user.name, byId: user.id, reason });
    });
    if (r.errors) return r;
    const c = r.case;
    if (action === 'terminate-employer') {
      tell(`trust-closure:${c.pending.id}`, managers().filter((u) => u.id !== user.id && can(u, 'accounts.restrict')), `Approve an account closure (${c.number})`, `${user.name} asks to close ${emp.company}: ${reason}`, `/admin/cases/${c.id}`);
      record(user, 'closure-requested', { entityType: 'employer', entityId: emp.id, caseId: c.id, reason, detail: emp.company });
    }
    if (action === 'escalate') tell(`trust-escalate:${c.id}:${c.version}`, managers().filter((u) => u.id !== user.id), `Escalated: case ${c.number}`, `${user.name}: ${reason}`, `/admin/cases/${c.id}`);
    if ((action === 'resolve' || action === 'dismiss') && (input.notifyReporter === true || input.notifyReporter === '1' || input.notifyReporter === 'on')) {
      const text = action === 'dismiss' ? 'We looked into it carefully and did not find a breach of our rules.' : 'We looked into it and took the action our rules call for.';
      for (const e of new Set(c.reports.map((x) => x.email).filter(Boolean))) mailer.trustReporterUpdate(e, { number: c.number, kind: 'outcome', text });
    }
    if (!['note'].includes(action) && !action.endsWith('-job') && !['request-correction', 'clear-flags', 'suspend-employer', 'reinstate-employer', 'terminate-employer', 'approve-pending', 'reject-pending', 'hold-postings', 'lift-postings'].includes(action)) record(user, `case-${action}`, { entityType: c.entityType, entityId: c.entityId, caseId: c.id, reason });
    return { status: 200, case: c };
  }
  // Status, assignment or priority, under the case's version.
  function patchCase(user, id, input) {
    const c0 = caseById(id);
    if (!seesCase(user, c0)) return { status: 404, errors: ['case not found'] };
    if (input.version === undefined || input.version === null || input.version === '') return { status: 400, errors: ['version is required (from the case you are changing)'] };
    const errors = [];
    const out = {};
    if (input.status !== undefined && input.status !== c0.status) {
      if (!STATUSES.includes(input.status)) errors.push(`status must be one of: ${STATUSES.join(', ')}`);
      else if (!MOVES[c0.status].includes(input.status)) errors.push(`a case that is ${STATUS_LABEL[c0.status]} cannot move to ${STATUS_LABEL[input.status]}`);
      else if (CLOSED.includes(c0.status) && !can(user, 'cases.manage')) errors.push('only a Trust & Safety Manager can reopen a case');
      else out.status = input.status;
    }
    const reason = clip(input.reason, 1000);
    if (out.status && CLOSED.includes(out.status) && reason.length < 5) errors.push('give the reason for closing the case');
    if (input.assigneeId !== undefined && input.assigneeId !== c0.assigneeId) {
      if (!can(user, 'cases.manage')) errors.push('only a Trust & Safety Manager can assign cases');
      else if (input.assigneeId === '' || input.assigneeId === null) out.assignee = null;
      else {
        const u = reviewers().find((x) => x.id === input.assigneeId);
        if (!u) errors.push('assign to an active team member whose role handles cases');
        else out.assignee = u;
      }
    }
    if (input.priority !== undefined && input.priority !== c0.priority) {
      if (!can(user, 'cases.manage')) errors.push('only a Trust & Safety Manager can change priority');
      else if (!PRIORITIES.includes(input.priority)) errors.push(`priority must be one of: ${PRIORITIES.join(', ')}`);
      else out.priority = input.priority;
    }
    if (errors.length) return { status: 400, errors };
    if (!Object.keys(out).length) return { status: 200, case: c0 };
    const r = changeCase(id, input.version, (c) => {
      if (!c.firstResponseAt) c.firstResponseAt = iso();
      if (out.status) {
        note(c, user, 'status', `${STATUS_LABEL[c.status]} → ${STATUS_LABEL[out.status]}${reason ? `: ${reason}` : ''}`);
        c.status = out.status;
        if (CLOSED.includes(out.status)) { c.resolvedAt = iso(); c.resolution = { outcome: out.status, reason, by: user.name, byId: user.id, at: iso() }; } else c.resolvedAt = null;
      }
      if (out.assignee !== undefined) {
        note(c, user, 'assigned', out.assignee ? `Assigned to ${out.assignee.name}` : 'Unassigned');
        c.assigneeId = out.assignee ? out.assignee.id : '';
        c.assigneeName = out.assignee ? out.assignee.name : '';
      }
      if (out.priority) { note(c, user, 'priority', `Priority set to ${out.priority}`); c.priorityOverride = out.priority; c.escalated = out.priority === 'high' ? c.escalated : false; }
    });
    if (r.errors) return r;
    if (out.assignee && out.assignee.id !== user.id) tell(`trust-assign:${id}:${r.case.version}`, [out.assignee], `Case ${r.case.number} assigned to you`, `${CATEGORIES[r.case.category] || r.case.category}: ${r.case.entityLabel}`, `/admin/cases/${id}`);
    record(user, 'case-updated', { entityType: r.case.entityType, entityId: r.case.entityId, caseId: id, reason, detail: [out.status && `status ${out.status}`, out.assignee !== undefined && `assignee ${out.assignee ? out.assignee.name : 'none'}`, out.priority && `priority ${out.priority}`].filter(Boolean).join(', ') });
    return r;
  }
  function searchCases(user, q = {}) {
    const text = normal(q.q);
    const mine = q.assignee === 'me' ? user.id : q.assignee === 'none' ? '' : q.assignee;
    return cases()
      .filter((c) => seesCase(user, c))
      .filter((c) => (q.status === 'closed' ? CLOSED.includes(c.status) : STATUSES.includes(q.status) ? c.status === q.status : q.status === 'all' ? true : !CLOSED.includes(c.status)))
      .filter((c) => !PRIORITIES.includes(q.priority) || c.priority === q.priority)
      .filter((c) => !ENTITY_TYPES.includes(q.entityType) || c.entityType === q.entityType)
      .filter((c) => !CATEGORIES[q.category] || c.category === q.category)
      .filter((c) => q.assignee === undefined || q.assignee === '' || c.assigneeId === mine)
      .filter((c) => !text || normal(`${c.number} ${c.entityLabel} ${c.entityId}`).includes(text))
      .sort((a, b) => PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority) || a.createdAt.localeCompare(b.createdAt));
  }
  // What reviewers see of a case: reporter emails only to those who handle it.
  const caseSummary = (c) => ({
    id: c.id, number: c.number, source: c.source, entityType: c.entityType, entityId: c.entityId, entityLabel: c.entityLabel, category: c.category, categoryLabel: CATEGORIES[c.category] || c.category,
    priority: c.priority, status: c.status, statusLabel: STATUS_LABEL[c.status], assigneeId: c.assigneeId || null, assigneeName: c.assigneeName || null, reports: c.reports.length, flags: c.flags.map((f) => f.code),
    escalated: Boolean(c.escalated), awaitingApproval: Boolean(c.pending), version: c.version, createdAt: c.createdAt, updatedAt: c.updatedAt, resolvedAt: c.resolvedAt,
  });
  const caseDetail = (c) => ({
    ...caseSummary(c),
    reports: c.reports.map((r) => ({ id: r.id, at: r.at, category: r.category, details: r.details, reporterType: r.reporterType, email: r.email || null })),
    flagsDetail: c.flags, evidence: c.evidence.map((e) => ({ id: e.id, name: e.originalName, size: e.size, by: e.by, at: e.at })),
    actions: c.actions, history: c.history, pending: c.pending ? { action: c.pending.action, by: c.pending.byName, reason: c.pending.reason, at: c.pending.at } : null, resolution: c.resolution,
  });

  // ---------- evidence ----------
  const evidenceDir = path.join(uploadsDir, 'trust-evidence');
  fs.mkdirSync(evidenceDir, { recursive: true });
  const evidenceUpload = multer({
    storage: multer.diskStorage({ destination: evidenceDir, filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`) }),
    limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 20 },
    fileFilter: (req, file, cb) => {
      const ok = DOCUMENT_TYPES.includes(path.extname(file.originalname).toLowerCase());
      cb(ok ? null : Object.assign(new Error('Evidence must be a PDF, JPG or PNG file'), { status: 400 }), ok);
    },
  });
  // Multer errors (wrong type, too big) as a 400 answer, not a crash.
  const takeEvidence = (req, res, next) => evidenceUpload.single('evidence')(req, res, (err) => {
    if (!err) return next();
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'Evidence files can be up to 5 MB' : err.status === 400 ? err.message : 'That upload did not work';
    if ((req.get('Accept') || '').includes('json')) return res.status(400).json({ ok: false, errors: [message] });
    return res.status(400).render('thanks', { title: 'Upload not accepted', page: '', ok: false, message, noindex: true });
  });
  async function addEvidence(user, id, file) {
    const c = caseById(id);
    const drop = () => file && fs.unlink(file.path, () => {});
    if (!seesCase(user, c)) { drop(); return { status: 404, errors: ['case not found'] }; }
    if (!file) return { status: 400, errors: ['choose a PDF, JPG or PNG file'] };
    const bad = await vetDocument(file);
    if (bad) return { status: 400, errors: [bad] };
    const ev = { id: crypto.randomUUID(), file: path.basename(file.filename), originalName: clip(file.originalname, 120), size: file.size, sha256: sha256(vault.readSync(file.path)), by: user.name, byId: user.id, at: iso() };
    const r = changeCase(id, null, (k) => { k.evidence.push(ev); note(k, user, 'evidence', `Added evidence: ${ev.originalName}`); if (!k.firstResponseAt) k.firstResponseAt = iso(); });
    record(user, 'evidence-added', { entityType: c.entityType, entityId: c.entityId, caseId: id, detail: `${ev.originalName} (${ev.sha256.slice(0, 12)})` });
    return r;
  }
  function sendEvidence(req, res, next) {
    const c = caseById(req.params.id);
    if (!seesCase(req.admin, c)) return next();
    const ev = c.evidence.find((e) => e.id === req.params.eid && !e.purgedAt);
    if (!ev) return next();
    if (!downloadLinks.valid(req)) return linkExpired(res, `/admin/cases/${c.id}`);
    const file = path.join(evidenceDir, path.basename(ev.file));
    if (!fs.existsSync(file)) return next();
    record(req.admin, 'evidence-viewed', { entityType: c.entityType, entityId: c.entityId, caseId: c.id, detail: ev.originalName });
    vault.send(res, file, `${c.number}-evidence${path.extname(ev.file)}`, 'Complaint evidence');
  }

  // ---------- appeals: the company's side and the decision ----------
  const appealByToken = (token) => (/^[a-f0-9]{48}$/.test(token) ? appeals().find((a) => a.tokenHash === sha256(token)) || null : null);
  const APPEAL_KIND = { 'job-restricted': 'Listing unpublished', 'job-removed': 'Listing removed', 'employer-suspended': 'Company account suspended', 'employer-closed': 'Company account closed', 'verification-declined': 'Company sign-up declined', 'employer-postings-held': 'New job postings on hold' };
  function submitAppeal(token, statement) {
    return db.transaction(() => {
      const a = appealByToken(token);
      if (!a) return { status: 404, errors: ['this appeal link is not valid'] };
      if (a.status !== 'available') return { status: 409, errors: [a.status === 'pending' ? 'we already have your appeal' : 'this decision can no longer be appealed'] };
      if (a.expiresAt < iso()) return { status: 410, errors: ['the time to appeal this decision has passed'] };
      const text = clip(statement, 2000);
      if (text.length < 20) return { status: 400, errors: ['tell us in a few sentences why the decision is wrong (at least 20 characters)'] };
      if (urlCount(text) > 5) return { status: 400, errors: ['please include no more than five links'] };
      const next = { ...a, status: 'pending', statement: text, submittedAt: iso(), version: a.version + 1, history: [...a.history, { at: iso(), text: 'Appeal sent by the company' }] };
      db.update(APPEALS, next);
      record({ id: '', name: 'Company (appeal link)', role: 'Client Employer' }, 'appeal-submitted', { entityType: a.entityType, entityId: a.entityId, caseId: a.caseId, detail: APPEAL_KIND[a.kind] || a.kind });
      tell(`trust-appeal:${a.id}`, team.members().filter((u) => can(u, 'appeals.decide') && u.id !== a.decisionById), 'New appeal to review', `${APPEAL_KIND[a.kind] || a.kind}: ${a.label}`, '/admin/appeals');
      if (a.caseId) changeCase(a.caseId, null, (c) => note(c, null, 'appeal', 'The company appealed the decision'));
      return { status: 200, appeal: next };
    });
  }
  function decideAppeal(user, id, input) {
    if (!can(user, 'appeals.decide')) return { status: 403, errors: ['your role does not allow deciding appeals'] };
    if (!strongOk(user)) return { status: 403, errors: ['turn on two-step sign-in (Sign-in security) before deciding appeals'] };
    const a = appeals().find((x) => x.id === id);
    if (!a) return { status: 404, errors: ['appeal not found'] };
    if (a.status !== 'pending') return { status: 409, errors: ['this appeal is not waiting for a decision'] };
    if (input.version !== undefined && input.version !== '' && Number(input.version) !== a.version) return { status: 409, errors: ['this appeal changed: reload it'] };
    if (a.decisionById && a.decisionById === user.id) return { status: 403, errors: ['someone who did not make the original decision must review the appeal'] };
    const outcome = String(input.outcome || '');
    const reason = clip(input.reason, 1000);
    if (!['upheld', 'overturned'].includes(outcome)) return { status: 400, errors: ['outcome must be upheld (the decision stands) or overturned'] };
    if (reason.length < 5) return { status: 400, errors: ['give the reason (the company sees it)'] };
    // Mark it first, so a second reviewer at the same moment gets a conflict.
    const claimed = db.transaction(() => {
      const cur = appeals().find((x) => x.id === id);
      if (cur.status !== 'pending') return null;
      const next = { ...cur, status: outcome, review: { byId: user.id, by: user.name, outcome, reason, at: iso() }, version: cur.version + 1, history: [...cur.history, { at: iso(), text: `${outcome === 'overturned' ? 'Overturned' : 'Upheld'} by ${user.name}` }] };
      db.update(APPEALS, next);
      return next;
    });
    if (!claimed) return { status: 409, errors: ['this appeal was just decided by someone else'] };
    if (outcome === 'overturned') {
      if (a.kind === 'job-restricted' || a.kind === 'job-removed') {
        const job = getJobs().find((j) => j.id === a.entityId);
        if (job && job.moderation && job.moderation.locked) unlockJob(user, job, `Appeal overturned: ${reason}`, { restore: true });
      } else if (a.kind === 'employer-suspended' || a.kind === 'employer-closed') {
        const emp = clients.read().find((e) => e.id === a.entityId);
        // A suspension appeal can't reopen an account that was closed since.
        if (emp && (a.kind === 'employer-closed' ? emp.terminatedAt : emp.suspension && !emp.terminatedAt)) { verification.reinstateCompany(emp.id, user); releaseCompanyJobs(user, emp.id, `Appeal overturned: ${reason}`); }
      } else if (a.kind === 'verification-declined') verification.reopenVerification(a.entityId, user);
      else if (a.kind === 'employer-postings-held') verification.setPostingHold(a.entityId, null, user);
    }
    tellOwners(a.employerId, {
      subject: `Your appeal: ${APPEAL_KIND[a.kind] || 'our decision'}`, heading: outcome === 'overturned' ? 'We changed our decision' : 'Our decision stands',
      lines: [outcome === 'overturned' ? `We reviewed your appeal about ${a.label} and reversed the decision.` : `We reviewed your appeal about ${a.label} carefully, and the decision stands.`, `Reason: ${reason}`],
    });
    if (a.caseId) changeCase(a.caseId, null, (c) => note(c, user, 'appeal', `Appeal ${outcome}: ${reason}`));
    record(user, `appeal-${outcome}`, { entityType: a.entityType, entityId: a.entityId, caseId: a.caseId, reason, detail: `${APPEAL_KIND[a.kind] || a.kind}; original decision by ${a.decisionBy}` });
    return { status: 200, appeal: claimed };
  }
  const appealJson = (a) => ({ id: a.id, kind: a.kind, kindLabel: APPEAL_KIND[a.kind] || a.kind, label: a.label, status: a.status, decisionBy: a.decisionBy, decisionReason: a.decisionReason, decidedAt: a.decidedAt, statement: a.statement || null, submittedAt: a.submittedAt || null, review: a.review || null, caseId: a.caseId || null, version: a.version });

  // ---------- combined audit history ----------
  const SOURCES = {
    trust: { label: 'Trust & safety', read: () => db.all(AUDIT).map((e) => ({ at: e.at, actor: e.actorName, role: e.role, action: e.action, entity: [e.entityType, e.entityId].filter(Boolean).join(' '), detail: [e.reason, e.detail].filter(Boolean).join(' · '), seq: e.seq })) },
    agency: { label: 'Agency & staffing', read: () => readSubmissions('agency-audit').map((e) => ({ at: e.createdAt, actor: e.actorName, role: e.role, action: e.action, entity: [e.entity, e.entityId].filter(Boolean).join(' '), detail: e.detail })) },
    crm: { label: 'Sales CRM', read: () => readSubmissions('crm-audit').map((e) => ({ at: e.createdAt, actor: e.actorName, role: e.role, action: e.action, entity: [e.entity, e.entityId].filter(Boolean).join(' '), detail: e.detail })) },
    workforce: { label: 'Workforce', read: () => readSubmissions('workforce-audit').map((e) => ({ at: e.createdAt, actor: e.actorName, role: e.actorKind, action: e.action, entity: [e.entity, e.entityId].filter(Boolean).join(' '), detail: e.detail })) },
    employers: { label: 'Employer accounts', read: () => readSubmissions('employer-audit').map((e) => ({ at: e.createdAt, actor: e.actor, role: 'Employer', action: e.event, entity: `employer ${e.employerId}`, detail: e.detail })) },
    team: { label: 'Team sign-ins & changes', read: () => db.all('activity').map((e) => ({ at: e.at, actor: e.userName, role: '', action: e.action, entity: '', detail: e.detail })) },
  };
  function auditLog(q = {}) {
    const src = SOURCES[q.source] ? [q.source] : Object.keys(SOURCES);
    const text = normal(q.q);
    const from = /^\d{4}-\d{2}-\d{2}$/.test(q.from || '') ? q.from : '';
    const to = /^\d{4}-\d{2}-\d{2}$/.test(q.to || '') ? q.to : '';
    return src.flatMap((k) => SOURCES[k].read().map((e) => ({ ...e, source: k, sourceLabel: SOURCES[k].label })))
      .filter((e) => (!from || e.at >= from) && (!to || e.at.slice(0, 10) <= to))
      .filter((e) => !text || normal(`${e.actor} ${e.action} ${e.entity} ${e.detail}`).includes(text))
      .sort((a, b) => String(b.at).localeCompare(String(a.at)));
  }

  // ---------- metrics and health ----------
  function overview() {
    syncChecks();
    const now = iso();
    const since = (days) => iso(Date.now() - days * DAY);
    const checks = readSubmissions(CHECKS);
    const openChecks = checks.filter((v) => verification.OPEN_CHECKS.includes(v.status));
    const decided30 = checks.filter((v) => v.reviewedAt && v.reviewedAt >= since(30));
    const all = cases();
    const open = all.filter((c) => !CLOSED.includes(c.status));
    const closed30 = all.filter((c) => c.resolvedAt && c.resolvedAt >= since(30));
    const responded30 = all.filter((c) => c.firstResponseAt && c.createdAt >= since(30));
    const ap = appeals();
    const decidedAppeals = ap.filter((a) => ['upheld', 'overturned'].includes(a.status) && a.review && a.review.at >= since(90));
    const queue = moderationQueue({});
    const workload = {};
    for (const c of open) { const k = c.assigneeName || 'Unassigned'; workload[k] = (workload[k] || 0) + 1; }
    return {
      verification: {
        waiting: openChecks.filter((v) => v.status === 'pending').length, awaitingCompany: openChecks.filter((v) => v.status === 'info-requested').length,
        oldestHours: openChecks.length ? Math.round(Math.max(...openChecks.map((v) => hoursBetween(v.resubmittedAt || v.signedUpAt || v.createdAt, now)))) : 0,
        medianHours30d: median(decided30.map((v) => hoursBetween(v.resubmittedAt || v.signedUpAt || v.createdAt, v.reviewedAt)).filter((h) => h >= 0)), decided30d: decided30.length,
      },
      listings: { waitingReview: queue.filter((r) => r.kinds.includes('pending')).length, flagged: queue.filter((r) => r.kinds.includes('flagged')).length, reported: queue.filter((r) => r.kinds.includes('reported')).length, restricted: getJobs().filter((j) => j.moderation && j.moderation.locked).length },
      cases: {
        open: open.length, byStatus: Object.fromEntries(STATUSES.filter((s) => !CLOSED.includes(s)).map((s) => [s, open.filter((c) => c.status === s).length])),
        high: open.filter((c) => c.priority === 'high').length, unassigned: open.filter((c) => !c.assigneeId).length, awaitingApproval: open.filter((c) => c.pending).length,
        medianFirstResponseHours30d: median(responded30.map((c) => hoursBetween(c.createdAt, c.firstResponseAt))), medianResolutionHours30d: median(closed30.map((c) => hoursBetween(c.createdAt, c.resolvedAt))), closed30d: closed30.length,
      },
      appeals: { waiting: ap.filter((a) => a.status === 'pending').length, decided90d: decidedAppeals.length, overturned90d: decidedAppeals.filter((a) => a.status === 'overturned').length, overturnPercent: decidedAppeals.length ? Math.round((decidedAppeals.filter((a) => a.status === 'overturned').length / decidedAppeals.length) * 100) : null },
      workload: Object.entries(workload).map(([name, n]) => ({ name, open: n })).sort((a, b) => b.open - a.open),
      risk: riskOverview(since),
    };
  }
  // Suspicious activity, holds, repeat violators and how often the automated
  // signals were wrong (a moderator cleared them).
  function riskOverview(since) {
    const list = assessments.all();
    const current = list.filter((a) => !a.supersededAt);
    const recent = list.filter((a) => a.assessedAt >= since(30) && risk.SEVERITY[a.level] >= risk.SEVERITY.high);
    const reviewed = list.filter((a) => a.review && a.review.at >= since(90));
    const falsePositives = reviewed.filter((a) => a.review.verdict === 'false-positive').length;
    return {
      suspicious30d: new Set(recent.map((a) => `${a.entityType}:${a.entityId}`)).size,
      byLevel: Object.fromEntries(risk.LEVELS.map((l) => [l, current.filter((a) => a.rules.length && a.level === l).length])),
      jobsOnHold: getJobs().filter((j) => j.reviewHold).length,
      postingHolds: clients.read().filter((e) => e.postingHold).length,
      repeatViolators: current.filter((a) => a.entityType === 'employer' && a.rules.some((r) => r.code === 'repeat-violations')).length,
      reviewed90d: reviewed.length, falsePositives90d: falsePositives, falsePositivePercent: reviewed.length ? Math.round((falsePositives / reviewed.length) * 100) : null,
    };
  }
  function health() {
    let dbOk = true;
    let dbMs = 0;
    const t0 = Date.now();
    try { db.count('jobs'); dbMs = Date.now() - t0; } catch (e) { dbOk = false; }
    const n = notify.stats();
    const problems = notify.problems();
    const snap = ops ? ops.snapshot() : { jobs: [], recentErrors: [] };
    const b = backups && backups.status ? backups.status() : null;
    const chain = verifyChain();
    const failingJobs = snap.jobs.filter((j) => j.failing || j.overdue);
    const status = !dbOk ? 'down' : failingJobs.length || problems.length || !chain.ok || (snap.serverErrorPercent || 0) >= 5 ? 'degraded' : 'ok';
    return {
      status, checkedAt: iso(),
      database: { ok: dbOk, ms: dbMs },
      requests: { last24h: snap.requests24h || 0, serverErrors24h: snap.serverErrors24h || 0, clientErrors24h: snap.clientErrors24h || 0, serverErrorPercent: snap.serverErrorPercent || 0, availabilityPercent: snap.availabilityPercent ?? 100, byHour: snap.byHour || [] },
      process: { uptimeSeconds: Math.round(process.uptime()), memoryMb: Math.round(process.memoryUsage().rss / 1048576) },
      notifications: { queued: n.queued, retrying: n.retrying, oldestQueuedMinutes: n.oldestQueuedMinutes, failed24h: n.failed24h, bounceRate: n.bounceRate, problems },
      backgroundJobs: snap.jobs.map((j) => ({ name: j.name, runs: j.runs, failures: j.failures, lastRunAt: j.lastRunAt, lastOkAt: j.lastOkAt, lastError: j.lastError || null, lastErrorAt: j.lastErrorAt, lastMs: j.lastMs, overdue: j.overdue, failing: j.failing })),
      recentErrors: snap.recentErrors || [],
      backups: backups ? { lastBackupAt: (b && b.at) || null, ok: Boolean(b && b.ok), warning: cleanMessage(backups.warning() || '') || null } : null,
      auditTrail: chain,
    };
  }
  // Failed emails for the operations view: what and why, never who.
  const failedDeliveries = () => db.where('notification-deliveries', 'status', 'failed', { limit: 30 }).map((d) => ({ id: d.id, type: d.type, template: d.template, attempts: d.attempts, failedAt: d.failedAt || d.updatedAt || d.createdAt, lastError: cleanMessage(d.lastError) }));

  // ---------- retention ----------
  // Two years after a case closes, what people wrote and uploaded goes; the
  // case outline and the audit trail stay.
  function prune() {
    const cutoff = iso(Date.now() - RETENTION_MONTHS * 30 * DAY);
    let n = 0;
    for (const c of cases().filter((x) => CLOSED.includes(x.status) && x.resolvedAt && x.resolvedAt < cutoff && !x.purgedAt)) {
      for (const e of c.evidence) if (e.file) fs.unlink(path.join(evidenceDir, path.basename(e.file)), () => {});
      db.update(CASES, { ...c, reports: c.reports.map((r) => ({ id: r.id, at: r.at, category: r.category, reporterType: r.reporterType, details: '', email: '' })), evidence: c.evidence.map((e) => ({ id: e.id, at: e.at, by: e.by, originalName: 'removed', size: 0, purgedAt: iso() })), history: c.history.map((h) => ({ ...h, text: h.action === 'opened' ? h.text : '' })), purgedAt: iso() });
      n++;
    }
    for (const a of appeals().filter((x) => x.statement && (x.review ? x.review.at : x.expiresAt) < cutoff)) db.update(APPEALS, { ...a, statement: '', purgedAt: iso() });
    // Report receipts (references and tracking links) and old assessments.
    const oldReceipts = db.all(RECEIPTS).filter((r) => r.createdAt < cutoff);
    if (oldReceipts.length) db.remove(RECEIPTS, oldReceipts.map((r) => r.id));
    assessments.prune(cutoff);
    return n;
  }
  const pruneJob = ops ? ops.track('trust-retention', prune, DAY) : prune;

  // ---------- pages ----------
  const json = (req) => (req.get('Accept') || '').includes('json');
  const gate = (action) => (req, res, next) => {
    if (can(req.admin, action)) return next();
    if (json(req)) return res.status(403).json({ ok: false, errors: ['your role does not allow that'] });
    res.status(403).render('thanks', { title: 'Not part of your role', page: '', ok: false, message: 'Your role does not include this page. Ask an Admin on your team if you need it.', noindex: true });
  };
  const view = (req, res, locals, status = 200) => {
    res.set('Cache-Control', 'no-store');
    res.status(status).render('admin-trust', {
      page: 'admin', noindex: true, admin: req.admin, errors: [], msg: clip(req.query.msg, 300), roleLabel: (roles.ROLE_INFO[req.admin.role] || {}).label || req.admin.role,
      can: (a) => can(req.admin, a), CATEGORIES, STATUS_LABEL, ENTITY_LABEL, CASE_ACTIONS, MODERATION_DECISIONS, VERIFY_DECISIONS, APPEAL_KIND, PRIORITIES, STATUSES, MOVES, CLOSED, strong: strongOk(req.admin), RISK_ACTIONS: risk.ACTIONS, docLinks: {}, assessment: null, assessmentHistory: [], ...locals,
    });
  };
  const back = (res, url, msg) => res.redirect(303, `${url}${url.includes('?') ? '&' : '?'}msg=${encodeURIComponent(msg)}`);
  const pageOf = (list, req, pathName, size = 25) => paginate(list, { page: req.query.page, size, query: req.query, path: pathName });

  app.get('/admin/overview', adminAuth, gate('trust.overview'), (req, res) => view(req, res, { title: 'Platform overview', section: 'overview', o: overview(), h: can(req.admin, 'ops.health') ? health() : null }));

  app.get('/admin/verifications', adminAuth, gate('verify.review'), (req, res) => {
    const { rows, pager } = pageOf(verificationQueue(req.query), req, '/admin/verifications');
    // Signed, short-lived links to documents; each opening is logged.
    const docLinks = Object.fromEntries(rows.flatMap((r) => (r.check.documents || []).filter((d) => !d.purgedAt).map((d) => [d.id, downloadLinks.signed(`/admin/verifications/${r.check.id}/documents/${d.id}`)])));
    view(req, res, { title: 'Employer verification', section: 'verifications', rows, pager, q: req.query, pol: policy(), docLinks });
  });
  app.post('/admin/verifications/:id/decision', adminAuth, gate('verify.review'), sameOrigin, (req, res) => {
    const r = decideVerification(req.admin, req.params.id, req.body);
    back(res, '/admin/verifications', r.errors ? `Not saved: ${r.errors.join('; ')}` : `${r.employer.company}: ${VERIFY_DECISIONS[req.body.decision]} · recorded`);
  });

  app.get('/admin/verifications/:id/documents/:docId', adminAuth, gate('verify.review'), (req, res, next) => {
    const check = readSubmissions(CHECKS).find((v) => v.id === req.params.id);
    const doc = check && (check.documents || []).find((d) => d.id === req.params.docId && !d.purgedAt);
    if (!doc) return next();
    if (!downloadLinks.valid(req)) return linkExpired(res, '/admin/verifications');
    const file = path.join(uploadsDir, 'verification-documents', path.basename(doc.file));
    if (!fs.existsSync(file)) return next();
    record(req.admin, 'verification-document-viewed', { entityType: 'employer', entityId: check.employerId, detail: `${doc.typeLabel || doc.type} (${doc.sha256.slice(0, 12)})` });
    vault.send(res, file, `verification-${doc.type}${path.extname(doc.file)}`, 'Verification document');
  });
  // A reviewer's verdict on automated signals: confirmed, or a false positive.
  app.post('/admin/risk/:id/review', adminAuth, gate('cases.view'), sameOrigin, (req, res) => {
    const a = assessments.all().find((x) => x.id === req.params.id);
    const backTo = String(req.body.back || '').startsWith('/admin/') && !String(req.body.back).startsWith('//') ? String(req.body.back) : '/admin/reports';
    if (!a) return back(res, backTo, 'Not saved: assessment not found');
    if (!can(req.admin, a.entityType === 'job' ? 'jobs.moderate' : 'cases.manage')) return back(res, backTo, 'Not saved: your role does not allow that');
    const verdict = ['confirmed', 'false-positive'].includes(req.body.verdict) ? req.body.verdict : '';
    const reason = clip(req.body.note, 300);
    if (!verdict || reason.length < 5) return back(res, backTo, 'Not saved: choose a verdict and say why');
    assessments.review(a, { by: req.admin.name, verdict, note: reason });
    record(req.admin, 'risk-reviewed', { entityType: a.entityType, entityId: a.entityId, reason, detail: `${verdict} (${a.level})` });
    back(res, backTo, 'Verdict recorded');
  });

  app.get('/admin/job-moderation', adminAuth, gate('jobs.review'), (req, res) => {
    const { rows, pager } = pageOf(moderationQueue(req.query), req, '/admin/job-moderation');
    view(req, res, { title: 'Job moderation', section: 'moderation', rows, pager, q: req.query });
  });
  app.get('/admin/job-moderation/:id', adminAuth, gate('jobs.review'), (req, res, next) => {
    const job = getJobs().find((j) => j.id === req.params.id && !j.sample);
    if (!job) return next();
    const related = cases().filter((c) => c.entityType === 'job' && c.entityId === job.id).filter((c) => seesCase(req.admin, c));
    view(req, res, { title: `Review: ${job.title}`, section: 'moderation-job', job, related, emp: job.employerId ? clients.read().find((e) => e.id === job.employerId) || null : null, jobPath, assessment: assessments.latest('job', job.id), assessmentHistory: assessments.historyOf('job', job.id).slice(0, 10) });
  });
  app.post('/admin/job-moderation/:id/decision', adminAuth, gate('jobs.review'), sameOrigin, (req, res) => {
    const r = decideJob(req.admin, req.params.id, req.body);
    back(res, r.status === 404 ? '/admin/job-moderation' : `/admin/job-moderation/${encodeURIComponent(req.params.id)}`, r.errors ? `Not saved: ${r.errors.join('; ')}` : `${MODERATION_DECISIONS[req.body.decision]}: recorded`);
  });

  app.get('/admin/reports', adminAuth, gate('cases.view'), (req, res) => {
    const { rows, pager } = pageOf(searchCases(req.admin, req.query), req, '/admin/reports');
    view(req, res, { title: 'Reports & complaints', section: 'cases', rows, pager, q: req.query, people: can(req.admin, 'cases.manage') ? reviewers() : [] });
  });
  app.get('/admin/cases/:id', adminAuth, gate('cases.view'), (req, res, next) => {
    const c = caseById(req.params.id);
    if (!seesCase(req.admin, c)) return next();
    const job = c.entityType === 'job' ? getJobs().find((j) => j.id === c.entityId) || null : null;
    const emp = employerOfCase(c) ? clients.read().find((e) => e.id === employerOfCase(c)) || null : null;
    const evidenceLinks = Object.fromEntries(c.evidence.filter((e) => !e.purgedAt).map((e) => [e.id, downloadLinks.signed(`/admin/cases/${c.id}/evidence/${e.id}`)]));
    const caseAppeals = appeals().filter((a) => a.caseId === c.id).map(appealJson);
    const assessment = assessments.latest(c.entityType, c.entityId);
    view(req, res, { title: `Case ${c.number}`, section: 'case', c, job, emp, evidenceLinks, caseAppeals, people: can(req.admin, 'cases.manage') ? reviewers() : [], assessment, assessmentHistory: assessments.historyOf(c.entityType, c.entityId).slice(0, 10), employerRisk: emp && c.entityType === 'job' ? assessments.latest('employer', emp.id) : null });
  });
  app.post('/admin/cases/:id', adminAuth, gate('cases.view'), sameOrigin, (req, res) => {
    const input = { version: req.body.version, reason: req.body.reason };
    for (const k of ['status', 'assigneeId', 'priority']) if (req.body[k] !== undefined && req.body[k] !== '__keep') input[k] = req.body[k];
    const r = patchCase(req.admin, req.params.id, input);
    back(res, r.status === 404 ? '/admin/reports' : `/admin/cases/${req.params.id}`, r.errors ? `Not saved: ${r.errors.join('; ')}` : 'Case updated');
  });
  app.post('/admin/cases/:id/actions', adminAuth, gate('cases.view'), sameOrigin, (req, res) => {
    const r = caseAction(req.admin, req.params.id, req.body);
    back(res, r.status === 404 ? '/admin/reports' : `/admin/cases/${req.params.id}`, r.errors ? `Not done: ${r.errors.join('; ')}` : `${CASE_ACTIONS[req.body.action].label}: done`);
  });
  app.post('/admin/cases/:id/evidence', adminAuth, gate('cases.view'), limit('trust-evidence', 30), sameOrigin, takeEvidence, async (req, res, next) => {
    try {
      const r = await addEvidence(req.admin, req.params.id, req.file);
      back(res, r.status === 404 ? '/admin/reports' : `/admin/cases/${req.params.id}`, r.errors ? `Not added: ${r.errors.join('; ')}` : 'Evidence added');
    } catch (err) { next(err); }
  });
  app.get('/admin/cases/:id/evidence/:eid', adminAuth, gate('cases.view'), (req, res, next) => sendEvidence(req, res, next));

  app.get('/admin/appeals', adminAuth, gate('cases.view'), (req, res) => {
    const status = ['pending', 'upheld', 'overturned'].includes(req.query.status) ? req.query.status : 'pending';
    const visible = (a) => can(req.admin, 'appeals.decide') || (a.caseId && seesCase(req.admin, caseById(a.caseId)));
    const { rows, pager } = pageOf(appeals().filter((a) => a.status === status).filter(visible), req, '/admin/appeals');
    view(req, res, { title: 'Appeals', section: 'appeals', rows, pager, q: { ...req.query, status } });
  });
  app.post('/admin/appeals/:id/decision', adminAuth, gate('appeals.decide'), sameOrigin, (req, res) => {
    const r = decideAppeal(req.admin, req.params.id, req.body);
    back(res, '/admin/appeals', r.errors ? `Not saved: ${r.errors.join('; ')}` : `Appeal ${r.appeal.status}`);
  });

  app.get('/admin/audit-logs', adminAuth, gate('audit.platform'), (req, res) => {
    const { rows, pager } = pageOf(auditLog(req.query), req, '/admin/audit-logs', 50);
    view(req, res, { title: 'Audit history', section: 'audit', rows, pager, q: req.query, sources: Object.fromEntries(Object.entries(SOURCES).map(([k, v]) => [k, v.label])), chain: verifyChain() });
  });
  app.get('/admin/system-health', adminAuth, gate('ops.health'), (req, res) => view(req, res, { title: 'System health', section: 'health', h: health(), failed: failedDeliveries() }));
  app.post('/admin/system-health/deliveries/:id/retry', adminAuth, gate('ops.health'), sameOrigin, (req, res) => {
    const ok = notify.retry(req.params.id);
    if (ok) record(req.admin, 'email-retried', { entityType: 'notification', entityId: req.params.id });
    back(res, '/admin/system-health', ok ? 'Email queued to try again' : 'That email is not waiting to be retried');
  });
  app.get('/admin/access-control', adminAuth, gate('access.view'), (req, res) => {
    view(req, res, { title: 'Access control', section: 'access', roleList: roles.ROLES, roleInfo: roles.ROLE_INFO, perms: roles.PERMS, members: team.list().map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, active: u.active !== false, twoFactorOn: Boolean(u.twoFactorOn), pending: Boolean(u.pending) })), pol: policy(), strongRoles: roles.STRONG_AUTH_ROLES });
  });
  app.post('/admin/access-control/policy', adminAuth, gate('trust.policy'), sameOrigin, (req, res) => {
    const r = setPolicy(req.admin, req.body);
    back(res, '/admin/access-control', r.errors ? `Not saved: ${r.errors.join('; ')}` : 'Policy saved');
  });

  // ---------- JSON for the team ----------
  const teamApi = (action) => (req, res, next) => {
    const user = team.currentUser(req);
    if (!user) return res.status(401).json({ ok: false, errors: ['sign in to the team admin first'] });
    if (team.mustUse2fa(user) && !team.has2fa(user.id)) return res.status(403).json({ ok: false, errors: ['set up two-step sign-in first'] });
    if (!can(user, action)) return res.status(403).json({ ok: false, errors: ['your role does not allow that'] });
    req.admin = user;
    res.set('Cache-Control', 'no-store');
    next();
  };
  const apiLimit = limit('trust-api', 300, 60 * 1000);
  const out = (res, r, map) => (r.errors ? res.status(r.status).json({ ok: false, errors: r.errors }) : res.status(r.status).json({ ok: true, ...map(r) }));
  const pageJson = (list, req, size = 50) => { const { rows, pager } = paginate(list, { page: req.query.page, size, query: req.query, path: '' }); return { rows, page: pager.page, pages: pager.pages, total: pager.total }; };
  const checkJson = (r) => ({
    id: r.check.id, status: r.check.status, employerId: r.check.employerId, company: r.employer.company || '', submittedBy: r.check.submittedBy || '', waitingSince: r.waitingSince, details: r.check.details || {},
    reply: r.check.reply || null, note: r.check.note || null, reviewedBy: r.check.reviewedBy || null, reviewedAt: r.check.reviewedAt || null, signals: r.signals,
  });
  const jobJson = (r) => ({ id: r.job.id, title: r.job.title, company: r.job.company, status: r.job.status, kinds: r.kinds, flags: r.flags, level: r.level || null, caseId: r.case ? r.case.id : null, since: r.since, restricted: Boolean(r.job.moderation && r.job.moderation.locked) });

  app.get('/api/admin/verifications', teamApi('verify.review'), apiLimit, (req, res) => { const p = pageJson(verificationQueue(req.query), req); res.json({ ok: true, verifications: p.rows.map(checkJson), page: p.page, pages: p.pages, total: p.total }); });
  app.post('/api/admin/verifications/:id/decision', teamApi('verify.review'), apiLimit, sameOrigin, (req, res) => out(res, decideVerification(req.admin, req.params.id, req.body), (r) => ({ verification: { id: r.check.id, status: r.check.status, reviewedBy: r.check.reviewedBy || r.check.infoRequestedBy, reviewedAt: r.check.reviewedAt || r.check.infoRequestedAt, note: r.check.note || null } })));
  app.get('/api/admin/moderation/jobs', teamApi('jobs.review'), apiLimit, (req, res) => { const p = pageJson(moderationQueue(req.query), req); res.json({ ok: true, jobs: p.rows.map(jobJson), page: p.page, pages: p.pages, total: p.total }); });
  app.post('/api/admin/moderation/jobs/:id/decision', teamApi('jobs.review'), apiLimit, sameOrigin, (req, res) => out(res, decideJob(req.admin, req.params.id, req.body), (r) => ({ job: { id: r.job.id, status: r.job.status, restricted: Boolean(r.job.moderation && r.job.moderation.locked), moderation: r.job.moderation ? { state: r.job.moderation.state, reason: r.job.moderation.reason, by: r.job.moderation.by, at: r.job.moderation.at } : null } })));
  app.get('/api/admin/cases', teamApi('cases.view'), apiLimit, (req, res) => { const p = pageJson(searchCases(req.admin, req.query), req); res.json({ ok: true, cases: p.rows.map(caseSummary), page: p.page, pages: p.pages, total: p.total }); });
  app.get('/api/admin/cases/:id', teamApi('cases.view'), apiLimit, (req, res) => { const c = caseById(req.params.id); if (!seesCase(req.admin, c)) return res.status(404).json({ ok: false, errors: ['case not found'] }); res.json({ ok: true, case: caseDetail(c) }); });
  app.patch('/api/admin/cases/:id', teamApi('cases.view'), apiLimit, sameOrigin, (req, res) => out(res, patchCase(req.admin, req.params.id, req.body || {}), (r) => ({ case: caseDetail(r.case) })));
  app.post('/api/admin/cases/:id/actions', teamApi('cases.view'), apiLimit, sameOrigin, (req, res) => out(res, caseAction(req.admin, req.params.id, req.body || {}), (r) => ({ case: caseDetail(r.case) })));
  app.get('/api/admin/appeals', teamApi('cases.view'), apiLimit, (req, res) => {
    const visible = (a) => can(req.admin, 'appeals.decide') || (a.caseId && seesCase(req.admin, caseById(a.caseId)));
    res.json({ ok: true, appeals: appeals().filter((a) => a.status !== 'available' && a.status !== 'superseded').filter(visible).slice(0, 200).map(appealJson) });
  });
  app.post('/api/admin/appeals/:id/decision', teamApi('appeals.decide'), apiLimit, sameOrigin, (req, res) => out(res, decideAppeal(req.admin, req.params.id, req.body || {}), (r) => ({ appeal: appealJson(r.appeal) })));
  app.get('/api/admin/audit-logs', teamApi('audit.platform'), apiLimit, (req, res) => { const p = pageJson(auditLog(req.query), req, 100); res.json({ ok: true, entries: p.rows, page: p.page, pages: p.pages, total: p.total, chain: verifyChain() }); });
  app.get('/api/admin/system-health', teamApi('ops.health'), apiLimit, (req, res) => res.json({ ok: true, health: health() }));
  // One queue across cases, flagged or held listings and company checks,
  // limited to what the person's role handles; most urgent first.
  function trustQueue(user) {
    const levelOfEntity = (type, id) => { const a = assessments.latest(type, id); return a && a.rules.length ? a.level : null; };
    const items = searchCases(user, {}).map((c) => ({ kind: 'case', id: c.id, number: c.number, label: c.entityLabel, entityType: c.entityType, entityId: c.entityId, category: c.category, priority: c.priority, status: c.status, riskLevel: levelOfEntity(c.entityType, c.entityId), escalated: Boolean(c.escalated), since: c.createdAt, link: `/admin/cases/${c.id}` }));
    if (can(user, 'jobs.review')) {
      const withCase = new Set(items.map((i) => `${i.entityType}:${i.entityId}`));
      for (const r of moderationQueue({}).filter((x) => !withCase.has(`job:${x.job.id}`))) items.push({ kind: 'listing', id: r.job.id, label: `${r.job.title} · ${r.job.company}`, entityType: 'job', entityId: r.job.id, priority: r.job.reviewHold || r.level === 'critical' ? 'high' : 'normal', status: r.job.status, kinds: r.kinds, onHold: Boolean(r.job.reviewHold), riskLevel: levelOfEntity('job', r.job.id), since: r.since, link: `/admin/job-moderation/${r.job.id}` });
    }
    if (can(user, 'verify.review')) for (const r of verificationQueue({})) items.push({ kind: 'verification', id: r.check.id, label: r.employer.company || '', entityType: 'employer', entityId: r.check.employerId, priority: r.check.escalated || (r.risk && risk.SEVERITY[r.risk.level] >= 3) ? 'high' : 'normal', status: r.check.status, recheck: r.check.kind === 'recheck', riskLevel: r.risk ? r.risk.level : null, since: r.waitingSince, link: '/admin/verifications' });
    const rank = (i) => PRIORITIES.indexOf(i.priority) * 10 - (risk.SEVERITY[i.riskLevel] || 0);
    return items.sort((a, b) => rank(a) - rank(b) || String(a.since).localeCompare(String(b.since)));
  }
  app.get('/api/admin/trust/queue', teamApi('cases.view'), apiLimit, (req, res) => { const p = pageJson(trustQueue(req.admin), req); res.json({ ok: true, items: p.rows, page: p.page, pages: p.pages, total: p.total }); });
  app.patch('/api/admin/trust/cases/:id', teamApi('cases.view'), apiLimit, sameOrigin, (req, res) => out(res, patchCase(req.admin, req.params.id, req.body || {}), (r) => ({ case: caseDetail(r.case) })));
  app.post('/api/admin/verification/:id/decision', teamApi('verify.review'), apiLimit, sameOrigin, (req, res) => out(res, decideVerification(req.admin, req.params.id, req.body || {}), (r) => ({ verification: { id: r.check.id, status: r.check.status, escalated: r.check.escalated ? { by: r.check.escalated.by, at: r.check.escalated.at, caseId: r.check.escalated.caseId } : null, reviews: (r.check.reviews || []).map((x) => ({ decision: x.decision, by: x.by, at: x.at, reason: x.reason })) } })));
  // The assessment behind a listing or company: rules, evidence, actions and history.
  app.get('/api/admin/risk/:type/:id', teamApi('cases.view'), apiLimit, (req, res) => {
    const type = req.params.type === 'jobs' ? 'job' : req.params.type === 'employers' ? 'employer' : '';
    if (!type || !can(req.admin, type === 'job' ? 'jobs.review' : 'verify.review')) return res.status(404).json({ ok: false, errors: ['not found'] });
    const history = assessments.historyOf(type, req.params.id);
    if (!history.length) return res.status(404).json({ ok: false, errors: ['no assessment yet'] });
    const shape = (a) => ({ id: a.id, level: a.level, rules: a.rules, context: a.context || [], actions: a.actions, review: a.review || null, assessedAt: a.assessedAt, supersededAt: a.supersededAt || null });
    res.json({ ok: true, note: 'A review aid for a person, not proof of fraud.', current: shape(history.find((a) => !a.supersededAt) || history[0]), history: history.map(shape) });
  });

  // ---------- public: reports and appeals ----------
  const reportLimit = limit('reports', 5);
  app.post('/api/reports', reportLimit, sameOrigin, takeEvidence, async (req, res, next) => {
    try {
      const thanks = 'Thanks for telling us. Our team will look into it, usually within one working day.';
      if (isBot(req.body)) { if (req.file) fs.unlink(req.file.path, () => {}); return res.status(202).json({ ok: true, message: thanks }); }
      if (req.file) {
        const bad = await vetDocument(req.file);
        if (bad) return res.status(400).json({ ok: false, errors: [bad] });
      }
      const r = submitReport(req, req.body || {}, req.file || null);
      if (r.errors) return res.status(r.status).json({ ok: false, errors: r.errors });
      res.status(202).json({ ok: true, message: thanks });
    } catch (err) { next(err); }
  });
  // Reports on a listing or a company, with a reference and a tracking link.
  const reportReply = async (req, res, entityType, next) => {
    try {
      const thanks = 'Thanks for telling us. Our team will look into it, usually within one working day.';
      if (isBot(req.body)) { if (req.file) fs.unlink(req.file.path, () => {}); return res.status(202).json({ ok: true, message: thanks, help: CYBERCRIME_HELP }); }
      if (req.file) {
        const bad = await vetDocument(req.file);
        if (bad) return res.status(400).json({ ok: false, errors: [bad] });
      }
      const body = req.body || {};
      const category = body.category || REASON_CATEGORY[body.reason] || '';
      const r = submitReport(req, { ...body, category, entityType, entityId: req.params.id }, req.file || null);
      if (r.errors) return res.status(r.status).json({ ok: false, errors: r.errors });
      // A job report also lands in the team's inbox, as from the job page.
      if (entityType === 'job') {
        const job = getJobs().find((j) => j.id === req.params.id && !j.sample && j.status !== 'draft');
        if (job) mailer.jobReported(saveSubmission('job-reports', { jobId: job.id, jobTitle: job.title, company: job.company, reason: Object.keys(REASON_CATEGORY).find((k) => REASON_CATEGORY[k] === category) || CATEGORIES[category], details: clip(body.details, 1000), email: clip(body.email, 160).toLowerCase(), reference: r.receipt.reference }));
      }
      res.status(202).json({ ok: true, message: `${thanks} Your reference is ${r.receipt.reference}; you can follow it with the private link below.`, reference: r.receipt.reference, trackUrl: r.receipt.trackUrl, help: CYBERCRIME_HELP });
    } catch (err) { next(err); }
  };
  app.post('/api/jobs/:id/reports', reportLimit, sameOrigin, takeEvidence, (req, res, next) => reportReply(req, res, 'job', next));
  app.post('/api/companies/:id/reports', reportLimit, sameOrigin, takeEvidence, (req, res, next) => reportReply(req, res, 'employer', next));
  app.get('/reports/track/:token', limit('report-track', 30), (req, res) => {
    const receipt = receiptByToken(req.params.token);
    res.set('Cache-Control', 'no-store');
    res.status(receipt ? 200 : 404).render('report-track', { title: 'Your report', page: '', noindex: true, track: receipt ? trackingOf(receipt) : null, help: CYBERCRIME_HELP });
  });

  const appealPage = (res, locals, status = 200) => { res.set('Cache-Control', 'no-store'); res.status(status).render('appeal', { title: 'Appeal a decision', page: '', noindex: true, errors: [], done: false, expired: false, APPEAL_KIND, ...locals }); };
  app.get('/appeal/:token', limit('appeal-view', 30), (req, res) => {
    const a = appealByToken(req.params.token);
    if (!a) return appealPage(res, { a: null }, 404);
    appealPage(res, { a, expired: a.status === 'available' && a.expiresAt < iso() });
  });
  app.post('/appeal/:token', limit('appeal', 10), sameOrigin, (req, res) => {
    if (isBot(req.body)) return appealPage(res, { a: null, done: true });
    const r = submitAppeal(req.params.token, req.body.statement);
    const a = appealByToken(req.params.token);
    if (r.errors) return appealPage(res, { a, errors: r.errors, statement: clip(req.body.statement, 2000) }, r.status);
    appealPage(res, { a, done: true });
  });

  // Checks run on start, then on a timer.
  setTimeout(() => { try { scanJob(); } catch (e) { console.error('Trust scan failed:', e.message); } }, 2000).unref();
  setInterval(() => { try { scanJob(); } catch (e) { console.error('Trust scan failed:', e.message); } }, Number(process.env.TRUST_SCAN_MS) || 10 * 60 * 1000).unref();
  setInterval(() => { try { pruneJob(); } catch (e) { console.error('Trust retention failed:', e.message); } }, DAY).unref();

  return { reportJob, submitReport, scan: scanJob, prune, verifyChain, record, policy, flagsFor, health, overview, assessments, REASON_CATEGORY, CYBERCRIME_HELP };
}

module.exports = { register, flagsFor, fingerprint, CATEGORIES, REASON_CATEGORY, CASE_ACTIONS, STATUSES, POLICY_DEFAULTS, CYBERCRIME_HELP, PUBLIC_STATUS };
