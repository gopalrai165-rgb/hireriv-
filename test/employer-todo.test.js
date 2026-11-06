// Step 211: "What needs you" on the employer dashboard. Only jobs the company
// runs itself, only what this person's role lets them act on, and it only points.
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
const app = (id, jobId, extra = {}) => ({ id, jobId, jobTitle: `Job ${jobId}`, name: `Person ${id}`, email: `${id}@example.in`, phone: `98450211${id.slice(1).padStart(2, '0')}`, status: 'Interview', createdAt: iso(1), history: [], ...extra });
const offer = (id, by, status = 'pending') => ({ id, title: 'Offer', createdBy: 'Rob', createdByUserId: by, approval: { status, by: null, userId: null, at: null, note: '' }, response: { status: 'awaiting' } });
const iv = (id, ago, extra = {}) => ({ id, at: iso(ago), duration: 30, mode: 'Phone', status: 'scheduled', feedback: [], ...extra });
const reply = (id) => ({ id, from: 'candidate', by: 'Them', text: 'Hello', at: iso(1) });

let srv;
let ann;
let rob;
let vic;
let mia;
let bob;
let ip = 0;
const h = () => ({ 'x-forwarded-for': `10.211.${Math.floor(++ip / 250)}.${(ip % 250) + 1}` });
const get = (url, cookie) => srv.request(url, { cookie, headers: h() });
const post = (url, form, cookie) => srv.request(url, { method: 'POST', form, cookie, headers: h() });
const text = async (url, cookie) => (await get(url, cookie)).text();
const block = (page) => { const i = page.indexOf('id="todo"'); return i === -1 ? '' : page.slice(i, page.indexOf('</section>', i)); };

before(async () => {
  srv = await startServer({ TRUST_PROXY: '1' }, {
    employers: [company('emp-a', 'A Co'), company('emp-b', 'B Co'), company('emp-c', 'C Co')],
    'employer-users': [person('u-ann', 'ann@aco.in', 'Ann'), person('u-rob', 'rob@aco.in', 'Rob'), person('u-vic', 'vic@aco.in', 'Vic'), person('u-bob', 'bob@bco.in', 'Bob'), person('u-cy', 'cy@cco.in', 'Cy'), person('u-mia', 'mia@aco.in', 'Mia')],
    'employer-members': [member('m1', 'emp-a', 'u-ann', 'owner'), member('m2', 'emp-a', 'u-rob', 'recruiter', ['j1']), member('m3', 'emp-a', 'u-vic', 'viewer'), member('m4', 'emp-b', 'u-bob', 'owner'), member('m5', 'emp-c', 'u-cy', 'owner'), member('m6', 'emp-a', 'u-mia', 'manager', ['j1'])],
    jobs: [job('j1', 'emp-a', { closesOn: day(3) }), job('j2', 'emp-a'), job('j3', 'emp-a', { closesOn: day(30) }), job('j4', 'emp-a', { closesOn: day(2), status: 'closed' }), job('t1', 'emp-a', { createdBy: undefined }), job('j9', 'emp-b'), job('c1', 'emp-c')],
    applications: [
      app('a1', 'j1', { status: 'New', createdAt: iso(10) }),
      app('a2', 'j1', { status: 'New', createdAt: iso(2) }),
      app('a3', 'j2', { status: 'Screening', createdAt: iso(30), history: [{ at: iso(8), from: 'New', to: 'Screening', by: 'Ann' }] }),
      app('a4', 'j2', { status: 'Screening', createdAt: iso(30), history: [{ at: iso(1), from: 'New', to: 'Screening', by: 'Ann' }] }),
      app('a5', 'j1', { status: 'New', createdAt: iso(20), withdrawnAt: iso(1), messages: [reply('w1')] }),
      app('a6', 'j1', { messages: [reply('m1')] }),
      app('a7', 'j2', { messages: [reply('m2')] }),
      app('a8', 'j1', { offers: [offer('o1', 'u-rob')] }),
      app('a9', 'j2', { offers: [offer('o2', 'u-ann')] }),
      app('a15', 'j1', { offers: [offer('o4', 'u-mia')] }),
      app('a10', 'j1', { offers: [offer('o3', 'u-rob', 'approved')] }),
      app('a11', 'j1', { interviews: [iv('v1', 1)] }),
      app('a12', 'j1', { interviews: [iv('v2', 1, { feedback: [{ by: 'Ann', at: iso(1), rating: 4 }] }), iv('v3', 1, { status: 'cancelled' }), iv('v4', 30), iv('v5', -1)] }),
      app('a13', 't1', { status: 'New', createdAt: iso(20), messages: [reply('t1')] }),
      app('a14', 'j9', { status: 'New', createdAt: iso(20) }),
    ],
  });
  const login = async (email, name) => srv.cookieFrom(await post('/employer/login', { email, password: `${name} long password` }));
  ann = await login('ann@aco.in', 'Ann');
  rob = await login('rob@aco.in', 'Rob');
  vic = await login('vic@aco.in', 'Vic');
  mia = await login('mia@aco.in', 'Mia');
  bob = await login('bob@bco.in', 'Bob');
}, { timeout: 60000 });
after(() => srv && srv.stop());

