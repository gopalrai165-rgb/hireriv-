// Step 60: the phone experience and the installable app. The manifest and
// icons, a service worker that stores public files only (simulated here),
// the offline page, sign-out clearing the browser's cache and the device's
// notifications, push devices registered only by their owner and only for
// supported push services, encrypted pushes without personal details that
// respect the person's choices, notification and marketing preferences,
// one application per job, and checks that pages fit a phone screen.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const vm = require('vm');
const { startServer, decodeEmail } = require('./helpers');
const pwa = require('../pwa');
const pushLib = require('../push');

const ROOT = path.join(__dirname, '..');
const PHONE = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';
let srv;
let pushServer;
let pushOrigin;
// What the stand-in push service received, and what it answers.
const received = [];
const answer = { status: 201 };
let ip = 0;
const headers = (extra = {}) => ({ 'x-forwarded-for': `10.60.${Math.floor(++ip / 250)}.${ip % 250}`, 'user-agent': PHONE, ...extra });
const get = (url, cookie, extra = {}) => srv.request(url, { cookie, headers: headers({ accept: 'text/html', ...extra }) });
const post = (url, form, cookie, extra = {}) => srv.request(url, { method: 'POST', form, cookie, headers: headers(extra) });
const call = async (url, method, body, cookie, extra = {}) => {
  const r = await srv.request(url, { method, cookie, body: body === undefined ? undefined : JSON.stringify(body), headers: headers({ 'content-type': 'application/json', accept: 'application/json', ...extra }) });
  const text = await r.text();
  let data = {};
  try { data = JSON.parse(text); } catch (e) { data = { text }; }
  return { ...data, status: r.status, raw: text };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) { const v = fn(); if (v) return v; }
  return fn();
}

before(async () => {
  pushServer = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(answer.status).end();
    });
  });
  await new Promise((r) => pushServer.listen(0, '127.0.0.1', r));
  pushOrigin = `http://127.0.0.1:${pushServer.address().port}`;
  srv = await startServer({ PUSH_TEST_ORIGIN: pushOrigin, ANALYTICS_FLUSH_MS: '200', TRUST_PROXY: '1' });
});
after(async () => {
  if (srv) await srv.stop();
  if (pushServer) await new Promise((r) => pushServer.close(r));
});

async function register(name, email) {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ name, email, phone: '9845012345', location: 'Bengaluru', agree: '1' })) fd.append(k, v);
  await srv.request('/account/register', { method: 'POST', body: fd, headers: headers() });
  const mail = await srv.waitForEmail((m) => m.includes(`To: ${email}`) && decodeEmail(m).includes('/account/verify/'));
  const link = decodeEmail(mail).match(/\/account\/verify\/[a-f0-9]{64}/)[0];
  return srv.cookieFrom(await post(link, {}));
}

// A browser's push subscription: a P-256 key pair and an auth secret.
function device(id = crypto.randomUUID()) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return {
    ecdh, auth,
    json: { endpoint: `${pushOrigin}/push/${id}`, expirationTime: null, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } },
  };
}
// What the browser does with a push: RFC 8291 decryption.
function decrypt(body, dev) {
  const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
  const salt = body.subarray(0, 16);
  assert.equal(body.readUInt32BE(16), 4096);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const data = body.subarray(21 + idlen);
  const shared = dev.ecdh.computeSecret(asPublic);
  const ikm = hmac(hmac(dev.auth, shared), Buffer.concat([Buffer.from('WebPush: info\0'), dev.ecdh.getPublicKey(), asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(data.subarray(data.length - 16));
  const plain = Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
  assert.equal(plain[plain.length - 1], 2, 'last-record delimiter');
  return JSON.parse(plain.subarray(0, plain.length - 1).toString());
}
function verifyVapid(auth, publicKey, audience) {
  const m = auth.match(/^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/);
  assert.ok(m, auth);
  assert.equal(m[4], publicKey);
  const raw = Buffer.from(publicKey, 'base64url');
  const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3], 'base64url')), 'VAPID signature');
  const claims = JSON.parse(Buffer.from(m[2], 'base64url'));
  assert.equal(claims.aud, audience);
  assert.ok(claims.exp > Date.now() / 1000 && claims.exp <= Date.now() / 1000 + 24 * 3600);
  assert.ok(claims.sub);
}
const pngSize = (buf) => (buf.subarray(1, 4).toString() === 'PNG' ? [buf.readUInt32BE(16), buf.readUInt32BE(20)] : null);

