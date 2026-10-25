// Quick applications for skilled and field jobs: name and phone are enough,
// "Apply on WhatsApp", people matched by phone, and the team adding candidates
// who applied by WhatsApp, phone call or walk-in.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, resumeForm } = require('./helpers');
const { candidatesDue } = require('../retention');
const { buildPool } = require('../match');

let srv;
let admin;
before(async () => {
  // Each test application comes from its own address, so the per-IP limit on
  // the apply form (6 per 10 minutes) doesn't get in the way.
  srv = await startServer({ TRUST_PROXY: '1' });
  admin = await srv.adminLogin();
});
after(() => srv && srv.stop());

const form = (fields) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
};
let ip = 0;
const apply = async (fields, withResume = false) => {
  ip++;
  const headers = { accept: 'application/json', 'x-forwarded-for': `10.0.0.${ip}` };
  const res = await srv.request('/api/apply', { method: 'POST', body: withResume ? resumeForm(fields) : form(fields), headers });
  return { status: res.status, body: await res.json() };
};
const byName = (name) => srv.records('applications').filter((a) => a.name === name);

test('office jobs still need a resume and an email', async () => {
  const r = await apply({ jobId: 'hr-101', name: 'Asha Rao', phone: '9811111111' });
  assert.equal(r.status, 400);
  assert.deepEqual(r.body.errors, ['email is required', 'resume is required']);
});

test('field jobs: name and phone are enough, and the recruiter will call', async () => {
  const html = await (await srv.request('/jobs/hr-114')).text();
  assert.match(html, /No resume or email needed/);
  assert.doesNotMatch(html, /name="resume"[^>]*required/);
  assert.doesNotMatch(html, /Or apply on WhatsApp/); // WhatsApp number is still the placeholder

  const r = await apply({ jobId: 'hr-114', name: 'Ravi Kumar', phone: '+91 98765 43210' });
  assert.equal(r.status, 200);
  assert.match(r.body.message, /call you on \+91 98765 43210/);
  const [a] = byName('Ravi Kumar');
  assert.equal(a.email, '');
  assert.equal(a.resume, '');
  const mail = await srv.waitForEmail((e) => e.includes('New application for') && e.includes('Ravi Kumar'));
  assert.match(mail, /Not given: call or WhatsApp them/);

  // Same person, number written differently: updated, not added twice.
  const again = await apply({ jobId: 'hr-114', name: 'Ravi Kumar', phone: '098765 43210', location: 'Whitefield' });
  assert.match(again.body.message, /already applied for this job/);
  assert.equal(byName('Ravi Kumar').length, 1);
  assert.equal(byName('Ravi Kumar')[0].location, 'Whitefield');
  // A different person for the same job is a new application.
  await apply({ jobId: 'hr-114', name: 'Sunil Das', phone: '9000012345' });
  assert.equal(byName('Sunil Das').length, 1);
  // A resume is still welcome, and gets read.
  assert.equal((await apply({ jobId: 'hr-117', name: 'Imran Ali', phone: '9000099999', email: 'imran@example.in' }, true)).status, 200);
  assert.ok(byName('Imran Ali')[0].resume);
});

test('the job form can switch quick apply on or off for one job', async () => {
  const job = {
    title: 'Driver (LMV)', company: 'Logistics firm', location: 'Pune', mode: 'Field work', type: 'Full-time', category: 'Delivery & Driving',
    experience: '', salary: '', skills: 'Driving', description: 'Drive a light commercial vehicle.', responsibilities: '', status: 'open', resume: 'required',
  };
  await srv.request('/admin/jobs', { method: 'POST', cookie: admin, form: job });
  const id = srv.records('jobs').find((j) => j.title === 'Driver (LMV)').id;
  assert.deepEqual((await apply({ jobId: id, name: 'Test', phone: '9000000001' })).body.errors, ['email is required', 'resume is required']);

  await srv.request('/admin/jobs/hr-101', { method: 'POST', cookie: admin, form: { ...job, title: 'Full-Stack Developer (MERN)', category: 'Technology', resume: 'optional' } });
  assert.equal((await apply({ jobId: 'hr-101', name: 'Quick Coder', phone: '9000000002' })).status, 200);
});

