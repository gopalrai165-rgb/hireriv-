// Office, skilled and field work: categories, kinds of work, job types,
// the Find Work tabs and filters, Google for Jobs data, and the one-time
// category upgrade for sites that saved their own list.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('./helpers');
const { DEFAULT_JOB_CATEGORIES, CATEGORY_WORK, workOf } = require('../content');

const siteSeed = () => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'site.json'), 'utf8'));
const found = (html) => Number((html.match(/<b>(\d+)<\/b> jobs? found/) || [])[1]);

let srv;
let admin;
before(async () => {
  srv = await startServer();
  admin = await srv.adminLogin();
});
after(() => srv && srv.stop());

test('every skilled, industrial and service category is offered by default and has a kind of work', () => {
  assert.equal(new Set(DEFAULT_JOB_CATEGORIES.map((c) => c.toLowerCase())).size, DEFAULT_JOB_CATEGORIES.length);
  for (const c of Object.keys(CATEGORY_WORK)) assert.ok(DEFAULT_JOB_CATEGORIES.includes(c), c);
  assert.equal(workOf({ category: 'Delivery & Driving' }), 'field');
  assert.equal(workOf({ category: 'Skilled Trades' }), 'skilled');
  assert.equal(workOf({ category: 'Technology' }), 'office');
  assert.equal(workOf({ category: 'A category added in Settings' }), 'office');
  assert.equal(workOf({ category: 'Construction & Real Estate', work: 'field' }), 'field'); // set on the job
  assert.equal(workOf({ category: 'Technology', work: 'purple' }), 'office');
});

test('Find Work: kind-of-work tabs, job type filter and grouped categories', async () => {
  const all = await (await srv.request('/jobs')).text();
  assert.equal(found(all), 18);
  assert.match(all, /Industrial, field &amp; service <span class="count">3<\/span>/);
  assert.match(all, /Skilled &amp; technical <span class="count">3<\/span>/);
  assert.match(all, /<optgroup label="Industrial, field &amp; service">/);

  const blue = await (await srv.request('/jobs?work=field')).text();
  assert.equal(found(blue), 3);
  assert.match(blue, /Delivery Executive/);
  assert.doesNotMatch(blue, /Full-Stack Developer/);
  assert.match(blue, /href="\/jobs\?work=field" title="[^"]*" aria-current="page"/);
  assert.match(blue, /<input type="hidden" name="work" value="field">/); // kept when searching

  assert.equal(found(await (await srv.request('/jobs?type=Temporary')).text()), 1);
  assert.equal(found(await (await srv.request('/jobs?work=skilled&location=Pune')).text()), 1);
  // Tab counts follow the other filters.
  assert.match(await (await srv.request('/jobs?location=Pune')).text(), /Skilled &amp; technical <span class="count">1<\/span>/);
  assert.equal(found(await (await srv.request('/jobs?work=nonsense')).text()), 18);
});

test('homepage links to each kind of work', async () => {
  const home = await (await srv.request('/')).text();
  assert.match(home, /Office, skilled or on the ground/);
  assert.match(home, /href="\/jobs\?work=field"[\s\S]*?3 open jobs/);
});

test('posting a daily-wage job with its kind of work set by hand', async () => {
  const form = {
    title: 'Site Helper', company: 'Builder', location: 'Pune', mode: 'On-site', type: 'Daily wage / Gig',
    category: 'Construction & Real Estate', work: 'field', experience: '', salary: '₹700 per day', skills: 'Shuttering',
    description: 'Help on a residential construction site.', responsibilities: '', status: 'open',
  };
  const res = await srv.request('/admin/jobs', { method: 'POST', cookie: admin, form });
  assert.equal(res.status, 302);
  const job = srv.records('jobs').find((j) => j.title === 'Site Helper');
  assert.equal(job.work, 'field');
  assert.equal(found(await (await srv.request('/jobs?work=field')).text()), 4);

  const page = await (await srv.request(`/jobs/${job.id}`)).text();
  assert.match(page, /"employmentType":"PER_DIEM"/);
  assert.match(page, /"minValue":700,"maxValue":700,"unitText":"DAY"/);
  assert.match(await (await srv.request('/jobs/hr-115')).text(), /"employmentType":"TEMPORARY"[\s\S]*"unitText":"MONTH"/);

  assert.equal((await srv.request('/admin/jobs', { method: 'POST', cookie: admin, form: { ...form, title: 'Bad type', type: 'Weekly' } })).status, 400);
  // "Same as the category" stores nothing, so the category decides.
  await srv.request(`/admin/jobs/${job.id}`, { method: 'POST', cookie: admin, form: { ...form, work: '', category: 'Factory & Production' } });
  assert.equal(srv.records('jobs').find((j) => j.id === job.id).work, '');
  assert.equal(found(await (await srv.request('/jobs?work=field')).text()), 4);
});

test('sites with their own category list get the new categories once', async () => {
  const site = { ...siteSeed(), jobCategories: ['Technology', 'Warehouse & packing', 'Pet Grooming'] };
  const custom = await startServer({}, { site: [site] });
  try {
    const saved = custom.records('site')[0].jobCategories;
    assert.deepEqual(saved.slice(0, 3), ['Technology', 'Warehouse & packing', 'Pet Grooming']);
    assert.ok(saved.includes('Delivery & Driving'));
    assert.equal(saved.filter((c) => c.toLowerCase() === 'warehouse & packing').length, 1); // no near-duplicate
    assert.equal(saved.length, 3 + Object.keys(CATEGORY_WORK).length - 1);
  } finally {
    await custom.stop();
  }

  // Already upgraded (e.g. someone removed some afterwards): left alone on restart.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hireriv-cat-'));
  const dbFile = path.join(dir, 'test.db');
  const store = require('../db').open(dbFile);
  store.replaceAll('site', [{ ...siteSeed(), jobCategories: ['Technology'] }]);
  store.metaSet('upgraded:categories-v2', '2026-10-24T00:00:00.000Z');
  store.close();
  const again = await startServer({ DB_FILE: dbFile });
  try {
    const db = new (require('node:sqlite').DatabaseSync)(dbFile, { readOnly: true });
    const cats = JSON.parse(db.prepare("SELECT data FROM records WHERE collection = 'site'").get().data).jobCategories;
    db.close();
    assert.deepEqual(cats, ['Technology']);
  } finally {
    await again.stop();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
