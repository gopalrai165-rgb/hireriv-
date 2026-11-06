// Step 197: screening questions. Asked on every way to apply, saved with a copy
// of the question, read by a person. The needed answer is never shown to the
// person applying and never rejects anyone. Things an employer must not ask are
// refused when the job is saved.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, decodeEmail } = require('./helpers');
const { hashPassword } = require('../employers');
const screening = require('../screening');

const iso = (ago = 0) => new Date(Date.now() - ago * 864e5).toISOString();
const today = new Date(Date.now() + 5.5 * 36e5).toISOString().slice(0, 10);
const LICENCE = 'Do you have a two-wheeler licence?';
const NIGHTS = 'Can you work nights in Hinjewadi?';
const AREA = 'Which area do you live in?';
const { questions: QS } = screening.parse({ screeningQuestions: [{ text: LICENCE, mustBe: 'yes' }, { text: NIGHTS }, { text: AREA, type: 'text' }] });
const [licence, nights, area] = QS;
const answers = (l = 'yes', n = 'no', a = 'Wakad') => ({ [`answer_${licence.id}`]: l, [`answer_${nights.id}`]: n, [`answer_${area.id}`]: a });
const base = { company: 'A Co', location: 'Pune', mode: 'On-site', type: 'Full-time', category: 'Retail', experience: '', salary: '', skills: [], description: 'Work', responsibilities: [], posted: today, status: 'open', alertsSentAt: today, resume: 'optional' };
const person = (id, email, name) => ({ id, email, name, phone: '9800000001', passwordHash: hashPassword(`${name} long password`), emailVerifiedAt: iso(1), phoneVerifiedAt: iso(1), createdAt: iso(1), active: true, link: null });
const member = (id, userId, role) => ({ id, employerId: 'emp-a', userId, role, jobIds: [], createdAt: iso(1) });
const JOB_FORM = { title: 'Rider', category: 'Retail', location: 'Pune', mode: 'On-site', type: 'Full-time', salaryMin: '20000', salaryMax: '25000', salaryPeriod: 'month', shift: 'Day', description: 'Deliver parcels.', responsibilities: 'Deliver', skills: 'Riding' };

let srv;
let team;
let owner;
let viewer;
let ip = 0;
const h = () => ({ 'x-forwarded-for': `10.197.${Math.floor(++ip / 250)}.${(ip % 250) + 1}` });
const get = (url, cookie) => srv.request(url, { cookie, headers: h() });
const post = (url, form, cookie) => srv.request(url, { method: 'POST', form, cookie, headers: h() });
const appsFor = (jobId) => srv.records('applications').filter((a) => a.jobId === jobId);
const apply = (jobId, name, phone, extra) => post('/api/apply', { jobId, name, phone, ...extra });
const jsonOf = async (r) => JSON.parse(await r.text());

async function seeker(email, phone) {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ name: 'Ravi Kumar', email, phone, location: 'Pune', agree: '1' })) fd.append(k, v);
  assert.equal((await srv.request('/account/register', { method: 'POST', body: fd, headers: h() })).status, 200);
  await srv.waitForEmail((m) => m.includes(`To: ${email}`) && decodeEmail(m).includes('/account/verify/'));
  const mail = decodeEmail(srv.emails().filter((m) => m.includes(`To: ${email}`)).pop());
  return srv.cookieFrom(await srv.request(mail.match(/\/account\/verify\/[a-f0-9]{64}/)[0], { method: 'POST', form: {}, headers: h() }));
}

before(async () => {
  srv = await startServer({ TRUST_PROXY: '1' }, {
    employers: [{ id: 'emp-a', company: 'A Co', name: 'A Co', email: 'owner@aco.in', active: true, approvedAt: iso(1), createdAt: iso(30) }],
    'employer-users': [person('u-ann', 'ann@aco.in', 'Ann'), person('u-vic', 'vic@aco.in', 'Vic')],
    'employer-members': [member('m1', 'u-ann', 'owner'), member('m2', 'u-vic', 'viewer')],
    jobs: [
      { ...base, id: 'hr-1', title: 'Delivery Rider', employerId: 'emp-a', createdBy: 'employer', createdByUser: 'u-ann', screeningQuestions: QS },
      { ...base, id: 'hr-2', title: 'Store Helper' },
      { ...base, id: 'hr-3', title: 'Second Rider', screeningQuestions: QS },
    ],
  });
  team = await srv.adminLogin();
  owner = srv.cookieFrom(await post('/employer/login', { email: 'ann@aco.in', password: 'Ann long password' }));
  viewer = srv.cookieFrom(await post('/employer/login', { email: 'vic@aco.in', password: 'Vic long password' }));
}, { timeout: 60000 });
after(() => srv && srv.stop());

