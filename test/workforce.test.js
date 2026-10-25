// Step 55: workers after placement. Onboarding without copying the profile,
// private documents, client sites and supervisors on assignments, shifts,
// check-in and check-out with breaks, manual entry, missing check-outs as
// exceptions, corrections and overtime approved by someone else, timesheets
// that lock attendance and become invoice drafts, payroll, reminders, and
// every person seeing only what their role and company allow.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, decodeEmail } = require('./helpers');
const { hashPassword } = require('../employers');
const workforce = require('../workforce');

const DAY = 86400000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const ymd = (msAgo) => new Date(Date.now() - msAgo).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

test('site times convert to UTC, including daylight saving', () => {
  assert.equal(workforce.localToUtc('2026-11-02', '09:00', 'Asia/Kolkata'), '2026-11-02T03:30:00.000Z');
  assert.equal(workforce.localToUtc('2026-03-08', '03:30', 'America/New_York'), '2026-03-08T07:30:00.000Z', 'after clocks go forward');
  assert.equal(workforce.localToUtc('2026-11-01', '09:00', 'America/New_York'), '2026-11-01T14:00:00.000Z', 'after clocks go back');
  assert.equal(workforce.parseAt('2026-11-02T09:05', 'Asia/Kolkata'), '2026-11-02T03:35:00.000Z');
  assert.equal(workforce.parseAt('2026-11-02T09:05:00+05:30', 'UTC'), '2026-11-02T03:35:00.000Z');
  assert.equal(workforce.parseAt('yesterday', 'Asia/Kolkata'), undefined);
});

