// Reading older resumes takes a while; changes made meanwhile must survive.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, resumeForm } = require('./helpers');

const old = Array.from({ length: 300 }, (_, i) => ({
  id: `old-${i}`, name: `Old ${i}`, email: `old${i}@x.in`, phone: '9876543210', jobId: 'hr-101', jobTitle: 'Dev', status: 'New',
  createdAt: new Date(Date.now() - (i + 1) * 3600000).toISOString(), resume: `old-${i}.pdf`,
}));

let srv;
let admin;
before(async () => {
  srv = await startServer({}, { applications: old });
  for (const a of old) fs.writeFileSync(path.join(srv.paths.uploads, a.resume), '%PDF-1.4 not really a pdf');
  admin = await srv.adminLogin();
});
after(() => srv && srv.stop());

test('an application that arrives during a resume reindex is kept', async () => {
  const reindex = srv.request('/admin/resumes/reindex', { method: 'POST', cookie: admin, form: {} });
  await new Promise((r) => setTimeout(r, 30));
  const apply = await srv.request('/api/apply', { method: 'POST', body: resumeForm({ jobId: 'hr-101', name: 'New Person', email: 'new@x.in', phone: '9876543210' }), headers: { accept: 'application/json' } });
  assert.equal(apply.status, 200);
  assert.equal((await reindex).status, 302);

  const list = srv.records('applications');
  assert.ok(list.some((a) => a.email === 'new@x.in'), 'new application survived');
  assert.equal(list.length, 301);
  assert.ok(list.filter((a) => a.id.startsWith('old-')).every((a) => a.resumeText !== undefined), 'old resumes were processed');
});