test('the manifest, icons and page tags make the site installable', async () => {
  const r = await get('/manifest.webmanifest');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /application\/manifest\+json/);
  const m = await r.json();
  assert.equal(m.name, 'Hireriv by Raigozen');
  assert.equal(m.short_name, 'Hireriv');
  assert.equal(m.start_url, '/?source=pwa');
  assert.equal(m.scope, '/');
  assert.equal(m.display, 'standalone');
  assert.equal(m.theme_color, '#123B70');
  assert.equal(m.background_color, '#ffffff');
  assert.ok(m.version >= 1);
  const sizes = {};
  for (const icon of m.icons) {
    const res = await get(icon.src);
    assert.equal(res.status, 200, icon.src);
    assert.equal(res.headers.get('content-type'), 'image/png');
    const [w, h] = pngSize(Buffer.from(await res.arrayBuffer()));
    assert.equal(`${w}x${h}`, icon.sizes);
    sizes[`${icon.sizes} ${icon.purpose}`] = true;
  }
  assert.ok(sizes['192x192 any'] && sizes['512x512 any'] && sizes['512x512 maskable']);
  for (const s of m.shortcuts) assert.match(s.url, /^\/(?!\/)/);
  assert.deepEqual(pngSize(Buffer.from(await (await get('/img/icons/apple-touch-icon.png')).arrayBuffer())), [180, 180]);

  for (const page of ['/', '/jobs', '/jobs/hr-101', '/account/login', '/employer/login']) {
    const html = await (await get(page)).text();
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/, page);
    assert.match(html, /<link rel="manifest" href="\/manifest.webmanifest">/, page);
    assert.match(html, /<meta name="theme-color" content="#123B70">/, page);
    assert.match(html, /<link rel="apple-touch-icon" href="\/img\/icons\/apple-touch-icon.png">/, page);
  }
});

