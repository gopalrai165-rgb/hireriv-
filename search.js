// Job search: structured pay, experience levels, city → state, keyword
// relevance, filters and stable sorting. Used by the Find Jobs page and the
// public JSON API, so both always return the same results.
const { parseSalary } = require('./seo');

// ---------- pay ----------
// Pay is stored as numbers: { min, max, period, currency }. Either bound may be
// missing (e.g. "from ₹15,000 a month"); no pay object means not disclosed.
const PAY_PERIODS = ['month', 'year', 'day', 'hour'];
const PERIOD_WORDS = { month: 'a month', year: 'a year', day: 'a day', hour: 'an hour' };
// To compare pay across periods: 26 working days a month, 8 hours a day.
const PER_MONTH = { month: 1, year: 1 / 12, day: 26, hour: 208 };

const inr = (n) => Math.round(n).toLocaleString('en-IN');
const lakhs = (n) => `${Number((n / 100000).toFixed(2))}`;

// "₹18,000 – 24,000 a month", "₹14 – 20 LPA", "From ₹800 a day".
function payText(pay) {
  if (!pay || !(pay.min || pay.max)) return '';
  const { min, max, period } = pay;
  if (period === 'year' && (min || max) >= 100000) {
    if (min && max && min !== max) return `₹${lakhs(min)} – ${lakhs(max)} LPA`;
    return `${min && !max ? 'From ' : !min ? 'Up to ' : ''}₹${lakhs(min || max)} LPA`;
  }
  const words = PERIOD_WORDS[period] || '';
  if (min && max && min !== max) return `₹${inr(min)} – ${inr(max)} ${words}`;
  return `${min && !max ? 'From ' : !min ? 'Up to ' : ''}₹${inr(min || max)} ${words}`;
}

// Validates the job form's pay fields. Returns { pay, errors }.
function parsePayFields({ salaryMin, salaryMax, salaryPeriod }) {
  const num = (v) => {
    const s = String(v ?? '').replace(/[,₹\s]/g, '');
    return s === '' ? null : Number(s);
  };
  const min = num(salaryMin);
  const max = num(salaryMax);
  const errors = [];
  for (const [label, v] of [['minimum pay', min], ['maximum pay', max]]) {
    if (v !== null && (!Number.isFinite(v) || v <= 0 || v > 1e9)) errors.push(`${label} must be a positive number`);
  }
  if (errors.length) return { pay: null, errors };
  if (min === null && max === null) return { pay: null, errors };
  if (!PAY_PERIODS.includes(salaryPeriod)) errors.push('choose whether the pay is per month, year, day or hour');
  if (min !== null && max !== null && min > max) errors.push('minimum pay cannot be more than the maximum');
  return { pay: errors.length ? null : { min: min || null, max: max || null, period: salaryPeriod, currency: 'INR' }, errors };
}

// Older jobs only have salary text: read numbers out of it where we can.
function payFromText(text) {
  const s = parseSalary(text);
  return s ? { min: s.min, max: s.max, period: s.unit.toLowerCase(), currency: 'INR' } : null;
}

const payOf = (job) => job.pay || null;
// Highest monthly pay the job offers, for filtering and sorting.
function monthlyMax(job) {
  const pay = payOf(job);
  if (!pay) return null;
  return (pay.max || pay.min) * (PER_MONTH[pay.period] || 1);
}

// ---------- experience ----------
const EXPERIENCE_LEVELS = [
  { key: 'fresher', label: 'Fresher (no experience)', min: 0, max: 0 },
  { key: 'entry', label: 'Entry level (0–2 years)', min: 0, max: 2 },
  { key: 'mid', label: 'Mid level (3–7 years)', min: 3, max: 7 },
  { key: 'senior', label: 'Senior (8+ years)', min: 8, max: 99 },
];
// "3-5 years" → [3, 5]; "Freshers welcome" → [0, 0]; "10+ years" → [10, 99].
function experienceRange(text) {
  const s = String(text || '').toLowerCase();
  if (!s) return null;
  if (/fresher|no experience/.test(s) && !/\d/.test(s)) return [0, 0];
  const nums = (s.match(/\d+(?:\.\d+)?/g) || []).map(Number);
  if (!nums.length) return /fresher/.test(s) ? [0, 0] : null;
  if (/\+|plus|above|more than/.test(s) && nums.length === 1) return [nums[0], 99];
  return [nums[0], nums[1] ?? nums[0]];
}
// A job fits a level when its experience range overlaps the level's. Jobs that
// don't say what experience they need fit every level.
function fitsLevel(job, key) {
  const level = EXPERIENCE_LEVELS.find((l) => l.key === key);
  const range = experienceRange(job.experience);
  if (!level || !range) return true;
  return range[0] <= level.max && range[1] >= level.min;
}