test('joining requirements never demand identity numbers or bank details', () => {
  assert.deepEqual(workforce.parseItems([{ label: 'Photo ID', kind: 'document', required: true }]).errors, []);
  assert.match(workforce.parseItems([{ label: 'Aadhaar card', kind: 'document', required: true }]).errors[0], /can't be required/);
  assert.match(workforce.parseItems([{ label: 'Bank account number', kind: 'document', required: true }]).errors[0], /can't be required/);
  assert.deepEqual(workforce.parseItems([{ label: 'Driving licence', kind: 'document', required: true, expires: true }]).items[0].expires, true);
  assert.match(workforce.parseItems([{ label: 'X', kind: 'selfie' }]).errors[0], /kind must be/);
  assert.ok(workforce.DEFAULT_ITEMS.every((i) => !/aadha|bank/i.test(i.label)));
});

// ---------- the whole app ----------
const company = (id, name, email) => ({ id, company: name, name: email.split('@')[0], email, active: true, createdAt: iso(30 * DAY), verification: { status: 'verified' } });
const person = (id, email, name) => ({ id, email, name, phone: '', passwordHash: hashPassword(`${name} long password`), emailVerifiedAt: iso(DAY), phoneVerifiedAt: null, createdAt: iso(DAY), active: true, link: null });
const membership = (id, employerId, userId, role) => ({ id, employerId, userId, role, jobIds: [], createdAt: iso(DAY) });
const placement = (id, extra) => ({
  id, appId: `app-${id}`, type: 'Temporary', feeMode: 'assignment', status: 'Joined', fee: 0, employerId: 'emp-a', company: 'A Co', jobTitle: 'Forklift Operator',
  joiningDate: ymd(10 * DAY), createdAt: iso(10 * DAY), guaranteeDays: 0, ...extra,
});

let srv;
const p = {};
let ip = 0;
const headers = (extra = {}) => ({ 'x-forwarded-for': `10.8.${Math.floor(++ip / 250)}.${ip % 250}`, ...extra });
const get = (url, cookie) => srv.request(url, { cookie, headers: headers() });
const post = (url, form, cookie) => srv.request(url, { method: 'POST', form, cookie, headers: headers() });
const json = (url, method, body, cookie, extra = {}) => srv.request(url, { method, cookie, body: body === undefined ? undefined : JSON.stringify(body), headers: headers({ 'content-type': 'application/json', accept: 'application/json', ...extra }) });
const call = async (url, method, body, cookie) => { const r = await json(url, method, body, cookie); return { status: r.status, ...(await r.json()) }; };
const rec = (collection, fn) => srv.records(collection).find(fn);
const upload = (url, fields, file, name, cookie) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append('file', new Blob([file]), name);
  return srv.request(url, { method: 'POST', body: fd, cookie, headers: headers({ accept: 'application/json' }) });
};

async function member(name, email, role) {
  await post('/admin/team', { name, email, role }, p.admin);
  const link = decodeEmail(await srv.waitForEmail((e) => e.includes(`To: ${email}`))).match(/\/admin\/setup\/[a-f0-9]{64}/)[0];
  return srv.cookieFrom(await post(link, { password: `${name} long password`, confirm: `${name} long password` }));
}
async function candidate(email) {
  const seen = srv.emails().length;
  await post('/account/login', { email });
  for (const end = Date.now() + 5000; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) {
    const mail = srv.emails().slice(seen).map(decodeEmail).find((e) => e.includes(`To: ${email}`) && e.includes('/account/verify/'));
    if (mail) return srv.cookieFrom(await post(mail.match(/\/account\/verify\/[A-Za-z0-9_-]+/)[0], {}));
  }
  throw new Error('no sign-in email');
}
const employer = async (email, name) => srv.cookieFrom(await post('/employer/login', { email, password: `${name} long password` }));

before(async () => {
  srv = await startServer({ TRUST_PROXY: '1' }, {
    employers: [company('emp-a', 'A Co', 'olga@aco.in'), company('emp-b', 'B Co', 'bob@bco.in')],
    'employer-users': [person('u-olga', 'olga@aco.in', 'Olga'), person('u-sam', 'sam@aco.in', 'Sam'), person('u-vic', 'vic@aco.in', 'Vic'), person('u-bob', 'bob@bco.in', 'Bob')],
    'employer-members': [membership('m1', 'emp-a', 'u-olga', 'owner'), membership('m2', 'emp-a', 'u-sam', 'supervisor'), membership('m3', 'emp-a', 'u-vic', 'viewer'), membership('m4', 'emp-b', 'u-bob', 'owner')],
    applications: [{ id: 'app-pl1', jobId: 'general', jobTitle: 'Forklift Operator', name: 'Sunil More', email: 'sunil@example.in', phone: '9800000000', status: 'Hired', createdAt: iso(20 * DAY), history: [] }],
    placements: [placement('pl1', { candidateName: 'Sunil More', candidateEmail: 'sunil@example.in' }), placement('pl2', { candidateName: 'No Email', candidateEmail: '' }), placement('pl3', { type: 'Permanent', feeMode: 'percent', candidateName: 'Perm', candidateEmail: 'perm@example.in' })],
  });
  p.admin = await srv.adminLogin();
  p.stan = await member('Stan', 'stan@hireriv.test', 'Staffing Manager');
  p.rita = await member('Rita', 'rita@hireriv.test', 'Recruiter');
  p.fin = await member('Farah', 'farah@hireriv.test', 'Finance Manager');
  p.olga = await employer('olga@aco.in', 'Olga');
  p.sam = await employer('sam@aco.in', 'Sam');
  p.vic = await employer('vic@aco.in', 'Vic');
  p.bob = await employer('bob@bco.in', 'Bob');
  p.sunil = await candidate('sunil@example.in');
}, { timeout: 30000 });
after(() => srv && srv.stop());

let workerId;
test('onboarding: a placed candidate becomes a worker without copying their profile', async () => {
  assert.equal((await call('/api/staffing/workers', 'POST', { placementId: 'pl1' }, p.rita)).status, 403, 'recruiters see onboarding status only');
  assert.equal((await call('/api/staffing/workers', 'POST', { placementId: 'pl3' }, p.stan)).status, 409, 'permanent hires are not onboarded as workers');
  assert.match((await call('/api/staffing/workers', 'POST', { placementId: 'pl2' }, p.stan)).errors[0], /no email for the worker/);
  const made = await call('/api/staffing/workers', 'POST', { placementId: 'pl1' }, p.stan);
  assert.equal(made.status, 201);
  workerId = made.worker.id;
  assert.equal((await call('/api/staffing/workers', 'POST', { placementId: 'pl1' }, p.stan)).existed, true, 'one worker per placement');
  const w = rec('workers', (x) => x.id === workerId);
  assert.deepEqual(Object.keys(w).filter((k) => ['phone', 'resume', 'skills', 'profile', 'experience'].includes(k)), [], 'no profile copy');
  assert.deepEqual(w.tasks.map((t) => t.key), ['photo-id', 'emergency-contact', 'site-rules']);
  // Recruiters: the status, no documents or contact details.
  const seen = (await call('/api/staffing/workers', 'GET', undefined, p.rita)).workers.find((x) => x.id === workerId);
  assert.deepEqual([seen.status, seen.email, seen.tasks], ['Onboarding', undefined, undefined]);

  // The worker completes the steps from their own account.
  assert.equal((await call(`/api/staffing/workers/${workerId}/onboarding`, 'POST', { task: 'site-rules', accept: true }, p.stan)).status, 403);
  assert.equal((await call(`/api/staffing/workers/${workerId}/onboarding`, 'POST', { task: 'site-rules', accept: true }, p.bob)).status, 404, 'another company');
  assert.equal((await call(`/api/staffing/workers/${workerId}/onboarding`, 'POST', { task: 'emergency-contact', contact: { name: 'Asha More', phone: '12' } }, p.sunil)).status, 400);
  assert.equal((await call(`/api/staffing/workers/${workerId}/onboarding`, 'POST', { task: 'emergency-contact', contact: { name: 'Asha More', phone: '98765 43210', relation: 'Sister' } }, p.sunil)).status, 200);
  assert.equal((await call(`/api/staffing/workers/${workerId}/onboarding`, 'POST', { task: 'site-rules', accept: true }, p.sunil)).status, 200);
  // Documents: real files only, kept private.
  const fake = await upload(`/api/staffing/workers/${workerId}/documents`, { task: 'photo-id' }, 'MZ\x90\x00 not a pdf', 'id.pdf', p.sunil);
  assert.equal(fake.status, 400);
  assert.equal((await upload(`/api/staffing/workers/${workerId}/documents`, { task: 'photo-id' }, 'MZ', 'id.exe', p.sunil)).status, 400);
  const ok = await upload(`/api/staffing/workers/${workerId}/documents`, { task: 'photo-id', expiresOn: ymd(-10 * DAY) }, '%PDF-1.4 photo id', 'id.pdf', p.sunil);
  assert.equal(ok.status, 201);
  const doc = (await ok.json()).document;
  assert.match(doc.sha256, /^[a-f0-9]{64}$/);
  assert.equal(doc.file, undefined, 'no storage path in responses');
  assert.equal((await call(`/api/staffing/workers/${workerId}/onboarding`, 'POST', { task: 'photo-id', decision: 'approve' }, p.rita)).status, 403);
  assert.equal((await call(`/api/staffing/workers/${workerId}/onboarding`, 'POST', { status: 'Joined' }, p.stan)).status, 409, 'not ready yet');
  assert.equal((await call(`/api/staffing/workers/${workerId}/onboarding`, 'POST', { task: 'photo-id', decision: 'approve' }, p.stan)).status, 200);
  assert.equal(rec('workers', (x) => x.id === workerId).status, 'Ready to join');
  // The file opens only through a fresh signed link, and opening it is logged.
  assert.equal((await get(`/admin/workforce/documents/${doc.id}/file`, p.stan)).status, 410);
  const page = await (await get(`/admin/workforce/workers/${workerId}`, p.stan)).text();
  const link = page.match(/href="(\/admin\/workforce\/documents\/[^"]+)"/)[1].replace(/&amp;/g, '&');
  const file = await get(link, p.stan);
  assert.equal(file.status, 200);
  assert.equal(await file.text(), '%PDF-1.4 photo id');
  assert.equal((await get(link, p.rita)).status, 403, 'Recruiters cannot open documents');
  assert.ok(rec('workforce-audit', (e) => e.action === 'document-viewed' && e.entityId === doc.id));
  assert.equal((await call(`/api/staffing/workers/${workerId}/onboarding`, 'POST', { status: 'Joined', joinedOn: ymd(10 * DAY) }, p.stan)).status, 200);
  assert.match(await (await get('/account/work', p.sunil)).text(), /A Co · Joined/);
});

