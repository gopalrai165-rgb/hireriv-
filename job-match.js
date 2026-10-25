// Explainable candidate ↔ job matching. A rules-based score from five factors
// (skills, experience, location and work arrangement, pay, job type and shift),
// each shown to the person with what matched and what didn't. The score is a
// relevance estimate for sorting and suggestions, not a prediction of being
// hired, and nothing is ever rejected because of it.
//
// Only what the candidate told us about their work is used: skills,
// certifications, experience, where and how they want to work, expected pay,
// job types, shifts and when they can start. Never name, gender, age, date of
// birth, religion, caste, marital status, disability, photo or anything that
// stands in for them. Missing information counts as unknown: that factor is
// left out of the score instead of counting against the person.
const { norm } = require('./match');
const search = require('./search');

const MATCH_VERSION = 1;
const FACTORS = [
  { key: 'skills', label: 'Skills' },
  { key: 'experience', label: 'Experience' },
  { key: 'location', label: 'Location and work arrangement' },
  { key: 'salary', label: 'Pay' },
  { key: 'jobType', label: 'Job type and shift' },
];
const DEFAULT_WEIGHTS = { skills: 40, experience: 20, location: 15, salary: 15, jobType: 10 };
// Below this much of the total weight known, there's too little to score.
const MIN_BASIS = 30;
const LEVELS = [
  { min: 70, key: 'strong', label: 'Strong match' },
  { min: 45, key: 'good', label: 'Good match' },
  { min: 0, key: 'partial', label: 'Partial match' },
];
const NOTE = 'A relevance estimate from the details given, not a prediction of being hired. People always make the decisions.';

// Weights from the settings form or JSON: whole numbers 0–100 adding up to 100.
function parseWeights(input) {
  const weights = {};
  const errors = [];
  for (const f of FACTORS) {
    const raw = String(input[f.key] ?? '').trim();
    const n = Number(raw);
    if (!/^\d{1,3}$/.test(raw) || n > 100) errors.push(`${f.label} weight must be a whole number from 0 to 100`);
    weights[f.key] = Number.isFinite(n) ? n : 0;
  }
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  if (!errors.length && total !== 100) errors.push(`matching weights must add up to 100 (they add up to ${total})`);
  return { weights, errors };
}
const weightsOf = (site) => {
  const w = site && site.matchWeights;
  return w && FACTORS.every((f) => Number.isInteger(w[f.key])) ? w : DEFAULT_WEIGHTS;
};

// ---------- the candidate's side ----------
const LEVEL_YEARS = { Fresher: [0, 0], '0-1 years': [0, 1], '1-3 years': [1, 3], '3-5 years': [3, 5], '5-10 years': [5, 10], '10+ years': [10, 45] };
const monthsBetween = (from, to) => {
  const [y1, m1] = from.split('-').map(Number);
  const [y2, m2] = to.split('-').map(Number);
  return Math.max(0, (y2 - y1) * 12 + (m2 - m1) + 1);
};
const thisMonth = () => new Date().toISOString().slice(0, 7);

// Years of experience as a range: the level they picked, else the jobs they
// listed, else what an application said ("3-5 years").
function yearsOf(profile, fallbackText = '') {
  if (LEVEL_YEARS[profile.experienceLevel]) return LEVEL_YEARS[profile.experienceLevel];
  const dated = (profile.experiences || []).filter((e) => /^\d{4}-\d{2}$/.test(e.from));
  if (dated.length) {
    const months = dated.reduce((n, e) => n + monthsBetween(e.from, e.current || !e.to ? thisMonth() : e.to), 0);
    const y = Math.round((months / 12) * 10) / 10;
    return [y, y];
  }
  return search.experienceRange(fallbackText);
}

