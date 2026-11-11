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
const istToday = (now) => new Date(now + 5.5 * 36e5).toISOString().slice(0, 10);
// An approved offer still waiting for an answer after the date the company asked for one.
const offerLapsed = (a, now = Date.now()) => ats.liveOffers(a).some((o) => o.approval.status === 'approved' && o.response.status === 'awaiting' && o.respondBy && o.respondBy < istToday(now));
// The candidate accepted, but nobody has marked them Hired (or closed the application).
const acceptedNotHired = (a) => Boolean(ats.acceptedOffer(a)) && !ats.CLOSED.includes(a.status);
// Interview times offered for the candidate to choose from, none chosen, and every one now past.
const timesRanOut = (a, now = Date.now()) => Boolean(a.interviewOptions) && a.interviewOptions.status === 'open' && (a.interviewOptions.slots || []).every((s) => Date.parse(s.at) <= now);

// Each one decides whether an application belongs under that heading for this person.
const CHECKS = {
  unread: (a, job, m) => can(m, 'applicants.contact', job) && messages.unreadFor(a, 'hiring') > 0,
  waiting: (a, job, m, now) => can(m, 'applicants.manage', job) && ['New', 'Screening'].includes(ats.stageOf(a)) && now - Date.parse(lastMove(a)) >= WAITING_DAYS * DAY,
  // Someone else approves an offer a person made, unless they own the company (ats.decideOffer).
  unpicked: (a, job, m, now) => can(m, 'interviews.manage', job) && timesRanOut(a, now),
  hire: (a, job, m) => can(m, 'applicants.manage', job) && acceptedNotHired(a),
  lapsed: (a, job, m, now) => can(m, 'offers.respond', job) && offerLapsed(a, now),
  offers: (a, job, m) => can(m, 'offers.approve', job) && (a.offers || []).some((o) => !o.withdrawnAt && o.approval && o.approval.status === 'pending' && (o.createdByUserId !== m.userId || m.role === 'owner')),
};
const LABELS = { unread: 'New replies from applicants', waiting: `Waiting over ${WAITING_DAYS} days with no move`, offers: 'Offers to approve', unpicked: 'Interview times offered that all passed unpicked', hire: 'Accepted an offer, not yet marked Hired', lapsed: 'Offers past their reply-by date with no answer' };
// Only the filters above: ?todo=constructor and the like are ignored.
const todoKey = (value) => (Object.hasOwn(LABELS, String(value)) ? String(value) : '');
// The Interviews page's own filters (/employer/interviews?todo=feedback|reschedule).
const FEEDBACK_LABEL = 'Finished interviews with no feedback yet';
const IV_TODO = { feedback: FEEDBACK_LABEL, reschedule: 'Candidates who asked for another interview time' };
const ivTodoKey = (value) => (Object.hasOwn(IV_TODO, String(value)) ? String(value) : '');
const matches = (key, a, job, member, now = Date.now()) => Object.hasOwn(CHECKS, key) && live(a) && CHECKS[key](a, job, member, now);

const feedbackDue = (a, job, m, now) => (live(a) && can(m, 'feedback.submit', job) ? (a.interviews || []).filter((iv) => {
  const end = Date.parse(iv.at) + (iv.duration || 0) * 60000;
  return iv.status === 'scheduled' && !(iv.feedback || []).length && now - end >= FEEDBACK_DUE_HOURS * 36e5 && now - end <= FEEDBACK_WINDOW_DAYS * DAY;
}) : []);

// Upcoming interviews whose candidate asked for another time, for people who can move them.
const rescheduleAsked = (a, job, m, now) => (live(a) && can(m, 'interviews.manage', job) ? (a.interviews || []).filter((iv) => iv.status === 'scheduled' && iv.confirmation === 'reschedule-requested' && Date.parse(iv.at) > now) : []);

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
  const asked = mine.filter((a) => rescheduleAsked(a, own.get(a.jobId), member, now).length);
  const askedCount = asked.reduce((n, a) => n + rescheduleAsked(a, own.get(a.jobId), member, now).length, 0);
  add('reschedule', askedCount, plural(askedCount, 'candidate asked for another interview time', 'candidates asked for another interview time'), asked.length === 1 ? `/employer/applicants/${asked[0].id}#interviews` : '/employer/interviews?todo=reschedule');
  const hire = of('hire');
  add('hire', hire.length, `${plural(hire.length, 'candidate', 'candidates')} accepted an offer and ${plural(hire.length, 'isn’t', 'aren’t')} marked Hired yet`, hrefFor(hire, 'hire', '#offers'));
  const lapsed = of('lapsed');
  add('lapsed', lapsed.length, `${plural(lapsed.length, 'offer is', 'offers are')} past the reply-by date with no answer`, hrefFor(lapsed, 'lapsed', '#offers'));
  const unpicked = of('unpicked');
  add('unpicked', unpicked.length, `${plural(unpicked.length, 'candidate', 'candidates')} didn’t pick any of the interview times offered, and they have all passed`, hrefFor(unpicked, 'unpicked'));
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

module.exports = { build, matches, lastMove, feedbackDue, rescheduleAsked, timesRanOut, offerLapsed, acceptedNotHired, todoKey, LABELS, FEEDBACK_LABEL, IV_TODO, ivTodoKey, WAITING_DAYS };