test('the service worker stores public files only and shows the offline page without a connection', async () => {
  const res = await get('/sw.js');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
  assert.equal(res.headers.get('cache-control'), 'no-cache');
  assert.equal(res.headers.get('service-worker-allowed'), '/');
  const code = await res.text();
  const version = (await (await get('/')).text()).match(/\/css\/style\.css\?v=([a-f0-9]+)/)[1];
  assert.match(code, new RegExp(`const VERSION = "${version}"`), 'the cache follows the asset version');

  for (const p of ['/css/style.css', '/js/main.js', '/img/logo.svg', '/img/icons/icon-192.png']) assert.ok(pwa.CACHEABLE.test(p), p);
  for (const p of ['/account', '/account/resume', '/api/notifications', '/api/me/notification-preferences', '/employer', '/employer/applicants', '/admin', '/client/invoices', '/uploads/cv.pdf', '/notifications', '/resumes/x.pdf', '/offline', '/']) assert.ok(!pwa.CACHEABLE.test(p), p);

  // Run the worker against stand-in browser APIs.
  const handlers = {};
  const store = new Map();
  const network = { up: true, fetched: [] };
  const response = (url, init = {}) => {
    const h = new Headers(init.headers || {});
    return { ok: (init.status || 200) < 400, status: init.status || 200, type: 'basic', url, headers: h, clone() { return this; }, body: init.body || url };
  };
  const urlOf = (r) => new URL(typeof r === 'string' ? r : r.url, 'https://hireriv.test').href;
  const cache = {
    async addAll(reqs) { for (const r of reqs) { network.fetched.push({ url: urlOf(r), credentials: r.credentials }); store.set(urlOf(r), response(urlOf(r))); } },
    async put(req, res) { store.set(urlOf(req), res); },
    async match(req) { return store.get(urlOf(req)); },
    async keys() { return [...store.keys()].map((url) => ({ url })); },
    async delete(req) { return store.delete(urlOf(req)); },
  };
  const sandbox = {
    self: { location: { origin: 'https://hireriv.test' }, addEventListener: (t, fn) => { handlers[t] = fn; }, clients: { claim: async () => {} }, skipWaiting: () => { sandbox.skipped = true; }, registration: {} },
    caches: { open: async () => cache, match: async (req) => store.get(urlOf(req)), keys: async () => ['hireriv-static-old', 'other-app'], delete: async (k) => { sandbox.deleted = (sandbox.deleted || []).concat(k); return true; } },
    fetch: async (req) => {
      network.fetched.push({ url: urlOf(req) });
      if (!network.up) throw new TypeError('Failed to fetch');
      const u = new URL(urlOf(req));
      if (u.pathname === '/img/private-test.png') return response(u.href, { headers: { 'Cache-Control': 'private' } });
      return response(u.href);
    },
    Request: class { constructor(url, init = {}) { this.url = urlOf(url); this.credentials = init.credentials; this.method = 'GET'; } },
    Response: class { constructor(body, init = {}) { this.body = body; this.status = init.status; } },
    URL, Headers, Promise, console,
  };
  vm.runInNewContext(code, sandbox);
  const run = async (type, extra) => {
    let waited = null;
    let responded = null;
    handlers[type]({ ...extra, waitUntil: (p) => { waited = p; }, respondWith: (p) => { responded = p; } });
    if (waited) await waited;
    return responded ? { res: await responded } : null;
  };
  await run('install', {});
  // Precached without cookies: the offline page, CSS, script and icons.
  assert.ok(network.fetched.every((f) => f.credentials === 'omit'));
  assert.ok(store.has('https://hireriv.test/offline'));
  assert.ok(store.has(`https://hireriv.test/css/style.css?v=${version}`));
  assert.ok([...store.keys()].every((u) => pwa.CACHEABLE.test(new URL(u).pathname) || new URL(u).pathname === '/offline'));
  await run('activate', {});
  assert.deepEqual(sandbox.deleted, ['hireriv-static-old'], 'old versions removed, other caches left alone');

  const req = (p, mode = 'cors', method = 'GET') => ({ request: { url: `https://hireriv.test${p}`, method, mode } });
  const before = store.size;
  // Pages, the API, resumes and dashboards are left to the network and never stored.
  for (const p of ['/api/notifications', '/api/me/notification-preferences', '/uploads/resume.pdf', '/employer/applicants.json']) assert.equal(await run('fetch', req(p)), null, p);
  assert.equal(await run('fetch', req('/api/apply', 'cors', 'POST')), null);
  for (const p of ['/account', '/employer', '/admin', '/notifications']) {
    const out = await run('fetch', req(p, 'navigate'));
    assert.equal(out.res.url, `https://hireriv.test${p}`, 'from the network');
  }
  assert.equal(store.size, before, 'nothing private was stored');
  // Public files are stored the first time they're fetched (unless marked private).
  await run('fetch', req('/img/photos/team.webp'));
  await sleep(10);
  assert.ok(store.has('https://hireriv.test/img/photos/team.webp'));
  await run('fetch', req('/img/private-test.png'));
  await sleep(10);
  assert.ok(!store.has('https://hireriv.test/img/private-test.png'));
  // Offline: pages fall back to the offline page.
  network.up = false;
  const off = await run('fetch', req('/account', 'navigate'));
  assert.equal(off.res.url, 'https://hireriv.test/offline');
  const css = await run('fetch', req(`/css/style.css?v=${version}`));
  assert.equal(css.res.url, `https://hireriv.test/css/style.css?v=${version}`, 'stylesheet from the cache');
  // An update waits until the page asks.
  assert.ok(!sandbox.skipped);
  handlers.message({ data: { type: 'SKIP_WAITING' } });
  assert.ok(sandbox.skipped);
});

