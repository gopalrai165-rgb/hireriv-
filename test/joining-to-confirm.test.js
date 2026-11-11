// Step 224: a placement left "Awaiting joining" after its joining date. Did
// they join? Nobody was asked. The team's "What needs you" lists them, the
// Placements tab has a "Joining to confirm" filter with the same ones, and the
// Placements tab's "no placement yet" note counts the same hires as Step 223.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');
const { hashPassword } = require('../employers');

const DAY = 864e5;
const iso = (ago = 0) => new Date(Date.now() - ago * DAY).toISOString();
const day = (ahead) => new Date(Date.now() + 5.5 * 36e5 + ahead * DAY).toISOString().slice(0, 10);
const member = (id, name, role) => ({ id, name, email: `${id}@hireriv.test`, role, active: true, passwordHash: hashPassword(`${name} long password`), createdAt: iso(50) });
const job = (id, extra = {}) => ({ id, title: `Job ${id}`, company: 'A Co', location: 'Pune', mode: 'On-site', type: 'Full-time', category: 'Retail', experience: '', skills: [], description: 'Work', responsibilities: [], posted: day(0), status: 'open', alertsSentAt: day(0), resume: 'optional', ...extra });
const app = (id, jobId, extra = {}) => ({ id, jobId, jobTitle: `Job ${jobId}`, name: `Person ${id}`, email: `${id}@example.in`, phone: `98450224${id.slice(1).padStart(2, '0')}`, status: 'Hired', createdAt: iso(20), history: [], ...extra });
const pl = (appId, joinIn, status = 'Awaiting joining', recruiterId = '') => ({ id: `pl-${appId}`, appId, candidateName: `Person ${appId}`, candidateEmail: `${appId}@example.in`, jobId: 't1', jobTitle: 'Job t1', employerId: '', type: 'Permanent', company: 'A Co', joiningDate: day(joinIn), ctc: 300000, feeMode: 'percent', feePercent: 8.33, fee: 24990, guaranteeDays: 90, status, invoice: null, cancelledInvoices: [], recruiterId, createdAt: iso(9), updatedAt: iso(9) });

let srv;
let admin;
let rita;
let ip = 0;
const h = () => ({ 'x-forwarded-for': `10.224.${Math.floor(++ip / 250)}.${(ip % 250) + 1}` });
const post = (url, form, cookie) => srv.request(url, { method: 'POST', form, cookie, headers: h() });
const text = async (url, cookie = admin) => (await srv.request(url, { cookie, headers: h() })).text();
const todo = (page) => { const i = page.indexOf('id="todo"'); return i === -1 ? '' : page.slice(i, page.indexOf('</section>', i)); };
const main = (page) => page.slice(page.indexOf('<main'), page.indexOf('</main>'));
const names = (s) => [...new Set([...s.matchAll(/Person (j\d+)/g)].map((m) => m[1]))].sort();

before(async () => {
  srv = await startServer({ TRUST_PROXY: '1' }, {
    team: [member('t-rita', 'Rita', 'Recruiter'), member('t-omar', 'Omar', 'Recruiter')],
    jobs: [job('t1'), job('e1', { employerId: 'emp-a', createdBy: 'employer' })],
    applications: ['j1', 'j2', 'j3', 'j4', 'j5', 'j6'].map((id) => app(id, 't1'))
      .concat([app('k1', 't1', { withdrawnAt: iso(1) }), app('k2', 'e1'), app('k3', 't1')]),
    placements: [
      pl('j1', -3, 'Awaiting joining', 't-rita'),
      pl('j2', -1, 'Awaiting joining', 't-omar'),
      pl('j3', -2),
      pl('j4', 0),
      pl('j5', 2),
      pl('j6', -5, 'Joined'),
    ],
  });
  admin = await srv.adminLogin();
  rita = srv.cookieFrom(await post('/admin/login', { login: 't-rita@hireriv.test', password: 'Rita long password' }));
}, { timeout: 60000 });
after(() => srv && srv.stop());

test('What needs you counts joinings past their date, by whose they are', async () => {
  assert.match(todo(await text('/admin')), /href="\/admin\?tab=placements&amp;view=joining"><span class="todo-count">3<\/span><span class="todo-text">joining dates have passed with nobody confirming they joined/, 'j1, j2, j3: not today, later or already joined');
  assert.match(todo(await text('/admin', rita)), /href="\/admin\?tab=placements&amp;view=joining"><span class="todo-count">2<\/span>/, 'hers and the unassigned one, not Omar’s');
});

test('the Placements filter shows the same ones', async () => {
  const page = main(await text('/admin?tab=placements&view=joining'));
  assert.match(page, /Showing: <b>Joining date passed, joining not confirmed<\/b>\./);
  assert.deepEqual(names(page.slice(page.indexOf('Showing:'))), ['j1', 'j2', 'j3']);
  const hers = main(await text('/admin?tab=placements&view=joining', rita));
  assert.match(hers, /\(yours and unassigned\)/);
  assert.deepEqual(names(hers.slice(hers.indexOf('Showing:'))), ['j1', 'j3']);
});

test('the Placements tab counts only team hires with no placement', async () => {
  const page = main(await text('/admin?tab=placements'));
  assert.match(page, /1 hired candidate has no placement yet:\s*<a href="\/admin\/applications\/k3\/placement">Person k3<\/a>/, 'not a withdrawn one or a company’s');
});

test('setting Joined clears it, and one left links to that placement', async () => {
  await post('/admin/placements/pl-j1/status', { status: 'Joined' }, admin);
  await post('/admin/placements/pl-j2/status', { status: 'Did not join' }, admin);
  assert.match(todo(await text('/admin')), /href="\/admin\/placements\/pl-j3\/edit"><span class="todo-count">1<\/span><span class="todo-text">joining date has passed/);
  assert.match(main(await text('/admin?tab=placements&view=joining', rita)), /Person j3/);
});
