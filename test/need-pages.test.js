// Pages for what job seekers ask for first: work from home, part-time, night
// shift, freshers, walk-in interviews and no English needed, across India and
// in a city, linked from the other landing pages and listed in the sitemap.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

const day = (offset) => new Date(Date.now() + offset * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const base = { company: 'Nova Foods', mode: 'On-site', type: 'Full-time', category: 'Logistics', experience: '1-3 years', salary: '', skills: ['Packing'], description: 'Work', responsibilities: [], posted: day(-1), status: 'open', alertsSentAt: day(-1) };
const seedJobs = [
  { ...base, id: 'hr-401', title: 'Home Telecaller', location: 'Remote', mode: 'Remote' },
  { ...base, id: 'hr-402', title: 'Weekend Cashier', location: 'Pune', type: 'Part-time' },
  { ...base, id: 'hr-403', title: 'Night Security Guard', location: 'Mumbai', shift: 'Night' },
  { ...base, id: 'hr-404', title: 'Trainee Picker', location: 'Pune', experience: 'Fresher' },
  { ...base, id: 'hr-405', title: 'Walk-in Loader', location: 'Pune', walkIn: true, address: 'Gate 4, Chakan', walkInTo: day(3) },
  { ...base, id: 'hr-406', title: 'Delivery Rider', location: 'Pune', english: 'None' },
  { ...base, id: 'hr-407', title: 'Old Walk-in Packer', location: 'Pune', walkIn: true, address: 'Gate 1', walkInFrom: day(-9), walkInTo: day(-2) },
];
let srv;
before(async () => {
  srv = await startServer({}, { jobs: seedJobs });
});
after(() => srv && srv.stop());

test('each page lists exactly its jobs', async () => {
  const expect = {
    '/jobs/work-from-home': ['Home Telecaller'],
    '/jobs/part-time': ['Weekend Cashier'],
    '/jobs/night-shift': ['Night Security Guard'],
    '/jobs/freshers': ['Trainee Picker'],
    '/jobs/walk-in': ['Walk-in Loader'],
    '/jobs/no-english': ['Delivery Rider'],
  };
  const titles = seedJobs.map((j) => j.title);
  for (const [path, want] of Object.entries(expect)) {
    const res = await srv.request(path);
    assert.equal(res.status, 200, path);
    const html = await res.text();
    for (const t of titles) assert.equal(html.includes(`>${t}<`), want.includes(t), `${path}: ${t}`);
  }
});

test('city versions, links, search and the sitemap', async () => {
  const pune = await (await srv.request('/jobs/part-time/in/pune')).text();
  assert.match(pune, /<h1[^>]*>Part-time jobs in Pune<\/h1>/);
  assert.ok(pune.includes('>Weekend Cashier<'));
  assert.match(pune, /href="\/jobs\?type=Part-time&amp;location=Pune"/, 'links to the same search with more filters');
  assert.match(pune, /href="\/jobs\/part-time">Part-time jobs<\/a>/, 'breadcrumb back to the India page');
  assert.match(pune, /href="\/jobs\/night-shift\/in\/pune"/, 'other needs in the same city');
  // A city without such jobs stays reachable but out of search engines.
  assert.match(await (await srv.request('/jobs/night-shift/in/pune')).text(), /<meta name="robots" content="noindex/);
  // Working from home has no city pages.
  assert.equal((await srv.request('/jobs/work-from-home/in/pune')).status, 404);
  assert.equal((await srv.request('/jobs/part-time/in/atlantis')).status, 404);

  assert.match(await (await srv.request('/')).text(), /<b>Popular searches<\/b>[\s\S]*href="\/jobs\/walk-in">Walk-in interview jobs</);
  const map = await (await srv.request('/sitemap.xml')).text();
  for (const p of ['/jobs/work-from-home', '/jobs/part-time', '/jobs/part-time/in/pune', '/jobs/night-shift/in/mumbai', '/jobs/no-english/in/pune']) assert.ok(map.includes(`${p}</loc>`), p);
  assert.ok(!map.includes('/jobs/night-shift/in/pune</loc>'), 'empty city pages are left out');
  // Jobs keep their own addresses.
  assert.equal((await srv.request('/jobs/hr-402')).status, 200);
});
