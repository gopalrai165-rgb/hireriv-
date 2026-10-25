// Web push for the installed app and the website: people turn on phone
// notifications themselves (never prompted on page load), each device is tied
// to the session that registered it, and nothing personal travels in a push.
//
// - A subscription belongs to the account signed in when it was registered
//   and to that sign-in: signing out, or the session expiring, removes it
//   before anything else is sent. Push services that answer 404 or 410 (the
//   person turned notifications off in the browser) remove it too.
// - Endpoints must be HTTPS addresses of a known browser push service, so the
//   server can't be pointed at an arbitrary host. The endpoint and keys are
//   never returned by the API or written to logs.
// - The message only says there is something new and in which area
//   ("New applications update"); the details open after signing in, with the
//   person's current permissions. It is encrypted for the device (RFC 8291)
//   and signed with this site's VAPID key (RFC 8292), whose private half is
//   never sent anywhere.
// - People choose which areas send pushes in Notification settings.
const crypto = require('crypto');

const COLLECTION = 'push-subscriptions';
const MAX_PER_ACCOUNT = 10;
const TTL_SECONDS = 24 * 3600;
// Browser push services (Chrome/Edge/Android, Firefox, Windows, Safari/iOS).
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^[a-z0-9-]+\.notify\.windows\.com$/, /^web\.push\.apple\.com$/, /^[a-z0-9.-]+\.push\.apple\.com$/];
// Which sign-in a subscription belongs to: the session store's kind and cookie.
const SESSIONS = { candidate: { kind: 'candidate', cookie: 'hr_cand' }, employer: { kind: 'employer', cookie: 'hr_emp' }, team: { kind: 'admin', cookie: 'hr_admin' } };

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const fromB64u = (s) => (typeof s === 'string' && /^[A-Za-z0-9_-]+={0,2}$/.test(s) ? Buffer.from(s.replace(/=+$/, ''), 'base64url') : Buffer.alloc(0));
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

function cookieValue(header, name) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch (e) { return ''; }
    }
  }
  return '';
}

// ---------- encryption (RFC 8291, aes128gcm) ----------
// Encrypts `payload` for a device's p256dh key and auth secret.
function encrypt(payload, p256dh, auth, { salt = crypto.randomBytes(16), ecdh = null } = {}) {
  const ua = Buffer.from(p256dh);
  const server = ecdh || crypto.createECDH('prime256v1');
  if (!ecdh) server.generateKeys();
  const asPublic = server.getPublicKey();
  const shared = server.computeSecret(ua);
  // IKM = HKDF(auth, shared, "WebPush: info" || 0 || ua_public || as_public, 32)
  const ikm = hmac(hmac(auth, shared), Buffer.concat([Buffer.from('WebPush: info\0'), ua, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  // One record; 0x02 marks it as the last.
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

// ---------- VAPID (RFC 8292) ----------
// From VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY (base64url, raw P-256), or made
// once and kept in the database.
function vapidKeys(db, env) {
  let pub = env.VAPID_PUBLIC_KEY;
  let priv = env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) {
    const stored = db.metaGet('push:vapid');
    if (stored) ({ pub, priv } = JSON.parse(stored));
    else {
      const ecdh = crypto.createECDH('prime256v1');
      ecdh.generateKeys();
      pub = b64u(ecdh.getPublicKey());
      priv = b64u(ecdh.getPrivateKey());
      db.metaSet('push:vapid', JSON.stringify({ pub, priv }));
    }
  }
  const raw = fromB64u(pub);
  const key = crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: b64u(fromB64u(priv)), x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33, 65)) }, format: 'jwk' });
  return { publicKey: pub, key };
}
function vapidHeader(endpoint, vapid, subject, nowMs) {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud, exp: Math.floor(nowMs / 1000) + 12 * 3600, sub: subject }));
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${claims}`), { key: vapid.key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${vapid.publicKey}`;
}

