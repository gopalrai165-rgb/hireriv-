// Recruitment agency and staffing management, on top of what exists: clients
// are the employer accounts (employers.js), placements and invoices stay in
// placements.js, and the team and its sign-in in team.js.
//
// New here: client contracts (the fee terms agreed with each client), an
// account manager per client, requisitions (a client's request to fill a
// number of openings, with recruiters assigned), staffing assignments for
// temporary and contract workers, invoice drafts (asked for by the team,
// issued by Finance through the existing billing, idempotent), recruitment
// reports and an audit log.
//
// Money is kept in whole paise (integers) and percentages in basis points
// (8.33% = 833), so nothing is lost to floating point. There is no built-in
// commission rate: fees come from the client's contract, else from Settings.
const crypto = require('crypto');
const roles = require('./agency-roles');

// ---------- money ----------
const MONEY_RE = /^\d{1,11}(\.\d{1,2})?$/;
// "1,50,000.50" or "₹1,50,000" → 15000050 paise; '' → null; anything else → NaN.
function paiseFrom(v) {
  const raw = String(v ?? '').replace(/[,₹\s]/g, '');
  if (raw === '') return null;
  if (!MONEY_RE.test(raw)) return NaN;
  const [r, p = ''] = raw.split('.');
  return Number(r) * 100 + Number(p.padEnd(2, '0'));
}
// "8.33" → 833 basis points (up to 100%).
function bpFrom(v) {
  const raw = String(v ?? '').trim().replace(/%$/, '');
  if (raw === '') return null;
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(raw)) return NaN;
  const [w, f = ''] = raw.split('.');
  const bp = Number(w) * 100 + Number(f.padEnd(2, '0'));
  return bp > 10000 ? NaN : bp;
}
// Quantities (days, hours, months) to two decimals, in hundredths.
function qtyFrom(v) {
  const raw = String(v ?? '').trim();
  if (raw === '') return null;
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(raw)) return NaN;
  const [w, f = ''] = raw.split('.');
  return Number(w) * 100 + Number(f.padEnd(2, '0'));
}
// Exact integer arithmetic, rounding half up to the paisa.
const divRound = (num, den) => Number((num + den / 2n) / den);
const percentOf = (paise, bp) => divRound(BigInt(paise) * BigInt(bp), 10000n);
const timesQty = (unitPaise, qtyH) => divRound(BigInt(unitPaise) * BigInt(qtyH), 100n);
const toRupees = (paise) => paise / 100;
const showPaise = (paise) => (paise === null || paise === undefined ? '' : (paise / 100).toFixed(2).replace(/\.00$/, ''));
const showBp = (bp) => (bp === null || bp === undefined ? '' : String(bp / 100));
const showQty = (h) => String(h / 100);
const inrPaise = (paise) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format((paise || 0) / 100);

// ---------- dates ----------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s) => DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const todayIst = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const median = (xs) => {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// ---------- the records ----------
const CONTRACT_KINDS = ['Permanent recruitment', 'Temporary & contract staffing', 'Both'];
const CONTRACT_STATUSES = ['Draft', 'Active', 'Ended'];
const REQ_KINDS = ['Permanent', 'Temporary', 'Contract'];
const PRIORITIES = ['Normal', 'High', 'Urgent'];
const REQ_STATUSES = ['Requested', 'Open', 'On hold', 'Filled', 'Cancelled'];
const REQ_MOVES = { Requested: ['Open', 'Cancelled'], Open: ['On hold', 'Filled', 'Cancelled'], 'On hold': ['Open', 'Cancelled'], Filled: ['Open'], Cancelled: [] };
const PAY_PERIODS = ['year', 'month', 'day', 'hour'];
const RATE_PER = ['hour', 'day', 'month'];
const SHIFTS = ['Day', 'Night', 'Rotational', 'Flexible'];
const ASSIGN_STATUSES = ['Scheduled', 'Active', 'Completed', 'Ended early', 'Cancelled'];
const ASSIGN_MOVES = { Scheduled: ['Active', 'Cancelled'], Active: ['Completed', 'Ended early'], Completed: [], 'Ended early': [], Cancelled: [] };
const LIVE_PLACEMENT = ['Awaiting joining', 'Joined', 'Contract ended'];
// A requisition counts as stale after this many days open without a placement.
const STALE_DAYS = 30;
// Open requisitions per recruiter above which the workload view flags them.
const BUSY_REQUISITIONS = 8;
const MAX_RECRUITERS = 10;
const kindCovers = (contractKind, reqKind) => contractKind === 'Both' || (reqKind === 'Permanent' ? contractKind === 'Permanent recruitment' : contractKind === 'Temporary & contract staffing');

// Reads one form or JSON body into checked values. `strict` (the API) refuses unknown fields.
function reader(input, allowed, strict) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { errors: ['send the details as an object'], has: () => false, str: () => '' };
  if (strict) for (const k of Object.keys(input)) if (!allowed.includes(k)) errors.push(`${k} is not a field you can set`);
  const has = (k) => Object.prototype.hasOwnProperty.call(input, k) && input[k] !== undefined;
  const str = (k, max) => (input[k] === null || input[k] === undefined ? '' : String(input[k]).trim().replace(/[ \t]+/g, ' ').slice(0, max + 1));
  return { errors, has, str };
}
const tooLong = (errors, label, v, max) => { if (v.length > max) errors.push(`${label} must be ${max} characters or fewer`); return v.slice(0, max); };

const CONTRACT_FIELDS = ['reference', 'kind', 'status', 'startsOn', 'endsOn', 'feeMode', 'feePercent', 'flatFee', 'guaranteeDays', 'paymentDays', 'markupPercent', 'notes'];
function parseContract(input, { strict = false, existing = null } = {}) {
  const r = reader(input, CONTRACT_FIELDS, strict);
  const { errors } = r;
  const base = existing || {};
  const pick = (k, max) => (r.has(k) || !existing ? tooLong(errors, k, r.str(k, max), max) : null);
  const out = { ...base };
  const ref = pick('reference', 60);
  if (ref !== null) { if (!ref) errors.push('reference is required (e.g. MSA-2026-01)'); out.reference = ref; }
  const kind = pick('kind', 40);
  if (kind !== null) { if (!CONTRACT_KINDS.includes(kind)) errors.push(`kind must be one of: ${CONTRACT_KINDS.join(', ')}`); out.kind = kind; }
  const status = pick('status', 20);
  if (status !== null) { const s = status || 'Draft'; if (!CONTRACT_STATUSES.includes(s)) errors.push(`status must be one of: ${CONTRACT_STATUSES.join(', ')}`); out.status = s; }
  const startsOn = pick('startsOn', 10);
  if (startsOn !== null) { if (!validDate(startsOn)) errors.push('startsOn must be a date like 2026-04-01'); out.startsOn = startsOn; }
  const endsOn = pick('endsOn', 10);
  if (endsOn !== null) { if (endsOn && !validDate(endsOn)) errors.push('endsOn must be a date like 2027-03-31'); out.endsOn = endsOn || null; }
  if (out.startsOn && out.endsOn && out.endsOn < out.startsOn) errors.push('the contract ends before it starts');
  const feeMode = pick('feeMode', 10);
  if (feeMode !== null) { const m = feeMode || 'percent'; if (!['percent', 'flat'].includes(m)) errors.push('feeMode must be percent or flat'); out.feeMode = m; }
  if (r.has('feePercent') || !existing) {
    const bp = bpFrom(r.str('feePercent', 10));
    if (Number.isNaN(bp)) errors.push('fee % must be a number from 0 to 100 with up to 2 decimals');
    out.feeBp = Number.isNaN(bp) ? null : bp;
  }
  if (r.has('flatFee') || !existing) {
    const p = paiseFrom(r.str('flatFee', 20));
    if (Number.isNaN(p)) errors.push('fixed fee must be an amount in rupees with up to 2 decimals');
    out.flatFeePaise = Number.isNaN(p) ? null : p;
  }
  if (r.has('markupPercent') || !existing) {
    const bp = bpFrom(r.str('markupPercent', 10));
    if (Number.isNaN(bp)) errors.push('markup % must be a number from 0 to 100 with up to 2 decimals');
    out.markupBp = Number.isNaN(bp) ? null : bp;
  }
  for (const [k, label, max, required] of [['guaranteeDays', 'guarantee days', 365, false], ['paymentDays', 'payment days', 180, true]]) {
    if (!(r.has(k) || !existing)) continue;
    const raw = r.str(k, 4);
    if (raw === '') { if (required) errors.push(`${label} is required`); out[k] = null; continue; }
    if (!/^\d{1,3}$/.test(raw) || Number(raw) > max) errors.push(`${label} must be a whole number from 0 to ${max}`);
    out[k] = Number(raw);
  }
  const notes = pick('notes', 1000);
  if (notes !== null) out.notes = notes;
  // Permanent recruitment needs its fee and guarantee written down: nothing is assumed.
  if (!errors.length && out.kind !== 'Temporary & contract staffing') {
    if (out.feeMode === 'percent' && !(out.feeBp > 0)) errors.push('fee % is required for permanent recruitment');
    if (out.feeMode === 'flat' && !(out.flatFeePaise > 0)) errors.push('fixed fee is required for permanent recruitment');
    if (out.guaranteeDays === null || out.guaranteeDays === undefined) errors.push('guarantee days are required for permanent recruitment');
  }
  return { errors: [...new Set(errors)], values: out };
}

