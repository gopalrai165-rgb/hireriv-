// "New since your last visit": open, real job cards carry their posted day;
// main.js tags those posted after the day of the previous visit (kept for
// the whole visit) and Find Jobs says how many are new.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer } = require('./helpers');

const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'main.js'), 'utf8');
const day = (offset) => new Date(Date.now() + offset * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const base = { company: 'Nova Foods', location: 'Pune', mode: 'On-site', type: 'Full-time', category: 'Logistics', experience: 'Fresher', salary: '', skills: [], description: 'Work', responsibilities: [], posted: day(-1), status: 'open', alertsSentAt: day(-1) };
let srv;
before(async () => { srv = await startServer({}, { jobs: [{ ...base, id: 'hr-1', title: 'Packer' }, { ...base, id: 'hr-2', title: 'Sample', sample: true }] }); });
after(() => srv && srv.stop());

test('real open cards carry their posted day; samples don\'t; Find Jobs has the note', async () => {
  const html = await (await srv.request('/jobs')).text();
  assert.match(html, new RegExp(`<article class="job-card" data-posted="${day(-1)}">`));
  assert.match(html, /<article class="job-card">/, 'the sample has no posted day');
  assert.match(html, /<p class="small new-since" data-new-since hidden><\/p>/);
});

test('main.js keeps the previous visit for the whole visit and skips Saved and Recently viewed', () => {
  assert.match(js, /const LAST_VISIT_KEY = 'hireriv:last-visit-day';/);
  assert.match(js, /sessionStorage\.getItem\('hireriv:visit-from'\)/);
  assert.ok(js.includes(String.raw`/^\d{4}-\d{2}-\d{2}$/.test(d)`), 'only a real day is trusted from storage');
  assert.match(js, /card\.closest\('#saved-list, #recent-list'\) \|\| card\.dataset\.posted <= visitFrom/);
});
