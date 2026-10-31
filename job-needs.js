// Two things job seekers in skilled, field and entry-level work ask before
// anything else: how much English the job needs, and whether they can just
// walk in for an interview (where, on which days, at what time, whom to ask).
// Used by the job forms, the job page and cards, the search filters, the API
// and the profile match.

// Lowest to highest. The filter key is the lower-case level.
const ENGLISH_LEVELS = ['None', 'Basic', 'Good', 'Fluent'];
const ENGLISH_LABELS = { None: 'No English needed', Basic: 'Basic English', Good: 'Good English', Fluent: 'Fluent English' };
const englishRank = (level) => ENGLISH_LEVELS.indexOf(level);
const englishKey = (level) => (ENGLISH_LEVELS.includes(level) ? level.toLowerCase() : '');
const englishFromKey = (key) => ENGLISH_LEVELS.find((l) => l.toLowerCase() === String(key || '').toLowerCase()) || '';

// "My English is X": jobs that say they need X or less. Jobs that don't say
// are left out, so the filter never promises what a job hasn't stated.
const fitsEnglish = (job, level) => Boolean(job && ENGLISH_LEVELS.includes(job.english)) && englishRank(job.english) <= englishRank(level);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s) => DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

// Reads the English level and walk-in details from a job form or API body.
// `walkIn` is whether the walk-in box is ticked; `today` is the India date.
function parse(body, { walkIn, today, closed = false }) {
  const errors = [];
  const english = String(body.english ?? '').trim();
  if (english && !ENGLISH_LEVELS.includes(english)) errors.push(`English needed must be one of: ${ENGLISH_LEVELS.join(', ')}`);
  const text = (k, max) => String(body[k] ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
  const out = { english: ENGLISH_LEVELS.includes(english) ? english : '', walkInFrom: '', walkInTo: '', walkInTime: '', walkInContact: '' };
  if (!walkIn) return { ...out, errors };
  out.walkInFrom = text('walkInFrom', 10);
  out.walkInTo = text('walkInTo', 10);
  out.walkInTime = text('walkInTime', 60);
  out.walkInContact = text('walkInContact', 80);
  for (const [k, label] of [['walkInFrom', 'first walk-in day'], ['walkInTo', 'last walk-in day']]) {
    if (out[k] && !validDate(out[k])) { errors.push(`${label} is not a date`); out[k] = ''; }
  }
  if (out.walkInFrom && out.walkInTo && out.walkInTo < out.walkInFrom) errors.push('the last walk-in day is before the first');
  if (!closed && out.walkInTo && today && out.walkInTo < today) errors.push('the walk-in days are over (pick later days, or leave them blank)');
  return { ...out, errors };
}

// The walk-in as people see it, or null: open now, upcoming or over.
function walkInOf(job, today) {
  if (!job || !job.walkIn) return null;
  const from = job.walkInFrom || '';
  const to = job.walkInTo || '';
  const state = to && today && to < today ? 'over' : from && today && from > today ? 'upcoming' : 'open';
  return { state, from, to, time: job.walkInTime || '', contact: job.walkInContact || '', address: job.address || '' };
}
// For the filter and badges: walk-ins that haven't ended.
const walkInOpen = (job, today) => {
  const w = walkInOf(job, today);
  return Boolean(w) && w.state !== 'over';
};

// "12 Nov" or "12 Nov – 15 Nov"; the year only when it isn't this year.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function dayLabel(d, today) {
  if (!validDate(d)) return '';
  const year = d.slice(0, 4) !== String(today || '').slice(0, 4) ? ` ${d.slice(0, 4)}` : '';
  return `${Number(d.slice(8))} ${MONTHS[Number(d.slice(5, 7)) - 1]}${year}`;
}
function walkInDays(w, today) {
  if (!w) return '';
  if (w.from && w.to && w.from !== w.to) return `${dayLabel(w.from, today)} – ${dayLabel(w.to, today)}`;
  if (w.from || w.to) return dayLabel(w.from || w.to, today);
  return '';
}