const REQ_FIELDS = ['title', 'kind', 'openings', 'location', 'experience', 'skills', 'description', 'dueOn', 'priority', 'contractId', 'jobId', 'budgetMin', 'budgetMax', 'budgetPeriod', 'billRate', 'payRate', 'ratePer', 'clientId'];
// Fields a client may send when asking for people.
const CLIENT_REQ_FIELDS = ['title', 'kind', 'openings', 'location', 'experience', 'skills', 'description', 'dueOn', 'budgetMin', 'budgetMax', 'budgetPeriod'];
function parseRequisition(input, { strict = false, existing = null, fields = REQ_FIELDS } = {}) {
  const r = reader(input, fields, strict);
  const { errors } = r;
  const out = { ...(existing || {}) };
  const want = (k) => fields.includes(k) && (r.has(k) || !existing);
  if (want('title')) { const v = tooLong(errors, 'title', r.str('title', 120), 120); if (!v) errors.push('title is required'); out.title = v; }
  if (want('kind')) { const v = r.str('kind', 20) || 'Permanent'; if (!REQ_KINDS.includes(v)) errors.push(`kind must be one of: ${REQ_KINDS.join(', ')}`); out.kind = v; }
  if (want('openings')) {
    const v = r.str('openings', 4) || '1';
    if (!/^\d{1,3}$/.test(v) || Number(v) < 1 || Number(v) > 500) errors.push('openings must be a whole number from 1 to 500');
    out.openings = Number(v) || 1;
  }
  if (want('location')) out.location = tooLong(errors, 'location', r.str('location', 80), 80);
  if (want('experience')) out.experience = tooLong(errors, 'experience', r.str('experience', 40), 40);
  if (want('skills')) {
    const raw = input.skills;
    const list = (Array.isArray(raw) ? raw : String(raw ?? '').split(',')).map((s) => String(s).trim()).filter(Boolean);
    if (list.length > 10) errors.push('list up to 10 skills');
    if (list.some((s) => s.length > 40)) errors.push('each skill must be 40 characters or fewer');
    out.skills = [...new Set(list.slice(0, 10).map((s) => s.slice(0, 40)))];
  }
  if (want('description')) out.description = tooLong(errors, 'description', String(input.description ?? '').trim().slice(0, 3001), 3000);
  if (want('dueOn')) { const v = r.str('dueOn', 10); if (v && !validDate(v)) errors.push('dueOn must be a date like 2026-12-01'); out.dueOn = v || null; }
  if (want('priority')) { const v = r.str('priority', 10) || 'Normal'; if (!PRIORITIES.includes(v)) errors.push(`priority must be one of: ${PRIORITIES.join(', ')}`); out.priority = v; }
  if (want('contractId')) out.contractId = r.str('contractId', 60) || null;
  if (want('jobId')) out.jobId = r.str('jobId', 60) || null;
  if (want('clientId')) out.clientId = r.str('clientId', 60);
  const money = (k, label) => {
    const v = paiseFrom(r.str(k, 20));
    if (Number.isNaN(v)) errors.push(`${label} must be an amount in rupees with up to 2 decimals`);
    return Number.isNaN(v) ? null : v;
  };
  if (want('budgetMin') || want('budgetMax') || want('budgetPeriod')) {
    const prev = out.budget || {};
    const min = want('budgetMin') ? money('budgetMin', 'budget from') : prev.minPaise ?? null;
    const max = want('budgetMax') ? money('budgetMax', 'budget to') : prev.maxPaise ?? null;
    const period = want('budgetPeriod') ? r.str('budgetPeriod', 10) || 'year' : prev.period || 'year';
    if (!PAY_PERIODS.includes(period)) errors.push(`budgetPeriod must be one of: ${PAY_PERIODS.join(', ')}`);
    if (min !== null && max !== null && max < min) errors.push('budget to is less than budget from');
    out.budget = min === null && max === null ? null : { minPaise: min, maxPaise: max, period };
  }
  if (want('billRate') || want('payRate') || want('ratePer')) {
    const prev = out.rates || {};
    const bill = want('billRate') ? money('billRate', 'bill rate') : prev.billPaise ?? null;
    const pay = want('payRate') ? money('payRate', 'pay rate') : prev.payPaise ?? null;
    const per = want('ratePer') ? r.str('ratePer', 10) || 'day' : prev.per || 'day';
    if (!RATE_PER.includes(per)) errors.push(`ratePer must be one of: ${RATE_PER.join(', ')}`);
    if (bill !== null && pay !== null && bill < pay) errors.push('the bill rate must be at least the pay rate');
    out.rates = bill === null && pay === null ? null : { billPaise: bill, payPaise: pay, per };
  }
  if (out.kind === 'Permanent' && out.rates) out.rates = null;
  return { errors: [...new Set(errors)], values: out };
}

const ASSIGN_FIELDS = ['placementId', 'role', 'site', 'startsOn', 'endsOn', 'shift', 'billRate', 'payRate', 'ratePer', 'notes', 'status'];
function parseAssignment(input, { strict = false, existing = null } = {}) {
  const r = reader(input, ASSIGN_FIELDS, strict);
  const { errors } = r;
  const out = { ...(existing || {}) };
  const want = (k) => r.has(k) || !existing;
  if (!existing) out.placementId = r.str('placementId', 60);
  else if (r.has('placementId') && r.str('placementId', 60) !== existing.placementId) errors.push("an assignment can't move to another placement");
  if (want('role')) out.role = tooLong(errors, 'role', r.str('role', 120), 120);
  if (want('site')) out.site = tooLong(errors, 'site', r.str('site', 160), 160);
  if (want('startsOn')) { const v = r.str('startsOn', 10); if (!validDate(v)) errors.push('startsOn must be a date like 2026-11-01'); out.startsOn = v; }
  if (want('endsOn')) { const v = r.str('endsOn', 10); if (v && !validDate(v)) errors.push('endsOn must be a date like 2027-01-31'); out.endsOn = v || null; }
  if (out.startsOn && out.endsOn && out.endsOn < out.startsOn) errors.push('the assignment ends before it starts');
  if (want('shift')) { const v = r.str('shift', 20); if (v && !SHIFTS.includes(v)) errors.push(`shift must be one of: ${SHIFTS.join(', ')}`); out.shift = v; }
  if (want('billRate') || want('payRate') || want('ratePer')) {
    const prev = out.rate || {};
    const money = (k, label) => {
      const v = paiseFrom(r.str(k, 20));
      if (Number.isNaN(v)) errors.push(`${label} must be an amount in rupees with up to 2 decimals`);
      return Number.isNaN(v) ? null : v;
    };
    const bill = want('billRate') ? money('billRate', 'bill rate') : prev.billPaise;
    const pay = want('payRate') ? money('payRate', 'pay rate') : prev.payPaise ?? null;
    const per = want('ratePer') ? r.str('ratePer', 10) || 'day' : prev.per;
    if (!(bill > 0)) errors.push('bill rate is required');
    if (!RATE_PER.includes(per)) errors.push(`ratePer must be one of: ${RATE_PER.join(', ')}`);
    if (bill > 0 && pay !== null && bill < pay) errors.push('the bill rate must be at least the pay rate');
    out.rate = { billPaise: bill, payPaise: pay, per };
  }
  if (want('notes')) out.notes = tooLong(errors, 'notes', r.str('notes', 500), 500);
  if (r.has('status')) out.nextStatus = r.str('status', 20);
  return { errors: [...new Set(errors)], values: out };
}

const overlaps = (a1, a2, b1, b2) => a1 <= (b2 || '9999-12-31') && b1 <= (a2 || '9999-12-31');

