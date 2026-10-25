// The notification service and center, against the Step 52 QA checklist:
// in-app notifications for applications and interviews reach the right people,
// people see, filter and mark only their own, preferences control optional
// email, failed emails retry without repeating the business event, webhooks
// are signed and idempotent, job alerts follow filters, preferences and
// deduplication, and every email template renders as a responsive page.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Emails rendered in this process (template checks) go to a throwaway outbox.
const OUTBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'hireriv-mail-'));
process.env.OUTBOX_DIR = OUTBOX;
process.env.SMTP_HOST = '';
const { startServer, decodeEmail } = require('./helpers');
const { hashPassword } = require('../employers');
const notifyModule = require('../notify');
const { open } = require('../db');

const DAY = 86400000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const istDate = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

// ---------- the service on its own (a throwaway database and a fake clock) ----------
function service() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hireriv-notify-')), 'n.db');
  const db = open(file);
  const clock = { t: Date.parse('2026-10-20T06:00:00Z') };
  const notify = notifyModule.create({ db, now: () => clock.t, log: { error() {} } });
  return { db, notify, clock };
}
const candidate = { kind: 'candidate', email: 'asha@example.in' };

test('an event is stored once per recipient, however often it is emitted', async () => {
  const { db, notify } = service();
  let sent = 0;
  notify.template('t', { resolve: () => ({ to: 'asha@example.in', send: async () => { sent++; return '<m1@x>'; } }) });
  const e = { key: 'application:1', type: 'application-submitted', to: [candidate, candidate], inApp: { title: 'Application received', link: '/account' }, email: { template: 't', refs: { applicationId: '1' } } };
  assert.deepEqual(notify.emit(e), { notifications: 1, deliveries: 1 });
  assert.deepEqual(notify.emit(e), { notifications: 0, deliveries: 0 });
  await notify.work();
  await notify.work();
  assert.equal(sent, 1);
  assert.equal(db.all('notifications').length, 1);
  const [d] = db.all('notification-deliveries');
  assert.equal(d.status, 'sent');
  assert.equal(d.providerRef, '<m1@x>');
  assert.equal(JSON.stringify(d).includes('asha@'), false, 'no address in the delivery record');
  assert.equal(JSON.stringify(db.all('notifications')).includes('asha@'), false, 'nor in the notification');
});

test('a failed email retries with backoff, then gives up, without repeating the event', async () => {
  const { db, notify, clock } = service();
  let tries = 0;
  notify.template('flaky', { resolve: () => ({ to: 'asha@example.in', send: async () => { tries++; if (tries < 3) throw new Error('SMTP down'); return true; } }) });
  notify.template('dead', { resolve: () => ({ to: 'asha@example.in', send: async () => false }) });
  notify.emit({ key: 'k1', type: 'interview-invited', to: [candidate], inApp: { title: 'Interview' }, email: { template: 'flaky' } });
  await notify.work();
  let d = db.all('notification-deliveries')[0];
  assert.deepEqual([d.status, d.attempts, d.lastError], ['queued', 1, 'SMTP down']);
  await notify.work();
  assert.equal(tries, 1, 'not before the backoff');
  clock.t += 60 * 1000;
  await notify.work();
  assert.equal(db.all('notification-deliveries')[0].attempts, 2);
  clock.t += 5 * 60 * 1000;
  await notify.work();
  d = db.all('notification-deliveries')[0];
  assert.deepEqual([d.status, d.attempts, tries], ['sent', 3, 3]);
  assert.equal(db.all('notifications').length, 1, 'retries never add notifications');

  notify.emit({ key: 'k2', type: 'interview-invited', to: [candidate], email: { template: 'dead' } });
  for (const m of [0, 1, 5, 30, 120]) { clock.t += m * 60000; await notify.work(); }
  d = db.all('notification-deliveries').find((x) => x.event === 'k2');
  assert.deepEqual([d.status, d.attempts], ['failed', notifyModule.MAX_ATTEMPTS]);
  assert.equal(notify.stats().failed24h, 1);
  assert.match(notify.problems()[0], /failed/);
  assert.equal(notify.retry(d.id), true);
  assert.equal(db.all('notification-deliveries').find((x) => x.event === 'k2').status, 'queued');
});

test('the business change and its notifications commit or fail together', () => {
  const { db, notify } = service();
  notify.template('t', { resolve: () => null });
  assert.throws(() => db.transaction(() => {
    db.prepend('applications', { id: 'a1' });
    notify.emit({ key: 'x', type: 'application-submitted', to: [candidate], inApp: { title: 'x' }, email: { template: 't' } });
    throw new Error('saving failed');
  }));
  assert.equal(db.all('applications').length, 0);
  assert.equal(db.all('notifications').length, 0);
  assert.equal(db.all('notification-deliveries').length, 0);
});

