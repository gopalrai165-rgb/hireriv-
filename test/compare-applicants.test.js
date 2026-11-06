// Step 212: employers compare 2 to 4 applicants side by side. It never ranks
// them, leaves out contact details, and follows each applicant page's role limits.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');
const { hashPassword } = require('../employers');

const iso = (ago = 0) => new Date(Date.now() - ago * 864e5).toISOString();
const today = iso().slice(0, 10);
const QUESTIONS = [{ id: 'q1', text: 'Do you have a licence?', type: 'yesno', mustBe: 'yes' }, { id: 'q2', text: 'Which city do you live in?', type: 'text', mustBe: '' }];
const person = (id, email, name) => ({ id, email, name, phone: '9800000001', passwordHash: hashPassword(`${name} long password`), emailVerifiedAt: iso(1), phoneVerifiedAt: iso(1), createdAt: iso(1), active: true, link: null });
const company = (id, name) => ({ id, company: name, name, email: `o@${id}.in`, active: true, approvedAt: iso(1), createdAt: iso(30) });
const member = (id, employerId, userId, role, jobIds = []) => ({ id, employerId, userId, role, jobIds, createdAt: iso(1) });
const job = (id, employerId, extra = {}) => ({ id, employerId, title: `Job ${id}`, company: 'A Co', location: 'Pune', mode: 'On-site', type: 'Full-time', category: 'Retail', experience: '', skills: ['Driving'], description: 'Work', responsibilities: [], posted: today, status: 'open', alertsSentAt: today, resume: 'optional', createdBy: 'employer', ...extra });
const app = (id, jobId, extra = {}) => ({ id, jobId, jobTitle: `Job ${jobId}`, name: `Person ${id}`, email: `${id}@example.in`, phone: `98450212${id.slice(1).padStart(2, '0')}`, status: 'New', createdAt: iso(2), history: [], ...extra });
const said = (a, b) => [{ id: 'q1', text: QUESTIONS[0].text, type: 'yesno', mustBe: 'yes', answer: a }, { id: 'q2', text: QUESTIONS[1].text, type: 'text', mustBe: '', answer: b }];

let srv;
let ann;
let rob;
let vic;
let bob;
let ip = 0;
const h = () => ({ 'x-forwarded-for': `10.212.${Math.floor(++ip / 250)}.${(ip % 250) + 1}` });
const get = (url, cookie) => srv.request(url, { cookie, headers: h() });
const post = (url, form, cookie) => srv.request(url, { method: 'POST', form, cookie, headers: h() });
const said2 = (r) => decodeURIComponent((r.headers.get('location') || '').replace(/\+/g, ' '));
const cmp = (...ids) => `/employer/applicants/compare?${ids.map((i) => `ids=${i}`).join('&')}`;
const rec = (id) => srv.records('applications').find((a) => a.id === id);

before(async () => {
  srv = await startServer({ TRUST_PROXY: '1' }, {
    employers: [company('emp-a', 'A Co'), company('emp-b', 'B Co')],
    'employer-users': [person('u-ann', 'ann@aco.in', 'Ann'), person('u-rob', 'rob@aco.in', 'Rob'), person('u-vic', 'vic@aco.in', 'Vic'), person('u-bob', 'bob@bco.in', 'Bob')],
    'employer-members': [member('m1', 'emp-a', 'u-ann', 'owner'), member('m2', 'emp-a', 'u-rob', 'recruiter', ['j1']), member('m3', 'emp-a', 'u-vic', 'viewer'), member('m4', 'emp-b', 'u-bob', 'owner')],
    jobs: [job('j1', 'emp-a', { screeningQuestions: QUESTIONS }), job('j2', 'emp-a'), job('j9', 'emp-b')],
    applications: [
      app('a1', 'j1', { skills: 'Driving', experience: '3 years', location: 'Pune', screening: said('yes', 'Pune'), interviews: [{ id: 'v1', at: iso(3), duration: 30, mode: 'Phone', status: 'scheduled', feedback: [{ by: 'Ann', at: iso(2), rating: 4, recommendation: 'Yes' }, { by: 'Rob', at: iso(2), rating: 5, recommendation: 'Yes' }] }] }),
      app('a2', 'j1', { skills: 'Cooking', experience: '1 year', screening: said('no', 'Delhi'), viewedAt: iso(1) }),
      app('a3', 'j2'),
      app('a4', 'j1'),
      app('a5', 'j1'),
      app('a9', 'j9'),
    ],
  });
  const login = async (email, name) => srv.cookieFrom(await post('/employer/login', { email, password: `${name} long password` }));
  ann = await login('ann@aco.in', 'Ann');
  rob = await login('rob@aco.in', 'Rob');
  vic = await login('vic@aco.in', 'Vic');
  bob = await login('bob@bco.in', 'Bob');
}, { timeout: 60000 });
after(() => srv && srv.stop());

