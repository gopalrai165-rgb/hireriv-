// Step 214: why candidates withdrew or weren't selected, in API v1, the
// spreadsheets and the team's reports; and anyone on the list can be compared.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, ADMIN_PASS } = require('./helpers');
const { hashPassword } = require('../employers');

const iso = (ago = 0) => new Date(Date.now() - ago * 864e5).toISOString();
const today = iso().slice(0, 10);
const person = (id, email, name) => ({ id, email, name, phone: '9800000001', passwordHash: hashPassword(`${name} long password`), emailVerifiedAt: iso(1), phoneVerifiedAt: iso(1), createdAt: iso(1), active: true, link: null });
const member = (id, userId, role) => ({ id, employerId: 'emp-a', userId, role, jobIds: [], createdAt: iso(1) });
const job = (id, extra = {}) => ({ id, title: `Job ${id}`, company: 'A Co', location: 'Pune', mode: 'On-site', type: 'Full-time', category: 'Retail', experience: '', skills: [], description: 'Work', responsibilities: [], posted: today, status: 'open', alertsSentAt: today, resume: 'optional', ...extra });
const own = { employerId: 'emp-a', createdBy: 'employer' };
const app = (id, jobId, extra = {}) => ({ id, jobId, jobTitle: `Job ${jobId}`, name: `Person ${id}`, email: `${id}@example.in`, phone: `98450214${id.slice(1).padStart(2, '0')}`, status: 'New', createdAt: iso(3), history: [], ...extra });
const left = (reason) => ({ withdrawnAt: iso(1), withdrawReason: reason });
const notSelected = (reason) => ({ status: 'Rejected', history: [{ at: iso(1), from: 'New', to: 'Rejected', by: 'Rita', rejectReason: reason }] });

let srv;
let ann;
let vic;
let admin;
let ip = 0;
const h = () => ({ 'x-forwarded-for': `10.214.${Math.floor(++ip / 250)}.${(ip % 250) + 1}` });
const get = (url, cookie) => srv.request(url, { cookie, headers: h() });
const post = (url, form, cookie) => srv.request(url, { method: 'POST', form, cookie, headers: h() });
const text = async (url, cookie) => (await get(url, cookie)).text();

before(async () => {
  srv = await startServer({ TRUST_PROXY: '1' }, {
    employers: [{ id: 'emp-a', company: 'A Co', name: 'A', email: 'o@a.in', active: true, approvedAt: iso(1), createdAt: iso(30) }],
    'employer-users': [person('u-ann', 'ann@aco.in', 'Ann'), person('u-vic', 'vic@aco.in', 'Vic')],
    'employer-members': [member('m1', 'u-ann', 'owner'), member('m2', 'u-vic', 'viewer')],
    jobs: [job('j1', own), job('t1')],
    applications: [
      app('a1', 'j1', left('pay')),
      app('a2', 'j1', { status: 'Hired' }),
      app('a3', 'j1'),
      app('a4', 't1', left('another-job')),
      app('a5', 't1', left('another-job')),
      app('a6', 't1', left('')),
      app('a7', 't1', notSelected('skills')),
      app('a8', 't1', { ...left('mistake'), withdrawnAt: iso(400) }),
    ],
  });
  ann = srv.cookieFrom(await post('/employer/login', { email: 'ann@aco.in', password: 'Ann long password' }));
  vic = srv.cookieFrom(await post('/employer/login', { email: 'vic@aco.in', password: 'Vic long password' }));
  admin = await srv.adminLogin();
}, { timeout: 60000 });
after(() => srv && srv.stop());

test('the team\'s reports show why, for the jobs the team runs', async () => {
  const page = await text('/admin/recruitment-reports', admin);
  const block = page.slice(page.indexOf('id="leaving"'), page.indexOf('id="workload"'));
  assert.match(block, /Why candidates withdrew/);
  assert.match(block, /<td>I took another job<\/td><td data-label="Candidates">2<\/td><td data-label="Share">67%/);
  assert.match(block, /No reason given<\/td><td data-label="Candidates">1<\/td>/);
  assert.doesNotMatch(block, /right for me/, 'a company\'s own applicants stay out');
  assert.doesNotMatch(block, /applied by mistake/, 'outside the period');
  assert.match(block, /Missing a skill, licence or certificate/);
  assert.match(await text('/admin/recruitment-reports?period=all', admin), /applied by mistake/);
});

test('both spreadsheets carry the reason', async () => {
  const list = await text('/employer/applicants', ann);
  const link = list.match(/href="([^"]*applicants\.csv[^"]*)"/)[1].replace(/&amp;/g, '&');
  const csv = await text(link, ann);
  assert.match(csv.split(/\r?\n/)[0], /Reason withdrawn/);
  assert.match(csv, /The pay isn.t right for me/);
  await post('/admin/confirm', { password: ADMIN_PASS, next: '/admin/export/applications.csv' }, admin);
  const team = await text('/admin/export/applications.csv', admin);
  assert.match(team.split(/\r?\n/)[0], /withdrawnReason/);
  assert.match(team, /I took another job/);
});

test('API v1 gives the reason and describes it', async () => {
  const doc = JSON.parse(await text('/api/v1/openapi.json'));
  assert.ok(doc.components.schemas.Application.properties.withdrawReason.enum.includes('another-job'));
  const made = await post('/employer/integrations/clients', [['name', 'HR'], ['environment', 'live'], ['scopes', 'applications:read']], ann);
  const html = await made.text();
  const secret = html.match(/<code class="secret-value">(hrv_(?:live|test)_[^<]+)<\/code>/)[1];
  const clientId = html.match(/Client id: <code>(int_[a-f0-9]+)<\/code>/)[1];
  const token = (await (await fetch(`${srv.base}/api/v1/oauth/token`, { method: 'POST', headers: { ...h(), authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials' }) })).json()).access_token;
  const read = async (id) => (await (await fetch(`${srv.base}/api/v1/applications/${id}`, { headers: { ...h(), authorization: `Bearer ${token}` } })).json());
  const gone = await read('a1');
  assert.equal((gone.application || gone.data || gone).withdrawReason, 'pay');
  const still = await read('a3');
  assert.equal((still.application || still.data || still).withdrawReason, null);
});

test('anyone on the list can be ticked; viewers get Compare without Move', async () => {
  const owner = await text('/employer/applicants', ann);
  for (const id of ['a1', 'a2', 'a3']) assert.match(owner, new RegExp(`name="ids" value="${id}"`), `${id}: withdrawn and hired too`);
  assert.match(owner, />Move<\/button>/);
  assert.match(owner, /data-no-confirm>Compare/);
  const viewer = await text('/employer/applicants', vic);
  assert.match(viewer, /name="ids" value="a2"/);
  assert.match(viewer, /data-no-confirm>Compare/);
  assert.doesNotMatch(viewer, />Move<\/button>|Move selected to/);
  assert.equal((await get('/employer/applicants/compare?ids=a2&ids=a3', vic)).status, 200);
  assert.match(await text('/employer/applicants/compare?ids=a1&ids=a2', ann), /Withdrawn/);
});

test('ticking someone who can\'t move leaves them alone', async () => {
  const r = await post('/employer/applicants/bulk', [['ids', 'a2'], ['ids', 'a3'], ['status', 'Screening']], ann);
  assert.match(decodeURIComponent(r.headers.get('location')).replace(/\+/g, ' '), /1 not moved/);
  assert.equal(srv.records('applications').find((a) => a.id === 'a2').status, 'Hired');
  assert.equal(srv.records('applications').find((a) => a.id === 'a3').status, 'Screening');
});
