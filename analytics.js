// Recruitment analytics and business intelligence: one set of numbers for the
// team's dashboards (Admin, recruitment managers, recruiters, account,
// staffing and finance managers) and each employer's own, from the records the
// rest of the app keeps. Nothing is copied or counted twice: applications,
// stage history, interviews and offers come from the applications, placements
// and invoices from billing (placements.js), requisitions from agency.js,
// registrations from the account records, job-page visits from the cookie-free
// website counts, and the backlog from trust & safety.
//
// Rules (also in DEFINITIONS, shown next to every number):
// - Every date belongs to its India day (Asia/Kolkata); ranges include both ends.
// - Applications are those made to jobs. Profiles without a job ("general
//   applications"), duplicates and sample jobs are left out. Deleted records
//   are gone from the sources, so they drop out of every number.
// - A stage counts once per application however many times it was entered.
//   A correction that moves an application back cancels the stages it skipped
//   back over, unless they are reached again later.
// - Withdrawn applications still count as received, never as active.
// - Money comes from billing only, in paise: invoiced = invoices dated in the
//   range, less credit notes dated in it; collected = payments (with TDS) dated
//   in the range, less refunds dated in it; outstanding and overdue are
//   balances today. Cancelled invoices count nowhere.
// - Who sees what is decided on the server from the sign-in: employers see
//   only their own company (and, below owner and viewer, only their jobs);
//   recruiters see their own work unless their role covers the whole team;
//   money needs the money permission (Admins, Account and Finance Managers;
//   company owners for their own invoices).
const ats = require('./ats');
const { WORK_KINDS, workOf } = require('./content');
const { accountOf } = require('./placements');
const employerTeam = require('./employer-team');
const roles = require('./agency-roles');