let aId;
test('assignments take the client\'s approved sites, a supervisor and shift rules', async () => {
  assert.equal((await call('/api/staffing/clients/emp-a/sites', 'PUT', { sites: [{ name: 'Chakan warehouse', timeZone: 'Asia/Kolkata' }] }, p.rita)).status, 403);
  assert.equal((await call('/api/staffing/clients/emp-a/sites', 'PUT', { sites: [{ name: 'X', timeZone: 'Mars/Base' }] }, p.stan)).status, 400);
  assert.equal((await call('/api/staffing/clients/emp-a/sites', 'PUT', { sites: [{ name: 'Chakan warehouse', timeZone: 'Asia/Kolkata' }] }, p.stan)).status, 200);
  const body = { placementId: 'pl1', site: 'Somewhere else', startsOn: ymd(10 * DAY), endsOn: ymd(-30 * DAY), billRate: '400', payRate: '300', ratePer: 'hour', shiftStart: '09:00', shiftEnd: '17:00', breakMinutes: '30', graceMinutes: '10', supervisorId: 'u-vic' };
  const bad = await call('/api/staffing/assignments', 'POST', body, p.admin);
  assert.ok(bad.errors.some((e) => /approved sites: Chakan warehouse/.test(e)));
  assert.ok(bad.errors.includes("supervisor must be a hiring manager or site supervisor in the client's team"), 'a viewer supervises nobody');
  assert.ok((await call('/api/staffing/assignments', 'POST', { ...body, site: 'chakan warehouse', supervisorId: 'u-sam', shiftStart: '25:00' }, p.admin)).errors.includes('shiftStart must be a time like 09:00'));
  const made = await call('/api/staffing/assignments', 'POST', { ...body, site: 'chakan warehouse', supervisorId: 'u-sam' }, p.admin);
  assert.equal(made.status, 201);
  aId = made.assignment.id;
  const a = rec('staffing-assignments', (x) => x.id === aId);
  assert.deepEqual([a.site, a.timeZone, a.shiftStart, a.breakMinutes, a.supervisorId], ['Chakan warehouse', 'Asia/Kolkata', '09:00', 30, 'u-sam']);
  assert.equal((await call('/api/staffing/attendance/check-in', 'POST', { assignmentId: aId }, p.sunil)).status, 409, 'not active yet');
  assert.equal((await call(`/api/staffing/assignments/${aId}`, 'PATCH', { status: 'Active' }, p.admin)).status, 200);
  // Extensions are recorded in its history, and the worker hears about changes.
  assert.equal((await call(`/api/staffing/assignments/${aId}`, 'PATCH', { endsOn: ymd(-40 * DAY) }, p.admin)).status, 200);
  assert.ok(rec('staffing-assignments', (x) => x.id === aId).history.some((h) => /^Extended from/.test(h.text)));
  assert.ok(srv.records('notifications').some((n) => n.type === 'work-assignment' && /Assignment changed/.test(n.title)));
});

