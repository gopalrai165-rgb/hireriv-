// Explainable, rules-based risk assessment for job listings and employer
// accounts (Step 64). Each assessment lists the rules that fired, the
// evidence each one saw, the resulting level (low, medium, high, critical) and
// the actions taken or recommended. A risk level is a review aid for a person,
// never proof of fraud: the only things done automatically are opening or
// escalating a case, raising its priority, pausing a listing that looks like
// impersonation until a moderator checks it, and slowing down unusual bursts
// of job posting. Suspending, closing or restricting an account is always a
// person's decision, with a reason and an appeal.
//
// Weak signals (a personal mailbox, no website, a small company, an IP
// address) are shown to reviewers as context and never raise the level.
// No machine learning: only rules a reviewer can read and check.
const crypto = require('crypto');

const ASSESSMENTS = 'risk-assessments';
const SEVERITY = { low: 1, medium: 2, high: 3, critical: 4 };
const WEIGHT = { low: 1, medium: 3, high: 6, critical: 10 };
const LEVELS = Object.keys(SEVERITY);

// What each action means, for the assessment and the reviewer.
const ACTIONS = {
  'duplicate-review': 'Queued for a duplicate check',
  'urgent-review': 'Moderation marked urgent',
  'review-hold': 'Paused until a moderator checks it',
  'posting-limit': 'New jobs held until the recent ones are reviewed',
  escalate: 'Escalated to a Trust & Safety Manager',
  reverification: 'Company details sent for checking again',
  'restrict-capabilities': 'A moderator may restrict what the account can do (recommended, not applied)',
};

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const iso = () => new Date().toISOString();
const normal = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n);

// ---------- near-duplicate text ----------
// Word triples of the title, description and duties; two listings whose
// triples overlap this much say nearly the same thing.
const NEAR_DUPLICATE = 0.8;
const MIN_SHINGLES = 15;
function shingles(job) {
  const words = normal([job.title, job.description, ...(job.responsibilities || [])].join(' ')).split(' ').filter(Boolean).slice(0, 400);
  const out = new Set();
  for (let i = 0; i + 2 < words.length; i++) out.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  return out;
}
function similarity(a, b) {
  if (!a.size || !b.size) return 0;
  let both = 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const s of small) if (big.has(s)) both++;
  return both / (a.size + b.size - both);
}

// Which listings could be near-copies of a set of triples, without comparing
// every pair: two sets with similarity >= t share a triple among the first
// |s| - ceil(t·|s|) + 1 of each, rarest first ("prefix filtering"), so only
// listings sharing one of those are compared. The answer is the same as
// comparing them all. Returns a function: triples -> candidate listings.
function nearIndex(others, t = NEAR_DUPLICATE) {
  const df = new Map();
  for (const o of others) for (const s of o.shingles) df.set(s, (df.get(s) || 0) + 1);
  const rarestFirst = (set) => [...set].sort((x, y) => (df.get(x) || 0) - (df.get(y) || 0) || (x < y ? -1 : x > y ? 1 : 0));
  const prefix = (set) => rarestFirst(set).slice(0, set.size - Math.ceil(t * set.size) + 1);
  const postings = new Map();
  for (const o of others) {
    for (const s of prefix(o.shingles)) {
      if (!postings.has(s)) postings.set(s, []);
      postings.get(s).push(o);
    }
  }
  return (mine) => {
    const out = new Set();
    for (const s of prefix(mine)) for (const o of postings.get(s) || []) out.add(o);
    return [...out];
  };
}

