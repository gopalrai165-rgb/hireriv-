// Salary pages: figures from real listings with pay, per month, only when
// enough listings share them; by city and for freshers; linked from role pages.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const salaries = require('../salaries');
const { startServer } = require('./helpers');

const day = (offset) => new Date(Date.now() + offset * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

test('pay becomes monthly, each listing counts once at its middle, rounded to ₹500', () => {
  assert.deepEqual(salaries.monthly({ pay: { min: 600, max: 800, period: 'day' } }), { min: 15600, max: 20800, mid: 18200 });
  assert.deepEqual(salaries.monthly({ pay: { min: 240000, period: 'year' } }), { min: 20000, max: 20000, mid: 20000 });
  assert.equal(salaries.monthly({ pay: null }), null);
  const jobs = [12000, 15000, 18000, 21000, 40000].map((m) => ({ pay: { min: m, max: m, period: 'month' } }));
  assert.deepEqual(salaries.summarise(jobs), { count: 5, enough: true, median: 18000, typicalLow: 15000, typicalHigh: 21000, lowest: 12000, highest: 40000 });
  assert.deepEqual(salaries.summarise(jobs.slice(0, 2)), { count: 2, enough: false });
  // Only real, published listings from the last 12 months with pay.
  const today = day(0);
  const base = { pay: { min: 1, max: 1, period: 'month' }, posted: day(-10), status: 'open' };
  const kept = salaries.pool([base, { ...base, sample: true }, { ...base, posted: day(-400) }, { ...base, pay: null }, { ...base, status: 'draft' }], { isSample: (j) => j.sample === true, isPublic: (j) => j.status !== 'draft', today });
  assert.equal(kept.length, 1);
});

const job = (id, location, min, max, extra = {}) => ({ id, title: 'Delivery Executive', company: 'Swift', location, mode: 'Field work', type: 'Full-time', category: 'Logistics', experience: '1-3 years', skills: ['Delivery'], description: 'Deliver parcels', responsibilities: [], posted: day(-5), status: 'open', alertsSentAt: day(-5), pay: { min, max, period: 'month', currency: 'INR' }, salary: '', ...extra });
const seedJobs = [
  job('hr-501', 'Pune', 16000, 20000), job('hr-502', 'Pune', 18000, 22000), job('hr-503', 'Pune', 20000, 24000, { experience: 'Fresher' }),
  job('hr-504', 'Mumbai', 22000, 26000, { experience: 'Fresher' }), job('hr-505', 'Mumbai', 24000, 28000, { experience: 'Fresher' }),
  job('hr-506', 'Pune', 90000, 99000, { sample: true }),
  job('hr-507', 'Delhi', 15000, 17000, { status: 'closed', posted: day(-30) }),
];
let srv;
before(async () => {
  srv = await startServer({}, { jobs: seedJobs });
});
after(() => srv && srv.stop());

test('the role page: India, by city, freshers and the method', async () => {
  const html = await (await srv.request('/salaries/delivery')).text();
  assert.match(html, /<h1>Delivery salary in India<\/h1>/);
  // Middles 18k, 20k, 22k, 24k, 26k, 16k (closed, still counted); the sample job is not.
  assert.match(html, /Most delivery jobs on .* pay <b>₹18,500 – ₹23,500 a month<\/b>/);
  assert.match(html, /<b>6<\/b><span class="small">with pay/);
  assert.match(html, /href="\/salaries\/delivery\/in\/pune">Pune<\/a><\/th><td>₹19,000 – ₹21,000/);
  assert.doesNotMatch(html, /\/salaries\/delivery\/in\/mumbai">Mumbai/, 'two listings are not enough for a city');
  assert.match(html, /Freshers: most jobs pay <b>₹23,000 – ₹25,000 a month<\/b> \(3 listings\)/);
  assert.match(html, /Sample listings are never counted/);
  assert.doesNotMatch(html, /99,000/);

  const pune = await (await srv.request('/salaries/delivery/in/pune')).text();
  assert.match(pune, /<h1>Delivery salary in Pune<\/h1>/);
  const mumbai = await (await srv.request('/salaries/delivery/in/mumbai')).text();
  assert.match(mumbai, /Not enough delivery listings in Mumbai/);
  assert.match(mumbai, /<meta name="robots" content="noindex/);
  assert.equal((await srv.request('/salaries/astronaut')).status, 404);
});

test('the index, the role landing page and the sitemap link to them', async () => {
  const index = await (await srv.request('/salaries')).text();
  assert.match(index, /href="\/salaries\/delivery">Delivery<\/a><\/th>\s*<td>₹18,500 – ₹23,500<\/td>/);
  assert.match(index, /href="\/salaries\/nurse">Nurse<\/a><\/th>\s*<td colspan="2" class="muted small">Not enough listings yet/);
  const landing = await (await srv.request('/jobs/role/delivery')).text();
  assert.match(landing, /Typical pay: <b>₹18,500 – ₹23,500 a month<\/b> \(<a href="\/salaries\/delivery">salary details<\/a>\)/);
  const map = await (await srv.request('/sitemap.xml')).text();
  for (const p of ['/salaries', '/salaries/delivery', '/salaries/delivery/in/pune']) assert.ok(map.includes(`${p}</loc>`), p);
  assert.ok(!map.includes('/salaries/nurse</loc>'));
});
