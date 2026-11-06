// Inviting someone who applied to apply for another job. Companies do it for
// their own jobs (employer-hiring.js) and the Hireriv team for the jobs it runs
// (server.js). They're told and decide for themselves: nothing is applied for
// them. Each list of invitations is kept apart by whoever sent it.
const TEAM_INVITES_PER_DAY = 100;
const DAY = 864e5;
const lower = (s) => String(s || '').trim().toLowerCase();
const digits10 = (p) => String(p || '').replace(/\D/g, '').slice(-10);
const sameApplicant = (a) => (x) => Boolean((a.email && lower(x.email) === lower(a.email)) || (digits10(a.phone).length === 10 && digits10(x.phone) === digits10(a.phone)));
const leftToday = (invites, perDay, now = Date.now()) => Math.max(0, perDay - invites.filter((i) => i.createdAt >= new Date(now - DAY).toISOString()).length);

// What the page shows: jobs that can still be offered, and what was sent.
// `targets` are the open jobs this sender may offer, `invites` the sender's own.
function stateOf({ a, applications, invites, targets, allJobs, jobPath, perDay }) {
  const applied = new Set(applications.filter(sameApplicant(a)).map((x) => x.jobId));
  const sent = invites.filter((i) => i.applicationId === a.id || (a.email && lower(i.email) === lower(a.email)));
  const sentIds = new Set(sent.map((i) => i.jobId));
  return {
    jobs: targets.filter((j) => j.id !== a.jobId && !applied.has(j.id) && !sentIds.has(j.id)).map((j) => ({ id: j.id, title: j.title, location: j.location, path: jobPath(j) })),
    invited: sent.map((i) => { const j = allJobs.find((x) => x.id === i.jobId); return { jobId: i.jobId, title: j ? j.title : 'A job that was removed', at: i.createdAt, applied: applied.has(i.jobId) }; }),
    reachable: Boolean(a.email),
    left: leftToday(invites, perDay),
    perDay,
  };
}

module.exports = { TEAM_INVITES_PER_DAY, lower, stateOf };