test('shifts: planned inside the assignment, never twice', async () => {
  const r = await call('/api/staffing/shifts', 'POST', { assignmentId: aId, from: ymd(-1 * DAY), to: ymd(-7 * DAY), days: 'mon,tue,wed,thu,fri,sat,sun' }, p.sam);
  assert.equal(r.status, 201);
  assert.equal(r.shifts.length, 7);
  assert.equal(r.shifts[0].start, '09:00');
  assert.equal(r.shifts[0].startAt, workforce.localToUtc(r.shifts[0].date, '09:00', 'Asia/Kolkata'));
  const again = await call('/api/staffing/shifts', 'POST', { assignmentId: aId, from: ymd(-1 * DAY), to: ymd(-7 * DAY), days: 'mon,tue,wed,thu,fri,sat,sun' }, p.sam);
  assert.deepEqual([again.status, again.shifts.length, again.skipped.length], [200, 0, 7]);
  assert.equal((await call('/api/staffing/shifts', 'POST', { assignmentId: aId, from: ymd(-1 * DAY) }, p.vic)).status, 403, 'viewers plan nothing');
  assert.equal((await call('/api/staffing/shifts', 'POST', { assignmentId: aId, from: ymd(-1 * DAY) }, p.bob)).status, 404);
  assert.equal((await call(`/api/staffing/shifts?assignmentId=${aId}`, 'GET', undefined, p.bob)).shifts.length, 0);
});

