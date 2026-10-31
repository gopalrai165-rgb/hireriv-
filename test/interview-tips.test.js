// Interview tips: a page for any interview and one per role, linked from job
// pages (the job's role, or the general tips), role, salary and interview pages.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const tips = require('../interview-tips');
const { startServer } = require('./helpers');

const day = (offset) => new Date(Date.now() + offset * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const job = (id, title, extra = {}) => ({ id, title, company: 'Swift', location: 'Pune', mode: 'Field work', type: 'Full-time', category: 'Logistics', experience: '1-3 years', skills: [], description: 'Work', responsibilities: [], posted: day(-2), status: 'open', alertsSentAt: day(-2), salary: '₹18,000 a month', ...extra });

let srv;
before(async () => {
  srv = await startServer({}, { jobs: [job('hr-701', 'Delivery Executive'), job('hr-702', 'Florist', { category: 'Retail' }), job('hr-703', 'Delivery Partner', { status: 'closed' })] });
});
after(() => srv && srv.stop());

test('every role has full tips, and the general guide has its sections', () => {
  for (const [key, t] of Object.entries(tips.ROLES)) {
    assert.ok(t.intro && t.bring.length >= 3 && t.questions.length >= 3 && t.show.length && t.ask.length, key);
    for (const q of t.questions) assert.equal(q.length, 2, key);
  }
  assert.deepEqual(tips.GENERAL.map((s) => s.id), ['before', 'bring', 'on-the-day', 'questions', 'ask', 'phone', 'walk-in', 'after']);
  assert.ok(tips.SAFETY.some((s) => /Never pay/.test(s)));
});

test('the general page: sections, the safety box and links to each role', async () => {
  const res = await srv.request('/interview-tips');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<h1>How to get ready for a job interview<\/h1>/);
  assert.match(html, /<h2 id="walk-in">Walk-in interviews<\/h2>/);
  assert.match(html, /<summary>Tell me about yourself\.<\/summary>/);
  assert.match(html, /Never pay anyone to get an interview or a job/);
  assert.match(html, /href="\/interview-tips\/delivery"/);
  assert.match(html, /href="\/interview-tips\/security-guard"/);
  assert.match(html, /<link rel="canonical" href="[^"]+\/interview-tips">/);
});

test('a role page: what to bring, questions with answers, and the role\'s jobs', async () => {
  const html = await (await srv.request('/interview-tips/delivery')).text();
  assert.match(html, /<h1>Delivery interview tips<\/h1>/);
  assert.match(html, /Driving licence for a two-wheeler/);
  assert.match(html, /<summary>What will you do if a customer is not at home\?<\/summary>/);
  assert.match(html, /href="\/jobs\/role\/delivery"/);
  assert.match(html, /href="\/interview-tips\/driver"/);
  assert.doesNotMatch(html, /href="\/interview-tips\/delivery"/);
  assert.equal((await srv.request('/interview-tips/astronaut')).status, 404);
});

test('job pages link to the job\'s role tips, or the general tips; closed jobs don\'t', async () => {
  assert.match(await (await srv.request('/jobs/hr-701')).text(), /href="\/interview-tips\/delivery">Delivery interview tips/);
  const other = await (await srv.request('/jobs/hr-702')).text();
  assert.match(other, /href="\/interview-tips">Interview tips: what to bring/);
  assert.doesNotMatch(await (await srv.request('/jobs/hr-703')).text(), /class="tips-link/);
});

test('role pages, the sitemap and the landing links include the tips', async () => {
  assert.match(await (await srv.request('/jobs/role/delivery')).text(), /href="\/interview-tips\/delivery">Delivery interview tips<\/a>/);
  const map = await (await srv.request('/sitemap.xml')).text();
  assert.match(map, /\/interview-tips<\/loc>/);
  assert.match(map, /\/interview-tips\/nurse<\/loc>/);
});
