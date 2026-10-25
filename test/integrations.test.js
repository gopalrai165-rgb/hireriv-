// Step 65: the public API (/api/v1) and integrations. Credentials shown once
// and stored as hashes, short-lived tokens with scopes, every call limited to
// the credential's company, idempotency keys, rate limits, signed webhooks
// with retries, delivery logs and replays, rotation and revocation, the
// sandbox with its own data, SSRF checks and the developer portal.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { startServer, decodeEmail } = require('./helpers');
const { hashPassword } = require('../employers');
const safe = require('../safe-fetch');

const DAY = 86400000;
const iso = (ago = 0) => new Date(Date.now() - ago).toISOString();
const company = (id, name, extra = {}) => ({ id, company: name, name, email: `owner@${id}.in`, active: true, approvedAt: iso(DAY), createdAt: iso(30 * DAY), ...extra });
const person = (id, email, name) => ({ id, email, name, phone: '9800000001', passwordHash: hashPassword(`${name} long password`), emailVerifiedAt: iso(DAY), phoneVerifiedAt: iso(DAY), createdAt: iso(DAY), active: true, link: null });
const membership = (id, employerId, userId, role) => ({ id, employerId, userId, role, jobIds: [], createdAt: iso(DAY) });
const job = (id, employerId, status, extra = {}) => ({ id, title: `Job ${id}`, company: 'Co', employerId, location: 'Pune', mode: 'On-site', type: 'Full-time', category: 'Retail', experience: '', posted: '2026-10-20', skills: [], description: 'A good job with clear duties for the right person.', responsibilities: ['Serve customers at the counter'], pay: null, payNote: 'Fixed monthly salary, discussed at interview', status, closesOn: null, sample: false, createdBy: 'employer', createdByUser: 'u-ann', ...extra });
const application = (id, jobId, name, email) => ({ id, jobId, jobTitle: `Job ${jobId}`, name, email, phone: '9811111111', status: 'New', createdAt: iso(DAY), history: [] });

let srv;
let receiver;
const hits = [];
let answer = 200;
const p = {};
let ip = 0;
const headers = (extra = {}) => ({ 'x-forwarded-for': `10.7.${Math.floor(++ip / 250)}.${ip % 250}`, ...extra });
const post = (url, form, cookie) => srv.request(url, { method: 'POST', form, cookie, headers: headers() });
const get = (url, cookie) => srv.request(url, { cookie, headers: headers() });
// An API call from another system: no cookies, no Origin header.
async function api(url, { method = 'GET', token, body, extra = {} } = {}) {
  const h = { ...headers(), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...extra };
  const r = await fetch(srv.base + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let data = {};
  try { data = JSON.parse(text); } catch (e) { data = { text }; }
  return { ...data, status: r.status, headers: r.headers };
}
const rec = (collection, fn) => srv.records(collection).find(fn);
const all = (collection, fn = () => true) => srv.records(collection).filter(fn);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 6000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) { const v = fn(); if (v) return v; }
  return fn();
}
const employer = async (email, name) => srv.cookieFrom(await post('/employer/login', { email, password: `${name} long password` }));
// Creates an integration in the portal and reads the secret off the answer page.
async function createClient(cookie, name, scopes, environment = 'live') {
  const res = await post('/employer/integrations/clients', [['name', name], ['environment', environment], ...scopes.map((s) => ['scopes', s])], cookie);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control') || '', /no-store/);
  const html = await res.text();
  const secret = html.match(/<code class="secret-value">(hrv_(?:live|test)_[^<]+)<\/code>/)[1];
  const clientId = html.match(/Client id: <code>(int_[a-f0-9]+)<\/code>/)[1];
  return { secret, clientId };
}
const tokenFor = async ({ secret, clientId }, scope) => {
  const r = await fetch(`${srv.base}/api/v1/oauth/token`, { method: 'POST', headers: { ...headers(), authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', ...(scope ? { scope } : {}) }) });
  const data = await r.json();
  assert.equal(r.status, 200, JSON.stringify(data));
  return data.access_token;
};
const verifySig = (header, raw, secret) => {
  const parts = header.split(',');
  const t = parts.find((x) => x.startsWith('t=')).slice(2);
  const want = crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  return parts.filter((x) => x.startsWith('v1=')).some((x) => x.slice(3) === want);
};

before(async () => {
  receiver = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => { hits.push({ headers: req.headers, raw, body: JSON.parse(raw || '{}'), url: req.url }); res.statusCode = answer; res.end(answer === 200 ? 'ok' : 'down'); });
  });
  await new Promise((r) => receiver.listen(0, '127.0.0.1', r));
  srv = await startServer({ TRUST_PROXY: '1', WEBHOOKS_ALLOW_PRIVATE: '1', WEBHOOK_TICK_MS: '200', API_RATE_SANDBOX: '25' }, {
    employers: [company('emp-a', 'A Co'), company('emp-b', 'B Co')],
    'employer-users': [person('u-ann', 'ann@aco.in', 'Ann Rao'), person('u-vic', 'vic@aco.in', 'Vic'), person('u-bob', 'bob@bco.in', 'Bob')],
    'employer-members': [membership('m1', 'emp-a', 'u-ann', 'owner'), membership('m2', 'emp-a', 'u-vic', 'manager'), membership('m3', 'emp-b', 'u-bob', 'owner')],
    jobs: [job('ja1', 'emp-a', 'open'), job('ja2', 'emp-a', 'draft'), job('jb1', 'emp-b', 'open', { createdByUser: 'u-bob' })],
    applications: [application('app-a1', 'ja1', 'Priya Nair', 'priya@example.com'), application('app-b1', 'jb1', 'Kiran Das', 'kiran@example.com')],
  });
  p.admin = await srv.adminLogin();
  p.ann = await employer('ann@aco.in', 'Ann Rao');
  p.vic = await employer('vic@aco.in', 'Vic');
  p.bob = await employer('bob@bco.in', 'Bob');
});
after(async () => {
  await srv.stop();
  await new Promise((r) => receiver.close(r));
});

