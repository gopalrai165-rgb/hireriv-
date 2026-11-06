// Step 202: saved candidates. A list the company shares, from Find candidates.
// Only people who still choose to be found show, with no more detail than the
// search, and the saves go with the candidate's account.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, decodeEmail } = require('./helpers');
const { hashPassword } = require('../employers');

const iso = (ago = 0) => new Date(Date.now() - ago * 864e5).toISOString();
const person = (id, email, name) => ({ id, email, name, phone: '9800000001', passwordHash: hashPassword(`${name} long password`), emailVerifiedAt: iso(1), phoneVerifiedAt: iso(1), createdAt: iso(1), active: true, link: null });
const company = (id, name, extra = {}) => ({ id, company: name, name, email: `o@${id}.in`, active: true, approvedAt: iso(1), verification: { status: 'verified' }, verificationStatus: 'verified', createdAt: iso(30), ...extra });
const member = (id, employerId, userId, role) => ({ id, employerId, userId, role, jobIds: [], createdAt: iso(1) });
const cand = (id, email, name, headline, extra = {}) => ({ id, email, emailVerifiedAt: iso(5), privacy: { discoverable: true }, profile: { name, headline, skills: ['Packing'], experiences: [], updatedAt: iso(1) }, resumes: [], createdAt: iso(10), ...extra });

let srv;
let ann;
let rob;
let vic;
let bob;
let ip = 0;
const h = () => ({ 'x-forwarded-for': `10.202.${Math.floor(++ip / 250)}.${(ip % 250) + 1}` });
const get = (url, cookie) => srv.request(url, { cookie, headers: h() });
const post = (url, form, cookie) => srv.request(url, { method: 'POST', form, cookie, headers: h() });
const saves = () => srv.records('candidate-saves');
const text = async (url, cookie) => (await get(url, cookie)).text();
const where = (r) => decodeURIComponent((r.headers.get('location') || '').replace(/\+/g, ' '));

before(async () => {
  srv = await startServer({ TRUST_PROXY: '1' }, {
    employers: [company('emp-a', 'A Co'), company('emp-b', 'B Co')],
    'employer-users': [person('u-ann', 'ann@aco.in', 'Ann'), person('u-rob', 'rob@aco.in', 'Rob'), person('u-vic', 'vic@aco.in', 'Vic'), person('u-bob', 'bob@bco.in', 'Bob')],
    'employer-members': [member('m1', 'emp-a', 'u-ann', 'owner'), member('m2', 'emp-a', 'u-rob', 'recruiter'), member('m3', 'emp-a', 'u-vic', 'viewer'), member('m4', 'emp-b', 'u-bob', 'owner')],
    candidates: [cand('c-1', 'one@example.in', 'Asha Rao', 'Packing lead'), cand('c-2', 'two@example.in', 'Bala Iyer', 'Store helper'), cand('c-3', 'three@example.in', 'Chitra Sen', 'Hidden person', { privacy: { discoverable: false } })],
  });
  const login = async (email, name) => srv.cookieFrom(await post('/employer/login', { email, password: `${name} long password` }));
  ann = await login('ann@aco.in', 'Ann');
  rob = await login('rob@aco.in', 'Rob');
  vic = await login('vic@aco.in', 'Vic');
  bob = await login('bob@bco.in', 'Bob');
}, { timeout: 60000 });
after(() => srv && srv.stop());

