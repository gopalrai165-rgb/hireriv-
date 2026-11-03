// "Send all drafts for review": every draft goes through the usual checks;
// the ones a limit or a gap stops stay drafts, with the reason.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');
const { hashPassword } = require('../employers');
const starter = require('./fixtures/jobs.json');

const EMP = { id: 'emp-old', company: 'Old Co', name: 'Olga Rao', email: 'olga@oldco.in', passwordHash: hashPassword('olga long password'), passwordSetAt: '2026-01-01T00:00:00.000Z', active: true, createdAt: '2026-01-01T00:00:00.000Z' };
const draft = (id, extra = {}) => ({ ...starter[0], id, title: `Draft ${id}`, company: 'Old Co', employerId: 'emp-old', createdBy: 'employer', status: 'draft', sample: false, responsibilities: ['Do the work'], salary: '', pay: { min: 15000, max: 18000, period: 'month', currency: 'INR' }, ...extra });
let srv; let employer;
before(async () => {
  srv = await startServer({}, { employers: [EMP], jobs: [draft('hr-901'), draft('hr-902'), draft('hr-903', { responsibilities: [] })] });
  employer = srv.cookieFrom(await srv.request('/employer/login', { method: 'POST', form: { email: 'olga@oldco.in', password: 'olga long password' } }));
});
after(() => srv && srv.stop());
const statusOf = (id) => srv.records('jobs').find((j) => j.id === id).status;

test('the Jobs list offers to send every draft', async () => {
  const html = await (await srv.request('/employer/jobs', { cookie: employer })).text();
  assert.match(html, /action="\/employer\/jobs\/submit-drafts"/);
  assert.match(html, /Send all 3 drafts for review/);
});

test('ready drafts are sent; one with a gap stays a draft and the reason is given', async () => {
  const cross = await srv.request('/employer/jobs/submit-drafts', { method: 'POST', cookie: employer, headers: { origin: 'https://evil.example' }, form: {} });
  assert.equal(cross.status, 403);
  const res = await srv.request('/employer/jobs/submit-drafts', { method: 'POST', cookie: employer, form: {} });
  const msg = decodeURIComponent(res.headers.get('location'));
  assert.match(msg, /2 drafts sent to the Hireriv team for review\. 1 still a draft: "Draft hr-903": before sending this job for review, add the main responsibilities/);
  assert.equal(statusOf('hr-901'), 'pending');
  assert.equal(statusOf('hr-902'), 'pending');
  assert.equal(statusOf('hr-903'), 'draft');
  assert.match(decodeURIComponent((await srv.request('/employer/jobs/submit-drafts', { method: 'POST', cookie: employer, form: {} })).headers.get('location')), /1 still a draft/);
  const out = await srv.request('/employer/jobs/submit-drafts', { method: 'POST', form: {} });
  assert.match(String(out.headers.get('location')), /\/employer\/login/, 'signed out goes to sign-in');
  assert.equal(statusOf('hr-903'), 'draft');
});
