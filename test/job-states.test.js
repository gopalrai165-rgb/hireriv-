// Jobs by state: the list of states, one state's page with its cities,
// nearby cities within 100 km on city pages, and job alerts for a whole state.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');
const starter = require('./fixtures/jobs.json');

let srv;
before(async () => { srv = await startServer({}, { jobs: starter.map((j) => ({ ...j, sample: false })) }); });
after(() => srv && srv.stop());
const page = async (p, opts) => (await srv.request(p, opts)).text();
const live = starter.filter((j) => j.status === 'open' || !j.status);
const count = (cities) => live.filter((j) => cities.includes(j.location)).length;

test('the states page lists every state with its cities and open jobs', async () => {
  const html = await page('/jobs/states');
  assert.match(html, /<h1>Jobs by state<\/h1>/);
  assert.match(html, /<a class="state-name" href="\/jobs\/state\/maharashtra"><b>Maharashtra<\/b>/);
  assert.match(html, /<a href="\/jobs\/in\/pune">Pune<\/a>/);
  assert.match(html, /<a class="state-name" href="\/jobs\/state\/tamil-nadu"><b>Tamil Nadu<\/b>/);
});

test("a state's page shows the jobs in all its cities, each city's count and an alert for the state", async () => {
  const res = await srv.request('/jobs/state/maharashtra');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<h1>Jobs in Maharashtra<\/h1>/);
  const n = count(['Mumbai', 'Navi Mumbai', 'Thane', 'Pune', 'Nagpur', 'Nashik']);
  assert.match(html, new RegExp(`${n} open job`));
  assert.match(html, /<a href="\/jobs\/in\/pune">Jobs in Pune<\/a> <span class="muted">\(\d+ open\)<\/span>/);
  assert.match(html, /href="\/jobs\?location=Maharashtra#alerts">Get an email when new jobs open in Maharashtra/);
  assert.match(html, /<a href="\/jobs\/states">Jobs by state<\/a>/, 'breadcrumbs');
  assert.equal((await srv.request('/jobs/state/atlantis')).status, 404);
  const map = await page('/sitemap.xml');
  assert.match(map, /\/jobs\/state\/maharashtra<\/loc>/);
  assert.doesNotMatch(map, /\/jobs\/state\/goa<\/loc>/, 'states without jobs stay out of the sitemap');
});

test('city pages show nearby cities within 100 km with their open jobs, and the whole state', async () => {
  const html = await page('/jobs/in/mumbai');
  assert.match(html, /Jobs within 100 km of Mumbai/);
  assert.match(html, /<a href="\/jobs\/in\/navi-mumbai"><b>Navi Mumbai<\/b><span class="muted small">about \d+ km away<\/span><span class="nearby-count">\d+ open jobs?<\/span><\/a>/);
  assert.match(html, /<a href="\/jobs\/state\/maharashtra">All jobs in Maharashtra<\/a>/);
  assert.match(await page('/jobs/freshers'), /href="\/jobs\/state\/karnataka">Jobs in Karnataka<\/a>/, 'linked from more ways to find jobs');
});

test('a job alert can cover a whole state', async () => {
  assert.match(await page('/jobs?location=Maharashtra'), /<optgroup label="Whole state">[^]*<option selected>Maharashtra<\/option>/);
  const res = await srv.request('/api/job-alerts', { method: 'POST', headers: { accept: 'application/json' }, form: { email: 'state@example.in', location: 'Maharashtra' } });
  assert.equal(res.status, 200);
  const bad = await srv.request('/api/job-alerts', { method: 'POST', headers: { accept: 'application/json' }, form: { email: 'state2@example.in', location: 'Atlantis' } });
  assert.equal(bad.status, 400);
});
