// Immediate joining (ticked on the form or in the listing's words): a card
// tag, the joining=immediate filter, its page and the API; and how many
// people applied to an open job, on the job page and cards.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const needs = require('../job-needs');
const { startServer } = require('./helpers');

const day = (offset) => new Date(Date.now() + offset * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const base = { company: 'Nova Foods', location: 'Pune', mode: 'On-site', type: 'Full-time', category: 'Logistics', experience: 'Fresher', salary: '', skills: [], description: 'Work', responsibilities: [], posted: day(-1), status: 'open', alertsSentAt: day(-1) };
const seedJobs = [
  { ...base, id: 'hr-901', title: 'Picker Packer', immediate: true, openings: '8' },
  { ...base, id: 'hr-902', title: 'Store Cashier', description: 'Immediate joiners preferred. Billing at the counter.' },
  { ...base, id: 'hr-903', title: 'Office Assistant' },
];
const apps = Array.from({ length: 12 }, (_, i) => ({ id: `a${i}`, jobId: 'hr-901', name: `P${i}`, email: `p${i}@example.com`, phone: '9876543210', createdAt: new Date().toISOString(), status: 'New' }));
let srv;
before(async () => { srv = await startServer({}, { jobs: seedJobs, applications: apps }); });
after(() => srv && srv.stop());

test('startsNow: the ticked box or the listing\'s own words', () => {
  assert.equal(needs.startsNow({ immediate: true }), true);
  assert.equal(needs.startsNow({ description: 'We need immediate joiners.' }), true);
  assert.equal(needs.startsNow({ mustHave: ['Must join immediately'] }), true);
  assert.equal(needs.startsNow({ description: 'Reply immediately to customers' }), false);
  assert.equal(needs.startsNow({ description: 'Work' }), false);
});

test('the filter, the API and the page list only jobs that start now', async () => {
  const api = await (await srv.request('/api/jobs?joining=immediate')).json();
  assert.deepEqual(api.jobs.map((j) => j.id).sort(), ['hr-901', 'hr-902']);
  assert.equal(api.jobs.find((j) => j.id === 'hr-902').immediateJoining, true);
  const html = await (await srv.request('/jobs?joining=immediate')).text();
  assert.doesNotMatch(html, /Office Assistant/);
  assert.match(html, /<span class="tag tag-walkin">Immediate joining<\/span>/);
  const page = await (await srv.request('/jobs/immediate-joining/in/pune')).text();
  assert.match(page, /Immediate joining jobs/);
  assert.match(page, /Store Cashier/);
  assert.doesNotMatch(page, /Office Assistant/);
});

test('how many applied: counts from 5, "first to apply" below that, openings on cards', async () => {
  assert.match(await (await srv.request('/jobs/hr-901')).text(), /12 people have applied · 8 openings/);
  assert.match(await (await srv.request('/jobs/hr-903')).text(), /Be one of the first to apply/);
  const list = await (await srv.request('/jobs')).text();
  assert.match(list, /8 openings · 12 applied/);
});