test('only owners manage integrations; the secret is shown once and stored as a hash', async () => {
  assert.equal((await srv.request('/employer/integrations')).headers.get('location'), '/employer/login');
  assert.equal((await get('/employer/integrations', p.vic)).status, 403);
  assert.equal((await post('/employer/integrations/clients', { name: 'X', scopes: 'jobs:read' }, p.vic)).status, 403);
  const bad = await post('/employer/integrations/clients', [['name', 'A'], ['scopes', 'jobs:everything']], p.ann);
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /unknown scopes: jobs:everything/);

  p.ats = await createClient(p.ann, 'Our ATS', ['jobs:read', 'jobs:write', 'applications:read', 'applications:status:update', 'webhooks:manage']);
  assert.match(p.ats.secret, /^hrv_live_[a-f0-9]{12}_[A-Za-z0-9_-]{43}$/);
  // Never again in full: not on the page, not in the database.
  const page = await (await get('/employer/integrations', p.ann)).text();
  assert.ok(!page.includes(p.ats.secret));
  assert.ok(page.includes(`hrv_live_${p.ats.secret.split('_')[2]}…${p.ats.secret.slice(-4)}`));
  const dbFile = fs.readFileSync(srv.paths.db);
  assert.ok(!dbFile.includes(Buffer.from(p.ats.secret)), 'the database holds no raw secret');
  const cred = rec('integration-credentials', (c) => c.clientId === p.ats.clientId);
  assert.match(cred.hash, /^[a-f0-9]{64}$/);
  assert.equal(cred.secret, undefined);
  // The owners are told, and it is in the company's activity log.
  await srv.waitForEmail((m) => m.includes('To: ann@aco.in') && decodeEmail(m).includes('created the integration "Our ATS"'));
  assert.ok(rec('employer-audit', (e) => e.employerId === 'emp-a' && e.event === 'integration-created'));
  // The developer portal and the API description.
  const dev = await (await srv.request('/developers')).text();
  for (const s of ['Hireriv-Signature', 'At least once', '/api/v1/oauth/token', 'no certified third-party integrations']) assert.ok(dev.includes(s), s);
  const spec = await api('/api/v1/openapi.json');
  assert.equal(spec.openapi, '3.1.0');
  assert.ok(spec.paths['/jobs'].post && spec.paths['/webhooks/{id}/rotate-secret']);
});

