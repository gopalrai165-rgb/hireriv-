// The notification service. A business event (someone applied, an interview
// was booked, an offer was approved…) becomes in-app notifications
// (`notifications`) and delivery tasks (`notification-deliveries`). Both are
// written in the same transaction as the change that caused them, so an
// application or interview is saved even when the email provider is down; a
// background worker then sends the tasks with bounded retries and records the
// outcome. Signed provider webhooks add delivered, bounced and complaint reports.
//
// Recipients are keys ("rk"), never addresses: candidates are a hash of their
// email, employer people and the team their user id. The address is looked up
// from the current records when a message is sent, so the tables hold no
// contact details and a deleted record simply sends nothing.
const crypto = require('crypto');

const NOTIFICATIONS = 'notifications';
const DELIVERIES = 'notification-deliveries';
const PREFERENCES = 'notification-preferences';
const WEBHOOKS = 'notification-webhooks';
const SUPPRESSIONS = 'email-suppressions';

const DAY = 86400000;
const KEEP_NOTIFICATIONS_DAYS = 365;
const KEEP_DELIVERIES_DAYS = 90;
const KEEP_WEBHOOK_EVENTS_DAYS = 30;
// Minutes to wait before attempts 2, 3, 4 and 5; after the fifth it has failed.
const BACKOFF_MINUTES = [1, 5, 30, 120];
const MAX_ATTEMPTS = BACKOFF_MINUTES.length + 1;
const BATCH = 25;
// Webhook signatures older than this are refused (replays).
const WEBHOOK_TOLERANCE_SECONDS = 300;

const CATEGORIES = { applications: 'Applications', interviews: 'Interviews', jobs: 'Jobs', work: 'Work & attendance', account: 'Account' };
// Email can be switched off per category; account and security email can't.
const OPTIONAL_CATEGORIES = ['applications', 'interviews', 'jobs', 'work'];

// Every kind of notification. `optional` emails follow the person's
// preferences; the others are part of a service they asked for (their
// application, their interview, their offer, their account) and are always sent.
const TYPES = {
  // candidates
  'application-submitted': { category: 'applications', label: 'Application received' },
  'application-status': { category: 'applications', optional: true, label: 'Application updates' },
  'interview-invited': { category: 'interviews', label: 'Interview invitation' },
  'interview-rescheduled': { category: 'interviews', label: 'Interview moved' },
  'interview-cancelled': { category: 'interviews', label: 'Interview cancelled' },
  'interview-reminder': { category: 'interviews', label: 'Interview reminder' },
  'offer-received': { category: 'applications', label: 'Job offer' },
  'offer-deadline': { category: 'applications', label: 'Offer deadline' },
  'job-alert': { category: 'jobs', optional: true, label: 'Job alert' },
  'job-digest': { category: 'jobs', optional: true, label: 'Saved search summary' },
  'job-invite': { category: 'jobs', optional: true, label: 'Invitation to apply' },
  'account-security': { category: 'account', label: 'Account and security' },
  // employers and the team
  'new-application': { category: 'applications', optional: true, label: 'New application' },
  'candidate-assigned': { category: 'applications', optional: true, label: 'Assigned to you' },
  'stage-changed': { category: 'applications', optional: true, label: 'Stage changed' },
  'hiring-milestone': { category: 'applications', optional: true, label: 'Hiring milestone' },
  'offer-approval': { category: 'applications', optional: true, label: 'Offer to approve' },
  'interview-response': { category: 'interviews', optional: true, label: 'Interview answer' },
  'feedback-due': { category: 'interviews', optional: true, label: 'Feedback due' },
  'interview-upcoming': { category: 'interviews', optional: true, label: 'Upcoming interview' },
  'job-decision': { category: 'jobs', label: 'Job review decision' },
  'job-expired': { category: 'jobs', optional: true, label: 'Job closed' },
  'job-review': { category: 'jobs', optional: true, label: 'Job waiting for review' },
  'staffing-request': { category: 'jobs', optional: true, label: 'Staffing request' },
  'requisition-assigned': { category: 'jobs', optional: true, label: 'Requisition assigned to you' },
  // workers, their supervisors and the staffing team (workforce.js)
  'work-onboarding': { category: 'work', optional: true, label: 'Joining steps and documents to review' },
  'work-shift': { category: 'work', optional: true, label: 'Shift reminders' },
  'work-attendance': { category: 'work', optional: true, label: 'Missing check-ins and check-outs' },
  'work-timesheet': { category: 'work', optional: true, label: 'Timesheets to approve or sent back' },
  'work-document': { category: 'work', optional: true, label: 'Documents expiring' },
  'work-assignment': { category: 'work', optional: true, label: 'Assignment changes, ends and replacements' },
  // the sales team (crm.js)
  'crm-lead': { category: 'jobs', optional: true, label: 'Sales leads: new, assigned to you, answers and conversions' },
  'crm-follow-up': { category: 'jobs', optional: true, label: 'Sales follow-ups due and overdue' },
  // trust & safety (trust.js)
  'billing': { category: 'account', label: 'Billing: payments, invoices, renewals, failed payments and refunds' },
  'security-alert': { category: 'account', label: 'Security alerts: repeated failed sign-ins, refused requests, unusual downloads or exports, and privileged changes' },
  'data-request': { category: 'account', label: 'Data requests from job seekers and others (access, correction, deletion, complaints)' },
  'trust-case': { category: 'jobs', optional: true, label: 'Trust & safety: urgent cases, escalations, assignments, closures to approve and appeals' },
};

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const candidateRk = (email) => `c:${sha(`candidate:${String(email || '').trim().toLowerCase()}`).slice(0, 32)}`;
const addressHash = (email) => sha(`address:${String(email || '').trim().toLowerCase()}`);

