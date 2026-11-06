// Why someone withdrew an application: one reason from a fixed list, only if
// they choose to give one. Saying nothing never stops them withdrawing. A fixed
// list on purpose, as with reject-reasons.js: the hiring side sees it and it
// feeds their reports, so it shouldn't invite remarks about named people.
const REASONS = [
  { key: 'another-job', label: 'I took another job' },
  { key: 'pay', label: 'The pay isn’t right for me' },
  { key: 'location', label: 'It’s too far, or in the wrong place' },
  { key: 'timing', label: 'The hours or start date don’t suit me' },
  { key: 'not-as-expected', label: 'The job isn’t what I expected' },
  { key: 'no-reply', label: 'I waited too long for a reply' },
  { key: 'not-looking', label: 'I’m no longer looking' },
  { key: 'mistake', label: 'I applied by mistake' },
  { key: 'other', label: 'Another reason' },
];
const KEYS = REASONS.map((r) => r.key);
const labelOf = (key) => (REASONS.find((r) => r.key === key) || {}).label || '';
// '' for nothing or anything not on the list: a bad value must not block withdrawing.
const parse = (value) => (KEYS.includes(String(value ?? '').trim()) ? String(value).trim() : '');

// Applications withdrawn (since `since`, when given), counted by reason, most
// common first. `none` is those who gave no reason.
function summary(applications, { since = null } = {}) {
  const counts = new Map();
  let total = 0;
  let none = 0;
  for (const a of applications) {
    if (!a.withdrawnAt || a.duplicateOf || (since && a.withdrawnAt < since)) continue;
    total++;
    if (!KEYS.includes(a.withdrawReason)) { none++; continue; }
    counts.set(a.withdrawReason, (counts.get(a.withdrawReason) || 0) + 1);
  }
  const share = (n) => (total ? Math.round((n / total) * 100) : 0);
  const rows = [...counts].sort((x, y) => y[1] - x[1] || KEYS.indexOf(x[0]) - KEYS.indexOf(y[0])).map(([key, count]) => ({ key, label: labelOf(key), count, share: share(count) }));
  return { total, none, noneShare: share(none), rows };
}

module.exports = { REASONS, KEYS, labelOf, parse, summary };