test('tokens: client credentials, scopes, never in the address', async () => {
  const none = await api('/api/v1/jobs');
  assert.equal(none.status, 401);
  assert.equal(none.error.code, 'unauthorized');
  assert.match(none.headers.get('www-authenticate'), /Bearer/);
  // Cookies don't count.
  assert.equal((await api('/api/v1/jobs', { extra: { cookie: p.ann } })).status, 401);
  // The body works as well as HTTP Basic; a wrong secret or another client id fails the same way.
  const viaBody = await api('/api/v1/oauth/token', { method: 'POST', body: { grant_type: 'client_credentials', client_secret: p.ats.secret } });
  assert.equal(viaBody.status, 200);
  assert.equal(viaBody.expires_in, 900);
  assert.equal(viaBody.token_type, 'Bearer');
  const wrong = await api('/api/v1/oauth/token', { method: 'POST', body: { grant_type: 'client_credentials', client_secret: `${p.ats.secret.slice(0, -4)}AAAA` } });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.error, 'invalid_client');
  assert.equal((await api('/api/v1/oauth/token', { method: 'POST', body: { grant_type: 'client_credentials', client_id: 'int_0000', client_secret: p.ats.secret } })).status, 401);
  assert.equal((await api('/api/v1/oauth/token', { method: 'POST', body: { grant_type: 'password', client_secret: p.ats.secret } })).error, 'unsupported_grant_type');
  assert.equal((await api('/api/v1/oauth/token', { method: 'POST', body: { grant_type: 'client_credentials', client_secret: p.ats.secret, scope: 'applications:contact' } })).error, 'invalid_scope');
  assert.equal((await api(`/api/v1/oauth/token?client_secret=${p.ats.secret}`, { method: 'POST', body: { grant_type: 'client_credentials' } })).status, 400);

  p.token = viaBody.access_token;
  assert.equal((await api(`/api/v1/jobs?access_token=${p.token}`)).error.code, 'token_in_url');
  assert.ok(!rec('integration-tokens', (t) => t.tokenHash === p.token), 'tokens are stored hashed');
  const me = await api('/api/v1/me', { token: p.token });
  assert.equal(me.data.company.id, 'emp-a');
  assert.match(me.headers.get('cache-control'), /no-store/);
  assert.equal(me.headers.get('ratelimit-limit'), '600');
  // A narrower token can't write.
  const readOnly = await tokenFor(p.ats, 'jobs:read');
  const denied = await api('/api/v1/jobs', { method: 'POST', token: readOnly, body: { title: 'X' } });
  assert.equal(denied.status, 403);
  assert.equal(denied.error.code, 'insufficient_scope');
  assert.equal((await api('/api/v1/nothing-here', { token: p.token })).error.code, 'not_found');
});

test('jobs: only the company’s own, idempotent creation, review as usual', async () => {
  const list = await api('/api/v1/jobs?limit=1', { token: p.token });
  assert.equal(list.data.length, 1);
  assert.equal(list.has_more, true);
  const rest = await api(`/api/v1/jobs?limit=10&cursor=${list.next_cursor}`, { token: p.token });
  const ids = [...list.data, ...rest.data].map((j) => j.id).sort();
  assert.deepEqual(ids, ['ja1', 'ja2']);
  // Another company's job is simply not found.
  assert.equal((await api('/api/v1/jobs/jb1', { token: p.token })).status, 404);
  assert.equal((await api('/api/v1/jobs/jb1', { method: 'PATCH', token: p.token, body: { title: 'Mine now' } })).status, 404);
  assert.equal((await api('/api/v1/jobs/jb1/close', { method: 'POST', token: p.token })).status, 404);

  const body = { title: 'Forklift Operator', category: 'Warehouse & Packing', location: 'Pune', description: 'Drive forklifts in our Pune warehouse.', responsibilities: ['Move pallets safely'], pay: { min: 20000, max: 24000, period: 'month' }, shift: 'Day', submit: true };
  const key = { 'idempotency-key': 'create-forklift-1' };
  const made = await api('/api/v1/jobs', { method: 'POST', token: p.token, body, extra: key });
  assert.equal(made.status, 201, JSON.stringify(made));
  assert.equal(made.data.status, 'pending', 'sent for Hireriv’s review, not published');
  const again = await api('/api/v1/jobs', { method: 'POST', token: p.token, body, extra: key });
  assert.equal(again.status, 201);
  assert.equal(again.data.id, made.data.id);
  assert.equal(again.headers.get('idempotent-replayed'), 'true');
  assert.equal(all('jobs', (j) => j.title === 'Forklift Operator').length, 1, 'no duplicate job');
  const reused = await api('/api/v1/jobs', { method: 'POST', token: p.token, body: { ...body, title: 'Other' }, extra: key });
  assert.equal(reused.status, 422);
  assert.equal(reused.error.code, 'idempotency_key_reused');
  const job = rec('jobs', (j) => j.id === made.data.id);
  assert.equal(job.employerId, 'emp-a');
  assert.equal(job.createdBy, 'employer');
  assert.ok(rec('employer-audit', (e) => e.event === 'job-submitted' && e.actor === 'Our ATS (API)'));
  // Validation errors come in the same shape.
  const invalid = await api('/api/v1/jobs', { method: 'POST', token: p.token, body: { title: '' } });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.error.code, 'validation_failed');
  assert.ok(Array.isArray(invalid.error.details));
});

