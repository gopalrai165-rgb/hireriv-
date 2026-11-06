// What needs someone on the Hireriv team today, on the team dashboard: replies
// nobody has read, candidates left waiting, interviews with no feedback and
// enquiries nobody has called. Only jobs the team runs; a company's own hiring
// is on its own dashboard (employer-todo.js). People who manage others see
// everything; everyone else sees their own work and work nobody owns yet.
// It only points: nobody is moved or sent anything from here.
const agencyRoles = require('./agency-roles');
const ats = require('./ats');
const messages = require('./messages');
const interviews = require('./interviews');
const { lastMove, WAITING_DAYS } = require('./employer-todo');

const DAY = 864e5;
const LABELS = { unread: 'New replies from candidates', waiting: `Waiting over ${WAITING_DAYS} days with no move` };
const CHECKS = {
  unread: (a) => messages.unreadFor(a, 'hiring') > 0,
  // A general resume isn't for a job yet, so it isn't waiting on anyone.
  waiting: (a, now) => a.jobId !== 'general' && ['New', 'Screening'].includes(ats.stageOf(a)) && now - Date.parse(lastMove(a)) >= WAITING_DAYS * DAY,
};
const plural = (n, one, many) => (n === 1 ? one : many);

// What this person is answerable for, given a helper that names each application's owner.
function scopeFor(user, jobs, ownerOf) {
  const companyRuns = new Set(jobs.filter((j) => j.createdBy === 'employer').map((j) => j.id));
  const everyone = agencyRoles.can(user, 'workload.view');
  return (a) => !a.duplicateOf && !a.withdrawnAt && !companyRuns.has(a.jobId) && (everyone || [user.id, ''].includes(ownerOf(a) || ''));
}
const matches = (key, a, inScope, now = Date.now()) => Boolean(CHECKS[key]) && inScope(a) && CHECKS[key](a, now);

function build({ user, apps, jobs, ownerOf, tabs, enquiries = [], now = Date.now() }) {
  const canWrite = agencyRoles.can(user, 'candidates.message');
  const canEnquire = tabs.includes('hire-requests');
  const items = [];
  const add = (key, count, text, href) => { if (count) items.push({ key, count, text, href }); };
  if (canWrite) {
    const inScope = scopeFor(user, jobs, ownerOf);
    const mine = apps.filter(inScope);
    const of = (key) => mine.filter((a) => CHECKS[key](a, now));
    const hrefFor = (found, key, hash = '') => (found.length === 1 ? `/admin/applications/${found[0].id}${hash}` : `/admin?tab=applications&todo=${key}`);
    const unread = of('unread');
    add('unread', unread.length, plural(unread.length, 'candidate wrote back and is waiting for a reply', 'candidates wrote back and are waiting for a reply'), hrefFor(unread, 'unread', '#messages'));
    const due = interviews.feedbackDue(mine);
    add('feedback', due.length, plural(due.length, 'interview finished with no feedback yet', 'interviews finished with no feedback yet'), due.length === 1 ? `/admin/interviews/${due[0].app.id}/${due[0].id}/feedback` : '/admin?tab=interviews');
    const waiting = of('waiting');
    add('waiting', waiting.length, `${plural(waiting.length, 'candidate has', 'candidates have')} waited over ${WAITING_DAYS} days without moving on`, hrefFor(waiting, 'waiting'));
  }
  if (canEnquire) {
    const everyone = agencyRoles.can(user, 'workload.view');
    const n = enquiries.filter((h) => everyone || [user.id, ''].includes(h.ownerId || '')).length;
    add('enquiries', n, plural(n, 'company enquiry hasn’t been called yet', 'company enquiries haven’t been called yet'), '/admin?tab=hire-requests&waiting=1');
  }
  return { show: canWrite || canEnquire, items };
}

module.exports = { build, matches, scopeFor, LABELS };