// For the profile match: a job that needs more English than the person has.
function englishGap(job, personLevel) {
  if (!job || !ENGLISH_LEVELS.includes(job.english) || !ENGLISH_LEVELS.includes(personLevel)) return null;
  return englishRank(job.english) > englishRank(personLevel) ? { needs: job.english, has: personLevel } : null;
}

// ---------- minimum education ----------
// What a job needs, lowest first. ITI and diplomas are their own track after
// 10th, so a 12th pass doesn't count as ITI, and ITI doesn't count as 12th.
const EDUCATION = [
  { key: 'none', label: 'No education needed' },
  { key: '10th', label: '10th pass' },
  { key: '12th', label: '12th pass' },
  { key: 'iti', label: 'ITI / Diploma' },
  { key: 'graduate', label: 'Graduate' },
  { key: 'postgraduate', label: 'Post-graduate' },
];
const EDUCATION_KEYS = EDUCATION.map((e) => e.key);
const educationLabel = (key) => (EDUCATION.find((e) => e.key === key) || {}).label || '';
// Which of a person's levels meet each requirement.
const MEETS = {
  none: ['below', '10th', '12th', 'iti', 'graduate', 'postgraduate'],
  '10th': ['10th', '12th', 'iti', 'graduate', 'postgraduate'],
  '12th': ['12th', 'graduate', 'postgraduate'],
  iti: ['iti'],
  graduate: ['graduate', 'postgraduate'],
  postgraduate: ['postgraduate'],
};
// Words in the free-text "Education" box, for jobs posted before the list:
// words in any case, abbreviations only in capitals (so "be" isn't B.E.).
const EDUCATION_WORDS = [
  ['postgraduate', /\b(post[- ]?graduat\w*|masters?)\b/i, /\b(PG|MBA|MCA|M\.?\s?Com|M\.?\s?Sc|M\.?\s?Tech|M\.A\.)/],
  ['graduate', /(?<!post[- ]?)\b(graduat\w*|degree|bachelor\w*)\b/i, /\b(B\.?\s?Com|B\.?\s?Sc|BBA|BCA|B\.?\s?Tech|B\.E\b|B\.A\b|BA|BE)\b/],
  ['iti', /\b(diploma|polytechnic)\b/i, /\bITI\b/],
  ['12th', /\b(12th|intermediate|higher secondary)\b/i, /\b(HSC|PUC)\b/],
  ['10th', /\b(10th|matric\w*)\b/i, /\b(SSC|SSLC)\b/],
  ['none', /\b(no (education|qualification)|any (education|qualification)|not required)\b/i, null],
];
// A job's minimum: the list choice, else the levels its text names (any of
// them will do: "12th pass or ITI"). educationOf gives the first, to show.
function educationNeeds(job) {
  if (!job) return [];
  if (EDUCATION_KEYS.includes(job.minEducation)) return [job.minEducation];
  const text = String(job.education || '');
  if (!text) return [];
  return EDUCATION_WORDS.filter(([, words, abbr]) => words.test(text) || (abbr && abbr.test(text))).map(([k]) => k).sort((x, y) => EDUCATION_KEYS.indexOf(x) - EDUCATION_KEYS.indexOf(y));
}
const educationOf = (job) => educationNeeds(job)[0] || '';
// "My education is X": jobs whose minimum X meets. Jobs that don't say are
// left out, as with English.
function fitsEducation(job, mine) {
  return educationNeeds(job).some((need) => (MEETS[need] || []).includes(mine));
}
// Profile levels (candidate-profile.js) as education keys.
const FROM_PROFILE = { 'Below 10th': 'below', '10th pass': '10th', '12th pass': '12th', ITI: 'iti', Diploma: 'iti', Graduate: 'graduate', 'Post-graduate': 'postgraduate', Doctorate: 'postgraduate' };
const educationFromProfile = (levels) => [...new Set((levels || []).map((l) => FROM_PROFILE[l]).filter(Boolean))];
// For the profile match: null when either side is unknown.
function educationMet(job, personKeys) {
  const needs = educationNeeds(job);
  if (!needs.length || needs.includes('none')) return null;
  if (!personKeys || !personKeys.length) return { need: needs[0], met: null };
  return { need: needs[0], met: needs.some((need) => personKeys.some((k) => (MEETS[need] || []).includes(k))) };
}

