// Application stage history and timeline. Every pipeline move is recorded on the
// application (application.history[]) with when, from, to and who, so reports
// can say exactly how far candidates got and how fast the team responds.
const MAX_HISTORY = 100;
const ORDER = ['New', 'Screening', 'Interview', 'Offered', 'Hired'];

// Move an application to a stage and record it. Returns false if it was already there.
function moveStage(a, to, by, at = new Date().toISOString()) {
  const from = a.status || 'New';
  if (from === to) return false;
  a.status = to;
  a.updatedAt = at;
  a.history = [...(a.history || []), { at, from, to, by: by || 'System' }].slice(-MAX_HISTORY);
  return true;
}

// Has this application ever been at (or past) a stage? Uses the recorded history,
// the current stage, and interviews booked; `placed` covers recorded placements.
function everReached(a, stage, placed = false) {
  const idx = ORDER.indexOf(stage);
  const seen = new Set([a.status || 'New', ...(a.history || []).flatMap((h) => [h.from, h.to])]);
  if ([...seen].some((s) => ORDER.indexOf(s) >= idx && ORDER.indexOf(s) > -1)) return true;
  if (stage === 'Screening' && (a.history || []).length) return true; // moved out of New at all
  if (stage === 'Screening' && (a.status || 'New') !== 'New') return true; // e.g. rejected straight from New
  if (['Screening', 'Interview'].includes(stage) && (a.interviews || []).length) return true;
  return placed && idx <= ORDER.indexOf('Hired');
}

// Days from application to the first move out of New (the team's response time).
function firstResponseDays(a) {
  const first = (a.history || []).find((h) => h.from === 'New');
  return first ? Math.max(0, (Date.parse(first.at) - Date.parse(a.createdAt)) / 86400000) : null;
}

// Everything that happened to an application, newest first.
function timeline(a) {
  const ev = [];
  ev.push({ at: a.createdAt, kind: 'Applied', text: `Applied for ${a.jobTitle}${a.source ? ` (via ${a.source})` : ''}` });
  for (const h of a.history || []) ev.push({ at: h.at, kind: 'Stage', text: `${h.from} → ${h.to}`, by: h.by });
  for (const iv of a.interviews || []) {
    ev.push({ at: iv.createdAt, kind: 'Interview', text: `${iv.mode} interview booked` });
    for (const [kind, at] of Object.entries(iv.reminders || {})) ev.push({ at, kind: 'Email', text: `Interview reminder sent (${kind === 'day' ? '1 day' : '1 hour'} before)` });
    if (iv.cancelledAt) ev.push({ at: iv.cancelledAt, kind: 'Interview', text: 'Interview cancelled' });
    for (const f of iv.feedback || []) ev.push({ at: f.at, kind: 'Feedback', text: `Interview feedback: ${f.recommendation}, ${f.rating}/5`, by: f.by });
  }
  for (const m of a.emails || []) ev.push({ at: m.at, kind: 'Email', text: `Emailed: ${m.subject}`, by: m.by });
  if (a.shared) {
    ev.push({ at: a.shared.sharedAt, kind: 'Shared', text: 'Shared with client' });
    if (a.shared.feedback) ev.push({ at: a.shared.feedback.at, kind: 'Client', text: `Client feedback: ${a.shared.feedback.decision}${a.shared.feedback.comment ? ` – “${a.shared.feedback.comment}”` : ''}`, by: a.shared.feedback.by });
  }
  if (a.withdrawnAt) ev.push({ at: a.withdrawnAt, kind: 'Withdrawn', text: 'Candidate withdrew' });
  return ev.filter((e) => e.at).sort((x, y) => y.at.localeCompare(x.at));
}

module.exports = { moveStage, everReached, firstResponseDays, timeline, ORDER };