test('the offline page is the same for everyone and never shows who is signed in', async () => {
  const cookie = await register('Mira Shah', 'mira@example.in');
  assert.match(await (await get('/account', cookie)).text(), /My account/);
  const r = await get('/offline', cookie);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('cache-control'), /public/);
  const html = await r.text();
  assert.match(html, /<h1>You are offline<\/h1>/);
  assert.match(html, /noindex/);
  assert.doesNotMatch(html, /My account|Mira|mira@example\.in|notification-bell/);
  assert.match(html, /data-retry/);
});

test('phone notification devices: validated, owned, never revealing the endpoint, removed on sign-out', async () => {
  const asha = await register('Asha Rao', 'asha@example.in');
  const ravi = await register('Ravi Nair', 'ravi@example.in');
  const api = '/api/devices/push-subscriptions';
  const dev = device();

  assert.equal((await call(api, 'POST', dev.json)).status, 401, 'sign in first');
  assert.equal((await call(api, 'POST', dev.json, asha, { origin: 'https://evil.example' })).status, 403, 'other sites are blocked');
  const bad = [
    { ...dev.json, endpoint: 'https://evil.example/push/1' },
    { ...dev.json, endpoint: 'http://fcm.googleapis.com/fcm/send/1' },
    { ...dev.json, endpoint: 'https://fcm.googleapis.com:8443/fcm/send/1' },
    { ...dev.json, endpoint: 'https://user:pw@fcm.googleapis.com/fcm/send/1' },
    { ...dev.json, keys: { ...dev.json.keys, p256dh: Buffer.alloc(65, 4).toString('base64url') } },
    { ...dev.json, keys: { ...dev.json.keys, p256dh: 'short' } },
    { ...dev.json, keys: { ...dev.json.keys, auth: Buffer.alloc(8).toString('base64url') } },
    { endpoint: dev.json.endpoint },
    'nonsense',
  ];
  for (const b of bad) assert.equal((await call(api, 'POST', b, asha)).status, 400, JSON.stringify(b).slice(0, 80));
  assert.equal(srv.records('push-subscriptions').length, 0);
  assert.ok(pushLib.endpointAllowed('https://fcm.googleapis.com/fcm/send/abc', {}));
  assert.ok(pushLib.endpointAllowed('https://web.push.apple.com/QGx', {}));
  assert.ok(!pushLib.endpointAllowed(`${pushOrigin}/push/1`, { NODE_ENV: 'production', PUSH_TEST_ORIGIN: pushOrigin }), 'the test stand-in only works in tests');

  const made = await call(api, 'POST', dev.json, asha);
  assert.equal(made.status, 201, made.raw);
  assert.equal(made.device.device, 'Android phone');
  assert.equal(made.device.thisSession, true);
  assert.doesNotMatch(made.raw, /endpoint|p256dh|auth|127\.0\.0\.1/);
  assert.equal((await call(api, 'POST', dev.json, asha)).status, 200, 'the same device again is not a second one');
  const list = await call(api, 'GET', undefined, asha);
  assert.equal(list.devices.length, 1);
  assert.match(list.publicKey, /^[\w-]{87}$/);
  assert.doesNotMatch(list.raw, /endpoint|p256dh|127\.0\.0\.1|"auth"/);
  assert.equal((await call(api, 'GET', undefined, ravi)).devices.length, 0, "Ravi doesn't see Asha's devices");

  // Someone else's device can't be removed by changing the id.
  const id = list.devices[0].id;
  assert.equal((await call(`${api}/${id}`, 'DELETE', undefined, ravi)).status, 404);
  assert.equal((await call(`${api}/${id}`, 'DELETE', undefined)).status, 401);
  assert.equal(srv.records('push-subscriptions').length, 1);
  // The settings page lists it, with a form to turn it off.
  const page = await (await get('/notifications/settings', asha)).text();
  assert.match(page, /Android phone<\/b> \(this sign-in\)/);
  assert.match(page, new RegExp(`action="/notifications/devices/${id}/delete"`));
  assert.match(page, /data-push data-key="[\w-]{87}"/);
  assert.match(page, /<button type="button" class="btn btn-primary btn-lg" data-push-on hidden>/, 'the browser is asked only when the button is pressed');
  assert.equal((await post(`/notifications/devices/${id}/delete`, {}, ravi)).status, 302);
  assert.equal(srv.records('push-subscriptions').length, 1, "Ravi's form doesn't remove it either");
  assert.equal((await call(`${api}/${id}`, 'DELETE', undefined, asha)).status, 200);
  assert.equal(srv.records('push-subscriptions').length, 0);

  // A device registered by Asha moves to Ravi when he signs in on it and registers it.
  await call(api, 'POST', dev.json, asha);
  assert.equal((await call(api, 'POST', dev.json, ravi)).status, 201);
  assert.equal((await call(api, 'GET', undefined, asha)).devices.length, 0);
  assert.equal((await call(api, 'GET', undefined, ravi)).devices.length, 1);

  // Signing out removes this sign-in's devices and clears the browser's cache.
  const out = await post('/account/logout', {}, ravi);
  assert.equal(out.status, 302);
  assert.equal(out.headers.get('clear-site-data'), '"cache"');
  assert.equal(srv.records('push-subscriptions').length, 0);
  // So do employer and team sign-outs.
  for (const p of ['/employer/logout', '/admin/logout']) assert.equal((await post(p, {}, '')).headers.get('clear-site-data'), '"cache"', p);
  const admin = await srv.adminLogin();
  assert.equal((await post('/admin/logout', {}, admin)).headers.get('clear-site-data'), '"cache"');
});

