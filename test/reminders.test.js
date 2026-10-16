// Interview reminders go out from the running server, once each.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

const H = 3600000;
const iso = (offset) => new Date(Date.now() + offset).toISOString();
const seed = {
  applications: [{
    id: 'a1', name: 'Priya Sharma', email: 'priya@example.in', phone: '9876543210', jobId: 'hr-101', jobTitle: 'Full-Stack Developer (MERN)', status: 'Interview', createdAt: iso(-5 * 24 * H),
    interviews: [{ id: 'iv1', status: 'scheduled', at: iso(20 * H), createdAt: iso(-3 * 24 * H), duration: 45, mode: 'Video call', where: 'https://meet.example.com/abc', interviewer: 'Ravi', interviewerEmail: 'ravi@client.in', sequence: 0, feedback: [] }],
  }],
};

let srv;
before(async () => { srv = await startServer({}, seed); });
after(() => srv && srv.stop());

test('the day-before reminder reaches the candidate and the interviewer once', async () => {
  await srv.waitForEmail((e) => e.includes('priya@example.in') && e.includes('Tomorrow'));
  await srv.waitForEmail((e) => e.includes('ravi@client.in') && e.includes('Tomorrow'));
  const iv = srv.records('applications')[0].interviews[0];
  assert.ok(iv.reminders.day);
  assert.equal(iv.reminders.hour, undefined);
  const count = srv.emails().length;

  // The timeline shows it.
  const admin = await srv.adminLogin();
  const page = await (await srv.request('/admin?tab=applications', { cookie: admin })).text();
  assert.match(page, /Interview reminder sent \(1 day before\)/);
  assert.equal(srv.emails().length, count);
});
