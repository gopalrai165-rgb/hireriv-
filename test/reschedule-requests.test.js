// Step 220: when a candidate asks for another interview time, the people who
// can move it see the request and the candidate's note, on the applicant page,
// the Interviews page and "What needs you", for the company and for the team.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');
const { hashPassword } = require('../employers');

const DAY = 864e5;
const iso = (ago = 0) => new Date(Date.now() - ago * DAY).toISOString();
const day = (ahead) => new Date(Date.now() + 5.5 * 36e5 + ahead * DAY).toISOString().slice(0, 10);
const person = (id, email, name) => ({ id, email, name, phone: '9800000001', passwordHash: hashPassword(`${name} long password`), emailVerifiedAt: iso(1), phoneVerifiedAt: iso(1), createdAt: iso(1), active: true, link: null });
const member = (id, userId, role, jobIds = []) => ({ id, employerId: 'emp-a', userId, role, jobIds, createdAt: iso(1) });
const job = (id, extra = {}) => ({ id, title: `Job ${id}`, company: 'A Co', location: 'Pune', mode: 'On-site', type: 'Full-time', category: 'Retail', experience: '', skills: [], description: 'Work', responsibilities: [], posted: day(0), status: 'open', alertsSentAt: day(0), resume: 'optional', ...extra });
const app = (id, jobId, extra = {}) => ({ id, jobId, jobTitle: `Job ${jobId}`, name: `Person ${id}`, email: `${id}@example.in`, phone: `98450220${id.slice(1).padStart(2, '0')}`, status: 'Interview', createdAt: iso(5), history: [], ...extra });
const iv = (id, ahead, confirmation, extra = {}) => ({ id, at: iso(-ahead), duration: 30, mode: 'Phone', where: '', interviewer: 'Inez', status: 'scheduled', confirmation, feedback: [], ...extra });
const asked = (id, ahead, note) => iv(id, ahead, 'reschedule-requested', { candidateNote: note, answeredAt: iso(0.1) });

let srv;
let admin;
let ann;
let rob;
let vic;
let ip = 0;
const h = () => ({ 'x-forwarded-for': `10.220.${Math.floor(++ip / 250)}.${(ip % 250) + 1}` });
const get = (url, cookie) => srv.request(url, { cookie, headers: h() });
const post = (url, form, cookie) => srv.request(url, { method: 'POST', form, cookie, headers: h() });
const text = async (url, cookie) => (await get(url, cookie)).text();
const todo = (page) => { const i = page.indexOf('id="todo"'); return i === -1 ? '' : page.slice(i, page.indexOf('</section>', i)); };
const main = (page) => page.slice(page.indexOf('<main'), page.indexOf('</main>'));
const names = (s) => [...new Set([...s.matchAll(/Person (\w\d+)/g)].map((m) => m[1]))].sort();
const rec = (id) => srv.records('applications').find((a) => a.id === id);

before(async () => {
  srv = await startServer({ TRUST_PROXY: '1' }, {
    employers: [{ id: 'emp-a', company: 'A Co', name: 'Ann', email: 'o@a.in', active: true, approvedAt: iso(1), createdAt: iso(30) }],
    'employer-users': [person('u-ann', 'ann@aco.in', 'Ann'), person('u-rob', 'rob@aco.in', 'Rob'), person('u-vic', 'vic@aco.in', 'Vic')],
    'employer-members': [member('m1', 'u-ann', 'owner'), member('m2', 'u-rob', 'recruiter', ['e1']), member('m3', 'u-vic', 'viewer')],
    jobs: [job('t1'), job('e1', { employerId: 'emp-a', createdBy: 'employer' }), job('e2', { employerId: 'emp-a', createdBy: 'employer' })],
    applications: [
      app('r1', 't1', { interviews: [asked('i1', 2, 'Mornings next week')] }),
      app('r2', 't1', { interviews: [iv('i2', 2, 'awaiting')] }),
      app('r3', 't1', { withdrawnAt: iso(1), interviews: [asked('i3', 2, 'Any day')] }),
      app('r4', 't1', { interviews: [asked('i4', 3, 'After 4 pm')] }),
      app('c1', 'e1', { interviews: [asked('i5', 2, 'Thursday please')] }),
      app('c2', 'e2', { interviews: [asked('i6', 2, 'Weekend only')] }),
      app('c3', 'e1', { interviews: [iv('i7', 2, 'confirmed')] }),
    ],
  });
  admin = await srv.adminLogin();
  const login = async (email, name) => srv.cookieFrom(await post('/employer/login', { email, password: `${name} long password` }));
  ann = await login('ann@aco.in', 'Ann');
  rob = await login('rob@aco.in', 'Rob');
  vic = await login('vic@aco.in', 'Vic');
}, { timeout: 60000 });
after(() => srv && srv.stop());

