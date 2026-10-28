// "Seen by the hiring team": the first time an employer opens an
// application (or anyone on the hiring side moves it), the job seeker sees
// when, and is told once in the app; employers see which they haven't opened.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const history = require('../history');
const { startServer, decodeEmail } = require('./helpers');
const { hashPassword } = require('../employers');

test('a stage move by a person marks the application seen; the system does not', () => {
  const a = { status: 'New' };
  history.moveStage(a, 'Screening', 'System', '2026-10-01T00:00:00.000Z');
  assert.equal(a.viewedAt, undefined);
  history.moveStage(a, 'Interview', 'Asha (team)', '2026-10-02T00:00:00.000Z', { actor: 'team' });
  assert.equal(a.viewedAt, '2026-10-02T00:00:00.000Z');
  history.moveStage(a, 'Offered', 'Asha (team)', '2026-10-05T00:00:00.000Z', { actor: 'team' });
  assert.equal(a.viewedAt, '2026-10-02T00:00:00.000Z', 'the first time is kept');
});

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const OLGA = { id: 'emp-old', company: 'Old Co', name: 'Olga Rao', email: 'olga@oldco.in', passwordHash: hashPassword('olga long password'), passwordSetAt: '2026-01-01T00:00:00.000Z', active: true, createdAt: '2026-01-01T00:00:00.000Z' };
const JOB = { id: 'hr-900', title: 'Accounts Assistant', company: 'Old Co', location: 'Pune', mode: 'On-site', type: 'Full-time', category: 'Finance', experience: 'Fresher', salary: '', pay: null, posted: today, skills: ['Tally'], description: 'Books.', responsibilities: [], status: 'open', employerId: 'emp-old', createdBy: 'employer' };
const APP = { id: 'app-1', jobId: 'hr-900', jobTitle: 'Accounts Assistant', name: 'Kavya Iyer', email: 'kavya@example.in', phone: '9845012345', status: 'New', createdAt: `${today}T04:00:00.000Z` };

let srv;
let ip = 0;
const headers = () => ({ 'x-forwarded-for': `10.7.0.${++ip}` });
before(async () => {
  srv = await startServer({ TRUST_PROXY: '1' }, { employers: [OLGA], jobs: [JOB], applications: [APP] });
});
after(() => srv && srv.stop());

async function candidateCookie(email) {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ name: 'Kavya Iyer', email, phone: '9845012345', location: 'Pune', agree: '1' })) fd.append(k, v);
  assert.equal((await srv.request('/account/register', { method: 'POST', body: fd, headers: headers() })).status, 200);
  await srv.waitForEmail((m) => m.includes(`To: ${email}`) && decodeEmail(m).includes('/account/verify/'));
  const mail = decodeEmail(srv.emails().filter((m) => m.includes(`To: ${email}`)).pop());
  const res = await srv.request(mail.match(/\/account\/verify\/[a-f0-9]{64}/)[0], { method: 'POST', form: {}, headers: headers() });
  return srv.cookieFrom(res);
}

test('the job seeker sees when the employer first opened the application, and is told once', async () => {
  const kavya = await candidateCookie('kavya@example.in');
  assert.match(await (await srv.request('/account', { cookie: kavya })).text(), /Not seen by the hiring team yet/);

  const login = await srv.request('/employer/login', { method: 'POST', form: { email: 'olga@oldco.in', password: 'olga long password' }, headers: headers() });
  const olga = srv.cookieFrom(login);
  assert.match(await (await srv.request('/employer/applicants', { cookie: olga, headers: headers() })).text(), /Kavya Iyer<\/b><\/a> <span class="pill pill-unseen">Not opened<\/span>/);
  for (let i = 0; i < 2; i++) assert.equal((await srv.request('/employer/applicants/app-1', { cookie: olga, headers: headers() })).status, 200);
  const a = srv.records('applications').find((x) => x.id === 'app-1');
  assert.ok(a.viewedAt);
  assert.doesNotMatch(await (await srv.request('/employer/applicants', { cookie: olga, headers: headers() })).text(), /Not opened/);

  const told = srv.records('notifications').filter((n) => n.type === 'application-viewed');
  assert.equal(told.length, 1, 'once, however often it is opened');
  assert.equal(told[0].title, 'Old Co opened your application');
  assert.match(await (await srv.request('/account', { cookie: kavya })).text(), /Seen by the hiring team /);
  const api = await (await srv.request('/api/candidate/applications', { cookie: kavya })).json();
  assert.equal(api.applications.find((x) => x.id === 'app-1').seenByHiringTeamAt, a.viewedAt);
});
