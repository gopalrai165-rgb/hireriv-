// Step 173: "Fill from a job post" on the employer and admin job forms. The
// rules in job-parse.js read a pasted WhatsApp message, email or job
// description into the form's own values; nothing is saved.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { parseJobPost } = require('../job-parse');
const { DEFAULT_JOB_CATEGORIES, DEFAULT_JOB_LOCATIONS } = require('../content');
const { startServer } = require('./helpers');
const { hashPassword } = require('../employers');

const ctx = { cities: ['Remote', ...DEFAULT_JOB_LOCATIONS, 'Multiple locations'], categories: DEFAULT_JOB_CATEGORIES };
const read = (text) => parseJobPost(text, ctx);

test('a WhatsApp-style post fills title, city, area, pay, experience, openings and more', () => {
  const r = read(`*Urgent Hiring* 🔥
Need 5 Telecallers in Pune (Hinjewadi)
Salary: 15k - 20k + incentives
Freshers can apply. Basic English required.
12th pass or graduate
Timing 9:30 AM to 6:30 PM, 6 days working
Walk-in interview Mon-Sat. Immediate joining.
Contact HR Priya 98765 43210`);
  assert.deepEqual(
    { ...r.fields, description: undefined },
    { title: 'Telecaller', location: 'Pune', area: 'Hinjewadi', salaryMin: '15000', salaryMax: '20000', salaryPeriod: 'month', experience: 'Fresher', openings: '5', hours: '9:30 AM – 6:30 PM', schedule: '6 days a week', english: 'Basic', minEducation: '12th', category: 'Customer Support & BPO', description: undefined },
  );
  assert.deepEqual(r.checks, { perks: ['incentives'], bring: [], walkIn: true, immediate: true });
  assert.doesNotMatch(r.fields.description, /98765|Priya|Urgent Hiring|Salary:/, 'no phone, heading or lines already read into fields');
  assert.match(r.notes.join(' '), /Left out 1 line with a phone number/);
});

test('labelled email posts fill sections, yearly pay, skills and the city by its old name', () => {
  const r = read(`Job Title: Accountant
Location: Bangalore
Experience: 2-4 years in Tally, GST, TDS
CTC 3 - 4.5 LPA
Full time, work from office
Responsibilities:
• Maintain books of accounts in Tally
• File GST returns monthly
Requirements:
• B.Com graduate
• Good English
Send CV to hr@acme.in`);
  assert.equal(r.fields.title, 'Accountant');
  assert.equal(r.fields.location, 'Bengaluru');
  assert.deepEqual([r.fields.salaryMin, r.fields.salaryMax, r.fields.salaryPeriod], ['300000', '450000', 'year']);
  assert.equal(r.fields.experience, '2-4 years');
  assert.equal(r.fields.type, 'Full-time');
  assert.equal(r.fields.mode, 'On-site');
  assert.equal(r.fields.english, 'Good');
  assert.equal(r.fields.minEducation, 'graduate');
  assert.equal(r.fields.category, 'Finance & Accounting');
  assert.equal(r.fields.skills, 'Tally, GST, TDS');
  assert.equal(r.fields.responsibilities, 'Maintain books of accounts in Tally\nFile GST returns monthly');
  assert.equal(r.fields.qualifications, 'B.Com graduate\nGood English');
  assert.ok(!JSON.stringify(r.fields).includes('hr@acme.in'));
});

test('daily pay "up to", perks, things to bring and night shift', () => {
  const r = read('We are hiring delivery executives for Hyderabad and Secunderabad. Own bike and driving licence must. Earn up to Rs 800 per day. Daily payment, PF and ESI. Night shift available. 20 openings.');
  assert.equal(r.fields.title, 'Delivery Executive');
  assert.equal(r.fields.location, 'Hyderabad', 'Secunderabad is part of Hyderabad');
  assert.deepEqual([r.fields.salaryMin, r.fields.salaryMax, r.fields.salaryPeriod], [undefined, '800', 'day']);
  assert.equal(r.fields.openings, '20');
  assert.equal(r.fields.shift, 'Night');
  assert.deepEqual(r.checks.perks, ['pf', 'dailypay']);
  assert.deepEqual(r.checks.bring, ['bike', 'licence']);
});

test('remote jobs, "upto" pay, and a phone number at the end of a one-line post', () => {
  const r = read('Hiring a React developer (remote). 3+ years experience with React, Node.js and TypeScript. Package upto 12 LPA. Part time also ok. Call 9876543210.');
  assert.equal(r.fields.title, 'React Developer');
  assert.equal(r.fields.location, 'Remote');
  assert.equal(r.fields.mode, 'Remote');
  assert.equal(r.fields.salaryMin, undefined);
  assert.equal(r.fields.salaryMax, '1200000');
  assert.equal(r.fields.experience, '3+ years');
  assert.equal(r.fields.type, 'Part-time');
  assert.equal(r.fields.description, 'Hiring a React developer (remote). 3+ years experience with React, Node.js and TypeScript. Package upto 12 LPA. Part time also ok.');
});