test('team: What needs you counts requests on the team’s jobs and links to them', async () => {
  const t = todo(await text('/admin', admin));
  assert.match(t, /<span class="todo-count">2<\/span><span class="todo-text">candidates asked for another interview time/, 'not the withdrawn one or a company’s');
  assert.match(t, /href="\/admin\?tab=interviews&amp;todo=reschedule"/);
  const page = main(await text('/admin?tab=interviews&todo=reschedule', admin));
  assert.match(page, /Showing: <b>Candidates who asked for another interview time<\/b>/);
  assert.deepEqual(names(page), ['r1', 'r4']);
  assert.match(page, /“Mornings next week”/);
});

test('team: the Interviews tab and the application page show the answer and the note', async () => {
  const tab = main(await text('/admin?tab=interviews', admin));
  assert.match(tab, /Candidate's answer/);
  assert.match(tab, /Asked for another time<\/span><br><span class="small">“After 4 pm”/);
  assert.match(tab, /Not answered yet/);
  const page = await text('/admin/applications/r1', admin);
  assert.match(page, /<b>Asked for another time:<\/b> “Mornings next week”/);
  assert.doesNotMatch(await text('/admin/applications/c1', admin), /Thursday please/, 'a company’s job shows only the state');
});

test('company: each person sees requests they can move, with the note', async () => {
  assert.match(todo(await text('/employer', ann)), /href="\/employer\/interviews\?todo=reschedule"><span class="todo-count">2<\/span><span class="todo-text">candidates asked for another interview time/);
  assert.match(todo(await text('/employer', rob)), /href="\/employer\/applicants\/c1#interviews"><span class="todo-count">1<\/span><span class="todo-text">candidate asked for another interview time/);
  assert.doesNotMatch(await text('/employer', vic), /asked for another interview time/, 'a viewer can’t move interviews');
  const page = main(await text('/employer/interviews?todo=reschedule', ann));
  assert.deepEqual(names(page), ['c1', 'c2']);
  assert.match(page, /“Thursday please”/);
  assert.doesNotMatch(page, /Person c3|Past and cancelled/);
  assert.match(await text('/employer/interviews?todo=reschedule', vic), /No candidate is waiting for a new time/);
});

test('company: the note goes only to people who can move the interview', async () => {
  assert.match(await text('/employer/applicants/c1', ann), /<b>Asked for another time:<\/b> “Thursday please”/);
  const viewer = await text('/employer/interviews', vic);
  assert.match(viewer, /Asked for another time/);
  assert.doesNotMatch(viewer, /Thursday please|Weekend only/);
  assert.doesNotMatch(await text('/employer/applicants/c1', vic), /Thursday please/);
});

test('moving the interview clears the request everywhere', async () => {
  const r = await post('/employer/applicants/c1/interviews/i5/reschedule', { date: day(6), time: '11:00' }, ann);
  assert.ok([302, 303].includes(r.status), `status ${r.status}`);
  assert.equal(rec('c1').interviews[0].confirmation, 'awaiting');
  assert.deepEqual(names(main(await text('/employer/interviews?todo=reschedule', ann))), ['c2']);
  await post('/admin/interviews/r1/i1/reschedule', { date: day(6), time: '12:00' }, admin);
  assert.deepEqual(names(main(await text('/admin?tab=interviews&todo=reschedule', admin))), ['r4']);
});

test('unknown filter values show the normal pages', async () => {
  assert.match(await text('/admin?tab=interviews&todo=constructor', admin), /Upcoming <span/);
  assert.match(await text('/employer/interviews?todo=__proto__', ann), /Past and cancelled|<h2>Upcoming<\/h2>/);
});