test('the list has a Compare button that skips the move question and the required stage', async () => {
  const page = await (await get('/employer/applicants', ann)).text();
  assert.match(page, /formaction="\/employer\/applicants\/compare" formmethod="get" formnovalidate data-no-confirm>Compare/);
});

test('people from one job line up, question by question', async () => {
  const r = await get(cmp('a1', 'a2'), ann);
  assert.equal(r.status, 200);
  const page = await r.text();
  assert.match(page, /href="\/employer\/applicants\/a1">Person a1/);
  assert.match(page, /href="\/employer\/applicants\/a2">Person a2/);
  assert.match(page, /3 years/);
  assert.match(page, /Cooking/);
  assert.match(page, /<th scope="row">Do you have a licence\?<\/th><td>Yes<\/td><td>No<\/td>/);
  assert.match(page, /<th scope="row">Which city do you live in\?<\/th><td>Pune<\/td><td>Delhi<\/td>/);
  assert.match(page, /4\.5\/5 \(2 scorecards\)/);
  assert.match(page, /never a reason to turn anyone away/);
});

test('it leaves out contact details and never picks anyone', async () => {
  const page = await (await get(cmp('a1', 'a2'), ann)).text();
  const body = page.slice(page.indexOf('compare-table'), page.indexOf('</table>'));
  assert.doesNotMatch(body, /a1@example\.in|9845021201|tel:|mailto:/);
  assert.doesNotMatch(body, /best|recommended|winner|top pick/i);
});

test('people from different jobs compare without the question rows', async () => {
  const page = await (await get(cmp('a1', 'a3'), ann)).text();
  assert.doesNotMatch(page, /<th scope="row">Do you have a licence/);
  assert.match(page, /<th scope="row">Needed answers/);
});

test('each person counts as viewed, once, and it is recorded', async () => {
  assert.equal(rec('a4').viewedAt, undefined);
  await get(cmp('a4', 'a5'), ann);
  assert.ok(rec('a4').viewedAt);
  assert.ok(rec('a5').viewedAt);
  const log = srv.records('employer-audit').filter((e) => e.event === 'applicant-viewed').map((e) => e.detail);
  assert.ok(log.includes('Person a4 for Job j1'));
  const kept = rec('a2').viewedAt;
  await get(cmp('a1', 'a2'), ann);
  assert.equal(rec('a2').viewedAt, kept, 'the first time stays');
});

test('how many, whose and which roles', async () => {
  assert.match(said2(await get(cmp('a1'), ann)), /Tick 2 to 4/);
  assert.match(said2(await get('/employer/applicants/compare', ann)), /Tick 2 to 4/);
  assert.match(said2(await get(cmp('a1', 'a1'), ann)), /Tick 2 to 4/, 'the same person twice is one person');
  assert.match(said2(await get(cmp('a1', 'a2', 'a3', 'a4', 'a5'), ann)), /Tick 2 to 4/);
  assert.match(said2(await get(cmp('a1', 'a9'), ann)), /not on your jobs/, 'another company');
  assert.match(said2(await get(cmp('a1', 'a3'), rob)), /not on your jobs/, 'a job they do not work on');
  assert.match(said2(await get(cmp('a1', 'a2'), bob)), /not on your jobs/);
  const v = await (await get(cmp('a1', 'a2'), vic)).text();
  assert.match(v, /Which city do you live in\?<\/th><td><span class="muted">Shown to the people working on this job/);
  assert.doesNotMatch(v, /a1\/resume/);
  assert.notEqual((await get(cmp('a1', 'a2'))).status, 200);
});
