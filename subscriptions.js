// Employer plans, subscriptions and online payments (Step 63).
//
// - Plans (subscription-plans) are configured by Admins: price, billing
//   interval, job and team-seat limits, features and the GST rate and SAC for
//   each plan or service package. Nothing here is fixed in code except the
//   first set of plans, written once.
// - A company's subscription (employer-subscriptions, one per company) says
//   which plan it is on, for which period, and what happens at the end of it.
//   Self-registered companies without one are on the free plan; companies the
//   team set up (managed clients, billed for placements) have no plan limits.
// - Every online payment is a transaction (payment-transactions) with a
//   provider order. It is "paid" only after the server has checked the
//   payment's signature and confirmed the payment with the provider (the
//   provider's API, or its signed webhook). Repeated callbacks or webhooks find
//   the transaction already settled and change nothing; the database also
//   refuses a second invoice for one transaction or a second record of one
//   webhook event.
// - Paying creates a numbered tax invoice (billing-invoices, in the same
//   INV/<FY>/<n> series as placement invoices) with its lines, GST and both
//   parties as they were at the time. Refunds are asked for by one person and
//   approved by another, with a credit note in the CN series.
// - Money is kept in paise (integers) with the currency next to it.
const crypto = require('crypto');
const { billingOf, amountInWords, formatYmd, financialYear } = require('./placements');
const { can: employerCan } = require('./employer-team');
const agencyRoles = require('./agency-roles');
const { HARD_UNLOCK_CAP, DEFAULT_MONTHLY, MAX_PACK } = require('./contact-credits');

const PLANS = 'subscription-plans';
const SUBS = 'employer-subscriptions';
const TXNS = 'payment-transactions';
const INVOICES = 'billing-invoices';
const REFUNDS = 'refund-records';
const EVENTS = 'payment-webhook-events';
const PROFILES = 'billing-profiles';

const CURRENCY = 'INR';
const INTERVALS = { month: 'Monthly', year: 'Yearly' };
// Jobs live, paused or waiting for review, and team members, when a plan sets no limit.
const HARD_JOB_CAP = 50;
const HARD_SEAT_CAP = 50;
const SETTLED = ['paid', 'refunded', 'partially_refunded'];
const TXN_STATUSES = ['created', 'pending', 'paid', 'failed', 'review', 'expired', 'refunded', 'partially_refunded'];
const REFUND_REASONS = ['Duplicate payment', 'Charged in error', 'Service not delivered', 'Cancelled within the agreed period', 'Goodwill', 'Other'];
const OFFLINE_MODES = ['Bank transfer', 'UPI', 'Cheque', 'Other'];
const SETTINGS_KEY = 'billing:subscription-settings';
const SETTINGS_DEFAULTS = { graceDays: 7, reminderDays: [7, 3, 1] };
const SEED_KEY = 'billing:plans-seeded';
// Version of the first plans written by seedPlans (see docs/BILLING.md).
// 2 added the contact credit packs (Step 85).
const SEED_VERSION = 2;

// States and union territories with their GST state codes (first two digits of a GSTIN).
const STATES = [
  ['01', 'Jammu and Kashmir'], ['02', 'Himachal Pradesh'], ['03', 'Punjab'], ['04', 'Chandigarh'], ['05', 'Uttarakhand'], ['06', 'Haryana'],
  ['07', 'Delhi'], ['08', 'Rajasthan'], ['09', 'Uttar Pradesh'], ['10', 'Bihar'], ['11', 'Sikkim'], ['12', 'Arunachal Pradesh'], ['13', 'Nagaland'],
  ['14', 'Manipur'], ['15', 'Mizoram'], ['16', 'Tripura'], ['17', 'Meghalaya'], ['18', 'Assam'], ['19', 'West Bengal'], ['20', 'Jharkhand'],
  ['21', 'Odisha'], ['22', 'Chhattisgarh'], ['23', 'Madhya Pradesh'], ['24', 'Gujarat'], ['26', 'Dadra and Nagar Haveli and Daman and Diu'],
  ['27', 'Maharashtra'], ['29', 'Karnataka'], ['30', 'Goa'], ['31', 'Lakshadweep'], ['32', 'Kerala'], ['33', 'Tamil Nadu'], ['34', 'Puducherry'],
  ['35', 'Andaman and Nicobar Islands'], ['36', 'Telangana'], ['37', 'Andhra Pradesh'], ['38', 'Ladakh'],
];
const stateCode = (name) => (STATES.find(([, n]) => n.toLowerCase() === String(name || '').trim().toLowerCase()) || [''])[0];
const stateName = (code) => (STATES.find(([c]) => c === code) || ['', ''])[1];