test('applications: own company only, contact details only with their scope, status moves', async () => {
  const list = await api('/api/v1/applications', { token: p.token });
  assert.deepEqual(list.data.map((a) => a.id), ['app-a1']);
  assert.equal(list.data[0].email, undefined, 'no contact details without applications:contact');
  assert.equal(list.data[0].phone, undefined);
  assert.equal((await api('/api/v1/applications/app-b1', { token: p.token })).status, 404);
  assert.equal((await api('/api/v1/applications/app-b1/status', { method: 'PATCH', token: p.token, body: { status: 'Screening' } })).status, 404);
  assert.equal(rec('applications', (a) => a.id === 'app-b1').status, 'New');

  const hr = await createClient(p.ann, 'HR system', ['applications:read', 'applications:contact']);
  const hrToken = await tokenFor(hr);
  const withContact = await api('/api/v1/applications/app-a1', { token: hrToken });
  assert.equal(withContact.data.email, 'priya@example.com');
  assert.equal((await api('/api/v1/applications/app-a1/status', { method: 'PATCH', token: hrToken, body: { status: 'Screening' } })).status, 403);
  p.hr = hr;
});

test('signed webhooks: delivery, no personal data, retries, replays, rotation', async () => {
  const url = `http://127.0.0.1:${receiver.address().port}/hook`;
  const bad = await api('/api/v1/webhooks', { method: 'POST', token: p.token, body: { url, events: ['job.exploded'] } });
  assert.equal(bad.status, 400);
  const made = await api('/api/v1/webhooks', { method: 'POST', token: p.token, body: { url, events: ['application.status_changed', 'job.published', 'job.closed'] } });
  assert.equal(made.status, 201, JSON.stringify(made));
  const secret = made.data.secret;
  assert.match(secret, /^whsec_/);
  assert.ok(!JSON.stringify(srv.records('webhook-endpoints')).includes(secret), 'the signing secret is derived, never stored');
  p.hook = made.data.id;
  const listed = await api('/api/v1/webhooks', { token: p.token });
  assert.ok(!listed.data[0].secret.includes(secret.slice(8)));
  // Company B can't see or touch it.
  const bobClient = await createClient(p.bob, 'B system', ['webhooks:manage', 'jobs:read']);
  const bobToken = await tokenFor(bobClient);
  assert.equal((await api('/api/v1/webhooks', { token: bobToken })).data.length, 0);
  assert.equal((await api(`/api/v1/webhooks/${p.hook}`, { method: 'DELETE', token: bobToken })).status, 404);
  assert.equal((await api(`/api/v1/webhooks/${p.hook}/deliveries`, { token: bobToken })).status, 404);

  const moved = await api('/api/v1/applications/app-a1/status', { method: 'PATCH', token: p.token, body: { status: 'Screening' } });
  assert.equal(moved.status, 200, JSON.stringify(moved));
  assert.equal(moved.data.status, 'Screening');
  const hit = await until(() => hits.find((h) => h.body.type === 'application.status_changed'));
  assert.ok(hit, 'the webhook arrived');
  assert.ok(verifySig(hit.headers['hireriv-signature'], hit.raw, secret));
  assert.ok(!verifySig(hit.headers['hireriv-signature'], hit.raw, 'whsec_wrong'));
  assert.equal(hit.headers['hireriv-event-type'], 'application.status_changed');
  assert.equal(hit.headers['hireriv-event-id'], hit.body.id);
  assert.equal(hit.headers['hireriv-delivery-attempt'], '1');
  assert.deepEqual(hit.body.data, { applicationId: 'app-a1', jobId: 'ja1', from: 'New', to: 'Screening' });
  for (const s of ['priya', 'Priya', '9811111111']) assert.ok(!hit.raw.includes(s), `no ${s} in the payload`);
  // Events of other companies, and types the endpoint didn't ask for, don't arrive.
  assert.ok(!hits.some((h) => h.raw.includes('app-b1')));

  // A failing receiver: the delivery waits for a retry, then can be replayed with the same event id.
  answer = 500;
  await api('/api/v1/jobs/ja2/close', { method: 'POST', token: p.token });
  const failed = await until(() => rec('webhook-deliveries', (d) => d.type === 'job.closed' && d.attempts === 1));
  assert.equal(failed.status, 'pending');
  assert.equal(failed.lastStatus, 500);
  assert.ok(new Date(failed.nextAttemptAt) - Date.now() > 15000, 'the next try is later, with backoff');
  answer = 200;
  const replay = await api(`/api/v1/webhook-deliveries/${failed.id}/replay`, { method: 'POST', token: p.token });
  assert.equal(replay.status, 202);
  const second = await until(() => hits.find((h) => h.body.type === 'job.closed' && h.headers['hireriv-delivery-id'] === replay.data.id));
  assert.equal(second.body.id, failed.eventId, 'a replay keeps the event id so receivers can dedupe');
  const logs = await api(`/api/v1/webhooks/${p.hook}/deliveries`, { token: p.token });
  assert.ok(logs.data.some((d) => d.status === 'delivered'));
  assert.ok(logs.data.some((d) => d.log.some((l) => l.status === 500)));
  // The company can catch up from the event list.
  const evs = await api('/api/v1/events?type=job.closed', { token: p.token });
  assert.equal(evs.data[0].id, failed.eventId);

  // Rotation: for a day both secrets sign.
  const rotated = await api(`/api/v1/webhooks/${p.hook}/rotate-secret`, { method: 'POST', token: p.token });
  assert.notEqual(rotated.data.secret, secret);
  const n = hits.length;
  const test = await api(`/api/v1/webhooks/${p.hook}/test`, { method: 'POST', token: p.token });
  assert.equal(test.status, 202);
  const t = await until(() => hits.slice(n).find((h) => h.body.type === 'webhook.test'));
  assert.equal(t.headers['hireriv-signature'].split('v1=').length - 1, 2);
  assert.ok(verifySig(t.headers['hireriv-signature'], t.raw, rotated.data.secret));
  assert.ok(verifySig(t.headers['hireriv-signature'], t.raw, secret));
});

