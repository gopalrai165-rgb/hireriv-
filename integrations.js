// The public API (v1) and integrations (Step 65): credentials for a company's
// own systems (an ATS, a job board feed, an HR tool), short-lived access
// tokens with scopes, per-client rate limits, idempotency keys, signed
// webhooks from an outbox with retries, delivery logs and replays, and a
// sandbox with its own sample data.
//
// Rules: a secret is shown once, then only its last four characters; only
// hashes are stored. Tokens go in the Authorization header, never the URL,
// and cookies are never accepted here. Every call is limited to the company
// the credential belongs to: an id from another company is "not found".
// Jobs sent through the API are reviewed by Hireriv like any other.
// Webhook payloads carry ids and states, not candidates' personal details.
// Delivery is at least once: receivers dedupe on the event id.
const crypto = require('crypto');
const { safeRequest, checkUrl, resolveSafe } = require('./safe-fetch');
const ats = require('./ats');

const DAY = 86400000;
const TOKEN_TTL_S = 900;
const ROTATION_GRACE_MS = DAY;
const MAX_ATTEMPTS = 8;
const DISABLE_AFTER = 20;
// Requests a minute per integration (API_RATE_LIVE and API_RATE_SANDBOX override them).
const RATE = { live: Number(process.env.API_RATE_LIVE) || 600, sandbox: Number(process.env.API_RATE_SANDBOX) || 120 };
const KEEP_DELIVERIES_DAYS = 30;
const API_VERSION = '2026-10-25';

const SCOPES = {
  'jobs:read': 'Read the company’s jobs',
  'jobs:write': 'Create and edit jobs, send them for review and close them',
  'applications:read': 'Read applications to the company’s jobs (without contact details)',
  'applications:contact': 'Also read applicants’ email and phone',
  'applications:status:update': 'Move applications along the hiring stages',
  'webhooks:manage': 'Manage webhook endpoints, see deliveries and replay them',
};
const EVENTS = {
  'job.submitted': 'A job was sent for Hireriv’s review',
  'job.published': 'A job went live',
  'job.rejected': 'A job was sent back with changes to make',
  'job.closed': 'A job closed',
  'application.created': 'Someone applied to a job',
  'application.status_changed': 'An application moved to another stage',
  'interview.scheduled': 'An interview was booked',
};
const C = { clients: 'integration-clients', creds: 'integration-credentials', tokens: 'integration-tokens', endpoints: 'webhook-endpoints', deliveries: 'webhook-deliveries', events: 'integration-events', idem: 'integration-idempotency', sandbox: 'integration-sandbox' };

const iso = (ms = Date.now()) => new Date(ms).toISOString();
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const clip = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
const b64u = (buf) => buf.toString('base64url');
const safeEqual = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const mask = (prefix, last4) => `${prefix}…${last4}`;

