// Step 216: a candidate's interviews on the team's application page. Actions
// come back to that page; on a job a company runs the team sees only that they exist.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

const iso = (ago = 0) => new Date(Date.now() - ago * 864e5).toISOString();
const day = (ahead) => new Date(Date.now() + ahead * 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const job = (id, extra = {}) => ({ id, title: `Job ${id}`, company: 'Client Co', location: 'Pune', mode: 'On-site', type: 'Full-time', category: 'Retail', experience: '', skills: [], description: 'Work', responsibilities: [], posted: iso().slice(0, 10), status: 'open', alertsSentAt: iso().slice(0, 10), resume: 'optional', ...extra });
const app = (id, jobId, extra = {}) => ({ id, jobId, jobTitle: `Job ${jobId}`, name: `Person ${id}`, email: `${id}@example.in`, phone: `98450216${id.slice(1).padStart(2, '0')}`, status: 'Interview', createdAt: iso(5), history: [], ...extra });
const iv = (id, ago, extra = {}) => ({ id, at: iso(ago), duration: 30, mode: 'Video call', where: 'https://meet.example/abc', interviewer: 'Inez Quill', status: 'scheduled', feedback: [], ...extra });
const score = { by: 'Inez Quill', byType: 'interviewer', rating: 4, recommendation: 'Hire', strengths: 'Kept calm', concerns: '', at: iso(1) };

let srv;
let admin;
let ip = 0;
const h = () => ({ 'x-forwarded-for': `10.216.${Math.floor(++ip / 250)}.${(ip % 250) + 1}` });
const get = (url, cookie = admin) => srv.request(url, { cookie, headers: h() });
const post = (url, form) => srv.request(url, { method: 'POST', form, cookie: admin, headers: h() });
const text = async (url) => (await get(url)).text();
const section = (page) => { const i = page.indexOf('id="interviews"'); return i === -1 ? '' : page.slice(i, page.indexOf('</section>', i)); };
const place = (r) => decodeURIComponent(r.headers.get('location')).replace(/\+/g, ' ');
const rec = (id) => srv.records('applications').find((a) => a.id === id);

before(async () => {
  srv = await startServer({ TRUST_PROXY: '1' }, {
    employers: [{ id: 'emp-a', company: 'A Co', name: 'A', email: 'o@a.in', active: true, approvedAt: iso(1), createdAt: iso(30) }],
    jobs: [job('j1'), job('e1', { employerId: 'emp-a', createdBy: 'employer' })],
    applications: [
      app('a1', 'j1', { interviews: [iv('up', -2, { confirmation: 'confirmed' }), iv('done', 2), iv('scored', 3, { feedback: [score] }), iv('off', 4, { status: 'cancelled' })] }),
      app('a2', 'j1'),
      app('a3', 'j1', { withdrawnAt: iso(1), interviews: [iv('w1', 2)] }),
      app('a4', 'e1', { interviews: [iv('c1', -2), iv('c2', 2, { feedback: [score] })] }),
      app('a5', 'j1', { status: 'Hired' }),
      app('a6', 'j1', { interviews: [iv('m1', -3), iv('x1', -4), iv('f1', 2)] }),
    ],
  });
  admin = await srv.adminLogin();
}, { timeout: 60000 });
after(() => srv && srv.stop());

test('the page shows each interview and offers only what fits its state', async () => {
  const s = section(await text('/admin/applications/a1'));
  assert.equal((s.match(/<article/g) || []).length, 4);
  assert.match(s, /Inez Quill/);
  assert.match(s, /href="https:\/\/meet\.example\/abc"/);
  assert.match(s, /Confirmed by candidate/);
  assert.match(s, /Hire, 4\/5/);
  assert.match(s, /Kept calm/);
  assert.match(s, /Cancelled/);
  for (const action of ['up/reschedule', 'up/cancel']) assert.ok(s.includes(`/admin/interviews/a1/${action}?from=application`), action);
  assert.ok(s.includes('/admin/interviews/a1/done/feedback?from=application'));
  assert.ok(!s.includes('done/reschedule') && !s.includes('off/feedback') && !s.includes('off/cancel'), 'no moving what finished; nothing on a cancelled one');
  assert.match(s, /No feedback yet/);
});

test('none yet, and no booking for people past that point', async () => {
  const none = section(await text('/admin/applications/a2'));
  assert.match(none, /None yet/);
  assert.match(none, /Schedule an interview/);
  assert.doesNotMatch(section(await text('/admin/applications/a5')), /Schedule an interview/);
  assert.doesNotMatch(section(await text('/admin/applications/a3')), /Schedule an interview/);
});

test('booking for someone who withdrew is refused, on the form and on saving', async () => {
  assert.match(place(await get('/admin/applications/a3/interview?from=application')), /a3\?msg=Not booked: the candidate withdrew/);
  const r = await post('/admin/applications/a3/interview', { date: day(3), time: '11:00', duration: 30, mode: 'Phone', where: '9845000000' });
  assert.match(place(r), /Not booked/);
  assert.equal(rec('a3').interviews.length, 1);
});

test('a job a company runs shows only that interviews exist', async () => {
  const s = section(await text('/admin/applications/a4'));
  assert.equal((s.match(/<article/g) || []).length, 2);
  assert.match(s, /company runs its own hiring/);
  assert.doesNotMatch(s, /Inez Quill|Kept calm|meet\.example|Schedule an interview|\/admin\/interviews\//);
});

test('moving, cancelling, booking and feedback all come back to the page', async () => {
  const moved = await post('/admin/interviews/a6/m1/reschedule?from=application', { date: day(6), time: '12:00' });
  assert.match(place(moved), /^\/admin\/applications\/a6\?msg=Moved the interview.*#interviews$/);
  const bad = await post('/admin/interviews/a6/m1/reschedule?from=application', { date: 'nope', time: '12:00' });
  assert.match(place(bad), /a6\?msg=Not moved/);
  const off = await post('/admin/interviews/a6/x1/cancel?from=application', {});
  assert.match(place(off), /a6\?msg=Cancelled the interview/);
  assert.equal(rec('a6').interviews.find((i) => i.id === 'x1').status, 'cancelled');

  const form = await text('/admin/interviews/a6/f1/feedback?from=application');
  assert.ok(form.includes('action="/admin/interviews/a6/f1/feedback?from=application"'));
  assert.ok(form.includes('href="/admin/applications/a6#interviews"'));
  const saved = await post('/admin/interviews/a6/f1/feedback?from=application', { rating: 5, recommendation: 'Hire', strengths: 'Good', concerns: '' });
  assert.match(place(saved), /a6\?msg=Feedback saved/);

  const book = await text('/admin/applications/a2/interview?from=application');
  assert.ok(book.includes('action="/admin/applications/a2/interview?from=application"'));
  const booked = await post('/admin/applications/a2/interview?from=application', { date: day(4), time: '11:00', duration: 30, mode: 'Phone', where: '9845000000' });
  assert.match(place(booked), /a2\?msg=Interview booked/);
  assert.equal(rec('a2').interviews.length, 1);
  assert.match(await text(place(booked).split('#')[0]), /Interview booked/);
});

test('from the Interviews tab, actions still go back there', async () => {
  const r = await post('/admin/interviews/a1/up/reschedule', { date: day(8), time: '10:00' });
  assert.match(place(r), /tab=interviews/);
  assert.ok((await text('/admin/interviews/a1/done/feedback')).includes('href="/admin?tab=interviews"'));
  assert.match(await text('/admin/applications/a2/interview'), /action="\/admin\/applications\/a2\/interview"/);
});