test('the owner sees each kind, counted correctly', async () => {
  const b = block(await text('/employer', ann));
  assert.match(b, /What needs you/);
  assert.match(b, /<span class="todo-count">2<\/span><span class="todo-text">applicants wrote to you/);
  assert.match(b, /<span class="todo-count">3<\/span><span class="todo-text">offers need your approval/, 'an owner may approve their own; not one already approved');
  assert.match(b, /href="\/employer\/applicants\?todo=offers"/);
  assert.match(b, /<span class="todo-count">1<\/span><span class="todo-text">interview finished with no feedback/);
  assert.match(b, /href="\/employer\/applicants\/a11#interviews"/);
  assert.match(b, /<span class="todo-count">2<\/span><span class="todo-text">applicants have waited over 7 days/, 'measured from the last move; withdrawn people and the team\'s jobs left out');
  assert.match(b, /href="\/employer\/applicants\?todo=waiting"/);
  assert.match(b, /<span class="todo-count">1<\/span><span class="todo-text">job closes within 7 days/);
});

test('a role only sees what it can act on', async () => {
  const b = block(await text('/employer', rob));
  assert.match(b, /<span class="todo-count">1<\/span><span class="todo-text">applicant wrote to you/, 'only the job they work on');
  assert.match(b, /href="\/employer\/applicants\/a6#messages"/);
  assert.match(b, /<span class="todo-count">1<\/span><span class="todo-text">applicant has waited/);
  assert.doesNotMatch(b, /offer needs|closes within/, 'recruiters do not approve offers or edit jobs');
  assert.equal(block(await text('/employer', vic)), '', 'viewers have nothing to act on');
  const mgr = block(await text('/employer', mia));
  assert.match(mgr, /<span class="todo-count">1<\/span><span class="todo-text">offer needs your approval/, 'not the offer this manager made');
  assert.match(mgr, /href="\/employer\/applicants\/a8#offers"/, 'one person goes straight to them');
  const other = block(await text('/employer', bob));
  assert.match(other, /<span class="todo-count">1<\/span><span class="todo-text">applicant has waited/);
  assert.doesNotMatch(other, /wrote to you|offer needs/);
});

test('the lists behind the links show the same people, and the spreadsheet follows', async () => {
  const names = (page) => [...new Set([...page.matchAll(/<b>(Person a\d+)<\/b>/g)].map((m) => m[1]))].sort();
  const waiting = await text('/employer/applicants?todo=waiting', ann);
  assert.deepEqual(names(waiting), ['Person a1', 'Person a3']);
  assert.match(waiting, /Showing: <b>Waiting over 7 days with no move<\/b>/);
  assert.match(waiting, /name="todo" value="waiting"/, 'other filters keep it');
  const link = waiting.match(/href="([^"]*applicants\.csv[^"]*)"/)[1].replace(/&amp;/g, '&');
  const csv = await text(link, ann);
  assert.match(csv, /Person a1/);
  assert.doesNotMatch(csv, /Person a2\b/, 'the download shows the same people');
  assert.deepEqual(names(await text('/employer/applicants?todo=unread', ann)), ['Person a6', 'Person a7']);
  assert.deepEqual(names(await text('/employer/applicants?todo=offers', ann)), ['Person a15', 'Person a8', 'Person a9']);
  assert.deepEqual(names(await text('/employer/applicants?todo=waiting', vic)), [], 'a viewer gets no list from it');
  assert.ok(names(await text('/employer/applicants?todo=nonsense', ann)).length > 2, 'unknown values are ignored');
});

test('when nothing is waiting it says so, and opening the page changes nothing', async () => {
  const cy = srv.cookieFrom(await post('/employer/login', { email: 'cy@cco.in', password: 'Cy long password' }));
  assert.match(block(await text('/employer', cy)), /Nothing right now\. You're up to date\./);
  const before_ = JSON.stringify(srv.records('applications'));
  await text('/employer', ann);
  assert.equal(JSON.stringify(srv.records('applications')), before_);
  const unread = await get('/employer/applicants/a6', rob);
  assert.equal(unread.status, 200);
  assert.doesNotMatch(block(await text('/employer', rob)), /applicant wrote to you/, 'reading the reply clears it');
});