function register(app, deps) {
  const {
    db, team, clients, billing, readSubmissions, writeSubmissions, saveSubmission, getJobs, adminAuth, sameOrigin, limit, site, events, ownerOf,
    hooks, requireEmployer, requireEmployerApi, can: employerCan,
  } = deps;
  const ACTIVE = new Set(['Requested', 'Open', 'On hold']);
  const now = () => new Date().toISOString();

  // ---------- storage ----------
  const contracts = () => readSubmissions('client-contracts');
  const requisitions = () => readSubmissions('requisitions');
  const assignments = () => readSubmissions('staffing-assignments');
  const drafts = () => readSubmissions('invoice-drafts');
  const update = (collection, id, fn) => {
    const list = readSubmissions(collection);
    const rec = list.find((x) => x.id === id);
    if (!rec) return null;
    fn(rec);
    rec.updatedAt = now();
    writeSubmissions(collection, list);
    return rec;
  };
  const clientById = (id) => clients.read().find((c) => c.id === id) || null;
  const memberById = (id) => team.members().find((u) => u.id === id) || null;
  const nameOf = (id) => (memberById(id) || {}).name || '';
  // People who can be given requisitions: everyone on the team except Finance.
  const assignable = () => team.members().filter((u) => u.role !== 'Finance Manager');
  const accountManagers = () => team.members().filter((u) => ['Admin', 'Account Manager'].includes(u.role));

  function audit(user, action, entity, entityId, detail = '', employerId = '') {
    saveSubmission('agency-audit', { actorId: user ? user.id : '', actorName: user ? user.name : 'System', role: user ? user.role : '', action, entity, entityId, employerId, detail: String(detail).slice(0, 300) });
    if (user) team.log(user, `${action}: ${detail}`.slice(0, 300), entity);
  }

  function nextNumber() {
    const n = Number(db.metaGet('requisition-seq') || 0) + 1;
    db.metaSet('requisition-seq', n);
    return `REQ-${String(n).padStart(4, '0')}`;
  }

  // ---------- who may do what (always from the signed-in team member) ----------
  const isAccountManagerOf = (user, employerId) => {
    const c = clientById(employerId);
    return Boolean(c && c.accountManagerId === user.id);
  };
  // Account Managers change only the clients they look after.
  const canManageClient = (user, employerId) => roles.can(user, 'clients.manage') && (user.role !== 'Account Manager' || isAccountManagerOf(user, employerId));
  const canManageReq = (user, r) => roles.can(user, 'requisitions.manage') && (user.role !== 'Account Manager' || isAccountManagerOf(user, r.employerId));
  const canSeeReq = (user, r) => roles.can(user, 'requisitions.view') && (user.role !== 'Recruiter' || (r.recruiterIds || []).includes(user.id));
  const canDraftFor = (user, p) => roles.can(user, 'invoices.draft') && (user.role !== 'Account Manager' || isAccountManagerOf(user, p.employerId));
  const canManageAssignment = (user, a) => {
    if (!roles.can(user, 'staffing.manage')) return false;
    if (user.role === 'Account Manager') return isAccountManagerOf(user, a.employerId);
    if (user.role === 'Recruiter') {
      const r = a.requisitionId && requisitions().find((x) => x.id === a.requisitionId);
      return Boolean(r && (r.recruiterIds || []).includes(user.id));
    }
    return true;
  };

  // ---------- derived facts ----------
  const livePlacementsOf = (reqId, list = billing.read()) => list.filter((p) => p.requisitionId === reqId && LIVE_PLACEMENT.includes(p.status));
  function describeReq(r, ctx = {}) {
    const placed = livePlacementsOf(r.id, ctx.placements);
    const apps = r.jobId ? (ctx.applications || readSubmissions('applications')).filter((a) => a.jobId === r.jobId) : [];
    const client = clientById(r.employerId);
    const contract = r.contractId ? contracts().find((c) => c.id === r.contractId) : null;
    const today = todayIst();
    return {
      ...r,
      company: client ? client.company : '(client removed)',
      contractRef: contract ? contract.reference : '',
      filled: placed.length,
      remaining: Math.max(0, r.openings - placed.length),
      pipeline: {
        applied: apps.filter((a) => !a.withdrawnAt).length,
        shortlisted: apps.filter((a) => a.shared && a.shared.employerId === r.employerId).length,
        interviewing: apps.filter((a) => a.status === 'Interview').length,
        offered: apps.filter((a) => a.status === 'Offered').length,
      },
      recruiters: (r.recruiterIds || []).map((id) => ({ id, name: nameOf(id) || 'Former team member' })),
      overdue: Boolean(r.dueOn && r.dueOn < today && ACTIVE.has(r.status)),
      ageDays: daysBetween(r.createdAt.slice(0, 10), today),
      stale: r.status === 'Open' && !placed.length && daysBetween(r.createdAt.slice(0, 10), today) > STALE_DAYS,
    };
  }
  // The team's JSON view; money only for roles that see money.
  function reqJson(r, user) {
    const d = describeReq(r);
    const out = {
      id: d.id, number: d.number, clientId: d.employerId, company: d.company, title: d.title, kind: d.kind, openings: d.openings, filled: d.filled, remaining: d.remaining,
      status: d.status, priority: d.priority, location: d.location, experience: d.experience, skills: d.skills, description: d.description, dueOn: d.dueOn, overdue: d.overdue,
      jobId: d.jobId, contractId: d.contractId, contractRef: d.contractRef, source: d.source, recruiters: d.recruiters, pipeline: d.pipeline, createdAt: d.createdAt, updatedAt: d.updatedAt,
    };
    if (roles.can(user, 'money.view')) {
      out.budget = d.budget ? { min: showPaise(d.budget.minPaise), max: showPaise(d.budget.maxPaise), period: d.budget.period, minPaise: d.budget.minPaise, maxPaise: d.budget.maxPaise } : null;
      out.rates = d.rates ? { bill: showPaise(d.rates.billPaise), pay: showPaise(d.rates.payPaise), per: d.rates.per, billPaise: d.rates.billPaise, payPaise: d.rates.payPaise } : null;
    }
    return out;
  }
  const contractJson = (c, user) => {
    const out = { id: c.id, clientId: c.employerId, reference: c.reference, kind: c.kind, status: c.status, startsOn: c.startsOn, endsOn: c.endsOn, paymentDays: c.paymentDays, guaranteeDays: c.guaranteeDays, createdAt: c.createdAt, updatedAt: c.updatedAt };
    if (roles.can(user, 'money.view') || roles.can(user, 'contracts.view')) {
      Object.assign(out, { feeMode: c.feeMode, feePercent: c.feeBp === null ? null : c.feeBp / 100, feeBp: c.feeBp, flatFeePaise: c.flatFeePaise, flatFee: showPaise(c.flatFeePaise), markupPercent: c.markupBp === null ? null : c.markupBp / 100 });
    }
    return out;
  };
  const contractLive = (c, on = todayIst()) => c.status === 'Active' && c.startsOn <= on && (!c.endsOn || c.endsOn >= on);

  // ---------- contracts ----------
  function createContract(user, employerId, input, strict) {
    const client = clientById(employerId);
    if (!client) return { status: 404, errors: ['client not found'] };
    if (!canManageClient(user, employerId)) return { status: 403, errors: ['only an Admin or this client\'s account manager can change its contracts'] };
    const { errors, values } = parseContract(input, { strict });
    if (contracts().some((c) => c.employerId === employerId && c.reference.toLowerCase() === String(values.reference || '').toLowerCase())) errors.push('this client already has a contract with that reference');
    if (errors.length) return { status: 400, errors };
    const c = saveSubmission('client-contracts', { employerId, ...values, createdBy: user.id, updatedAt: now() });
    audit(user, 'contract-added', 'contract', c.id, `${client.company}: ${c.reference} (${c.status})`, employerId);
    return { status: 201, contract: c };
  }
  function changeContract(user, id, input, strict) {
    const c = contracts().find((x) => x.id === id);
    if (!c) return { status: 404, errors: ['contract not found'] };
    if (!canManageClient(user, c.employerId)) return { status: 403, errors: ['only an Admin or this client\'s account manager can change its contracts'] };
    const { errors, values } = parseContract(input, { strict, existing: c });
    if (c.status === 'Ended' && values.status !== 'Ended') errors.push('an ended contract stays ended: add a new one');
    if (contracts().some((x) => x.id !== c.id && x.employerId === c.employerId && x.reference.toLowerCase() === String(values.reference).toLowerCase())) errors.push('this client already has a contract with that reference');
    if (errors.length) return { status: 400, errors };
    const saved = update('client-contracts', id, (rec) => Object.assign(rec, values));
    audit(user, 'contract-changed', 'contract', id, `${(clientById(c.employerId) || {}).company}: ${saved.reference} (${saved.status})`, c.employerId);
    return { status: 200, contract: saved };
  }
  function setAccountManager(user, employerId, managerId) {
    const client = clientById(employerId);
    if (!client) return { status: 404, errors: ['client not found'] };
    if (user.role !== 'Admin') return { status: 403, errors: ['only an Admin assigns account managers'] };
    if (managerId && !accountManagers().some((u) => u.id === managerId)) return { status: 400, errors: ['choose an Account Manager or Admin on the team'] };
    const list = clients.read();
    const rec = list.find((c) => c.id === employerId);
    rec.accountManagerId = managerId || null;
    clients.write(list);
    audit(user, 'account-manager-set', 'client', employerId, `${client.company}: ${managerId ? nameOf(managerId) : 'none'}`, employerId);
    return { status: 200, client: rec };
  }

  // ---------- requisitions ----------
  // Checks the links a requisition makes: its contract and job must be this client's.
  function checkLinks(values, employerId, selfId = null) {
    const errors = [];
    if (values.contractId) {
      const c = contracts().find((x) => x.id === values.contractId && x.employerId === employerId);
      if (!c) errors.push('contract must be one of this client\'s contracts');
      else if (!contractLive(c)) errors.push(`contract ${c.reference} is not active today`);
      else if (!kindCovers(c.kind, values.kind)) errors.push(`contract ${c.reference} covers ${c.kind.toLowerCase()}, not ${values.kind.toLowerCase()} roles`);
    }
    if (values.jobId) {
      const job = getJobs().find((j) => j.id === values.jobId);
      if (!job || job.employerId !== employerId) errors.push('job must be one of this client\'s jobs');
      else if (requisitions().some((x) => x.id !== selfId && x.jobId === job.id && ACTIVE.has(x.status))) errors.push('that job already belongs to another open requisition');
    }
    return errors;
  }

  function createRequisition(user, input, strict) {
    const { errors, values } = parseRequisition(input, { strict });
    const employerId = values.clientId;
    delete values.clientId;
    const client = clientById(employerId);
    if (!client) return { status: 400, errors: [...errors, 'clientId must be one of your clients'] };
    if (!canManageReq(user, { employerId })) return { status: 403, errors: ['your role does not allow creating requisitions for this client'] };
    errors.push(...checkLinks(values, employerId));
    if (errors.length) return { status: 400, errors: [...new Set(errors)] };
    // Without a contract, the client's single active contract that covers this kind of role is used.
    if (!values.contractId) {
      const live = contracts().filter((c) => c.employerId === employerId && contractLive(c) && kindCovers(c.kind, values.kind));
      if (live.length === 1) values.contractId = live[0].id;
    }
    const r = saveSubmission('requisitions', {
      number: nextNumber(), employerId, ...values, status: 'Open', source: 'team', recruiterIds: [], managerId: user.id,
      history: [{ at: now(), by: user.name, text: 'Opened' }], updatedAt: now(), closedAt: null,
    });
    audit(user, 'requisition-opened', 'requisition', r.id, `${r.number} for ${client.company}: ${r.openings} × ${r.title}`, employerId);
    return { status: 201, requisition: r };
  }

  function changeRequisition(user, id, input, strict) {
    const r = requisitions().find((x) => x.id === id);
    if (!r || !canSeeReq(user, r)) return { status: 404, errors: ['requisition not found'] };
    if (!canManageReq(user, r)) return { status: 403, errors: ['your role does not allow changing this requisition'] };
    const body = { ...input };
    const nextStatus = body.status !== undefined ? String(body.status) : null;
    const note = String(body.note ?? '').trim().slice(0, 300);
    delete body.status;
    delete body.note;
    if (Object.prototype.hasOwnProperty.call(body, 'clientId')) return { status: 400, errors: ["a requisition can't move to another client"] };
    const { errors, values } = parseRequisition(body, { strict, existing: r, fields: REQ_FIELDS.filter((k) => k !== 'clientId') });
    errors.push(...checkLinks(values, r.employerId, r.id));
    if (nextStatus !== null && nextStatus !== r.status) {
      if (!REQ_STATUSES.includes(nextStatus)) errors.push(`status must be one of: ${REQ_STATUSES.join(', ')}`);
      else if (!REQ_MOVES[r.status].includes(nextStatus)) errors.push(`a requisition can't move from ${r.status} to ${nextStatus}`);
      if (nextStatus === 'Cancelled' && !note) errors.push('say why the requisition is cancelled');
    }
    if (values.openings < livePlacementsOf(r.id).length) errors.push(`openings can't be fewer than the ${livePlacementsOf(r.id).length} already filled`);
    if (errors.length) return { status: 400, errors: [...new Set(errors)] };
    const changed = Object.keys(values).filter((k) => JSON.stringify(values[k]) !== JSON.stringify(r[k]) && k !== 'history');
    const saved = update('requisitions', id, (rec) => {
      Object.assign(rec, values);
      if (changed.length) rec.history.push({ at: now(), by: user.name, text: `Changed ${changed.join(', ')}` });
      if (nextStatus && nextStatus !== r.status) {
        rec.status = nextStatus;
        rec.closedAt = ['Filled', 'Cancelled'].includes(nextStatus) ? now() : null;
        rec.history.push({ at: now(), by: user.name, text: `${r.status} → ${nextStatus}${note ? `: ${note}` : ''}` });
      }
    });
    if (nextStatus && nextStatus !== r.status) audit(user, 'requisition-status', 'requisition', id, `${r.number}: ${r.status} → ${nextStatus}`, r.employerId);
    else if (changed.length) audit(user, 'requisition-changed', 'requisition', id, `${r.number}: ${changed.join(', ')}`, r.employerId);
    return { status: 200, requisition: saved };
  }

  function assignRecruiters(user, id, ids) {
    const r = requisitions().find((x) => x.id === id);
    if (!r || !canSeeReq(user, r)) return { status: 404, errors: ['requisition not found'] };
    if (!roles.can(user, 'requisitions.assign')) return { status: 403, errors: ['only an Admin or a Recruitment Manager assigns recruiters'] };
    const list = [...new Set((Array.isArray(ids) ? ids : [ids]).filter(Boolean).map(String))];
    const errors = [];
    if (list.length > MAX_RECRUITERS) errors.push(`assign up to ${MAX_RECRUITERS} recruiters`);
    const pool = new Set(assignable().map((u) => u.id));
    if (list.some((x) => !pool.has(x))) errors.push('recruiters must be active team members who work on requisitions');
    if (['Cancelled'].includes(r.status)) errors.push('this requisition is cancelled');
    if (errors.length) return { status: 400, errors };
    const before = new Set(r.recruiterIds || []);
    const added = list.filter((x) => !before.has(x));
    const removed = [...before].filter((x) => !list.includes(x));
    const saved = update('requisitions', id, (rec) => {
      rec.recruiterIds = list;
      if (added.length || removed.length) rec.history.push({ at: now(), by: user.name, text: [added.length ? `Assigned ${added.map(nameOf).join(', ')}` : '', removed.length ? `Unassigned ${removed.map(nameOf).join(', ')}` : ''].filter(Boolean).join('; ') });
    });
    if (added.length || removed.length) {
      audit(user, 'recruiters-assigned', 'requisition', id, `${r.number}: ${list.map(nameOf).join(', ') || 'nobody'}`, r.employerId);
      if (events && events.agencyAssigned) for (const uid of added) if (uid !== user.id) events.agencyAssigned(saved, uid, clientById(r.employerId));
    }
    return { status: 200, requisition: saved };
  }

  // A requisition fills itself when its last opening gets a placement.
  hooks.placed = (p, user) => {
    if (!p.requisitionId) return;
    const r = requisitions().find((x) => x.id === p.requisitionId);
    if (!r) return;
    audit(user, 'placement-linked', 'requisition', r.id, `${r.number}: placement recorded (${livePlacementsOf(r.id).length} of ${r.openings})`, r.employerId);
    if (r.status === 'Open' && livePlacementsOf(r.id).length >= r.openings) {
      update('requisitions', r.id, (rec) => {
        rec.status = 'Filled';
        rec.closedAt = now();
        rec.history.push({ at: now(), by: user ? user.name : 'System', text: 'Open → Filled: every opening has a placement' });
      });
      audit(user, 'requisition-status', 'requisition', r.id, `${r.number}: Open → Filled`, r.employerId);
    }
  };
  // The requisition (and contract) a new placement belongs to: the open one for the application's job.
  const reqForApp = (a, employerId) => requisitions().find((r) => r.jobId && r.jobId === a.jobId && ACTIVE.has(r.status) && (!employerId || r.employerId === employerId)) || null;
  hooks.linkFor = (a, employerId) => {
    const r = reqForApp(a, employerId);
    if (!r) return {};
    const owner = ownerOf(a);
    return { requisitionId: r.id, contractId: r.contractId || null, recruiterId: (r.recruiterIds || []).includes(owner) ? owner : (r.recruiterIds || [])[0] || owner || '' };
  };
  hooks.termsFor = (a) => {
    const r = reqForApp(a);
    const c = r && r.contractId ? contracts().find((x) => x.id === r.contractId && contractLive(x)) : null;
    if (!c) return null;
    const type = r.kind === 'Permanent' ? 'Permanent' : r.kind;
    const t = { contractRef: c.reference, requisitionNumber: r.number, type, guaranteeDays: c.guaranteeDays ?? undefined };
    if (r.kind !== 'Permanent') t.feeMode = 'assignment';
    else if (c.feeMode === 'flat') Object.assign(t, { feeMode: 'flat', flatFee: toRupees(c.flatFeePaise) });
    else Object.assign(t, { feeMode: 'percent', feePercent: c.feeBp / 100 });
    return t;
  };

  // ---------- requisitions a client asks for ----------
  function clientRequisition(emp, user, input, strict) {
    const { errors, values } = parseRequisition(input, { strict, fields: CLIENT_REQ_FIELDS });
    if (errors.length) return { status: 400, errors };
    const r = saveSubmission('requisitions', {
      number: nextNumber(), employerId: emp.id, ...values, priority: 'Normal', contractId: null, jobId: null, rates: null, status: 'Requested', source: 'client',
      requestedBy: { userId: user.id, name: user.name }, recruiterIds: [], managerId: null, history: [{ at: now(), by: `${user.name} (${emp.company})`, text: 'Requested by the client' }], updatedAt: now(), closedAt: null,
    });
    team.log(null, `${emp.company} requested ${r.openings} × ${r.title} (${r.number})`, 'requisitions');
    saveSubmission('agency-audit', { actorId: '', actorName: `${user.name} (${emp.company})`, role: 'Client Employer', action: 'requisition-requested', entity: 'requisition', entityId: r.id, employerId: emp.id, detail: `${r.number}: ${r.openings} × ${r.title}` });
    if (events && events.staffingRequest) events.staffingRequest({ id: r.id, company: emp.company, roles: `${r.title} (${r.number})`, headcount: String(r.openings), location: r.location });
    return { status: 201, requisition: r };
  }
  // What a client sees: their own requisitions only, no internal notes, rates only for billing roles.
  function clientReqView(r, member) {
    const d = describeReq(r);
    const am = clientById(r.employerId);
    const out = {
      id: d.id, number: d.number, title: d.title, kind: d.kind, openings: d.openings, filled: d.filled, status: d.status, location: d.location, experience: d.experience,
      skills: d.skills, description: d.description, dueOn: d.dueOn, createdAt: d.createdAt, shortlisted: d.pipeline.shortlisted,
      accountManager: am && am.accountManagerId ? nameOf(am.accountManagerId) : '', jobId: d.jobId,
    };
    if (employerCan(member, 'billing.view')) out.budget = d.budget ? { min: showPaise(d.budget.minPaise), max: showPaise(d.budget.maxPaise), period: d.budget.period } : null;
    return out;
  }

  // ---------- staffing assignments ----------
  const eligiblePlacements = () => billing.read().filter((p) => p.type !== 'Permanent' && p.feeMode === 'assignment' && LIVE_PLACEMENT.includes(p.status));
  function createAssignment(user, input, strict) {
    const { errors, values } = parseAssignment(input, { strict });
    const p = billing.read().find((x) => x.id === values.placementId);
    if (!p) return { status: 400, errors: [...errors, 'placementId must be a temporary or contract placement'] };
    if (p.type === 'Permanent' || p.feeMode !== 'assignment') errors.push('the placement must be temporary or contract, billed per staffing assignment');
    if (!LIVE_PLACEMENT.includes(p.status)) errors.push(`the placement is "${p.status}"`);
    const draft = { employerId: p.employerId, requisitionId: p.requisitionId || null };
    if (!canManageAssignment(user, draft)) return { status: 403, errors: ['your role does not allow staffing this placement'] };
    if (values.nextStatus) errors.push('a new assignment starts as Scheduled');
    if (!values.role) values.role = p.jobTitle;
    if (assignments().some((a) => a.placementId === p.id && a.status !== 'Cancelled' && overlaps(a.startsOn, a.endsOn, values.startsOn, values.endsOn))) errors.push('this worker already has an assignment in those dates');
    if (errors.length) return { status: 400, errors: [...new Set(errors)] };
    delete values.nextStatus;
    const a = saveSubmission('staffing-assignments', { ...values, employerId: p.employerId, requisitionId: p.requisitionId || null, workerName: p.candidateName, status: 'Scheduled', createdBy: user.id, updatedAt: now(), history: [{ at: now(), by: user.name, text: 'Scheduled' }] });
    audit(user, 'assignment-added', 'assignment', a.id, `${(clientById(p.employerId) || {}).company || p.company}: ${a.role} from ${a.startsOn}`, p.employerId);
    return { status: 201, assignment: a };
  }
  function changeAssignment(user, id, input, strict) {
    const a = assignments().find((x) => x.id === id);
    if (!a || !roles.can(user, 'staffing.view')) return { status: 404, errors: ['assignment not found'] };
    if (!canManageAssignment(user, a)) return { status: 403, errors: ['your role does not allow changing this assignment'] };
    const { errors, values } = parseAssignment(input, { strict, existing: a });
    const next = values.nextStatus;
    delete values.nextStatus;
    if (next && next !== a.status) {
      if (!ASSIGN_STATUSES.includes(next)) errors.push(`status must be one of: ${ASSIGN_STATUSES.join(', ')}`);
      else if (!ASSIGN_MOVES[a.status].includes(next)) errors.push(`an assignment can't move from ${a.status} to ${next}`);
    }
    if (['Completed', 'Ended early', 'Cancelled'].includes(a.status) && Object.keys(input).some((k) => !['status', 'notes'].includes(k))) errors.push(`a ${a.status.toLowerCase()} assignment can only get notes`);
    const billed = drafts().filter((d) => d.assignmentId === a.id && d.status !== 'Discarded');
    if (billed.length && (values.rate.billPaise !== a.rate.billPaise || values.rate.per !== a.rate.per)) errors.push('this assignment has invoice drafts or invoices: its bill rate stays as billed (end it and add a new assignment for a new rate)');
    if (billed.some((d) => d.period.from < values.startsOn || (values.endsOn && d.period.to > values.endsOn))) errors.push('billed periods must stay inside the assignment dates');
    if (assignments().some((x) => x.id !== a.id && x.placementId === a.placementId && x.status !== 'Cancelled' && overlaps(x.startsOn, x.endsOn, values.startsOn, values.endsOn))) errors.push('this worker already has an assignment in those dates');
    if (next === 'Cancelled' && billed.length) errors.push('an assignment with invoice drafts or invoices can\'t be cancelled: end it instead');
    if (errors.length) return { status: 400, errors: [...new Set(errors)] };
    const saved = update('staffing-assignments', id, (rec) => {
      Object.assign(rec, values);
      if (next && next !== a.status) {
        rec.status = next;
        if (next === 'Ended early' && !rec.endsOn) rec.endsOn = todayIst();
        rec.history.push({ at: now(), by: user.name, text: `${a.status} → ${next}` });
      }
    });
    audit(user, next && next !== a.status ? 'assignment-status' : 'assignment-changed', 'assignment', id, `${saved.role}${next && next !== a.status ? `: ${a.status} → ${next}` : ''}`, a.employerId);
    return { status: 200, assignment: saved };
  }
  const assignmentJson = (a, user) => {
    const out = { id: a.id, placementId: a.placementId, requisitionId: a.requisitionId, clientId: a.employerId, company: (clientById(a.employerId) || {}).company || '', worker: a.workerName, role: a.role, site: a.site, shift: a.shift, startsOn: a.startsOn, endsOn: a.endsOn, status: a.status, ratePer: a.rate.per, createdAt: a.createdAt, updatedAt: a.updatedAt };
    if (roles.can(user, 'money.view')) Object.assign(out, { billRate: showPaise(a.rate.billPaise), payRate: showPaise(a.rate.payPaise), billRatePaise: a.rate.billPaise, payRatePaise: a.rate.payPaise });
    return out;
  };

  // ---------- invoice drafts ----------
  // Anyone allowed asks for an invoice; Finance (or an Admin) issues it through
  // the existing billing; payments are recorded there later. The same request
  // twice gives the same draft, never a second invoice.
  const KEY_RE = /^[\w.:-]{8,100}$/;
  function createDraft(user, placementId, input, requestKey) {
    const p = billing.read().find((x) => x.id === placementId);
    if (!p) return { status: 404, errors: ['placement not found'] };
    if (!canDraftFor(user, p)) return { status: 403, errors: ['your role does not allow asking for invoices for this client'] };
    if (requestKey !== undefined && requestKey !== null && !KEY_RE.test(String(requestKey))) return { status: 400, errors: ['Idempotency-Key must be 8–100 letters, numbers, dots, colons, dashes or underscores'] };
    if (requestKey) {
      const same = drafts().find((d) => d.requestKey === `${user.id}:${requestKey}`);
      if (same) return same.placementId === p.id ? { status: 200, draft: same, existed: true } : { status: 409, errors: ['that Idempotency-Key was used for another invoice'] };
    }
    const body = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const unknown = Object.keys(body).filter((k) => !['assignmentId', 'from', 'to', 'quantity', 'note'].includes(k));
    if (unknown.length) return { status: 400, errors: unknown.map((k) => `${k} is not a field you can set`) };
    let values;
    if (!body.assignmentId) {
      if (['monthly', 'assignment', 'free'].includes(p.feeMode)) return { status: 409, errors: ['this placement has no one-time fee: bill it by month or by staffing assignment'] };
      if (p.invoice) return { status: 409, errors: [`invoice ${p.invoice.number} is already issued for this placement`] };
      if (p.status !== 'Joined') return { status: 409, errors: ['the fee is invoiced once the candidate has joined'] };
      const feePaise = Math.round(p.fee * 100);
      if (!(feePaise > 0)) return { status: 409, errors: ['set a fee on the placement first'] };
      values = {
        kind: 'placement-fee', naturalKey: `fee:${p.id}`, assignmentId: null, period: null, subtotalPaise: feePaise,
        lines: [{ text: `Recruitment fee – ${p.jobTitle} (${p.candidateName})${p.feeMode === 'percent' ? ` · ${p.feePercent}% of annual CTC` : ''}`, quantityH: 100, unitPaise: feePaise, amountPaise: feePaise }],
      };
    } else {
      const a = assignments().find((x) => x.id === String(body.assignmentId) && x.placementId === p.id);
      if (!a) return { status: 400, errors: ['assignmentId must be one of this placement\'s staffing assignments'] };
      if (a.status === 'Cancelled' || a.status === 'Scheduled') return { status: 409, errors: [`the assignment is ${a.status.toLowerCase()}: nothing to bill yet`] };
      if (p.feeMode !== 'assignment') return { status: 409, errors: ['this placement is not billed per staffing assignment'] };
      const errors = [];
      const from = String(body.from ?? '').trim();
      const to = String(body.to ?? '').trim();
      if (!validDate(from)) errors.push('from must be a date like 2026-11-01');
      if (!validDate(to)) errors.push('to must be a date like 2026-11-30');
      const qty = qtyFrom(body.quantity);
      if (qty === null || Number.isNaN(qty) || !(qty > 0)) errors.push(`quantity must be the ${a.rate.per}s worked, more than 0, up to 2 decimals`);
      if (!errors.length) {
        if (to < from) errors.push('to is before from');
        if (from < a.startsOn || (a.endsOn && to > a.endsOn)) errors.push(`the period must be inside the assignment (${a.startsOn} to ${a.endsOn || 'open-ended'})`);
        if (to > todayIst()) errors.push('only past or finished days can be billed');
        const days = daysBetween(from, to) + 1;
        const cap = a.rate.per === 'day' ? days * 100 : a.rate.per === 'hour' ? days * 24 * 100 : Math.ceil(days / 28) * 100;
        if (qty > cap) errors.push(`${showQty(qty)} ${a.rate.per}s is more than the period allows`);
      }
      if (!errors.length && drafts().some((d) => d.assignmentId === a.id && d.status !== 'Discarded' && d.naturalKey !== `staffing:${a.id}:${from}:${to}` && overlaps(d.period.from, d.period.to, from, to))) errors.push('part of this period is already billed or drafted');
      if (errors.length) return { status: 400, errors };
      const amount = timesQty(a.rate.billPaise, qty);
      const label = `${from} to ${to}`;
      values = {
        kind: 'staffing', naturalKey: `staffing:${a.id}:${from}:${to}`, assignmentId: a.id, period: { from, to, label }, subtotalPaise: amount,
        lines: [{ text: `Staffing – ${p.candidateName} as ${a.role}${a.site ? ` at ${a.site}` : ''}, ${label}: ${showQty(qty)} ${a.rate.per}${qty === 100 ? '' : 's'} at ${inrPaise(a.rate.billPaise)}/${a.rate.per}`, quantityH: qty, unitPaise: a.rate.billPaise, amountPaise: amount }],
      };
    }
    const note = String(body.note ?? '').trim().slice(0, 200);
    const same = drafts().find((d) => d.naturalKey === values.naturalKey && d.status !== 'Discarded');
    if (same) return { status: 200, draft: same, existed: true };
    const d = saveSubmission('invoice-drafts', { placementId: p.id, employerId: p.employerId, ...values, note, status: 'Draft', requestKey: requestKey ? `${user.id}:${requestKey}` : null, createdBy: user.id, createdByName: user.name, updatedAt: now() });
    audit(user, 'invoice-drafted', 'invoice-draft', d.id, `${p.company}: ${inrPaise(d.subtotalPaise)} before GST (${d.kind})`, p.employerId);
    return { status: 201, draft: d };
  }

  function issueDraft(user, id, { email = false } = {}) {
    const d = drafts().find((x) => x.id === id);
    if (!d) return { status: 404, errors: ['invoice draft not found'] };
    if (!roles.can(user, 'invoices.issue')) return { status: 403, errors: ['only an Admin or a Finance Manager issues invoices'] };
    if (d.status === 'Issued') return { status: 200, draft: d, existed: true };
    if (d.status !== 'Draft') return { status: 409, errors: ['this draft was discarded'] };
    const p = billing.read().find((x) => x.id === d.placementId);
    if (!p) return { status: 409, errors: ['the placement is gone'] };
    let r;
    if (d.kind === 'placement-fee') {
      if (Math.round(p.fee * 100) !== d.subtotalPaise) return { status: 409, errors: ['the placement fee changed after this draft: discard it and draft again'] };
      r = billing.issueFee(p.id, { email });
    } else {
      r = billing.issueStaffing(p.id, {
        subtotal: toRupees(d.subtotalPaise), period: d.period, assignmentId: d.assignmentId, email,
        lines: d.lines.map((l) => ({ text: l.text, amount: toRupees(l.amountPaise) })),
      });
    }
    if (r.error) return { status: r.status || 409, errors: [r.error] };
    const saved = update('invoice-drafts', id, (rec) => Object.assign(rec, { status: 'Issued', issuedAt: now(), issuedBy: user.id, issuedByName: user.name, invoiceNumber: r.inv.number, invoiceKey: r.inv.id || 'main' }));
    audit(user, 'invoice-issued', 'invoice-draft', id, `${p.company}: ${r.inv.number} for ${inrPaise(Math.round(r.inv.total * 100))}`, p.employerId);
    return { status: 200, draft: saved, invoice: r.inv, emailedTo: r.emailedTo };
  }
  function discardDraft(user, id, reason) {
    const d = drafts().find((x) => x.id === id);
    if (!d) return { status: 404, errors: ['invoice draft not found'] };
    const p = billing.read().find((x) => x.id === d.placementId) || { employerId: d.employerId };
    if (!canDraftFor(user, p) && !roles.can(user, 'invoices.issue')) return { status: 403, errors: ['your role does not allow that'] };
    if (d.status !== 'Draft') return { status: 409, errors: [`this draft is already ${d.status.toLowerCase()}`] };
    const saved = update('invoice-drafts', id, (rec) => Object.assign(rec, { status: 'Discarded', discardedAt: now(), discardedBy: user.id, discardReason: String(reason || '').slice(0, 200) }));
    audit(user, 'invoice-draft-discarded', 'invoice-draft', id, `${inrPaise(d.subtotalPaise)}${reason ? `: ${reason}` : ''}`, d.employerId);
    return { status: 200, draft: saved };
  }
  const draftJson = (d) => ({
    id: d.id, placementId: d.placementId, clientId: d.employerId, kind: d.kind, assignmentId: d.assignmentId, period: d.period, status: d.status,
    subtotal: showPaise(d.subtotalPaise), subtotalPaise: d.subtotalPaise, lines: d.lines.map((l) => ({ text: l.text, quantity: showQty(l.quantityH), unitPaise: l.unitPaise, amountPaise: l.amountPaise })),
    note: d.note, createdAt: d.createdAt, createdBy: d.createdByName, issuedAt: d.issuedAt || null, invoiceNumber: d.invoiceNumber || null,
  });

  // ---------- reports ----------
  const PERIODS = { '30': 30, '90': 90, '365': 365, all: 0 };
  function report(user, periodKey = '90') {
    const days = PERIODS[periodKey] ?? 90;
    const since = days ? new Date(Date.now() - days * 86400000).toISOString() : '';
    const inPeriod = (iso) => !since || (iso && iso >= since);
    const money = roles.can(user, 'money.view');
    const placements = billing.read();
    const reqs = requisitions();
    const live = reqs.filter((r) => ACTIVE.has(r.status));
    const desc = reqs.map((r) => describeReq(r, { placements }));
    const fills = placements.filter((p) => p.requisitionId && inPeriod(p.createdAt) && LIVE_PLACEMENT.includes(p.status));
    const fillDays = fills.map((p) => { const r = reqs.find((x) => x.id === p.requisitionId); return r ? daysBetween(r.createdAt, p.createdAt) : null; }).filter((x) => x !== null);
    const as = assignments();
    const today = todayIst();
    const billedIn = (p) => billing.invoicesOf(p).filter((inv) => !since || inv.date >= since.slice(0, 10));
    const people = team.members().filter((u) => u.role !== 'Finance Manager').map((u) => {
      const mine = desc.filter((r) => (r.recruiterIds || []).includes(u.id) && ACTIVE.has(r.status));
      return {
        id: u.id, name: u.name, role: (roles.ROLE_INFO[u.role] || {}).label || u.role,
        openRequisitions: mine.length, openingsLeft: mine.reduce((n, r) => n + r.remaining, 0), overdue: mine.filter((r) => r.overdue).length,
        placements: placements.filter((p) => p.recruiterId === u.id && inPeriod(p.createdAt) && LIVE_PLACEMENT.includes(p.status)).length,
        busy: mine.length > BUSY_REQUISITIONS,
      };
    });
    const byClient = clients.read().map((c) => {
      const rs = desc.filter((r) => r.employerId === c.id);
      const ps = placements.filter((p) => p.employerId === c.id);
      const row = {
        id: c.id, company: c.company, accountManager: c.accountManagerId ? nameOf(c.accountManagerId) : '',
        openRequisitions: rs.filter((r) => ACTIVE.has(r.status)).length, openingsLeft: rs.filter((r) => ACTIVE.has(r.status)).reduce((n, r) => n + r.remaining, 0),
        placements: ps.filter((p) => inPeriod(p.createdAt) && LIVE_PLACEMENT.includes(p.status)).length,
        activeWorkers: as.filter((a) => a.employerId === c.id && a.status === 'Active').length,
      };
      if (money) row.billedPaise = ps.reduce((n, p) => n + billedIn(p).reduce((m, inv) => m + Math.round(inv.subtotal * 100), 0), 0);
      return row;
    }).filter((x) => x.openRequisitions || x.placements || x.activeWorkers || x.billedPaise);
    const out = {
      period: { key: days ? String(days) : 'all', since: since ? since.slice(0, 10) : null },
      requisitions: {
        open: live.filter((r) => r.status === 'Open').length, requested: live.filter((r) => r.status === 'Requested').length, onHold: live.filter((r) => r.status === 'On hold').length,
        openingsLeft: desc.filter((r) => ACTIVE.has(r.status)).reduce((n, r) => n + r.remaining, 0),
        overdue: desc.filter((r) => r.overdue).length, stale: desc.filter((r) => r.stale).length,
        filledInPeriod: reqs.filter((r) => r.status === 'Filled' && inPeriod(r.closedAt)).length, cancelledInPeriod: reqs.filter((r) => r.status === 'Cancelled' && inPeriod(r.closedAt)).length,
        placementsInPeriod: fills.length, medianDaysToFill: median(fillDays),
        fillRate: (() => { const closed = reqs.filter((r) => ['Filled', 'Cancelled'].includes(r.status) && inPeriod(r.closedAt)); return closed.length ? Math.round((closed.filter((r) => r.status === 'Filled').length / closed.length) * 100) : null; })(),
      },
      placementsByType: Object.fromEntries(billing.TYPES.map((t) => [t, placements.filter((p) => p.type === t && inPeriod(p.createdAt)).length])),
      staffing: {
        active: as.filter((a) => a.status === 'Active').length, scheduled: as.filter((a) => a.status === 'Scheduled').length,
        startingThisWeek: as.filter((a) => a.status === 'Scheduled' && a.startsOn >= today && a.startsOn <= addDays(today, 7)).length,
        endingIn14Days: as.filter((a) => a.status === 'Active' && a.endsOn && a.endsOn >= today && a.endsOn <= addDays(today, 14)).length,
      },
      workload: roles.can(user, 'workload.view') || user.role === 'Admin' ? people : people.filter((x) => x.id === user.id),
      clients: byClient,
      invoiceDrafts: { waiting: drafts().filter((d) => d.status === 'Draft').length },
    };
    if (money) {
      const waiting = drafts().filter((d) => d.status === 'Draft');
      out.invoiceDrafts.waitingPaise = waiting.reduce((n, d) => n + d.subtotalPaise, 0);
      out.billedPaise = placements.reduce((n, p) => n + billedIn(p).reduce((m, inv) => m + Math.round(inv.subtotal * 100), 0), 0);
      out.staffingMarginPaise = as.filter((a) => a.status === 'Active' && a.rate.payPaise !== null).reduce((n, a) => n + (a.rate.billPaise - a.rate.payPaise), 0);
    }
    return out;
  }

  // ---------- pages (team) ----------
  const need = (action) => (req, res, next) => (roles.can(req.admin, action) ? next() : res.status(403).render('thanks', { title: 'Not part of your role', page: '', ok: false, message: 'Your role does not include this. Ask an Admin on your team if you need it.', noindex: true }));
  const view = (res, name, locals, status = 200) => res.status(status).render(name, {
    page: 'admin', noindex: true, errors: [], msg: '', inrPaise, showPaise, showBp, showQty, can: (a) => roles.can(res.locals.admin, a), roleInfo: roles.ROLE_INFO,
    REQ_STATUSES, REQ_KINDS, PRIORITIES, PAY_PERIODS, RATE_PER, SHIFTS, ASSIGN_STATUSES, ASSIGN_MOVES, REQ_MOVES, CONTRACT_KINDS, CONTRACT_STATUSES, ...locals,
  });
  const back = (res, url, msg) => res.redirect(`${url}${url.includes('?') ? '&' : '?'}msg=${encodeURIComponent(msg)}`);
  const firstUpper = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  // Clients: the spec's /admin/clients is the existing Clients tab.
  app.get('/admin/clients', adminAuth, (req, res) => res.redirect('/admin?tab=clients'));
  app.get('/admin/clients/:id', adminAuth, need('clients.view'), (req, res, next) => {
    const c = clientById(req.params.id);
    if (!c) return next();
    const reqs = requisitions().filter((r) => r.employerId === c.id && canSeeReq(req.admin, r)).map((r) => describeReq(r));
    const hireRequests = readSubmissions('hire-requests').filter((h) => h.employerId === c.id).slice(0, 10);
    view(res, 'admin-client', {
      title: `${c.company} · Client`, c, contracts: contracts().filter((x) => x.employerId === c.id), reqs, hireRequests,
      accountManager: c.accountManagerId ? memberById(c.accountManagerId) : null, accountManagers: accountManagers(),
      canManage: canManageClient(req.admin, c.id), canReq: canManageReq(req.admin, { employerId: c.id }), money: roles.can(req.admin, 'money.view'),
      showTerms: roles.can(req.admin, 'contracts.view'), msg: String(req.query.msg || ''), cf: {}, settingsFee: (site.billing || {}).feePercent,
    });
  });
  app.post('/admin/clients/:id/account-manager', adminAuth, sameOrigin, (req, res, next) => {
    const r = setAccountManager(req.admin, req.params.id, String(req.body.accountManagerId || ''));
    if (r.status === 404) return next();
    back(res, `/admin/clients/${req.params.id}`, r.errors ? firstUpper(r.errors[0]) : `Account manager: ${r.client.accountManagerId ? nameOf(r.client.accountManagerId) : 'none'}`);
  });
  app.post('/admin/clients/:id/contracts', adminAuth, sameOrigin, (req, res, next) => {
    const r = createContract(req.admin, req.params.id, req.body, false);
    if (r.status === 404) return next();
    if (r.status === 403) return need('nothing')(req, res);
    if (r.errors) {
      const c = clientById(req.params.id);
      return view(res, 'admin-client', {
        title: `${c.company} · Client`, c, contracts: contracts().filter((x) => x.employerId === c.id), reqs: requisitions().filter((x) => x.employerId === c.id).map((x) => describeReq(x)),
        hireRequests: [], accountManager: c.accountManagerId ? memberById(c.accountManagerId) : null, accountManagers: accountManagers(), canManage: true, canReq: canManageReq(req.admin, { employerId: c.id }),
        money: roles.can(req.admin, 'money.view'), showTerms: true, errors: r.errors, cf: req.body, settingsFee: (site.billing || {}).feePercent,
      }, 400);
    }
    back(res, `/admin/clients/${req.params.id}`, `Contract ${r.contract.reference} added`);
  });
  app.post('/admin/contracts/:id', adminAuth, sameOrigin, (req, res, next) => {
    const c = contracts().find((x) => x.id === req.params.id);
    if (!c) return next();
    const r = changeContract(req.admin, c.id, { status: String(req.body.status || '') }, false);
    if (r.status === 403) return need('nothing')(req, res);
    back(res, `/admin/clients/${c.employerId}`, r.errors ? firstUpper(r.errors[0]) : `Contract ${c.reference}: ${r.contract.status}`);
  });

  // Requisitions
  const reqFilters = (req) => ({
    status: REQ_STATUSES.includes(req.query.status) ? req.query.status : req.query.status === 'all' ? 'all' : '',
    client: String(req.query.client || '').slice(0, 60),
    recruiter: req.query.recruiter === 'me' ? 'me' : String(req.query.recruiter || '').slice(0, 60),
  });
  const filterReqs = (user, f) => requisitions().filter((r) => canSeeReq(user, r))
    .filter((r) => (f.status === 'all' ? true : f.status ? r.status === f.status : ACTIVE.has(r.status)))
    .filter((r) => !f.client || r.employerId === f.client)
    .filter((r) => !f.recruiter || (r.recruiterIds || []).includes(f.recruiter === 'me' ? user.id : f.recruiter));
  const reqListPage = (req, res, extra = {}, status = 200) => {
    const f = reqFilters(req);
    view(res, 'admin-requisitions', {
      title: 'Requisitions', f, rows: filterReqs(req.admin, f).map((r) => describeReq(r)), clientList: clients.read(), people: assignable(),
      canCreate: roles.can(req.admin, 'requisitions.manage'), jobs: getJobs().filter((j) => j.employerId && j.status === 'open'), contractList: contracts().filter((c) => contractLive(c)),
      rf: { kind: 'Permanent', openings: '1', priority: 'Normal', budgetPeriod: 'year', ratePer: 'day', clientId: String(req.query.client || '') }, msg: String(req.query.msg || ''), ...extra,
    }, status);
  };
  app.get('/admin/requisitions', adminAuth, need('requisitions.view'), (req, res) => reqListPage(req, res));
  app.post('/admin/requisitions', adminAuth, need('requisitions.manage'), sameOrigin, (req, res) => {
    const r = createRequisition(req.admin, req.body, false);
    if (r.errors) return reqListPage(req, res, { errors: r.errors, rf: req.body, openForm: true }, r.status);
    back(res, `/admin/requisitions/${r.requisition.id}`, `${r.requisition.number} opened`);
  });
  const reqPage = (req, res, r, extra = {}, status = 200) => {
    const d = describeReq(r);
    const placements = billing.read().filter((p) => p.requisitionId === r.id);
    view(res, 'admin-requisition', {
      title: `${r.number} · ${r.title}`, r: d, placements, staffing: assignments().filter((a) => a.requisitionId === r.id), people: assignable(),
      canManage: canManageReq(req.admin, r), canAssign: roles.can(req.admin, 'requisitions.assign'), money: roles.can(req.admin, 'money.view'),
      jobs: getJobs().filter((j) => j.employerId === r.employerId && j.status === 'open'), contractList: contracts().filter((c) => c.employerId === r.employerId && contractLive(c)),
      rf: { ...r, skills: (r.skills || []).join(', '), budgetMin: r.budget ? showPaise(r.budget.minPaise) : '', budgetMax: r.budget ? showPaise(r.budget.maxPaise) : '', budgetPeriod: r.budget ? r.budget.period : 'year', billRate: r.rates ? showPaise(r.rates.billPaise) : '', payRate: r.rates ? showPaise(r.rates.payPaise) : '', ratePer: r.rates ? r.rates.per : 'day' },
      msg: String(req.query.msg || ''), ...extra,
    }, status);
  };
  const findVisibleReq = (req) => {
    const r = requisitions().find((x) => x.id === req.params.id);
    return r && canSeeReq(req.admin, r) ? r : null;
  };
  app.get('/admin/requisitions/:id', adminAuth, need('requisitions.view'), (req, res, next) => {
    const r = findVisibleReq(req);
    if (!r) return next();
    reqPage(req, res, r);
  });
  app.post('/admin/requisitions/:id', adminAuth, need('requisitions.view'), sameOrigin, (req, res, next) => {
    const r = findVisibleReq(req);
    if (!r) return next();
    const body = { ...req.body };
    const out = changeRequisition(req.admin, r.id, body, false);
    if (out.status === 403) return need('nothing')(req, res);
    if (out.errors) return reqPage(req, res, r, { errors: out.errors, rf: { ...req.body } }, 400);
    back(res, `/admin/requisitions/${r.id}`, body.status && body.status !== r.status ? `${r.number}: ${body.status}` : `${r.number} saved`);
  });
  app.post('/admin/requisitions/:id/recruiters', adminAuth, need('requisitions.view'), sameOrigin, (req, res, next) => {
    const r = findVisibleReq(req);
    if (!r) return next();
    const out = assignRecruiters(req.admin, r.id, [].concat(req.body.recruiterIds || []));
    if (out.status === 403) return need('nothing')(req, res);
    back(res, `/admin/requisitions/${r.id}`, out.errors ? firstUpper(out.errors[0]) : `Recruiters for ${r.number}: ${out.requisition.recruiterIds.map(nameOf).join(', ') || 'nobody'}`);
  });
  // A client's portal request becomes a requisition the team works.
  app.post('/admin/hire-requests/:id/requisition', adminAuth, need('requisitions.manage'), sameOrigin, (req, res, next) => {
    const h = readSubmissions('hire-requests').find((x) => x.id === req.params.id);
    if (!h || !h.employerId) return next();
    const headcount = Math.min(500, Math.max(1, parseInt(h.headcount, 10) || 1));
    const kind = /temp|contract|gig|daily/i.test(h.hiringType || '') ? (/temp|gig|daily/i.test(h.hiringType) ? 'Temporary' : 'Contract') : 'Permanent';
    const out = createRequisition(req.admin, { clientId: h.employerId, title: String(h.roles).slice(0, 120), kind, openings: String(headcount), location: String(h.location || '').slice(0, 80), description: String(h.message || '').slice(0, 3000) }, false);
    if (out.errors) return back(res, `/admin/clients/${h.employerId}`, firstUpper(out.errors[0]));
    update('requisitions', out.requisition.id, (rec) => { rec.hireRequestId = h.id; rec.source = 'client'; });
    back(res, `/admin/requisitions/${out.requisition.id}`, `${out.requisition.number} opened from the client's request: check the details and assign recruiters`);
  });

  // The recruiter's own workspace, with the team's workload for managers.
  app.get('/admin/workspace', adminAuth, need('requisitions.view'), (req, res) => {
    const me = req.admin;
    const placements = billing.read();
    const mine = requisitions().filter((r) => (r.recruiterIds || []).includes(me.id) && ACTIVE.has(r.status)).map((r) => describeReq(r, { placements }))
      .sort((a, b) => (PRIORITIES.indexOf(b.priority) - PRIORITIES.indexOf(a.priority)) || String(a.dueOn || '9999').localeCompare(String(b.dueOn || '9999')));
    const myPlacements = placements.filter((p) => p.recruiterId === me.id).slice(0, 50);
    const myStaffing = assignments().filter((a) => ['Scheduled', 'Active'].includes(a.status) && mine.some((r) => r.id === a.requisitionId));
    view(res, 'admin-workspace', { title: 'My workspace', mine, myPlacements, myStaffing, report: report(me, '90'), msg: String(req.query.msg || '') });
  });

  // Staffing assignments
  const staffingPage = (req, res, extra = {}, status = 200) => {
    const f = { status: ASSIGN_STATUSES.includes(req.query.status) ? req.query.status : '', placement: String(req.query.placement || '').slice(0, 60), client: String(req.query.client || '').slice(0, 60) };
    const rows = assignments().filter((a) => (f.status ? a.status === f.status : ['Scheduled', 'Active'].includes(a.status) || !!f.placement))
      .filter((a) => !f.placement || a.placementId === f.placement).filter((a) => !f.client || a.employerId === f.client)
      .map((a) => ({ ...a, company: (clientById(a.employerId) || {}).company || '', canManage: canManageAssignment(req.admin, a), billed: drafts().filter((d) => d.assignmentId === a.id && d.status !== 'Discarded') }));
    view(res, 'admin-staffing', {
      title: 'Staffing assignments', f, rows, eligible: eligiblePlacements(), clientList: clients.read(), money: roles.can(req.admin, 'money.view'),
      canAdd: roles.can(req.admin, 'staffing.manage') && req.admin.role !== 'Finance Manager', canDraft: roles.can(req.admin, 'invoices.draft'), af: { ratePer: 'day', placementId: f.placement }, today: todayIst(), msg: String(req.query.msg || ''), ...extra,
    }, status);
  };
  app.get('/admin/staffing', adminAuth, need('staffing.view'), (req, res) => staffingPage(req, res));
  app.post('/admin/staffing', adminAuth, need('staffing.manage'), sameOrigin, (req, res) => {
    const r = createAssignment(req.admin, req.body, false);
    if (r.status === 403) return need('nothing')(req, res);
    if (r.errors) return staffingPage(req, res, { errors: r.errors, af: req.body, openForm: true }, 400);
    back(res, '/admin/staffing', `${r.assignment.workerName} scheduled as ${r.assignment.role} from ${r.assignment.startsOn}`);
  });
  app.post('/admin/staffing/:id', adminAuth, need('staffing.manage'), sameOrigin, (req, res, next) => {
    const a = assignments().find((x) => x.id === req.params.id);
    if (!a) return next();
    const body = Object.fromEntries(Object.entries(req.body).filter(([k]) => ASSIGN_FIELDS.includes(k)));
    const r = changeAssignment(req.admin, a.id, body, false);
    if (r.status === 403) return need('nothing')(req, res);
    back(res, '/admin/staffing', r.errors ? firstUpper(r.errors[0]) : `${a.workerName}: ${r.assignment.status}`);
  });
  app.post('/admin/staffing/:id/invoice-draft', adminAuth, need('invoices.draft'), sameOrigin, (req, res, next) => {
    const a = assignments().find((x) => x.id === req.params.id);
    if (!a) return next();
    const r = createDraft(req.admin, a.placementId, { assignmentId: a.id, from: req.body.from, to: req.body.to, quantity: req.body.quantity }, req.body.requestKey || null);
    if (r.status === 403) return need('nothing')(req, res);
    back(res, r.errors ? '/admin/staffing' : '/admin/invoice-drafts', r.errors ? firstUpper(r.errors[0]) : r.existed ? 'That period already has a draft' : `Invoice draft for ${inrPaise(r.draft.subtotalPaise)} + GST sent to Finance`);
  });

  // Invoice drafts: Finance's queue.
  app.get('/admin/invoice-drafts', adminAuth, need('invoices.draft'), (req, res) => {
    const placements = billing.read();
    const status = ['Draft', 'Issued', 'Discarded'].includes(req.query.status) ? req.query.status : 'Draft';
    const rows = drafts().filter((d) => d.status === status).map((d) => ({ ...d, p: placements.find((p) => p.id === d.placementId) || null, company: (clientById(d.employerId) || {}).company || '' }));
    // Joined placements with a one-time fee nobody has asked to invoice yet.
    const waiting = placements.filter((p) => p.status === 'Joined' && !p.invoice && ['percent', 'flat'].includes(p.feeMode) && p.fee > 0 && !drafts().some((d) => d.naturalKey === `fee:${p.id}` && d.status !== 'Discarded'));
    view(res, 'admin-invoice-drafts', { title: 'Invoice drafts', rows, status, waiting, canIssue: roles.can(req.admin, 'invoices.issue'), clientById, msg: String(req.query.msg || ''), requestKey: crypto.randomUUID() });
  });
  app.post('/admin/placements/:id/invoice-draft', adminAuth, need('invoices.draft'), sameOrigin, (req, res) => {
    const r = createDraft(req.admin, req.params.id, {}, req.body.requestKey || null);
    if (r.status === 403) return need('nothing')(req, res);
    back(res, '/admin/invoice-drafts', r.errors ? firstUpper(r.errors[0]) : r.existed ? 'That invoice is already drafted' : `Invoice draft for ${inrPaise(r.draft.subtotalPaise)} + GST added`);
  });
  app.post('/admin/invoice-drafts/:id/issue', adminAuth, need('invoices.issue'), sameOrigin, (req, res) => {
    const r = issueDraft(req.admin, req.params.id, { email: req.body.email === '1' });
    if (r.status === 404) return res.status(404).render('404', { title: 'Not found', page: '', noindex: true });
    back(res, '/admin/invoice-drafts', r.errors ? firstUpper(r.errors[0]) : r.existed ? `Already issued as ${r.draft.invoiceNumber}` : `Invoice ${r.invoice.number} issued${r.emailedTo ? ` · emailed to ${r.emailedTo}` : ''}. Record payments under Placements when they arrive.`);
  });
  app.post('/admin/invoice-drafts/:id/discard', adminAuth, sameOrigin, (req, res) => {
    const r = discardDraft(req.admin, req.params.id, String(req.body.reason || ''));
    if (r.status === 404) return res.status(404).render('404', { title: 'Not found', page: '', noindex: true });
    if (r.status === 403) return need('nothing')(req, res);
    back(res, '/admin/invoice-drafts', r.errors ? firstUpper(r.errors[0]) : 'Draft discarded');
  });

  // Reports and the audit log
  app.get('/admin/recruitment-reports', adminAuth, need('reports.view'), (req, res) => {
    const period = Object.keys(PERIODS).includes(String(req.query.period)) ? String(req.query.period) : '90';
    view(res, 'admin-recruitment-reports', { title: 'Recruitment reports', r: report(req.admin, period), period, money: roles.can(req.admin, 'money.view') });
  });
  const auditRows = (q) => readSubmissions('agency-audit')
    .filter((e) => !q.entity || e.entity === q.entity).filter((e) => !q.client || e.employerId === q.client).slice(0, 200);
  app.get('/admin/agency-audit', adminAuth, need('audit.view'), (req, res) => {
    const q = { entity: ['requisition', 'contract', 'client', 'assignment', 'invoice-draft'].includes(req.query.entity) ? req.query.entity : '', client: String(req.query.client || '').slice(0, 60) };
    view(res, 'admin-agency-audit', { title: 'Agency audit log', rows: auditRows(q), q, clientList: clients.read() });
  });

  // The spec's paths, kept as short links to where things live.
  app.get('/recruiter/workspace', (req, res) => res.redirect('/admin/workspace'));
  app.get('/recruiter/placements', (req, res) => res.redirect('/admin/workspace#placements'));
  app.get('/staffing/assignments', (req, res) => res.redirect('/admin/staffing'));
  app.get('/client/requisitions', (req, res) => res.redirect('/employer/requisitions'));
  app.get('/client/candidates', (req, res) => res.redirect('/employer#shortlist'));

  // ---------- JSON for the team ----------
  const teamApi = (action) => (req, res, next) => {
    const user = team.currentUser(req);
    if (!user) return res.status(401).json({ ok: false, errors: ['sign in to the team admin first'] });
    if (team.requires2fa() && !team.has2fa(user.id)) return res.status(403).json({ ok: false, errors: ['your team requires two-step sign-in: set it up first'] });
    if (action && !roles.can(user, action)) return res.status(403).json({ ok: false, errors: ['your role does not allow that'] });
    req.admin = user;
    res.set('Cache-Control', 'no-store');
    next();
  };
  const reply = (res, r, key, map) => (r.errors ? res.status(r.status).json({ ok: false, errors: r.errors }) : res.status(r.status).json({ ok: true, ...(r.existed ? { existed: true } : {}), [key]: map(r[key]) }));
  const apiLimit = limit('agency-api', 300, 60 * 1000);

  app.get('/api/clients', teamApi('clients.view'), apiLimit, (req, res) => {
    const reqs = requisitions();
    res.json({
      ok: true,
      clients: clients.read().map((c) => ({
        id: c.id, company: c.company, active: Boolean(c.active), verified: clients.verificationOf(c) === 'verified',
        accountManager: c.accountManagerId ? { id: c.accountManagerId, name: nameOf(c.accountManagerId) } : null,
        activeContracts: contracts().filter((x) => x.employerId === c.id && contractLive(x)).length,
        openRequisitions: reqs.filter((r) => r.employerId === c.id && ACTIVE.has(r.status)).length,
      })),
    });
  });
  app.get('/api/clients/:id', teamApi('clients.view'), apiLimit, (req, res) => {
    const c = clientById(req.params.id);
    if (!c) return res.status(404).json({ ok: false, errors: ['client not found'] });
    res.json({
      ok: true, client: { id: c.id, company: c.company, active: Boolean(c.active), accountManager: c.accountManagerId ? { id: c.accountManagerId, name: nameOf(c.accountManagerId) } : null },
      contracts: roles.can(req.admin, 'contracts.view') ? contracts().filter((x) => x.employerId === c.id).map((x) => contractJson(x, req.admin)) : [],
      requisitions: requisitions().filter((r) => r.employerId === c.id && canSeeReq(req.admin, r)).map((r) => reqJson(r, req.admin)),
    });
  });
  app.put('/api/clients/:id/account-manager', teamApi('clients.manage'), apiLimit, sameOrigin, (req, res) => {
    const r = setAccountManager(req.admin, req.params.id, String((req.body || {}).accountManagerId || ''));
    if (r.errors) return res.status(r.status).json({ ok: false, errors: r.errors });
    res.json({ ok: true, accountManager: r.client.accountManagerId ? { id: r.client.accountManagerId, name: nameOf(r.client.accountManagerId) } : null });
  });
  app.post('/api/clients/:id/contracts', teamApi('clients.manage'), apiLimit, sameOrigin, (req, res) => reply(res, createContract(req.admin, req.params.id, req.body, true), 'contract', (c) => contractJson(c, req.admin)));
  app.patch('/api/contracts/:id', teamApi('clients.manage'), apiLimit, sameOrigin, (req, res) => reply(res, changeContract(req.admin, req.params.id, req.body, true), 'contract', (c) => contractJson(c, req.admin)));

  app.get('/api/requisitions', teamApi('requisitions.view'), apiLimit, (req, res) => {
    const f = reqFilters(req);
    res.json({ ok: true, requisitions: filterReqs(req.admin, f).map((r) => reqJson(r, req.admin)) });
  });
  app.post('/api/requisitions', teamApi('requisitions.manage'), apiLimit, sameOrigin, (req, res) => reply(res, createRequisition(req.admin, req.body, true), 'requisition', (r) => reqJson(r, req.admin)));
  app.get('/api/requisitions/:id', teamApi('requisitions.view'), apiLimit, (req, res) => {
    const r = requisitions().find((x) => x.id === req.params.id);
    if (!r || !canSeeReq(req.admin, r)) return res.status(404).json({ ok: false, errors: ['requisition not found'] });
    res.json({ ok: true, requisition: { ...reqJson(r, req.admin), history: r.history } });
  });
  app.patch('/api/requisitions/:id', teamApi('requisitions.view'), apiLimit, sameOrigin, (req, res) => reply(res, changeRequisition(req.admin, req.params.id, req.body || {}, true), 'requisition', (r) => reqJson(r, req.admin)));
  app.put('/api/requisitions/:id/recruiters', teamApi('requisitions.view'), apiLimit, sameOrigin, (req, res) => {
    const ids = (req.body || {}).recruiterIds;
    if (!Array.isArray(ids)) return res.status(400).json({ ok: false, errors: ['recruiterIds must be a list of team member ids'] });
    reply(res, assignRecruiters(req.admin, req.params.id, ids), 'requisition', (r) => reqJson(r, req.admin));
  });

  const placementJson = (p, user) => {
    const out = { id: p.id, candidateName: p.candidateName, jobTitle: p.jobTitle, clientId: p.employerId, company: p.company, type: p.type, status: p.status, joiningDate: p.joiningDate, requisitionId: p.requisitionId || null, recruiterId: p.recruiterId || null, billing: p.feeMode, createdAt: p.createdAt };
    if (roles.can(user, 'money.view')) Object.assign(out, { fee: p.fee, feePaise: Math.round((p.fee || 0) * 100), monthlyRate: p.monthlyRate, invoices: billing.invoicesOf(p).map((i) => ({ number: i.number, date: i.date, total: i.total, status: i.status })) });
    return out;
  };
  app.get('/api/placements', teamApi('placements.view'), apiLimit, (req, res) => {
    const mine = req.query.recruiter === 'me';
    const reqId = String(req.query.requisition || '');
    res.json({ ok: true, placements: billing.read().filter((p) => (!mine || p.recruiterId === req.admin.id) && (!reqId || p.requisitionId === reqId)).map((p) => placementJson(p, req.admin)) });
  });
  app.get('/api/placements/:id/invoices', teamApi('invoices.draft'), apiLimit, (req, res) => {
    const p = billing.read().find((x) => x.id === req.params.id);
    if (!p) return res.status(404).json({ ok: false, errors: ['placement not found'] });
    res.json({
      ok: true, invoices: billing.invoicesOf(p).map((i) => ({ key: i.id || 'main', number: i.number, date: i.date, dueDate: i.dueDate, subtotal: i.subtotal, total: i.total, status: i.status, period: i.period || null })),
      drafts: drafts().filter((d) => d.placementId === p.id).map(draftJson),
    });
  });
  app.post('/api/placements/:id/invoices', teamApi('invoices.draft'), limit('invoice-drafts', 60, 60 * 1000), sameOrigin, (req, res) => reply(res, createDraft(req.admin, req.params.id, req.body, req.get('Idempotency-Key')), 'draft', draftJson));
  app.post('/api/placements/:id/invoices/:draftId/issue', teamApi('invoices.issue'), limit('invoice-drafts', 60, 60 * 1000), sameOrigin, (req, res) => {
    const d = drafts().find((x) => x.id === req.params.draftId && x.placementId === req.params.id);
    if (!d) return res.status(404).json({ ok: false, errors: ['invoice draft not found'] });
    const r = issueDraft(req.admin, d.id, { email: (req.body || {}).email === true });
    if (r.errors) return res.status(r.status).json({ ok: false, errors: r.errors });
    res.json({ ok: true, ...(r.existed ? { existed: true } : {}), draft: draftJson(r.draft), invoiceNumber: r.draft.invoiceNumber });
  });
  app.delete('/api/placements/:id/invoices/:draftId', teamApi('invoices.draft'), apiLimit, sameOrigin, (req, res) => {
    const d = drafts().find((x) => x.id === req.params.draftId && x.placementId === req.params.id);
    if (!d) return res.status(404).json({ ok: false, errors: ['invoice draft not found'] });
    reply(res, discardDraft(req.admin, d.id, (req.body || {}).reason), 'draft', draftJson);
  });

  app.get('/api/staffing/assignments', teamApi('staffing.view'), apiLimit, (req, res) => {
    const status = String(req.query.status || '');
    if (status && !ASSIGN_STATUSES.includes(status)) return res.status(400).json({ ok: false, errors: [`status must be one of: ${ASSIGN_STATUSES.join(', ')}`] });
    res.json({ ok: true, assignments: assignments().filter((a) => !status || a.status === status).filter((a) => !req.query.placement || a.placementId === String(req.query.placement)).map((a) => assignmentJson(a, req.admin)) });
  });
  app.post('/api/staffing/assignments', teamApi('staffing.manage'), apiLimit, sameOrigin, (req, res) => reply(res, createAssignment(req.admin, req.body, true), 'assignment', (a) => assignmentJson(a, req.admin)));
  app.patch('/api/staffing/assignments/:id', teamApi('staffing.view'), apiLimit, sameOrigin, (req, res) => reply(res, changeAssignment(req.admin, req.params.id, req.body || {}, true), 'assignment', (a) => assignmentJson(a, req.admin)));

  app.get('/api/recruitment/reports', teamApi('reports.view'), apiLimit, (req, res) => {
    const period = String(req.query.period || '90');
    if (!Object.keys(PERIODS).includes(period)) return res.status(400).json({ ok: false, errors: ['period must be one of: 30, 90, 365, all'] });
    res.json({ ok: true, report: report(req.admin, period) });
  });
  app.get('/api/recruitment/audit', teamApi('audit.view'), apiLimit, (req, res) => {
    res.json({ ok: true, entries: auditRows({ entity: String(req.query.entity || ''), client: String(req.query.client || '') }).map((e) => ({ at: e.createdAt, actor: e.actorName, role: e.role, action: e.action, entity: e.entity, entityId: e.entityId, clientId: e.employerId, detail: e.detail })) });
  });

  // ---------- the client's side ----------
  // A client sees only its own requisitions: the company comes from the
  // signed-in person's membership, never from the browser.
  const clientList = (req) => requisitions().filter((r) => r.employerId === req.employer.id).map((r) => clientReqView(r, req.member));
  const clientPage = (req, res, extra = {}, status = 200) => res.status(status).render('employer-requisitions', {
    title: `${req.employer.company} · Requisitions`, page: 'employer', noindex: true, tab: 'requisitions', errors: [], rows: clientList(req), REQ_KINDS, PAY_PERIODS,
    canRequest: employerCan(req.member, 'requirements.send'), money: employerCan(req.member, 'billing.view'), detail: null, msg: String(req.query.msg || ''), rf: { kind: 'Permanent', openings: '1', budgetPeriod: 'year' }, ...extra,
  });
  app.get('/employer/requisitions', requireEmployer, (req, res) => clientPage(req, res));
  app.get('/employer/requisitions/:id', requireEmployer, (req, res, next) => {
    const r = requisitions().find((x) => x.id === req.params.id && x.employerId === req.employer.id);
    if (!r) return next();
    const shortlist = clients.shortlistFor(req.employer).filter((a) => r.jobId && readSubmissions('applications').some((x) => x.id === a.id && x.jobId === r.jobId));
    const workers = assignments().filter((a) => a.requisitionId === r.id && a.status !== 'Cancelled').map((a) => ({ worker: a.workerName, role: a.role, site: a.site, shift: a.shift, startsOn: a.startsOn, endsOn: a.endsOn, status: a.status }));
    clientPage(req, res, { detail: { r: clientReqView(r, req.member), shortlist, workers } });
  });
  app.post('/employer/requisitions', requireEmployer, limit('employer-req', 10), sameOrigin, (req, res) => {
    if (!employerCan(req.member, 'requirements.send')) return clients.forbid(req, res);
    const r = clientRequisition(req.employer, req.employerUser, req.body, false);
    if (r.errors) return clientPage(req, res, { errors: r.errors, rf: req.body }, 400);
    res.redirect(`/employer/requisitions?msg=${encodeURIComponent(`Request ${r.requisition.number} sent. Your account manager will confirm it within one working day.`)}`);
  });
  app.post('/employer/requisitions/:id/cancel', requireEmployer, limit('employer-req', 10), sameOrigin, (req, res, next) => {
    const r = requisitions().find((x) => x.id === req.params.id && x.employerId === req.employer.id);
    if (!r) return next();
    if (!employerCan(req.member, 'requirements.send')) return clients.forbid(req, res);
    if (r.status !== 'Requested') return res.redirect(`/employer/requisitions?msg=${encodeURIComponent(`${r.number} is already being worked on: ask your account manager to change it.`)}`);
    update('requisitions', r.id, (rec) => { rec.status = 'Cancelled'; rec.closedAt = now(); rec.history.push({ at: now(), by: `${req.employerUser.name} (${req.employer.company})`, text: 'Requested → Cancelled by the client' }); });
    saveSubmission('agency-audit', { actorId: '', actorName: `${req.employerUser.name} (${req.employer.company})`, role: 'Client Employer', action: 'requisition-status', entity: 'requisition', entityId: r.id, employerId: r.employerId, detail: `${r.number}: Requested → Cancelled by the client` });
    res.redirect(`/employer/requisitions?msg=${encodeURIComponent(`${r.number} cancelled.`)}`);
  });
  app.get('/api/employers/requisitions', requireEmployerApi, (req, res) => res.json({ ok: true, requisitions: clientList(req) }));
  app.get('/api/employers/requisitions/:id', requireEmployerApi, (req, res) => {
    const r = requisitions().find((x) => x.id === req.params.id && x.employerId === req.employer.id);
    if (!r) return res.status(404).json({ ok: false, errors: ['requisition not found'] });
    res.json({ ok: true, requisition: clientReqView(r, req.member) });
  });
  app.post('/api/employers/requisitions', requireEmployerApi, limit('employer-req', 10), sameOrigin, (req, res) => {
    if (!employerCan(req.member, 'requirements.send')) return clients.forbid(req, res);
    const r = clientRequisition(req.employer, req.employerUser, req.body, true);
    if (r.errors) return res.status(r.status).json({ ok: false, errors: r.errors });
    res.status(201).json({ ok: true, requisition: clientReqView(r.requisition, req.member) });
  });

  return { report, requisitions, contracts, assignments, drafts, createDraft, issueDraft, describeReq };
}

module.exports = { register, paiseFrom, bpFrom, qtyFrom, percentOf, timesQty, parseContract, parseRequisition, parseAssignment, REQ_MOVES, ASSIGN_MOVES, REQ_STATUSES };
