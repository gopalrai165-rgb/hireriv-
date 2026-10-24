// The applicant tracking rules: hiring stages and the moves allowed between
// them, offers (approval and the candidate's answer kept apart), internal
// notes, interview scheduling rules, hiring metrics, and a notification ledger
// so a retried request never emails twice. No routes here: see employer-ats.js.
//
// Stages are stored with the names the rest of the app already uses ("New",
// "Offered"); LABELS gives the names people see ("Applied", "Offer").
const crypto = require('crypto');

const PIPELINE = ['New', 'Screening', 'Shortlisted', 'Interview', 'Offered', 'Hired'];
const OUTCOMES = ['On hold', 'Rejected'];
const STAGES = [...PIPELINE, ...OUTCOMES];
const LABELS = { New: 'Applied', Offered: 'Offer' };
const label = (s) => LABELS[s] || s;
const CLOSED = ['Hired', 'Rejected'];

// The workflow: where an application can go from each stage. Anything else is
// a correction, which only a company owner can make, with a reason.
const NEXT = {
  New: ['Screening', 'Shortlisted', 'On hold', 'Rejected'],
  Screening: ['Shortlisted', 'On hold', 'Rejected'],
  Shortlisted: ['Interview', 'Screening', 'On hold', 'Rejected'],
  Interview: ['Offered', 'Shortlisted', 'On hold', 'Rejected'],
  Offered: ['Hired', 'On hold', 'Rejected'],
  'On hold': ['Screening', 'Shortlisted', 'Interview', 'Offered', 'Rejected'],
  Hired: [],
  Rejected: [],
};

const stageOf = (a) => (a.withdrawnAt ? 'Withdrawn' : a.status || 'New');
const liveOffers = (a) => (a.offers || []).filter((o) => !o.withdrawnAt);
const approvedOffer = (a) => liveOffers(a).find((o) => o.approval.status === 'approved') || null;
const acceptedOffer = (a) => liveOffers(a).find((o) => o.approval.status === 'approved' && o.response.status === 'accepted') || null;

// Why `a` can't move to `to` in the normal workflow ('' when it can).
function moveProblem(a, to) {
  if (!STAGES.includes(to)) return `stage must be one of: ${STAGES.join(', ')}`;
  if (a.withdrawnAt) return 'the candidate withdrew this application';
  const from = a.status || 'New';
  if (from === to) return '';
  if (!(NEXT[from] || []).includes(to)) return `an application can't move from ${label(from)} to ${label(to)}${CLOSED.includes(from) ? ' (a company owner can correct it)' : ''}`;
  if (to === 'Offered' && !approvedOffer(a)) return 'create an offer and get it approved first';
  if (to === 'Hired' && !acceptedOffer(a)) return "record the candidate accepting the offer first";
  return '';
}
const allowedMoves = (a) => (a.withdrawnAt ? [] : (NEXT[a.status || 'New'] || []).filter((to) => !moveProblem(a, to)));

// Records the move in the application's history (append-only: corrections are
// new entries, nothing is removed). Returns false when it was already there.
function recordMove(moveStage, a, to, actor, { correction = false, reason = '' } = {}) {
  if (!moveStage(a, to, actor.label)) return false;
  const h = a.history[a.history.length - 1];
  Object.assign(h, { actor: actor.kind, ...(actor.userId ? { userId: actor.userId } : {}), ...(correction ? { correction: true, reason } : {}) });
  return true;
}

// ---------- notes ----------
const MAX_NOTES = 200;
function addNote(a, user, text) {
  const t = String(text ?? '').trim().slice(0, 2000);
  if (!t) return { error: 'write a note first' };
  const note = { id: crypto.randomUUID(), at: new Date().toISOString(), userId: user.id, by: user.name, text: t };
  a.atsNotes = [...(a.atsNotes || []), note].slice(-MAX_NOTES);
  return { note };
}

