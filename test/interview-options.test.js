// Interview times to choose from: the employer offers several, the candidate
// is told and picks one from their account, and it is booked and confirmed.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, decodeEmail } = require('./helpers');
const { hashPassword } = require('../employers');
const starter = require('./fixtures/jobs.json');

const day = (offset) => new Date(Date.now() + offset * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const EMP = { id: 'emp-old', company: 'Old Co', name: 'Olga Rao', email: 'olga@oldco.in', passwordHash: hashPassword('olga long password'), passwordSetAt: '2026-01-01T00:00:00.000Z', active: true, createdAt: '2026-01-01T00:00:00.000Z' };
const JOB = { ...starter[0], id: 'hr-900', company: 'Old Co', employerId: 'emp-old', createdBy: 'employer', status: 'open', sample: false };
const APP = { id: 'app-1', jobId: 'hr-900', jobTitle: JOB.title, email: 'asha@example.in', name: 'Asha Rao', phone: '9811100001', createdAt: '2026-11-01T05:00:00.000Z', status: 'Shortlisted' };
let srv; let seeker; let employer;
before(async () => {
  srv = await startServer({}, { employers: [EMP], jobs: [JOB], applications: [APP] });
  const fd = new FormData();
  for (const [k, v] of Object.entries({ agree: '1', name: 'Asha Rao', email: 'asha@example.in', phone: '9811100001' })) fd.append(k, v);
  await srv.request('/account/register', { method: 'POST', body: fd });
  const seen = srv.emails().length;
  await srv.request('/account/login', { method: 'POST', form: { email: 'asha@example.in' } });
  for (let i = 0; i < 100 && !seeker; i++) {
    await new Promise((r) => setTimeout(r, 50));
    const mail = srv.emails().slice(seen).map(decodeEmail).find((e) => e.includes('/account/verify/'));
    if (mail) seeker = srv.cookieFrom(await srv.request(mail.match(/\/account\/verify\/[A-Za-z0-9_-]+/)[0], { method: 'POST', form: {} }));
  }
  employer = srv.cookieFrom(await srv.request('/employer/login', { method: 'POST', form: { email: 'olga@oldco.in', password: 'olga long password' } }));
});
after(() => srv && srv.stop());
const page = async (p, cookie) => (await srv.request(p, { cookie })).text();
const base = { duration: '45', mode: 'Video call', where: 'https://meet.example/abc', interviewer: 'Olga Rao', message: 'Keep your ID ready.' };
const offer = (extra) => srv.request('/employer/applicants/app-1/interview', { method: 'POST', cookie: employer, form: { ...base, ...extra } });

test('the form offers more times; bad or repeated times are refused with the reason', async () => {
  assert.match(await page('/employer/applicants/app-1/interview', employer), /Let the candidate choose: offer more times/);
  const same = await offer({ date: day(2), time: '11:00', date2: day(2), time2: '11:00' });
  assert.equal(same.status, 400);
  assert.match(await same.text(), /time 2 is the same as another/);
  const past = await offer({ date: day(2), time: '11:00', date2: day(-1), time2: '11:00' });
  assert.equal(past.status, 400);
  assert.match(await past.text(), /time 2: /);
  assert.equal(srv.records('applications').find((x) => x.id === 'app-1').interviewOptions, undefined);
});

test('three times are sent: the candidate is emailed and sees them; the employer sees it waiting', async () => {
  const res = await offer({ date: day(3), time: '15:00', date2: day(2), time2: '11:00', date3: day(4), time3: '10:30' });
  assert.equal(res.status, 302);
  assert.match(decodeURIComponent(res.headers.get('location')), /3 interview times sent/);
  const o = srv.records('applications').find((x) => x.id === 'app-1').interviewOptions;
  assert.equal(o.status, 'open');
  assert.equal(o.slots.length, 3);
  assert.ok(o.slots[0].at < o.slots[1].at, 'earliest first');
  const mail = decodeEmail(await srv.waitForEmail((m) => m.includes('To: asha@example.in') && m.includes('Choose a time for your interview')));
  assert.match(mail, /Option 3/);
  assert.match(await page('/employer/applicants/app-1', employer), /Waiting for Asha Rao to choose an interview time<\/b> from 3 you offered/);
  const mine = await page('/account/interviews', seeker);
  assert.match(mine, /Choose a time for your interview/);
  assert.equal((mine.match(/class="iv-slot"/g) || []).length, 3);
  assert.match(mine, /Keep your ID ready\./);
});

test('the candidate picks one: it is booked and confirmed, the offer closes, and only they can pick', async () => {
  const o = srv.records('applications').find((x) => x.id === 'app-1').interviewOptions;
  const other = await srv.request('/account/interviews/app-1/choose', { method: 'POST', form: { offerId: o.id, at: o.slots[1].at } });
  assert.notEqual(other.status, 303, 'signed out cannot');
  const wrong = await srv.request('/account/interviews/app-1/choose', { method: 'POST', cookie: seeker, form: { offerId: o.id, at: '2030-01-01T00:00:00.000Z' } });
  assert.match(decodeURIComponent(wrong.headers.get('location')), /not one of the options/);
  const res = await srv.request('/account/interviews/app-1/choose', { method: 'POST', cookie: seeker, form: { offerId: o.id, at: o.slots[1].at } });
  assert.equal(res.status, 303);
  assert.match(decodeURIComponent(res.headers.get('location')), /Booked: your interview for/);
  const a = srv.records('applications').find((x) => x.id === 'app-1');
  assert.equal(a.interviewOptions.status, 'chosen');
  assert.equal(a.interviews.length, 1);
  assert.equal(a.interviews[0].at, o.slots[1].at);
  assert.equal(a.interviews[0].confirmation, 'confirmed');
  assert.equal(a.interviews[0].mode, 'Video call');
  assert.equal(a.status, 'Interview');
  const again = await srv.request('/account/interviews/app-1/choose', { method: 'POST', cookie: seeker, form: { offerId: o.id, at: o.slots[0].at } });
  assert.match(decodeURIComponent(again.headers.get('location')), /no longer open/);
  assert.doesNotMatch(await page('/account/interviews', seeker), /Choose a time for your interview/);
  assert.doesNotMatch(await page('/employer/applicants/app-1', employer), /Waiting for Asha Rao to choose/);
});

test('the employer can withdraw times that were not chosen', async () => {
  await offer({ date: day(6), time: '11:00', date2: day(7), time2: '11:00' });
  assert.equal(srv.records('applications').find((x) => x.id === 'app-1').interviewOptions.status, 'open');
  await srv.request('/employer/applicants/app-1/interview-options/cancel', { method: 'POST', cookie: employer, form: {} });
  assert.equal(srv.records('applications').find((x) => x.id === 'app-1').interviewOptions.status, 'withdrawn');
  assert.doesNotMatch(await page('/account/interviews', seeker), /Choose a time for your interview/);
});