// ---------- validation ----------
function endpointAllowed(endpoint, env) {
  let u;
  try { u = new URL(endpoint); } catch (e) { return false; }
  if (endpoint.length > 1000 || u.username || u.password) return false;
  // Tests point pushes at a local stand-in; never in production.
  if (env.NODE_ENV === 'test' && env.PUSH_TEST_ORIGIN && u.origin === env.PUSH_TEST_ORIGIN) return true;
  return u.protocol === 'https:' && (!u.port || u.port === '443') && PUSH_HOSTS.some((re) => re.test(u.hostname));
}
// { endpoint, keys: { p256dh, auth } } as the browser's PushSubscription.toJSON() gives it.
function parseSubscription(input, env) {
  const s = input && typeof input === 'object' ? input.subscription || input : null;
  if (!s || typeof s.endpoint !== 'string' || !s.keys || typeof s.keys !== 'object') return { error: 'send the browser subscription: { endpoint, keys: { p256dh, auth } }' };
  if (!endpointAllowed(s.endpoint, env)) return { error: 'this push service is not supported' };
  const p256dh = fromB64u(s.keys.p256dh);
  const auth = fromB64u(s.keys.auth);
  if (p256dh.length !== 65 || p256dh[0] !== 4) return { error: 'the device key is not valid' };
  if (auth.length !== 16) return { error: 'the device secret is not valid' };
  // A point on the P-256 curve (convertKey refuses anything else).
  try { crypto.ECDH.convertKey(p256dh, 'prime256v1'); } catch (e) { return { error: 'the device key is not valid' }; }
  return { endpoint: s.endpoint, p256dh: b64u(p256dh), auth: b64u(auth) };
}
// A short device label from the browser ("Android phone", "iPhone", "Windows computer").
function deviceLabel(ua) {
  const s = String(ua || '');
  if (/iPhone/.test(s)) return 'iPhone';
  if (/iPad/.test(s)) return 'iPad';
  if (/Android/.test(s)) return /Mobile/.test(s) ? 'Android phone' : 'Android tablet';
  if (/Windows/.test(s)) return 'Windows computer';
  if (/Macintosh/.test(s)) return 'Mac';
  if (/Linux|CrOS/.test(s)) return 'Computer';
  return 'Device';
}

