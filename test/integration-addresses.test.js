// Step 190: an integration can be limited to the addresses of its own systems.
// The check applies to asking for a token and to every call, at once, before the
// rate limit, and only after the secret or token is proven. Owners are told.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');
const { hashPassword } = require('../employers');
const { parseList, allowed } = require('../ip-allow');

const DAY = 86400000;
const iso = (ago = 0) => new Date(Date.now() - ago).toISOString();
const company = (id, name) => ({ id, company: name, name, email: `owner@${id}.in`, active: true, approvedAt: iso(DAY), createdAt: iso(30 * DAY) });
const person = (id, email, name) => ({ id, email, name, phone: '9800000001', passwordHash: hashPassword(`${name} long password`), emailVerifiedAt: iso(DAY), phoneVerifiedAt: iso(DAY), createdAt: iso(DAY), active: true, link: null });
const membership = (id, employerId, userId, role) => ({ id, employerId, userId, role, jobIds: [], createdAt: iso(DAY) });

const SERVER = '198.51.100.7';
const OTHER = '203.0.113.99';

let srv;
let ann;
let cara;
let bob;
let seq = 0;
const browser = () => ({ 'x-forwarded-for': `10.190.0.${(++seq % 250) + 1}` });
const post = (url, form, cookie) => srv.request(url, { method: 'POST', form, cookie, headers: browser() });
const page = (url, cookie) => srv.request(url, { cookie, headers: browser() });
async function fromAddress(ip, url, { token, basic, form } = {}) {
  const headers = { 'x-forwarded-for': ip };
  if (token) headers.authorization = `Bearer ${token}`;
  if (basic) headers.authorization = `Basic ${Buffer.from(basic).toString('base64')}`;
  if (form) headers['content-type'] = 'application/x-www-form-urlencoded';
  const r = await fetch(srv.base + url, { method: form ? 'POST' : 'GET', headers, body: form ? new URLSearchParams(form).toString() : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})), headers: r.headers };
}
const askToken = (ip, c) => fromAddress(ip, '/api/v1/oauth/token', { basic: `${c.clientId}:${c.secret}`, form: { grant_type: 'client_credentials' } });
async function create(cookie, name, addresses) {
  const r = await post('/employer/integrations/clients', [['name', name], ['environment', 'live'], ['scopes', 'jobs:read'], ...(addresses === undefined ? [] : [['addresses', addresses]])], cookie);
  const html = await r.text();
  const m = html.match(/<code class="secret-value">(hrv_[^<]+)<\/code>/);
  return { status: r.status, html, secret: m && m[1], clientId: m && html.match(/Client id: <code>(int_[a-f0-9]+)<\/code>/)[1] };
}
const clientRec = (id) => srv.records('integration-clients').find((c) => c.id === id);

before(async () => {
  srv = await startServer({ TRUST_PROXY: '1' }, {
    employers: [company('emp-a', 'A Co'), company('emp-b', 'B Co')],
    'employer-users': [person('u-ann', 'ann@aco.in', 'Ann'), person('u-cara', 'cara@aco.in', 'Cara'), person('u-bob', 'bob@bco.in', 'Bob')],
    'employer-members': [membership('m1', 'emp-a', 'u-ann', 'owner'), membership('m2', 'emp-a', 'u-cara', 'manager'), membership('m3', 'emp-b', 'u-bob', 'owner')],
  });
  const signIn = async (email, name) => srv.cookieFrom(await post('/employer/login', { email, password: `${name} long password` }));
  ann = await signIn('ann@aco.in', 'Ann');
  cara = await signIn('cara@aco.in', 'Cara');
  bob = await signIn('bob@bco.in', 'Bob');
}, { timeout: 60000 });
after(() => srv && srv.stop());

