// Contact credits (Step 85): verified employers can see the mobile number of
// a job seeker who agreed to it, so they can call or WhatsApp them.
//
// - Only candidates who let verified employers find them AND switched on
//   "Show my mobile number to verified employers who unlock my profile" can be
//   unlocked (employer-discovery.js). Switching either off hides the number
//   again straight away, even from companies that unlocked it before.
// - Each plan includes some free unlocks a month (contactUnlocks on the plan,
//   set by Admins; blank means up to HARD_UNLOCK_CAP). After those, an unlock
//   uses one contact credit. Credits come in packs, bought through the usual
//   checkout as a package with `credits` set (billing-routes.js fulfil()), and
//   never expire. A full refund of a pack takes back the credits not yet used.
// - Unlocking the same person again costs nothing. Every unlock is kept
//   (contact-unlocks) with who did it, recorded in the company's activity log,
//   and the job seeker is told which company saw their number.
// - The balance is a ledger (contact-credit-ledger): +N for a pack or a grant
//   by the team, -1 per unlock beyond the month's free ones, -N on a refund.
const crypto = require('crypto');

const UNLOCKS = 'contact-unlocks';
const LEDGER = 'contact-credit-ledger';
const HARD_UNLOCK_CAP = 500;
// Plans saved before contact unlocks existed.
const DEFAULT_MONTHLY = 5;
const MAX_PACK = 10000;

const iso = () => new Date().toISOString();
// The month in India, as YYYY-MM.
const monthIst = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }).slice(0, 7);

function create({ db, store }) {
  const ledgerOf = (employerId) => db.where(LEDGER, 'employerId', employerId);
  const unlocksOf = (employerId) => db.where(UNLOCKS, 'employerId', employerId);
  const balance = (employerId) => Math.max(0, ledgerOf(employerId).reduce((n, e) => n + e.delta, 0));
  const monthly = (emp) => store.limitsOf(emp).contactUnlocks;

  // What a company has this month.
  function status(emp) {
    const month = monthIst();
    const free = monthly(emp);
    const used = unlocksOf(emp.id).filter((u) => u.month === month && u.source === 'plan').length;
    return { month, free, used, freeLeft: Math.max(0, free - used), credits: balance(emp.id) };
  }
  const unlockedIds = (employerId) => new Set(unlocksOf(employerId).map((u) => u.candidateId));

  // Uses a free unlock, else a credit. One record per company and candidate.
  function unlock(emp, user, candidateId) {
    return db.transaction(() => {
      const had = unlocksOf(emp.id).find((u) => u.candidateId === candidateId);
      if (had) return { existed: true, unlock: had };
      const s = status(emp);
      let source;
      if (s.freeLeft > 0) source = 'plan';
      else if (s.credits > 0) source = 'credit';
      else return { error: s.free ? `you have used this month's ${s.free} free unlocks and have no contact credits left` : 'your plan has no free unlocks and you have no contact credits', status: 402 };
      const u = { id: crypto.randomUUID(), employerId: emp.id, company: emp.company, candidateId, by: user ? user.id : null, source, month: s.month, createdAt: iso() };
      db.prepend(UNLOCKS, u);
      if (source === 'credit') db.prepend(LEDGER, { id: crypto.randomUUID(), employerId: emp.id, delta: -1, reason: 'unlock', unlockId: u.id, createdAt: iso() });
      return { unlock: u, source };
    });
  }

  // Credits from a paid pack (once per payment) or given by the team.
  function grant(employerId, credits, { reason, transactionId = null, by = '' }) {
    const n = Number(credits);
    if (!Number.isInteger(n) || n < 1 || n > MAX_PACK) return null;
    if (transactionId && ledgerOf(employerId).some((e) => e.transactionId === transactionId && e.delta > 0)) return null;
    const e = { id: crypto.randomUUID(), employerId, delta: n, reason, transactionId, by, createdAt: iso() };
    db.prepend(LEDGER, e);
    return e;
  }
  // A refunded pack: its credits not yet used come back off the balance.
  function revoke(employerId, transactionId, by = '') {
    const given = ledgerOf(employerId).filter((e) => e.transactionId === transactionId && e.delta > 0).reduce((n, e) => n + e.delta, 0);
    const taken = ledgerOf(employerId).filter((e) => e.transactionId === transactionId && e.delta < 0).reduce((n, e) => n - e.delta, 0);
    const n = Math.min(given - taken, balance(employerId));
    if (n <= 0) return 0;
    db.prepend(LEDGER, { id: crypto.randomUUID(), employerId, delta: -n, reason: 'refund', transactionId, by, createdAt: iso() });
    return n;
  }

  // Companies that saw a candidate's number, for their own data export.
  const unlocksOfCandidate = (candidateId) => db.all(UNLOCKS).filter((u) => u.candidateId === candidateId);

  return { status, unlock, unlockedIds, unlocksOf, unlocksOfCandidate, grant, revoke, balance, ledgerOf };
}

module.exports = { create, monthIst, UNLOCKS, LEDGER, HARD_UNLOCK_CAP, DEFAULT_MONTHLY, MAX_PACK };