test('writing questions: limits, answer types and needed answers', () => {
  const ok = screening.parse({ qText0: ' Can you  lift 20 kg? ', qType0: 'yesno', qMustBe0: 'yes', qText1: '', qText2: 'Where do you live?', qType2: 'text', qMustBe2: '' });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.questions.map((q) => [q.text, q.type, q.mustBe]), [['Can you lift 20 kg?', 'yesno', 'yes'], ['Where do you live?', 'text', '']]);
  assert.equal(ok.questions[0].id, screening.parse({ screeningQuestions: ['can you lift 20 kg?'] }).questions[0].id, 'the same words keep their id');
  assert.match(screening.parse({ screeningQuestions: [{ text: 'A?', type: 'text', mustBe: 'yes' }] }).errors[0], /only works with a Yes or No/);
  assert.match(screening.parse({ screeningQuestions: [{ text: 'A?', type: 'essay' }] }).errors[0], /answer type/);
  assert.match(screening.parse({ screeningQuestions: [{ text: 'A?', mustBe: 'maybe' }] }).errors[0], /must be yes or no/);
  assert.match(screening.parse({ screeningQuestions: ['A?', 'a?'] }).errors[0], /same as an earlier/);
  assert.match(screening.parse({ screeningQuestions: 'A?' }).errors[0], /must be a list/);
  assert.match(screening.parse({ screeningQuestions: ['1', '2', '3', '4', '5', '6'] }).errors[0], /up to 5/);
});

test('what must not be asked is refused; what the work needs is not', () => {
  const refused = (text, type = 'yesno') => screening.parse({ screeningQuestions: [{ text, type }] }).errors.length > 0;
  for (const q of ['Are you married?', 'What is your caste?', 'How old are you?', 'What is your religion?', 'Male or female?', 'Are you pregnant?', 'Do you have children?',
    'Can you pay the registration fee?', 'Can you pay a deposit?', 'What is your OTP?', 'Tell us your password', 'Message us at 9812345678', 'See https://x.example', 'Mail hr@x.example']) assert.ok(refused(q), q);
  assert.ok(refused('What is your Aadhaar number?', 'text'));
  for (const q of ['Do you have a two-wheeler licence?', 'Can you work nights?', 'Have you taught children before?', 'Are you OK with the pay on offer?', 'Do you have a PAN card?', 'Can you lift 20 kg?']) assert.ok(!refused(q), q);
});

test('the job form saves questions and shows them again; a bad one comes back with the words kept', async () => {
  const form = { ...JOB_FORM, qText0: LICENCE, qType0: 'yesno', qMustBe0: 'yes', qText1: AREA, qType1: 'text', qMustBe1: '' };
  assert.equal((await post('/employer/jobs', form, owner)).status, 302);
  const job = srv.records('jobs').find((j) => j.title === 'Rider');
  assert.deepEqual(job.screeningQuestions.map((q) => [q.text, q.type, q.mustBe]), [[LICENCE, 'yesno', 'yes'], [AREA, 'text', '']]);
  const edit = await (await get(`/employer/jobs/${job.id}/edit`, owner)).text();
  assert.match(edit, /value="Do you have a two-wheeler licence\?"/);

  const bad = await post('/employer/jobs', { ...JOB_FORM, title: 'Rider two', qText0: 'Are you married?' }, owner);
  assert.equal(bad.status, 400);
  const html = await bad.text();
  assert.match(html, /asks about something personal/);
  assert.match(html, /value="Are you married\?"/);

  // The team's form too, and it can clear them.
  const teamForm = { ...JOB_FORM, company: 'Team Client', title: 'Team job', status: 'open', qText0: 'Can you start on Monday?', qType0: 'yesno', qMustBe0: '' };
  assert.equal((await post('/admin/jobs', teamForm, team)).status, 302);
  const tj = srv.records('jobs').find((j) => j.title === 'Team job');
  assert.equal(tj.screeningQuestions.length, 1);
  assert.match(await (await get(`/admin/jobs/${tj.id}/edit`, team)).text(), /Can you start on Monday\?/);
  await post(`/admin/jobs/${tj.id}`, { ...teamForm, qText0: '' }, team);
  assert.deepEqual(srv.records('jobs').find((j) => j.id === tj.id).screeningQuestions, []);
});

test('the job page asks the questions, and never shows the needed answer', async () => {
  const html = await (await get('/jobs/hr-1')).text();
  assert.match(html, new RegExp(`type="radio" name="answer_${licence.id}" value="yes" required`));
  assert.match(html, new RegExp(`<input name="answer_${area.id}" maxlength="300" required>`));
  assert.doesNotMatch(html, /mustBe|needs:/);
  assert.doesNotMatch(await (await get('/jobs/hr-2')).text(), /answer_q/);
  const api = await jsonOf(await get('/api/public/jobs/hr-1'));
  const raw = JSON.stringify(api);
  assert.ok(raw.includes(LICENCE));
  assert.doesNotMatch(raw, /mustBe/);
});

