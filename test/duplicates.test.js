// Applying twice for the same job updates the first application.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, resumeForm, decodeEmail } = require('./helpers');

const base = { jobId: 'hr-101', name: 'Priya Sharma', email: 'priya@example.in', phone: '9876543210', skills: 'React' };
let srv;
before(async () => { srv = await startServer(); });
after(() => srv && srv.stop());

const apply = async (fields) => {
  const res = await srv.request('/api/apply', { method: 'POST', body: resumeForm(fields), headers: { accept: 'application/json' } });
  return { status: res.status, body: await res.json() };
};
const mine = () => srv.records('applications').filter((a) => a.email.toLowerCase() === 'priya@example.in');

test('applying again for the same job updates the existing application', async () => {
  await apply(base);
  const [first] = mine();
  const admin = await srv.adminLogin();
  await srv.request(`/admin/applications/${first.id}/status`, { method: 'POST', cookie: admin, form: { status: 'Screening' } });

  const again = await apply({ ...base, email: 'Priya@Example.in', phone: '9123456780', skills: 'React, Node.js' });
  assert.equal(again.status, 200);
  assert.match(again.body.message, /already applied for this job, so we've updated your application/);

  const list = mine();
  assert.equal(list.length, 1);
  const a = list[0];
  assert.equal(a.id, first.id);
  assert.equal(a.phone, '9123456780');
  assert.equal(a.skills, 'React, Node.js');
  assert.notEqual(a.resume, first.resume);
  assert.equal(a.reapplied.length, 1);
  assert.equal(fs.existsSync(path.join(srv.paths.uploads, first.resume)), false);
  assert.equal(fs.existsSync(path.join(srv.paths.uploads, a.resume)), true);
  await srv.waitForEmail((e) => e.includes('Updated application for') && decodeEmail(e).includes('Priya Sharma'));
});

test('a different job, or coming back after withdrawing, is a new application', async () => {
  await apply({ ...base, jobId: 'hr-102' });
  assert.equal(mine().length, 2);

  const list = srv.records('applications');
  const db = require('../db').open(srv.paths.db);
  db.replaceAll('applications', list.map((a) => (a.jobId === 'hr-101' ? { ...a, withdrawnAt: new Date().toISOString() } : a)));
  db.close();
  await apply(base);
  assert.equal(mine().length, 3);
});
