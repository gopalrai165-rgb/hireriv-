// Step 191: usage per integration. Counts by day, what each kind of answer adds,
// each company sees only its own, the numbers are saved on a timer without a page
// being opened, nothing about the requests themselves is stored, and old days go.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');
const { hashPassword } = require('../employers');

const DAY = 86400000;
const iso = (ago = 0) => new Date(Date.now() - ago).toISOString();
const istDay = (ago = 0) => new Date(Date.now() - ago + 5.5 * 3600000).toISOString().slice(0, 10);
const company = (id, name) => ({ id, company: name, name, email: `owner@${id}.in`, active: true, approvedAt: iso(DAY), createdAt: iso(30 * DAY) });
const person = (id, email, name) => ({ id, email, name, phone: '9800000001', passwordHash: hashPassword(`${name} long password`), emailVerifiedAt: iso(DAY), phoneVerifiedAt: iso(DAY), createdAt: iso(DAY), active: true, link: null });
const membership = (id, employerId, userId) => ({ id, employerId, userId, role: 'owner', jobIds: [], createdAt: iso(DAY) });
const usageRow = (clientId, ago, requests) => ({ id: `${clientId}|${istDay(ago)}`, clientId, employerId: 'emp-a', day: istDay(ago), requests, clientErrors: 0, serverErrors: 0, limited: 0, refused: 0, tokens: 0 });