test('the list: addresses and ranges are read, tidied and checked', () => {
  const ok = parseList('198.51.100.7, 203.0.113.0/24\n2001:db8::/48  ::ffff:192.0.2.1 198.51.100.7 192.0.2.9/32');
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.list, ['198.51.100.7', '203.0.113.0/24', '2001:db8::/48', '192.0.2.1', '192.0.2.9']);
  for (const bad of ['nonsense', '1.2.3', '1.2.3.4/33', '1.2.3.4/abc', '0.0.0.0/0', '10.0.0.0/7', '::/0', '2001:db8::/31', '1.2.3.4/24/8', '1.2.3.4/-1']) {
    assert.ok(parseList(bad).errors.length, bad);
  }
  assert.ok(parseList(Array.from({ length: 21 }, (_, i) => `192.0.2.${i}`)).errors.length);
  assert.deepEqual(parseList('').list, []);

  assert.equal(allowed([], '1.2.3.4'), true);
  assert.equal(allowed(undefined, undefined), true);
  const list = ['198.51.100.7', '203.0.113.0/24', '2001:db8::/48'];
  for (const yes of ['198.51.100.7', '::ffff:198.51.100.7', '203.0.113.200', '2001:db8:0:1::5']) assert.equal(allowed(list, yes), true, yes);
  for (const no of ['198.51.100.8', '203.0.114.1', '2001:db9::1', '', undefined, 'unknown']) assert.equal(allowed(list, no), false, String(no));
});

test('with no list, any address works', async () => {
  const c = await create(ann, 'Open');
  assert.equal(c.status, 200);
  assert.deepEqual(clientRec(c.clientId).allowedIps, []);
  const t = await askToken(OTHER, c);
  assert.equal(t.status, 200);
  assert.equal((await fromAddress(SERVER, '/api/v1/me', { token: t.data.access_token })).status, 200);
});

test('a list made with the integration stops tokens and calls from elsewhere', async () => {
  const c = await create(ann, 'Ours', `${SERVER}\n192.0.2.0/24`);
  assert.deepEqual(clientRec(c.clientId).allowedIps, [SERVER, '192.0.2.0/24']);
  const denied = await askToken(OTHER, c);
  assert.equal(denied.status, 403);
  assert.equal(denied.data.error, 'ip_not_allowed');
  assert.ok(!denied.data.access_token);
  const t = await askToken(SERVER, c);
  assert.equal(t.status, 200);
  assert.equal((await fromAddress('192.0.2.50', '/api/v1/me', { token: t.data.access_token })).status, 200);
  // The same good token from somewhere else, as if it were stolen.
  const stolen = await fromAddress(OTHER, '/api/v1/me', { token: t.data.access_token });
  assert.equal(stolen.status, 403);
  assert.equal(stolen.data.error.code, 'ip_not_allowed');
  assert.equal(stolen.headers.get('ratelimit-remaining'), null, 'refused before the rate limit');
});

test('strangers learn nothing: a wrong secret or token from any address is still 401', async () => {
  const c = await create(ann, 'Quiet', SERVER);
  const wrong = c.secret.slice(0, -1) + (c.secret.endsWith('a') ? 'b' : 'a');
  const r = await fromAddress(OTHER, '/api/v1/oauth/token', { basic: `${c.clientId}:${wrong}`, form: { grant_type: 'client_credentials' } });
  assert.equal(r.status, 401);
  assert.equal(r.data.error, 'invalid_client');
  assert.equal((await fromAddress(OTHER, '/api/v1/me', { token: `hrv_at_${'x'.repeat(43)}` })).status, 401);
  assert.equal(clientRec(c.clientId).refusedAt, undefined, 'not a refusal of a real key');
});

test('a bad list is refused and nothing is created or changed', async () => {
  const bad = await create(ann, 'Wide', '0.0.0.0/0');
  assert.equal(bad.status, 400);
  assert.match(bad.html, /too wide/);
  assert.ok(!srv.records('integration-clients').some((c) => c.name === 'Wide'));

  const c = await create(ann, 'Keeper', SERVER);
  const r = await post(`/employer/integrations/clients/${c.clientId}/addresses`, { addresses: 'not-an-address' }, ann);
  assert.equal(r.status, 400);
  const html = await r.text();
  assert.match(html, /is not an address or range/);
  assert.match(html, /not-an-address<\/textarea>/, 'what was typed stays in the box');
  assert.deepEqual(clientRec(c.clientId).allowedIps, [SERVER]);
});