test('save from the search; the whole company sees the list; the search is kept', async () => {
  const page = await text('/employer/candidates', ann);
  assert.match(page, /Saved \(0\)/);
  assert.match(page, /action="\/employer\/candidates\/c-1\/save"/);
  assert.match(await text('/employer/candidates?saved=1', ann), /Nobody saved yet/);

  const r = await post('/employer/candidates/c-1/save', { saved: '1', back: 'q=packing&skills=Packing&evil=1' }, ann);
  assert.equal(r.status, 303);
  assert.match(where(r), /^\/employer\/candidates\?q=packing&skills=Packing&msg=Saved/);
  assert.doesNotMatch(where(r), /evil/);
  assert.match(where(r), /#cand-c-1$/);
  assert.deepEqual(saves().map((s) => [s.employerId, s.candidateId, s.savedBy]), [['emp-a', 'c-1', 'u-ann']]);

  const list = await text('/employer/candidates?saved=1', rob);
  assert.match(list, /Saved \(1\)/);
  assert.match(list, /Packing lead/);
  assert.doesNotMatch(list, /Store helper/);
  assert.match(list, /Saved: remove/);
  assert.match(await text('/employer/candidates?saved=1&q=nothingmatches', rob), /No candidates match/);
  await post('/employer/candidates/c-1/save', { saved: '1' }, rob);
  assert.equal(saves().length, 1, 'saving twice keeps one');
});

test('the list shows no more than the search: no surname, email or phone', async () => {
  const list = await text('/employer/candidates?saved=1', ann);
  assert.match(list, /Asha R\./);
  assert.doesNotMatch(list, /Asha Rao|one@example\.in/);
  const log = srv.records('employer-audit').filter((e) => /candidate-saved/.test(e.event));
  assert.ok(log.length);
  assert.doesNotMatch(JSON.stringify(log), /Asha|c-1/, 'the log does not say who');
});

test('other companies, other roles and hidden people', async () => {
  assert.match(await text('/employer/candidates?saved=1', bob), /Saved \(0\)/);
  assert.doesNotMatch(await text('/employer/candidates?saved=1', bob), /Packing lead/);
  assert.equal((await post('/employer/candidates/c-2/save', { saved: '1' }, vic)).status, 403);
  assert.match(where(await post('/employer/candidates/c-3/save', { saved: '1' }, ann)), /not available/);
  assert.match(where(await post('/employer/candidates/nobody/save', { saved: '1' }, ann)), /not available/);
  assert.equal((await srv.request('/employer/candidates/c-2/save', { method: 'POST', form: { saved: '1' }, cookie: ann, headers: { ...h(), origin: 'https://evil.example' } })).status, 403);
  assert.equal(saves().length, 1);
});

test('JSON: the card says saved; saving and removing', async () => {
  const call = (id, body) => srv.request(`/api/employers/candidates/${id}/save`, { method: 'POST', cookie: ann, body: JSON.stringify(body), headers: { ...h(), 'content-type': 'application/json', accept: 'application/json' } });
  const r = await call('c-2', {});
  assert.equal(r.status, 201);
  const found = JSON.parse(await (await srv.request('/api/employers/candidates?saved=1', { cookie: ann, headers: { ...h(), accept: 'application/json' } })).text());
  assert.deepEqual(found.candidates.map((c) => [c.id, c.saved]).sort(), [['c-1', true], ['c-2', true]]);
  assert.equal((await call('c-2', { saved: false })).status, 200);
  assert.equal(saves().length, 1);
  assert.equal((await call('c-3', {})).status, 404);
});

test('someone who stops sharing leaves the list, comes back if they return, and can be removed; the download names the company; deleting the account removes the save', async () => {
  const email = 'dev@example.in';
  const fd = new FormData();
  for (const [k, v] of Object.entries({ name: 'Dev Shah', email, phone: '9845012377', location: 'Pune', agree: '1' })) fd.append(k, v);
  await srv.request('/account/register', { method: 'POST', body: fd, headers: h() });
  await srv.waitForEmail((m) => m.includes(`To: ${email}`) && decodeEmail(m).includes('/account/verify/'));
  const mail = decodeEmail(srv.emails().filter((m) => m.includes(`To: ${email}`)).pop());
  const dev = srv.cookieFrom(await srv.request(mail.match(/\/account\/verify\/[a-f0-9]{64}/)[0], { method: 'POST', form: {}, headers: h() }));
  const patch = (body) => srv.request('/api/candidate/profile', { method: 'PATCH', cookie: dev, body: JSON.stringify(body), headers: { ...h(), 'content-type': 'application/json', accept: 'application/json' } });
  assert.equal((await patch({ headline: 'Forklift driver', skills: ['Forklift'], privacy: { discoverable: true } })).status, 200);
  const id = srv.records('candidates').find((c) => c.email === email).id;

  assert.equal((await post(`/employer/candidates/${id}/save`, { saved: '1' }, ann)).status, 303);
  assert.match(await text('/employer/candidates?saved=1', ann), /Forklift driver/);
  const data = JSON.parse(await text('/account/my-data.json', dev));
  assert.deepEqual(data.employersWhoSavedYourProfile.map((x) => x.company), ['A Co']);

  await patch({ privacy: { discoverable: false } });
  const gone = await text('/employer/candidates?saved=1', ann);
  assert.doesNotMatch(gone, /Forklift driver/);
  assert.match(gone, /1 saved person has stopped sharing/);

  await patch({ privacy: { discoverable: true } });
  assert.match(await text('/employer/candidates?saved=1', ann), /Forklift driver/);

  assert.equal((await post('/account/delete', { confirm: 'DELETE' }, dev)).status < 400, true);
  assert.equal(saves().filter((s) => s.candidateId === id).length, 0, 'gone with the account');
  assert.doesNotMatch(await text('/employer/candidates?saved=1', ann), /Forklift driver|stopped sharing/);
});

test('removing someone', async () => {
  await post('/employer/candidates/c-2/save', { saved: '1' }, ann);
  assert.equal(saves().filter((s) => s.candidateId === 'c-2').length, 1);
  assert.match(where(await post('/employer/candidates/c-2/save', { saved: '0' }, ann)), /Removed from your saved list/);
  assert.equal(saves().filter((s) => s.candidateId === 'c-2').length, 0);
  assert.equal(saves().filter((s) => s.candidateId === 'c-1').length, 1, 'others stay');
});