test('the public form needs every answer, checks them, and saves a copy of the question', async () => {
  const none = await apply('hr-1', 'Asha Rao', '9845000001');
  assert.equal(none.status, 400);
  assert.match(await none.text(), /please answer/);
  assert.equal((await apply('hr-1', 'Asha Rao', '9845000001', answers('maybe'))).status, 400);
  assert.equal((await apply('hr-1', 'Asha Rao', '9845000001', answers('yes', 'no', '   '))).status, 400);
  assert.equal(appsFor('hr-1').length, 0);

  assert.ok((await apply('hr-1', 'Asha Rao', '9845000001', answers())).ok);
  const a = appsFor('hr-1')[0];
  assert.deepEqual(a.screening.map((x) => [x.text, x.answer]), [[LICENCE, 'yes'], [NIGHTS, 'no'], [AREA, 'Wakad']]);
  assert.equal(screening.outcome(a), 'meets');
  assert.ok((await apply('hr-2', 'Asha Rao', '9845000001')).ok, 'jobs with no questions are unchanged');

  // A "wrong" answer still applies: a person decides.
  assert.ok((await apply('hr-1', 'Bala Iyer', '9845000002', answers('no'))).ok);
  const b = appsFor('hr-1').find((x) => x.name === 'Bala Iyer');
  assert.equal(b.status, 'New');
  assert.equal(screening.outcome(b), 'misses');

  // Applying again replaces the answers.
  assert.ok((await apply('hr-1', 'Bala Iyer', '9845000002', answers('yes'))).ok);
  assert.equal(screening.outcome(appsFor('hr-1').find((x) => x.name === 'Bala Iyer')), 'meets');
  assert.ok((await apply('hr-1', 'Bala Iyer', '9845000002', answers('no'))).ok);
});

test('signed in: one-tap is hidden, a one-tap sent anyway does not apply, the job page form does', async () => {
  const cookie = await seeker('ravi@example.in', '9845012399');
  const list = await (await get('/jobs', cookie)).text();
  assert.ok(list.includes('action="/account/apply/hr-2"'), 'an ordinary job keeps one-tap');
  assert.ok(!list.includes('action="/account/apply/hr-3"'), 'no one-tap where there are questions');

  const tap = await post('/account/apply/hr-3', { from: 'card' }, cookie);
  assert.equal(tap.status, 302);
  assert.match(decodeURIComponent(tap.headers.get('location')), /a few questions/);
  assert.equal(appsFor('hr-3').length, 0);

  const page = await (await get('/jobs/hr-3', cookie)).text();
  const oneClick = page.match(/<div class="one-click">[\s\S]*?<\/form>/)[0];
  assert.match(oneClick, new RegExp(`name="answer_${licence.id}"`));

  assert.equal((await post('/account/apply/hr-3', answers(), cookie)).status, 302);
  const saved = appsFor('hr-3')[0];
  assert.equal(saved.oneClick, true);
  assert.equal(saved.screening.length, 3);
  const data = await jsonOf(await get('/account/my-data.json', cookie));
  const mine = data.applications.find((x) => x.job === 'Second Rider');
  assert.deepEqual(mine.answersToJobQuestions[0], { question: LICENCE, answer: 'Yes' });
});

test('employers read the answers; the filter only narrows the list; typed answers follow the contact rule', async () => {
  const list = await (await get('/employer/applicants?job=hr-1', owner)).text();
  assert.match(list, /Asha Rao/);
  assert.match(list, /Bala Iyer/);
  assert.match(list, /Has the needed answers/);
  assert.match(list, /1 answer to check/);
  const misses = await (await get('/employer/applicants?job=hr-1&answers=misses', owner)).text();
  assert.match(misses, /Bala Iyer/);
  assert.doesNotMatch(misses, /Asha Rao/);
  assert.match(await (await get('/employer/applicants?job=hr-1&answers=meets', owner)).text(), /Asha Rao/);

  const bala = appsFor('hr-1').find((x) => x.name === 'Bala Iyer');
  assert.equal(bala.status, 'New', 'the filter moved nobody');
  const page = await (await get(`/employer/applicants/${bala.id}`, owner)).text();
  assert.match(page, /Answers to your questions/);
  assert.match(page, /Job needs: Yes/);
  assert.match(page, /Wakad/);
  assert.match(page, /it never rejects anyone/);

  const seen = await (await get(`/employer/applicants/${bala.id}`, viewer)).text();
  assert.match(seen, /Job needs: Yes/, 'a Yes or No is shown');
  assert.doesNotMatch(seen, /Wakad/, 'a typed answer needs the contact permission');
});

