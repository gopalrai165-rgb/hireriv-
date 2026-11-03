// Moving several applicants to one stage at once from the applicants list.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');
const { hashPassword } = require('../employers');
const starter = require('./fixtures/jobs.json');

const EMP = { id: 'emp-old', company: 'Old Co', name: 'Olga Rao', email: 'olga@oldco.in', passwordHash: hashPassword('olga long password'), passwordSetAt: '2026-01-01T00:00:00.000Z', active: true, createdAt: '2026-01-01T00:00:00.000Z' };
const JOB = { ...starter[0], id: 'hr-900', company: 'Old Co', employerId: 'emp-old', createdBy: 'employer', status: 'open', sample: false };
const OTHER = { ...starter[1], id: 'hr-901', company: 'Else Ltd', employerId: 'emp-else', createdBy: 'employer', status: 'open', sample: false };
const app = (id, name, extra = {}) => ({ id, jobId: 'hr-900', jobTitle: JOB.title, email: `${id}@example.in`, name, phone: '9811100001', createdAt: '2026-11-01T05:00:00.000Z', status: 'New', ...extra });
let srv; let employer;
before(async () => {
  srv = await startServer({}, {
    employers: [EMP, { ...EMP, id: 'emp-else', company: 'Else Ltd', email: 'e@else.in' }], jobs: [JOB, OTHER],
    applications: [app('a1', 'Asha Rao'), app('a2', 'Ravi Kumar'), app('a3', 'Meena Shah', { withdrawnAt: '2026-11-02T00:00:00.000Z' }), app('a4', 'Dev Patel', { status: 'Hired' }), { ...app('x1', 'Not Mine'), jobId: 'hr-901', jobTitle: OTHER.title }],
  });
  employer = srv.cookieFrom(await srv.request('/employer/login', { method: 'POST', form: { email: 'olga@oldco.in', password: 'olga long password' } }));
});
after(() => srv && srv.stop());
const status = (id) => srv.records('applications').find((x) => x.id === id).status;
const bulk = (form, cookie = employer) => srv.request('/employer/applicants/bulk', { method: 'POST', cookie, form });

test('the list has tick boxes for applicants this member can move, and a stage to move them to', async () => {
  const html = await (await srv.request('/employer/applicants', { cookie: employer })).text();
  assert.match(html, /action="\/employer\/applicants\/bulk"/);
  assert.match(html, /name="ids" value="a1" aria-label="Select Asha Rao"/);
  assert.doesNotMatch(html, /name="ids" value="a3"/, 'not a withdrawn application');
  assert.match(html, /Move selected to…/);
});

test('ticked applicants move together; withdrawn, not allowed and other companies\' are skipped', async () => {
  const res = await bulk([['ids', 'a1'], ['ids', 'a2'], ['ids', 'a3'], ['ids', 'x1'], ['status', 'Shortlisted'], ['back_job', 'hr-900']]);
  assert.equal(res.status, 303);
  const msg = decodeURIComponent(res.headers.get('location'));
  assert.match(msg, /^\/employer\/applicants\?job=hr-900&msg=/, 'back to the same filters');
  assert.match(msg, /2 applicants moved to Shortlisted\. 2 not moved/);
  assert.match(msg, /withdrew/);
  assert.equal(status('a1'), 'Shortlisted');
  assert.equal(status('a2'), 'Shortlisted');
  assert.equal(status('x1'), 'New', 'another company\'s applicant is untouched');
  const h = srv.records('applications').find((x) => x.id === 'a1').history || [];
  assert.ok(h.some((e) => e.to === 'Shortlisted'), 'recorded in the history like a single move');
});

test('nothing ticked, an unknown stage, a cross-site post or no sign-in change nothing', async () => {
  assert.match(decodeURIComponent((await bulk({ status: 'Shortlisted' })).headers.get('location')), /Tick the applicants to move first/);
  assert.match(decodeURIComponent((await bulk({ ids: 'a1', status: 'Promoted' })).headers.get('location')), /Choose the stage/);
  const cross = await srv.request('/employer/applicants/bulk', { method: 'POST', cookie: employer, headers: { origin: 'https://evil.example' }, form: { ids: 'a1', status: 'Rejected' } });
  assert.equal(cross.status, 403);
  await bulk({ ids: 'a1', status: 'Rejected' }, '');
  assert.equal(status('a1'), 'Shortlisted');
});