// ---------- signals in a listing's own text ----------
const EMAIL_RE = /\b[A-Z0-9._%+-]+@([A-Z0-9-]+\.)+[A-Z]{2,}\b/gi;
const FREE_MAIL = /@(gmail|yahoo|ymail|hotmail|outlook|live|rediffmail|protonmail|icloud|aol|zoho)\./i;
const PHONE_RE = /(?:\+?91[\s-]?)?\b[6-9]\d{4}[\s-]?\d{5}\b/g;
const APPLY_OFFSITE = /\b(send|mail|email|whatsapp|share|forward)\b[^.\n]{0,30}\b(cv|resume|bio ?data|details|documents?)\b/i;
const hostOf = (url) => String(url || '').replace(/^https?:\/\//i, '').split(/[/?#:]/)[0].replace(/^www\./, '').toLowerCase();
const textOf = (job) => [job.title, job.description, job.payNote, job.address, ...(job.responsibilities || []), ...(job.qualifications || []), ...(job.benefits || [])].join('\n');

// Asking candidates to apply to a personal mailbox or number outside Hireriv.
function offPlatform(job, employer) {
  const text = textOf(job);
  const emails = [...new Set(text.match(EMAIL_RE) || [])];
  const site = hostOf(employer && employer.website);
  const strange = emails.filter((e) => FREE_MAIL.test(e) || (site && !e.toLowerCase().endsWith(`@${site}`) && !e.toLowerCase().endsWith(`.${site}`)));
  const phones = text.match(PHONE_RE) || [];
  if (!(strange.length || phones.length) || !APPLY_OFFSITE.test(text)) return null;
  return `${strange.length ? `${strange.length} email address${strange.length === 1 ? '' : 'es'} not on the company's own domain` : ''}${strange.length && phones.length ? ' and ' : ''}${phones.length ? 'a phone number' : ''} for sending applications`;
}

// ---------- the rules ----------
// Each returns { code, severity, label, evidence, action? } or nothing.
// `ctx` carries what the rule may compare with: other live listings, the
// employer, reports, past decisions and recent postings.
function jobRules(job, ctx) {
  const out = [];
  const add = (code, severity, label, evidence, action) => out.push({ code, severity, label, evidence: clip(evidence, 200), ...(action ? { action } : {}) });
  // Short texts look alike by chance: only a substantial copy counts as impersonation.
  const mine = shingles(job);
  const substantial = mine.size >= MIN_SHINGLES;
  for (const f of ctx.flags || []) {
    if (f.code === 'payment-request') add('payment-request', 'high', f.label, f.detail, 'urgent-review');
    else if (f.code === 'personal-data') add('personal-data', 'high', f.label, f.detail, 'urgent-review');
    else if (f.code === 'copied' && substantial) add('impersonation', 'critical', f.label, `same text as ${f.detail}`, 'review-hold');
    else if (f.code === 'copied') add('copied', 'high', f.label, f.detail, 'urgent-review');
    else if (f.code === 'duplicate') add('duplicate', 'low', f.label, f.detail, 'duplicate-review');
    else add(f.code, f.severity === 'high' ? 'high' : f.severity, f.label, f.detail);
  }
  // Nearly the same words as another live listing.
  if (ctx.others && substantial && !out.some((r) => ['impersonation', 'copied', 'duplicate'].includes(r.code))) {
    // Only the later of two near-copies is flagged (posted earlier, or the same day with a lower id).
    const earlier = (o) => String(o.posted || '') < String(job.posted || '') || (String(o.posted || '') === String(job.posted || '') && o.id < job.id);
    const pool = ctx.nearPool ? ctx.nearPool(mine) : ctx.others;
    const near = pool.filter((o) => o.id !== job.id && earlier(o) && similarity(mine, o.shingles) >= NEAR_DUPLICATE);
    const otherCompany = near.filter((o) => (job.employerId ? o.employerId !== job.employerId : normal(o.company) !== normal(job.company)));
    if (otherCompany.length) add('impersonation', 'critical', "Nearly the same text as another company's listing (possible impersonation)", otherCompany.map((o) => o.id).slice(0, 3).join(', '), 'review-hold');
    else if (near.length) add('near-duplicate', 'medium', 'Nearly the same as another listing of this company', near.map((o) => o.id).slice(0, 3).join(', '), 'duplicate-review');
  }
  const off = offPlatform(job, ctx.employer);
  if (off) add('off-platform', 'medium', 'Asks candidates to apply outside Hireriv', off);
  // Changes made after the listing went live (pay, place, who is hiring).
  for (const c of job.changeSignals || []) add(`changed-${c.code}`, c.code === 'employer' ? 'high' : 'medium', c.label, c.detail);
  return out;
}

function employerRules(emp, ctx) {
  const out = [];
  const add = (code, severity, label, evidence, action) => out.push({ code, severity, label, evidence: clip(evidence, 200), ...(action ? { action } : {}) });
  const pol = ctx.policy || {};
  // A burst of jobs sent for review in a day.
  const burst = (ctx.recentSubmissions || 0);
  if (burst >= (pol.postingBurst || 10)) add('posting-burst', 'medium', 'Many jobs sent for review in 24 hours', `${burst} jobs`, 'posting-limit');
  // Several different people reported the company or its jobs.
  const reporters = ctx.reporters || 0;
  if (reporters >= (pol.urgentReports || 3)) add('many-reports', 'high', 'Reported by several different people', `${reporters} different reporters on open cases`, 'escalate');
  // Moderation decisions that stood (not overturned on appeal).
  const upheld = ctx.upheldViolations || 0;
  if (upheld >= 2) add('repeat-violations', 'high', 'Listings restricted or removed more than once', `${upheld} decisions in 180 days`, 'restrict-capabilities');
  if (ctx.identityChanged) add('identity-changed', 'medium', 'Name or registration numbers changed after verification', ctx.identityChanged, 'reverification');
  if (ctx.highRiskJobs) add('risky-listings', ctx.highRiskJobs > 1 ? 'high' : 'medium', 'Listings with high-risk signals', `${ctx.highRiskJobs} listing${ctx.highRiskJobs === 1 ? '' : 's'}`);
  return out;
}

// Context only: shown to reviewers, never counted.
function employerContext(emp) {
  const out = [];
  if (emp.freeEmail) out.push('Signed up with a personal mailbox');
  if (!emp.gstin && !emp.cin && !emp.udyam) out.push('No GSTIN, CIN or Udyam number');
  if (!emp.website) out.push('No website');
  return out;
}

function summarize(rules) {
  const level = rules.reduce((m, r) => (SEVERITY[r.severity] > SEVERITY[m] ? r.severity : m), 'low');
  return { level: rules.length ? level : 'low', score: rules.reduce((n, r) => n + WEIGHT[r.severity], 0) };
}

// ---------- the record of assessments ----------
// A new assessment is kept only when its rules or evidence change; the earlier
// one stays, marked superseded, so the history shows what was known when.
function store(db) {
  const all = () => db.all(ASSESSMENTS);
  const latest = (type, id) => db.where(ASSESSMENTS, 'entityId', String(id)).find((a) => a.entityType === type && !a.supersededAt) || null;
  const historyOf = (type, id) => db.where(ASSESSMENTS, 'entityId', String(id)).filter((a) => a.entityType === type);
  function save(type, id, { employerId = '', rules, context = [] }) {
    const { level, score } = summarize(rules);
    const fp = sha(JSON.stringify(rules.map((r) => [r.code, r.severity, r.evidence])));
    const prev = latest(type, id);
    if (prev && prev.fp === fp) return { assessment: prev, changed: false };
    const a = {
      id: crypto.randomUUID(), entityType: type, entityId: String(id), employerId, level, score, rules, context, fp,
      actions: [], assessedAt: iso(), createdAt: iso(),
    };
    db.transaction(() => {
      if (prev) db.update(ASSESSMENTS, { ...prev, supersededAt: a.assessedAt });
      db.prepend(ASSESSMENTS, a);
    });
    return { assessment: a, changed: true, previous: prev };
  }
  // Records an action taken because of an assessment (who: the system or a person).
  function noteAction(a, code, { by = 'System', detail = '' } = {}) {
    const cur = db.where(ASSESSMENTS, 'id', a.id)[0] || a;
    cur.actions = [...(cur.actions || []), { code, label: ACTIONS[code] || code, by, detail: clip(detail, 200), at: iso() }];
    db.update(ASSESSMENTS, cur);
    return cur;
  }
  // A reviewer's verdict on the automated signals: confirmed or a false positive.
  function review(a, { by, verdict, note }) {
    const cur = db.where(ASSESSMENTS, 'id', a.id)[0] || a;
    cur.review = { by, verdict, note: clip(note, 300), at: iso() };
    db.update(ASSESSMENTS, cur);
    return cur;
  }
  function prune(cutoffIso) {
    const old = all().filter((a) => a.supersededAt && a.supersededAt < cutoffIso);
    if (old.length) db.remove(ASSESSMENTS, old.map((a) => a.id));
    return old.length;
  }
  return { all, latest, historyOf, save, noteAction, review, prune };
}

// Changes to a live listing worth a second look (pay, place, who is hiring).
function changesOf(before, after, employer) {
  const out = [];
  const mid = (p) => (p && (p.min || p.max) ? ((p.min || p.max) + (p.max || p.min)) / 2 : 0);
  const a = mid(before.pay);
  const b = mid(after.pay);
  if (a && !b) out.push({ code: 'pay', label: 'Pay removed after the listing went live', detail: `was ${before.salary || a}` });
  else if (a && b && Math.abs(b - a) / a >= 0.3) out.push({ code: 'pay', label: 'Pay changed a lot after the listing went live', detail: `${before.salary || a} → ${after.salary || b}` });
  if (before.location && after.location && before.location !== after.location) out.push({ code: 'location', label: 'Workplace changed after the listing went live', detail: `${before.location} → ${after.location}` });
  // Only while the company's new name has not been confirmed by the team.
  if (employer && employer.recheck && before.company && normal(before.company) !== normal(employer.company)) out.push({ code: 'employer', label: 'The company name changed after the listing went live', detail: `${before.company} → ${employer.company}` });
  return out.map((c) => ({ ...c, at: iso() }));
}

module.exports = { store, jobRules, nearIndex, employerRules, employerContext, summarize, shingles, similarity, changesOf, offPlatform, ASSESSMENTS, ACTIONS, LEVELS, SEVERITY, NEAR_DUPLICATE };