let d3;
let d1;
test('attendance: check-in and out, breaks, manual entry, no location, missing check-outs', async () => {
  // Workers use the server clock and send no location.
  assert.match((await call('/api/staffing/attendance/check-in', 'POST', { assignmentId: aId, at: `${ymd(DAY)}T09:00` }, p.sunil)).errors[0], /current time/);
  assert.deepEqual((await call('/api/staffing/attendance/check-in', 'POST', { assignmentId: aId, lat: 18.5, lng: 73.8 }, p.sunil)).errors, ['lat: location is not collected', 'lng: location is not collected']);
  assert.equal((await call('/api/staffing/attendance/check-in', 'POST', { assignmentId: aId }, p.bob)).status, 404);
  assert.equal((await call('/api/staffing/attendance/check-in', 'POST', { assignmentId: aId }, p.vic)).status, 403);
  // The supervisor enters a day from the site register, without a check-out.
  assert.match((await call('/api/staffing/attendance/check-in', 'POST', { assignmentId: aId, at: `${ymd(-2 * DAY)}T09:00` }, p.sam)).errors[0], /future/);
  assert.match((await call('/api/staffing/attendance/check-in', 'POST', { assignmentId: aId, at: `${ymd(9 * DAY)}T09:00` }, p.sam)).errors[0], /more than 7 days ago/);
  const in3 = await call('/api/staffing/attendance/check-in', 'POST', { assignmentId: aId, at: `${ymd(3 * DAY)}T09:00` }, p.sam);
  assert.equal(in3.status, 201);
  d3 = in3.record;
  assert.deepEqual([d3.source, d3.checkIn, d3.lateMinutes, d3.timeZone], ['manual', '09:00', 0, 'Asia/Kolkata']);
  assert.equal(d3.checkInAt, workforce.localToUtc(ymd(3 * DAY), '09:00', 'Asia/Kolkata'), 'stored in UTC');
  assert.equal((await call('/api/staffing/attendance/check-in', 'POST', { assignmentId: aId }, p.sunil)).status, 409, 'already checked in');
  // The hourly check turns it into an exception: no hours are invented.
  assert.match(decodeURIComponent((await post('/admin/workforce/scan', {}, p.stan)).headers.get('location')), /1 missing check-out/);
  const ex = rec('attendance-records', (r) => r.id === d3.id);
  assert.deepEqual([ex.status, ex.exception, ex.workedMinutes, ex.checkOutAt], ['Exception', 'Missing check-out', null, null]);
  assert.match((await call('/api/staffing/attendance/check-out', 'POST', { assignmentId: aId }, p.sunil)).errors[0], /exception/);
  assert.ok(srv.records('notifications').some((n) => n.type === 'work-attendance' && n.employerId === 'emp-a'), 'the supervisor is told');
  await srv.waitForEmail((e) => e.includes('To: sam@aco.in') && e.includes('A check-out is missing'));
  assert.match((await post('/admin/workforce/scan', {}, p.stan)).headers.get('location'), /0%20missing/, 'only once');

  // A day with a late arrival and overtime, entered by the supervisor.
  const in1 = await call('/api/staffing/attendance/check-in', 'POST', { assignmentId: aId, at: `${ymd(DAY)}T09:25` }, p.sam);
  assert.equal(in1.record.lateMinutes, 25, 'late beyond the 10-minute grace');
  assert.equal((await call('/api/staffing/attendance/check-out', 'POST', { assignmentId: aId, at: `${ymd(DAY)}T09:20` }, p.sam)).status, 400, 'out before in');
  const out1 = await call('/api/staffing/attendance/check-out', 'POST', { assignmentId: aId, at: `${ymd(DAY)}T18:30` }, p.sam);
  d1 = out1.record;
  assert.deepEqual([d1.workedMinutes, d1.overtimeMinutes, d1.overtimeStatus], [545, 95, 'Pending'], '9h05 worked against a 7h30 plan');
  // Today, by the worker: check in, a break, check out.
  const now = await call('/api/staffing/attendance/check-in', 'POST', { assignmentId: aId }, p.sunil);
  assert.deepEqual([now.status, now.record.source, now.record.date], [201, 'self', ymd(0)]);
  assert.equal((await call(`/api/staffing/attendance/${now.record.id}/breaks`, 'POST', { action: 'start' }, p.sunil)).status, 200);
  assert.equal((await call(`/api/staffing/attendance/${now.record.id}/breaks`, 'POST', { action: 'start' }, p.sunil)).status, 409);
  assert.equal((await call(`/api/staffing/attendance/${now.record.id}/breaks`, 'POST', { action: 'end' }, p.sunil)).status, 200);
  assert.equal((await call('/api/staffing/attendance/check-out', 'POST', { assignmentId: aId }, p.sunil)).status, 200);
  // Who sees attendance.
  assert.equal((await call('/api/staffing/attendance', 'GET', undefined, p.rita)).status, 403);
  assert.equal((await call('/api/staffing/attendance', 'GET', undefined, p.bob)).attendance.length, 0);
  assert.equal((await call('/api/staffing/attendance', 'GET', undefined, p.sunil)).attendance.length, 3);
  assert.equal((await call('/api/staffing/attendance', 'GET', undefined, p.vic)).attendance.length, 3, 'viewers see, without changing');
});

