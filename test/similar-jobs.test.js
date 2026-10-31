// Similar jobs: the same role, category and city count; after applying the
// job page offers "Apply to similar jobs" with one-tap apply, and the quick
// apply form points to them once sent.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, decodeEmail } = require('./helpers');

const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'main.js'), 'utf8');
const day = (offset) => new Date(Date.now() + offset * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const base = { company: 'Nova Foods', location: 'Pune', mode: 'Field work', type: 'Full-time', category: 'Logistics', experience: 'Fresher', salary: '', skills: [], description: 'Work', responsibilities: [], posted: day(-3), status: 'open', alertsSentAt: day(-3), resume: 'optional' };
const jobs = [
  { ...base, id: 'hr-1', title: 'Delivery Executive' },
  { ...base, id: 'hr-2', title: 'Delivery Partner', posted: day(-1) },
  { ...base, id: 'hr-3', title: 'Warehouse Picker', location: 'Mumbai' },
  { ...base, id: 'hr-4', title: 'Delivery Rider', location: 'Delhi', category: 'Retail' },
  { ...base, id: 'hr-5', title: 'Accountant', category: 'Finance', mode: 'On-site' },
  { ...base, id: 'hr-6', title: 'Nurse', location: 'Chennai', category: 'Healthcare', mode: 'On-site' },
];
let srv;
let ip = 0;
const headers = () => ({ 'x-forwarded-for': `10.8.0.${++ip}` });
before(async () => { srv = await startServer({ TRUST_PROXY: '1' }, { jobs }); });
after(() => srv && srv.stop());

const similarTitles = (html) => {
  const at = html.indexOf('id="similar"');
  return at < 0 ? [] : [...html.slice(at).matchAll(/<h3><a href="[^"]+">([^<]+)<\/a><\/h3>/g)].map((m) => m[1]);
};

test('the best matches come first; jobs with nothing in common are left out', async () => {
  const html = await (await srv.request('/jobs/hr-1')).text();
  // Same role, category and city; then same category; then same role elsewhere. The nurse never.
  assert.deepEqual(similarTitles(html), ['Delivery Partner', 'Delivery Rider', 'Warehouse Picker', 'Accountant']);
  assert.match(html, /<h2>Similar jobs<\/h2>/);
  assert.match(html, /data-similar-prompt hidden/);
});

test('after applying: "Apply to similar jobs", with one-tap apply on them', async () => {
  const email = 'ravi@example.in';
  const fd = new FormData();
  for (const [k, v] of Object.entries({ name: 'Ravi Kumar', email, phone: '9845012399', location: 'Pune', agree: '1' })) fd.append(k, v);
  assert.equal((await srv.request('/account/register', { method: 'POST', body: fd, headers: headers() })).status, 200);
  await srv.waitForEmail((m) => m.includes(`To: ${email}`) && decodeEmail(m).includes('/account/verify/'));
  const mail = decodeEmail(srv.emails().filter((m) => m.includes(`To: ${email}`)).pop());
  const cookie = srv.cookieFrom(await srv.request(mail.match(/\/account\/verify\/[a-f0-9]{64}/)[0], { method: 'POST', form: {}, headers: headers() }));
  assert.equal((await srv.request('/account/apply/hr-1', { method: 'POST', cookie, form: {}, headers: headers() })).status, 302);
  const html = await (await srv.request('/jobs/hr-1', { cookie })).text();
  assert.match(html, /<a href="#similar" class="btn btn-primary btn-block similar-cta">Apply to similar jobs<\/a>/);
  assert.match(html, /<h2>Apply to similar jobs<\/h2>/);
  assert.match(html.slice(html.indexOf('id="similar"')), /action="\/account\/apply\/hr-2" class="one-tap"/);
});

test('the quick apply form shows the prompt once sent', () => {
  assert.match(js, /const similar = form\.dataset\.applyForm !== undefined && document\.querySelector\('\[data-similar-prompt\]'\);/);
});