test('pushes are encrypted, signed, free of personal details, and follow the person\'s choices', async () => {
  const cookie = await register('Kiran Das', 'kiran@example.in');
  const api = '/api/devices/push-subscriptions';
  received.length = 0;

  // No device turned on: applying sends nothing to any push service.
  let r = await post('/account/apply/hr-114', {}, cookie);
  assert.match(decodeURIComponent(r.headers.get('location')), /Applied for/);
  await sleep(400);
  assert.equal(received.length, 0, 'no push without permission');

  const dev = device();
  assert.equal((await call(api, 'POST', dev.json, cookie)).status, 201);
  const publicKey = (await call(api, 'GET', undefined, cookie)).publicKey;
  r = await post('/account/apply/hr-113', {}, cookie);
  assert.equal(r.status, 302);
  await until(() => received.length);
  assert.equal(received.length, 1);
  const got = received[0];
  assert.equal(got.path, new URL(dev.json.endpoint).pathname);
  assert.equal(got.headers['content-encoding'], 'aes128gcm');
  assert.ok(Number(got.headers.ttl) > 0);
  verifyVapid(got.headers.authorization, publicKey, pushOrigin);
  const message = decrypt(got.body, dev);
  const n = (await call('/api/notifications', 'GET', undefined, cookie)).notifications.find((x) => x.category === 'applications');
  assert.deepEqual(message, { title: 'Hireriv', body: 'New applications update', url: `/notifications/${n.id}/open`, tag: 'applications' });
  assert.doesNotMatch(got.body.toString('latin1') + JSON.stringify(message), /Kiran|kiran@|CNC|9845012345/);
  assert.ok(srv.records('push-subscriptions')[0].lastSentAt);

  // Turning phone notifications off for applications stops them.
  const prefs = await call('/api/me/notification-preferences', 'PATCH', { push: { applications: false } }, cookie);
  assert.equal(prefs.status, 200, prefs.raw);
  assert.equal(prefs.push.applications, false);
  assert.equal(prefs.email.applications, true, 'email untouched');
  received.length = 0;
  await post('/account/apply/hr-115', {}, cookie);
  await sleep(400);
  assert.equal(received.length, 0);
  await call('/api/me/notification-preferences', 'PATCH', { push: { applications: true } }, cookie);

  // The push service says the browser turned it off (410): the device is removed.
  answer.status = 410;
  await post('/account/apply/hr-116', {}, cookie);
  await until(() => !srv.records('push-subscriptions').length);
  assert.equal(srv.records('push-subscriptions').length, 0);
  answer.status = 201;
});