// The first plans (prices exclude GST). Admins change all of it later.
function defaultPlans(gstPercent) {
  const plan = (p) => ({ kind: 'subscription', currency: CURRENCY, interval: 'month', custom: false, active: true, gstPercent, sac: '', summary: '', features: [], ...p });
  return [
    plan({ code: 'starter', name: 'Starter', pricePaise: 0, jobLimit: 3, seatLimit: 3, contactUnlocks: 5, sort: 1, summary: 'Free for small teams getting started',
      features: ['3 jobs live at a time', '3 team members', '5 candidate contacts a month', 'Applicant tracking and interview scheduling', 'Email support'] }),
    plan({ code: 'growth', name: 'Growth', pricePaise: 199900, jobLimit: 10, seatLimit: 5, contactUnlocks: 30, sort: 2, summary: 'For companies hiring every month',
      features: ['10 jobs live at a time', '5 team members', 'Find candidates who agreed to be found', '30 candidate contacts a month', 'Hiring reports'] }),
    plan({ code: 'business', name: 'Business', pricePaise: 499900, jobLimit: 30, seatLimit: 15, contactUnlocks: 100, sort: 3, summary: 'For larger hiring teams',
      features: ['30 jobs live at a time', '15 team members', '100 candidate contacts a month', 'Analytics and exports', 'Priority support'] }),
    plan({ code: 'enterprise', name: 'Enterprise', pricePaise: null, custom: true, jobLimit: null, seatLimit: null, sort: 4, summary: 'Custom limits, terms and services',
      features: ['Limits agreed with you', 'An account manager', 'Staffing and placement services', 'Invoices on agreed terms'] }),
    // A one-time service package; switched off until the team sets its price and SAC.
    plan({ code: 'assisted-hiring', kind: 'package', name: 'Assisted hiring (one role)', pricePaise: 999900, interval: null, jobLimit: null, seatLimit: null, sort: 10, active: false, sac: '998512',
      summary: 'A Hireriv recruiter screens applicants and shortlists for one role', features: ['Screening calls', 'A shortlist within 10 working days', 'Interviews arranged for you'] }),
    // Contact credit packs (contact-credits.js); switched off until the team sets their price and SAC.
    plan({ code: 'contact-credits-25', kind: 'package', name: '25 contact credits', pricePaise: 49900, interval: null, jobLimit: null, seatLimit: null, credits: 25, sort: 11, active: false,
      summary: 'See the mobile numbers of 25 more job seekers who agreed to it', features: ['Call or WhatsApp them directly', 'Credits never expire', 'Unlocking someone again is free'] }),
    plan({ code: 'contact-credits-100', kind: 'package', name: '100 contact credits', pricePaise: 149900, interval: null, jobLimit: null, seatLimit: null, credits: 100, sort: 12, active: false,
      summary: 'See the mobile numbers of 100 more job seekers who agreed to it', features: ['Call or WhatsApp them directly', 'Credits never expire', 'Unlocking someone again is free'] }),
  ];
}

