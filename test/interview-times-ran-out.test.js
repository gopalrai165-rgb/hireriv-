// Step 221: interview times offered for the candidate to choose from, none
// chosen, all now past. The applicant page says so instead of "waiting", the
// dashboard lists them, and unknown ?todo= values never act as a filter.
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
const app = (id, extra = {}) => ({ id, jobId: 'e1', jobTitle: 'Job e1', name: `Person ${id}`, email: `${id}@example.in`, phone: `98450221${id.slice(1).padStart(2, '0')}`, status: 'Shortlisted', createdAt: iso(9), history: [], ...extra });
const options = (status, ...daysAhead) => ({ id: `opt-${daysAhead.join('')}`, status, createdAt: iso(5), byUserId: 'u-ann', by: 'Ann', f: { duration: 30, mode: 'Phone', where: '', interviewer: '', interviewerEmail: '', message: '' }, slots: daysAhead.map((d) => ({ at: iso(-d) })) });

let srv;
let ann;
let vic;
let ip = 0;
const h = () => ({ 'x-forwarded-for': `10.221.${Math.floor(++ip / 250)}.${(ip % 250) + 1}` });
const get = (url, cookie) => srv.request(url, { cookie, headers: h() });
const post = (url, form, cookie) => srv.request(url, { method: 'POST', form, cookie, headers: h() });
const text = async (url, cookie) => (await get(url, cookie)).text();
const todo = (page) => { const i = page.indexOf('id="todo"'); return i === -1 ? '' : page.slice(i, page.indexOf('</section>', i)); };
const names = (page) => [...new Set([...page.matchAll(/Person (o\d+)/g)].map((m) => m[1]))].sort();

before(async () => {
  srv = await startServer({ TRUST_PROXY: '1' }, {
    employers: [{ id: 'emp-a', company: 'A Co', name: 'Ann', email: 'o@a.in', active: true, approvedAt: iso(1), createdAt: iso(30) }],
    'employer-users': [person('u-ann', 'ann@aco.in', 'Ann'), person('u-vic', 'vic@aco.in', 'Vic')],
    'employer-members': [member('m1', 'u-ann', 'owner'), member('m3', 'u-vic', 'viewer')],
    jobs: [job('e1')],
    applications: [
      app('o1', { interviewOptions: options('open', -3, -2) }),
      app('o2', { interviewOptions: options('open', -1, 2) }),
      app('o3', { withdrawnAt: iso(1), interviewOptions: options('open', -4, -3) }),
      app('o4', { interviewOptions: options('chosen', -5, -4) }),
      app('o5', { interviewOptions: options('open', -6, -5) }),
      app('o6'),
    ],
  });
  const login = async (email, name) => srv.cookieFrom(await post('/employer/login', { email, password: `${name} long password` }));
  ann = await login('ann@aco.in', 'Ann');
  vic = await login('vic@aco.in', 'Vic');
}, { timeout: 60000 });
after(() => srv && srv.stop());

test('the applicant page says the offered times ran out, instead of waiting', async () => {
  const page = await text('/employer/applicants/o1', ann);
  assert.match(page, /Person o1 didn’t pick any of the 2 interview times you offered, and they have all passed/);
  assert.match(page, /Clear the old times/);
  assert.doesNotMatch(page, /Waiting for Person o1 to choose/);
  assert.doesNotMatch(await text('/employer/applicants/o1', vic), /Clear the old times/, 'a viewer can’t clear them');
});

test('only the times still to come are listed while some are left', async () => {
  const page = await text('/employer/applicants/o2', ann);
  assert.match(page, /Waiting for Person o2 to choose an interview time<\/b> from 1 you offered: [^<]+ \(1 more already passed\)/);
});

test('What needs you lists them and the link opens the same people', async () => {
  const t = todo(await text('/employer', ann));
  assert.match(t, /href="\/employer\/applicants\?todo=unpicked"><span class="todo-count">2<\/span><span class="todo-text">candidates didn’t pick any of the interview times offered/, 'not the withdrawn one, a chosen one or one with times left');
  const list = await text('/employer/applicants?todo=unpicked', ann);
  assert.deepEqual(names(list), ['o1', 'o5']);
  assert.match(list, /Showing: <b>Interview times offered that all passed unpicked<\/b>/);
  assert.doesNotMatch(todo(await text('/employer', vic)), /interview times offered/);
});

test('clearing the old times takes them off the list', async () => {
  await post('/employer/applicants/o5/interview-options/cancel', {}, ann);
  assert.equal(srv.records('applications').find((a) => a.id === 'o5').interviewOptions.status, 'withdrawn');
  assert.deepEqual(names(await text('/employer/applicants?todo=unpicked', ann)), ['o1']);
  assert.doesNotMatch(await text('/employer/applicants/o5', ann), /didn’t pick any/);
});

test('unknown ?todo= values are ignored on both Applicants lists', async () => {
  for (const bad of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    const page = await text(`/employer/applicants?todo=${bad}`, ann);
    assert.doesNotMatch(page, /Showing: <b>/, bad);
    assert.ok(names(page).length >= 4, bad);
  }
  const admin = await srv.adminLogin();
  const team = await (await srv.request('/admin?tab=applications&todo=constructor', { cookie: admin, headers: h() })).text();
  assert.doesNotMatch(team, /Showing: <b>/);
  assert.doesNotMatch(team, /function Object/);
});