test('webhook addresses must be public; redirects and DNS answers are checked', async () => {
  for (const u of ['http://example.com/x', 'https://localhost/x', 'https://10.0.0.5/x', 'https://[::1]/x', 'https://169.254.169.254/latest', 'https://user:pw@example.com/', 'https://example.com:22/', 'https://intranet/x', 'https://db.internal/x', 'ftp://example.com/']) {
    assert.ok(safe.checkUrl(u).error, u);
  }
  assert.equal(safe.checkUrl('https://hooks.example.com/hireriv').error, undefined);
  for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1', '::ffff:7f00:1', '64:ff9b::a00:1']) assert.equal(safe.isBlockedAddress(a), true, a);
  for (const a of ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946']) assert.equal(safe.isBlockedAddress(a), false, a);
  // A name that resolves to a private address, even among public ones, is refused.
  const lookup = async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.8', family: 4 }];
  assert.match((await safe.resolveSafe(new URL('https://rebind.example.com/'), { lookup })).error, /private/);
  // Each redirect target is checked again before it is followed.
  const hop = http.createServer((req, res) => { res.writeHead(307, { location: 'https://10.0.0.9/steal' }); res.end(); });
  await new Promise((r) => hop.listen(0, '127.0.0.1', r));
  const first = `http://127.0.0.1:${hop.address().port}/`;
  assert.ok((await safe.safeRequest(first)).error, 'a private address is refused before connecting');
  const followed = await safe.safeRequest(first, { checkHop: (u, hopNo) => (hopNo === 0 ? { allowPrivate: true } : {}) });
  assert.match(followed.error, /public internet address|https/);
  // Other redirects are not followed at all.
  await new Promise((done) => hop.close(done));
});

test('revoking and rotating stop access at once; the team can revoke with a reason', async () => {
  // Rotation with "stop now": the old secret no longer gets tokens.
  const res = await post(`/employer/integrations/clients/${p.hr.clientId}/rotate`, { now: '1' }, p.ann);
  assert.equal(res.status, 200);
  const newSecret = (await res.text()).match(/<code class="secret-value">(hrv_live_[^<]+)<\/code>/)[1];
  assert.equal((await api('/api/v1/oauth/token', { method: 'POST', body: { grant_type: 'client_credentials', client_secret: p.hr.secret } })).status, 401);
  const fresh = await tokenFor({ clientId: p.hr.clientId, secret: newSecret });
  assert.equal((await api('/api/v1/applications', { token: fresh })).status, 200);
  // The company revokes: tokens stop working immediately.
  await post(`/employer/integrations/clients/${p.hr.clientId}/revoke`, {}, p.ann);
  assert.equal((await api('/api/v1/applications', { token: fresh })).status, 401);
  assert.equal(all('integration-tokens', (t) => t.clientId === p.hr.clientId).length, 0);
  // Company B can't revoke A's integration.
  await post(`/employer/integrations/clients/${p.ats.clientId}/revoke`, {}, p.bob);
  assert.equal(rec('integration-clients', (c) => c.id === p.ats.clientId).status, 'active');

  // Hireriv's team sees integrations (masked) and revokes with a reason.
  const desk = await (await get('/admin/integrations', p.admin)).text();
  assert.ok(desk.includes('Our ATS'));
  assert.ok(!desk.includes(p.ats.secret));
  const noReason = await post(`/admin/integrations/clients/${p.ats.clientId}/revoke`, { reason: '' }, p.admin);
  assert.match(decodeURIComponent(noReason.headers.get('location')), /Give a reason/);
  await post(`/admin/integrations/clients/${p.ats.clientId}/revoke`, { reason: 'The key was posted publicly' }, p.admin);
  assert.equal(rec('integration-clients', (c) => c.id === p.ats.clientId).status, 'revoked');
  assert.equal((await api('/api/v1/me', { token: p.token })).status, 401);
  assert.equal(rec('webhook-endpoints', (e) => e.id === p.hook).status, 'disabled');
  await srv.waitForEmail((m) => m.includes('To: ann@aco.in') && decodeEmail(m).includes('The key was posted publicly'));
  const entry = rec('trust-audit', (e) => e.action === 'integration-revoked');
  assert.equal(entry.reason, 'The key was posted publicly');
  assert.equal(entry.entityId, 'emp-a');
});

test('the sandbox has its own data and limits, and never touches live records', async () => {
  const box = await createClient(p.ann, 'ATS test', ['jobs:read', 'jobs:write', 'applications:read', 'applications:contact', 'applications:status:update', 'webhooks:manage'], 'sandbox');
  assert.match(box.secret, /^hrv_test_/);
  const token = await tokenFor(box);
  const jobs = await api('/api/v1/jobs', { token });
  assert.equal(jobs.data.length, 2);
  assert.ok(jobs.data.every((j) => j.sandbox && j.id.startsWith('sbx_job_')));
  assert.equal((await api('/api/v1/jobs/ja1', { token })).status, 404, 'live jobs are not visible from the sandbox');
  const before = srv.records('jobs').length;
  const made = await api('/api/v1/jobs', { method: 'POST', token, body: { title: 'Test job', description: 'Testing the integration end to end.', submit: true } });
  assert.equal(made.status, 201);
  assert.equal(srv.records('jobs').length, before, 'no live job was created');
  const apps = await api('/api/v1/applications', { token });
  assert.equal(apps.data.length, 3);
  assert.match(apps.data[0].email, /@example\.com$/);
  const moved = await api(`/api/v1/applications/${apps.data[0].id}/status`, { method: 'PATCH', token, body: { status: 'Shortlisted' } });
  assert.equal(moved.status, 200);
  // Sandbox events stay in the sandbox.
  const evs = await api('/api/v1/events', { token });
  assert.ok(evs.data.some((e) => e.type === 'application.status_changed'));
  const live = all('integration-events', (e) => e.environment === 'live');
  assert.ok(!live.some((e) => JSON.stringify(e.data).includes('sbx_')));
  // Its own, lower rate limit.
  let limited = null;
  for (let i = 0; i < 30 && !limited; i++) {
    const r = await api('/api/v1/me', { token });
    if (r.status === 429) limited = r;
  }
  assert.ok(limited, 'the sandbox limit applies');
  assert.equal(limited.error.code, 'rate_limited');
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
});

test('no collar words in the new files', () => {
  const root = path.join(__dirname, '..');
  for (const f of ['integrations.js', 'safe-fetch.js', 'openapi.js', 'views/developers.ejs', 'views/employer-integrations.ejs', 'views/admin-integrations.ejs', 'docs/API.md']) {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    assert.doesNotMatch(text, /(white|blue|grey|gray)[\s-]collar/i, f);
  }
});
