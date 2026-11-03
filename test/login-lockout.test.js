// Password guessing spread over many connections: employer and team sign-in
// lock the account after 10 wrong passwords in 15 minutes, whatever the address.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, ADMIN_PASS } = require('./helpers');
const { hashPassword } = require('../employers');

const EMP = { id: 'emp-old', company: 'Old Co', name: 'Olga Rao', email: 'olga@oldco.in', passwordHash: hashPassword('olga long password'), passwordSetAt: '2026-01-01T00:00:00.000Z', active: true, createdAt: '2026-01-01T00:00:00.000Z' };
const OTHER = { ...EMP, id: 'emp-two', company: 'Two Co', name: 'Tara', email: 'tara@two.in' };
let srv;
before(async () => { srv = await startServer({ TRUST_PROXY: '1' }, { employers: [EMP, OTHER] }); });
after(() => srv && srv.stop());
let n = 0;
const from = () => ({ 'x-forwarded-for': `203.0.113.${++n}` });
const empLogin = (email, password) => srv.request('/employer/login', { method: 'POST', headers: from(), form: { email, password } });
const teamLogin = (login, password) => srv.request('/admin/login', { method: 'POST', headers: from(), form: { login, password, next: '/admin' } });

test('employer: 10 wrong passwords from different addresses lock that account only', async () => {
  for (let i = 0; i < 10; i++) assert.equal((await empLogin('olga@oldco.in', `wrong guess ${i}`)).status, 401);
  const locked = await empLogin('olga@oldco.in', 'olga long password');
  assert.equal(locked.status, 429, 'even the right password waits');
  assert.match(await locked.text(), /Too many wrong passwords for this account/);
  assert.equal((await empLogin('OLGA@oldco.in', 'olga long password')).status, 429, 'the same account in capitals');
  const ok = await empLogin('tara@two.in', 'olga long password');
  assert.equal(ok.status, 302, 'other accounts are not affected');
});

test('team sign-in: the same lock per sign-in name', async () => {
  for (let i = 0; i < 10; i++) assert.equal((await teamLogin('admin', `wrong guess ${i}`)).status, 401);
  assert.equal((await teamLogin('admin', ADMIN_PASS)).status, 429);
  assert.equal((await teamLogin('someone@else.in', 'whatever long')).status, 401, 'other names still get the normal answer');
});

test('a tampered sales unsubscribe link is refused, not a server error', async () => {
  const res = await srv.request(`/crm/unsubscribe/lead-1.${'é'.repeat(32)}`, { method: 'POST', headers: from(), form: {} });
  assert.equal(res.status, 404);
});

test('a cross-site CSV upload is refused before the file is read', async () => {
  const fd = new FormData();
  fd.append('file', new Blob(['title\nPacker\n']), 'jobs.csv');
  const cookie = srv.cookieFrom(await empLogin('tara@two.in', 'olga long password'));
  const res = await srv.request('/employer/jobs/import', { method: 'POST', cookie, headers: { ...from(), origin: 'https://evil.example' }, body: fd });
  assert.equal(res.status, 403);
});