// ---------- offers ----------
const PAY_PERIODS = ['month', 'year'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function parseOffer(body, today) {
  const get = (k, max = 300) => String(body[k] ?? '').trim().slice(0, max);
  const errors = [];
  const amount = get('salary', 12).replace(/[,\s₹]/g, '');
  const offer = { title: get('title', 120), salary: null, joiningDate: get('joiningDate', 10), respondBy: get('respondBy', 10), notes: get('notes', 1000) };
  if (amount) {
    if (!/^\d{1,10}$/.test(amount) || Number(amount) < 1) errors.push('salary must be a whole number of rupees');
    else offer.salary = { amount: Number(amount), period: PAY_PERIODS.includes(get('salaryPeriod', 10)) ? get('salaryPeriod', 10) : 'month', currency: 'INR' };
  }
  for (const [k, name] of [['joiningDate', 'joining date'], ['respondBy', 'respond-by date']]) {
    if (offer[k] && (!DATE_RE.test(offer[k]) || Number.isNaN(Date.parse(offer[k])))) errors.push(`${name} is invalid`);
    else if (offer[k] && offer[k] < today) errors.push(`${name} is in the past`);
  }
  return { offer, errors };
}
function createOffer(a, fields, user) {
  if (a.withdrawnAt) return { error: 'the candidate withdrew this application' };
  if (!['Interview', 'Offered', 'On hold'].includes(a.status)) return { error: 'make an offer after the interview stage' };
  if (liveOffers(a).some((o) => o.response.status === 'awaiting')) return { error: 'this candidate already has an offer waiting for an answer: withdraw it first' };
  const offer = {
    id: crypto.randomUUID(), createdAt: new Date().toISOString(), createdBy: user.name, createdByUserId: user.id, ...fields,
    approval: { status: 'pending', by: null, userId: null, at: null, note: '' },
    response: { status: 'awaiting', at: null, recordedBy: null, note: '' },
  };
  a.offers = [...(a.offers || []), offer];
  return { offer };
}
const findOffer = (a, id) => (a.offers || []).find((o) => o.id === id) || null;
// Approval is separate from creating the offer: an owner may approve their own,
// anyone else's offer needs someone other than the person who made it.
function decideOffer(o, user, isOwner, approve, note) {
  if (o.withdrawnAt) return 'this offer was withdrawn';
  if (o.approval.status !== 'pending') return `this offer was already ${o.approval.status}`;
  if (o.createdByUserId === user.id && !isOwner) return 'someone else (or a company owner) must approve an offer you made';
  o.approval = { status: approve ? 'approved' : 'rejected', by: user.name, userId: user.id, at: new Date().toISOString(), note: String(note ?? '').trim().slice(0, 500) };
  return '';
}
const RESPONSES = ['accepted', 'declined'];
function recordResponse(o, user, response, note) {
  if (o.withdrawnAt) return 'this offer was withdrawn';
  if (o.approval.status !== 'approved') return 'the offer must be approved before the candidate can answer it';
  if (!RESPONSES.includes(response)) return 'response must be accepted or declined';
  if (o.response.status !== 'awaiting') return `the candidate already ${o.response.status} this offer`;
  o.response = { status: response, at: new Date().toISOString(), recordedBy: user.name, note: String(note ?? '').trim().slice(0, 500) };
  return '';
}
function withdrawOffer(o, user) {
  if (o.withdrawnAt) return 'this offer was already withdrawn';
  if (o.response.status === 'accepted') return 'the candidate accepted this offer';
  Object.assign(o, { withdrawnAt: new Date().toISOString(), withdrawnBy: user.name });
  return '';
}

// ---------- interview scheduling rules ----------
// At least two hours ahead, between 7 am and 9 pm India time, and no clash with
// the candidate's other interviews or the interviewer's (by email) in this list.
const MIN_LEAD_MS = 2 * 3600000;
const istHour = (d) => Number(d.toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false }));
function scheduleProblem(apps, a, at, duration, interviewerEmail, now = Date.now()) {
  const start = at.getTime();
  const end = start + duration * 60000;
  if (start < now + MIN_LEAD_MS) return 'book interviews at least 2 hours ahead';
  const endsAt = new Date(end - 1);
  if (istHour(at) < 7 || istHour(endsAt) >= 21) return 'interviews must be between 7 am and 9 pm India time';
  const overlaps = (iv) => iv.status === 'scheduled' && Date.parse(iv.at) < end && Date.parse(iv.at) + iv.duration * 60000 > start;
  if ((a.interviews || []).some(overlaps)) return 'the candidate already has an interview at that time';
  const who = String(interviewerEmail || '').toLowerCase();
  if (who && apps.some((x) => (x.interviews || []).some((iv) => overlaps(iv) && String(iv.interviewerEmail || '').toLowerCase() === who))) return 'the interviewer already has an interview at that time';
  return '';
}

// ---------- metrics ----------
// Definitions (the same everywhere):
// - counted: applications to the given jobs, not duplicates, on real (not sample) jobs;
// - reached a stage: the application is there now or its history shows it got there
//   or past it (On hold and Rejected don't count as progress);
// - time to hire: days from applying to the move to Hired; time to fill: days from
//   the job going live to its first hire. Medians, in days, one decimal.
const DAY = 86400000;
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return Math.round((s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) * 10) / 10;
};
function furthest(a) {
  const seen = [a.status || 'New', ...(a.history || []).flatMap((h) => [h.from, h.to])];
  if ((a.interviews || []).length) seen.push('Interview');
  if ((a.offers || []).some((o) => o.approval.status === 'approved')) seen.push('Offered');
  return Math.max(0, ...seen.map((s) => PIPELINE.indexOf(s)));
}
const hiredAt = (a) => ((a.status === 'Hired' && [...(a.history || [])].reverse().find((h) => h.to === 'Hired')) || {}).at || null;

