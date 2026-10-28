// Jobs by area inside a city (areas.js, geo.js): a job's area from the form
// or its address, shown on cards and the job page, an area filter, area
// names in "Near" with distances to the kilometre, and a page per area.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const geo = require('../geo');
const { startServer } = require('./helpers');

const day = (offset) => new Date(Date.now() + offset * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

test('areas are found from the form or the address, and placed', () => {
  const slugs = geo.ALL_AREAS.map((a) => a.slug);
  assert.equal(new Set(slugs).size, slugs.length, 'area names are unique across cities');
  assert.equal(geo.areaOf({ location: 'Pune', address: 'Plot 12, MIDC Bhosari, Pune' }).name, 'Bhosari');
  assert.equal(geo.areaOf({ location: 'Pune', area: 'Hinjawadi Phase 2' }).name, 'Hinjewadi', 'other spellings count');
  assert.equal(geo.areaOf({ location: 'Pune', area: 'Kharadi', address: 'Near Hadapsar' }).name, 'Kharadi', 'the form wins over the address');
  assert.equal(geo.areaOf({ location: 'Mumbai', address: 'Fortune Towers, Malad' }).name, 'Malad', 'whole words only');
  assert.equal(geo.areaOf({ location: 'Delhi NCR', address: 'Plot 5, Udyog Vihar' }).name, 'Udyog Vihar');
  assert.equal(geo.areaOf({ location: 'Pune', address: 'Andheri East' }), null, 'only areas of the job’s own city');
  assert.equal(geo.areaLabel({ location: 'Pune', area: 'Sus Gaon' }), 'Sus Gaon', 'an unlisted area is shown as typed');

  assert.deepEqual(geo.parseNear('hinjawadi'), { point: [18.59, 73.74], label: 'Hinjewadi, Pune', kind: 'area', value: 'Hinjewadi, Pune' });
  assert.equal(geo.parseNear('Andheri, Mumbai').kind, 'area');
  assert.equal(geo.parseNear('Andheri, Pune').error, 'errFormat');
  const km = geo.jobDistance({ location: 'Pune', area: 'Kharadi' }, geo.parseNear('Hinjewadi').point);
  assert.ok(km > 18 && km < 26, String(km));
  assert.deepEqual(geo.nearbyAreas(geo.areaBySlug('pune', 'hinjewadi')).slice(0, 2).map((a) => a.name), ['Wakad', 'Baner']);
});

const base = { company: 'Nova Foods', location: 'Pune', mode: 'On-site', type: 'Full-time', category: 'Logistics', experience: 'Fresher', salary: '', skills: ['Packing'], description: 'Work', responsibilities: [], posted: day(-1), status: 'open', alertsSentAt: day(-1) };
const seedJobs = [
  { ...base, id: 'hr-701', title: 'IT Helpdesk Executive', area: 'Hinjewadi' },
  { ...base, id: 'hr-702', title: 'Warehouse Picker', address: 'Gate 2, Wakad Industrial Estate, Pune' },
  { ...base, id: 'hr-703', title: 'Store Cashier', area: 'Kharadi' },
  { ...base, id: 'hr-704', title: 'Office Boy', location: 'Mumbai', area: 'Andheri East' },
  { ...base, id: 'hr-705', title: 'Field Sales Officer' },
];
const titles = seedJobs.map((j) => j.title);
const shows = (html, want) => { for (const t of titles) assert.equal(html.includes(`>${t}<`), want.includes(t), t); };
let srv;
let admin;
before(async () => {
  srv = await startServer({}, { jobs: seedJobs });
  admin = await srv.adminLogin();
});
after(() => srv && srv.stop());

test('cards, the job page and the area filter', async () => {
  const all = await (await srv.request('/jobs')).text();
  assert.match(all, /Hinjewadi, Pune<\/li>/);
  assert.match(all, /Andheri, Mumbai<\/li>/);
  assert.match(all, /<option value="Hinjewadi, Pune">/, '"Near" suggests areas');
  assert.doesNotMatch(all, /id="f-area"/, 'no area list until a city is chosen');
  const pune = await (await srv.request('/jobs?location=Pune')).text();
  assert.match(pune, /<select id="f-area" name="area">/);
  assert.match(pune, /<option value="hinjewadi"/);
  shows(await (await srv.request('/jobs?location=Pune&area=hinjewadi')).text(), ['IT Helpdesk Executive']);
  shows(await (await srv.request('/jobs?location=Pune&area=wakad')).text(), ['Warehouse Picker']);
  assert.match(await (await srv.request('/jobs/hr-701')).text(), /Hinjewadi, Pune, Maharashtra/);
  shows(await (await srv.request('/jobs?q=hinjewadi')).text(), ['IT Helpdesk Executive']);
});

test('"Near" an area sorts by distance and shows it to the kilometre', async () => {
  const html = await (await srv.request('/jobs?near=Hinjewadi')).text();
  const order = ['IT Helpdesk Executive', 'Warehouse Picker', 'Store Cashier'].map((t) => html.indexOf(`>${t}<`));
  assert.ok(order[0] < order[1] && order[1] < order[2], String(order));
  assert.match(html, /Under 1 km away/);
  assert.match(html, /~2 km away/);
  assert.match(html, /~20 km away|~25 km away|~2\d km away/);
  assert.match(html, /Nearest jobs to Hinjewadi, Pune first/);
});

test('area pages, links from the city page, and the sitemap', async () => {
  const page = await srv.request('/jobs/in/pune/hinjewadi');
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<h1[^>]*>Jobs in Hinjewadi, Pune<\/h1>/);
  shows(html, ['IT Helpdesk Executive']);
  assert.match(html, /href="\/jobs\/in\/pune">Jobs in Pune<\/a>/, 'breadcrumb back to the city');
  assert.match(html, /href="\/jobs\/in\/pune\/wakad">Jobs in Wakad<\/a> <span class="muted">\(~2 km\)/);
  assert.match(html, /href="\/jobs\?location=Pune&amp;area=hinjewadi"/);
  const empty = await (await srv.request('/jobs/in/pune/chakan')).text();
  assert.match(empty, /<meta name="robots" content="noindex/);
  assert.equal((await srv.request('/jobs/in/pune/andheri')).status, 404, 'an area of another city');
  assert.equal((await srv.request('/jobs/in/pune/atlantis')).status, 404);

  const city = await (await srv.request('/jobs/in/pune')).text();
  assert.match(city, /By area: .*href="\/jobs\/in\/pune\/hinjewadi">Jobs in Hinjewadi<\/a> <span class="muted">\(1\)/);
  const map = await (await srv.request('/sitemap.xml')).text();
  for (const p of ['/jobs/in/pune/hinjewadi</loc>', '/jobs/in/pune/wakad</loc>', '/jobs/in/mumbai/andheri</loc>']) assert.ok(map.includes(p), p);
  assert.ok(!map.includes('/jobs/in/pune/chakan</loc>'));
});

test('the API and the job form', async () => {
  const one = await (await srv.request('/api/jobs/hr-702')).json();
  assert.equal((one.job || one).area, 'Wakad');
  assert.equal((await (await srv.request('/api/jobs?location=Pune&area=kharadi')).json()).jobs.map((j) => j.id).join(), 'hr-703');
  const spec = await (await srv.request('/api/v1/openapi.json')).json();
  assert.ok(spec.components.schemas.JobInput.properties.area);

  assert.match(await (await srv.request('/admin/jobs/new', { cookie: admin })).text(), /name="area"[^>]*list="job-areas"/);
  const form = { ...base, skills: 'Packing', responsibilities: '', title: 'Field Sales Officer', area: '  Baner ' };
  delete form.posted; delete form.alertsSentAt;
  const saved = await srv.request('/admin/jobs/hr-705', { method: 'POST', cookie: admin, form });
  assert.ok(saved.status < 400, String(saved.status));
  assert.equal(srv.records('jobs').find((x) => x.id === 'hr-705').area, 'Baner');
});