test('corrections and overtime need someone else, and history is kept', async () => {
  const c = await call(`/api/staffing/attendance/${d3.id}/corrections`, 'POST', { checkOutAt: `${ymd(3 * DAY)}T16:30`, reason: 'Forgot to check out' }, p.sunil);
  assert.equal(c.status, 201);
  assert.equal((await call(`/api/staffing/attendance/${d3.id}/corrections`, 'POST', { checkOutAt: `${ymd(3 * DAY)}T16:00`, reason: 'again' }, p.sunil)).status, 409, 'one at a time');
  assert.equal((await call(`/api/staffing/attendance/corrections/${c.correction.id}/approve`, 'POST', {}, p.sunil)).status, 403, 'workers approve nothing');
  assert.equal((await call(`/api/staffing/attendance/corrections/${c.correction.id}/approve`, 'POST', {}, p.bob)).status, 404);
  const ok = await call(`/api/staffing/attendance/corrections/${c.correction.id}/approve`, 'POST', {}, p.sam);
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.record.status, ok.record.workedMinutes, ok.record.overtimeMinutes, ok.record.original.checkOutAt], ['Complete', 450, 0, null]);
  assert.ok(ok.record.history.some((h) => h.correctionId === c.correction.id));
  // A correction the supervisor asks for is decided by someone else.
  const own = await call(`/api/staffing/attendance/${d3.id}/corrections`, 'POST', { checkInAt: `${ymd(3 * DAY)}T08:55`, reason: 'Register says 8:55' }, p.sam);
  assert.equal((await call(`/api/staffing/attendance/corrections/${own.correction.id}/approve`, 'POST', {}, p.sam)).status, 403);
  assert.equal((await call(`/api/staffing/attendance/corrections/${own.correction.id}/reject`, 'POST', {}, p.stan)).status, 400, 'a reason is needed');
  assert.equal((await call(`/api/staffing/attendance/corrections/${own.correction.id}/reject`, 'POST', { note: 'Register unclear' }, p.stan)).status, 200);
  assert.equal(rec('attendance-corrections', (x) => x.id === own.correction.id).status, 'Rejected');
  // Overtime: not by whoever entered the times.
  assert.equal((await call(`/api/staffing/attendance/${d1.id}/overtime`, 'POST', { decision: 'approve' }, p.sam)).status, 403);
  assert.equal((await call(`/api/staffing/attendance/${d1.id}/overtime`, 'POST', { decision: 'approve' }, p.sunil)).status, 403);
  assert.equal((await call(`/api/staffing/attendance/${d1.id}/overtime`, 'POST', { decision: 'approve' }, p.olga)).record.overtimeStatus, 'Approved');
});