// The recipient key for a recipient object.
function rkOf(r) {
  if (r.kind === 'candidate') return candidateRk(r.email);
  if (r.kind === 'employer') return `e:${r.userId}`;
  if (r.kind === 'team') return `t:${r.userId}`;
  if (r.kind === 'inbox') return 'inbox';
  if (r.kind === 'interviewer') return `iv:${r.interviewId}`;
  throw new Error(`unknown recipient kind ${r.kind}`);
}
// Inbox and outside interviewers only get email; they have no account.
const hasInbox = (r) => ['candidate', 'employer', 'team'].includes(r.kind);

// In-app links must stay on this site.
const safeLink = (link) => (typeof link === 'string' && /^\/(?!\/)[^\s\\]*$/.test(link) ? link.slice(0, 300) : '');
const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

// Email per area (on unless switched off), phone notifications per area (they
// only reach devices the person turned them on for), and agreement to
// marketing emails, which is off until the person turns it on.
const defaultPrefs = () => ({
  email: Object.fromEntries(OPTIONAL_CATEGORIES.map((c) => [c, true])),
  push: Object.fromEntries(OPTIONAL_CATEGORIES.map((c) => [c, true])),
  marketing: { email: false, at: null, how: null },
});

function create({ db, now = () => Date.now(), log = console }) {
  const iso = (ms = now()) => new Date(ms).toISOString();
  db.uniqueKey(NOTIFICATIONS, (n) => n.dkey || null);
  db.uniqueKey(DELIVERIES, (d) => d.key || null);
  db.uniqueKey(PREFERENCES, (p) => p.rk || null);
  db.uniqueKey(WEBHOOKS, (w) => w.eventId || null);
  db.uniqueKey(SUPPRESSIONS, (s) => s.hash || null);

  // Step 51 kept a send-once ledger in `notifications`; those rows are
  // deliveries, so they move once to where deliveries now live.
  const legacy = db.all(NOTIFICATIONS).filter((n) => n.channel && !n.rk);
  if (legacy.length) {
    db.transaction(() => {
      for (const n of legacy.reverse()) {
        try {
          db.prepend(DELIVERIES, { id: n.id, key: `${n.key}|email`, event: n.key, type: '', template: n.template || '', version: 1, rk: n.audience || '', to: null, refs: { applicationId: n.applicationId || '' }, status: n.status === 'sent' ? 'sent' : 'failed', attempts: 1, createdAt: n.createdAt, sentAt: n.sentAt || null, lastError: n.error || null });
        } catch (e) { if (e.code !== 'ERR_UNIQUE') throw e; }
      }
      db.remove(NOTIFICATIONS, legacy.map((n) => n.id));
    });
  }

  const templates = {};
  // A template: { version, resolve(refs, to) → { to: address, send: () => Promise<messageId|true|false> } | null }.
  function template(name, def) {
    templates[name] = { version: 1, ...def };
  }

  // ---------- preferences ----------
  function prefsOf(rk) {
    const p = db.where(PREFERENCES, 'rk', rk)[0];
    const base = defaultPrefs();
    for (const ch of ['email', 'push']) if (p && p[ch]) for (const c of OPTIONAL_CATEGORIES) if (typeof p[ch][c] === 'boolean') base[ch][c] = p[ch][c];
    if (p && p.marketing && typeof p.marketing.email === 'boolean') base.marketing = { email: p.marketing.email, at: p.marketing.at || null, how: p.marketing.how || null };
    return base;
  }
  function setPrefs(rk, input) {
    const prefs = prefsOf(rk);
    for (const ch of ['email', 'push']) for (const c of OPTIONAL_CATEGORIES) if (input && input[ch] && typeof input[ch][c] === 'boolean') prefs[ch][c] = input[ch][c];
    // Agreeing or withdrawing is recorded with when and where it happened.
    if (input && typeof input.marketing === 'boolean' && input.marketing !== prefs.marketing.email) prefs.marketing = { email: input.marketing, at: iso(), how: String(input.how || 'notification settings').slice(0, 60) };
    const existing = db.where(PREFERENCES, 'rk', rk)[0];
    if (existing) db.update(PREFERENCES, { ...existing, ...prefs, updatedAt: iso() });
    else db.prepend(PREFERENCES, { id: crypto.randomUUID(), rk, ...prefs, createdAt: iso(), updatedAt: iso() });
    return prefs;
  }
  // Would this in-app notification also go to the person's phone?
  function pushAllowed(n) {
    if (!OPTIONAL_CATEGORIES.includes(n.category)) return true;
    return prefsOf(n.rk).push[n.category] !== false;
  }
  // Called with each new in-app notification once it is saved (push).
  const listeners = [];
  const onNotification = (fn) => listeners.push(fn);
  // Would this recipient get this type of email?
  function emailAllowed(rk, type) {
    const t = TYPES[type];
    if (!t || !t.optional) return true;
    if (rk === 'inbox' || rk.startsWith('iv:')) return true;
    return prefsOf(rk).email[t.category] !== false;
  }

  // ---------- emitting events ----------
  // emit({ key, type, to: [recipient], inApp: (r) => ({ title, body, link, jobId, perm }) | null,
  //        email: { template, refs } | null })
  // `key` is the stable idempotency key of the business event: emitting the
  // same key again adds nothing for recipients who already have it.
  // A recipient can carry `inApp: false` or `mail: false` (no email).
  function emit({ key, type, to, inApp, email }) {
    if (!TYPES[type]) throw new Error(`unknown notification type ${type}`);
    if (email && !templates[email.template]) throw new Error(`unknown email template ${email.template}`);
    const out = { notifications: 0, deliveries: 0 };
    const created = [];
    const seen = new Set();
    db.transaction(() => {
      for (const r of to || []) {
        if (!r) continue;
        const rk = rkOf(r);
        if (seen.has(rk)) continue;
        seen.add(rk);
        const content = hasInbox(r) && r.inApp !== false && inApp ? (typeof inApp === 'function' ? inApp(r) : inApp) : null;
        if (content) {
          const n = {
            id: crypto.randomUUID(), dkey: `${key}|${rk}`, rk, type, category: TYPES[type].category,
            title: clip(content.title, 140), body: clip(content.body, 300), link: safeLink(content.link),
            ...(r.kind === 'employer' ? { employerId: r.employerId } : {}),
            ...(content.jobId ? { jobId: content.jobId } : {}), ...(content.perm ? { perm: content.perm } : {}),
            event: key, readAt: null, createdAt: iso(),
          };
          if (insert(NOTIFICATIONS, n)) { out.notifications++; created.push(n); }
        }
        if (email && r.mail !== false && (r.kind !== 'candidate' || r.email) && emailAllowed(rk, type)) {
          const d = {
            id: crypto.randomUUID(), key: `${key}|email|${rk}`, event: key, type, template: email.template, version: templates[email.template].version,
            rk, to: { kind: r.kind, ...(r.userId ? { userId: r.userId } : {}), ...(r.employerId ? { employerId: r.employerId } : {}), ...(r.interviewId ? { interviewId: r.interviewId } : {}) },
            refs: email.refs || {}, status: 'queued', attempts: 0, nextAttemptAt: iso(), createdAt: iso(),
          };
          if (insert(DELIVERIES, d)) out.deliveries++;
        }
      }
    });
    if (out.deliveries) kick();
    if (created.length && listeners.length) {
      setImmediate(() => {
        for (const n of created) for (const fn of listeners) Promise.resolve().then(() => fn({ ...n, categoryLabel: CATEGORIES[n.category] || '' })).catch((e) => log.error('Notification listener:', e.message));
      });
    }
    return out;
  }
  function insert(collection, doc) {
    try {
      db.prepend(collection, doc);
      return true;
    } catch (e) {
      if (e.code === 'ERR_UNIQUE') return false;
      throw e;
    }
  }

  // ---------- delivery worker ----------
  let running = null;
  let again = false;
  let stopped = false;
  function kick() {
    if (!stopped) setImmediate(() => work().catch((e) => log.error('Notification worker:', e.message)));
  }
  // Sends every task that is due. Resolves when this run is done.
  function work() {
    // A run in progress picks up tasks queued meanwhile before it finishes.
    if (running) { again = true; return running; }
    // Cleared once the run settles (never synchronously, which would leave a
    // finished run in place when nothing was due).
    running = (async () => {
      for (;;) {
        again = false;
        const t = iso();
        const due = db.where(DELIVERIES, 'status', 'queued').filter((d) => d.nextAttemptAt <= t).reverse().slice(0, BATCH);
        for (const d of due) await deliver(d);
        if (due.length < BATCH && !again) break;
      }
    })().finally(() => { running = null; });
    return running;
  }
  function save(d, patch) {
    const current = db.where(DELIVERIES, 'key', d.key)[0] || d;
    const next = { ...current, ...patch, updatedAt: iso() };
    db.update(DELIVERIES, next);
    return next;
  }
  async function deliver(d) {
    const t = templates[d.template];
    if (!t) return save(d, { status: 'skipped', lastError: 'unknown template' });
    save(d, { status: 'sending' });
    let result = false;
    let error = '';
    try {
      const r = await t.resolve(d.refs || {}, { ...(d.to || {}), rk: d.rk });
      if (!r) return save(d, { status: 'skipped', lastError: 'nothing to send (the record changed or was deleted)' });
      if (!r.to) return save(d, { status: 'skipped', lastError: 'no email address' });
      if (suppressed(r.to)) return save(d, { status: 'skipped', lastError: 'the address bounced or reported spam before' });
      result = await r.send();
    } catch (e) {
      error = e.message;
    }
    const attempts = (d.attempts || 0) + 1;
    if (result) return save(d, { status: 'sent', attempts, sentAt: iso(), providerRef: typeof result === 'string' ? result : null, lastError: null });
    if (attempts >= MAX_ATTEMPTS) return save(d, { status: 'failed', attempts, failedAt: iso(), lastError: error || 'sending failed' });
    return save(d, { status: 'queued', attempts, nextAttemptAt: iso(now() + BACKOFF_MINUTES[attempts - 1] * 60000), lastError: error || 'sending failed' });
  }
  // Tasks left "sending" by a crash or restart go back in the queue.
  for (const d of db.where(DELIVERIES, 'status', 'sending')) db.update(DELIVERIES, { ...d, status: 'queued', nextAttemptAt: iso() });

  function start(intervalMs = 30000) {
    stopped = false;
    kick();
    const timer = setInterval(() => work().catch((e) => log.error('Notification worker:', e.message)), intervalMs);
    timer.unref();
    return () => { stopped = true; clearInterval(timer); };
  }

  // ---------- suppression (bounces and complaints) ----------
  const suppressed = (address) => db.where(SUPPRESSIONS, 'hash', addressHash(address)).length > 0;
  function suppress(address, reason) {
    insert(SUPPRESSIONS, { id: crypto.randomUUID(), hash: addressHash(address), reason, createdAt: iso() });
  }
  const unsuppress = (id) => db.remove(SUPPRESSIONS, [id]);

  // ---------- provider webhooks ----------
  // Header `x-hireriv-signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`.
  function verifySignature(raw, header, secret) {
    if (!secret) return false;
    const parts = Object.fromEntries(String(header || '').split(',').map((p) => p.trim().split('=')).filter((p) => p.length === 2));
    const ts = Number(parts.t);
    if (!Number.isInteger(ts) || !/^[a-f0-9]{64}$/.test(parts.v1 || '')) return false;
    if (Math.abs(now() / 1000 - ts) > WEBHOOK_TOLERANCE_SECONDS) return false;
    const expected = crypto.createHmac('sha256', secret).update(`${ts}.`).update(raw).digest();
    return crypto.timingSafeEqual(expected, Buffer.from(parts.v1, 'hex'));
  }
  const WEBHOOK_STATUS = { delivered: 'delivered', bounced: 'bounced', complained: 'complained', failed: 'failed' };
  // events: [{ id, type: delivered|bounced|complained|failed|deferred, messageId, recipient? }].
  // Each event id is processed once; unknown message ids are recorded and ignored.
  function applyWebhook(events) {
    const out = { applied: 0, duplicates: 0, ignored: 0 };
    for (const ev of Array.isArray(events) ? events.slice(0, 500) : []) {
      const id = clip(ev && ev.id, 200);
      if (!id || !insert(WEBHOOKS, { id: crypto.randomUUID(), eventId: id, type: clip(ev.type, 20), createdAt: iso() })) {
        out[id ? 'duplicates' : 'ignored']++;
        continue;
      }
      const status = WEBHOOK_STATUS[ev.type];
      const d = status && ev.messageId ? db.where(DELIVERIES, 'providerRef', String(ev.messageId))[0] : null;
      if (!d) { out.ignored++; continue; }
      // Delivered never overrides a later bounce or complaint.
      if (!(status === 'delivered' && ['bounced', 'complained'].includes(d.status))) {
        save(d, { status, [`${status}At`]: iso(), ...(status === 'failed' ? { lastError: 'the provider could not deliver it' } : {}) });
      }
      if (['bounced', 'complained'].includes(status) && ev.recipient) suppress(String(ev.recipient), status);
      out.applied++;
    }
    return out;
  }

  // ---------- reading notifications ----------
  // viewer: { rk, employerId?, visible?: (n) => boolean }. Employer people see
  // the notifications of the company they're signed in to, and only those
  // their current role still allows.
  function mine(viewer) {
    return db.where(NOTIFICATIONS, 'rk', viewer.rk).filter((n) =>
      (viewer.employerId ? n.employerId === viewer.employerId : !n.employerId) && (!viewer.visible || viewer.visible(n)));
  }
  function list(viewer, { unread = false, category = '', limit = 20, offset = 0 } = {}) {
    const all = mine(viewer);
    const filtered = all.filter((n) => (!unread || !n.readAt) && (!category || n.category === category));
    return { items: filtered.slice(offset, offset + limit), total: filtered.length, unread: all.filter((n) => !n.readAt).length };
  }
  const unreadCount = (viewer) => mine(viewer).filter((n) => !n.readAt).length;
  const find = (viewer, id) => mine(viewer).find((n) => n.id === id) || null;
  function markRead(viewer, id) {
    const n = find(viewer, id);
    if (!n) return null;
    if (!n.readAt) { n.readAt = iso(); db.update(NOTIFICATIONS, n); }
    return n;
  }
  function markAllRead(viewer, category = '') {
    const t = iso();
    const changed = mine(viewer).filter((n) => !n.readAt && (!category || n.category === category));
    db.transaction(() => { for (const n of changed) db.update(NOTIFICATIONS, { ...n, readAt: t }); });
    return changed.length;
  }

  // Everything kept for one recipient (account deletion).
  function forget(rk) {
    db.transaction(() => {
      for (const c of [NOTIFICATIONS, DELIVERIES, PREFERENCES]) {
        const ids = db.where(c, 'rk', rk).map((x) => x.id);
        if (ids.length) db.remove(c, ids);
      }
    });
  }
  // A person who left a company keeps nothing from it.
  function forgetCompany(rk, employerId) {
    const ids = db.where(NOTIFICATIONS, 'rk', rk).filter((n) => n.employerId === employerId).map((n) => n.id);
    if (ids.length) db.remove(NOTIFICATIONS, ids);
  }

  // ---------- retention ----------
  function prune() {
    const cut = (days) => iso(now() - days * DAY);
    const n = db.all(NOTIFICATIONS).filter((x) => x.createdAt < cut(KEEP_NOTIFICATIONS_DAYS)).map((x) => x.id);
    const d = db.all(DELIVERIES).filter((x) => !['queued', 'sending'].includes(x.status) && x.createdAt < cut(KEEP_DELIVERIES_DAYS)).map((x) => x.id);
    const w = db.all(WEBHOOKS).filter((x) => x.createdAt < cut(KEEP_WEBHOOK_EVENTS_DAYS)).map((x) => x.id);
    if (n.length) db.remove(NOTIFICATIONS, n);
    if (d.length) db.remove(DELIVERIES, d);
    if (w.length) db.remove(WEBHOOKS, w);
    return n.length + d.length + w.length;
  }

  // ---------- monitoring ----------
  function stats() {
    const t = now();
    const since = (days) => iso(t - days * DAY);
    const by = (s) => db.where(DELIVERIES, 'status', s);
    const queued = by('queued');
    const oldest = queued.reduce((m, d) => (d.createdAt < m ? d.createdAt : m), iso(t));
    const recent = (list, field, days) => list.filter((d) => (d[field] || d.updatedAt || d.createdAt) >= since(days)).length;
    const sent7 = recent(by('sent'), 'sentAt', 7) + recent(by('delivered'), 'sentAt', 7);
    const bounced7 = recent(by('bounced'), 'bouncedAt', 7);
    const complained7 = recent(by('complained'), 'complainedAt', 7);
    const handed = sent7 + bounced7 + complained7;
    return {
      queued: queued.length,
      retrying: queued.filter((d) => d.attempts > 0).length,
      oldestQueuedMinutes: queued.length ? Math.round((t - Date.parse(oldest)) / 60000) : 0,
      failed24h: recent(by('failed'), 'failedAt', 1),
      skipped7d: recent(by('skipped'), 'updatedAt', 7),
      sent7d: sent7,
      delivered7d: recent(by('delivered'), 'deliveredAt', 7),
      bounced7d: bounced7,
      complained7d: complained7,
      bounceRate: handed ? Math.round(((bounced7 + complained7) / handed) * 1000) / 10 : 0,
    };
  }
  // Short, plain warnings for the admin dashboard.
  function problems() {
    const s = stats();
    const out = [];
    if (s.failed24h) out.push(`${s.failed24h} email${s.failed24h === 1 ? '' : 's'} failed in the last day after ${MAX_ATTEMPTS} tries`);
    if (s.oldestQueuedMinutes >= 30) out.push(`emails have been waiting to send for ${s.oldestQueuedMinutes} minutes`);
    if (s.bounceRate >= 5 && s.sent7d >= 20) out.push(`${s.bounceRate}% of emails bounced or were reported as spam this week`);
    return out;
  }
  const recentDeliveries = (status, limit = 50) => (status ? db.where(DELIVERIES, 'status', status, { limit }) : db.all(DELIVERIES).slice(0, limit));
  const suppressions = () => db.all(SUPPRESSIONS);
  // Puts a failed task back in the queue (an Admin asked to try again).
  function retry(id) {
    const d = db.all(DELIVERIES).find((x) => x.id === id && x.status === 'failed');
    if (!d) return false;
    save(d, { status: 'queued', attempts: 0, nextAttemptAt: iso() });
    kick();
    return true;
  }

  return {
    TYPES, CATEGORIES, OPTIONAL_CATEGORIES, rkOf, candidateRk, addressHash, template, emit, work, start, prefsOf, setPrefs, emailAllowed, pushAllowed, onNotification,
    list, unreadCount, find, markRead, markAllRead, forget, forgetCompany, prune, stats, problems, recentDeliveries, suppressions, unsuppress, suppress, retry,
    verifySignature, applyWebhook, safeLink,
  };
}

module.exports = { create, TYPES, CATEGORIES, OPTIONAL_CATEGORIES, candidateRk, rkOf, addressHash, BACKOFF_MINUTES, MAX_ATTEMPTS };