test('preferences switch off optional email only; bounced addresses are skipped', async () => {
  const { db, notify } = service();
  notify.template('t', { resolve: () => ({ to: 'asha@example.in', send: async () => true }) });
  const rk = notify.candidateRk('asha@example.in');
  notify.setPrefs(rk, { email: { jobs: false, account: false } });
  assert.equal(notify.prefsOf(rk).email.jobs, false);
  assert.equal(notify.prefsOf(rk).email.account, undefined, 'account email is not a preference');
  notify.emit({ key: 'alert', type: 'job-alert', to: [candidate], inApp: { title: 'New job' }, email: { template: 't' } });
  notify.emit({ key: 'invite', type: 'interview-invited', to: [candidate], inApp: { title: 'Interview' }, email: { template: 't' } });
  assert.deepEqual(db.all('notification-deliveries').map((d) => d.type), ['interview-invited']);
  assert.equal(db.all('notifications').length, 2, 'in-app either way');
  notify.suppress('Asha@Example.in', 'bounced');
  notify.emit({ key: 'invite2', type: 'interview-invited', to: [candidate], email: { template: 't' } });
  await notify.work();
  const d = db.all('notification-deliveries').find((x) => x.event === 'invite2');
  assert.equal(d.status, 'skipped');
  assert.match(d.lastError, /bounced/);
});

test('webhooks: only correctly signed, recent requests; each event once; bounces stop email', async () => {
  const { db, notify, clock } = service();
  notify.template('t', { resolve: () => ({ to: 'asha@example.in', send: async () => '<abc@hireriv>' }) });
  notify.emit({ key: 'k', type: 'offer-received', to: [candidate], email: { template: 't' } });
  await notify.work();
  const secret = 'whsec-test';
  const body = Buffer.from(JSON.stringify({ events: [{ id: 'ev1', type: 'delivered', messageId: '<abc@hireriv>' }] }));
  const sign = (b, ts = Math.floor(clock.t / 1000), key = secret) => `t=${ts},v1=${crypto.createHmac('sha256', key).update(`${ts}.`).update(b).digest('hex')}`;
  assert.equal(notify.verifySignature(body, sign(body), secret), true);
  assert.equal(notify.verifySignature(body, sign(body, undefined, 'other'), secret), false);
  assert.equal(notify.verifySignature(body, sign(body, Math.floor(clock.t / 1000) - 600), secret), false, 'replayed');
  assert.equal(notify.verifySignature(Buffer.from(body.toString().replace('delivered', 'bounced')), sign(body), secret), false, 'tampered');
  assert.equal(notify.verifySignature(body, '', secret), false);
  assert.deepEqual(notify.applyWebhook(JSON.parse(body).events), { applied: 1, duplicates: 0, ignored: 0 });
  assert.deepEqual(notify.applyWebhook(JSON.parse(body).events), { applied: 0, duplicates: 1, ignored: 0 });
  assert.equal(db.all('notification-deliveries')[0].status, 'delivered');
  notify.applyWebhook([{ id: 'ev2', type: 'bounced', messageId: '<abc@hireriv>', recipient: 'asha@example.in' }, { id: 'ev3', type: 'delivered', messageId: '<abc@hireriv>' }, { id: 'ev4', type: 'delivered', messageId: '<nope>' }]);
  assert.equal(db.all('notification-deliveries')[0].status, 'bounced', 'a late "delivered" does not undo a bounce');
  assert.equal(db.all('email-suppressions').length, 1);
  assert.equal(JSON.stringify(db.all('email-suppressions')).includes('asha'), false, 'only a fingerprint is kept');
});

test('people only see and change their own notifications', () => {
  const { notify } = service();
  notify.emit({ key: 'a', type: 'new-application', to: [{ kind: 'employer', userId: 'u1', employerId: 'A' }, { kind: 'employer', userId: 'u2', employerId: 'A' }], inApp: { title: 'New application', jobId: 'j1', perm: 'applicants.view' } });
  notify.emit({ key: 'b', type: 'new-application', to: [{ kind: 'employer', userId: 'u1', employerId: 'B' }], inApp: { title: 'From B' } });
  notify.emit({ key: 'c', type: 'job-alert', to: [candidate], inApp: { title: 'Job', link: 'https://evil.example/x' } });
  const u1A = { rk: 'e:u1', employerId: 'A' };
  const u2A = { rk: 'e:u2', employerId: 'A' };
  assert.deepEqual(notify.list(u1A).items.map((n) => n.title), ['New application'], 'only the company signed in to');
  assert.deepEqual(notify.list({ rk: 'e:u1', employerId: 'B' }).items.map((n) => n.title), ['From B']);
  assert.equal(notify.list({ ...u1A, visible: () => false }).items.length, 0, 'filtered by the current role');
  const theirs = notify.list(u2A).items[0];
  assert.equal(notify.markRead(u1A, theirs.id), null, "someone else's");
  assert.equal(notify.list(u2A).unread, 1);
  assert.equal(notify.markAllRead(u1A), 1);
  assert.equal(notify.list(u2A).unread, 1);
  assert.equal(notify.list({ rk: notify.candidateRk('asha@example.in') }).items[0].link, '', 'links stay on this site');
  notify.forgetCompany('e:u1', 'A');
  assert.equal(notify.list(u1A).total, 0);
  assert.equal(notify.list({ rk: 'e:u1', employerId: 'B' }).total, 1);
});