test('timesheets: blocked by open items, approved by someone else, locked, billed and paid', async () => {
  const period = { assignmentId: aId, from: ymd(3 * DAY), to: ymd(DAY) };
  assert.match((await call('/api/staffing/timesheets', 'POST', { ...period, to: ymd(0) }, p.sunil)).errors[0], /finished days only/);
  assert.match((await call('/api/staffing/timesheets', 'POST', { ...period, from: ymd(40 * DAY) }, p.sunil)).errors.join(' '), /at most 31 days/);
  const ts = await call('/api/staffing/timesheets', 'POST', period, p.sunil);
  assert.equal(ts.status, 201);
  assert.deepEqual(ts.timesheet.totals, { daysWorked: 2, absences: 0, lateArrivals: 1, workedMinutes: 995, overtimeMinutes: 95, payableMinutes: 995 });
  assert.equal((await call('/api/staffing/timesheets', 'POST', period, p.sam)).existed, true, 'the same period is the same timesheet');
  assert.match((await call(`/api/staffing/attendance/${d1.id}/corrections`, 'POST', { checkInAt: `${ymd(DAY)}T09:00`, reason: 'x' }, p.sunil)).errors[0], /send the timesheet back first/);
  assert.equal((await call(`/api/staffing/timesheets/${ts.timesheet.id}/approve`, 'POST', {}, p.sunil)).status, 403, 'nobody approves their own timesheet');
  assert.equal((await call(`/api/staffing/timesheets/${ts.timesheet.id}/approve`, 'POST', {}, p.vic)).status, 403);
  assert.equal((await call(`/api/staffing/timesheets/${ts.timesheet.id}/approve`, 'POST', {}, p.bob)).status, 404);
  assert.ok(srv.records('notifications').some((n) => n.type === 'work-timesheet' && n.employerId === 'emp-a'), 'the supervisor is asked to approve');
  const ok = await call(`/api/staffing/timesheets/${ts.timesheet.id}/approve`, 'POST', {}, p.sam);
  assert.deepEqual([ok.status, ok.timesheet.status, ok.timesheet.approvedBy], [200, 'Approved', 'Sam']);
  assert.ok(srv.records('attendance-records').filter((r) => r.timesheetId === ts.timesheet.id).every((r) => r.locked));
  assert.match((await call(`/api/staffing/attendance/${d1.id}/corrections`, 'POST', { checkInAt: `${ymd(DAY)}T09:00`, reason: 'x' }, p.sunil)).errors[0], /approved timesheet/);
  // The approved hours became an invoice draft for Finance: 16.58 h × ₹400.
  const draft = rec('invoice-drafts', (d) => d.naturalKey === `staffing:${aId}:${period.from}:${period.to}`);
  assert.deepEqual([draft.status, draft.subtotalPaise, draft.lines[0].quantityH], ['Draft', 663200, 1658]);
  assert.equal(rec('workforce-timesheets', (t) => t.id === ts.timesheet.id).draftId, draft.id);
  // Payroll: Finance only, approved timesheets only, at the pay rate.
  assert.equal((await get('/admin/workforce/payroll.csv', p.rita)).status, 403);
  const csv = await (await get('/admin/workforce/payroll.csv', p.fin)).text();
  assert.match(csv, /Sunil More,A Co,Forklift Operator,Chakan warehouse,.*,2,16\.58,1\.58,0,300\.00,hour,4974\.00,Sam/);
  assert.equal((await call('/api/staffing/attendance', 'GET', undefined, p.fin)).status, 403, 'Finance sees timesheets, not attendance');
  assert.ok((await call('/api/staffing/timesheets', 'GET', undefined, p.fin)).timesheets.every((t) => t.status === 'Approved'));
});