// ---------- perks ----------
// What a job gives besides pay. Ticked on the form, and also read from the
// Benefits lines and pay note (never from "Costs the worker pays").
const PERKS = [
  { key: 'food', label: 'Food / meals', re: /\b(food|meals?|lunch|dinner|breakfast|canteen|tiffin)\b/i },
  { key: 'stay', label: 'Stay / room', re: /\b(accommodation|hostel|lodging|quarters|stay|room)\b/i },
  { key: 'transport', label: 'Transport', re: /\b(cab|transport|bus|pick[- ]?up|conveyance|travel allowance)\b/i },
  { key: 'pf', label: 'PF / ESI', re: /\b(PF|EPF|ESI|ESIC|provident fund)\b/i },
  { key: 'incentives', label: 'Incentives', re: /\b(incentives?|(?<!joining\s)bonus|commission)\b/i },
  { key: 'insurance', label: 'Health insurance', re: /\b(insurance|mediclaim)\b/i },
  // Step 100: money soon after joining, for people who can't wait a month.
  { key: 'joiningbonus', label: 'Joining bonus', re: /\bjoining\s+bonus\b/i },
  { key: 'dailypay', label: 'Daily / weekly payment', re: /\b(daily|weekly)\s+(pay(ment|out)?s?|salary|wages?)\b|\bpaid\s+(daily|weekly|every\s+(day|week))\b|\bsame[- ]day\s+pay(ment)?\b/i },
];
const PERK_KEYS = PERKS.map((p) => p.key);
const perkLabel = (key) => (PERKS.find((p) => p.key === key) || {}).label || '';
function perksOf(job) {
  if (!job) return [];
  const ticked = (Array.isArray(job.perks) ? job.perks : []).filter((k) => PERK_KEYS.includes(k));
  const text = [...(job.benefits || []), job.payNote || ''].join(' \n ');
  const read = PERKS.filter((p) => p.re.test(text)).map((p) => p.key);
  return PERK_KEYS.filter((k) => ticked.includes(k) || read.includes(k));
}
const hasPerks = (job, keys) => {
  const have = perksOf(job);
  return keys.every((k) => have.includes(k));
};
// ---------- things the worker must have ----------
// A vehicle, a licence or a device the job can't be done without (delivery,
// field sales, work from home). Ticked on the form, and also read from the
// requirement lines (licences needed, requirements, who can apply).
const ITEMS = [
  { key: 'bike', label: 'Own two-wheeler', re: /\b(own|personal|your)\s+(bike|two[- ]?wheeler|scooty|scooter|motorcycle|vehicle)\b|\b(bike|two[- ]?wheeler|scooty|scooter|motorcycle)\s+(is\s+)?(required|needed|must|compulsory|mandatory)\b/i },
  { key: 'licence', label: 'Driving licence', re: /\b(driving|driver'?s?)\s+licen[cs]e\b|\bDL\b/ },
  { key: 'smartphone', label: 'Smartphone', re: /\b(smart\s?phone|android\s+(phone|mobile))\b/i },
  { key: 'laptop', label: 'Laptop', re: /\b(own|personal|your)\s+laptop\b|\blaptop\s+(is\s+)?(required|needed|must|compulsory|mandatory)\b/i },
];
const ITEM_KEYS = ITEMS.map((i) => i.key);
const itemLabel = (key) => (ITEMS.find((i) => i.key === key) || {}).label || '';
function itemsOf(job) {
  if (!job) return [];
  const ticked = (Array.isArray(job.bring) ? job.bring : []).filter((k) => ITEM_KEYS.includes(k));
  const text = [...(job.mustHave || []), ...(job.qualifications || []), ...(job.eligibility || [])].join(' \n ');
  const read = ITEMS.filter((i) => i.re.test(text)).map((i) => i.key);
  return ITEM_KEYS.filter((k) => ticked.includes(k) || read.includes(k));
}
// "I don't have X": jobs that need none of them.
const needsNoneOf = (job, keys) => {
  const need = itemsOf(job);
  return !keys.some((k) => need.includes(k));
};
// "Jobs for people with a bike": jobs that need every one of them.
const needsAllOf = (job, keys) => {
  const need = itemsOf(job);
  return keys.every((k) => need.includes(k));
};
// For the profile match: each thing the job needs, and whether the person
// said they have it (null: not said; a licence also counts from certificates).
function itemsMet(job, has, certificates = []) {
  const said = (has || []).filter((k) => ITEM_KEYS.includes(k));
  const licenceListed = certificates.some((c) => /\b(driving|driver'?s?)\s+licen[cs]e\b|\bDL\b|\b(LMV|MCWG|two[- ]?wheeler licen[cs]e)\b/i.test(String(c)));
  return itemsOf(job).map((key) => ({ key, label: itemLabel(key), met: said.includes(key) || (key === 'licence' && licenceListed) ? true : null }));
}

// ---------- immediate joining ----------
// Jobs that need people who can start straight away: ticked on the form
// ("Needs people who can start straight away"), or said in the listing's own
// words ("immediate joiners", "join immediately").
const IMMEDIATE_RE = /\bimmediate\s+(join(ing|ers?|ees?)|start(ers?)?)\b|\b(join|joining|start)\s+immediately\b/i;
function startsNow(job) {
  if (!job) return false;
  if (job.immediate) return true;
  return IMMEDIATE_RE.test([job.title, job.description, ...(job.mustHave || []), ...(job.eligibility || []), ...(job.qualifications || [])].join(' \n '));
}

// A list of keys from a form or API body: an array, repeated fields or commas.
const keyList = (v) => [].concat(v ?? []).flatMap((x) => String(x).split(',')).map((x) => x.trim()).filter(Boolean);
// From a form or API body: minEducation, perks and the things to have.
function parseExtras(body) {
  const errors = [];
  const minEducation = String(body.minEducation ?? '').trim();
  if (minEducation && !EDUCATION_KEYS.includes(minEducation)) errors.push(`minimum education must be one of: ${EDUCATION_KEYS.join(', ')}`);
  const raw = keyList(body.perks);
  if (raw.some((k) => !PERK_KEYS.includes(k))) errors.push(`perks must be from: ${PERK_KEYS.join(', ')}`);
  const bring = keyList(body.bring);
  if (bring.some((k) => !ITEM_KEYS.includes(k))) errors.push(`things the worker must have must be from: ${ITEM_KEYS.join(', ')}`);
  return { minEducation: EDUCATION_KEYS.includes(minEducation) ? minEducation : '', perks: PERK_KEYS.filter((k) => raw.includes(k)), bring: ITEM_KEYS.filter((k) => bring.includes(k)), errors };
}

module.exports = {
  ENGLISH_LEVELS, ENGLISH_LABELS, englishKey, englishFromKey, fitsEnglish, parse, walkInOf, walkInOpen, walkInDays, englishGap, validDate,
  EDUCATION, EDUCATION_KEYS, educationLabel, educationOf, educationNeeds, fitsEducation, educationFromProfile, educationMet, PERKS, PERK_KEYS, perkLabel, perksOf, hasPerks, parseExtras,
  ITEMS, ITEM_KEYS, itemLabel, itemsOf, needsNoneOf, needsAllOf, itemsMet, startsNow,
};