// ---------- the scheduled checks and stage moves (fake records) ----------
test('feedback due, offer deadlines and stage moves notify the right people once', () => {
  const { notify } = service();
  const notifyEvents = require('../notify-events');
  const now = Date.now();
  const jobA = { id: 'j1', title: 'Packer', createdBy: 'employer', employerId: 'A', status: 'open' };
  const members = [{ id: 'm1', userId: 'u-owner', employerId: 'A', role: 'owner' }, { id: 'm2', userId: 'u-rec', employerId: 'A', role: 'recruiter', jobIds: ['j1'] }, { id: 'm3', userId: 'u-view', employerId: 'A', role: 'viewer' }];
  const users = Object.fromEntries(['u-owner', 'u-rec', 'u-view'].map((id) => [id, { id, name: id, email: `${id}@a.in`, active: true, emailVerifiedAt: iso(DAY) }]));
  const apps = [{
    id: 'a1', jobId: 'j1', jobTitle: 'Packer', name: 'Asha', email: 'asha@example.in', status: 'Interview', assignedTo: 'u-rec',
    interviews: [{ id: 'iv-done', at: new Date(now - 5 * 3600000).toISOString(), duration: 30, status: 'scheduled', feedback: [] }, { id: 'iv-soon', at: new Date(now - 30 * 60000).toISOString(), duration: 30, status: 'scheduled', feedback: [] }],
    offers: [{ id: 'o1', respondBy: istDate(now + DAY), approval: { status: 'approved' }, response: { status: 'awaiting' } }],
  }];
  const events = notifyEvents.create({
    notify, mailer: {}, site: { name: 'Hireriv', email: 'hello@hireriv.in' }, baseUrl: 'http://x', db: null, readSubmissions: () => apps, getJobs: () => [jobA],
    formatIst: (d) => d.toISOString(), interviewIcs: () => '', appOwner: () => '', team: { byId: () => null, members: () => [] }, hasAccount: () => true, jobPath: (j) => `/jobs/${j.id}`,
    clients: () => ({ read: () => [{ id: 'A', company: 'A Co', active: true }], team: { membersOf: () => members, userById: (id) => users[id], membership: (u, e) => members.find((m) => m.userId === u && m.employerId === e), owners: () => [members[0]] } }),
  });
  assert.equal(events.feedbackDueScan(now), 1, 'only the interview that ended over 2 hours ago');
  assert.equal(events.feedbackDueScan(now), 0, 'once');
  assert.deepEqual(notify.list({ rk: 'e:u-rec', employerId: 'A' }).items.map((n) => n.title), ['Feedback due for Packer']);
  assert.equal(notify.list({ rk: 'e:u-view', employerId: 'A' }).total, 0);
  const today = istDate(now);
  assert.equal(events.offerDeadlineScan(today), 1);
  assert.equal(events.offerDeadlineScan(today), 0);
  assert.equal(notify.list({ rk: notify.candidateRk('asha@example.in') }).items[0].title, 'Reply to your offer: Packer');
  // A move the candidate can see notifies them; an internal one doesn't.
  events.stageMoved(apps[0], { at: iso(0), from: 'Screening', to: 'Shortlisted', userId: 'u-owner' });
  events.stageMoved(apps[0], { at: iso(1), from: 'Shortlisted', to: 'Rejected', userId: 'u-owner' });
  const seen = notify.list({ rk: notify.candidateRk('asha@example.in') }).items.map((n) => n.body);
  assert.ok(seen.includes('Status: Not selected.'));
  assert.ok(!seen.some((b) => /Shortlisted|Under review/.test(b)), 'Screening → Shortlisted looks the same to the candidate');
  // The assigned recruiter hears when someone else moved their applicant.
  assert.equal(notify.list({ rk: 'e:u-rec', employerId: 'A' }).items.filter((n) => n.title === 'Stage changed for Packer').length, 2);
});

