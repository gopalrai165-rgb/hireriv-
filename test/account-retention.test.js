// Job seeker accounts are never deleted just for being quiet: only with data
// retention turned on, and only when unused for the whole retention period.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { startServer } = require('./helpers');

const site = require(path.join(__dirname, '..', 'data', 'site.json'));
const old = '2025-01-01T00:00:00.000Z';
const account = (id, at) => ({ id, email: `${id}@example.in`, createdAt: at, updatedAt: at, emailVerifiedAt: at, resumes: [], defaultResumeId: null, privacy: { visibleToRecruiters: true, discoverable: true, shareContact: false }, profile: { name: id, skills: [], preferences: { roles: 'driver' } } });
const recent = new Date(Date.now() - 5 * 86400000).toISOString();

test('without data retention, an old account with no applications is kept', async () => {
  const srv = await startServer({}, { candidates: [account('waiting', old)] });
  try {
    assert.deepEqual(srv.records('candidates').map((c) => c.id), ['waiting'], 'a job seeker still waiting for the right job keeps their account');
  } finally { srv.stop(); }
});

test('with retention on, only accounts with no applications and unused for the whole period go', async () => {
  const srv = await startServer({}, {
    site: [{ ...site, retentionMonths: 12 }],
    candidates: [account('unused', old), account('active', recent), account('applied', old)],
    applications: [{ id: 'a1', jobId: 'hr-101', jobTitle: 'Driver', email: 'applied@example.in', name: 'A', createdAt: recent, status: 'New' }],
  });
  try {
    assert.deepEqual(srv.records('candidates').map((c) => c.id).sort(), ['active', 'applied']);
  } finally { srv.stop(); }
});