test('saving applies at once to tokens already given out; owners are told and it is logged', async () => {
  const c = await create(ann, 'Moved');
  const { data } = await askToken(OTHER, c);
  assert.equal((await fromAddress(OTHER, '/api/v1/me', { token: data.access_token })).status, 200);

  const r = await post(`/employer/integrations/clients/${c.clientId}/addresses`, { addresses: SERVER }, ann);
  assert.equal(r.status, 303);
  assert.match(decodeURIComponent(r.headers.get('location')), /now works only from the addresses listed/);
  assert.equal((await fromAddress(OTHER, '/api/v1/me', { token: data.access_token })).status, 403);
  assert.equal((await fromAddress(SERVER, '/api/v1/me', { token: data.access_token })).status, 200);
  await srv.waitForEmail((m) => m.includes('API addresses changed'));
  assert.ok(srv.records('employer-audit').some((e) => e.event === 'integration-addresses-changed' && e.detail.includes('Moved: any to')));

  // Emptying the list opens it again.
  const open = await post(`/employer/integrations/clients/${c.clientId}/addresses`, { addresses: '' }, ann);
  assert.match(decodeURIComponent(open.headers.get('location')), /now works from any address/);
  assert.equal((await fromAddress(OTHER, '/api/v1/me', { token: data.access_token })).status, 200);
});

test('a refusal is recorded and emailed once, however often it repeats, and shown on the pages', async () => {
  const c = await create(ann, 'Watched', SERVER);
  const before = srv.emails().filter((m) => m.includes('used from a new address')).length;
  for (let i = 0; i < 5; i++) assert.equal((await askToken(OTHER, c)).status, 403);
  const rec = clientRec(c.clientId);
  assert.equal(rec.refusedIp, OTHER);
  await srv.waitForEmail((m) => m.includes('used from a new address'));
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(srv.emails().filter((m) => m.includes('used from a new address')).length - before, 1);
  assert.ok(srv.records('employer-audit').some((e) => e.event === 'integration-address-refused' && e.detail.includes(OTHER)));

  const html = await (await page('/employer/integrations', ann)).text();
  assert.match(html, /Addresses allowed: 1 address or range/);
  assert.match(html, new RegExp(`Last refused: a request from <code>${OTHER}</code>`));
  assert.ok(html.includes(`${SERVER}</textarea>`));
  const team = await (await srv.request('/admin/integrations', { cookie: await srv.adminLogin(), headers: browser() })).text();
  assert.match(team, new RegExp(`Addresses: ${SERVER.replace(/\./g, '\\.')}`));
  assert.match(team, new RegExp(`Refused ${OTHER.replace(/\./g, '\\.')}`));
});

test('only the company\'s owners can change the list, and no secret comes back', async () => {
  const c = await create(ann, 'Guarded', SERVER);
  const addr = `/employer/integrations/clients/${c.clientId}/addresses`;
  const other = await post(addr, { addresses: OTHER }, bob);
  assert.match(decodeURIComponent(other.headers.get('location') || ''), /Integration not found/);
  assert.notEqual((await post(addr, { addresses: OTHER }, cara)).status, 303, 'a manager cannot');
  assert.notEqual((await srv.request(addr, { method: 'POST', form: { addresses: OTHER }, headers: browser() })).status, 200, 'signed out cannot');
  const crossSite = await srv.request(addr, { method: 'POST', form: { addresses: OTHER }, cookie: ann, headers: { ...browser(), origin: 'https://evil.example' } });
  assert.equal(crossSite.status, 403);
  assert.deepEqual(clientRec(c.clientId).allowedIps, [SERVER]);
  // There is no way to change it with an API token.
  const { data } = await askToken(SERVER, c);
  const viaApi = await fetch(`${srv.base}${addr}`, { method: 'POST', headers: { 'x-forwarded-for': SERVER, authorization: `Bearer ${data.access_token}`, 'content-type': 'application/x-www-form-urlencoded' }, body: 'addresses=' });
  assert.notEqual(viaApi.status, 303);
  assert.deepEqual(clientRec(c.clientId).allowedIps, [SERVER]);
  const html = await (await page('/employer/integrations', ann)).text();
  assert.ok(!html.includes(c.secret));
});

test('a revoked integration has no list to change', async () => {
  const c = await create(ann, 'Gone', SERVER);
  await post(`/employer/integrations/clients/${c.clientId}/revoke`, {}, ann);
  const r = await post(`/employer/integrations/clients/${c.clientId}/addresses`, { addresses: '' }, ann);
  assert.equal(r.status, 400);
  assert.deepEqual(clientRec(c.clientId).allowedIps, [SERVER]);
});
