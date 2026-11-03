// Closing soon: a reminder three days before a job's last day to apply, and
// "Keep open 30 more days", which moves only the date (no new review).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');
const { hashPassword } = require('../employers');
const starter = require('./fixtures/jobs.json');

const day = (offset) => new Date(Date.now() + offset * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const EMP = { id: 'emp-old', company: 'Old Co', name: 'Olga Rao', email: 'olga@oldco.in', passwordHash: hashPassword('olga long password'), passwordSetAt: '2026-01-01T00:00:00.000Z', active: true, createdAt: '2026-01-01T00:00:00.000Z' };
const mine = { ...starter[0], company: 'Old Co', employerId: 'emp-old', createdBy: 'employer', status: 'open', sample: false };
const JOBS = [
  { ...mine, id: 'hr-900', title: 'Soon Closing Packer', closesOn: day(2) },
  { ...mine, id: 'hr-901', title: 'Later Closing Driver', closesOn: day(20) },
  { ...mine, id: 'hr-902', title: 'Open Ended Clerk', closesOn: null },
];
let srv; let employer;
before(async () => {
  srv = await startServer({ REMINDER_DELAY_MS: '1500' }, { employers: [EMP], jobs: JOBS });
  employer = srv.cookieFrom(await srv.request('/employer/login', { method: 'POST', form: { email: 'olga@oldco.in', password: 'olga long password' } }));
});
after(() => srv && srv.stop());
const page = async (p, cookie) => (await srv.request(p, { cookie })).text();

test('a reminder goes out for the job closing in 2 days, once, and not for the others', async () => {
  const mail = await srv.waitForEmail((m) => m.includes('Closing soon: Soon Closing Packer'));
  assert.match(mail, /To: olga@oldco\.in/);
  assert.equal(srv.emails().filter((m) => m.includes('Closing soon: Later Closing Driver') || m.includes('Closing soon: Open Ended Clerk')).length, 0);
  const notes = await (await srv.request('/api/notifications', { cookie: employer })).json();
  assert.ok(notes.notifications.some((n) => n.title === 'Closing in 2 days: Soon Closing Packer'), JSON.stringify(notes.notifications.map((n) => n.title)));
});

test('the jobs list says it closes soon and offers to keep it open', async () => {
  const html = await page('/employer/jobs', employer);
  assert.match(html, /Closes in 2 days/);
  assert.match(html, /action="\/employer\/jobs\/hr-900\/extend"><button class="btn btn-primary btn-sm" title="Closes [\d-]+">Keep open 30 more days/);
  assert.doesNotMatch(html, /hr-901\/extend/, 'not for a job closing in 20 days');
});

test('keeping it open moves the date 30 days on, keeps it live and needs no review', async () => {
  const res = await srv.request('/employer/jobs/hr-900/extend', { method: 'POST', cookie: employer, form: {} });
  assert.ok([302, 303].includes(res.status));
  assert.match(decodeURIComponent(res.headers.get('location')), new RegExp(`now takes applications until ${day(32)}`));
  const job = srv.records('jobs').find((j) => j.id === 'hr-900');
  assert.equal(job.closesOn, day(32));
  assert.equal(job.status, 'open');
  const none = await srv.request('/employer/jobs/hr-902/extend', { method: 'POST', cookie: employer, form: {} });
  assert.match(decodeURIComponent(none.headers.get('location')), /has no closing date to move/);
  assert.equal((await srv.request('/employer/jobs/hr-900/extend', { method: 'POST', form: {} })).status === 200, false, 'signed out cannot');
  const cross = await srv.request('/employer/jobs/hr-900/extend', { method: 'POST', cookie: employer, headers: { origin: 'https://evil.example' }, form: {} });
  assert.equal(cross.status, 403);
});