// Everything matching needs, from a candidate record (`profile` as stored) and
// optional extras: resume skills and application details for people whose
// profile is still thin.
function facts(profile = {}, extra = {}) {
  const p = profile || {};
  const prefs = p.preferences || {};
  const salary = p.salary || {};
  const availability = p.availability || {};
  const expected = salary.expected ? (salary.period === 'year' ? salary.expected / 12 : salary.expected) : null;
  const skills = [...(p.skills || []), ...String(extra.skills || '').split(',').map((s) => s.trim()), ...(extra.resumeSkills || [])].filter(Boolean);
  return {
    skills: [...new Map(skills.map((s) => [s.toLowerCase(), s])).values()],
    certifications: (p.certifications || []).map((c) => c.name).filter(Boolean),
    years: yearsOf(p, extra.experience),
    city: p.city || String(extra.location || '').split(',')[0].trim(),
    state: p.state || '',
    locations: prefs.locations || [],
    arrangements: prefs.arrangements || [],
    types: prefs.types || [],
    shifts: prefs.shifts || [],
    categories: prefs.categories || [],
    roles: prefs.roles || '',
    relocate: Boolean(prefs.relocate),
    expectedMonthly: expected,
    noticePeriod: availability.noticePeriod || extra.noticePeriod || '',
    availableFrom: availability.availableFrom || '',
  };
}

// ---------- the factors ----------
// Each returns null (unknown) or { score 0–1, detail }.
const has = (text, item) => text.includes(norm(item));

function skillsFactor(f, job) {
  const wanted = (job.skills || []).filter(Boolean);
  if (!wanted.length) return null;
  const text = norm([...f.skills, ...f.certifications].join(' , '));
  const matched = wanted.filter((s) => has(text, s));
  const missing = wanted.filter((s) => !matched.includes(s));
  if (!f.skills.length && !f.certifications.length) return { unknown: true, detail: 'Add your skills to your profile to see how they match', matched, missing };
  return {
    score: matched.length / wanted.length, matched, missing,
    detail: matched.length ? `${matched.length} of ${wanted.length} skills: ${matched.join(', ')}` : `None of the ${wanted.length} listed skills yet`,
  };
}

function experienceFactor(f, job) {
  const need = search.experienceRange(job.experience);
  if (!need) return null;
  if (!f.years) return { unknown: true, detail: `The job asks for ${job.experience}; add your experience to compare` };
  const [cmin, cmax] = f.years;
  const yrs = cmin === cmax ? `${cmin} ${cmin === 1 ? 'year' : 'years'}` : `${cmin}–${cmax} years`;
  if (cmax >= need[0] && cmin <= need[1]) return { score: 1, detail: `You have ${yrs}; the job asks for ${job.experience}` };
  if (cmin > need[1]) return { score: 1, detail: `You have ${yrs}, more than the ${job.experience} asked for` };
  const gap = need[0] - cmax;
  return { score: gap <= 1 ? 0.5 : 0, detail: `The job asks for ${job.experience}; you have ${yrs}` };
}

const lower = (s) => String(s || '').trim().toLowerCase();
function locationFactor(f, job) {
  const arrangementOk = !f.arrangements.length || f.arrangements.includes(job.mode);
  const remote = job.mode === 'Remote' || job.location === 'Remote';
  if (remote) {
    if (arrangementOk) return { score: 1, detail: 'Remote job' };
    return { score: 0.5, detail: `Remote job; you prefer ${f.arrangements.join(' or ')}` };
  }
  const places = [f.city, ...f.locations].map(lower).filter(Boolean);
  if (!places.length && !f.state) return { unknown: true, detail: `In ${job.location}; add your city to compare` };
  const where = lower(job.location);
  let score;
  let detail;
  if (places.includes(where)) { score = 1; detail = `In ${job.location}, where you want to work`; }
  else if (search.stateOf(job.location) && [f.state, ...[f.city, ...f.locations].map(search.stateOf)].includes(search.stateOf(job.location))) { score = 0.5; detail = `In ${job.location}, in your state`; }
  else if (f.relocate) { score = 0.5; detail = `In ${job.location}; you're open to relocating`; }
  else { score = 0; detail = `In ${job.location}, outside the places you chose`; }
  if (!arrangementOk) { score /= 2; detail += `; it's ${job.mode} and you prefer ${f.arrangements.join(' or ')}`; }
  return { score, detail };
}

const inr = (n) => `₹${Math.round(n).toLocaleString('en-IN')}`;
function salaryFactor(f, job) {
  const top = search.monthlyMax(job);
  if (!top) return null;
  if (!f.expectedMonthly) return { unknown: true, detail: `Pays up to ${inr(top)} a month; add your expected pay to compare` };
  const detail = `Pays up to ${inr(top)} a month; you expect ${inr(f.expectedMonthly)}`;
  if (top >= f.expectedMonthly) return { score: 1, detail };
  return { score: top >= 0.85 * f.expectedMonthly ? 0.5 : 0, detail };
}