// ---------- every email template ----------
test('every email renders as a responsive branded page with a text version and no contact details in the subject', async () => {
  const { createMailer } = require('../mailer');
  const site = { name: 'Hireriv', phone: '+91 98000 00000', email: 'hello@hireriv.in' };
  const m = createMailer(site);
  const a = { id: 'a1', name: 'Asha Kumar', email: 'asha@example.in', phone: '9845012345', jobTitle: 'Forklift Operator', status: 'Interview', skills: 'Forklift' };
  const iv = { id: 'iv1', at: new Date(Date.now() + DAY).toISOString(), duration: 45, mode: 'In person', where: 'Plot 4, Bhosari', interviewer: 'Rita', candidateNote: '' };
  const who = { name: 'Rita Rao', email: 'rita@aco.in', company: 'A Co' };
  const job = { id: 'j1', title: 'Forklift Operator', company: 'A Co', location: 'Pune', mode: 'On-site', type: 'Full-time', experience: '1-2 years', salary: '', skills: ['Forklift'], description: 'Drive forklifts safely.' };
  const offer = { joiningDate: '2026-11-10', respondBy: '2026-10-30' };
  const ics = 'BEGIN:VCALENDAR\r\nEND:VCALENDAR';
  const sends = [
    () => m.applicationConfirmation(a), () => m.applicationToTeam(a), () => m.applicationUpdatedConfirmation(a), () => m.applicationUpdatedToTeam(a),
    () => m.interviewScheduled(a, iv, ics, 'Mon 26 Oct, 11:00'), () => m.interviewRescheduled(a, iv, ics, 'Tue 27 Oct, 11:00', 'Mon 26 Oct, 11:00'),
    () => m.interviewReminder(a, iv, 'Mon 26 Oct, 11:00', 'day'), () => m.interviewerReminder('rita@aco.in', a, iv, 'Mon', 'hour'), () => m.interviewCancelled(a, iv, ics, 'Mon'),
    () => m.interviewResponse(who, a, iv, 'Mon', true, '', 'http://x/employer'), () => m.employerNewApplication(who, a, 'http://x/employer'),
    () => m.offerMade(a, 'A Co', offer), () => m.offerDeadline(a, 'A Co', offer), () => m.statusChanged(a), () => m.jobAlert({ email: 'asha@example.in', token: 'f'.repeat(48), category: '', location: 'Pune' }, job),
    () => m.employerJobDecision({ ...who }, job, false, 'Add the pay', 'http://x/edit'), () => m.notice({ ...who, kind: 'employer' }, { subject: 'Feedback due for Forklift Operator', heading: 'Feedback due', intro: 'the interview with Asha <b> has no scorecard.', link: 'http://x', why: 'feedback' }),
    () => m.accountDeleted('asha@example.in'), () => m.candidatePasswordChanged('asha@example.in', 'changed'),
  ];
  for (const s of sends) assert.ok(await s(), 'sent');
  const files = fs.readdirSync(OUTBOX).sort();
  assert.equal(files.length, sends.length);
  for (const f of files) {
    const raw = fs.readFileSync(path.join(OUTBOX, f), 'utf8');
    const eml = decodeEmail(raw);
    const subject = (/^Subject: (.*)$/m.exec(raw) || [])[1] || '';
    assert.ok(subject, f);
    assert.doesNotMatch(subject, /asha@|9845012345|Asha/, `${f}: no candidate details in the subject`);
    assert.match(eml, /name="viewport"/, f);
    assert.match(eml, /max-width:560px/, f);
    assert.match(eml, /Hire<span[^>]*>riv/, f);
    assert.match(raw, /Content-Type: text\/plain/, `${f}: text version`);
    assert.doesNotMatch(eml, /width="600"|width:600px/, f);
  }
  const notice = decodeEmail(fs.readFileSync(path.join(OUTBOX, files[16]), 'utf8'));
  assert.match(notice, /Asha &lt;b&gt;/, 'notice text is escaped');
  assert.match(notice, /notifications\/settings/, 'optional emails link to the settings');
  fs.rmSync(OUTBOX, { recursive: true, force: true });
});

// ---------- the whole app ----------
const job = (id, extra) => ({
  id, title: `Job ${id}`, company: 'A Co', location: 'Pune', mode: 'On-site', type: 'Full-time', category: 'Technology', experience: '2-4 years',
  salary: '', pay: null, posted: istDate(Date.now() - 5 * DAY), approvedAt: iso(5 * DAY), skills: ['Forklift', 'Safety'], description: 'A real job.', responsibilities: [],
  status: 'open', closesOn: null, sample: false, createdBy: 'employer', employerId: 'emp-a', alertsSentAt: iso(5 * DAY), ...extra,
});
const owner = (id, company, email) => ({ id, company, name: email.split('@')[0], email, passwordHash: hashPassword('owner long password'), passwordSetAt: iso(DAY), active: true, createdAt: iso(30 * DAY) });

let srv;
const people = {};
let ip = 0;
const headers = (extra = {}) => ({ 'x-forwarded-for': `10.9.${Math.floor(++ip / 250)}.${ip % 250}`, ...extra });
const get = (url, cookie) => srv.request(url, { cookie, headers: headers() });
const post = (url, form, cookie) => srv.request(url, { method: 'POST', form, cookie, headers: headers() });
const json = (url, method, body, cookie) => srv.request(url, { method, cookie, body: body === undefined ? undefined : JSON.stringify(body), headers: headers({ 'content-type': 'application/json', accept: 'application/json' }) });
const api = async (url, cookie) => (await json(url, 'GET', undefined, cookie)).json();
const rec = (id) => srv.records('applications').find((a) => a.id === id);
const settle = () => new Promise((r) => setTimeout(r, 400));