function create(deps) {
  const { db, app, clients, hiring, getJobs, readSubmissions, limit, sameOrigin, adminAuth, mailer, site, baseUrl, record, roles, adminNav } = deps;
  const { requireEmployer, allow, team } = clients;
  const allowPrivate = process.env.WEBHOOKS_ALLOW_PRIVATE === '1' && process.env.NODE_ENV !== 'production';
  if (!db.metaGet('secret:integrations')) db.metaSet('secret:integrations', crypto.randomBytes(32).toString('hex'));
  const pepper = () => db.metaGet('secret:integrations');
  const hmac = (s) => crypto.createHmac('sha256', pepper()).update(String(s)).digest('hex');
  const one = (coll, field, value) => db.where(coll, field, String(value))[0] || null;

  // ---------- clients and credentials ----------
  const clientsOf = (employerId) => db.where(C.clients, 'employerId', employerId);
  const credsOf = (clientId) => db.where(C.creds, 'clientId', clientId);
  // A new secret: hrv_live_<key id>_<random>. Only its hash is kept.
  function issueCredential(client, by) {
    const keyId = crypto.randomBytes(6).toString('hex');
    const prefix = `hrv_${client.environment === 'sandbox' ? 'test' : 'live'}_${keyId}`;
    const secret = `${prefix}_${b64u(crypto.randomBytes(32))}`;
    const cred = { id: crypto.randomUUID(), clientId: client.id, employerId: client.employerId, keyId, prefix, last4: secret.slice(-4), hash: hmac(secret), createdAt: iso(), createdBy: by.name, revokedAt: null, expiresAt: null, lastUsedAt: null };
    db.prepend(C.creds, cred);
    return { cred, secret };
  }
  function parseScopes(input) {
    const list = [...new Set([].concat(input || []).flatMap((s) => String(s).split(/[\s,]+/)).filter(Boolean))];
    const bad = list.filter((s) => !SCOPES[s]);
    return { scopes: list.filter((s) => SCOPES[s]), bad };
  }
  function createClient(emp, by, input) {
    const name = clip(input.name, 80);
    const environment = input.environment === 'sandbox' ? 'sandbox' : 'live';
    const { scopes, bad } = parseScopes(input.scopes);
    const errors = [];
    if (name.length < 2) errors.push('give the integration a name (for example "Our ATS")');
    if (bad.length) errors.push(`unknown scopes: ${bad.join(', ')}`);
    if (!scopes.length) errors.push('choose at least one permission');
    if (scopes.includes('applications:contact') && !scopes.includes('applications:read')) errors.push('applications:contact needs applications:read');
    if (clientsOf(emp.id).filter((c) => c.status === 'active').length >= 10) errors.push('a company can have up to 10 active integrations');
    if (errors.length) return { errors };
    const client = { id: `int_${crypto.randomBytes(8).toString('hex')}`, employerId: emp.id, name, environment, scopes, status: 'active', createdAt: iso(), createdBy: by.name, createdById: by.id, revokedAt: null };
    db.prepend(C.clients, client);
    const { cred, secret } = issueCredential(client, by);
    if (environment === 'sandbox') seedSandbox(client);
    team.audit(emp.id, by, 'integration-created', `${name} (${environment}; ${scopes.join(' ')}; key ${mask(cred.prefix, cred.last4)})`);
    tellOwners(emp, { subject: `A new ${site.name} API key for ${emp.company}`, heading: 'A new API key was created', intro: `${by.name} created the integration "${name}" (${environment}) with these permissions: ${scopes.join(', ')}. If you did not expect this, revoke it under Integrations.` });
    return { client, cred, secret, errors: [] };
  }
  // A new secret; the old one keeps working for a day (or stops now).
  function rotate(emp, by, clientId, { now = false } = {}) {
    const client = one(C.clients, 'id', clientId);
    if (!client || client.employerId !== emp.id || client.status !== 'active') return { errors: ['integration not found'] };
    const live = credsOf(client.id).filter((c) => !c.revokedAt && (!c.expiresAt || c.expiresAt > iso()));
    for (const c of live) {
      db.update(C.creds, now ? { ...c, revokedAt: iso(), revokedBy: by.name } : { ...c, expiresAt: iso(Date.now() + ROTATION_GRACE_MS) });
      if (now) revokeTokens((t) => t.credentialId === c.id);
    }
    const { cred, secret } = issueCredential(client, by);
    team.audit(emp.id, by, 'integration-key-rotated', `${client.name}: new key ${mask(cred.prefix, cred.last4)}; old key ${now ? 'stopped now' : 'works for 24 hours'}`);
    return { client, cred, secret, errors: [] };
  }
  function revokeTokens(fn) {
    const gone = db.all(C.tokens).filter(fn);
    if (gone.length) db.remove(C.tokens, gone.map((t) => t.id));
  }
  // Stops the integration at once: its keys, tokens and webhooks.
  function revoke(client, by, reason = '') {
    if (client.status !== 'active') return { errors: ['this integration is already revoked'] };
    db.update(C.clients, { ...client, status: 'revoked', revokedAt: iso(), revokedBy: by.name, revokeReason: clip(reason, 300) });
    for (const c of credsOf(client.id).filter((x) => !x.revokedAt)) db.update(C.creds, { ...c, revokedAt: iso(), revokedBy: by.name });
    revokeTokens((t) => t.clientId === client.id);
    // Its sandbox endpoints, and the endpoints it added (a leaked key could have added one).
    for (const e of db.where(C.endpoints, 'employerId', client.employerId).filter((x) => x.status === 'active' && (x.clientId === client.id || x.createdByClientId === client.id))) db.update(C.endpoints, { ...e, status: 'disabled', disabledReason: 'The integration was revoked', disabledAt: iso() });
    team.audit(client.employerId, by, 'integration-revoked', `${client.name}${reason ? `: ${clip(reason, 300)}` : ''}`);
    return { errors: [] };
  }
  const owners = (emp) => team.owners(emp.id).map((m) => team.userById(m.userId)).filter(Boolean);
  function tellOwners(emp, { subject, heading, intro }) {
    for (const u of owners(emp)) mailer.notice({ ...emp, name: u.name, email: u.email }, { subject, heading, intro, rows: [], link: `${baseUrl}/employer/integrations`, label: 'Open Integrations' });
  }

  // ---------- tokens ----------
  // client_credentials: the secret (in the body or HTTP Basic) for a 15-minute token.
  function exchange(input, basic) {
    const secret = clip(basic ? basic.pass : input.client_secret, 200);
    const fail = { status: 401, code: 'invalid_client', message: 'the client secret is not valid' };
    if (String(input.grant_type || '') !== 'client_credentials') return { status: 400, code: 'unsupported_grant_type', message: 'grant_type must be client_credentials' };
    const m = secret.match(/^hrv_(live|test)_([a-f0-9]{12})_[A-Za-z0-9_-]{43}$/);
    if (!m) return fail;
    const cred = one(C.creds, 'keyId', m[2]);
    if (!cred || !safeEqual(cred.hash, hmac(secret)) || cred.revokedAt || (cred.expiresAt && cred.expiresAt <= iso())) return fail;
    const client = one(C.clients, 'id', cred.clientId);
    const askedId = clip(basic ? basic.user : input.client_id, 60);
    if (!client || client.status !== 'active' || (askedId && askedId !== client.id)) return fail;
    const emp = clients.read().find((e) => e.id === client.employerId);
    if (!emp || !emp.active || emp.suspension || emp.terminatedAt) return { status: 403, code: 'account_inactive', message: 'this company account is not active' };
    const asked = input.scope ? parseScopes(input.scope) : { scopes: client.scopes, bad: [] };
    if (asked.bad.length || asked.scopes.some((s) => !client.scopes.includes(s))) return { status: 400, code: 'invalid_scope', message: `this integration may ask for: ${client.scopes.join(' ')}` };
    const token = `hrv_at_${b64u(crypto.randomBytes(32))}`;
    db.prepend(C.tokens, { id: crypto.randomUUID(), tokenHash: sha(token), clientId: client.id, credentialId: cred.id, employerId: client.employerId, environment: client.environment, scopes: asked.scopes, exp: Date.now() + TOKEN_TTL_S * 1000, createdAt: iso() });
    db.update(C.creds, { ...cred, lastUsedAt: iso() });
    return { status: 200, body: { access_token: token, token_type: 'Bearer', expires_in: TOKEN_TTL_S, scope: asked.scopes.join(' ') } };
  }
  setInterval(() => revokeTokens((t) => t.exp < Date.now()), 10 * 60000).unref();

  // ---------- requests ----------
  const fail = (res, status, code, message, details) => res.status(status).json({ error: { code, message, ...(details ? { details } : {}) } });
  // Per-integration limits, in memory per process: a fixed one-minute window.
  const windows = new Map();
  function rateLimit(req, res) {
    const max = RATE[req.integration.client.environment];
    const now = Date.now();
    const key = req.integration.client.id;
    let w = windows.get(key);
    if (!w || w.reset <= now) { w = { reset: now + 60000, used: 0 }; windows.set(key, w); }
    w.used++;
    res.set({ 'RateLimit-Limit': String(max), 'RateLimit-Remaining': String(Math.max(0, max - w.used)), 'RateLimit-Reset': String(Math.ceil((w.reset - now) / 1000)) });
    if (w.used > max) { res.set('Retry-After', String(Math.ceil((w.reset - now) / 1000))); fail(res, 429, 'rate_limited', `up to ${max} requests a minute; try again shortly`); return false; }
    return true;
  }
  // Authorization: Bearer <token>. Sets the company, a member acting for the
  // integration (its scopes decide what it may do) and the person shown in logs.
  const apiAuth = (scope) => (req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'Hireriv-Api-Version': API_VERSION });
    if (req.query.access_token || req.query.client_secret) return fail(res, 400, 'token_in_url', 'send the token in the Authorization header, never in the address');
    const h = String(req.get('authorization') || '');
    const m = h.match(/^Bearer\s+(hrv_at_[A-Za-z0-9_-]{43})$/);
    if (!m) { res.set('WWW-Authenticate', 'Bearer realm="hireriv"'); return fail(res, 401, 'unauthorized', 'send a valid access token: Authorization: Bearer <token>'); }
    const t = one(C.tokens, 'tokenHash', sha(m[1]));
    const client = t && one(C.clients, 'id', t.clientId);
    if (!t || t.exp < Date.now() || !client || client.status !== 'active') { res.set('WWW-Authenticate', 'Bearer realm="hireriv", error="invalid_token"'); return fail(res, 401, 'invalid_token', 'the access token is not valid or has expired'); }
    const emp = clients.read().find((e) => e.id === t.employerId);
    if (!emp || !emp.active || emp.suspension || emp.terminatedAt) return fail(res, 403, 'account_inactive', 'this company account is not active');
    req.integration = { client, scopes: t.scopes, sandbox: client.environment === 'sandbox' };
    if (!rateLimit(req, res)) return;
    if (scope && !t.scopes.includes(scope)) { res.set('WWW-Authenticate', `Bearer realm="hireriv", error="insufficient_scope", scope="${scope}"`); return fail(res, 403, 'insufficient_scope', `this token needs the ${scope} permission`); }
    const creator = team.userById(client.createdById) || {};
    req.employer = emp;
    req.employerUser = { id: `integration:${client.id}`, name: `${client.name} (API)`, email: creator.email || '', phoneVerifiedAt: creator.phoneVerifiedAt || null };
    req.member = { employerId: emp.id, userId: req.employerUser.id, role: 'owner', jobIds: [] };
    next();
  };
  // Idempotency-Key on POST: the same key and body give the same answer; a
  // different body with the same key is refused. Kept for 24 hours.
  const idempotent = (req, res, next) => {
    const key = req.get('idempotency-key');
    if (!key) return next();
    if (!/^[A-Za-z0-9_.:-]{1,100}$/.test(key)) return fail(res, 400, 'invalid_idempotency_key', 'Idempotency-Key must be 1 to 100 letters, digits or _ . : -');
    const id = sha(`${req.integration.client.id}|${req.method}|${req.path}|${key}`);
    const bodyHash = sha(JSON.stringify(req.body || {}));
    const prev = one(C.idem, 'key', id);
    if (prev && prev.createdAt > iso(Date.now() - DAY)) {
      if (prev.bodyHash !== bodyHash) return fail(res, 422, 'idempotency_key_reused', 'this Idempotency-Key was used with a different request');
      res.set('Idempotent-Replayed', 'true');
      return res.status(prev.status).json(prev.body);
    }
    const json = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode < 500) {
        try { if (prev) db.remove(C.idem, [prev.id]); db.prepend(C.idem, { id: crypto.randomUUID(), key: id, bodyHash, status: res.statusCode, body, createdAt: iso() }); } catch (e) { /* a parallel request kept its answer first */ }
      }
      return json(body);
    };
    next();
  };
  // Pages of results: ?limit=1..100 and an opaque cursor.
  function page(list, req) {
    const size = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 25));
    let offset = 0;
    if (req.query.cursor) { const n = Number.parseInt(Buffer.from(String(req.query.cursor), 'base64url').toString(), 10); offset = Number.isInteger(n) && n >= 0 ? n : 0; }
    const rows = list.slice(offset, offset + size);
    const more = offset + size < list.length;
    return { data: rows, has_more: more, next_cursor: more ? Buffer.from(String(offset + size)).toString('base64url') : null };
  }

  // ---------- what the API returns ----------
  const jobOut = (j) => ({ ...hiring.employerJobView(j), updatedAt: j.updatedAt || j.submittedAt || null });
  function applicationOut(a, job, scopes) {
    const v = {
      id: a.id, jobId: a.jobId, jobTitle: job.title, appliedAt: a.createdAt, status: ats.stageOf(a), stageLabel: ats.label(ats.stageOf(a)), withdrawn: Boolean(a.withdrawnAt),
      name: a.name, experience: a.experience || '', location: a.location || '', noticePeriod: a.noticePeriod || '', skills: a.skills || '',
      history: (a.history || []).map((h) => ({ at: h.at, from: h.from, to: h.to })), allowedMoves: ats.allowedMoves(a), updatedAt: a.updatedAt || a.createdAt,
    };
    if (scopes.includes('applications:contact')) Object.assign(v, { email: a.email || '', phone: a.phone || '' });
    return v;
  }
  const companyJobs = (req) => getJobs().filter((j) => j.employerId === req.employer.id && !j.sample);
  const companyJob = (req, id) => companyJobs(req).find((j) => j.id === id && hiring.selfManaged(j)) || null;
  function companyApplications(req) {
    const jobs = new Map(companyJobs(req).filter((j) => hiring.selfManaged(j)).map((j) => [j.id, j]));
    return { jobs, list: readSubmissions('applications').filter((a) => !a.duplicateOf && jobs.has(a.jobId)) };
  }

  // ---------- events and webhooks ----------
  // Each event is stored once and copied to the outbox of every endpoint that wants it.
  function emit(type, employerId, data, { environment = 'live', clientId = '' } = {}) {
    if (!employerId || (!EVENTS[type] && type !== 'webhook.test')) return null;
    const ev = { id: `evt_${crypto.randomBytes(12).toString('hex')}`, type, employerId, environment, clientId, data, createdAt: iso() };
    const targets = db.where(C.endpoints, 'employerId', employerId).filter((e) => e.status === 'active' && e.environment === environment && (type === 'webhook.test' || e.events.includes(type)) && (environment !== 'sandbox' || e.clientId === clientId));
    db.transaction(() => {
      db.prepend(C.events, ev);
      for (const e of targets) db.prepend(C.deliveries, { id: `whd_${crypto.randomBytes(10).toString('hex')}`, endpointId: e.id, employerId, eventId: ev.id, type, status: 'pending', attempts: 0, nextAttemptAt: iso(), createdAt: iso(), log: [] });
    });
    if (targets.length) setImmediate(() => { tick().catch(() => {}); });
    return ev;
  }
  // The signing secret is derived, never stored: whsec_ + HMAC(server key, endpoint, version).
  const signingSecret = (e, version = e.secretVersion) => `whsec_${b64u(crypto.createHmac('sha256', pepper()).update(`webhook:${e.id}:${version}`).digest())}`;
  // Hireriv-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body">. During a
  // rotation the old secret signs too, so receivers can switch without a gap.
  function signatureHeader(e, body, t) {
    const sig = (secret) => crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
    const parts = [`t=${t}`, `v1=${sig(signingSecret(e))}`];
    if (e.previousVersion && e.previousUntil && e.previousUntil > iso()) parts.push(`v1=${sig(signingSecret(e, e.previousVersion))}`);
    return parts.join(',');
  }
  const backoff = (attempt) => { const base = Math.min(6 * 3600000, 30000 * 2 ** (attempt - 1)); return Math.round(base * (0.8 + Math.random() * 0.4)); };
  let running = false;
  async function deliver(d) {
    const e = one(C.endpoints, 'id', d.endpointId);
    const ev = one(C.events, 'id', d.eventId);
    if (!e || !ev || e.status !== 'active') { db.update(C.deliveries, { ...d, status: 'cancelled', finishedAt: iso() }); return; }
    const body = JSON.stringify({ id: ev.id, type: ev.type, created_at: ev.createdAt, api_version: 'v1', environment: ev.environment, data: ev.data });
    const t = Math.floor(Date.now() / 1000);
    const attempt = d.attempts + 1;
    const started = Date.now();
    const r = await safeRequest(e.url, {
      method: 'POST', body, allowPrivate,
      headers: { 'content-type': 'application/json', 'user-agent': `${site.name}-Webhooks/1.0`, 'hireriv-event-id': ev.id, 'hireriv-event-type': ev.type, 'hireriv-delivery-id': d.id, 'hireriv-delivery-attempt': String(attempt), 'hireriv-signature': signatureHeader(e, body, t) },
    });
    const ok = !r.error && r.status >= 200 && r.status < 300;
    const entry = { at: iso(), attempt, status: r.status || null, ms: Date.now() - started, error: ok ? null : clip(r.error || `answered ${r.status}`, 160), response: ok ? null : clip(r.body, 300) };
    const cur = one(C.deliveries, 'id', d.id) || d;
    const done = ok || attempt >= MAX_ATTEMPTS;
    db.update(C.deliveries, { ...cur, attempts: attempt, status: ok ? 'delivered' : done ? 'failed' : 'pending', lastStatus: entry.status, lastError: entry.error, nextAttemptAt: done ? null : iso(Date.now() + backoff(attempt)), finishedAt: done ? iso() : null, log: [...(cur.log || []), entry].slice(-MAX_ATTEMPTS) });
    const ep = one(C.endpoints, 'id', e.id);
    if (ok) db.update(C.endpoints, { ...ep, consecutiveFailures: 0, lastSuccessAt: iso() });
    else if (done) {
      const fails = (ep.consecutiveFailures || 0) + 1;
      const disable = fails >= DISABLE_AFTER;
      db.update(C.endpoints, { ...ep, consecutiveFailures: fails, lastFailureAt: iso(), ...(disable ? { status: 'disabled', disabledAt: iso(), disabledReason: `${fails} deliveries in a row failed` } : {}) });
      if (disable) { const emp = clients.read().find((x) => x.id === ep.employerId); if (emp) tellOwners(emp, { subject: `A webhook for ${emp.company} was turned off`, heading: 'A webhook endpoint was turned off', intro: `${fails} deliveries in a row to ${ep.url} failed, so we stopped sending to it. Fix the endpoint, turn it back on under Integrations and replay what it missed.` }); }
    }
  }
  async function tick() {
    if (running) return;
    running = true;
    try {
      const due = db.where(C.deliveries, 'status', 'pending').filter((d) => d.nextAttemptAt <= iso()).slice(0, 20);
      for (const d of due) await deliver(d);
    } finally { running = false; }
  }
  setInterval(() => { tick().catch((e) => console.error('Webhook delivery failed:', e.message)); }, Number(process.env.WEBHOOK_TICK_MS) || 5000).unref();
  // Old deliveries, events, idempotency answers and expired keys go.
  function prune() {
    const cutoff = iso(Date.now() - KEEP_DELIVERIES_DAYS * DAY);
    const old = (coll, field) => db.all(coll).filter((x) => x[field] && x[field] < cutoff).map((x) => x.id);
    for (const [coll, ids] of [[C.deliveries, db.all(C.deliveries).filter((d) => d.status !== 'pending' && d.createdAt < cutoff).map((d) => d.id)], [C.events, old(C.events, 'createdAt')], [C.idem, db.all(C.idem).filter((x) => x.createdAt < iso(Date.now() - DAY)).map((x) => x.id)]]) if (ids.length) db.remove(coll, ids);
  }
  setInterval(() => { try { prune(); } catch (e) { console.error('Integration retention failed:', e.message); } }, DAY).unref();

  async function validateEndpointUrl(raw) {
    const c = checkUrl(raw, { allowPrivate });
    if (c.error) return { error: c.error };
    const r = await resolveSafe(c.url, { allowPrivate });
    return r.error ? { error: r.error } : { url: c.url.toString() };
  }
  async function createEndpoint(emp, by, input, { environment = 'live', clientId = '', viaClientId = null } = {}) {
    const events = [...new Set([].concat(input.events || []).map(String))];
    const errors = [];
    const bad = events.filter((x) => !EVENTS[x]);
    if (!events.length) errors.push('choose at least one event');
    if (bad.length) errors.push(`unknown events: ${bad.join(', ')}`);
    if (db.where(C.endpoints, 'employerId', emp.id).filter((e) => e.status !== 'deleted').length >= 10) errors.push('a company can have up to 10 webhook endpoints');
    const v = await validateEndpointUrl(input.url);
    if (v.error) errors.push(v.error);
    if (errors.length) return { errors };
    const e = { id: `whe_${crypto.randomBytes(8).toString('hex')}`, employerId: emp.id, clientId, environment, url: v.url, events, description: clip(input.description, 120), status: 'active', secretVersion: 1, consecutiveFailures: 0, createdAt: iso(), createdBy: by.name, createdByClientId: viaClientId };
    db.prepend(C.endpoints, e);
    team.audit(emp.id, by, 'webhook-created', `${e.url} (${environment}; ${events.join(' ')})`);
    return { endpoint: e, secret: signingSecret(e), errors: [] };
  }
  function rotateEndpointSecret(e, by) {
    const next = { ...e, previousVersion: e.secretVersion, previousUntil: iso(Date.now() + ROTATION_GRACE_MS), secretVersion: e.secretVersion + 1 };
    db.update(C.endpoints, next);
    team.audit(e.employerId, by, 'webhook-secret-rotated', `${e.url}: the old secret also signs for 24 hours`);
    return { endpoint: next, secret: signingSecret(next) };
  }
  function replay(d, by) {
    const e = one(C.endpoints, 'id', d.endpointId);
    if (!e || e.status !== 'active') return { errors: ['the endpoint is not active'] };
    const copy = { id: `whd_${crypto.randomBytes(10).toString('hex')}`, endpointId: e.id, employerId: e.employerId, eventId: d.eventId, type: d.type, status: 'pending', attempts: 0, nextAttemptAt: iso(), createdAt: iso(), replayOf: d.id, log: [] };
    db.prepend(C.deliveries, copy);
    team.audit(e.employerId, by, 'webhook-replayed', `${d.type} (${d.eventId}) to ${e.url}`);
    setImmediate(() => { tick().catch(() => {}); });
    return { delivery: copy, errors: [] };
  }
  const endpointOut = (e) => ({ id: e.id, url: e.url, events: e.events, description: e.description || '', environment: e.environment, status: e.status, disabledReason: e.disabledReason || null, secret: `whsec_… (version ${e.secretVersion})`, consecutiveFailures: e.consecutiveFailures || 0, lastSuccessAt: e.lastSuccessAt || null, createdAt: e.createdAt });
  const deliveryOut = (d) => ({ id: d.id, eventId: d.eventId, type: d.type, status: d.status, attempts: d.attempts, nextAttemptAt: d.nextAttemptAt, lastStatus: d.lastStatus || null, lastError: d.lastError || null, createdAt: d.createdAt, finishedAt: d.finishedAt || null, replayOf: d.replayOf || null, log: d.log || [] });

  // ---------- the sandbox ----------
  // Sandbox keys see only their own sample data; nothing reaches live jobs,
  // candidates or Hireriv's review.
  const sbox = (clientId, kind) => db.where(C.sandbox, 'clientId', clientId).filter((x) => x.kind === kind);
  function seedSandbox(client) {
    const job = (n, status) => ({ id: `sbx_job_${crypto.randomBytes(4).toString('hex')}`, kind: 'job', clientId: client.id, data: { title: `Sample job ${n}`, location: 'Pune', mode: 'On-site', type: 'Full-time', category: 'Warehouse & Packing', description: 'A sample listing for testing your integration.', responsibilities: ['Pack orders'], pay: { min: 18000, max: 22000, period: 'month', currency: 'INR' }, shift: 'Day', status, sandbox: true, updatedAt: iso() } });
    const j1 = job(1, 'open');
    const j2 = job(2, 'draft');
    for (const d of [j1, j2]) db.prepend(C.sandbox, d);
    ['Asha Test', 'Ravi Test', 'Meena Test'].forEach((name, i) => db.prepend(C.sandbox, { id: `sbx_app_${crypto.randomBytes(4).toString('hex')}`, kind: 'application', clientId: client.id, data: { jobId: j1.id, jobTitle: j1.data.title, name, email: `test${i + 1}@example.com`, phone: `+910000000${i + 1}0`, status: ['New', 'Screening', 'Interview'][i], appliedAt: iso(), sandbox: true, history: [] } }));
  }
  const sbJob = (x) => ({ id: x.id, ...x.data });
  const sbApp = (x, scopes) => { const { email, phone, ...rest } = x.data; return { id: x.id, ...rest, ...(scopes.includes('applications:contact') ? { email, phone } : {}) }; };
  const sbEmit = (req, type, data) => emit(type, req.employer.id, data, { environment: 'sandbox', clientId: req.integration.client.id });
  const SANDBOX_JOB_FIELDS = ['title', 'location', 'mode', 'type', 'category', 'description', 'responsibilities', 'pay', 'shift', 'hours', 'payNote', 'openings'];

  // ---------- the API ----------
  const route = (fn) => async (req, res, next) => { try { await fn(req, res); } catch (err) { next(err); } };
  const parseBasic = (req) => {
    const m = String(req.get('authorization') || '').match(/^Basic\s+([A-Za-z0-9+/=]+)$/);
    if (!m) return null;
    const [user, ...rest] = Buffer.from(m[1], 'base64').toString().split(':');
    return { user, pass: rest.join(':') };
  };
  app.post('/api/v1/oauth/token', limit('integration-token', 30, 60000), (req, res) => {
    res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
    if (req.query.client_secret) return fail(res, 400, 'token_in_url', 'send the client secret in the body or HTTP Basic, never in the address');
    const r = exchange(req.body || {}, parseBasic(req));
    if (r.status !== 200) return res.status(r.status).json({ error: r.code, error_description: r.message });
    res.json(r.body);
  });
  app.get('/api/v1/me', apiAuth(), (req, res) => res.json({ data: { client: { id: req.integration.client.id, name: req.integration.client.name, environment: req.integration.client.environment }, scopes: req.integration.scopes, company: { id: req.employer.id, name: req.employer.company } } }));

  app.get('/api/v1/jobs', apiAuth('jobs:read'), (req, res) => {
    if (req.integration.sandbox) return res.json(page(sbox(req.integration.client.id, 'job').map(sbJob), req));
    const status = String(req.query.status || '');
    const list = companyJobs(req).filter((j) => hiring.selfManaged(j)).filter((j) => !status || j.status === status).sort((a, b) => String(b.updatedAt || b.posted || '').localeCompare(String(a.updatedAt || a.posted || '')));
    const p = page(list, req);
    res.json({ ...p, data: p.data.map(jobOut) });
  });
  app.get('/api/v1/jobs/:id', apiAuth('jobs:read'), (req, res) => {
    if (req.integration.sandbox) { const x = sbox(req.integration.client.id, 'job').find((j) => j.id === req.params.id); return x ? res.json({ data: sbJob(x) }) : fail(res, 404, 'not_found', 'job not found'); }
    const j = companyJob(req, req.params.id);
    return j ? res.json({ data: jobOut(j) }) : fail(res, 404, 'not_found', 'job not found');
  });
  app.post('/api/v1/jobs', apiAuth('jobs:write'), idempotent, (req, res) => {
    const body = req.body || {};
    if (req.integration.sandbox) {
      if (!clip(body.title, 120) || !clip(body.description, 2000)) return fail(res, 400, 'validation_failed', 'title and description are required', ['title is required', 'description is required'].filter((m, i) => !clip(i ? body.description : body.title, 10)));
      const x = { id: `sbx_job_${crypto.randomBytes(4).toString('hex')}`, kind: 'job', clientId: req.integration.client.id, data: { ...Object.fromEntries(SANDBOX_JOB_FIELDS.filter((k) => body[k] !== undefined).map((k) => [k, body[k]])), status: body.submit === true ? 'pending' : 'draft', sandbox: true, updatedAt: iso() } };
      db.prepend(C.sandbox, x);
      if (body.submit === true) sbEmit(req, 'job.submitted', { jobId: x.id, status: 'pending' });
      return res.status(201).json({ data: sbJob(x) });
    }
    const r = hiring.createEmployerJob(req, body);
    if (r.errors.length) return fail(res, 400, 'validation_failed', 'the job is not valid', r.errors);
    if (body.submit === true) {
      const s = hiring.submitJob(req, r.job);
      if (s.errors.length) return res.status(201).json({ data: jobOut(r.job), warnings: [`saved as a draft but not sent for review: ${s.errors.join('; ')}`] });
    }
    res.status(201).json({ data: jobOut(r.job) });
  });
  app.patch('/api/v1/jobs/:id', apiAuth('jobs:write'), (req, res) => {
    const body = req.body || {};
    if (req.integration.sandbox) {
      const x = sbox(req.integration.client.id, 'job').find((j) => j.id === req.params.id);
      if (!x) return fail(res, 404, 'not_found', 'job not found');
      const next = { ...x, data: { ...x.data, ...Object.fromEntries(SANDBOX_JOB_FIELDS.filter((k) => body[k] !== undefined).map((k) => [k, body[k]])), updatedAt: iso() } };
      db.update(C.sandbox, next);
      return res.json({ data: sbJob(next) });
    }
    const j = companyJob(req, req.params.id);
    if (!j) return fail(res, 404, 'not_found', 'job not found');
    const r = hiring.updateEmployerJob(req, j, body);
    if (r.errors.length) return fail(res, 400, 'validation_failed', 'the change is not valid', r.errors);
    res.json({ data: jobOut(j) });
  });
  app.post('/api/v1/jobs/:id/submit', apiAuth('jobs:write'), (req, res) => {
    if (req.integration.sandbox) {
      const x = sbox(req.integration.client.id, 'job').find((j) => j.id === req.params.id);
      if (!x) return fail(res, 404, 'not_found', 'job not found');
      db.update(C.sandbox, { ...x, data: { ...x.data, status: 'pending', updatedAt: iso() } });
      sbEmit(req, 'job.submitted', { jobId: x.id, status: 'pending' });
      return res.json({ data: { ...sbJob(x), status: 'pending' } });
    }
    const j = companyJob(req, req.params.id);
    if (!j) return fail(res, 404, 'not_found', 'job not found');
    const r = hiring.submitJob(req, j);
    if (r.errors.length) return fail(res, 409, 'not_submitted', r.errors.join('; '), r.errors);
    res.json({ data: jobOut(j) });
  });
  app.post('/api/v1/jobs/:id/close', apiAuth('jobs:write'), (req, res) => {
    if (req.integration.sandbox) {
      const x = sbox(req.integration.client.id, 'job').find((j) => j.id === req.params.id);
      if (!x) return fail(res, 404, 'not_found', 'job not found');
      db.update(C.sandbox, { ...x, data: { ...x.data, status: 'closed', updatedAt: iso() } });
      sbEmit(req, 'job.closed', { jobId: x.id, status: 'closed' });
      return res.json({ data: { ...sbJob(x), status: 'closed' } });
    }
    const j = companyJob(req, req.params.id);
    if (!j) return fail(res, 404, 'not_found', 'job not found');
    if (hiring.lockedByModeration(j)) return fail(res, 409, 'locked', 'this job was restricted by Hireriv moderators');
    const r = hiring.setJobState(req, j, 'close');
    if (r.errors.length) return fail(res, 409, 'not_closed', r.errors.join('; '));
    res.json({ data: jobOut(j) });
  });

  app.get('/api/v1/applications', apiAuth('applications:read'), (req, res) => {
    const { scopes } = req.integration;
    const jobId = String(req.query.job_id || '');
    const status = String(req.query.status || '');
    const since = /^\d{4}-\d{2}-\d{2}/.test(String(req.query.updated_since || '')) ? String(req.query.updated_since) : '';
    if (req.integration.sandbox) return res.json(page(sbox(req.integration.client.id, 'application').map((x) => sbApp(x, scopes)).filter((a) => (!jobId || a.jobId === jobId) && (!status || a.status === status)), req));
    const { jobs, list } = companyApplications(req);
    const rows = list.filter((a) => (!jobId || a.jobId === jobId)).map((a) => applicationOut(a, jobs.get(a.jobId), scopes)).filter((a) => (!status || a.status === status) && (!since || a.updatedAt >= since)).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    res.json(page(rows, req));
  });
  app.get('/api/v1/applications/:id', apiAuth('applications:read'), (req, res) => {
    const { scopes } = req.integration;
    if (req.integration.sandbox) { const x = sbox(req.integration.client.id, 'application').find((a) => a.id === req.params.id); return x ? res.json({ data: sbApp(x, scopes) }) : fail(res, 404, 'not_found', 'application not found'); }
    const { jobs, list } = companyApplications(req);
    const a = list.find((x) => x.id === req.params.id);
    return a ? res.json({ data: applicationOut(a, jobs.get(a.jobId), scopes) }) : fail(res, 404, 'not_found', 'application not found');
  });
  app.patch('/api/v1/applications/:id/status', apiAuth('applications:status:update'), (req, res) => {
    const to = String((req.body || {}).status || '');
    if (req.integration.sandbox) {
      const x = sbox(req.integration.client.id, 'application').find((a) => a.id === req.params.id);
      if (!x) return fail(res, 404, 'not_found', 'application not found');
      if (!ats.STAGES.includes(to)) return fail(res, 400, 'validation_failed', `status must be one of: ${ats.STAGES.join(', ')}`);
      const next = { ...x, data: { ...x.data, status: to, history: [...(x.data.history || []), { at: iso(), from: x.data.status, to }] } };
      db.update(C.sandbox, next);
      sbEmit(req, 'application.status_changed', { applicationId: x.id, jobId: x.data.jobId, from: x.data.status, to });
      return res.json({ data: sbApp(next, req.integration.scopes) });
    }
    const list = readSubmissions('applications');
    const a = list.find((x) => x.id === req.params.id && !x.duplicateOf);
    const job = a && companyJob(req, a.jobId);
    if (!a || !job) return fail(res, 404, 'not_found', 'application not found');
    Object.assign(req, { applications: list, application: a, job });
    const r = hiring.changeStatus(req, to);
    if (r.error) return fail(res, r.status, r.status === 400 ? 'validation_failed' : 'conflict', r.error);
    res.json({ data: applicationOut(a, job, req.integration.scopes), changed: r.changed });
  });

  // Webhooks through the API (the company's dashboard does the same).
  const envOf = (req) => (req.integration.sandbox ? { environment: 'sandbox', clientId: req.integration.client.id } : { environment: 'live', clientId: '' });
  const myEndpoint = (req, id) => { const e = one(C.endpoints, 'id', id); const env = envOf(req); return e && e.employerId === req.employer.id && e.status !== 'deleted' && e.environment === env.environment && (env.environment !== 'sandbox' || e.clientId === env.clientId) ? e : null; };
  app.get('/api/v1/webhooks', apiAuth('webhooks:manage'), (req, res) => {
    const env = envOf(req);
    res.json(page(db.where(C.endpoints, 'employerId', req.employer.id).filter((e) => e.status !== 'deleted' && e.environment === env.environment && (env.environment !== 'sandbox' || e.clientId === env.clientId)).map(endpointOut), req));
  });
  app.post('/api/v1/webhooks', apiAuth('webhooks:manage'), idempotent, route(async (req, res) => {
    const r = await createEndpoint(req.employer, req.employerUser, req.body || {}, { ...envOf(req), viaClientId: req.integration.client.id });
    if (r.errors.length) return fail(res, 400, 'validation_failed', 'the webhook is not valid', r.errors);
    res.status(201).json({ data: { ...endpointOut(r.endpoint), secret: r.secret }, note: 'Store the signing secret now: it is not shown again.' });
  }));
  app.patch('/api/v1/webhooks/:id', apiAuth('webhooks:manage'), route(async (req, res) => {
    const e = myEndpoint(req, req.params.id);
    if (!e) return fail(res, 404, 'not_found', 'webhook not found');
    const body = req.body || {};
    const next = { ...e };
    const errors = [];
    if (body.url !== undefined) { const v = await validateEndpointUrl(body.url); if (v.error) errors.push(v.error); else next.url = v.url; }
    if (body.events !== undefined) { const evs = [...new Set([].concat(body.events).map(String))]; if (!evs.length || evs.some((x) => !EVENTS[x])) errors.push('events must be a list of known events'); else next.events = evs; }
    if (body.active !== undefined) next.status = body.active === true ? 'active' : 'disabled';
    if (next.status === 'active') Object.assign(next, { consecutiveFailures: 0, disabledReason: null });
    if (errors.length) return fail(res, 400, 'validation_failed', 'the change is not valid', errors);
    db.update(C.endpoints, next);
    team.audit(req.employer.id, req.employerUser, 'webhook-updated', next.url);
    res.json({ data: endpointOut(next) });
  }));
  app.delete('/api/v1/webhooks/:id', apiAuth('webhooks:manage'), (req, res) => {
    const e = myEndpoint(req, req.params.id);
    if (!e) return fail(res, 404, 'not_found', 'webhook not found');
    db.update(C.endpoints, { ...e, status: 'deleted', deletedAt: iso() });
    team.audit(req.employer.id, req.employerUser, 'webhook-deleted', e.url);
    res.status(204).end();
  });
  app.post('/api/v1/webhooks/:id/rotate-secret', apiAuth('webhooks:manage'), (req, res) => {
    const e = myEndpoint(req, req.params.id);
    if (!e) return fail(res, 404, 'not_found', 'webhook not found');
    const r = rotateEndpointSecret(e, req.employerUser);
    res.json({ data: { ...endpointOut(r.endpoint), secret: r.secret }, note: 'The old secret also signs deliveries for 24 hours.' });
  });
  app.post('/api/v1/webhooks/:id/test', apiAuth('webhooks:manage'), (req, res) => {
    const e = myEndpoint(req, req.params.id);
    if (!e || e.status !== 'active') return fail(res, 404, 'not_found', 'active webhook not found');
    const env = envOf(req);
    const ev = emit('webhook.test', req.employer.id, { message: 'A test event from Hireriv', endpointId: e.id }, env);
    res.status(202).json({ data: { eventId: ev.id } });
  });
  app.get('/api/v1/webhooks/:id/deliveries', apiAuth('webhooks:manage'), (req, res) => {
    const e = myEndpoint(req, req.params.id);
    if (!e) return fail(res, 404, 'not_found', 'webhook not found');
    res.json(page(db.where(C.deliveries, 'endpointId', e.id).map(deliveryOut), req));
  });
  app.post('/api/v1/webhook-deliveries/:id/replay', apiAuth('webhooks:manage'), (req, res) => {
    const d = one(C.deliveries, 'id', req.params.id);
    if (!d || !myEndpoint(req, d.endpointId)) return fail(res, 404, 'not_found', 'delivery not found');
    const r = replay(d, req.employerUser);
    if (r.errors.length) return fail(res, 409, 'not_replayed', r.errors[0]);
    res.status(202).json({ data: deliveryOut(r.delivery) });
  });
  // The company's events for 30 days, to catch up on anything missed.
  app.get('/api/v1/events', apiAuth(), (req, res) => {
    const env = envOf(req);
    const type = String(req.query.type || '');
    const since = String(req.query.since || '');
    const list = db.where(C.events, 'employerId', req.employer.id).filter((e) => e.environment === env.environment && (env.environment !== 'sandbox' || e.clientId === env.clientId) && e.type !== 'webhook.test' && (!type || e.type === type) && (!since || e.createdAt > since));
    res.json(page(list.map((e) => ({ id: e.id, type: e.type, created_at: e.createdAt, data: e.data })), req));
  });
  // Anything else under /api/v1 is a clear 404 in the same shape.
  app.all('/api/v1/{*rest}', (req, res) => { res.set('Cache-Control', 'no-store'); fail(res, 404, 'not_found', 'no such endpoint; see /developers'); });

  // ---------- the company's Integrations page ----------
  const view = (req, res, locals = {}, status = 200) => {
    res.set('Cache-Control', 'no-store');
    const list = clientsOf(req.employer.id).map((c) => ({ ...c, keys: credsOf(c.id).map((k) => ({ id: k.id, masked: mask(k.prefix, k.last4), createdAt: k.createdAt, createdBy: k.createdBy, lastUsedAt: k.lastUsedAt, expiresAt: k.expiresAt, revokedAt: k.revokedAt })) }));
    const endpoints = db.where(C.endpoints, 'employerId', req.employer.id).filter((e) => e.status !== 'deleted').map((e) => ({ ...endpointOut(e), deliveries: db.where(C.deliveries, 'endpointId', e.id).slice(0, 10).map(deliveryOut) }));
    res.status(status).render('employer-integrations', { title: `${req.employer.company} · Integrations`, page: 'employer', noindex: true, tab: 'integrations', errors: [], msg: clip(req.query.msg, 300), list, endpoints, SCOPES, EVENTS, newSecret: null, values: {}, ...locals });
  };
  const by = (req) => req.employerUser;
  const back = (res, msg) => res.redirect(303, `/employer/integrations?msg=${encodeURIComponent(msg)}`);
  app.get('/employer/integrations', requireEmployer, allow('integrations.manage'), (req, res) => view(req, res));
  // A new secret is shown on the page that answers the form, never in a link.
  app.post('/employer/integrations/clients', requireEmployer, allow('integrations.manage'), limit('integrations', 20), sameOrigin, (req, res) => {
    const r = createClient(req.employer, by(req), { name: req.body.name, environment: req.body.environment, scopes: req.body.scopes });
    if (r.errors.length) return view(req, res, { errors: r.errors, values: req.body }, 400);
    view(req, res, { newSecret: { kind: 'key', clientId: r.client.id, name: r.client.name, secret: r.secret } });
  });
  app.post('/employer/integrations/clients/:id/rotate', requireEmployer, allow('integrations.manage'), limit('integrations', 20), sameOrigin, (req, res) => {
    const r = rotate(req.employer, by(req), req.params.id, { now: req.body.now === '1' });
    if (r.errors.length) return back(res, r.errors[0]);
    view(req, res, { newSecret: { kind: 'key', clientId: r.client.id, name: r.client.name, secret: r.secret } });
  });
  app.post('/employer/integrations/clients/:id/revoke', requireEmployer, allow('integrations.manage'), limit('integrations', 20), sameOrigin, (req, res) => {
    const client = one(C.clients, 'id', req.params.id);
    if (!client || client.employerId !== req.employer.id) return back(res, 'Integration not found');
    const r = revoke(client, by(req), 'Revoked by the company');
    back(res, r.errors.length ? r.errors[0] : `${client.name} revoked: its keys and tokens stopped working`);
  });
  app.post('/employer/integrations/webhooks', requireEmployer, allow('integrations.manage'), limit('integrations', 20), sameOrigin, route(async (req, res) => {
    const env = req.body.environment === 'sandbox' ? 'sandbox' : 'live';
    const sandboxClient = env === 'sandbox' ? clientsOf(req.employer.id).find((c) => c.id === req.body.clientId && c.environment === 'sandbox' && c.status === 'active') : null;
    if (env === 'sandbox' && !sandboxClient) return view(req, res, { errors: ['choose the sandbox integration this endpoint is for'], values: req.body }, 400);
    const r = await createEndpoint(req.employer, by(req), { url: req.body.url, events: req.body.events, description: req.body.description }, { environment: env, clientId: sandboxClient ? sandboxClient.id : '' });
    if (r.errors.length) return view(req, res, { errors: r.errors, values: req.body }, 400);
    view(req, res, { newSecret: { kind: 'webhook', name: r.endpoint.url, secret: r.secret } });
  }));
  const ownEndpoint = (req) => { const e = one(C.endpoints, 'id', req.params.id); return e && e.employerId === req.employer.id && e.status !== 'deleted' ? e : null; };
  app.post('/employer/integrations/webhooks/:id/:action', requireEmployer, allow('integrations.manage'), limit('integrations', 30), sameOrigin, (req, res) => {
    const e = ownEndpoint(req);
    const a = req.params.action;
    if (!e || !['rotate', 'disable', 'enable', 'test', 'delete'].includes(a)) return back(res, 'Webhook not found');
    if (a === 'rotate') { const r = rotateEndpointSecret(e, by(req)); return view(req, res, { newSecret: { kind: 'webhook', name: e.url, secret: r.secret } }); }
    if (a === 'test') { if (e.status !== 'active') return back(res, 'Turn the endpoint on first'); emit('webhook.test', req.employer.id, { message: 'A test event from Hireriv', endpointId: e.id }, { environment: e.environment, clientId: e.clientId }); return back(res, 'Test event queued'); }
    const status = a === 'enable' ? 'active' : a === 'disable' ? 'disabled' : 'deleted';
    db.update(C.endpoints, { ...e, status, ...(status === 'active' ? { consecutiveFailures: 0, disabledReason: null } : {}), ...(status === 'deleted' ? { deletedAt: iso() } : {}) });
    team.audit(req.employer.id, by(req), `webhook-${a === 'enable' ? 'enabled' : a === 'disable' ? 'disabled' : 'deleted'}`, e.url);
    back(res, `Webhook ${a === 'enable' ? 'turned on' : a === 'disable' ? 'turned off' : 'deleted'}`);
  });
  app.post('/employer/integrations/deliveries/:id/replay', requireEmployer, allow('integrations.manage'), limit('integrations', 30), sameOrigin, (req, res) => {
    const d = one(C.deliveries, 'id', req.params.id);
    if (!d || d.employerId !== req.employer.id) return back(res, 'Delivery not found');
    const r = replay(d, by(req));
    back(res, r.errors.length ? r.errors[0] : 'Sent again');
  });

  // ---------- the team's view ----------
  const gate = (action) => (req, res, next) => (roles.can(req.admin, action) ? next() : res.status(403).render('thanks', { title: 'Not part of your role', page: '', ok: false, message: 'Your role does not include integrations.', noindex: true }));
  app.get('/admin/integrations', adminAuth, gate('integrations.view'), (req, res) => {
    res.set('Cache-Control', 'no-store');
    const emps = new Map(clients.read().map((e) => [e.id, e]));
    const all = db.all(C.clients).map((c) => ({ ...c, company: (emps.get(c.employerId) || {}).company || c.employerId, keys: credsOf(c.id).filter((k) => !k.revokedAt).map((k) => ({ masked: mask(k.prefix, k.last4), lastUsedAt: k.lastUsedAt, expiresAt: k.expiresAt })) }));
    const endpoints = db.all(C.endpoints).filter((e) => e.status !== 'deleted').map((e) => ({ ...endpointOut(e), company: (emps.get(e.employerId) || {}).company || e.employerId }));
    const ds = db.all(C.deliveries).filter((d) => d.createdAt >= iso(Date.now() - DAY));
    res.render('admin-integrations', { title: 'Integrations', page: 'admin', noindex: true, admin: req.admin, ...adminNav(req), msg: clip(req.query.msg, 300), all, endpoints, stats: { delivered: ds.filter((d) => d.status === 'delivered').length, pending: ds.filter((d) => d.status === 'pending').length, failed: ds.filter((d) => d.status === 'failed').length }, canManage: roles.can(req.admin, 'integrations.manage') });
  });
  // Stops an integration at once (a leaked key, abuse); the company is told.
  app.post('/admin/integrations/clients/:id/revoke', adminAuth, gate('integrations.manage'), sameOrigin, (req, res) => {
    const client = one(C.clients, 'id', req.params.id);
    const reason = clip(req.body.reason, 300);
    if (!client) return res.redirect(303, '/admin/integrations?msg=Not%20found');
    if (reason.length < 5) return res.redirect(303, `/admin/integrations?msg=${encodeURIComponent('Give a reason (the company sees it)')}`);
    const r = revoke(client, { id: req.admin.id, name: `${req.admin.name} (${site.name})` }, reason);
    if (!r.errors.length) {
      record(req.admin, 'integration-revoked', { entityType: 'employer', entityId: client.employerId, reason, detail: client.name });
      const emp = clients.read().find((e) => e.id === client.employerId);
      if (emp) tellOwners(emp, { subject: `${site.name} stopped an integration for ${emp.company}`, heading: 'An integration was stopped', intro: `We revoked the integration "${client.name}" and its keys. Reason: ${reason}. Create a new key under Integrations when you are ready.` });
    }
    res.redirect(303, `/admin/integrations?msg=${encodeURIComponent(r.errors.length ? r.errors[0] : `${client.name} revoked`)}`);
  });

  // ---------- events from the rest of the platform ----------
  // Ids and states only; the integration reads details through the API.
  const ofJob = (job) => job && job.employerId && !job.sample;
  function tap(events, history) {
    const wrap = (name, fn) => { const orig = events[name]; events[name] = (...args) => { const out = orig.apply(events, args); try { fn(...args); } catch (e) { console.error(`Integration event ${name} failed:`, e.message); } return out; }; };
    wrap('jobSubmitted', (job) => { if (ofJob(job)) emit('job.submitted', job.employerId, { jobId: job.id, status: job.status }); });
    wrap('jobDecision', (job, emp, approved, reason) => { if (ofJob(job)) emit(approved ? 'job.published' : 'job.rejected', job.employerId, { jobId: job.id, status: job.status, ...(approved ? {} : { reason: clip(reason, 300) }) }); });
    wrap('jobExpired', (job) => { if (ofJob(job)) emit('job.closed', job.employerId, { jobId: job.id, status: 'closed', reason: 'reached its closing date' }); });
    wrap('newApplication', (a, job) => { if (ofJob(job)) emit('application.created', job.employerId, { applicationId: a.id, jobId: job.id, status: a.status || 'New' }); });
    wrap('interviewBooked', (a, iv) => { const job = getJobs().find((j) => j.id === a.jobId); if (ofJob(job) && iv) emit('interview.scheduled', job.employerId, { applicationId: a.id, jobId: job.id, interviewId: iv.id, at: iv.at, mode: iv.mode }); });
    hiring.hooks.stateChanged = (job, from) => { if (ofJob(job) && job.status === 'closed' && from !== 'closed') emit('job.closed', job.employerId, { jobId: job.id, status: 'closed', reason: 'closed by the employer' }); };
    history.onMove((a, entry) => { const job = getJobs().find((j) => j.id === a.jobId); if (ofJob(job)) emit('application.status_changed', job.employerId, { applicationId: a.id, jobId: job.id, from: entry.from, to: entry.to }); });
  }

  return { tap, emit, tick, prune, exchange, createClient, rotate, revoke, createEndpoint, signingSecret, SCOPES, EVENTS, API_VERSION };
}

module.exports = { create, SCOPES, EVENTS, API_VERSION };
