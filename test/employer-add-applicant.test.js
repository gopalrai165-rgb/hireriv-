// Step 206: employers add applicants who reached them another way (phone call,
// walk-in, WhatsApp, referral) and record answers to the job's questions. The
// person is told by email when there is one, and can withdraw.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, decodeEmail } = require('./helpers');
const { hashPassword } = require('../employers');

const iso = (ago = 0) => new Date(Date.now() - ago * 864e5).toISOString();
const today = iso().slice(0, 10);
const QUESTIONS = [{ id: 'q1', text: 'Do you have a licence?', type: 'yesno', mustBe: 'yes' }, { id: 'q2', text: 'Which city do you live in?', type: 'text', mustBe: '' }];
const person = (id, email, name) => ({ id, email, name, phone: '9800000001', passwordHash: hashPassword(`${name} long password`), emailVerifiedAt: iso(1), phoneVerifiedAt: iso(1), createdAt: iso(1), active: true, link: null });
const company = (id, name) => ({ id, company: name, name, email: `o@${id}.in`, active: true, approvedAt: iso(1), createdAt: iso(30) });
const member = (id, employerId, userId, role, jobIds = []) => ({ id, employerId, userId, role, jobIds, createdAt: iso(1) });
const job = (id, employerId, extra = {}) => ({ id, employerId, title: `Job ${id}`, company: 'A Co', location: 'Pune', mode: 'On-site', type: 'Full-time', category: 'Retail', experience: '', skills: [], description: 'Work', responsibilities: [], posted: today, status: 'open', alertsSentAt: today, resume: 'optional', createdBy: 'employer', ...extra });

let srv;
let ann;
let rob;
let vic;
let bob;
let ip = 0;
const h = () => ({ 'x-forwarded-for': `10.206.${Math.floor(++ip / 250)}.${(ip % 250) + 1}` });
const get = (url, cookie) => srv.request(url, { cookie, headers: h() });
const post = (url, form, cookie) => srv.request(url, { method: 'POST', form, cookie, headers: h() });
const text = async (url, cookie) => (await get(url, cookie)).text();
const said = (r) => decodeURIComponent((r.headers.get('location') || '').replace(/\+/g, ' '));
const apps = () => srv.records('applications');
const NEW = '/employer/applicants/new';
const form = (extra = {}) => ({ jobId: 'j1', name: 'Kiran Das', phone: '9845014001', source: 'walk-in', consent: '1', ...extra });

before(async () => {
  srv = await startServer({ TRUST_PROXY: '1' }, {
    employers: [company('emp-a', 'A Co'), company('emp-b', 'B Co')],
    'employer-users': [person('u-ann', 'ann@aco.in', 'Ann'), person('u-rob', 'rob@aco.in', 'Rob'), person('u-vic', 'vic@aco.in', 'Vic'), person('u-bob', 'bob@bco.in', 'Bob')],
    'employer-members': [member('m1', 'emp-a', 'u-ann', 'owner'), member('m2', 'emp-a', 'u-rob', 'recruiter', ['j1']), member('m3', 'emp-a', 'u-vic', 'viewer'), member('m4', 'emp-b', 'u-bob', 'owner')],
    jobs: [job('j1', 'emp-a', { screeningQuestions: QUESTIONS }), job('j2', 'emp-a'), job('j3', 'emp-a', { status: 'closed' }), job('j9', 'emp-b'), { ...job('j8', ''), employerId: undefined, createdBy: undefined }],
    applications: [{ id: 'a1', jobId: 'j1', jobTitle: 'Job j1', name: 'Own Words', email: 'own@example.in', phone: '9845014099', status: 'New', createdAt: iso(2), history: [], screening: [{ id: 'q1', text: 'Do you have a licence?', type: 'yesno', mustBe: 'yes', answer: 'no' }, { id: 'q2', text: 'Which city do you live in?', type: 'text', mustBe: '', answer: 'Theirs' }] }],
  });
  const login = async (email, name) => srv.cookieFrom(await post('/employer/login', { email, password: `${name} long password` }));
  ann = await login('ann@aco.in', 'Ann');
  rob = await login('rob@aco.in', 'Rob');
  vic = await login('vic@aco.in', 'Vic');
  bob = await login('bob@bco.in', 'Bob');
}, { timeout: 60000 });
after(() => srv && srv.stop());

test('the Applicants page links to the form, which lists only jobs this person can manage', async () => {
  assert.match(await text('/employer/applicants', rob), /href="\/employer\/applicants\/new"/);
  assert.doesNotMatch(await text('/employer/applicants', vic), /href="\/employer\/applicants\/new"/);
  const page = await text(NEW, rob);
  assert.match(page, /value="j1"/);
  assert.doesNotMatch(page, /value="j2"|value="j3"|value="j9"/);
  const owners = await text(NEW, ann);
  assert.match(owners, /value="j2"/);
  assert.doesNotMatch(owners, /value="j3"/, 'no closed jobs');
  assert.equal((await get(NEW, vic)).status, 403);
});

