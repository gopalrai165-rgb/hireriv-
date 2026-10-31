// Recently viewed jobs: open, real job pages mark themselves; main.js keeps
// the last 10 in this browser only and the Saved page shows them.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer } = require('./helpers');

const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'main.js'), 'utf8');
const day = (offset) => new Date(Date.now() + offset * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const base = { company: 'Nova Foods', location: 'Pune', mode: 'On-site', type: 'Full-time', category: 'Logistics', experience: 'Fresher', salary: '', skills: [], description: 'Work', responsibilities: [], posted: day(-1), status: 'open', alertsSentAt: day(-1) };
let srv;
before(async () => { srv = await startServer({}, { jobs: [{ ...base, id: 'hr-1', title: 'Packer' }, { ...base, id: 'hr-2', title: 'Old', status: 'closed' }, { ...base, id: 'hr-3', title: 'Sample', sample: true }] }); });
after(() => srv && srv.stop());

test('only open, real job pages are remembered', async () => {
  assert.match(await (await srv.request('/jobs/hr-1')).text(), /<span hidden data-viewed-job="hr-1"><\/span>/);
  assert.doesNotMatch(await (await srv.request('/jobs/hr-2')).text(), /data-viewed-job/);
  assert.doesNotMatch(await (await srv.request('/jobs/hr-3')).text(), /data-viewed-job/);
});

test('the Saved page has the recently viewed box; Find Jobs links to it', async () => {
  const saved = await (await srv.request('/saved')).text();
  assert.match(saved, /<section class="recent-jobs" id="recent" aria-labelledby="recent-h" hidden>/);
  assert.match(saved, /kept on this device only/);
  assert.match(await (await srv.request('/jobs')).text(), /data-recent-link hidden><a href="\/saved#recent">Jobs you looked at recently<\/a>/);
});

test('main.js keeps the last 10, newest first, and drops closed ones', () => {
  assert.match(js, /const VIEWED_KEY = 'hireriv:viewed-jobs';/);
  assert.match(js, /const VIEWED_MAX = 10;/);
  assert.match(js, /writeViewed\(\[id, \.\.\.readViewed\(\)\.filter\(\(x\) => x !== id\)\]\)/);
  assert.match(js, /querySelectorAll\('\.job-card\.is-closed'\)\.forEach\(\(el\) => el\.remove\(\)\)/);
});
