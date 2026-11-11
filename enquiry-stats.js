// Employer enquiries (hire requests) in numbers, and the filters on the admin
// Hire requests screen. The same figures feed the weekly summary email.
const { sourceName } = require('./reports');

const STATUSES = ['New', 'Contacted', 'Requirement received', 'Candidates shared', 'Closed'];
const PERIODS = { 7: 'Last 7 days', 30: 'Last 30 days', 90: 'Last 90 days', all: 'All time' };
const DAY = 86400000;

const statusOf = (h) => h.followUp || 'New';
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const tally = (list, key) => Object.entries(list.reduce((m, h) => { const k = key(h); m[k] = (m[k] || 0) + 1; return m; }, {}))
  .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
const sourceLabel = (h) => (h.source ? sourceName(h.source) + (h.campaign ? ` (${h.campaign})` : '') : 'Not tracked');
const pageLabel = (h) => h.fromPage || 'Hire a Team form';

// Hours from the enquiry to the first move out of "New" (recorded from Step 131).
const hoursToContact = (h) => (h.contactedAt ? Math.max(0, (Date.parse(h.contactedAt) - Date.parse(h.createdAt)) / 3600000) : null);

// Read the filters from the query string, keeping only known values.
function parseFilters(query, ownerIds = []) {
  const q = String(query.q || '').trim().slice(0, 80);
  const status = STATUSES.includes(query.status) ? query.status : '';
  // 'open': mine and those nobody owns yet, what the dashboard's "What needs you" counts.
  const owner = ['me', 'none', 'open'].includes(query.owner) || ownerIds.includes(query.owner) ? query.owner : '';
  const period = Object.keys(PERIODS).includes(String(query.period)) ? String(query.period) : 'all';
  return { q, status, owner, period, waiting: query.waiting === '1' };
}

function inPeriod(h, period, now) {
  return period === 'all' || Date.parse(h.createdAt) > now - Number(period) * DAY;
}

// The list the screen shows: period, status, owner, "waiting for a call" and search.
function filter(list, f, { isOverdue, me, now = Date.now() }) {
  const words = f.q.toLowerCase().split(/\s+/).filter(Boolean);
  const digits = f.q.replace(/\D/g, '');
  return list.filter((h) => {
    if (!inPeriod(h, f.period, now)) return false;
    if (f.status && statusOf(h) !== f.status) return false;
    if (f.owner === 'me' && h.ownerId !== me) return false;
    if (f.owner === 'none' && h.ownerId) return false;
    if (f.owner === 'open' && h.ownerId && h.ownerId !== me) return false;
    if (f.owner && !['me', 'none', 'open'].includes(f.owner) && h.ownerId !== f.owner) return false;
    if (f.waiting && !isOverdue(h)) return false;
    if (!words.length) return true;
    const text = [h.company, h.name, h.email, h.roles, h.location, h.industry].join(' ').toLowerCase();
    return words.every((w) => text.includes(w)) || (digits.length >= 4 && String(h.phone || '').replace(/\D/g, '').includes(digits));
  });
}

// The numbers for a period: new, open, waiting, by status, sources, pages and
// how quickly the team makes the first call.
function summarise(list, { isOverdue, period = '90', now = Date.now() }) {
  const inRange = list.filter((h) => inPeriod(h, period, now));
  const open = list.filter((h) => statusOf(h) !== 'Closed');
  const hours = inRange.map(hoursToContact).filter((x) => x !== null);
  const timed = inRange.filter((h) => h.contactedAt);
  return {
    period,
    periodLabel: PERIODS[period],
    received: inRange.length,
    newCount: list.filter((h) => statusOf(h) === 'New').length,
    open: open.length,
    waiting: list.filter(isOverdue).length,
    closed: inRange.filter((h) => statusOf(h) === 'Closed').length,
    byStatus: STATUSES.map((s) => [s, list.filter((h) => statusOf(h) === s).length]),
    sources: tally(inRange, sourceLabel),
    pages: tally(inRange, pageLabel),
    medianHours: median(hours),
    withinDay: timed.length ? Math.round((100 * timed.filter((h) => hoursToContact(h) <= 24).length) / timed.length) : null,
    timedCount: timed.length,
  };
}

// "3 hours", "1.5 days": for the median time to the first call.
function formatHours(h) {
  if (h === null || h === undefined) return '';
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 48) return `${Math.round(h)} hour${Math.round(h) === 1 ? '' : 's'}`;
  return `${Math.round((h / 24) * 10) / 10} days`;
}

module.exports = { STATUSES, PERIODS, parseFilters, filter, summarise, formatHours, sourceLabel, pageLabel, hoursToContact };
