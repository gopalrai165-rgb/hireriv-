// How fast a hiring team opens applications, from viewedAt (set the first
// time an employer opens an application or anyone on the hiring side moves
// it, Step 96). Worked out per hiring team: an employer's own jobs share
// their company's figure, and jobs Hireriv's team handles share one figure.
//
// Fair to the employer and honest to job seekers:
// - only applications from the last 90 days that are at least 3 days old
//   count, so new ones nobody could have opened yet don't drag it down;
// - applications never opened count as slow, so a team can't look fast by
//   ignoring most people;
// - withdrawn and duplicate applications don't count;
// - nothing is said until at least 5 applications count, and only good news
//   is shown ("within a day" or "within 3 days"), never a slow label.
const DAY = 86400000;
const WINDOW_DAYS = 90;
const SETTLE_DAYS = 3;
const MIN_APPLICATIONS = 5;

const cache = new WeakMap();
const CACHE_MS = 60 * 60 * 1000;

const teamOf = (job) => (job && job.employerId) || 'team';

// { [team]: { count, medianHours, label } } for the shared, frozen
// applications list from db.snapshot; kept until the list changes or an hour passes.
function byTeam(applications, jobById, now = Date.now()) {
  const hit = cache.get(applications);
  if (hit && now - hit.at < CACHE_MS) return hit.teams;
  const from = now - WINDOW_DAYS * DAY;
  const to = now - SETTLE_DAYS * DAY;
  const hours = {};
  for (const a of applications) {
    if (a.withdrawnAt || a.duplicateOf || !a.jobId || a.jobId === 'general') continue;
    const at = Date.parse(a.createdAt);
    if (!(at >= from && at <= to)) continue;
    const job = jobById(a.jobId);
    if (!job) continue;
    const seen = a.viewedAt ? Date.parse(a.viewedAt) : NaN;
    const h = Number.isFinite(seen) ? Math.max(0, (seen - at) / 3600000) : Infinity;
    (hours[teamOf(job)] ||= []).push(h);
  }
  const teams = {};
  for (const [team, list] of Object.entries(hours)) {
    if (list.length < MIN_APPLICATIONS) continue;
    list.sort((x, y) => x - y);
    const mid = list.length % 2 ? list[(list.length - 1) / 2] : (list[list.length / 2 - 1] + list[list.length / 2]) / 2;
    teams[team] = { count: list.length, medianHours: mid, label: mid <= 24 ? 'day' : mid <= 72 ? '3days' : '' };
  }
  cache.set(applications, { at: now, teams });
  return teams;
}

// The label for one job's hiring team: 'day', '3days' or '' (nothing to say).
function labelFor(job, applications, jobById, now) {
  const t = byTeam(applications, jobById, now)[teamOf(job)];
  return t ? t.label : '';
}

module.exports = { byTeam, labelFor, teamOf, WINDOW_DAYS, SETTLE_DAYS, MIN_APPLICATIONS };
