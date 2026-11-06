// Step 205: the team records a job's question answers for people who didn't fill
// in the form: those who applied on WhatsApp or were added by hand. Then they
// count in the same filters and reports. What a candidate typed themselves stays.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');
const { hashPassword } = require('../employers');

const iso = (ago = 0) => new Date(Date.now() - ago * 864e5).toISOString();
const today = iso().slice(0, 10);
const QUESTIONS = [{ id: 'q1', text: 'Do you have a licence?', type: 'yesno', mustBe: 'yes' }, { id: 'q2', text: 'Which city do you live in?', type: 'text', mustBe: '' }];
const job = (id, extra = {}) => ({ id, title: `Job ${id}`, company: 'Client Co', location: 'Pune', mode: 'On-site', type: 'Full-time', category: 'Retail', experience: '', skills: [], description: 'Work', responsibilities: [], posted: today, status: 'open', alertsSentAt: today, resume: 'optional', screeningQuestions: QUESTIONS, ...extra });
const app = (id, jobId, extra = {}) => ({ id, jobId, jobTitle: `Job ${jobId}`, name: `Person ${id}`, email: `${id}@example.in`, phone: `98450130${id.slice(1).padStart(2, '0')}`, status: 'New', createdAt: iso(2), history: [], ...extra });
const member = (id, name, role) => ({ id, name, email: `${id}@hireriv.test`, role, active: true, passwordHash: hashPassword(`${name} long password`), createdAt: iso(50) });
const THEIRS = [{ id: 'q1', text: 'Do you have a licence?', type: 'yesno', mustBe: 'yes', answer: 'no' }, { id: 'q2', text: 'Which city do you live in?', type: 'text', mustBe: '', answer: 'Their own words' }];

let srv;
let rita;
let fin;
let ip = 0;
const h = () => ({ 'x-forwarded-for': `10.205.${Math.floor(++ip / 250)}.${(ip % 250) + 1}` });
const get = (url, cookie) => srv.request(url, { cookie, headers: h() });
const post = (url, form, cookie) => srv.request(url, { method: 'POST', form, cookie, headers: h() });
const rec = (id) => srv.records('applications').find((a) => a.id === id);
const said = (r) => decodeURIComponent((r.headers.get('location') || '').replace(/\+/g, ' '));
const page = async (id) => (await get(`/admin/applications/${id}`, rita)).text();
const answer = (licence, city) => ({ answer_q1: licence, answer_q2: city });
const url = (id) => `/admin/applications/${id}/answers`;

before(async () => {
  srv = await startServer({ TRUST_PROXY: '1' }, {
    team: [member('t-rita', 'Rita', 'Recruiter'), member('t-fin', 'Farah', 'Finance Manager')],
    employers: [{ id: 'emp-a', company: 'A Co', name: 'A Co', email: 'o@aco.in', active: true, approvedAt: iso(1), createdAt: iso(30) }],
    jobs: [job('j1'), job('j2', { screeningQuestions: [] }), job('j3', { employerId: 'emp-a', company: 'A Co', createdBy: 'employer' })],
    applications: [
      app('a1', 'j1', { addedBy: 'Rita', addedVia: 'WhatsApp chat' }),
      app('a2', 'j1', { screening: THEIRS }),
      app('a3', 'j2'),
      app('a4', 'j3'),
      app('a5', 'j1', { withdrawnAt: iso(1) }),
      app('a6', 'general'),
    ],
  });
  const login = async (id, name) => srv.cookieFrom(await post('/admin/login', { login: `${id}@hireriv.test`, password: `${name} long password` }));
  rita = await login('t-rita', 'Rita');
  fin = await login('t-fin', 'Farah');
}, { timeout: 60000 });
after(() => srv && srv.stop());

test('the page offers the questions when nobody has answered them', async () => {
  const p = await page('a1');
  assert.match(p, /Record their answers/);
  assert.match(p, /Do you have a licence\?/);
  assert.match(p, /name="answer_q1"/);
  assert.match(p, /name="answer_q2"/);
});