// ---------- location ----------
const CITY_STATE = {
  Bengaluru: 'Karnataka', Mysuru: 'Karnataka', Mangaluru: 'Karnataka',
  Mumbai: 'Maharashtra', 'Navi Mumbai': 'Maharashtra', Thane: 'Maharashtra', Pune: 'Maharashtra', Nagpur: 'Maharashtra', Nashik: 'Maharashtra',
  Delhi: 'Delhi', 'Delhi NCR': 'Delhi', Gurugram: 'Haryana', Faridabad: 'Haryana', Noida: 'Uttar Pradesh', Ghaziabad: 'Uttar Pradesh', Lucknow: 'Uttar Pradesh',
  Hyderabad: 'Telangana', Chennai: 'Tamil Nadu', Coimbatore: 'Tamil Nadu', Kolkata: 'West Bengal',
  Ahmedabad: 'Gujarat', Surat: 'Gujarat', Vadodara: 'Gujarat', Jaipur: 'Rajasthan', Chandigarh: 'Chandigarh',
  Kochi: 'Kerala', Thiruvananthapuram: 'Kerala', Indore: 'Madhya Pradesh', Bhopal: 'Madhya Pradesh', Bhubaneswar: 'Odisha',
  Visakhapatnam: 'Andhra Pradesh', Guwahati: 'Assam', Patna: 'Bihar', Goa: 'Goa',
};
const stateOf = (city) => CITY_STATE[city] || '';
// The states of these cities, for the location filter.
const statesOf = (cities) => [...new Set(cities.map(stateOf).filter(Boolean))].sort();
// `location` is a city, a state, or "Remote".
function inLocation(job, location) {
  if (!location) return true;
  if (location === 'Remote') return job.mode === 'Remote' || job.location === 'Remote';
  return job.location === location || stateOf(job.location) === location;
}

// ---------- keyword ----------
const words = (s) => String(s || '').toLowerCase().split(/[^\p{L}\p{N}+#.]+/u).filter((w) => w.length > 1 || /\d/.test(w));
// Every word must appear somewhere; title matches count most, then skills,
// company and category, then the description.
function relevance(job, terms) {
  if (!terms.length) return 1;
  const fields = [
    [job.title, 6], [(job.skills || []).join(' '), 4], [job.company, 2], [job.category, 2],
    [[job.description, ...(job.responsibilities || []), ...(job.qualifications || [])].join(' '), 1],
  ].map(([text, weight]) => [String(text || '').toLowerCase(), weight]);
  let score = 0;
  for (const t of terms) {
    let best = 0;
    for (const [text, weight] of fields) if (text.includes(t)) best = Math.max(best, weight);
    if (!best) return 0;
    score += best;
  }
  return score;
}

// ---------- the search ----------
const SORTS = ['relevance', 'newest', 'salary'];
const MIN_PAY_OPTIONS = [10000, 15000, 20000, 30000, 50000, 100000, 200000];

// Filters: q, location, categories[], type, mode, work, group, experience,
// minPay (₹ a month), sort. `extra(job)` adds caller-specific rules.
function searchJobs(list, f, { extra = () => true } = {}) {
  const terms = [...new Set(words(f.q))].slice(0, 12);
  const cats = new Set(f.categories || []);
  const scored = [];
  for (const job of list) {
    if (cats.size && !cats.has(job.category)) continue;
    if (f.type && job.type !== f.type) continue;
    if (f.mode && job.mode !== f.mode) continue;
    if (!inLocation(job, f.location)) continue;
    if (f.experience && !fitsLevel(job, f.experience)) continue;
    if (f.minPay && !(monthlyMax(job) >= f.minPay)) continue;
    if (!extra(job)) continue;
    const score = relevance(job, terms);
    if (!score) continue;
    scored.push({ job, score });
  }
  const sort = SORTS.includes(f.sort) ? f.sort : terms.length ? 'relevance' : 'newest';
  // Newest first, then by id, so equal jobs never swap places between pages.
  const newest = (a, b) => String(b.job.posted || '').localeCompare(String(a.job.posted || '')) || String(b.job.id).localeCompare(String(a.job.id), undefined, { numeric: true });
  const byPay = (a, b) => (monthlyMax(b.job) ?? -1) - (monthlyMax(a.job) ?? -1);
  scored.sort(sort === 'relevance' ? (a, b) => b.score - a.score || newest(a, b) : sort === 'salary' ? (a, b) => byPay(a, b) || newest(a, b) : newest);
  return { jobs: scored.map((x) => x.job), sort };
}

module.exports = {
  PAY_PERIODS, payText, parsePayFields, payFromText, payOf, monthlyMax,
  EXPERIENCE_LEVELS, experienceRange, fitsLevel,
  CITY_STATE, stateOf, statesOf, inLocation,
  SORTS, MIN_PAY_OPTIONS, relevance, searchJobs, words,
};