test('adding someone: the record says who and how, and the team on the job hears about it', async () => {
  const r = await post(NEW, form({ email: 'kiran@example.in', location: 'Pune', experience: '1-3 years', skills: 'Driving', answer_q1: 'yes', answer_q2: 'Pune' }), rob);
  assert.equal(r.status, 303);
  const a = apps().find((x) => x.name === 'Kiran Das');
  assert.ok(a);
  assert.match(said(r), new RegExp(`^/employer/applicants/${a.id}\\?msg=Added Kiran`));
  assert.equal(a.jobId, 'j1');
  assert.equal(a.source, 'walk-in');
  assert.equal(a.addedVia, 'Walk-in');
  assert.equal(a.addedBy, 'Rob');
  assert.equal(a.addedByEmployer, 'emp-a');
  assert.deepEqual(a.screening.map((x) => x.answer), ['yes', 'Pune']);
  assert.equal(a.screeningRecordedBy.by, 'Rob');
  const page = await text(`/employer/applicants/${a.id}`, ann);
  assert.match(page, /Added by Rob · Walk-in/);
  assert.match(page, /Recorded by Rob/);
  assert.ok(srv.records('notifications').some((n) => n.type === 'new-application' && n.link && n.link.includes(a.id)), 'the people on the job are told');
  const log = srv.records('employer-audit').find((e) => e.event === 'applicant-added');
  assert.match(log.detail, /Job j1 \(Walk-in\)/);
  assert.doesNotMatch(log.detail, /Kiran/);
});

test('the person is told by email, with how to withdraw, and that it is free', async () => {
  const mail = decodeEmail(await srv.waitForEmail((m) => m.includes('To: kiran@example.in') && /added you/.test(decodeEmail(m))));
  assert.match(mail, /A Co added you as an applicant for Job j1/);
  assert.match(mail, /withdraw/i);
  assert.match(mail, /never pay/i);
  assert.doesNotMatch(mail, /Application received/);
});

test('what has to be there', async () => {
  const before_ = apps().length;
  const bad = async (extra, re) => {
    const r = await post(NEW, form(extra), ann);
    assert.equal(r.status, 400, JSON.stringify(extra));
    assert.match(await r.text(), re);
  };
  await bad({ consent: '' }, /agreed to be added/);
  await bad({ name: '' }, /name is required/);
  await bad({ phone: '12' }, /phone is invalid/);
  await bad({ source: 'magic' }, /how they reached you/);
  await bad({ jobId: 'j3' }, /pick one of your open jobs/);
  await bad({ jobId: 'j9' }, /pick one of your open jobs/);
  await bad({ jobId: 'j8' }, /pick one of your open jobs/);
  await bad({ answer_q1: 'yes' }, /please answer: Which city/);
  assert.equal(apps().length, before_);
  const kept = await (await post(NEW, form({ consent: '', name: 'Kept <b>Name</b>' }), ann)).text();
  assert.match(kept, /value="Kept &lt;b&gt;Name&lt;\/b&gt;"/, 'the form keeps what was typed, escaped');
});

test('no answers is fine; someone already applied is not changed', async () => {
  const r = await post(NEW, form({ name: 'No Answers', phone: '9845014002' }), ann);
  assert.equal(r.status, 303);
  const a = apps().find((x) => x.name === 'No Answers');
  assert.equal(a.screening, undefined);
  const again = await post(NEW, form({ name: 'Other Name', phone: '9845014099' }), ann);
  assert.match(said(again), /^\/employer\/applicants\/a1\?msg=.*already applied/);
  assert.equal(apps().find((x) => x.id === 'a1').name, 'Own Words', 'their own details stay');
  assert.equal((await post(NEW, form({ name: 'By email', phone: '9845014003', email: 'OWN@example.in' }), ann)).headers.get('location').startsWith('/employer/applicants/a1'), true);
});

test('roles, other companies and forms from elsewhere', async () => {
  const before_ = apps().length;
  assert.equal((await post(NEW, form({ phone: '9845014010' }), vic)).status, 403);
  assert.equal((await post(NEW, form({ jobId: 'j2', phone: '9845014011' }), rob)).status, 400, 'not on that job');
  assert.equal((await post(NEW, form({ phone: '9845014012' }), bob)).status, 400);
  assert.equal((await srv.request(NEW, { method: 'POST', form: form({ phone: '9845014013' }), cookie: ann, headers: { ...h(), origin: 'https://evil.example' } })).status, 403);
  assert.notEqual((await post(NEW, form({ phone: '9845014014' }))).status, 303);
  assert.equal(apps().length, before_);
});

test('employers record answers later, never over the candidate\'s own', async () => {
  const id = apps().find((x) => x.name === 'No Answers').id;
  const page = await text(`/employer/applicants/${id}`, ann);
  assert.match(page, /Record their answers/);
  assert.match(page, new RegExp(`action="/employer/applicants/${id}/answers"`));
  assert.match(said(await post(`/employer/applicants/${id}/answers`, { answer_q1: 'no', answer_q2: 'Delhi' }, ann)), /Answers saved/);
  assert.deepEqual(apps().find((x) => x.id === id).screening.map((x) => x.answer), ['no', 'Delhi']);
  assert.match(await text(`/employer/applicants/${id}`, ann), /Correct these answers/);
  assert.doesNotMatch(await text('/employer/applicants/a1', ann), /Record their answers|Correct these answers/);
  assert.match(said(await post('/employer/applicants/a1/answers', { answer_q1: 'yes', answer_q2: 'X' }, ann)), /answered these themselves/);
  assert.equal(apps().find((x) => x.id === 'a1').screening[0].answer, 'no');
  assert.equal((await post(`/employer/applicants/${id}/answers`, { answer_q1: 'yes', answer_q2: 'X' }, vic)).status, 403);
  assert.equal((await post(`/employer/applicants/${id}/answers`, { answer_q1: 'yes', answer_q2: 'X' }, bob)).status, 404);
});
