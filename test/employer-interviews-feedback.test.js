// Step 219: the company's Interviews page shows the interviews still waiting
// for feedback, the dashboard's link opens just those, and finished interviews
// read "Finished" with their scorecard summary rather than "scheduled".
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');
const { hashPassword } = require('../employers');

const DAY = 864e5;
const iso = (ago = 0) => new Date(Date.now() - ago * DAY).toISOString();
const day = (ahead) => new Date(Date.now() + 5.5 * 36e5 + ahead * DAY).toISOString().slice(0, 10);
const person = (id, email, name) => ({ id, email, name, phone: '9800000001', passwordHash: hashPassword(`${name} long password`), emailVerifiedAt: iso(1), phoneVerifiedAt: iso(1), createdAt: iso(1), active: true, link: null });
const company = (id, name) => ({ id, company: name, name, email: `o@${id}.in`, active: true, approvedAt: iso(1), createdAt: iso(30) });
const member = (id, employerId, userId, role, jobIds = []) => ({ id, employerId, userId, role, jobIds, createdAt: iso(1) });
const job = (id, employerId, extra = {}) => ({ id, employerId, title: `Job ${id}`, company: 'A Co', location: 'Pune', mode: 'On-site', type: 'Full-time', category: 'Retail', experience: '', skills: [], description: 'Work', responsibilities: [], posted: day(0), status: 'open', alertsSentAt: day(0), resume: 'optional', createdBy: 'employer', ...extra });
const app = (id, jobId, extra = {}) => ({ id, jobId, jobTitle: `Job ${jobId}`, name: `Person ${id}`, email: `${id}@example.in`, phone: `98450219${id.slice(1).padStart(2, '0')}`, status: 'Interview', createdAt: iso(5), history: [], ...extra });
const iv = (id, ago, extra = {}) => ({ id, at: iso(ago), duration: 30, mode: 'Phone', status: 'scheduled', feedback: [], ...extra });
const score = (by, rating, recommendation) => ({ id: `f-${by}`, by, byType: 'employer', rating, recommendation, at: iso(1) });

let srv;
let ann;
let rob;
let vic;
let ip = 0;
const h = () => ({ 'x-forwarded-for': `10.219.${Math.floor(++ip / 250)}.${(ip % 250) + 1}` });
const get = (url, cookie) => srv.request(url, { cookie, headers: h() });
const post = (url, form, cookie) => srv.request(url, { method: 'POST', form, cookie, headers: h() });
const text = async (url, cookie) => (await get(url, cookie)).text();
const dueBlock = (page) => { const i = page.indexOf('id="feedback-due"'); return i === -1 ? '' : page.slice(i, page.indexOf('</section>', i)); };
const names = (s) => [...new Set([...s.matchAll(/Person (a\d+)/g)].map((m) => m[1]))].sort();

before(async () => {
  srv = await startServer({ TRUST_PROXY: '1' }, {
    employers: [company('emp-a', 'A Co'), company('emp-b', 'B Co')],
    'employer-users': [person('u-ann', 'ann@aco.in', 'Ann'), person('u-rob', 'rob@aco.in', 'Rob'), person('u-vic', 'vic@aco.in', 'Vic'), person('u-bob', 'bob@bco.in', 'Bob')],
    'employer-members': [member('m1', 'emp-a', 'u-ann', 'owner'), member('m2', 'emp-a', 'u-rob', 'recruiter', ['j1']), member('m3', 'emp-a', 'u-vic', 'viewer'), member('m4', 'emp-b', 'u-bob', 'owner')],
    jobs: [job('j1', 'emp-a'), job('j2', 'emp-a'), job('j9', 'emp-b')],
    applications: [
      app('a1', 'j1', { interviews: [iv('v1', 1)] }),
      app('a2', 'j2', { interviews: [iv('v2', 2)] }),
      app('a3', 'j1', { interviews: [iv('v3', 1, { feedback: [score('Ann', 4, 'Hire'), score('Rob', 5, 'Hire')] }), iv('v4', 2, { status: 'cancelled' })] }),
      app('a4', 'j1', { interviews: [iv('v5', -2)] }),
      app('a5', 'j1', { withdrawnAt: iso(1), interviews: [iv('v6', 1)] }),
      app('a6', 'j9', { interviews: [iv('v7', 1)] }),
    ],
  });
  const login = async (email, name) => srv.cookieFrom(await post('/employer/login', { email, password: `${name} long password` }));
  ann = await login('ann@aco.in', 'Ann');
  rob = await login('rob@aco.in', 'Rob');
  vic = await login('vic@aco.in', 'Vic');
}, { timeout: 60000 });
after(() => srv && srv.stop());

test('the Interviews page lists what is waiting for feedback, for this person', async () => {
  assert.deepEqual(names(dueBlock(await text('/employer/interviews', ann))), ['a1', 'a2'], 'not scored, cancelled, upcoming, withdrawn or another company’s');
  assert.deepEqual(names(dueBlock(await text('/employer/interviews', rob))), ['a1'], 'only the job Rob works on');
  assert.equal(dueBlock(await text('/employer/interviews', vic)), '', 'a viewer can’t write feedback');
  assert.match(dueBlock(await text('/employer/interviews', ann)), /href="\/employer\/applicants\/a1#interviews"/);
});

test('the dashboard link opens just those', async () => {
  const dash = await text('/employer', ann);
  assert.match(dash, /href="\/employer\/interviews\?todo=feedback"/);
  const page = await text('/employer/interviews?todo=feedback', ann);
  assert.match(page, /Showing: <b>Finished interviews with no feedback yet<\/b>/);
  assert.deepEqual(names(page.slice(page.indexOf('<main'))).filter((n) => n !== 'a3' && n !== 'a4'), ['a1', 'a2']);
  assert.doesNotMatch(page, /Person a4|Past and cancelled/, 'nothing else on the filtered page');
  assert.match(await text('/employer/interviews?todo=feedback', vic), /Nothing waiting for your feedback/);
});

test('finished and cancelled interviews say so, with the feedback summary', async () => {
  const page = await text('/employer/interviews', ann);
  const i = page.indexOf('Past and cancelled');
  const past = page.slice(i, page.indexOf('</section>', i));
  assert.match(past, />Finished<\/span>[^]*Person a3[^]*<b>Hire<\/b>, 4\.5\/5 \(2 scorecards\)/);
  assert.match(past, />Cancelled<\/span>/);
  assert.match(past, /no feedback yet/);
  assert.doesNotMatch(past, />scheduled</);
  const applicant = await text('/employer/applicants/a3', ann);
  assert.match(applicant, />Finished<\/span>/);
  assert.match(applicant, />Cancelled<\/span>/);
  assert.match(await text('/employer/applicants/a4', ann), />Scheduled<\/span>/);
});

test('saving feedback takes it off the list', async () => {
  const r = await post('/employer/applicants/a1/interviews/v1/feedback', { rating: 4, recommendation: 'Hire', strengths: 'Clear' }, ann);
  assert.ok([302, 303].includes(r.status), `status ${r.status}`);
  assert.deepEqual(names(dueBlock(await text('/employer/interviews', ann))), ['a2']);
});
