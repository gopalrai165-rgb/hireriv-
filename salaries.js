// Salary pages: what jobs on Hireriv pay for a role, across India and by
// city, worked out from the pay employers put on real listings (never the
// sample jobs) posted in the last 12 months, open or closed. Every pay is
// turned into a month (a day is 26 working days, an hour 208), each listing
// counts once at the middle of its range, and figures are shown only when
// enough listings share them, so one listing can't be read as "the salary".
const PER_MONTH = { month: 1, year: 1 / 12, day: 26, hour: 208 };
const MIN_LISTINGS = 3;
const WINDOW_DAYS = 365;

// A listing's pay as a monthly range, or null when it has none.
function monthly(job) {
  const p = job && job.pay;
  if (!p || !(p.min || p.max)) return null;
  const k = PER_MONTH[p.period] || 1;
  const min = (p.min || p.max) * k;
  const max = (p.max || p.min) * k;
  return { min, max, mid: (min + max) / 2 };
}

// Rounded to ₹500 so the figures don't look more exact than they are.
const round = (n) => Math.round(n / 500) * 500;
function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// The figures for a set of listings, or { count, enough: false } when too few have pay.
function summarise(jobs) {
  const pays = jobs.map(monthly).filter(Boolean);
  if (pays.length < MIN_LISTINGS) return { count: pays.length, enough: false };
  const mids = pays.map((p) => p.mid).sort((a, b) => a - b);
  return {
    count: pays.length, enough: true,
    median: round(quantile(mids, 0.5)),
    typicalLow: round(quantile(mids, 0.25)),
    typicalHigh: round(quantile(mids, 0.75)),
    lowest: round(Math.min(...pays.map((p) => p.min))),
    highest: round(Math.max(...pays.map((p) => p.max))),
  };
}

// Listings that count: real, published, posted in the window, with pay.
function pool(jobs, { isSample, isPublic, today }) {
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
  return jobs.filter((j) => isPublic(j) && !isSample(j) && monthly(j) && String(j.posted || '') >= from);
}

// One role: India, each city with enough listings (highest first) and freshers.
function forRole(list, { cities, fresher }) {
  const india = summarise(list);
  const byCity = cities
    .map((c) => ({ city: c, ...summarise(list.filter((j) => c.locations.includes(j.location))) }))
    .filter((x) => x.enough)
    .sort((a, b) => b.median - a.median || a.city.name.localeCompare(b.city.name));
  const freshers = summarise(list.filter(fresher));
  return { india, byCity, freshers };
}

const inr = (n) => `₹${Math.round(n).toLocaleString('en-IN')}`;

module.exports = { monthly, summarise, pool, forRole, inr, MIN_LISTINGS, WINDOW_DAYS };