before(async () => {
  srv = await startServer({ TRUST_PROXY: '1', EMAIL_WEBHOOK_SECRET: 'whsec-app' }, {
    employers: [owner('emp-a', 'A Co', 'olga@aco.in'), owner('emp-b', 'B Co', 'bob@bco.in')],
    jobs: [job('j1'), job('j2', { title: 'Job j2' }), job('j3', { employerId: 'emp-b', company: 'B Co' }), job('t1', { createdBy: undefined, employerId: undefined, title: 'Team-run', ownerId: 'owner' })],
    applications: [
      { id: 'b1', jobId: 'j3', jobTitle: 'Job j3', name: 'Bilal', email: 'bilal@example.in', phone: '9800000001', status: 'New', notes: '', createdAt: iso(DAY) },
    ],
  });
  people.olga = srv.cookieFrom(await post('/employer/login', { email: 'olga@aco.in', password: 'owner long password' }));
  people.bob = srv.cookieFrom(await post('/employer/login', { email: 'bob@bco.in', password: 'owner long password' }));
  people.admin = await srv.adminLogin();
  // Rita: a recruiter on j1 only.
  const body = new URLSearchParams([['name', 'Rita'], ['email', 'rita@aco.in'], ['role', 'recruiter'], ['jobIds', 'j1']]).toString();
  await srv.request('/employer/team', { method: 'POST', body, cookie: people.olga, headers: headers({ 'content-type': 'application/x-www-form-urlencoded' }) });
  const link = decodeEmail(await srv.waitForEmail((m) => m.includes('To: rita@aco.in'))).match(/\/employer\/setup\/[a-f0-9]{64}/)[0];
  people.rita = srv.cookieFrom(await post(link, { password: 'Rita long password', confirm: 'Rita long password' }));
}, { timeout: 30000 });
after(() => srv && srv.stop());

async function register(name, email) {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ name, email, phone: '9845012345', location: 'Pune', agree: '1' })) fd.append(k, v);
  await srv.request('/account/register', { method: 'POST', body: fd, headers: headers() });
  await srv.waitForEmail((m) => m.includes(`To: ${email}`) && decodeEmail(m).includes('/account/verify/'));
  const link = decodeEmail(srv.emails().filter((m) => m.includes(`To: ${email}`) && decodeEmail(m).includes('/account/verify/')).pop()).match(/\/account\/verify\/[a-f0-9]{64}/)[0];
  return srv.cookieFrom(await post(link, {}));
}
async function apply(jobId, name, email, skills = 'Forklift, Safety') {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ jobId, name, email, phone: '9845012345', skills })) fd.append(k, v);
  fd.append('resume', new Blob(['%PDF-1.4 test'], { type: 'application/pdf' }), 'cv.pdf');
  const res = await srv.request('/api/apply', { method: 'POST', body: fd, headers: headers({ accept: 'application/json' }) });
  assert.equal(res.status, 200, await res.text());
  return srv.records('applications').find((a) => a.email === email && a.jobId === jobId);
}

test('applying creates the right notifications for the candidate and the people on the job', async () => {
  const a = await apply('j1', 'Asha Kumar', 'asha@example.in');
  await apply('j2', 'Dev Rao', 'dev@example.in');
  await apply('t1', 'Tara Sen', 'tara@example.in');
  await settle();
  people.asha = await register('Asha Kumar', 'asha@example.in');
  const mine = await api('/api/notifications', people.asha);
  assert.equal(mine.as, 'candidate');
  assert.deepEqual(mine.notifications.map((n) => n.title), ['Application received: Job j1']);
  assert.equal(mine.notifications[0].link, '/account#applications');

  // Olga (owner) hears about both A Co jobs; Rita only about j1; B Co nothing.
  const olga = (await api('/api/notifications', people.olga)).notifications.map((n) => n.title);
  assert.deepEqual(olga.sort(), ['Strong match: new application for Job j1', 'Strong match: new application for Job j2']);
  assert.deepEqual((await api('/api/notifications', people.rita)).notifications.map((n) => n.title), ['Strong match: new application for Job j1']);
  assert.deepEqual((await api('/api/notifications', people.bob)).notifications, []);
  // The team owner of the team-run job sees it in-app.
  assert.ok((await api('/api/notifications', people.admin)).notifications.some((n) => n.title.includes('Team-run')));
  // Emails: candidate confirmation, the team inbox, and the people on j1.
  await srv.waitForEmail((m) => m.includes('To: asha@example.in') && m.includes("received your application"));
  await srv.waitForEmail((m) => m.includes('To: rita@aco.in') && m.includes('New applicant for Job j1'));
  assert.equal(srv.emails().filter((m) => m.includes('To: rita@aco.in') && m.includes('Job j2')).length, 0);
  people.a1 = a.id;
});