test('API v1: answers on applications, typed answers only with the contact permission; jobs take and keep questions', async () => {
  const client = async (name, scopes) => {
    const res = await post('/employer/integrations/clients', [['name', name], ['environment', 'live'], ...scopes.map((x) => ['scopes', x])], owner);
    const html = await res.text();
    const auth = Buffer.from(`${html.match(/Client id: <code>(int_[a-f0-9]+)<\/code>/)[1]}:${html.match(/<code class="secret-value">(hrv_live_[^<]+)<\/code>/)[1]}`).toString('base64');
    const t = await fetch(`${srv.base}/api/v1/oauth/token`, { method: 'POST', headers: { ...h(), authorization: `Basic ${auth}`, 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
    return (await t.json()).access_token;
  };
  const call = async (url, token, method = 'GET', body) => (await fetch(`${srv.base}/api/v1${url}`, { method, headers: { ...h(), authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })).json();
  const id = appsFor('hr-1').find((x) => x.name === 'Bala Iyer').id;
  const plain = (await call(`/applications/${id}`, await client('plain', ['applications:read']))).data;
  assert.equal(plain.screeningOutcome, 'misses');
  assert.deepEqual([plain.screening[0].question, plain.screening[0].answer, plain.screening[0].mustBe, plain.screening[0].met], [LICENCE, 'No', 'yes', false]);
  assert.equal(plain.screening[2].answer, null);
  assert.equal(plain.screening[2].hidden, true);
  const full = (await call(`/applications/${id}`, await client('full', ['applications:read', 'applications:contact']))).data;
  assert.equal(full.screening[2].answer, 'Wakad');

  const writer = await client('writer', ['jobs:read', 'jobs:write']);
  const made = await call('/jobs', writer, 'POST', { ...JOB_FORM, title: 'API rider', screeningQuestions: [{ text: 'Do you have a helmet?', mustBe: 'yes' }] });
  assert.equal(made.data.screeningQuestions[0].mustBe, 'yes', 'the company sees its own needed answer');
  const patched = await call(`/jobs/${made.data.id}`, writer, 'PATCH', { hours: '9 to 6' });
  assert.equal(patched.data.screeningQuestions.length, 1, 'a change to something else keeps the questions');
  const refused = await call(`/jobs/${made.data.id}`, writer, 'PATCH', { screeningQuestions: [{ text: 'What is your caste?' }] });
  assert.match(JSON.stringify(refused), /something personal/);
  const cleared = await call(`/jobs/${made.data.id}`, writer, 'PATCH', { screeningQuestions: [] });
  assert.deepEqual(cleared.data.screeningQuestions, []);
});

test('editing a job leaves earlier answers as they were asked; the team sees them', async () => {
  const before = appsFor('hr-1')[0].screening[0].text;
  const jobs = srv.records('jobs');
  assert.ok(jobs.find((j) => j.id === 'hr-1').screeningQuestions.length);
  const form = { ...JOB_FORM, title: 'Delivery Rider', qText0: 'Do you own a bike?', qType0: 'yesno' };
  assert.equal((await post('/employer/jobs/hr-1', form, owner)).status, 302);
  assert.equal(srv.records('jobs').find((j) => j.id === 'hr-1').screeningQuestions[0].text, 'Do you own a bike?');
  assert.equal(appsFor('hr-1')[0].screening[0].text, before);
  const html = await (await get('/admin?tab=applications', team)).text();
  assert.match(html, /<summary>Answers: 1 answer to check<\/summary>/);
  assert.match(html, /Wakad/);
});

test('words are escaped, and the review step reads Yes or No questions properly', async () => {
  const { questions } = screening.parse({ screeningQuestions: [{ text: 'Can you <b>lift</b> "boxes"?' }] });
  const html = require('ejs').render(fs.readFileSync(path.join(__dirname, '..', 'views', 'partials', 'apply-questions.ejs'), 'utf8'), { questions });
  assert.doesNotMatch(html, /<b>lift/);
  assert.match(html, /&lt;b&gt;lift/);
  const answersView = require('ejs').render(fs.readFileSync(path.join(__dirname, '..', 'views', 'partials', 'screening-answers.ejs'), 'utf8'), { items: [{ text: '<i>Q</i>', answer: '<img src=x>', hidden: false, met: null }] });
  assert.doesNotMatch(answersView, /<img src=x>|<i>Q/);
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'main.js'), 'utf8');
  assert.match(js, /el\.type !== 'radio' \|\| el\.checked/, 'a draft keeps the ticked choice, not the last one');
});