function metrics(applications, jobs, { now = Date.now(), since = null, members = [] } = {}) {
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  const apps = applications.filter((a) => jobById.has(a.jobId) && !a.duplicateOf && !(jobById.get(a.jobId).sample === true) && (!since || a.createdAt >= since));
  const live = apps.filter((a) => !a.withdrawnAt);
  const count = (stage) => live.filter((a) => (a.status || 'New') === stage).length;
  const upcoming = apps.flatMap((a) => (a.interviews || []).filter((iv) => iv.status === 'scheduled' && Date.parse(iv.at) + iv.duration * 60000 > now));
  const reached = PIPELINE.map((stage, i) => ({ stage, label: label(stage), count: apps.filter((a) => furthest(a) >= i).length }));
  const funnel = reached.map((r, i) => {
    const next = reached[i + 1];
    const conversion = next && r.count ? Math.round((next.count / r.count) * 1000) / 10 : null;
    return { ...r, conversion, dropOff: conversion === null ? null : Math.round((100 - conversion) * 10) / 10 };
  });
  const hireDays = apps.map((a) => (hiredAt(a) ? (Date.parse(hiredAt(a)) - Date.parse(a.createdAt)) / DAY : null)).filter((d) => d !== null && d >= 0);
  const fillDays = jobs.map((j) => {
    const hires = apps.filter((a) => a.jobId === j.id && hiredAt(a)).map((a) => Date.parse(hiredAt(a)));
    const opened = Date.parse(j.approvedAt || j.posted);
    return hires.length && opened ? (Math.min(...hires) - opened) / DAY : null;
  }).filter((d) => d !== null && d >= 0);
  const perJob = jobs.filter((j) => j.sample !== true).map((j) => {
    const mine = apps.filter((a) => a.jobId === j.id);
    return { jobId: j.id, title: j.title, status: j.status, openings: j.openings || null, applications: mine.length, active: mine.filter((a) => !a.withdrawnAt && !CLOSED.includes(a.status)).length, hired: mine.filter((a) => a.status === 'Hired').length };
  });
  const workload = members.map((m) => {
    const mine = apps.filter((a) => a.assignedTo === m.userId);
    return { userId: m.userId, name: m.name, role: m.role, open: mine.filter((a) => !a.withdrawnAt && !CLOSED.includes(a.status)).length, hired: mine.filter((a) => a.status === 'Hired').length, rejected: mine.filter((a) => a.status === 'Rejected').length, interviews: upcoming.filter((iv) => mine.some((a) => (a.interviews || []).includes(iv))).length };
  });
  return {
    activeVacancies: jobs.filter((j) => j.status === 'open' && j.sample !== true).length,
    applications: apps.length,
    newApplications: count('New'),
    awaitingReview: count('New') + count('Screening'),
    shortlisted: count('Shortlisted'),
    interviewsScheduled: upcoming.length,
    offersIssued: apps.reduce((n, a) => n + (a.offers || []).filter((o) => o.approval.status === 'approved' && !o.withdrawnAt).length, 0),
    hires: count('Hired'),
    onHold: count('On hold'),
    rejected: count('Rejected'),
    withdrawn: apps.filter((a) => a.withdrawnAt).length,
    funnel,
    timeToHireDays: median(hireDays),
    timeToFillDays: median(fillDays),
    perJob,
    workload,
  };
}

// ---------- notification ledger ----------
// Each notification has a key (e.g. "interview-invite:<id>"). Sending the same
// key again does nothing, so a retried request can't email twice. The ledger
// keeps who it was for (candidate, team or employer), the template and whether
// it was delivered; never the message itself.
function notifier({ readSubmissions, writeSubmissions, saveSubmission }) {
  const KEY = 'notifications';
  const update = (id, patch) => {
    const list = readSubmissions(KEY);
    const n = list.find((x) => x.id === id);
    if (n) { Object.assign(n, patch); writeSubmissions(KEY, list); }
  };
  function once(key, meta, sendFn) {
    if (readSubmissions(KEY).some((n) => n.key === key)) return false;
    const n = saveSubmission(KEY, { key, ...meta, channel: 'email', status: 'queued' });
    Promise.resolve()
      .then(sendFn)
      .then((ok) => update(n.id, { status: ok === false ? 'failed' : 'sent', doneAt: new Date().toISOString() }))
      .catch(() => update(n.id, { status: 'failed', doneAt: new Date().toISOString() }));
    return true;
  }
  // Deliveries older than a year are dropped.
  function prune() {
    const cutoff = new Date(Date.now() - 365 * DAY).toISOString();
    const list = readSubmissions(KEY);
    const keep = list.filter((n) => n.createdAt >= cutoff);
    if (keep.length !== list.length) writeSubmissions(KEY, keep);
  }
  return { once, prune, list: () => readSubmissions(KEY) };
}

module.exports = {
  PIPELINE, OUTCOMES, STAGES, LABELS, NEXT, CLOSED, RESPONSES, label, stageOf, moveProblem, allowedMoves, recordMove,
  addNote, parseOffer, createOffer, findOffer, decideOffer, recordResponse, withdrawOffer, approvedOffer, acceptedOffer, liveOffers,
  scheduleProblem, metrics, median, notifier,
};