// ---------- dates (India time, YYYY-MM-DD) ----------
const todayIst = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const DAY_MS = 86400000;
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
// The same day next month or next year (31 Jan → 28/29 Feb).
function addInterval(ymd, interval) {
  const [y, m, d] = ymd.split('-').map(Number);
  const months = interval === 'year' ? 12 : 1;
  const ty = y + Math.floor((m - 1 + months) / 12);
  const tm = ((m - 1 + months) % 12) + 1;
  const last = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
  return `${ty}-${String(tm).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}
const iso = () => new Date().toISOString();

// ---------- money ----------
const rupees = (paise) => (Number(paise) || 0) / 100;
const inr = (paise) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: CURRENCY, maximumFractionDigits: 2 }).format(rupees(paise));
// "1,999" or "₹1,999.50" typed by a person → paise; NaN when it isn't a sum of money.
function paiseIn(v) {
  const raw = String(v ?? '').replace(/[,₹\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return NaN;
  const [r, p = ''] = raw.split('.');
  return Number(r) * 100 + Number(p.padEnd(2, '0'));
}
// GST on a taxable value: CGST + SGST for a buyer in the seller's state, IGST otherwise.
function taxOf(subtotalPaise, gstPercent, taxType) {
  const tax = Math.round((subtotalPaise * gstPercent) / 100);
  if (!gstPercent) return { taxPaise: 0, taxLines: [] };
  if (taxType === 'intra') {
    const half = Math.round(tax / 2);
    return { taxPaise: tax, taxLines: [{ label: `CGST @ ${gstPercent / 2}%`, amountPaise: half }, { label: `SGST @ ${gstPercent / 2}%`, amountPaise: tax - half }] };
  }
  return { taxPaise: tax, taxLines: [{ label: `IGST @ ${gstPercent}%`, amountPaise: tax }] };
}
// A monthly figure to compare plans with different intervals.
const perMonth = (plan) => (plan.pricePaise || 0) / (plan.interval === 'year' ? 12 : 1);

const clip = (v, n) => String(v ?? '').trim().slice(0, n);
const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function create({ db, site, gateway, validGstin = () => true }) {
  db.uniqueKey(PLANS, (p) => p.code || null);
  db.uniqueKey(SUBS, (s) => s.employerId || null);
  db.uniqueKey(TXNS, (t) => (t.orderId ? `${t.provider}:${t.orderId}` : null));
  // One invoice per payment, and invoice numbers never repeat.
  db.uniqueKey(INVOICES, (i) => (i.transactionId ? `txn:${i.transactionId}` : `no:${i.number}`));
  db.uniqueKey(REFUNDS, (r) => (r.providerRefundId ? `${r.provider}:${r.providerRefundId}` : null));
  db.uniqueKey(EVENTS, (e) => `${e.provider}:${e.eventId}`);
  db.uniqueKey(PROFILES, (p) => p.employerId || null);

  const find = (collection, field, value) => db.where(collection, field, value)[0] || null;
  const put = (collection, doc) => {
    doc.updatedAt = iso();
    if (!db.update(collection, doc)) db.prepend(collection, doc);
    return doc;
  };
  const add = (collection, doc) => {
    const d = { id: crypto.randomUUID(), createdAt: iso(), ...doc };
    db.prepend(collection, d);
    return d;
  };

  // ---------- settings and plans ----------
  function settings() {
    let saved = {};
    try { saved = JSON.parse(db.metaGet(SETTINGS_KEY) || '{}'); } catch (e) { saved = {}; }
    return { ...SETTINGS_DEFAULTS, ...saved };
  }
  const saveSettings = (s) => db.metaSet(SETTINGS_KEY, JSON.stringify(s));

  // Writes the first plans once (a versioned data change). unseedPlans undoes it
  // for plans nobody has used yet.
  function seedPlans() {
    if (Number(db.metaGet(SEED_KEY) || 0) >= SEED_VERSION) return 0;
    const gst = billingOf(site).gstPercent;
    let n = 0;
    db.transaction(() => {
      for (const p of defaultPlans(gst)) {
        const had = find(PLANS, 'code', p.code);
        // Plans seeded before version 2 get the free contacts their defaults include.
        if (had && had.seeded && had.contactUnlocks === undefined && p.contactUnlocks !== undefined) put(PLANS, { ...had, contactUnlocks: p.contactUnlocks });
        if (had) continue;
        db.prepend(PLANS, { id: crypto.randomUUID(), ...p, version: 1, seeded: SEED_VERSION, createdAt: iso(), updatedAt: iso() });
        n++;
      }
      db.metaSet(SEED_KEY, SEED_VERSION);
    });
    return n;
  }
  function unseedPlans() {
    const used = new Set([...db.all(SUBS).map((s) => s.planId), ...db.all(TXNS).map((t) => t.planId)]);
    const seeded = db.all(PLANS).filter((p) => p.seeded && !used.has(p.id));
    db.transaction(() => {
      db.remove(PLANS, seeded.map((p) => p.id));
      db.metaSet(SEED_KEY, 0);
    });
    return seeded.length;
  }

  const plans = () => db.all(PLANS).sort((a, b) => (a.sort || 0) - (b.sort || 0));
  const planById = (id) => find(PLANS, 'id', String(id || ''));
  const freePlan = () => plans().find((p) => p.kind === 'subscription' && p.active && p.pricePaise === 0 && !p.custom) || null;
  // What anyone may see about a plan: no internal notes or version history.
  const publicPlan = (p) => ({
    id: p.id, code: p.code, kind: p.kind, name: p.name, summary: p.summary, custom: Boolean(p.custom),
    price: p.pricePaise == null ? null : { amountPaise: p.pricePaise, currency: p.currency, display: inr(p.pricePaise), gstPercent: p.gstPercent, excludesGst: true },
    interval: p.interval, intervalLabel: INTERVALS[p.interval] || 'One time', jobLimit: p.jobLimit, seatLimit: p.seatLimit, contactUnlocks: p.kind === 'package' ? null : p.contactUnlocks === undefined ? DEFAULT_MONTHLY : p.contactUnlocks,
    credits: p.kind === 'package' ? p.credits || 0 : null, features: p.features || [],
  });

  // Checks a plan form; returns { errors, plan }.
  function parsePlan(body, existing = null) {
    const errors = [];
    const intOrNull = (k, label, max) => {
      const raw = clip(body[k], 6);
      if (raw === '') return null;
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0 || n > max) errors.push(`${label} must be a whole number from 0 to ${max}, or blank for no limit`);
      return n;
    };
    const kind = existing ? existing.kind : body.kind === 'package' ? 'package' : 'subscription';
    const custom = kind === 'subscription' && ['1', 'on', 'true'].includes(String(body.custom));
    const code = existing ? existing.code : clip(body.code, 40).toLowerCase();
    const plan = {
      kind, code, custom,
      name: clip(body.name, 80),
      summary: clip(body.summary, 200),
      currency: CURRENCY,
      pricePaise: custom ? null : paiseIn(body.price),
      interval: kind === 'package' ? null : INTERVALS[body.interval] ? body.interval : '',
      jobLimit: intOrNull('jobLimit', 'Job limit', HARD_JOB_CAP),
      seatLimit: intOrNull('seatLimit', 'Team seats', HARD_SEAT_CAP),
      contactUnlocks: kind === 'package' ? null : intOrNull('contactUnlocks', 'Candidate contacts a month', HARD_UNLOCK_CAP),
      credits: kind === 'package' ? intOrNull('credits', 'Contact credits', MAX_PACK) || 0 : 0,
      features: String(body.features || '').split('\n').map((f) => clip(f, 120)).filter(Boolean).slice(0, 12),
      gstPercent: Number(clip(body.gstPercent, 6)),
      sac: clip(body.sac, 8),
      active: ['1', 'on', 'true'].includes(String(body.active)),
      sort: Number.isInteger(Number(body.sort)) ? Number(body.sort) : existing ? existing.sort : 50,
    };
    if (!plan.name) errors.push('Enter a name');
    if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(plan.code)) errors.push('Code: 2–40 lowercase letters, numbers and dashes');
    else if (!existing && find(PLANS, 'code', plan.code)) errors.push('Another plan already uses that code');
    if (!custom && !(Number.isInteger(plan.pricePaise) && plan.pricePaise >= 0 && plan.pricePaise <= 10000000000)) errors.push('Enter the price in rupees (up to 2 decimals), without GST');
    if (kind === 'package' && plan.pricePaise === 0) errors.push('A service package needs a price');
    if (kind === 'subscription' && !plan.interval) errors.push('Choose monthly or yearly billing');
    if (!(Number.isFinite(plan.gstPercent) && plan.gstPercent >= 0 && plan.gstPercent <= 28)) errors.push('GST rate must be from 0 to 28%');
    if (plan.sac && !/^\d{4,8}$/.test(plan.sac)) errors.push('SAC must be 4–8 digits');
    return { errors, plan };
  }

  // ---------- billing profile (who the invoice is addressed to) ----------
  const profileOf = (emp) => {
    const saved = find(PROFILES, 'employerId', emp.id);
    return saved || {
      employerId: emp.id, legalName: emp.company, gstin: emp.gstin || '', address: [emp.addressLine, emp.city, emp.pincode].filter(Boolean).join(', '),
      stateName: stateName(String(emp.gstin || '').slice(0, 2)) || (stateCode(emp.state) ? emp.state : ''), contactName: '', contactEmail: '',
    };
  };
  function parseProfile(emp, body) {
    const p = {
      employerId: emp.id,
      legalName: clip(body.legalName, 160),
      gstin: clip(body.gstin, 15).toUpperCase(),
      address: clip(body.address, 400),
      stateName: clip(body.stateName, 60),
      contactName: clip(body.contactName, 120),
      contactEmail: clip(body.contactEmail, 160).toLowerCase(),
    };
    const errors = [];
    if (!p.legalName) errors.push('Enter the legal name for invoices');
    if (p.gstin && !(GSTIN_RE.test(p.gstin) && validGstin(p.gstin))) errors.push('GSTIN should be 15 characters, e.g. 29ABCDE1234F1Z5');
    if (p.stateName && !stateCode(p.stateName)) errors.push('Choose a state from the list');
    if (p.gstin && p.stateName && stateCode(p.stateName) !== p.gstin.slice(0, 2)) errors.push(`That GSTIN is registered in ${stateName(p.gstin.slice(0, 2)) || 'another state'}`);
    if (!p.stateName && p.gstin) p.stateName = stateName(p.gstin.slice(0, 2));
    if (p.contactEmail && !EMAIL_RE.test(p.contactEmail)) errors.push('Enter a valid billing email');
    return { errors, profile: p };
  }
  function seller() {
    const b = billingOf(site);
    return { name: b.legalName || site.name, address: site.address, gstin: b.gstin, pan: b.pan, stateName: b.stateName || stateName(String(b.gstin || '').slice(0, 2)), bank: b.bank, email: site.email, phone: site.phone };
  }
  // Same state as us: CGST + SGST. Another state, or unknown: IGST.
  function taxTypeFor(buyer) {
    const s = seller();
    const ours = String(s.gstin || '').slice(0, 2) || stateCode(s.stateName);
    const theirs = String(buyer.gstin || '').slice(0, 2) || stateCode(buyer.stateName);
    return ours && theirs && ours === theirs ? 'intra' : 'inter';
  }
  const buyerOf = (emp) => {
    const p = profileOf(emp);
    return { name: p.legalName || emp.company, address: p.address, gstin: p.gstin, stateName: p.stateName };
  };

  // ---------- subscriptions and limits ----------
  const subOf = (empId) => find(SUBS, 'employerId', empId);
  // The plan a company is on now: its subscription, or the free plan for
  // companies that registered themselves; null for managed clients.
  function currentPlan(emp) {
    const s = subOf(emp.id);
    if (s && s.status !== 'expired') return { sub: s, plan: planById(s.planId) || s.plan };
    if (!emp.selfSignup) return { sub: s, plan: null, managed: true };
    return { sub: s, plan: freePlan() };
  }
  // Limits are read from the plan as it is now (Admins can change them), with
  // limits agreed with this company on top.
  function limitsOf(emp) {
    const { sub, plan, managed } = currentPlan(emp);
    const o = (sub && sub.overrides) || {};
    const pick = (k, cap) => {
      const v = o[k] != null ? o[k] : plan ? (plan[k] === undefined && k === 'contactUnlocks' ? DEFAULT_MONTHLY : plan[k]) : null;
      return v == null ? cap : Math.min(v, cap);
    };
    return { jobs: pick('jobLimit', HARD_JOB_CAP), seats: pick('seatLimit', HARD_SEAT_CAP), contactUnlocks: pick('contactUnlocks', HARD_UNLOCK_CAP), planName: plan ? plan.name : managed ? 'Managed account' : 'No plan', managed: Boolean(managed) };
  }
  function changeSub(emp, sub, patch, event, by = '') {
    const before = sub ? sub.planId : null;
    const next = sub || { id: crypto.randomUUID(), employerId: emp.id, createdAt: iso(), history: [], reminders: [], version: 0 };
    Object.assign(next, patch);
    next.version = (next.version || 0) + 1;
    next.history = [{ at: iso(), event, from: before, to: next.planId, by: clip(by, 120) }, ...(next.history || [])].slice(0, 100);
    return put(SUBS, next);
  }
  const snapshot = (p) => ({ code: p.code, name: p.name, pricePaise: p.pricePaise, currency: p.currency, interval: p.interval, jobLimit: p.jobLimit, seatLimit: p.seatLimit, contactUnlocks: p.contactUnlocks, gstPercent: p.gstPercent, sac: p.sac });
  // Back to the free plan (cancelled, unpaid after the grace period, or refunded).
  function toFree(emp, sub, event, by) {
    const free = freePlan();
    return changeSub(emp, sub, {
      planId: free ? free.id : null, plan: free ? snapshot(free) : null, status: 'active', periodStart: todayIst(), periodEnd: null,
      cancelAtPeriodEnd: false, nextPlanId: null, graceEnds: null, reminders: [],
    }, event, by);
  }

  // ---------- quotes ----------
  // What a purchase costs: lines, GST and total, fixed when the order is made.
  function quote(emp, { purpose, plan, credit = null, invoice = null, from = null }) {
    const buyer = buyerOf(emp);
    const taxType = taxTypeFor(buyer);
    const today = todayIst();
    let lines = [];
    let gstPercent = 0;
    let period = null;
    if (purpose === 'plan' || purpose === 'renewal') {
      const start = from || today;
      period = { from: start, to: addDays(addInterval(start, plan.interval), -1) };
      lines.push({ text: `${plan.name} plan · ${INTERVALS[plan.interval].toLowerCase()} · ${formatYmd(period.from)} to ${formatYmd(period.to)}`, sac: plan.sac, amountPaise: plan.pricePaise });
      if (credit && credit.amountPaise > 0) lines.push({ text: `Unused time on ${credit.planName} (${credit.days} days)`, sac: plan.sac, amountPaise: -credit.amountPaise });
      gstPercent = plan.gstPercent;
    } else if (purpose === 'package') {
      lines.push({ text: `${plan.name} (service package)`, sac: plan.sac, amountPaise: plan.pricePaise });
      gstPercent = plan.gstPercent;
    } else if (purpose === 'invoice') {
      // Paying the balance of an invoice the team issued: the invoice already has its tax.
      const due = balanceOf(invoice);
      return { lines: [{ text: `Payment for invoice ${invoice.number}`, sac: '', amountPaise: due }], subtotalPaise: due, gstPercent: 0, taxType, taxLines: [], taxPaise: 0, totalPaise: due, currency: CURRENCY, buyer, period: null };
    }
    const subtotalPaise = lines.reduce((n, l) => n + l.amountPaise, 0);
    const { taxPaise, taxLines } = taxOf(subtotalPaise, gstPercent, taxType);
    return { lines, subtotalPaise, gstPercent, taxType, taxLines, taxPaise, totalPaise: subtotalPaise + taxPaise, currency: CURRENCY, buyer, period };
  }
  // Credit for the unused part of a paid period when moving up to a bigger plan.
  function unusedCredit(sub) {
    if (!sub || sub.status !== 'active' || !sub.periodEnd || !sub.plan || !(sub.plan.pricePaise > 0)) return null;
    const today = todayIst();
    const total = daysBetween(sub.periodStart, sub.periodEnd);
    const left = daysBetween(today, sub.periodEnd);
    if (total <= 0 || left <= 0) return null;
    return { amountPaise: Math.floor((sub.plan.pricePaise * left) / total), days: left, planName: sub.plan.name };
  }

  // ---------- invoices ----------
  // Same series as placement invoices: INV/2026-27/0001, numbers never reused.
  function nextNumber(prefix, date) {
    const key = `${prefix === 'INV' ? 'invoice' : 'credit'}-seq:${financialYear(date)}`;
    const n = Number(db.metaGet(key) || 0) + 1;
    db.metaSet(key, n);
    return `${prefix}/${financialYear(date)}/${String(n).padStart(4, '0')}`;
  }
  const paidOf = (inv) => (inv.payments || []).reduce((n, p) => n + p.amountPaise, 0);
  const creditedOf = (inv) => (inv.creditNotes || []).reduce((n, c) => n + c.totalPaise, 0);
  const refundedOf = (inv) => (inv.refunds || []).reduce((n, r) => n + r.amountPaise, 0);
  const balanceOf = (inv) => Math.max(0, inv.totalPaise - paidOf(inv) - creditedOf(inv) + refundedOf(inv));
  function refreshInvoice(inv) {
    if (inv.status === 'Cancelled') return inv;
    const paid = paidOf(inv);
    // Fully credited (e.g. refunded in full) reads as Credited, not Paid.
    if (balanceOf(inv) === 0) inv.status = paid > 0 && creditedOf(inv) < inv.totalPaise ? 'Paid' : 'Credited';
    else inv.status = paid > 0 || creditedOf(inv) > 0 ? 'Part paid' : 'Unpaid';
    return inv;
  }
  function issueInvoice(emp, { kind, q, transactionId = null, dueDays = 0, payment = null }) {
    const date = todayIst();
    const inv = {
      id: crypto.randomUUID(), number: nextNumber('INV', date), employerId: emp.id, kind, transactionId, date, dueDate: addDays(date, dueDays),
      period: q.period, currency: q.currency, lines: q.lines, subtotalPaise: q.subtotalPaise, gstPercent: q.gstPercent, taxType: q.taxType,
      taxLines: q.taxLines, taxPaise: q.taxPaise, totalPaise: q.totalPaise, seller: seller(), buyer: q.buyer,
      payments: payment ? [payment] : [], creditNotes: [], refunds: [], status: 'Unpaid', createdAt: iso(),
    };
    refreshInvoice(inv);
    db.prepend(INVOICES, inv);
    return inv;
  }
  const invoicesOf = (empId) => db.where(INVOICES, 'employerId', empId);

  return {
    PLANS, SUBS, TXNS, INVOICES, REFUNDS, EVENTS, PROFILES, settings, saveSettings, seedPlans, unseedPlans, plans, planById, freePlan, publicPlan, parsePlan,
    profileOf, parseProfile, seller, taxTypeFor, buyerOf, subOf, currentPlan, limitsOf, changeSub, snapshot, toFree, quote, unusedCredit, nextNumber,
    balanceOf, paidOf, creditedOf, refundedOf, refreshInvoice, issueInvoice, invoicesOf, find, put, add, gateway,
  };
}

module.exports = {
  create, defaultPlans, addInterval, addDays, daysBetween, taxOf, paiseIn, inr, rupees, perMonth, todayIst, stateCode, stateName,
  STATES, INTERVALS, TXN_STATUSES, SETTLED, REFUND_REASONS, OFFLINE_MODES, HARD_JOB_CAP, HARD_SEAT_CAP, HARD_UNLOCK_CAP, SEED_VERSION, CURRENCY, amountInWords, employerCan, agencyRoles,
};
