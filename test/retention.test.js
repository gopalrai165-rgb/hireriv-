// Data retention end to end: off by default, previewed in Settings, and when
// switched on it deletes only what it should.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer } = require('./helpers');

const OLD = '2023-01-10T10:00:00.000Z';
const RECENT = new Date(Date.now() - 30 * 86400000).toISOString();
const SOON = new Date(Date.now() + 3 * 86400000).toISOString();
const app = (id, email, createdAt, extra = {}) => ({ id, email, name: email.split('@')[0], phone: '9876543210', jobId: 'hr-101', jobTitle: 'Dev', status: 'New', createdAt, resume: `${id}.pdf`, ...extra });

const seed = {
  applications: [
    app('a1', 'gone@x.in', OLD),
    app('a2', 'recent@x.in', RECENT),
    app('a3', 'placed@x.in', OLD),
    app('a4', 'interview@x.in', OLD, { interviews: [{ id: 'iv1', status: 'scheduled', at: SOON, createdAt: OLD, mode: 'Video' }] }),
  ],
  placements: [{ id: 'p1', appId: 'a3', candidateName: 'placed', candidateEmail: 'placed@x.in', status: 'Joined', company: 'Acme', joiningDate: '2023-02-01', feeMode: 'percent', fee: 1000, guaranteeDays: 90, type: 'Permanent' }],
  contacts: [{ id: 'c1', name: 'Old', email: 'o@x.in', message: 'hi', createdAt: OLD }, { id: 'c2', name: 'New', email: 'n@x.in', message: 'hi', createdAt: RECENT }],
  'hire-requests': [{ id: 'h1', company: 'Old Co', roles: 'Dev', createdAt: OLD }],
  'job-alerts': [{ id: 'j1', email: 'u@x.in', confirmed: false, createdAt: OLD }, { id: 'j2', email: 'c@x.in', confirmed: true, createdAt: OLD }],
};

let srv;
let admin;
before(async () => {
  srv = await startServer({}, seed);
  for (const a of seed.applications) fs.writeFileSync(path.join(srv.paths.uploads, a.resume), 'resume');
  admin = await srv.adminLogin();
});
after(() => srv && srv.stop());

const settingsForm = (retentionMonths) => ({
  tagline: 'Hiring', phone: '+91 98765 43210', whatsapp: '919876543210', email: 'hello@hireriv.com', address: 'Kolkata', hours: '9-6',
  stat_value_0: '10', stat_label_0: 'Hires', jobCategories: 'Technology', jobLocations: 'Bengaluru',
  billing_feePercent: '8.33', billing_guaranteeDays: '90', billing_gstPercent: '18', billing_paymentDays: '15', billing_tdsPercent: '10',
  retentionMonths: String(retentionMonths),
});

test('nothing is deleted while retention is off', () => {
  assert.equal(srv.records('applications').length, 4);
  assert.equal(srv.records('job-alerts').length, 2);
});

test('settings preview what each period would delete', async () => {
  const html = await (await srv.request('/admin?tab=settings', { cookie: admin })).text();
  assert.match(html, /24 months without activity · would delete 1 candidate now/);
});

test('turning it on deletes only inactive, unprotected data', async () => {
  const res = await srv.request('/admin/settings', { method: 'POST', cookie: admin, form: settingsForm(24) });
  assert.equal(res.status, 302);
  assert.match(decodeURIComponent(res.headers.get('location')), /removed 1 candidate, 1 message and 1 hiring request/);

  assert.deepEqual(srv.records('applications').map((a) => a.email).sort(), ['interview@x.in', 'placed@x.in', 'recent@x.in']);
  assert.equal(fs.existsSync(path.join(srv.paths.uploads, 'a1.pdf')), false);
  assert.equal(fs.existsSync(path.join(srv.paths.uploads, 'a2.pdf')), true);
  assert.equal(srv.records('placements').length, 1);
  assert.deepEqual(srv.records('contacts').map((c) => c.id), ['c2']);
  assert.equal(srv.records('hire-requests').length, 0);
  assert.deepEqual(srv.records('job-alerts').map((s) => s.id), ['j2']);

  const log = srv.records('activity').map((e) => e.action);
  assert.ok(log.includes('Turned on data retention: 24 months'));
  assert.ok(log.includes('Data retention clean-up'));
});

test('the privacy policy states the period', async () => {
  const html = await (await srv.request('/privacy')).text();
  assert.match(html, /automatically 24 months after your last activity/);
});