function create({ db, env = process.env, siteUrl = '', now = () => Date.now(), log = console, fetchImpl = (...a) => fetch(...a) }) {
  const iso = () => new Date(now()).toISOString();
  db.uniqueKey(COLLECTION, (s) => s.endpointHash || null);
  let vapid = null;
  const keys = () => vapid || (vapid = vapidKeys(db, env));
  const subject = env.VAPID_SUBJECT || (/^https:/.test(siteUrl) ? siteUrl : 'mailto:support@hireriv.com');

  // The session this request is signed in with, for the account it acts as.
  function sessionOf(req, as) {
    const s = SESSIONS[as];
    const token = s && cookieValue(req.headers.cookie, s.cookie);
    if (!token) return null;
    const key = sha(token);
    const row = db.sessions.get(s.kind, key);
    return row ? { kind: s.kind, key, subject: row.subject } : null;
  }
  const live = (sub) => {
    const row = db.sessions.get(sub.session.kind, sub.session.key);
    return Boolean(row && row.subject === sub.session.subject);
  };
  const view = (s, req) => ({ id: s.id, device: s.device, createdAt: s.createdAt, lastSentAt: s.lastSentAt || null, thisSession: Boolean(req && sessionOf(req, s.as) && sessionOf(req, s.as).key === s.session.key) });
  const mine = (rk) => db.where(COLLECTION, 'rk', rk);

  // Removes subscriptions whose sign-in has ended.
  function sweep(list = db.all(COLLECTION)) {
    const dead = list.filter((s) => !live(s)).map((s) => s.id);
    if (dead.length) db.remove(COLLECTION, dead);
    return dead.length;
  }
  function list(viewer) {
    sweep(mine(viewer.rk));
    return mine(viewer.rk);
  }
  function add(req, viewer, input) {
    const parsed = parseSubscription(input, env);
    if (parsed.error) return { status: 400, error: parsed.error };
    const session = sessionOf(req, viewer.as);
    if (!session) return { status: 401, error: 'sign in first' };
    const endpointHash = sha(parsed.endpoint);
    return db.transaction(() => {
      // A device re-registering moves to whoever is signed in on it now.
      const existing = db.where(COLLECTION, 'endpointHash', endpointHash)[0];
      if (existing) db.remove(COLLECTION, [existing.id]);
      const current = list(viewer);
      if (current.length >= MAX_PER_ACCOUNT) db.remove(COLLECTION, [current[current.length - 1].id]);
      const doc = {
        id: crypto.randomUUID(), rk: viewer.rk, as: viewer.as, session: { kind: session.kind, key: session.key, subject: session.subject },
        endpoint: parsed.endpoint, endpointHash, keys: { p256dh: parsed.p256dh, auth: parsed.auth }, device: deviceLabel(req.get('User-Agent')),
        createdAt: iso(), lastSentAt: null, failures: 0,
      };
      db.prepend(COLLECTION, doc);
      return { status: existing && existing.rk === viewer.rk ? 200 : 201, subscription: doc, moved: Boolean(existing && existing.rk !== viewer.rk) };
    });
  }
  // Only the owner can remove one; anyone else gets "not found".
  function remove(viewer, id) {
    const s = mine(viewer.rk).find((x) => x.id === id);
    if (!s) return false;
    db.remove(COLLECTION, [s.id]);
    return true;
  }
  // Signing out removes the devices registered with that sign-in.
  function forgetSession(req) {
    let n = 0;
    for (const as of Object.keys(SESSIONS)) {
      const token = cookieValue(req.headers.cookie, SESSIONS[as].cookie);
      if (!token) continue;
      const key = sha(token);
      const ids = db.all(COLLECTION).filter((s) => s.session.kind === SESSIONS[as].kind && s.session.key === key).map((s) => s.id);
      if (ids.length) db.remove(COLLECTION, ids);
      n += ids.length;
    }
    return n;
  }
  // Account deletion.
  function forget(rk) {
    const ids = mine(rk).map((s) => s.id);
    if (ids.length) db.remove(COLLECTION, ids);
  }

  async function sendTo(sub, message) {
    const body = encrypt(JSON.stringify(message), fromB64u(sub.keys.p256dh), fromB64u(sub.keys.auth));
    let res;
    try {
      res = await fetchImpl(sub.endpoint, {
        method: 'POST', body, redirect: 'manual', signal: AbortSignal.timeout(10000),
        headers: { 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: String(TTL_SECONDS), Urgency: 'normal', Authorization: vapidHeader(sub.endpoint, keys(), subject, now()) },
      });
    } catch (e) {
      return 'failed';
    }
    const current = db.where(COLLECTION, 'endpointHash', sub.endpointHash)[0];
    if (!current || current.id !== sub.id) return 'gone';
    if (res.status === 404 || res.status === 410) {
      db.remove(COLLECTION, [sub.id]);
      return 'gone';
    }
    if (res.status >= 200 && res.status < 300) {
      db.update(COLLECTION, { ...current, lastSentAt: iso(), failures: 0 });
      return 'sent';
    }
    // Repeated refusals (a revoked key, a broken subscription) remove it.
    if (current.failures + 1 >= 5) db.remove(COLLECTION, [sub.id]);
    else db.update(COLLECTION, { ...current, failures: current.failures + 1 });
    return 'failed';
  }
  // Sends one in-app notification to the recipient's devices, if they asked
  // for pushes in its area. Resolves to the number sent.
  async function deliver(n, allowed) {
    const subs = mine(n.rk);
    if (!subs.length || !allowed(n)) return 0;
    sweep(subs);
    const message = { title: 'Hireriv', body: n.categoryLabel ? `New ${n.categoryLabel.toLowerCase()} update` : 'You have a new notification', url: `/notifications/${n.id}/open`, tag: n.category || 'hireriv' };
    let sent = 0;
    for (const s of mine(n.rk)) if ((await sendTo(s, message)) === 'sent') sent++;
    return sent;
  }
  return { COLLECTION, publicKey: () => keys().publicKey, list, add, remove, forgetSession, forget, sweep, deliver, view };
}

module.exports = { create, encrypt, parseSubscription, endpointAllowed, deviceLabel, PUSH_HOSTS, MAX_PER_ACCOUNT };
