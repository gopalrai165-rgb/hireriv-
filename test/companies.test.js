// Companies hiring now: /companies lists every active company with live jobs
// of its own (most jobs first), company pages show where they hire, and both
// are in the sitemap.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

const day = (offset) => new Date(Date.now() + offset * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const base = { location: 'Pune', mode: 'On-site', type: 'Full-time', category: 'Logistics', experience: 'Fresher', salary: '', skills: [], description: 'Work', responsibilities: [], posted: day(-1), status: 'open', alertsSentAt: day(-1) };
const emp = (id, company, extra = {}) => ({ id, company, name: 'Owner', email: `${id}@example.com`, industry: 'Logistics', active: true, createdAt: new Date().toISOString(), ...extra });
const employers = [emp('emp-a', 'Acme Foods'), emp('emp-b', 'Bright Retail', { industry: 'Retail' }), emp('emp-c', 'Closed Co', { active: false }), emp('emp-d', 'No Jobs Ltd')];
const jobs = [
  { ...base, id: 'hr-1', title: 'Packer', company: 'Acme Foods', employerId: 'emp-a' },
  { ...base, id: 'hr-2', title: 'Loader', company: 'Acme Foods', employerId: 'emp-a', location: 'Mumbai', category: 'Manufacturing' },
  { ...base, id: 'hr-3', title: 'Cashier', company: 'Bright Retail', employerId: 'emp-b' },
  { ...base, id: 'hr-4', title: 'Helper', company: 'Closed Co', employerId: 'emp-c' },
  { ...base, id: 'hr-5', title: 'Old job', company: 'No Jobs Ltd', employerId: 'emp-d', status: 'closed' },
];
let srv;
before(async () => { srv = await startServer({}, { jobs, employers }); });
after(() => srv && srv.stop());

test('the list: active companies with live jobs, most jobs first', async () => {
  const html = await (await srv.request('/companies')).text();
  assert.match(html, /<h1>Companies hiring now<\/h1>/);
  assert.ok(html.indexOf('Acme Foods') < html.indexOf('Bright Retail'));
  assert.match(html, /2 open jobs/);
  assert.match(html, /Hiring in Pune, Mumbai|Hiring in Mumbai, Pune/);
  assert.doesNotMatch(html, /Closed Co|No Jobs Ltd/);
});

test('a company page shows where it hires; the sitemap lists the pages', async () => {
  const html = await (await srv.request('/companies/emp-a')).text();
  assert.match(html, /<dt>Hiring in<\/dt><dd>(Pune, Mumbai|Mumbai, Pune)<\/dd>/);
  assert.match(html, /<dt>Kinds of jobs<\/dt><dd>Logistics, Manufacturing<\/dd>/);
  assert.match(html, /href="\/companies" class="back-link"/);
  const map = await (await srv.request('/sitemap.xml')).text();
  assert.match(map, /\/companies<\/loc>/);
  assert.match(map, /\/companies\/emp-a<\/loc>/);
  assert.doesNotMatch(map, /\/companies\/emp-c<\/loc>/);
});