const TZ = 'Asia/Kolkata';
const DAY = 86400000;
const PIPE = ats.PIPELINE; // New, Screening, Shortlisted, Interview, Offered, Hired
const OPEN_INVOICE = ['Unpaid', 'Part paid'];
const dayKey = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: TZ });
const ymd = (d) => (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : d ? dayKey(d) : '');
const addDays = (k, n) => new Date(Date.parse(`${k}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const spanDays = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY) + 1;
const paise = (n) => Math.round((Number(n) || 0) * 100);
const pct = (part, whole) => (whole ? Math.round((part / whole) * 1000) / 10 : null);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return Math.round((s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) * 10) / 10;
};
const mean = (xs) => (xs.length ? Math.round((xs.reduce((n, x) => n + x, 0) / xs.length) * 10) / 10 : null);

const PERIODS = { today: 'Today', '7d': 'Last 7 days', '30d': 'Last 30 days', quarter: 'This quarter', custom: 'Custom range' };
const HIRING_TYPES = { permanent: 'Permanent', temporary: 'Temporary', contract: 'Contract' };
// Job types and placement types by recruitment type.
const JOB_TYPE_KIND = { 'Full-time': 'permanent', 'Part-time': 'permanent', Contract: 'contract', Temporary: 'temporary', 'Daily wage / Gig': 'temporary', Apprenticeship: 'temporary', Internship: 'temporary' };
const PLACEMENT_TYPE_KIND = { Permanent: 'permanent', Temporary: 'temporary', Contract: 'contract', 'Contract-to-hire': 'contract' };
const JOB_STATUSES = ['open', 'paused', 'pending', 'draft', 'rejected', 'closed'];
const APP_STATUSES = [...PIPE, ...ats.OUTCOMES, 'Withdrawn'];
const REVENUE_STATUSES = { invoiced: 'Invoiced', paid: 'Paid', overdue: 'Overdue', refunded: 'Refunded' };
const FILTER_KEYS = ['period', 'from', 'to', 'work', 'hiringType', 'location', 'industry', 'employer', 'recruiter', 'jobStatus', 'applicationStatus', 'placementStatus', 'revenueStatus', 'page', 'pageSize', 'as'];
const MAX_RANGE_DAYS = 1096;
const OVERDUE_FOLLOW_UP_DAYS = 3;

const COMMON = { timezone: TZ, period: 'the chosen range, by India date, both ends included' };
const DEFINITIONS = {
  applications: { label: 'Applications received', formula: 'Applications made to jobs, dated in the range', excludes: 'Profiles without a job, duplicates and sample jobs; withdrawn applications are included' },
  applicationConversion: { label: 'Application conversion', formula: 'Applications received ÷ job pages viewed in the range', excludes: 'Only where job-page views are counted: the whole site or one kind of work, with no other filters. Views are counted without cookies and skip bots and browsers asking not to be tracked, so this is approximate' },
  interviewRate: { label: 'Interview rate', formula: 'Applications received in the range that reached the interview stage (or had an interview booked that was not cancelled) ÷ applications received in the range', excludes: 'Interview stages reversed by a correction' },
  offerAcceptance: { label: 'Offer acceptance', formula: 'Offers accepted ÷ offers made, for applications whose offer was made in the range', excludes: 'Withdrawn offers. An offer counts once per application; an accepted offer is one the candidate accepted or that ended in a hire' },
  timeToHire: { label: 'Time to hire', formula: 'Median days from applying to being hired, for hires made in the range', excludes: 'The hire date is the first move to Hired (not reversed by a correction) or the placement record, whichever is earlier' },
  timeToFill: { label: 'Time to fill', formula: 'Median days from a job going live to its first hire, for jobs first filled in the range', excludes: 'Jobs never approved or posted' },
  placementRate: { label: 'Placement rate', formula: 'Applications received in the range that ended in a hire or placement ÷ applications received in the range', excludes: 'The same applications on both sides, so later placements of older applications never inflate it' },
  placements: { label: 'Placements', formula: 'Placements recorded in the range', excludes: 'Replacements under a guarantee are shown separately' },
  recruiterProductivity: { label: 'Placements per recruiter', formula: 'Placements recorded in the range ÷ recruiters with at least one application, interview or placement in the range', excludes: 'Each placement counts for the recruiter on it (or who owns the application)' },
  revenueCollected: { label: 'Revenue collected', formula: 'Payments received (including TDS the client deducted) dated in the range, less refunds dated in the range', excludes: 'From billing records only, never estimates. Cancelled invoices are excluded' },
  invoiced: { label: 'Invoiced', formula: 'Invoice totals (with GST) dated in the range, less credit notes dated in the range', excludes: 'Cancelled invoices' },
  outstandingInvoices: { label: 'Outstanding invoices', formula: 'Unpaid balances of open invoices today', excludes: 'A balance today, whatever the range; overdue is the part past its due date' },
};
for (const d of Object.values(DEFINITIONS)) Object.assign(d, COMMON);

// ---------- filters ----------
function rangeOf(f, today) {
  if (f.period === 'today') return { from: today, to: today };
  if (f.period === '7d') return { from: addDays(today, -6), to: today };
  if (f.period === '30d') return { from: addDays(today, -29), to: today };
  if (f.period === 'quarter') {
    const [y, m] = today.split('-').map(Number);
    return { from: `${y}-${String(Math.floor((m - 1) / 3) * 3 + 1).padStart(2, '0')}-01`, to: today };
  }
  return { from: f.from, to: f.to };
}

// Validates a query string; unknown keys and values are errors, not ignored.
function parseFilters(q, today = dayKey(Date.now())) {
  const errors = [];
  const one = (k) => {
    const v = q[k];
    if (Array.isArray(v)) { errors.push(`${k} can only be given once`); return ''; }
    return v === undefined ? '' : String(v).trim().slice(0, 120);
  };
  for (const k of Object.keys(q)) if (!FILTER_KEYS.includes(k)) errors.push(`unknown filter: ${k.slice(0, 40)}`);
  const f = Object.fromEntries(FILTER_KEYS.map((k) => [k, one(k)]));
  if (!f.period) f.period = f.from || f.to ? 'custom' : '30d';
  if (!PERIODS[f.period]) errors.push(`period must be one of: ${Object.keys(PERIODS).join(', ')}`);
  if (f.period === 'custom') {
    const valid = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
    if (!valid(f.from) || !valid(f.to)) errors.push('a custom range needs from and to as dates (YYYY-MM-DD)');
    else if (f.from > f.to) errors.push('from must be on or before to');
    else if (f.to > today) errors.push('to cannot be in the future');
    else if (spanDays(f.from, f.to) > MAX_RANGE_DAYS) errors.push('a range can be at most 3 years');
    else if (f.from < '2000-01-01') errors.push('from is too early');
  } else if (f.from || f.to) errors.push('from and to are only used with period=custom');
  const choice = (k, list) => { if (f[k] && !list.includes(f[k])) errors.push(`${k} must be one of: ${list.join(', ')}`); };
  choice('work', WORK_KINDS.map((w) => w.key));
  choice('hiringType', Object.keys(HIRING_TYPES));
  choice('jobStatus', JOB_STATUSES);
  choice('applicationStatus', APP_STATUSES);
  choice('revenueStatus', Object.keys(REVENUE_STATUSES));
  for (const k of ['employer', 'recruiter']) if (f[k] && !/^[\w-]{1,80}$/.test(f[k])) errors.push(`${k} is not a valid id`);
  const int = (k, def, min, max) => {
    if (!f[k]) return def;
    const n = Number(f[k]);
    if (!Number.isInteger(n) || n < min || n > max) { errors.push(`${k} must be a whole number from ${min} to ${max}`); return def; }
    return n;
  };
  f.page = int('page', 1, 1, 10000);
  f.pageSize = int('pageSize', 25, 1, 100);
  if (!errors.length) Object.assign(f, rangeOf(f, today));
  f.label = f.period === 'custom' ? `${f.from} to ${f.to}` : PERIODS[f.period] || '';
  return { f, errors };
}

// ---------- the numbers ----------
function create(deps) {
  const { readSubmissions, getJobs, billing, team, clients, agency, appOwner, siteAnalytics, trust, ops, now = () => Date.now() } = deps;

  // The stages an application really reached (see the rules above).
  function furthest(a, placedIds) {
    let top = 0;
    for (const h of a.history || []) {
      const i = PIPE.indexOf(h.to);
      if (h.correction && i >= 0) top = i;
      else if (i > top) top = i;
    }
    const cur = PIPE.indexOf(a.status || 'New');
    if (cur > top) top = cur;
    if ((a.interviews || []).some((iv) => iv.status !== 'cancelled')) top = Math.max(top, PIPE.indexOf('Interview'));
    if ((a.offers || []).some((o) => o.approval && o.approval.status === 'approved' && !o.withdrawnAt)) top = Math.max(top, PIPE.indexOf('Offered'));
    if (placedIds.has(a.id)) top = PIPE.indexOf('Hired');
    return top;
  }
  // When an application first entered a stage (and kept it), or null.
  function enteredAt(a, stage) {
    let at = null;
    for (const h of a.history || []) {
      if (h.to === stage && !at) at = h.at;
      if (h.correction && at && PIPE.indexOf(h.to) < PIPE.indexOf(stage)) at = null;
    }
    return at;
  }
  const screened = (a, top) => top >= 1 || (a.status || 'New') !== 'New' || (a.history || []).some((h) => h.from === 'New');
  const firstReviewAt = (a) => ((a.history || []).find((h) => h.from === 'New') || {}).at || null;

  // Everything one request needs, with the person's scope and the filters applied.
  function dataset(scope, f) {
    const today = dayKey(now());
    const inRange = (d) => { const k = ymd(d); return Boolean(k) && k >= f.from && k <= f.to; };
    const allJobs = getJobs().filter((j) => j.sample !== true);
    const jobById = new Map(allJobs.map((j) => [j.id, j]));
    const statusOfJob = (j) => (j.status === 'open' && j.closesOn && j.closesOn < today ? 'closed' : j.status || 'open');
    const jobMatches = (j) => (!f.work || workOf(j) === f.work)
      && (!f.hiringType || (JOB_TYPE_KIND[j.type] || 'permanent') === f.hiringType)
      && (!f.location || String(j.location || '').toLowerCase() === f.location.toLowerCase())
      && (!f.industry || String(j.category || '').toLowerCase() === f.industry.toLowerCase())
      && (!f.employer || j.employerId === f.employer)
      && (!f.jobStatus || statusOfJob(j) === f.jobStatus);
    const visibleJob = scope.as === 'employer'
      ? (j) => j.employerId === scope.employer.id && employerTeam.can(scope.member, 'job.view', j)
      : () => true;
    const jobs = allJobs.filter((j) => visibleJob(j) && jobMatches(j));
    const jobIds = new Set(jobs.map((j) => j.id));
    // Whose work: one recruiter (a filter, or a recruiter's own scope) or everyone.
    const who = scope.as === 'team' ? (scope.allRecruiters ? f.recruiter : scope.user.id) : f.recruiter;
    const ownerOf = scope.as === 'team' ? (a) => appOwner(a) : (a) => a.assignedTo || '';
    const placementsAll = billing.read().filter((p) => (scope.as !== 'employer' || p.employerId === scope.employer.id));
    const placedIds = new Set(placementsAll.map((p) => p.appId).filter(Boolean));
    const apps = readSubmissions('applications').filter((a) => jobIds.has(a.jobId) && !a.duplicateOf && (!who || ownerOf(a) === who));
    const stageNow = (a) => (a.withdrawnAt ? 'Withdrawn' : a.status || 'New');
    const appsFiltered = f.applicationStatus ? apps.filter((a) => stageNow(a) === f.applicationStatus) : apps;
    const anyJobFilter = f.work || f.location || f.industry || f.jobStatus;
    const appById = new Map(readSubmissions('applications').map((a) => [a.id, a]));
    // The recruiter on a placement: recorded on it, else who owns the application or the job.
    const placementOwner = (p) => (scope.as === 'employer' ? (appById.get(p.appId) || {}).assignedTo || ''
      : p.recruiterId || (appById.has(p.appId) ? ownerOf(appById.get(p.appId)) : (jobById.get(p.jobId) || {}).ownerId || ''));
    const placements = placementsAll.filter((p) => {
      const job = jobById.get(p.jobId);
      if (scope.as === 'employer' && job && !employerTeam.can(scope.member, 'job.view', job)) return false;
      if (scope.as === 'employer' && !job && !['owner', 'viewer'].includes(scope.member.role)) return false;
      if (anyJobFilter && !(job && jobIds.has(job.id))) return false;
      if (f.employer && p.employerId !== f.employer) return false;
      if (f.hiringType && PLACEMENT_TYPE_KIND[p.type] !== f.hiringType) return false;
      if (f.placementStatus && p.status !== f.placementStatus) return false;
      if (who && placementOwner(p) !== who) return false;
      return true;
    });
    const vacancies = jobs.filter((j) => !who || scope.as === 'employer' || j.ownerId === who);
    return { today, inRange, jobs, vacancies, jobById, apps: appsFiltered, allApps: apps, placements, placementsAll, placedIds, ownerOf, placementOwner, who, statusOfJob };
  }

  const hireDateOf = (a, d) => {
    const fromStage = furthest(a, new Set()) === PIPE.indexOf('Hired') ? enteredAt(a, 'Hired') : null;
    const fromPlacement = d.placementsAll.filter((p) => p.appId === a.id && !p.replacementFor).map((p) => p.createdAt).sort()[0] || null;
    return [fromStage, fromPlacement].filter(Boolean).sort()[0] || null;
  };
  const offerOf = (a) => {
    const offers = (a.offers || []).filter((o) => o.approval && o.approval.status === 'approved' && !o.withdrawnAt);
    const made = offers.map((o) => o.approval.at).sort()[0] || enteredAt(a, 'Offered');
    return made ? { at: made, accepted: offers.some((o) => o.response && o.response.status === 'accepted'), declined: offers.some((o) => o.response && o.response.status === 'declined') && !offers.some((o) => o.response && o.response.status === 'accepted') } : null;
  };

  // Day, week or month buckets for a range.
  function buckets(f) {
    const span = spanDays(f.from, f.to);
    const unit = span <= 31 ? 'day' : span <= 183 ? 'week' : 'month';
    const keyOf = (k) => {
      if (unit === 'day') return k;
      if (unit === 'month') return k.slice(0, 7);
      const dow = (new Date(`${k}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday starts a week
      const start = addDays(k, -dow);
      return start < f.from ? f.from : start;
    };
    const keys = [];
    for (let k = f.from; k <= f.to; k = addDays(k, 1)) { const b = keyOf(k); if (keys[keys.length - 1] !== b) keys.push(b); }
    return { unit, keys, keyOf };
  }
  function series(f, events) {
    const b = buckets(f);
    const rows = b.keys.map((key) => ({ key, ...Object.fromEntries(Object.keys(events).map((n) => [n, 0])) }));
    const at = new Map(rows.map((r) => [r.key, r]));
    for (const [name, list] of Object.entries(events)) {
      for (const [d, n = 1] of list) {
        const k = ymd(d);
        if (k && k >= f.from && k <= f.to) at.get(b.keyOf(k))[name] += n;
      }
    }
    return { unit: b.unit, rows };
  }

  function funnel(d, f) {
    const cohort = d.apps.filter((a) => d.inRange(a.createdAt));
    const tops = cohort.map((a) => ({ a, top: furthest(a, d.placedIds) }));
    const stages = [
      { key: 'applied', label: 'Applied', count: cohort.length },
      { key: 'screened', label: 'Screened', count: tops.filter(({ a, top }) => screened(a, top)).length },
      ...PIPE.slice(2).map((s) => ({ key: s.toLowerCase(), label: ats.label(s), count: tops.filter(({ top }) => top >= PIPE.indexOf(s)).length })),
    ];
    stages.forEach((s, i) => {
      s.percentOfApplied = pct(s.count, cohort.length);
      const next = stages[i + 1];
      s.toNext = next ? pct(next.count, s.count) : null;
    });
    const byWork = WORK_KINDS.map((w) => {
      const mine = tops.filter(({ a }) => workOf(d.jobById.get(a.jobId)) === w.key);
      return { key: w.key, label: w.label, applied: mine.length, interviewed: mine.filter(({ top }) => top >= PIPE.indexOf('Interview')).length, hired: mine.filter(({ top }) => top >= PIPE.indexOf('Hired')).length };
    });
    return {
      cohort: { from: f.from, to: f.to, applications: cohort.length },
      stages,
      outcomes: { withdrawn: cohort.filter((a) => a.withdrawnAt).length, rejected: cohort.filter((a) => a.status === 'Rejected' && !a.withdrawnAt).length, onHold: cohort.filter((a) => a.status === 'On hold' && !a.withdrawnAt).length, active: cohort.filter((a) => !a.withdrawnAt && !ats.CLOSED.includes(a.status || 'New')).length },
      byWork,
    };
  }

  function timing(d) {
    const hires = d.apps.map((a) => ({ a, at: hireDateOf(a, d) })).filter((h) => h.at && d.inRange(h.at));
    const hireDays = hires.map(({ a, at }) => (Date.parse(at) - Date.parse(a.createdAt)) / DAY).filter((x) => x >= 0);
    const opened = (j) => (j.approvedAt ? Date.parse(j.approvedAt) : j.posted ? Date.parse(`${j.posted}T00:00:00+05:30`) : null);
    const fills = d.vacancies.map((j) => {
      const first = d.allApps.filter((a) => a.jobId === j.id).map((a) => hireDateOf(a, d)).filter(Boolean).sort()[0] || null;
      const start = opened(j);
      return { jobId: j.id, title: j.title, company: j.company, status: d.statusOfJob(j), openedOn: start ? dayKey(start) : null, firstHireOn: first ? dayKey(first) : null, days: first && start ? Math.round(((Date.parse(first) - start) / DAY) * 10) / 10 : null };
    });
    const filledInRange = fills.filter((x) => x.firstHireOn && d.inRange(x.firstHireOn) && x.days !== null && x.days >= 0);
    const bands = [[0, 7, '0–7 days'], [7, 14, '8–14 days'], [14, 30, '15–30 days'], [30, 60, '31–60 days'], [60, Infinity, 'Over 60 days']];
    return {
      timeToHire: { medianDays: median(hireDays), averageDays: mean(hireDays), hires: hireDays.length, bands: bands.map(([lo, hi, label]) => ({ label, hires: hireDays.filter((x) => (lo === 0 ? x >= 0 : x > lo) && x <= hi).length })) },
      timeToFill: { medianDays: median(filledInRange.map((x) => x.days)), averageDays: mean(filledInRange.map((x) => x.days)), jobs: filledInRange.length },
      vacancies: fills.sort((x, y) => String(y.firstHireOn || '').localeCompare(String(x.firstHireOn || '')) || x.title.localeCompare(y.title)),
    };
  }

  function offers(d) {
    const list = d.apps.map((a) => ({ a, o: offerOf(a) })).filter(({ o }) => o && d.inRange(o.at));
    const accepted = list.filter(({ a, o }) => o.accepted || furthest(a, d.placedIds) === PIPE.indexOf('Hired')).length;
    return { made: list.length, accepted, declined: list.filter(({ o }) => o.declined).length };
  }

  function placementSummary(d) {
    const inRange = d.placements.filter((p) => d.inRange(p.createdAt));
    const main = inRange.filter((p) => !p.replacementFor);
    const by = (fn, keys) => keys.map((k) => ({ key: k, count: main.filter((p) => fn(p) === k).length }));
    return {
      count: main.length,
      replacements: inRange.length - main.length,
      byType: by((p) => PLACEMENT_TYPE_KIND[p.type] || 'permanent', Object.keys(HIRING_TYPES)).map((x) => ({ ...x, label: HIRING_TYPES[x.key] })),
      byStatus: by((p) => p.status, billing.STATUSES).map((x) => ({ ...x, label: x.key })),
      byWork: WORK_KINDS.map((w) => ({ key: w.key, label: w.label, count: main.filter((p) => d.jobById.get(p.jobId) && workOf(d.jobById.get(p.jobId)) === w.key).length })),
      rows: inRange.sort((x, y) => y.createdAt.localeCompare(x.createdAt)).map((p) => ({ id: p.id, recordedOn: dayKey(p.createdAt), candidateName: p.candidateName || '', jobTitle: p.jobTitle || '', company: p.company || '', type: p.type, status: p.status, joiningDate: p.joiningDate || '', replacement: Boolean(p.replacementFor) })),
    };
  }

  function revenue(d, f) {
    const invoices = d.placements.flatMap((p) => billing.invoicesOf(p).map((inv) => ({ p, inv }))).filter(({ inv }) => inv.status !== 'Cancelled');
    const overdue = (inv) => OPEN_INVOICE.includes(inv.status) && inv.dueDate && inv.dueDate < d.today;
    const match = ({ inv }) => !f.revenueStatus
      || (f.revenueStatus === 'invoiced')
      || (f.revenueStatus === 'paid' && inv.status === 'Paid')
      || (f.revenueStatus === 'overdue' && overdue(inv))
      || (f.revenueStatus === 'refunded' && (inv.refunds || []).length > 0);
    const list = invoices.filter(match);
    const sumOf = (xs, fn) => xs.reduce((n, x) => n + fn(x), 0);
    const credits = list.flatMap(({ inv }) => (inv.creditNotes || []).filter((c) => d.inRange(c.date)));
    const payments = list.flatMap(({ inv }) => (inv.payments || []).filter((x) => d.inRange(x.date)));
    const refunds = list.flatMap(({ inv }) => (inv.refunds || []).filter((x) => d.inRange(x.date)));
    const issued = list.filter(({ inv }) => d.inRange(inv.date));
    const open = list.filter(({ inv }) => OPEN_INVOICE.includes(inv.status));
    const balance = ({ inv }) => paise(accountOf(inv).balance);
    return {
      currency: 'INR', unit: 'paise',
      invoicedPaise: sumOf(issued, ({ inv }) => paise(inv.total)) - sumOf(credits, (c) => paise(c.total)),
      invoicesIssued: issued.length,
      creditNotesPaise: sumOf(credits, (c) => paise(c.total)),
      collectedPaise: sumOf(payments, (x) => paise(x.amount) + paise(x.tds)) - sumOf(refunds, (x) => paise(x.amount)),
      refundedPaise: sumOf(refunds, (x) => paise(x.amount)),
      outstandingPaise: sumOf(open, balance),
      outstandingInvoices: open.length,
      overduePaise: sumOf(open.filter(({ inv }) => overdue(inv)), balance),
      overdueInvoices: open.filter(({ inv }) => overdue(inv)).length,
      series: series(f, {
        collectedPaise: [...payments.map((x) => [x.date, paise(x.amount) + paise(x.tds)]), ...refunds.map((x) => [x.date, -paise(x.amount)])],
        invoicedPaise: [...issued.map(({ inv }) => [inv.date, paise(inv.total)]), ...credits.map((c) => [c.date, -paise(c.total)])],
      }),
      rows: list.sort((x, y) => String(y.inv.date).localeCompare(String(x.inv.date))).map(({ p, inv }) => ({
        number: inv.number || '', date: inv.date, dueDate: inv.dueDate || '', company: p.company || '', status: overdue(inv) ? 'Overdue' : inv.status,
        totalPaise: paise(inv.total), balancePaise: OPEN_INVOICE.includes(inv.status) ? balance({ inv }) : 0, refundedPaise: sumOf(inv.refunds || [], (x) => paise(x.amount)),
      })),
    };
  }

  // Each recruiter's (or each company member's) work in the range.
  function recruiters(scope, d) {
    let people;
    if (scope.as === 'team') {
      people = team.members().filter((u) => roles.can(u, 'requisitions.view') || roles.can(u, 'staffing.manage')).map((u) => ({ id: u.id, name: u.name, role: (roles.ROLE_INFO[u.role] || {}).label || u.role }));
      if (!scope.allRecruiters) people = people.filter((p) => p.id === scope.user.id);
    } else {
      people = clients.team.membersOf(scope.employer.id).filter((m) => m.role !== 'supervisor').map((m) => ({ id: m.userId, name: (clients.team.userById(m.userId) || {}).name || 'Former member', role: (employerTeam.ROLES[m.role] || {}).label || m.role }));
      if (!employerTeam.can(scope.member, 'workload.view')) people = people.filter((p) => p.id === scope.member.userId);
    }
    if (d.who) people = people.filter((p) => p.id === d.who);
    const nowMs = now();
    const rows = people.map((p) => {
      const mine = d.allApps.filter((a) => d.ownerOf(a) === p.id);
      const offered = mine.map((a) => ({ a, o: offerOf(a) })).filter(({ o }) => o && d.inRange(o.at));
      const hires = mine.map((a) => ({ a, at: hireDateOf(a, d) })).filter((h) => h.at && d.inRange(h.at));
      const placed = d.placements.filter((p2) => d.inRange(p2.createdAt) && !p2.replacementFor && d.placementOwner(p2) === p.id);
      return {
        id: p.id, name: p.name, role: p.role,
        vacancies: scope.as === 'team' ? d.vacancies.filter((j) => j.ownerId === p.id && d.statusOfJob(j) === 'open').length : null,
        activeCandidates: mine.filter((a) => !a.withdrawnAt && !ats.CLOSED.includes(a.status || 'New')).length,
        screened: mine.filter((a) => d.inRange(firstReviewAt(a))).length,
        interviews: mine.reduce((n, a) => n + (a.interviews || []).filter((iv) => iv.status !== 'cancelled' && d.inRange(iv.createdAt)).length, 0),
        offersMade: offered.length,
        offersAccepted: offered.filter(({ a, o }) => o.accepted || furthest(a, d.placedIds) === PIPE.indexOf('Hired')).length,
        placements: placed.length,
        medianDaysToHire: median(hires.map(({ a, at }) => (Date.parse(at) - Date.parse(a.createdAt)) / DAY).filter((x) => x >= 0)),
        overdueFollowUps: mine.filter((a) => !a.withdrawnAt && (a.status || 'New') === 'New' && nowMs - Date.parse(a.createdAt) > OVERDUE_FOLLOW_UP_DAYS * DAY).length,
        upcomingInterviews: mine.reduce((n, a) => n + (a.interviews || []).filter((iv) => iv.status === 'scheduled' && Date.parse(iv.at) > nowMs && Date.parse(iv.at) < nowMs + 7 * DAY).length, 0),
      };
    });
    return rows.sort((x, y) => y.placements - x.placements || y.interviews - x.interviews || x.name.localeCompare(y.name));
  }

  function upcoming(d) {
    const nowMs = now();
    return d.apps.flatMap((a) => (a.interviews || []).filter((iv) => iv.status === 'scheduled' && Date.parse(iv.at) > nowMs && Date.parse(iv.at) < nowMs + 14 * DAY).map((iv) => ({ at: iv.at, mode: iv.mode, jobTitle: a.jobTitle || (d.jobById.get(a.jobId) || {}).title || '' })))
      .sort((x, y) => x.at.localeCompare(y.at)).slice(0, 20);
  }

  function kpis(scope, d, f) {
    const cohort = d.apps.filter((a) => d.inRange(a.createdAt));
    const tops = cohort.map((a) => furthest(a, d.placedIds));
    const t = timing(d);
    const o = offers(d);
    const placed = d.placements.filter((p) => d.inRange(p.createdAt) && !p.replacementFor);
    const placedApps = new Set(d.placementsAll.map((p) => p.appId));
    const cohortPlaced = cohort.filter((a, i) => tops[i] === PIPE.indexOf('Hired') || placedApps.has(a.id)).length;
    // Job-page views are counted per kind of work only, for the whole site.
    const viewsComparable = scope.as === 'team' && scope.allRecruiters && !f.recruiter && !f.employer && !f.location && !f.industry && !f.hiringType && !f.jobStatus && !f.applicationStatus;
    const views = viewsComparable && siteAnalytics ? siteAnalytics.countFor('job-view', f.from, f.to, f.work ? WORK_KINDS.find((w) => w.key === f.work).label : null) : null;
    const active = recruiters(scope, d).filter((r) => r.screened || r.interviews || r.placements).length;
    const k = (id, value, extra = {}) => ({ id, label: DEFINITIONS[id].label, value, definition: DEFINITIONS[id], ...extra });
    const out = [
      k('applications', cohort.length),
      k('applicationConversion', views ? pct(cohort.length, views) : null, { unit: '%', numerator: cohort.length, denominator: views, note: views === null ? 'not available with these filters' : !views ? 'no job-page views counted in this range' : '' }),
      k('interviewRate', pct(tops.filter((x) => x >= PIPE.indexOf('Interview')).length, cohort.length), { unit: '%', numerator: tops.filter((x) => x >= PIPE.indexOf('Interview')).length, denominator: cohort.length }),
      k('offerAcceptance', pct(o.accepted, o.made), { unit: '%', numerator: o.accepted, denominator: o.made }),
      k('timeToHire', t.timeToHire.medianDays, { unit: 'days', denominator: t.timeToHire.hires }),
      k('timeToFill', t.timeToFill.medianDays, { unit: 'days', denominator: t.timeToFill.jobs }),
      k('placementRate', pct(cohortPlaced, cohort.length), { unit: '%', numerator: cohortPlaced, denominator: cohort.length }),
      k('placements', placed.length),
    ];
    if (scope.as === 'team') out.push(k('recruiterProductivity', active ? Math.round((placed.length / active) * 10) / 10 : null, { numerator: placed.length, denominator: active }));
    if (scope.money) {
      const r = revenue(d, f);
      out.push(k('revenueCollected', r.collectedPaise, { unit: 'paise' }), k('invoiced', r.invoicedPaise, { unit: 'paise' }), k('outstandingInvoices', r.outstandingPaise, { unit: 'paise', count: r.outstandingInvoices, overduePaise: r.overduePaise, overdueCount: r.overdueInvoices }));
    }
    return out;
  }

  // Platform-wide figures for Admins.
  function platform(d, f) {
    const candidates = readSubmissions('candidates');
    const companies = clients.read();
    const verification = { verified: 0, pending: 0, declined: 0 };
    for (const c of companies) { const v = clients.verificationOf(c); if (verification[v] !== undefined) verification[v]++; }
    const jobsLive = getJobs().filter((j) => j.sample !== true && d.statusOfJob(j) === 'open');
    const snap = ops ? ops.snapshot() : { jobs: [] };
    const t = trust ? trust.overview() : null;
    return {
      candidatesRegistered: candidates.filter((c) => d.inRange(c.createdAt)).length,
      candidatesTotal: candidates.length,
      employersRegistered: companies.filter((c) => d.inRange(c.createdAt)).length,
      employers: { total: companies.length, ...verification },
      activeJobs: jobsLive.length,
      failedBackgroundJobs: snap.jobs.filter((j) => j.failing || j.overdue).map((j) => ({ name: j.name, failing: j.failing, overdue: j.overdue, lastRunAt: j.lastRunAt, lastError: j.lastError })),
      moderationBacklog: t ? { verificationsWaiting: t.verification.waiting, listingsWaiting: t.listings.waitingReview, listingsFlagged: t.listings.flagged, listingsReported: t.listings.reported, casesOpen: t.cases.open, appealsWaiting: t.appeals.waiting } : null,
      activity: series(f, {
        applications: readSubmissions('applications').filter((a) => !a.duplicateOf && a.jobId !== 'general').map((a) => [a.createdAt]),
        candidateSignUps: candidates.map((c) => [c.createdAt]),
        employerSignUps: companies.map((c) => [c.createdAt]),
      }),
    };
  }

  // The employer's own view: each vacancy, requests to Hireriv, activity by kind.
  function employerBlocks(scope, d) {
    const reqs = agency ? agency.requisitions().filter((r) => r.employerId === scope.employer.id) : [];
    const cohort = d.apps.filter((a) => d.inRange(a.createdAt));
    const by = (fn) => Object.entries(cohort.reduce((m, a) => { const k = fn(d.jobById.get(a.jobId) || {}) || 'Not given'; m[k] = (m[k] || 0) + 1; return m; }, {})).map(([label, count]) => ({ label, count })).sort((x, y) => y.count - x.count);
    return {
      hiringRequests: { completed: reqs.filter((r) => r.status === 'Filled').length, pending: reqs.filter((r) => ['Requested', 'Open', 'On hold'].includes(r.status)).length, cancelled: reqs.filter((r) => r.status === 'Cancelled').length },
      byCategory: by((j) => j.category), byLocation: by((j) => j.location), byType: by((j) => j.type),
    };
  }

  function vacancyRows(d) {
    return d.vacancies.map((j) => {
      const mine = d.apps.filter((a) => a.jobId === j.id);
      const tops = mine.map((a) => furthest(a, d.placedIds));
      return {
        jobId: j.id, title: j.title, location: j.location || '', status: d.statusOfJob(j), applications: mine.length, newInRange: mine.filter((a) => d.inRange(a.createdAt)).length,
        shortlisted: tops.filter((x) => x >= PIPE.indexOf('Shortlisted')).length, interviewed: tops.filter((x) => x >= PIPE.indexOf('Interview')).length,
        offered: tops.filter((x) => x >= PIPE.indexOf('Offered')).length, hired: tops.filter((x) => x === PIPE.indexOf('Hired')).length,
      };
    }).sort((x, y) => y.applications - x.applications || x.title.localeCompare(y.title));
  }

  const page = (rows, f) => ({ total: rows.length, page: f.page, pageSize: f.pageSize, pages: Math.max(1, Math.ceil(rows.length / f.pageSize)), rows: rows.slice((f.page - 1) * f.pageSize, f.page * f.pageSize) });

  // One report by name, for the API, the pages and the CSV export.
  function report(name, scope, f) {
    const d = dataset(scope, f);
    switch (name) {
      case 'overview': {
        const out = {
          kpis: kpis(scope, d, f),
          activity: series(f, {
            applications: d.apps.map((a) => [a.createdAt]),
            interviews: d.apps.flatMap((a) => (a.interviews || []).filter((iv) => iv.status !== 'cancelled').map((iv) => [iv.createdAt])),
            placements: d.placements.filter((p) => !p.replacementFor).map((p) => [p.createdAt]),
          }),
          upcomingInterviews: upcoming(d),
          vacancies: { open: d.vacancies.filter((j) => d.statusOfJob(j) === 'open').length, total: d.vacancies.length },
        };
        if (scope.platform) out.platform = platform(d, f);
        if (scope.as === 'employer') { out.employer = employerBlocks(scope, d); out.perVacancy = page(vacancyRows(d), f); }
        return out;
      }
      case 'recruitment-funnel': return funnel(d, f);
      case 'time-to-hire': { const t = timing(d); return { timeToHire: t.timeToHire, timeToFill: t.timeToFill, vacancies: page(t.vacancies, f) }; }
      case 'recruiter-performance': return { recruiters: page(recruiters(scope, d), f), overdueAfterDays: OVERDUE_FOLLOW_UP_DAYS };
      case 'placements': { const p = placementSummary(d); return { ...p, series: series(f, { placements: d.placements.filter((x) => !x.replacementFor).map((x) => [x.createdAt]) }), rows: undefined, list: page(p.rows, f) }; }
      case 'revenue': { const r = revenue(d, f); return { ...r, rows: undefined, invoices: page(r.rows, f) }; }
      case 'vacancies': return { vacancies: page(vacancyRows(d), f) };
      default: return null;
    }
  }

  // Flat rows for CSV: every row the report has, not one page.
  function exportRows(name, scope, f) {
    const all = { ...f, page: 1, pageSize: 1e9 };
    const r = report(name, scope, all);
    const rupees = (p) => (p / 100).toFixed(2);
    switch (name) {
      case 'overview': return r.kpis.map((k) => ({ kpi: k.label, value: k.unit === 'paise' ? rupees(k.value) : k.value ?? '', unit: k.unit === 'paise' ? 'INR' : k.unit || 'count', numerator: k.numerator ?? '', denominator: k.denominator ?? '', from: f.from, to: f.to, timezone: TZ, definition: k.definition.formula }));
      case 'recruitment-funnel': return r.stages.map((s) => ({ stage: s.label, applications: s.count, percentOfApplied: s.percentOfApplied ?? '', toNextStage: s.toNext ?? '', from: f.from, to: f.to }));
      case 'time-to-hire': return r.vacancies.rows.map((v) => ({ job: v.title, company: v.company || '', status: v.status, openedOn: v.openedOn || '', firstHireOn: v.firstHireOn || '', daysToFill: v.days ?? '' }));
      case 'recruiter-performance': return r.recruiters.rows.map(({ id, ...x }) => ({ ...x, vacancies: x.vacancies ?? '', medianDaysToHire: x.medianDaysToHire ?? '', from: f.from, to: f.to }));
      case 'placements': return r.list.rows;
      case 'revenue': return r.invoices.rows.map((x) => ({ invoice: x.number, date: x.date, dueDate: x.dueDate, client: x.company, status: x.status, totalInr: rupees(x.totalPaise), balanceInr: rupees(x.balancePaise), refundedInr: rupees(x.refundedPaise) }));
      case 'vacancies': return r.vacancies.rows.map(({ jobId, ...x }) => x);
      default: return null;
    }
  }

  return { report, exportRows, dataset, furthest, parseFilters };
}