const SERVER = '198.51.100.7';
const OTHER = '203.0.113.99';
let srv;
let ann;
let bob;
let seq = 0;
const browser = () => ({ 'x-forwarded-for': `10.191.0.${(++seq % 250) + 1}` });
const post = (url, form, cookie) => srv.request(url, { method: 'POST', form, cookie, headers: browser() });
const html = async (url, cookie) => (await srv.request(url, { cookie, headers: browser() })).text();
const call = (token, url = '/api/v1/me', ip = SERVER) => fetch(srv.base + url, { headers: { 'x-forwarded-for': ip, authorization: `Bearer ${token}` } });
async function create(cookie, name, environment = 'live', addresses = '') {
  const r = await post('/employer/integrations/clients', [['name', name], ['environment', environment], ['scopes', 'jobs:read'], ['addresses', addresses]], cookie);
  const t = await r.text();
  return { secret: t.match(/<code class="secret-value">(hrv_[^<]+)<\/code>/)[1], clientId: t.match(/Client id: <code>(int_[a-f0-9]+)<\/code>/)[1] };
}
const askToken = async (c, ip = SERVER) => {
  const r = await fetch(`${srv.base}/api/v1/oauth/token`, { method: 'POST', headers: { 'x-forwarded-for': ip, authorization: `Basic ${Buffer.from(`${c.clientId}:${c.secret}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
  return (await r.json()).access_token;
};
const today = (clientId) => srv.records('integration-usage').find((u) => u.clientId === clientId && u.day === istDay());
async function saved(clientId, check) {
  for (const end = Date.now() + 4000; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) {
    const u = today(clientId);
    if (u && check(u)) return u;
  }
  return today(clientId);
}

before(async () => {
  srv = await startServer({ TRUST_PROXY: '1', USAGE_FLUSH_MS: '150', API_RATE_SANDBOX: '3' }, {
    employers: [company('emp-a', 'A Co'), company('emp-b', 'B Co')],
    'employer-users': [person('u-ann', 'ann@aco.in', 'Ann'), person('u-bob', 'bob@bco.in', 'Bob')],
    'employer-members': [membership('m1', 'emp-a', 'u-ann'), membership('m2', 'emp-b', 'u-bob')],
    'integration-usage': [usageRow('int_old', 120 * DAY, 9), usageRow('int_kept', 80 * DAY, 9)],
  });
  const signIn = async (email, name) => srv.cookieFrom(await post('/employer/login', { email, password: `${name} long password` }));
  ann = await signIn('ann@aco.in', 'Ann');
  bob = await signIn('bob@bco.in', 'Bob');
}, { timeout: 60000 });
after(() => srv && srv.stop());

test('each kind of answer is counted, and saved without opening a page', async () => {
  const c = await create(ann, 'Counted');
  const token = await askToken(c);
  for (let i = 0; i < 3; i++) assert.equal((await call(token)).status, 200);
  assert.equal((await call(token, '/api/v1/jobs/none')).status, 404);
  assert.equal((await call(token, '/api/v1/webhooks')).status, 403, 'a missing permission is a mistake in the request');
  const u = await saved(c.clientId, (x) => x.requests >= 5 && x.clientErrors >= 2);
  assert.equal(u.requests, 5);
  assert.equal(u.clientErrors, 2);
  assert.equal(u.serverErrors, 0);
  assert.equal(u.tokens, 1);
  assert.equal(u.limited, 0);
  // Added to, not replaced, when saved again.
  await call(token);
  assert.equal((await saved(c.clientId, (x) => x.requests === 6)).requests, 6);
});

test('over the rate limit and refused addresses have their own counts; a bad token counts for nobody', async () => {
  const s = await create(ann, 'Limited', 'sandbox');
  const token = await askToken(s);
  for (let i = 0; i < 5; i++) await call(token);
  const u = await saved(s.clientId, (x) => x.requests >= 5 && x.limited >= 2);
  assert.equal(u.requests, 5);
  assert.equal(u.limited, 2);
  assert.equal(u.clientErrors, 0);

  const c = await create(ann, 'Fenced', 'live', SERVER);
  const good = await askToken(c);
  assert.equal((await call(good, '/api/v1/me', OTHER)).status, 403);
  await askToken(c, OTHER);
  const f = await saved(c.clientId, (x) => x.refused >= 2);
  assert.equal(f.refused, 2);
  assert.equal(f.requests, 0, 'a refused request is not a request served');
  const rows = srv.records('integration-usage').length;
  assert.equal((await call(`hrv_at_${'y'.repeat(43)}`)).status, 401);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(srv.records('integration-usage').length, rows);
});

test('only counts are stored: no addresses, paths or tokens', async () => {
  const c = await create(ann, 'Private');
  const token = await askToken(c);
  await call(token, '/api/v1/jobs/secret-path-value');
  const u = await saved(c.clientId, (x) => x.requests >= 1);
  assert.deepEqual(Object.keys(u).sort(), ['clientErrors', 'clientId', 'day', 'employerId', 'id', 'limited', 'refused', 'requests', 'serverErrors', 'tokens'].sort());
  const text = JSON.stringify(u);
  assert.ok(!text.includes(SERVER) && !text.includes('secret-path-value') && !text.includes(token));
});

test('the owner sees the figures and chart; another company does not', async () => {
  const c = await create(ann, 'Shown');
  const token = await askToken(c);
  for (let i = 0; i < 4; i++) await call(token);
  await call(token, '/api/v1/jobs/none');
  // No wait here: opening the page saves what is waiting.
  const page = await html('/employer/integrations', ann);
  const block = page.slice(page.indexOf('<b>Shown</b>'));
  assert.match(block, /Last 30 days: 5 requests, 1 error</);
  assert.match(block, /<b>5<\/b><span>Today<\/span>/);
  assert.match(block, /class="colchart"[^>]*aria-label="requests per day for the last 14 days, highest in [^"]+ at 5"/);
  assert.match(block, /Show as table/);
  assert.match(block, /Errors: 1 \(20% of requests\)/);
  assert.doesNotMatch(await html('/employer/integrations', bob), /Shown|Last 30 days: 5/);
  const fresh = await create(bob, 'Fresh');
  const bobPage = await html('/employer/integrations', bob);
  assert.ok(bobPage.includes(fresh.clientId));
  assert.match(bobPage, /No requests in the last 30 days\./);
  const team = await html('/admin/integrations', await srv.adminLogin());
  const row = team.slice(team.indexOf('<b>Shown</b>'));
  assert.match(row, /<b>5<\/b><br><span class="muted">1 error, 0 refused/);
});

test('the 30-day figures leave older days out, and days past 90 are removed', async () => {
  await html('/employer/integrations', ann);
  const rows = srv.records('integration-usage');
  assert.ok(!rows.some((u) => u.clientId === 'int_old'), 'older than 90 days: gone');
  assert.ok(rows.some((u) => u.clientId === 'int_kept'), '80 days: kept');
});