function jobTypeFactor(f, job) {
  const parts = [];
  const notes = [];
  if (f.types.length) {
    const ok = f.types.includes(job.type);
    parts.push(ok ? 1 : 0);
    notes.push(ok ? `${job.type}, a type you chose` : `${job.type}; you chose ${f.types.join(', ')}`);
  }
  if (job.shift && f.shifts.length) {
    const ok = f.shifts.includes(job.shift) || f.shifts.includes('Flexible');
    parts.push(ok ? 1 : 0);
    notes.push(ok ? `${job.shift} shift suits you` : `${job.shift} shift; you chose ${f.shifts.join(', ')}`);
  }
  if (!parts.length) return { unknown: true, detail: `${job.type}${job.shift ? `, ${job.shift} shift` : ''}; add the job types and shifts you want to compare` };
  return { score: parts.reduce((a, b) => a + b, 0) / parts.length, detail: notes.join('; ') };
}

const FACTOR_FNS = { skills: skillsFactor, experience: experienceFactor, location: locationFactor, salary: salaryFactor, jobType: jobTypeFactor };

// Job-specific must-haves, shown on their own and never part of the score:
// licences or certificates, starting straight away, physical work.
function requirementsOf(f, job, today = new Date().toISOString().slice(0, 10)) {
  const out = [];
  const text = norm([...f.certifications, ...f.skills].join(' , '));
  for (const item of job.mustHave || []) out.push({ key: 'licence', label: item, met: has(text, item) ? true : null, detail: has(text, item) ? 'On your profile' : 'Not on your profile yet' });
  if (job.immediate) {
    const soon = new Date(Date.parse(today) + 7 * 86400000).toISOString().slice(0, 10);
    const met = f.noticePeriod === 'Immediate' || (f.availableFrom && f.availableFrom <= soon) ? true : f.noticePeriod || f.availableFrom ? false : null;
    out.push({ key: 'immediate', label: 'Can start straight away', met, detail: met ? 'You can start now' : met === false ? `You said: ${f.noticePeriod || `from ${f.availableFrom}`}` : 'Add when you can start' });
  }
  if (job.physical) out.push({ key: 'physical', label: job.physical, met: null, detail: 'Part of the job; check it suits you' });
  return out;
}

// The full explanation for one candidate and one job.
function explain(f, job, weights = DEFAULT_WEIGHTS) {
  let basis = 0;
  let total = 0;
  let skills = { matched: [], missing: job.skills || [] };
  const factors = FACTORS.map((def) => {
    const w = weights[def.key] || 0;
    const r = FACTOR_FNS[def.key](f, job);
    if (def.key === 'skills' && r) skills = { matched: r.matched, missing: r.missing };
    if (!r) return { key: def.key, label: def.label, weight: w, status: 'not-asked', detail: 'The job does not say' };
    if (r.unknown) return { key: def.key, label: def.label, weight: w, status: 'unknown', detail: r.detail };
    basis += w;
    total += w * r.score;
    return { key: def.key, label: def.label, weight: w, status: r.score >= 0.99 ? 'met' : r.score > 0 ? 'partial' : 'unmet', score: Math.round(r.score * 100) / 100, detail: r.detail };
  });
  const score = basis >= MIN_BASIS ? Math.round((total / basis) * 100) : null;
  const level = score === null ? { key: 'unknown', label: 'Not enough details yet' } : LEVELS.find((l) => score >= l.min);
  return {
    score, level: level.key, label: level.label, basis, version: MATCH_VERSION, factors,
    matched: factors.filter((x) => x.status === 'met').map((x) => x.label),
    notYet: factors.filter((x) => x.status === 'unmet' || x.status === 'partial').map((x) => x.label),
    skills, requirements: requirementsOf(f, job), note: NOTE,
  };
}

module.exports = { MATCH_VERSION, FACTORS, DEFAULT_WEIGHTS, MIN_BASIS, NOTE, parseWeights, weightsOf, facts, explain, yearsOf, requirementsOf };