test('clients see only their workers; supervisors only theirs', async () => {
  assert.equal((await get('/employer', p.sam)).headers.get('location'), '/employer/workforce');
  const page = await (await get('/employer/workforce', p.sam)).text();
  assert.match(page, /Sunil More/);
  assert.doesNotMatch(page, /href="\/employer\/jobs"/, 'supervisors get only the workforce tabs');
  assert.doesNotMatch(await (await get('/employer/workforce', p.bob)).text(), /Sunil More/);
  assert.doesNotMatch(await (await get('/employer/workforce', p.sam)).text(), /₹300|300\.00|sunil@example\.in|Asha More/, 'no pay rate, email or emergency contact for the client');
  const r = await call(`/api/staffing/assignments/${aId}/replacement`, 'POST', { reason: 'Needs a forklift licence holder' }, p.sam);
  assert.equal(r.status, 201);
  assert.equal((await call(`/api/staffing/assignments/${aId}/replacement`, 'POST', { reason: 'again' }, p.olga)).status, 409);
  assert.equal((await call(`/api/staffing/replacements/${r.replacement.id}`, 'POST', { status: 'Arranged' }, p.sam)).status, 403);
  assert.equal((await call(`/api/staffing/replacements/${r.replacement.id}`, 'POST', { status: 'Arranged', note: 'Kiran from Monday' }, p.stan)).status, 200);
  // Short links.
  assert.equal((await get('/worker/dashboard')).headers.get('location'), '/account/work');
  assert.equal((await get('/client/workforce')).headers.get('location'), '/employer/workforce');
  assert.equal((await get('/staffing/timesheets')).headers.get('location'), '/admin/workforce/timesheets');
});

test('requirements are configurable per client and role, within the rules', async () => {
  assert.equal((await call('/api/staffing/requirements', 'PUT', { items: [{ label: 'Photo ID', kind: 'document', required: true }] }, p.rita)).status, 403);
  assert.equal((await call('/api/staffing/requirements', 'PUT', { clientId: 'emp-a', role: 'Forklift Operator', items: [{ label: 'Aadhaar', kind: 'document', required: true }] }, p.stan)).status, 400);
  const ok = await call('/api/staffing/requirements', 'PUT', { clientId: 'emp-a', role: 'Forklift Operator', items: [{ label: 'Forklift licence', kind: 'document', required: true, expires: true }, { label: 'Site rules', kind: 'acknowledge', required: true }] }, p.stan);
  assert.equal(ok.status, 200);
  assert.ok((await call('/api/staffing/requirements', 'GET', undefined, p.stan)).requirements.some((s) => s.role === 'Forklift Operator'));
  for (const s of ['', '/onboarding', '/shifts', '/attendance', '/timesheets', '/rules']) assert.equal((await get(`/admin/workforce${s}`, p.stan)).status, 200, s);
  assert.equal((await get('/admin/workforce/attendance', p.rita)).status, 403);
  assert.equal((await get('/admin/workforce/payroll', p.fin)).status, 200);
  assert.equal((await get('/admin/workforce', p.fin)).status, 403, 'Finance: payroll only');
});