test('recording answers counts them like any others, and says who recorded them', async () => {
  const r = await post(url('a1'), answer('yes', 'Pune'), rita);
  assert.equal(r.status, 303);
  assert.match(said(r), /Answers saved/);
  const a = rec('a1');
  assert.deepEqual(a.screening.map((x) => x.answer), ['yes', 'Pune']);
  assert.equal(a.screeningRecordedBy.by, 'Rita');
  assert.equal(a.screeningRecordedBy.userId, 't-rita');
  assert.ok(a.screeningRecordedBy.at);
  const p = await page('a1');
  assert.match(p, /Recorded by Rita/);
  assert.match(p, /What the job needs/);
  assert.ok(srv.records('activity').some((e) => e.action === 'Recorded answers to a job\'s questions' && /Person a1/.test(e.detail) && !/Pune/.test(e.detail)), 'the log leaves the answers out');
});

test('all the questions are needed, and an answer the team recorded can be corrected', async () => {
  const before_ = rec('a1').screening;
  assert.match(said(await post(url('a1'), { answer_q2: 'Delhi' }, rita)), /Not saved: please answer: Do you have a licence/);
  assert.deepEqual(rec('a1').screening, before_);
  assert.match(said(await post(url('a1'), answer('maybe', 'Delhi'), rita)), /Not saved/);
  const p = await page('a1');
  assert.match(p, /Correct these answers/);
  assert.match(p, /value="Pune"/, 'the form starts from what is there');
  await post(url('a1'), answer('no', 'Delhi'), rita);
  assert.deepEqual(rec('a1').screening.map((x) => x.answer), ['no', 'Delhi']);
  assert.match(await page("a1"), /Job needs: Yes/);
});

test("a candidate's own answers can't be changed", async () => {
  const p = await page('a2');
  assert.match(p, /Their own words/);
  assert.doesNotMatch(p, /Record their answers|Correct these answers|Recorded by/);
  assert.match(said(await post(url('a2'), answer('yes', 'Pune'), rita)), /answered these themselves/);
  assert.deepEqual(rec('a2').screening, THEIRS);
  assert.equal(rec('a2').screeningRecordedBy, undefined);
});

test('no form where it does not apply', async () => {
  assert.doesNotMatch(await page('a3'), /Record their answers/);
  assert.match(said(await post(url('a3'), answer('yes', 'Pune'), rita)), /no questions/);
  assert.doesNotMatch(await page('a4'), /Record their answers/);
  assert.match(said(await post(url('a4'), answer('yes', 'Pune'), rita)), /runs its own hiring/);
  assert.doesNotMatch(await page('a5'), /Record their answers/);
  assert.match(said(await post(url('a5'), answer('yes', 'Pune'), rita)), /withdrew/);
  assert.doesNotMatch(await page('a6'), /Record their answers/);
  for (const id of ['a3', 'a4', 'a5', 'a6']) assert.equal(rec(id).screening, undefined);
});

test('roles and forms from elsewhere', async () => {
  assert.equal((await post(url('a1'), answer('yes', 'Pune'), fin)).status, 403);
  assert.doesNotMatch(await (await get('/admin/applications/a1', fin)).text(), /Correct these answers/);
  assert.notEqual((await post(url('a1'), answer('yes', 'Pune'))).status, 303);
  assert.equal((await srv.request(url('a1'), { method: 'POST', form: answer('yes', 'Pune'), cookie: rita, headers: { ...h(), origin: 'https://evil.example' } })).status, 403);
  assert.equal(rec('a1').screening[1].answer, 'Delhi');
  assert.equal((await post(url('nope'), answer('yes', 'Pune'), rita)).status, 404);
});

test('words are escaped', async () => {
  await post(url('a1'), answer('yes', '<script>alert(1)</script>'), rita);
  assert.doesNotMatch(await page('a1'), /<script>alert\(1\)/);
});
