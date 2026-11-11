// Step 222: offers that need a next step. A candidate who accepted but isn't
// marked Hired, and an approved offer past its reply-by date with no answer,
// show on the company's "What needs you", the Applicants filter and the offer.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');
const { hashPassword } = require('../employers');

const DAY = 864e5;
const iso = (ago = 0) => new Date(Date.now() - ago * DAY).toISOString();
const day = (ahead) => new Date(Date.now() + 5.5 * 36e5 + ahead * DAY).toISOString().slice(0, 10);
const person = (id, email, name) => ({ id, email, name, phone: '9800000001', passwordHash: hashPassword(`${name} long password`), emailVerifiedAt: iso(1), phoneVerifiedAt: iso(1), createdAt: iso(1), active: true, link: null });
const member = (id, userId, role) => ({ id, employerId: 'emp-a', userId, role, jobIds: [], createdAt: iso(1) });
const job = (id) => ({ id, employerId: 'emp-a', createdBy: 'employer', title: `Job ${id}`, company: 'A Co', location: 'Pune', mode: 'On-site', type: 'Full-time', category: 'Retail', experience: '', skills: [], description: 'Work', responsibilities: [], posted: day(0), status: 'open', alertsSentAt: day(0), resume: 'optional' });
const app = (id, status, offers, extra = {}) => ({ id, jobId: 'e1', jobTitle: 'Job e1', name: `Person ${id}`, email: `${id}@example.in`, phone: `98450222${id.slice(1).padStart(2, '0')}`, status, createdAt: iso(20), history: [], offers, ...extra });
const offer = (id, { approval = 'approved', response = 'awaiting', respondBy = '', withdrawn = false } = {}) => ({
  id, title: 'Store Manager', salary: null, joiningDate: '', respondBy, notes: '', createdAt: iso(5), createdBy: 'Ann', createdByUserId: 'u-ann',
  approval: { status: approval, by: 'Ann', userId: 'u-ann', at: iso(4), note: '' },
  response: { status: response, at: response === 'awaiting' ? null : iso(1), recordedBy: response === 'awaiting' ? null : 'Them', note: '' },
  ...(withdrawn ? { withdrawnAt: iso(1), withdrawnBy: 'Ann' } : {}),
});

let srv;
let ann;
let vic;
let ip = 0;
const h = () => ({ 'x-forwarded-for': `10.222.${Math.floor(++ip / 250)}.${(ip % 250) + 1}` });
const get = (url, cookie) => srv.request(url, { cookie, headers: h() });
const post = (url, form, cookie) => srv.request(url, { method: 'POST', form, cookie, headers: h() });
const text = async (url, cookie) => (await get(url, cookie)).text();
const todo = (page) => { const i = page.indexOf('id="todo"'); return i === -1 ? '' : page.slice(i, page.indexOf('</section>', i)); };
const names = (page) => [...new Set([...page.matchAll(/Person (f\d+)/g)].map((m) => m[1]))].sort();

before(async () => {
  srv = await startServer({ TRUST_PROXY: '1' }, {
    employers: [{ id: 'emp-a', company: 'A Co', name: 'Ann', email: 'o@a.in', active: true, approvedAt: iso(1), createdAt: iso(30) }],
    'employer-users': [person('u-ann', 'ann@aco.in', 'Ann'), person('u-vic', 'vic@aco.in', 'Vic')],
    'employer-members': [member('m1', 'u-ann', 'owner'), member('m3', 'u-vic', 'viewer')],
    jobs: [job('e1')],
    applications: [
      app('f1', 'Offered', [offer('x1', { response: 'accepted' })]),
      app('f2', 'Hired', [offer('x2', { response: 'accepted' })]),
      app('f3', 'Offered', [offer('x3', { respondBy: day(-2) })]),
      app('f4', 'Offered', [offer('x4', { respondBy: day(3) })]),
      app('f5', 'Offered', [offer('x5', { respondBy: day(-2), withdrawn: true })]),
      app('f6', 'Offered', [offer('x6', { approval: 'pending', respondBy: day(-2) })]),
      app('f7', 'Offered', [offer('x7', { respondBy: day(-1) })], { withdrawnAt: iso(1) }),
      app('f8', 'Offered', [offer('x8', { respondBy: day(-3) })]),
    ],
  });
  const login = async (email, name) => srv.cookieFrom(await post('/employer/login', { email, password: `${name} long password` }));
  ann = await login('ann@aco.in', 'Ann');
  vic = await login('vic@aco.in', 'Vic');
}, { timeout: 60000 });
after(() => srv && srv.stop());

test('What needs you lists accepted-not-Hired and lapsed offers', async () => {
  const t = todo(await text('/employer', ann));
  assert.match(t, /href="\/employer\/applicants\/f1#offers"><span class="todo-count">1<\/span><span class="todo-text">candidate accepted an offer and isn’t marked Hired yet/);
  assert.match(t, /href="\/employer\/applicants\?todo=lapsed"><span class="todo-count">2<\/span><span class="todo-text">offers are past the reply-by date with no answer/, 'f3 and f8: not future, withdrawn, unapproved or a withdrawn person');
  assert.doesNotMatch(todo(await text('/employer', vic)), /accepted an offer|reply-by/);
});

test('the Applicants filters show the same people', async () => {
  const lapsed = await text('/employer/applicants?todo=lapsed', ann);
  assert.deepEqual(names(lapsed), ['f3', 'f8']);
  assert.match(lapsed, /Showing: <b>Offers past their reply-by date with no answer<\/b>/);
  assert.deepEqual(names(await text('/employer/applicants?todo=hire', ann)), ['f1']);
});

test('the offer itself says what to do next', async () => {
  assert.match(await text('/employer/applicants/f3', ann), /The answer was due by [^<]+ and hasn’t come\. Call the candidate, then record their answer or withdraw the offer\./);
  assert.match(await text('/employer/applicants/f4', ann), /Answer asked for by /);
  assert.match(await text('/employer/applicants/f1', ann), /Accepted\. When they have confirmed their joining, move them to Hired under Stage\./);
  assert.doesNotMatch(await text('/employer/applicants/f2', ann), /move them to Hired/);
});

test('recording the answer or marking Hired clears them', async () => {
  await post('/employer/applicants/f3/offers/x3/declined', {}, ann);
  assert.deepEqual(names(await text('/employer/applicants?todo=lapsed', ann)), ['f8']);
  const r = await post('/employer/applicants/f1/status', { status: 'Hired' }, ann);
  assert.ok([302, 303].includes(r.status), `status ${r.status}`);
  assert.equal(srv.records('applications').find((a) => a.id === 'f1').status, 'Hired');
  assert.doesNotMatch(todo(await text('/employer', ann)), /accepted an offer/);
});