const REPORTS = ['overview', 'recruitment-funnel', 'time-to-hire', 'recruiter-performance', 'placements', 'revenue', 'vacancies'];

// ---------- routes ----------
function register(app, deps) {
  const { team, clients, limit, adminAuth, requireEmployer, sendCsv } = deps;
  const core = create(deps);

  // Who is asking, from the session only. Team members need the analytics
  // permission (and two-step sign-in where the team requires it); employer
  // people need their role's analytics permission.
  function scopeOf(req, want = String(req.query.as || '')) {
    const user = team.currentUser(req);
    const teamOk = user && !(team.mustUse2fa(user) && !team.has2fa(user.id));
    const c = clients.context(req);
    if (teamOk && want !== 'employer') {
      if (!roles.can(user, 'analytics.view')) return { error: 403 };
      return { as: 'team', user, role: user.role, allRecruiters: roles.can(user, 'workload.view'), money: roles.can(user, 'money.view'), platform: roles.can(user, 'analytics.platform') };
    }
    if (c && want !== 'team') {
      if (!employerTeam.can(c.member, 'analytics.view')) return { error: 403 };
      return { as: 'employer', user: c.user, employer: c.employer, member: c.member, money: employerTeam.can(c.member, 'billing.view'), platform: false };
    }
    return { error: user ? 403 : 401 };
  }
  // Filters a person may use: other companies and other people are "not found".
  function checkScope(scope, f) {
    if (scope.as === 'employer') {
      if (f.employer && f.employer !== scope.employer.id) return { status: 404, error: 'employer not found' };
      if (f.recruiter && !clients.team.membersOf(scope.employer.id).some((m) => m.userId === f.recruiter)) return { status: 404, error: 'recruiter not found' };
      if (f.recruiter && f.recruiter !== scope.member.userId && !employerTeam.can(scope.member, 'workload.view')) return { status: 403, error: 'your role shows only your own work' };
    } else {
      if (f.employer && !clients.read().some((c) => c.id === f.employer)) return { status: 404, error: 'employer not found' };
      if (f.recruiter && !team.members().some((u) => u.id === f.recruiter)) return { status: 404, error: 'recruiter not found' };
      if (f.recruiter && f.recruiter !== scope.user.id && !scope.allRecruiters) return { status: 403, error: 'your role shows only your own work' };
    }
    return null;
  }
  const audit = (scope, action, f) => {
    const detail = `${f.from} to ${f.to}${['work', 'hiringType', 'location', 'industry', 'employer', 'recruiter', 'jobStatus', 'applicationStatus', 'placementStatus', 'revenueStatus'].filter((k) => f[k]).map((k) => `, ${k}=${f[k]}`).join('')}`;
    if (scope.as === 'team') team.log(scope.user, action, detail);
    else clients.team.audit(scope.employer.id, scope.user, action, detail);
  };
  const scopeJson = (s) => (s.as === 'team' ? { as: 'team', role: s.role, allRecruiters: s.allRecruiters, money: s.money } : { as: 'employer', employerId: s.employer.id, role: s.member.role, money: s.money });
  const filtersJson = (f) => Object.fromEntries(Object.entries(f).filter(([k, v]) => v !== '' && k !== 'as'));

  const apiLimit = limit('analytics', 120, 60 * 1000);
  // Any signed-in account whose role includes analytics (team or employer),
  // with filters it may use; the report itself is scoped from the session.
  function anyAccountAnalytics(req, res, next) {
    res.set('Cache-Control', 'no-store');
    const scope = scopeOf(req);
    if (scope.error) return res.status(scope.error).json({ ok: false, errors: [scope.error === 401 ? 'sign in first' : 'your role does not include analytics'] });
    const { f, errors } = core.parseFilters(req.query);
    if (errors.length) return res.status(400).json({ ok: false, errors });
    const bad = checkScope(scope, f);
    if (bad) return res.status(bad.status).json({ ok: false, errors: [bad.error] });
    Object.assign(req, { scope, filters: f });
    next();
  }
  const moneyOnly = (req, res, next) => (req.scope.money ? next() : res.status(403).json({ ok: false, errors: ['your role does not include this report'] }));
  function answer(req, res, name) {
    const { scope, filters: f } = req;
    const started = Date.now();
    const data = core.report(name, scope, f);
    if (name === 'revenue') audit(scope, 'Viewed the revenue report', f);
    res.json({ ok: true, report: name, scope: scopeJson(scope), filters: filtersJson(f), period: { from: f.from, to: f.to, label: f.label, timezone: TZ }, generatedAt: new Date().toISOString(), tookMs: Date.now() - started, definitions: DEFINITIONS, data });
  }
  app.get('/api/analytics/overview', apiLimit, anyAccountAnalytics, (req, res) => answer(req, res, 'overview'));
  app.get('/api/analytics/recruitment-funnel', apiLimit, anyAccountAnalytics, (req, res) => answer(req, res, 'recruitment-funnel'));
  app.get('/api/analytics/time-to-hire', apiLimit, anyAccountAnalytics, (req, res) => answer(req, res, 'time-to-hire'));
  app.get('/api/analytics/recruiter-performance', apiLimit, anyAccountAnalytics, (req, res) => answer(req, res, 'recruiter-performance'));
  app.get('/api/analytics/placements', apiLimit, anyAccountAnalytics, (req, res) => answer(req, res, 'placements'));
  app.get('/api/analytics/revenue', apiLimit, anyAccountAnalytics, moneyOnly, (req, res) => answer(req, res, 'revenue'));
  // CSV with the same filters and permissions; every export is recorded.
  app.get('/api/analytics/reports/:reportId/export', limit('analytics-export', 30), anyAccountAnalytics, (req, res) => {
    const { scope, filters: f } = req;
    if (!REPORTS.includes(req.params.reportId)) return res.status(404).json({ ok: false, errors: [`report must be one of: ${REPORTS.join(', ')}`] });
    if (req.params.reportId === 'revenue' && !scope.money) return res.status(403).json({ ok: false, errors: ['your role does not include this report'] });
    const rows = core.exportRows(req.params.reportId, scope, f);
    audit(scope, `Exported analytics: ${req.params.reportId} (${rows.length} rows)`, f);
    sendCsv(res, `analytics-${req.params.reportId}-${f.from}-to-${f.to}`, rows.length ? rows : [{ note: 'No records match these filters' }]);
  });

  // ---------- dashboards ----------
  function dashboard(req, res, as) {
    const scope = scopeOf(req, as);
    if (scope.error) return res.status(403).render('thanks', { title: 'Not part of your role', page: '', ok: false, message: 'Your role does not include analytics.', noindex: true });
    const query = { ...req.query };
    delete query.as;
    let { f, errors } = core.parseFilters(query);
    const bad = !errors.length && checkScope(scope, f);
    if (bad) errors = [bad.error];
    if (errors.length) f = core.parseFilters({}).f;
    const reports = { overview: core.report('overview', scope, f), funnel: core.report('recruitment-funnel', scope, f), timing: core.report('time-to-hire', scope, f), recruiters: core.report('recruiter-performance', scope, f), placements: core.report('placements', scope, f) };
    if (scope.money) { reports.revenue = core.report('revenue', scope, f); audit(scope, 'Viewed the revenue report', f); }
    const options = {
      employers: scope.as === 'team' ? clients.read().map((c) => ({ id: c.id, name: c.company })).sort((x, y) => x.name.localeCompare(y.name)) : [],
      recruiters: scope.as === 'team' ? (scope.allRecruiters ? team.members().filter((u) => roles.can(u, 'requisitions.view') || roles.can(u, 'staffing.manage')).map((u) => ({ id: u.id, name: u.name })) : [])
        : (employerTeam.can(scope.member, 'workload.view') ? clients.team.membersOf(scope.employer.id).filter((m) => m.role !== 'supervisor').map((m) => ({ id: m.userId, name: (clients.team.userById(m.userId) || {}).name || 'Former member' })) : []),
      industries: [...new Set(deps.getJobs().filter((j) => j.sample !== true && (scope.as === 'team' || j.employerId === scope.employer.id)).map((j) => j.category).filter(Boolean))].sort(),
      locations: [...new Set(deps.getJobs().filter((j) => j.sample !== true && (scope.as === 'team' || j.employerId === scope.employer.id)).map((j) => j.location).filter(Boolean))].sort(),
    };
    const exportQuery = new URLSearchParams(Object.entries(filtersJson(f)).filter(([k]) => !['page', 'pageSize', 'label', 'from', 'to'].includes(k) || f.period === 'custom').map(([k, v]) => [k, String(v)]));
    if (f.period !== 'custom') { exportQuery.delete('from'); exportQuery.delete('to'); }
    if (as) exportQuery.set('as', as);
    res.status(errors.length ? 400 : 200).set('Cache-Control', 'private, no-store').render('analytics', {
      title: scope.as === 'team' ? 'Analytics' : `${scope.employer.company} · Analytics`, page: scope.as === 'team' ? 'admin' : 'employer', noindex: true,
      scope, f, errors, reports, options, DEFINITIONS, PERIODS, HIRING_TYPES, WORK_KINDS, JOB_STATUSES, APP_STATUSES, REVENUE_STATUSES, placementStatuses: deps.billing.STATUSES,
      exportQuery: exportQuery.toString(), base: scope.as === 'team' ? '/admin/analytics' : '/employer/analytics', admin: scope.as === 'team' ? scope.user : null, tab: 'analytics',
    });
  }
  app.get('/admin/analytics', adminAuth, (req, res) => dashboard(req, res, 'team'));
  app.get('/employer/analytics', requireEmployer, (req, res) => dashboard(req, res, 'employer'));
  app.get('/analytics', (req, res) => res.redirect('/admin/analytics'));

  return core;
}

module.exports = { create, register, parseFilters, DEFINITIONS, PERIODS, HIRING_TYPES, REPORTS, JOB_TYPE_KIND, PLACEMENT_TYPE_KIND };