test('"X required at …" titles, fees flagged, and several cities', () => {
  const r = read('Security guards required at Gurgaon client site. 10th pass. Salary 14000. Free accommodation and food. Registration fee Rs 500.');
  assert.equal(r.fields.title, 'Security Guard');
  assert.equal(r.fields.location, 'Gurugram');
  assert.equal(r.fields.mode, 'Client site');
  assert.deepEqual([r.fields.salaryMin, r.fields.salaryMax], ['14000', '14000']);
  assert.deepEqual(r.checks.perks, ['food', 'stay']);
  assert.match(r.notes.join(' '), /asks candidates to pay a fee/);
  const many = read('Hiring sales executives in Mumbai, Pune and Nagpur. Salary 20,000 - 25,000 per month.');
  assert.equal(many.fields.location, 'Multiple locations');
  assert.match(many.notes.join(' '), /Mumbai, Pune, Nagpur/);
  assert.equal(many.fields.category, 'Sales & Business Development');
});

test('phone numbers and PIN codes are never read as pay; unknown text fills nothing', () => {
  assert.equal(read('Contact 9876543210 for the role. Office PIN 411057.').fields.salaryMax, undefined);
  assert.equal(read('Salary 9876543210').fields.salaryMax, undefined);
  const none = read('hello there');
  assert.deepEqual(none.found.filter((f) => f !== 'Job title' && f !== 'Description'), []);
  assert.equal(read('Job in Atlantis').fields.location, undefined, 'only cities on the site list');
});

// ---------- the endpoints and the forms ----------
const EMP = { id: 'emp-p', company: 'Paste Co', name: 'Pia Rao', email: 'pia@paste.in', phone: '9800000002', passwordHash: hashPassword('pia long password 1'), passwordSetAt: '2026-01-01T00:00:00.000Z', active: true, approvedAt: '2026-01-02T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' };
let srv;
let employer;
let admin;
before(async () => {
  srv = await startServer({}, { employers: [EMP] });
  employer = srv.cookieFrom(await srv.request('/employer/login', { method: 'POST', form: { email: EMP.email, password: 'pia long password 1' } }));
  await srv.verifyEmployerMobile(employer);
  admin = await srv.adminLogin();
});
after(() => srv && srv.stop());
const json = (url, body, cookie) => srv.request(url, { method: 'POST', cookie, body: JSON.stringify(body), headers: { 'content-type': 'application/json', accept: 'application/json' } });
const POST = 'Need 3 warehouse pickers in Pune. Salary 14k-16k. Freshers. Day shift. PF and free food.';

test('employers read a post through the API; signed out, empty and other sites are refused', async () => {
  const r = await json('/api/employers/jobs/parse', { text: POST }, employer);
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.ok, true);
  assert.equal(d.fields.title, 'Warehouse Picker');
  assert.equal(d.fields.location, 'Pune');
  assert.equal(d.fields.openings, '3');
  assert.equal(d.fields.category, 'Logistics & Operations');
  assert.deepEqual(d.checks.perks, ['food', 'pf']);
  assert.equal((await json('/api/employers/jobs/parse', { text: POST })).status, 401);
  const empty = await json('/api/employers/jobs/parse', { text: '  ' }, employer);
  assert.equal(empty.status, 400);
  assert.deepEqual((await empty.json()).errors, ['paste the job post first']);
  assert.equal((await json('/api/employers/jobs/parse', { text: 'x'.repeat(8001) }, employer)).status, 400);
  const cross = await srv.request('/api/employers/jobs/parse', { method: 'POST', cookie: employer, body: JSON.stringify({ text: POST }), headers: { 'content-type': 'application/json', origin: 'https://evil.example' } });
  assert.equal(cross.status, 403);
  assert.equal(srv.records('jobs').filter((j) => j.employerId === EMP.id).length, 0, 'nothing saved');
});

test('the admin team reads a post too; others get no answer', async () => {
  const r = await json('/admin/jobs/parse', { text: POST }, admin);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).fields.salaryMax, '16000');
  assert.equal((await json('/admin/jobs/parse', { text: POST })).status, 401);
  assert.equal((await json('/admin/jobs/parse', { text: POST }, employer)).status, 401);
});

test('the new-job forms show the panel and its script; editing a job does not', async () => {
  const emp = await (await srv.request('/employer/jobs/new', { cookie: employer })).text();
  assert.match(emp, /<details class="form-card job-paste" data-job-paste data-endpoint="\/api\/employers\/jobs\/parse">/);
  assert.match(emp, /<script src="\/js\/job-paste\.js\?v=[^"]+" defer><\/script>/);
  const adm = await (await srv.request('/admin/jobs/new', { cookie: admin })).text();
  assert.match(adm, /data-job-paste data-endpoint="\/admin\/jobs\/parse"/);
  assert.match(adm, /\/js\/job-paste\.js/);
  const js = await srv.request('/js/job-paste.js');
  assert.equal(js.status, 200);
  const saved = await srv.request('/employer/jobs', { method: 'POST', cookie: employer, form: { title: 'Picker', category: 'Logistics & Operations', location: 'Pune', mode: 'On-site', type: 'Full-time', description: 'Pick and pack orders in the warehouse with the team.', responsibilities: 'Pick orders', salaryMin: '14000', salaryMax: '16000', salaryPeriod: 'month', action: 'save' } });
  assert.equal(saved.status, 302);
  const id = srv.records('jobs').find((j) => j.employerId === EMP.id).id;
  const edit = await (await srv.request(`/employer/jobs/${id}/edit`, { cookie: employer })).text();
  assert.doesNotMatch(edit, /data-job-paste|job-paste\.js/);
});