test('notification preferences: email and phone per area, marketing only when asked, validated', async () => {
  const cookie = await register('Leela Iyer', 'leela@example.in');
  const me = '/api/me/notification-preferences';
  let p = await call(me, 'GET', undefined, cookie);
  assert.equal(p.status, 200);
  assert.equal(p.as, 'candidate');
  assert.deepEqual(p.push, { applications: true, interviews: true, jobs: true, work: true });
  assert.equal(p.marketing.email, false, 'marketing is off until the person agrees');
  assert.deepEqual((await call('/api/notification-preferences', 'GET', undefined, cookie)).email, p.email, 'the older address answers the same');
  assert.equal((await call(me, 'GET')).status, 401);

  for (const body of [{}, { email: { account: false } }, { push: { jobs: 'no' } }, { push: [] }, { marketing: 'yes' }, { sms: true }]) {
    assert.equal((await call(me, 'PATCH', body, cookie)).status, 400, JSON.stringify(body));
  }
  assert.equal((await call(me, 'PATCH', { email: { jobs: false } }, cookie, { origin: 'https://evil.example' })).status, 403);

  p = await call(me, 'PATCH', { marketing: { email: true } }, cookie);
  assert.equal(p.marketing.email, true);
  assert.ok(p.marketing.updatedAt);
  assert.ok(srv.records('newsletter').some((s) => s.email === 'leela@example.in'));
  p = await call(me, 'PATCH', { marketing: { email: false } }, cookie);
  assert.equal(p.marketing.email, false);
  assert.ok(!srv.records('newsletter').some((s) => s.email === 'leela@example.in'), 'withdrawing removes them from the list');
  const saved = srv.records('notification-preferences').find((x) => x.marketing && x.marketing.how === 'notification preferences API');
  assert.ok(saved && saved.marketing.at && saved.marketing.how, 'when and where consent changed is recorded');

  // The settings form saves both channels and the marketing choice.
  const r = await post('/notifications/settings', { email_applications: '1', push_interviews: '1', marketing: '1' }, cookie);
  assert.equal(r.status, 302);
  p = await call(me, 'GET', undefined, cookie);
  assert.deepEqual(p.email, { applications: true, interviews: false, jobs: false, work: false });
  assert.deepEqual(p.push, { applications: false, interviews: true, jobs: false, work: false });
  assert.equal(p.marketing.email, true);

  // The team has no marketing choice to make here.
  const admin = await srv.adminLogin();
  assert.equal((await call(me, 'GET', undefined, admin)).marketing, undefined);
  assert.equal((await call(me, 'PATCH', { marketing: true }, admin)).status, 400);
  assert.equal((await call(me, 'PATCH', { push: { jobs: false } }, admin)).status, 200);
});

test('applying on a phone: one application per job, status visible in the account', async () => {
  const cookie = await register('Sunil Pal', 'sunil@example.in');
  const first = await post('/account/apply/hr-114', {}, cookie);
  assert.match(decodeURIComponent(first.headers.get('location')), /Applied for Delivery Executive/);
  const again = await post('/account/apply/hr-114', {}, cookie);
  assert.match(decodeURIComponent(again.headers.get('location')), /already applied/);
  assert.equal(srv.records('applications').filter((a) => a.email === 'sunil@example.in' && a.jobId === 'hr-114').length, 1);
  const account = await (await get('/account', cookie)).text();
  assert.match(account, /id="applications"/);
  assert.match(account, /Delivery Executive/);
});

