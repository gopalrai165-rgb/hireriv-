// Step 217: the team's Interviews tab, its dashboard lists and its interview
// actions cover only jobs the team runs. On a job a company runs itself, the
// company's team books, moves and scores interviews; the Hireriv team can't.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

const iso = (ago = 0) => new Date(Date.now() - ago * 864e5).toISOString();
const day = (ahead) => new Date(Date.now() + ahead * 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const job = (id, extra = {}) => ({ id, title: `Job ${id}`, company: 'Client Co', location: 'Pune', mode: 'On-site', type: 'Full-time', category: 'Retail', experience: '', skills: [], description: 'Work', responsibilities: [], posted: iso().slice(0, 10), status: 'open', alertsSentAt: iso().slice(0, 10), resume: 'optional', ...extra });
const app = (id, jobId, extra = {}) => ({ id, jobId, jobTitle: `Job ${jobId}`, name: `Person ${id}`, email: `${id}@example.in`, phone: `98450217${id.slice(1).padStart(2, '0')}`, status: 'Interview', createdAt: iso(5), history: [], ...extra });
const iv = (id, ago, extra = {}) => ({ id, at: iso(ago), duration: 30, mode: 'Video call', where: 'https://meet.example/abc', interviewer: 'Inez Quill', status: 'scheduled', feedback: [], ...extra });
const score = { by: 'Owen Vale', byType: 'employer', rating: 2, recommendation: 'No hire', strengths: '', concerns: 'Late', at: iso(1) };

let srv;
let admin;
let ip = 0;
const h = () => ({ 'x-forwarded-for': `10.217.${Math.floor(++ip / 250)}.${(ip % 250) + 1}` });
const get = (url) => srv.request(url, { cookie: admin, headers: h() });
const post = (url, form) => srv.request(url, { method: 'POST', form, cookie: admin, headers: h() });
const text = async (url) => (await get(url)).text();
const place = (r) => decodeURIComponent(r.headers.get('location') || '').replace(/\+/g, ' ');
const rec = (id) => srv.records('applications').find((a) => a.id === id);
const COMPANY = /company runs its own hiring for this job/;

before(async () => {
  srv = await startServer({ TRUST_PROXY: '1' }, {
    employers: [{ id: 'emp-a', company: 'A Co', name: 'A', email: 'o@a.in', active: true, approvedAt: iso(1), createdAt: iso(30) }],
    jobs: [job('j1'), job('e1', { employerId: 'emp-a', createdBy: 'employer' })],
    applications: [
      app('t1', 'j1', { interviews: [iv('tu', -2), iv('td', 2)] }),
      app('c1', 'e1', { name: 'Zara Company', interviews: [iv('cu', -2, { interviewer: 'Owen Vale' }), iv('cd', 2, { interviewer: 'Owen Vale' }), iv('cs', 3, { feedback: [score] })] }),
      app('c2', 'e1', { status: 'New' }),
    ],
  });
  admin = await srv.adminLogin();
}, { timeout: 60000 });
after(() => srv && srv.stop());

test('the Interviews tab lists only jobs the team runs and counts the rest', async () => {
  const page = await text('/admin?tab=interviews');
  assert.match(page, /Person t1/);
  assert.doesNotMatch(page, /Zara Company|Owen Vale|\/admin\/interviews\/c1\//);
  assert.match(page, /Only jobs the team runs are listed\. 1 more upcoming interview is on jobs companies run themselves/);
  assert.match(page, /Upcoming <span class="muted">\(1\)/);
});

test('the dashboard lists only the team’s interviews', async () => {
  const page = await text('/admin');
  const i = page.indexOf('Upcoming interviews');
  const card = page.slice(i, page.indexOf('</section>', i));
  assert.match(card, /Person t1/);
  assert.doesNotMatch(card, /Zara Company|\/admin\/interviews\/c1\//);
});

test('the Applications list offers no interview actions on a company-run job', async () => {
  const page = await text('/admin?tab=applications');
  assert.doesNotMatch(page, /\/admin\/applications\/c[12]\/interview/);
  assert.doesNotMatch(page, /\/admin\/interviews\/c1\//);
  assert.match(page, /The company books interviews for this job/);
  assert.match(page, /\/admin\/applications\/t1\/interview/);
});

test('booking, moving, cancelling, feedback and calendar files are refused on a company-run job', async () => {
  const before = JSON.stringify(rec('c1').interviews);
  assert.match(place(await get('/admin/applications/c2/interview')), /Not booked: this company runs/);
  const booked = await post('/admin/applications/c2/interview', { date: day(3), time: '11:00', duration: 30, mode: 'Phone', where: '9845000000' });
  assert.match(place(booked), /Not booked: this company runs/);
  assert.equal((rec('c2').interviews || []).length, 0);
  assert.match(place(await post('/admin/interviews/c1/cu/reschedule', { date: day(5), time: '12:00' })), /Not moved: this company runs/);
  assert.match(place(await post('/admin/interviews/c1/cu/cancel', {})), /Not cancelled: this company runs/);
  assert.match(place(await get('/admin/interviews/c1/cd/feedback')), /Feedback not open: this company runs/);
  assert.match(place(await post('/admin/interviews/c1/cd/feedback', { rating: 5, recommendation: 'Hire' })), /Feedback not saved: this company runs/);
  const ics = await get('/admin/interviews/c1/cu.ics');
  assert.equal(ics.status, 302);
  assert.match(place(ics), COMPANY);
  assert.equal(JSON.stringify(rec('c1').interviews), before, 'nothing changed');
});

test('refusals started from the application page go back there', async () => {
  assert.match(place(await post('/admin/interviews/c1/cu/cancel?from=application', {})), /\/admin\/applications\/c1\?msg=Not cancelled: this company runs.*#interviews$/);
});

test('the team still manages interviews on its own jobs', async () => {
  const r = await post('/admin/interviews/t1/tu/reschedule', { date: day(6), time: '12:00' });
  assert.match(place(r), /Moved the interview/);
  assert.equal((await get('/admin/interviews/t1/tu.ics')).status, 200);
  assert.equal((await get('/admin/interviews/t1/td/feedback')).status, 200);
});