test('Apply on WhatsApp appears once a real number is in Settings', async () => {
  const settings = {
    tagline: 'Hiring', phone: '+91 98765 43210', whatsapp: '919812345678', email: 'hello@hireriv.com', address: 'Kolkata', hours: '9-6',
    stat_value_0: '10', stat_label_0: 'Hires', jobCategories: 'Technology\nDelivery & Driving', jobLocations: 'Bengaluru\nPune',
    billing_feePercent: '8.33', billing_guaranteeDays: '90', billing_gstPercent: '18', billing_paymentDays: '15', billing_tdsPercent: '10',
  };
  assert.equal((await srv.request('/admin/settings', { method: 'POST', cookie: admin, form: settings })).status, 302);
  const html = await (await srv.request('/jobs/hr-114')).text();
  assert.match(html, /href="https:\/\/wa\.me\/919812345678\?text=Hi%20Hireriv%2C%20I%20want%20to%20apply%20for%20Delivery%20Executive/);
  assert.doesNotMatch(await (await srv.request('/jobs/hr-102')).text(), /Or apply on WhatsApp/); // office job
});

test('the team adds someone who applied on WhatsApp', async () => {
  assert.equal((await srv.request('/admin/applications/new', { cookie: admin })).status, 200);
  const add = (fields) => srv.request('/admin/applications/new', { method: 'POST', cookie: admin, body: form(fields) });

  assert.equal((await add({ jobId: 'hr-117', name: 'Mohan Lal', phone: '', source: 'whatsapp-chat' })).status, 400);
  assert.equal((await add({ jobId: 'hr-117', name: 'Mohan Lal', phone: '9123412345', source: 'carrier-pigeon' })).status, 400);
  const res = await add({ jobId: 'hr-117', name: 'Mohan Lal', phone: '9123412345', source: 'whatsapp-chat', location: 'Kukatpally', notes: 'Ex-army, has own uniform' });
  assert.equal(res.status, 302);
  assert.match(decodeURIComponent(res.headers.get('location')), /Added Mohan Lal for Security Guard/);
  const [a] = byName('Mohan Lal');
  assert.equal(a.source, 'whatsapp-chat');
  assert.equal(a.addedVia, 'WhatsApp message');
  assert.equal(a.notes, 'Ex-army, has own uniform');
  assert.equal(srv.emails().filter((e) => e.includes('Mohan Lal')).length, 0); // nobody is emailed

  const page = await (await srv.request('/admin?tab=applications', { cookie: admin })).text();
  assert.match(page, /Added for Security Guard \(WhatsApp message\)/);
  assert.match(page, /No email \(contact by phone\)/);
  assert.match(page, /href="https:\/\/wa\.me\/919123412345"/);

  // Adding the same person again updates them and keeps both notes.
  const again = await add({ jobId: 'hr-117', name: 'Mohan Lal', phone: '+91 91234 12345', source: 'phone-call', notes: 'Called back, can start Monday' });
  assert.match(decodeURIComponent(again.headers.get('location')), /had already applied/);
  assert.equal(byName('Mohan Lal').length, 1);
  assert.equal(byName('Mohan Lal')[0].notes, 'Ex-army, has own uniform\nCalled back, can start Monday');
});

test('talent pool and data retention tell phone-only people apart', () => {
  const apps = [
    { id: 'a1', name: 'Ravi', email: '', phone: '+91 98765 43210', jobTitle: 'Driver', createdAt: '2023-01-01T00:00:00.000Z' },
    { id: 'a2', name: 'Ravi', email: '', phone: '09876543210', jobTitle: 'Picker', createdAt: '2023-02-01T00:00:00.000Z' },
    { id: 'a3', name: 'Sunil', email: '', phone: '9000012345', jobTitle: 'Driver', createdAt: '2026-10-01T00:00:00.000Z' },
    { id: 'a4', name: 'Kiran', email: '', phone: '9000055555', jobTitle: 'Guard', createdAt: '2023-01-01T00:00:00.000Z' },
  ];
  const pool = buildPool(apps);
  assert.equal(pool.length, 3);
  assert.equal(pool.find((c) => c.name === 'Ravi').applicationCount, 2);

  const due = candidatesDue(apps, [{ appId: 'a4', status: 'Joined' }], { months: 12, now: new Date('2026-10-24') });
  assert.deepEqual(due.map((c) => c.appIds), [['a1', 'a2']]); // Sunil is recent, Kiran has an active placement
});
