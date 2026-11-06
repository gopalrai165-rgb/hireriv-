// Why an application didn't go ahead: one reason from a fixed list, picked by
// the person who moves it to Not selected (Rejected). Kept on that move in the
// application's history, so reports can show where hiring loses people.
//
// A fixed list on purpose: free text invites remarks about the person rather
// than the job. The reason is for the hiring side's own reports. It is not in
// the email the candidate gets, but it is in their data download, because it is
// information about them.
const REASONS = [
  { key: 'experience', label: 'Not enough experience for this job' },
  { key: 'skills', label: 'Missing a skill, licence or certificate the job needs' },
  { key: 'answers', label: 'Answers to the job’s questions' },
  { key: 'pay', label: 'Pay expectations didn’t match' },
  { key: 'location', label: 'Too far, or can’t travel as the job needs' },
  { key: 'timing', label: 'Can’t start or work the hours needed' },
  { key: 'no-show', label: 'Didn’t come to the interview' },
  { key: 'unreachable', label: 'Couldn’t be reached' },
  { key: 'interview', label: 'Interview didn’t go well enough' },
  { key: 'other-candidate', label: 'Another candidate was chosen' },
  { key: 'filled', label: 'The position was filled or closed' },
  { key: 'not-interested', label: 'The candidate is no longer interested' },
  { key: 'other', label: 'Other' },
];
const KEYS = REASONS.map((r) => r.key);
const labelOf = (key) => (REASONS.find((r) => r.key === key) || {}).label || '';

// '' when none was given; an error for anything not on the list.
function parse(value) {
  const key = String(value ?? '').trim();
  if (!key) return { key: '' };
  return KEYS.includes(key) ? { key } : { error: `the reason must be one of: ${KEYS.join(', ')}` };
}

// The reason for the application's current Not selected, or ''.
function reasonOf(a) {
  if (!a || a.status !== 'Rejected') return '';
  const move = [...(a.history || [])].reverse().find((h) => h.to === 'Rejected');
  return move && KEYS.includes(move.rejectReason) ? move.rejectReason : '';
}

// Applications not selected (moved there in the period, when `since` is given),
// counted by reason, most common first. `none` is those with no reason given.
function summary(applications, { since = null } = {}) {
  const counts = new Map();
  let total = 0;
  let none = 0;
  for (const a of applications) {
    if (a.status !== 'Rejected' || a.withdrawnAt || a.duplicateOf) continue;
    const move = [...(a.history || [])].reverse().find((h) => h.to === 'Rejected');
    if (since && !(move && move.at >= since)) continue;
    total++;
    const key = move && KEYS.includes(move.rejectReason) ? move.rejectReason : '';
    if (!key) { none++; continue; }
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const share = (n) => (total ? Math.round((n / total) * 100) : 0);
  const rows = [...counts].sort((x, y) => y[1] - x[1] || KEYS.indexOf(x[0]) - KEYS.indexOf(y[0])).map(([key, count]) => ({ key, label: labelOf(key), count, share: share(count) }));
  return { total, none, noneShare: share(none), rows };
}

module.exports = { REASONS, KEYS, labelOf, parse, reasonOf, summary };
