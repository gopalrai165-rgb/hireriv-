// Step 223: a candidate marked Hired on a job the team runs, with no placement
// recorded, is never invoiced. The team's "What needs you" lists them, the
// Applications filter opens the same people, and the application page says so.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

const DAY = 864e5;
const iso = (ago = 0) => new Date(Date.now() - ago * DAY).toISOString();
const day = (ahead) => new Date(Date.now() + 5.5 * 36e5 + ahead * DAY).toISOString().slice(0, 10);
const job = (id, extra = {}) => ({ id, title: `Job ${id}`, company: 'A Co', location: 'Pune', mode: 'On-site', type: 'Full-time', category: 'Retail', experience: '', skills: [], description: 'Work', responsibilities: [], posted: day(0), status: 'open', alertsSentAt: day(0), resume: 'optional', ...extra });
const app = (id, jobId, status, extra = {}) => ({ id, jobId, jobTitle: `Job ${jobId}`, name: `Person ${id}`, email: `${id}@example.in`, phone: `98450223${id.slice(1).padStart(2, '0')}`, status, createdAt: iso(20), history: [], ...extra });
const placement = (appId) => ({ id: `pl-${appId}`, appId, candidateName: `Person ${appId}`, candidateEmail: `${appId}@example.in`, jobId: 't1', jobTitle: 'Job t1', employerId: '', type: 'Permanent', company: 'A Co', joiningDate: day(-3), ctc: 300000, feeMode: 'percent', feePercent: 8.33, fee: 24990, guaranteeDays: 90, status: 'Joined', invoice: null, cancelledInvoices: [], createdAt: iso(3), updatedAt: iso(3) });

let srv;
let admin;
let ip = 0;
const h = () => ({ 'x-forwarded-for': `10.223.${Math.floor(++ip / 250)}.${(ip % 250) + 1}` });
const text = async (url) => (await srv.request(url, { cookie: admin, headers: h() })).text();
const todo = (page) => { const i = page.indexOf('id="todo"'); return i === -1 ? '' : page.slice(i, page.indexOf('</section>', i)); };
const main = (page) => page.slice(page.indexOf('<main'), page.indexOf('</main>'));
const names = (s) => [...new Set([...s.matchAll(/Person (h\d+)/g)].map((m) => m[1]))].sort();

before(async () => {
  srv = await startServer({ TRUST_PROXY: '1' }, {
    jobs: [job('t1'), job('e1', { employerId: 'emp-a', createdBy: 'employer' })],
    applications: [
      app('h1', 't1', 'Hired'),
      app('h2', 't1', 'Hired'),
      app('h3', 't1', 'Hired'),
      app('h4', 't1', 'Offered'),
      app('h5', 'e1', 'Hired'),
      app('h6', 't1', 'Hired', { withdrawnAt: iso(1) }),
    ],
    placements: [placement('h3')],
  });
  admin = await srv.adminLogin();
}, { timeout: 60000 });
after(() => srv && srv.stop());

test('What needs you counts hires on team jobs with no placement', async () => {
  const t = todo(await text('/admin'));
  assert.match(t, /href="\/admin\?tab=applications&amp;todo=unplaced"><span class="todo-count">2<\/span><span class="todo-text">hires have no placement recorded, so the fee can’t be invoiced/, 'h1 and h2: not placed, offered, a company’s or withdrawn');
  assert.match(await text('/admin'), /2 without a placement/, 'the Hired tile says how many have none');
});

test('the Applications filter shows the same people', async () => {
  const page = main(await text('/admin?tab=applications&todo=unplaced'));
  assert.match(page, /Showing: <b>Hired with no placement recorded<\/b>/);
  assert.deepEqual(names(page), ['h1', 'h2']);
});

test('the application page says what is missing, or links the placement', async () => {
  assert.match(await text('/admin/applications/h1'), /No placement recorded yet\.<\/b>[^<]+<a href="\/admin\/applications\/h1\/placement">Record placement<\/a>/);
  assert.match(await text('/admin/applications/h3'), /✓ Placement recorded: Joined[^<]+<a href="\/admin\/placements\/pl-h3\/edit">/);
  assert.match(await text('/admin/applications/h4'), /\+ Record placement<\/a> when the offer is accepted/);
  assert.doesNotMatch(await text('/admin/applications/h5'), /id="placement"/, 'a company’s own hire');
});

test('recording the placement clears it and one left links straight to the form', async () => {
  const r = await srv.request('/admin/applications/h2/placement', {
    method: 'POST', cookie: admin, headers: h(),
    form: { type: 'Permanent', company: 'A Co', employerId: '', billingName: '', billingAddress: '', clientGstin: '', taxType: 'intra', joiningDate: day(0), ctc: '300000', feeMode: 'percent', feePercent: '8.33', flatFee: '', guaranteeDays: '90', status: 'Awaiting joining', notes: '' },
  });
  assert.ok([302, 303].includes(r.status), `status ${r.status}`);
  assert.ok(srv.records('placements').some((p) => p.appId === 'h2'));
  assert.match(todo(await text('/admin')), /href="\/admin\/applications\/h1\/placement"><span class="todo-count">1<\/span><span class="todo-text">hire has no placement recorded/);
});