test('the notification center: view, filter, open, mark read, and nobody else\'s', async () => {
  const page = await (await get('/notifications', people.olga)).text();
  assert.match(page, /Strong match: new application for Job j1/);
  assert.match(page, /2 unread/);
  assert.match(await (await get('/employer', people.olga)).text(), /bell-count[^>]*>2</, 'the bell shows the count');
  const list = (await api('/api/notifications?category=applications&unread=1', people.olga)).notifications;
  assert.equal(list.length, 2);
  assert.equal((await api('/api/notifications?category=interviews', people.olga)).notifications.length, 0);
  // Opening one marks it read and goes to the applicant.
  const open = await get(`/notifications/${list[0].id}/open`, people.olga);
  assert.match(open.headers.get('location'), /^\/employer\/applicants\//);
  assert.equal((await api('/api/notifications/unread-count', people.olga)).unread, 1);
  // Rita can't read or mark Olga's.
  const other = list[1].id;
  assert.equal((await json(`/api/notifications/${other}/read`, 'PATCH', {}, people.rita)).status, 404);
  assert.equal((await post(`/notifications/${other}/read`, {}, people.rita)).status, 404);
  assert.equal((await get(`/notifications/${other}/open`, people.rita)).headers.get('location'), '/notifications');
  assert.equal((await api('/api/notifications/unread-count', people.olga)).unread, 1);
  assert.equal((await json(`/api/notifications/${other}/read`, 'PATCH', {}, people.olga)).status, 200);
  const rita = (await api('/api/notifications', people.rita)).notifications[0];
  const r = await (await json('/api/notifications/read-all', 'POST', {}, people.rita)).json();
  assert.equal(r.marked, 1);
  assert.equal((await api(`/api/notifications?unread=1`, people.rita)).notifications.length, 0);
  assert.ok(rita);
  // Signed out: nothing.
  assert.equal((await json('/api/notifications', 'GET')).status, 401);
  assert.equal((await get('/notifications')).status, 401);
  // A forged ?as= for an account you're not signed in to is ignored.
  assert.equal((await api('/api/notifications?as=team', people.olga)).as, 'employer');
});

test('interview invitations, new times and cancellations reach the candidate; answers reach the team', async () => {
  const tomorrow = istDate(Date.now() + DAY);
  const ok = await json(`/api/ats/applications/${people.a1}/stage`, 'PATCH', { stage: 'Shortlisted' }, people.rita);
  assert.equal(ok.status, 200);
  const booked = await json(`/api/ats/applications/${people.a1}/interviews`, 'POST', { date: tomorrow, time: '11:00', duration: 45, mode: 'Phone', where: '9800000000', interviewer: 'Rita', interviewerEmail: 'rita@aco.in' }, people.rita);
  assert.equal(booked.status, 201);
  const iv = (await booked.json()).interview;
  await srv.waitForEmail((m) => m.includes('To: asha@example.in') && m.includes('Interview scheduled'));
  let titles = (await api('/api/notifications', people.asha)).notifications.map((n) => n.title);
  assert.ok(titles.includes('Interview invitation: Job j1'), titles.join());
  assert.ok(!titles.some((t) => /Shortlisted/.test(t)), 'internal stages stay internal');

  // Asha asks for another time; the people on the job hear about it.
  const ask = await post(`/account/interviews/${people.a1}/${iv.id}/reschedule`, { note: 'Afternoons please' }, people.asha);
  assert.equal(ask.status, 302);
  const olgaHeard = (await api('/api/notifications?category=interviews', people.olga)).notifications;
  assert.equal(olgaHeard[0].title, 'New time requested for Job j1');
  await srv.waitForEmail((m) => m.includes('To: olga@aco.in') && m.includes('New time requested for Job j1'));

  // Rita moves it; Asha gets the new time to confirm.
  const moved = await json(`/api/ats/interviews/${iv.id}/reschedule`, 'POST', { date: tomorrow, time: '15:00' }, people.rita);
  assert.equal(moved.status, 200);
  const mv = (await moved.json()).interview;
  assert.deepEqual([mv.confirmation, mv.sequence], ['awaiting', 1]);
  assert.equal((await json(`/api/ats/interviews/${iv.id}/reschedule`, 'POST', { date: tomorrow, time: '23:00' }, people.rita)).status, 400, 'same rules as booking');
  assert.equal((await json(`/api/ats/interviews/${iv.id}/reschedule`, 'POST', { date: tomorrow, time: '15:00' }, people.bob)).status, 404);
  await srv.waitForEmail((m) => m.includes('To: asha@example.in') && m.includes('Interview moved'));
  titles = (await api('/api/notifications', people.asha)).notifications.map((n) => n.title);
  assert.ok(titles.includes('Interview moved: Job j1'));

  const cancel = await post(`/employer/applicants/${people.a1}/interviews/${iv.id}/cancel`, {}, people.rita);
  assert.equal(cancel.status, 302);
  await srv.waitForEmail((m) => m.includes('To: asha@example.in') && m.includes('Interview cancelled'));
  titles = (await api('/api/notifications?category=interviews', people.asha)).notifications.map((n) => n.title);
  assert.deepEqual(titles, ['Interview cancelled: Job j1', 'Interview moved: Job j1', 'Interview invitation: Job j1']);
  // Each went out once.
  assert.equal(srv.emails().filter((m) => m.includes('To: asha@example.in') && m.includes('Interview scheduled')).length, 1);
});

test('assignments, stage changes by others and offers needing approval reach the right person', async () => {
  // Olga (owner) assigns Asha's application to Rita, then moves it: Rita hears both.
  const ritaId = srv.records('employer-users').find((u) => u.email === 'rita@aco.in').id;
  assert.equal(rec(people.a1).assignedTo, ritaId, 'booking the interview made Rita responsible');
  assert.equal((await json(`/api/ats/applications/${people.a1}/assign`, 'POST', { userId: '' }, people.olga)).status, 200);
  assert.equal((await json(`/api/ats/applications/${people.a1}/assign`, 'POST', { userId: ritaId }, people.olga)).status, 200);
  assert.equal((await json(`/api/ats/applications/${people.a1}/stage`, 'PATCH', { stage: 'On hold' }, people.olga)).status, 200);
  const rita = (await api('/api/notifications', people.rita)).notifications.map((n) => n.title);
  assert.ok(rita.includes('Assigned to you: Job j1'), rita.join());
  assert.ok(rita.includes('Stage changed for Job j1'), rita.join());
  await srv.waitForEmail((m) => m.includes('To: rita@aco.in') && m.includes('An applicant for Job j1 is now yours'));
  // Rita makes an offer: the owner is asked to approve it.
  const made = await json(`/api/ats/applications/${people.a1}/offers`, 'POST', { salary: '22000', respondBy: istDate(Date.now() + DAY) }, people.rita);
  assert.equal(made.status, 201);
  const offer = (await made.json()).offer;
  assert.ok((await api('/api/notifications', people.olga)).notifications.some((n) => n.title === 'Offer to approve for Job j1'));
  assert.equal((await json(`/api/ats/offers/${offer.id}/approve`, 'POST', { approve: true }, people.olga)).status, 200);
  await srv.waitForEmail((m) => m.includes('To: asha@example.in') && m.includes('Job offer: Job j1'));
  assert.ok((await api('/api/notifications', people.asha)).notifications.some((n) => n.title === 'Job offer: Job j1'));
  assert.equal(rec(people.a1).status, 'Offered');
});

test('preferences control optional email; essential messages always go', async () => {
  const p = await api('/api/notification-preferences', people.asha);
  assert.deepEqual(p.email, { applications: true, interviews: true, jobs: true });
  assert.equal((await json('/api/notification-preferences', 'PATCH', { email: { account: false } }, people.asha)).status, 400);
  assert.equal((await json('/api/notification-preferences', 'PATCH', { email: { jobs: 'no' } }, people.asha)).status, 400);
  assert.equal((await json('/api/notification-preferences', 'PATCH', { email: { jobs: false } }, people.asha)).status, 200);
  // The settings page saves the same thing.
  const saved = await post('/notifications/settings', { email_applications: '1', email_interviews: '1' }, people.olga);
  assert.match(decodeURIComponent(saved.headers.get('location')), /saved/);
  assert.deepEqual((await api('/api/notification-preferences', people.olga)).email, { applications: true, interviews: true, jobs: false });
  assert.match(await (await get('/notifications/settings', people.asha)).text(), /Always sent/);
});

test('job alerts: saved filters, one email per job, preferences, own alerts only', async () => {
  people.neha = await register('Neha Gupta', 'neha@example.in');
  // Signed in: on at once (no confirmation email), listed, overlapping alerts allowed.
  const r1 = await json('/api/job-alerts', 'POST', { category: 'Technology', location: 'Pune' }, people.neha);
  assert.equal(r1.status, 201);
  const r2 = await json('/api/job-alerts', 'POST', { category: '', location: 'Pune' }, people.neha);
  assert.equal(r2.status, 201);
  await json('/api/job-alerts', 'POST', { category: 'Technology', location: 'Mumbai' }, people.neha);
  assert.equal((await json('/api/job-alerts', 'POST', { category: 'Technology', location: 'Pune' }, people.neha)).status, 200, 'already on');
  const mine = (await api('/api/job-alerts', people.neha)).alerts;
  assert.equal(mine.length, 3);
  await json('/api/job-alerts', 'POST', { category: 'Technology', location: 'Pune' }, people.asha);
  const ashaAlert = (await api('/api/job-alerts', people.asha)).alerts[0];
  assert.equal((await json(`/api/job-alerts/${ashaAlert.id}`, 'DELETE', undefined, people.neha)).status, 404, "someone else's alert");
  assert.equal((await json('/api/job-alerts', 'GET')).status, 401);

  // The team posts a Pune technology job: Neha matches twice but gets one
  // email; Asha (job emails off) gets it in-app only; Mumbai doesn't match.
  const form = { title: 'Alert Test Role', company: 'Acme', location: 'Pune', mode: 'On-site', type: 'Full-time', category: 'Technology', experience: '1-3 years', salary: '', description: 'A role for alerts.', skills: 'Testing' };
  const posted = await srv.request('/admin/jobs', { method: 'POST', form, cookie: people.admin, headers: headers() });
  assert.equal(posted.status, 302);
  await srv.waitForEmail((m) => m.includes('To: neha@example.in') && m.includes('New job: Alert Test Role'));
  await settle();
  assert.equal(srv.emails().filter((m) => m.includes('To: neha@example.in') && m.includes('New job: Alert Test Role')).length, 1);
  assert.equal(srv.emails().filter((m) => m.includes('To: asha@example.in') && m.includes('New job: Alert Test Role')).length, 0);
  assert.ok((await api('/api/notifications?category=jobs', people.asha)).notifications.some((n) => n.title === 'New job: Alert Test Role'));
  assert.ok((await api('/api/notifications?category=jobs', people.neha)).notifications.some((n) => n.title === 'New job: Alert Test Role'));
  // Deleting your own alert works.
  assert.equal((await json(`/api/job-alerts/${mine[0].id}`, 'DELETE', undefined, people.neha)).status, 200);
  assert.equal((await api('/api/job-alerts', people.neha)).alerts.length, 2);
});

test('the provider webhook is signed, idempotent and never callable from a browser', async () => {
  const d = srv.records('notification-deliveries').find((x) => x.status === 'sent' && x.providerRef);
  assert.ok(d, 'a sent email with a provider reference');
  const body = JSON.stringify({ events: [{ id: 'evt-1', type: 'delivered', messageId: d.providerRef }] });
  const ts = Math.floor(Date.now() / 1000);
  const sig = `t=${ts},v1=${crypto.createHmac('sha256', 'whsec-app').update(`${ts}.${body}`).digest('hex')}`;
  const send = (b, signature) => srv.request('/webhooks/email', { method: 'POST', body: b, headers: { 'content-type': 'application/json', ...(signature ? { 'x-hireriv-signature': signature } : {}) } });
  assert.equal((await send(body)).status, 401);
  assert.equal((await send(body.replace('delivered', 'bounced'), sig)).status, 401);
  const ok = await (await send(body, sig)).json();
  assert.deepEqual([ok.applied, ok.duplicates], [1, 0]);
  const again = await (await send(body, sig)).json();
  assert.deepEqual([again.applied, again.duplicates], [0, 1]);
  assert.equal(srv.records('notification-deliveries').find((x) => x.id === d.id).status, 'delivered');
  // Admins see delivery health; recruiters and employers don't.
  assert.match(await (await get('/admin/notifications', people.admin)).text(), /Email delivery/);
  assert.equal((await get('/admin/notifications', people.olga)).status, 401);
});

test('deleting an account deletes its notifications and settings, and says so by email', async () => {
  const rk = notifyModule.candidateRk('neha@example.in');
  assert.ok(srv.records('notifications').some((n) => n.rk === rk));
  const data = await (await get('/account/my-data.json', people.neha)).json();
  assert.ok(data.notifications.length >= 1, 'notifications are in the data download');
  assert.equal((await post('/account/delete', { confirm: 'DELETE' }, people.neha)).status, 200);
  assert.equal(srv.records('notifications').some((n) => n.rk === rk), false);
  assert.equal(srv.records('notification-deliveries').some((n) => n.rk === rk), false);
  await srv.waitForEmail((m) => m.includes('To: neha@example.in') && m.includes('Your Hireriv data has been deleted'));
});

test('with the email provider down, applications are still saved and the email waits to retry', async () => {
  const down = await startServer({ SMTP_HOST: '127.0.0.1', SMTP_PORT: '1' }, { jobs: [job('j9', { createdBy: undefined, employerId: undefined })] });
  try {
    const fd = new FormData();
    for (const [k, v] of Object.entries({ jobId: 'j9', name: 'Ravi Kumar', email: 'ravi@example.in', phone: '9845012345' })) fd.append(k, v);
    fd.append('resume', new Blob(['%PDF-1.4 test'], { type: 'application/pdf' }), 'cv.pdf');
    const res = await down.request('/api/apply', { method: 'POST', body: fd, headers: { accept: 'application/json' } });
    assert.equal(res.status, 200);
    assert.equal(down.records('applications').filter((a) => a.email === 'ravi@example.in').length, 1);
    let ds = [];
    for (let i = 0; i < 60; i++) {
      ds = down.records('notification-deliveries');
      if (ds.length && ds.every((d) => d.attempts >= 1)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(ds.length, 2, 'the candidate and the team inbox');
    for (const d of ds) {
      assert.equal(d.status, 'queued', 'waiting to retry');
      assert.equal(d.attempts, 1);
      assert.ok(Date.parse(d.nextAttemptAt) > Date.now() + 30000, 'backed off');
    }
  } finally {
    await down.stop();
  }
});
