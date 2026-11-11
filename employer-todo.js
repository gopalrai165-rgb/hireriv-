// What needs someone at a company today, on the employer dashboard: replies
// nobody has read, applicants left waiting, interviews with no feedback, offers
// to approve and jobs about to close. Only jobs the company runs itself, and
// only what this person's role lets them act on. The list only points: nobody
// is moved, rejected or sent anything from here.
const { can } = require('./employer-team');
const ats = require('./ats');
const messages = require('./messages');

const DAY = 864e5;
const WAITING_DAYS = 7;
const CLOSING_DAYS = 7;
// The same window as the feedback reminder in notify-events.js.
const FEEDBACK_DUE_HOURS = 2;
const FEEDBACK_WINDOW_DAYS = 14;

const lastMove = (a) => {
  const h = a.history || [];
  return (h.length && h[h.length - 1].at) || a.createdAt;
};
const live = (a) => !a.withdrawnAt && !a.duplicateOf;

// Each one decides whether an application belongs under that heading for this person.
const CHECKS = {
  unread: (a, job, m) => can(m, 'applicants.contact', job) && messages.unreadFor(a, 'hiring') > 0,
  waiting: (a, job, m, now) => can(m, 'applicants.manage', job) && ['New', 'Screening'].includes(ats.stageOf(a)) && now - Date.parse(lastMove(a)) >= WAITING_DAYS * DAY,
  // Someone else approves an offer a person made, unless they own the company (ats.decideOffer).
  offers: (a, job, m) => can(m, 'offers.approve', job) && (a.offers || []).some((o) => !o.withdrawnAt && o.approval && o.approval.status === 'pending' && (o.createdByUserId !== m.userId || m.role === 'owner')),
};
const LABELS = { unread: 'New replies from applicants', waiting: `Waiting over ${WAITING_DAYS} days with no move`, offers: 'Offers to approve' };
// The Interviews page's own filter (/employer/interviews?todo=feedback).
const FEEDBACK_LABEL = 'Finished interviews with no feedback yet';
const matches = (key, a, job, member, now = Date.now()) => Boolean(CHECKS[key]) && live(a) && CHECKS[key](a, job, member, now);

const feedbackDue = (a, job, m, now) => (live(a) && can(m, 'feedback.submit', job) ? (a.interviews || []).filter((iv) => {
  const end = Date.parse(iv.at) + (iv.duration || 0) * 60000;
  return iv.status === 'scheduled' && !(iv.feedback || []).length && now - end >= FEEDBACK_DUE_HOURS * 36e5 && now - end <= FEEDBACK_WINDOW_DAYS * DAY;
}) : []);

const plural = (n, one, many) => (n === 1 ? one : many);

// `jobs`: the jobs this person can see; `apps`: applications, any job.
function build({ member, jobs, apps, now = Date.now() }) {
  const own = new Map(jobs.filter((j) => j.createdBy === 'employer').map((j) => [j.id, j]));
  const mine = apps.filter((a) => own.has(a.jobId));
  const items = [];
  const add = (key, count, text, href) => { if (count) items.push({ key, count, text, href }); };
  // One person goes straight to them; several go to the list.
  const hrefFor = (found, key, hash = '') => (found.length === 1 ? `/employer/applicants/${found[0].id}${hash}` : `/employer/applicants?todo=${key}`);

  const of = (key) => mine.filter((a) => matches(key, a, own.get(a.jobId), member, now));
  const unread = of('unread');
  add('unread', unread.length, plural(unread.length, 'applicant wrote to you and is waiting for a reply', 'applicants wrote to you and are waiting for a reply'), hrefFor(unread, 'unread', '#messages'));
  const offers = of('offers');
  add('offers', offers.length, plural(offers.length, 'offer needs your approval before the candidate sees it', 'offers need your approval before the candidates see them'), hrefFor(offers, 'offers', '#offers'));
  const due = mine.filter((a) => feedbackDue(a, own.get(a.jobId), member, now).length);
  const dueCount = due.reduce((n, a) => n + feedbackDue(a, own.get(a.jobId), member, now).length, 0);
  add('feedback', dueCount, plural(dueCount, 'interview finished with no feedback yet', 'interviews finished with no feedback yet'), due.length === 1 ? `/employer/applicants/${due[0].id}#interviews` : '/employer/interviews?todo=feedback');
  const waiting = of('waiting');
  add('waiting', waiting.length, `${plural(waiting.length, 'applicant has', 'applicants have')} waited over ${WAITING_DAYS} days without moving on`, hrefFor(waiting, 'waiting'));
  const today = new Date(now + 5.5 * 36e5).toISOString().slice(0, 10);
  const until = new Date(Date.parse(today) + CLOSING_DAYS * DAY).toISOString().slice(0, 10);
  const closing = [...own.values()].filter((j) => j.status === 'open' && j.closesOn && j.closesOn >= today && j.closesOn <= until && can(member, 'job.edit', j));
  add('closing', closing.length, `${plural(closing.length, 'job closes', 'jobs close')} within ${CLOSING_DAYS} days`, '/employer/jobs');

  // Only for people who act on applicants: a viewer has nothing to be up to date on.
  const acts = [...own.values()].some((j) => can(member, 'applicants.manage', j) || can(member, 'applicants.contact', j));
  return { show: acts, items };
}

module.exports = { build, matches, lastMove, feedbackDue, LABELS, FEEDBACK_LABEL, WAITING_DAYS };
