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

module.exports = { ENGLISH_LEVELS, ENGLISH_LABELS, englishKey, englishFromKey, fitsEnglish, parse, walkInOf, walkInOpen, walkInDays, englishGap, validDate };