test('Find Jobs on a phone: kinds of work, folding filters, big tap targets, light pages', async () => {
  const html = await (await get('/jobs')).text();
  assert.match(html, /<nav class="work-tabs" aria-label="Kind of work">/);
  for (const label of ['Office &amp; professional', 'Skilled &amp; technical', 'Industrial, field &amp; service']) assert.ok(html.includes(label), label);
  assert.doesNotMatch(html, /collar/i);
  assert.match(html, /<details class="more-filters" open data-more-filters="0">/);
  for (const id of ['f-q', 'f-loc', 'f-exp', 'f-pay', 'f-type', 'f-mode', 'f-shift']) assert.match(html, new RegExp(`<label class="sr-only" for="${id}">`), id);
  const filtered = await (await get('/jobs?work=field&type=Full-time')).text();
  assert.match(filtered, /data-more-filters="1"/);
  assert.match(filtered, /href="[^"]*work=field[^"]*" title="[^"]*" aria-current="page">Industrial, field &amp; service/);

  // A job page shows pay, place, type and shift up front.
  const job = await (await get('/jobs/hr-114')).text();
  for (const dt of ['Pay', 'Workplace', 'Employment type', 'Work arrangement']) assert.match(job, new RegExp(`<dt>${dt}</dt>`), dt);

  const css = fs.readFileSync(path.join(ROOT, 'public/css/style.css'), 'utf8');
  assert.match(css, /@media \(max-width: 700px\) \{\n  \/\* Easy to tap: at least 44px high\. \*\/\n  [^}]*min-height: 44px;/);
  // Every table sits in a box that scrolls on its own, so pages never scroll sideways.
  for (const f of fs.readdirSync(path.join(ROOT, 'views')).filter((x) => x.endsWith('.ejs'))) {
    const s = fs.readFileSync(path.join(ROOT, 'views', f), 'utf8');
    for (let i = s.indexOf('<table'); i >= 0; i = s.indexOf('<table', i + 1)) {
      const before = s.slice(Math.max(0, i - 400), i);
      const wrap = Math.max(before.lastIndexOf('table-wrap'), before.lastIndexOf('scroll-x'));
      assert.ok(wrap >= 0 && before.lastIndexOf('</div>') < wrap, `${f}: table at line ${s.slice(0, i).split('\n').length} is not in a scrolling box`);
    }
  }
  assert.match(css, /\.table-wrap \{ overflow-x: auto;/);

  // Browsers asking to save data get no web font.
  const light = await get('/jobs', '', { 'save-data': 'on' });
  assert.match(light.headers.get('vary') || '', /Save-Data/i);
  assert.doesNotMatch(await light.text(), /fonts\.googleapis\.com/);
  assert.match(html, /fonts\.googleapis\.com/);
});

test('app use is counted without personal data; phone notifications are never requested on page load', async () => {
  assert.equal((await get('/?source=pwa')).status, 200);
  assert.equal((await call('/api/public/events', 'POST', { event: 'app-installed' })).status, 204);
  assert.equal((await call('/api/public/events', 'POST', { event: 'push-enabled' })).status, 400, 'only the server counts that');
  const rows = await until(() => {
    const all = srv.records('site-analytics');
    return all.some((x) => x.event === 'app-launch') && all.some((x) => x.event === 'app-installed') && all;
  });
  assert.ok(rows, 'counted');
  assert.equal(rows.find((x) => x.event === 'app-launch').label, 'Phone or tablet');
  assert.ok(rows.some((x) => x.event === 'push-enabled'));
  for (const x of rows) assert.deepEqual(Object.keys(x).sort(), ['count', 'day', 'event', 'id', 'label']);

  const js = fs.readFileSync(path.join(ROOT, 'public/js/main.js'), 'utf8');
  assert.equal(js.match(/requestPermission\(/g).length, 1);
  assert.match(js, /on\.addEventListener\('click', async \(\) => \{\n    on\.disabled = true;\n    try \{\n      const permission = await Notification\.requestPermission\(\);/);
  assert.doesNotMatch(js, /localStorage\.setItem\([^)]*(?:resume|email|token|phone)/i);
  // Sign-out forms clear the tab's storage and the device's push subscription.
  assert.match(js, /form\[action\$="\/logout"\]/);
  // The offline page and the robots rules.
  assert.match(await (await get('/robots.txt')).text(), /Disallow: \/account/);
});
