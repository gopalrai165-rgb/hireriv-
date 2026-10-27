// Running totals over the applications for the admin pages: counts by stage,
// by job, by day and by person, résumés not read yet, and the applications that have
// interviews. Worked out in one pass the first time a page asks after the
// applications change, then shared by every admin view until the next change,
// instead of each view going through every application several times.
//
// `applications` must be the shared, frozen list from db.snapshot: a new list
// after each write is what tells this module to count again.
const { istDay } = require('./ics');

const cache = new WeakMap();

const statusOf = (a) => a.status || 'New';

function totals(applications) {
  let t = cache.get(applications);
  if (t) return t;
  const byStatus = {};
  const perJob = {};
  const emails = new Set();
  const created = [];
  const byDay = {};
  const withInterviews = [];
  let unreadResumes = 0;
  for (const a of applications) {
    const s = statusOf(a);
    byStatus[s] = (byStatus[s] || 0) + 1;
    perJob[a.jobId] = (perJob[a.jobId] || 0) + 1;
    emails.add(String(a.email).toLowerCase());
    const ms = new Date(a.createdAt).getTime();
    if (!Number.isNaN(ms)) {
      created.push(ms);
      const day = istDay(new Date(ms));
      byDay[day] = (byDay[day] || 0) + 1;
    }
    if ((a.interviews || []).length) withInterviews.push(a);
    if (a.resume && a.resumeText === undefined) unreadResumes++;
  }
  created.sort((x, y) => x - y);
  t = Object.freeze({
    total: applications.length,
    // Stage name -> how many (stages with none are missing; use count()).
    byStatus: Object.freeze(byStatus),
    count: (status) => byStatus[status] || 0,
    // Job id -> how many applications.
    perJob: Object.freeze(perJob),
    // India date (YYYY-MM-DD) -> how many were sent that day.
    byDay: Object.freeze(byDay),
    people: emails.size,
    unreadResumes,
    // Only these can have interviews, so interviews.js gives the same answers
    // from them as from every application.
    withInterviews: Object.freeze(withInterviews),
    // How many were sent at or after `ms` (a time that moves, so not cached).
    since: (ms) => created.length - lowerBound(created, ms),
  });
  cache.set(applications, t);
  return t;
}

// First index whose value is >= x in an ascending list.
function lowerBound(list, x) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

module.exports = { totals };
