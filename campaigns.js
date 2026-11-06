// Email campaigns (Step 194): news and job round-ups to the people who asked for
// them. Consent was already recorded (privacy.js setMarketing, the newsletter
// list) but nothing could use it.
//
// Rules: only the opt-in list is ever written to, and consent and past bounces
// are checked again just before each email. An Admin writes the campaign, must
// send themselves a test of exactly that wording, and confirms their password to
// send. Every email has a one-click unsubscribe (RFC 8058) whose link holds no
// address. Sending goes in batches from a queue in the database, so a restart
// carries on and nobody gets it twice; each address leaves the queue as it is
// used, so a finished campaign keeps only its counts.
const crypto = require('crypto');
const identity = require('./identity');

const CAMPAIGNS = 'email-campaigns';
const QUEUE = 'email-campaign-queue';
const SECRET_KEY = 'campaigns:secret';
const SUBSCRIBERS = 'newsletter';
const BATCH = Number(process.env.CAMPAIGN_BATCH) || 50;
const TICK_MS = Number(process.env.CAMPAIGN_TICK_MS) || 60000;
const iso = () => new Date().toISOString();
const line = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n);
const lower = (s) => String(s || '').trim().toLowerCase();

function register(app, deps) {
  const { db, team, adminAuth, requireAdmin, requireConfirmed, sameOrigin, limit, privacy, notify, mailer, site, baseUrl, readSubmissions, realContact, ops } = deps;

  // ---------- unsubscribe links ----------
  function secret() {
    let s = db.metaGet(SECRET_KEY);
    if (!s) { s = crypto.randomBytes(32).toString('hex'); db.metaSet(SECRET_KEY, s); }
    return s;
  }
  const sign = (text) => crypto.createHmac('sha256', secret()).update(text).digest('base64url').slice(0, 32);
  const tokenFor = (subscriberId, campaignId) => `${subscriberId}.${campaignId}.${sign(`${subscriberId}.${campaignId}`)}`;
  function readToken(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    const want = Buffer.from(sign(`${parts[0]}.${parts[1]}`));
    const got = Buffer.from(parts[2]);
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
    return { subscriberId: parts[0], campaignId: parts[1] };
  }

  // ---------- who it can go to ----------
  const subscribers = () => readSubmissions(SUBSCRIBERS);
  const canSendTo = (email) => Boolean(email) && !identity.isMobileOnly(email) && !notify.suppressed(email);
  const audience = () => {
    const seen = new Set();
    return subscribers().filter((s) => {
      const key = lower(s.email);
      if (seen.has(key) || !canSendTo(key)) return false;
      seen.add(key);
      return true;
    });
  };

  // ---------- the campaign ----------
  const find = (id) => db.where(CAMPAIGNS, 'id', String(id))[0] || null;
  const all = () => [...db.all(CAMPAIGNS)].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  function readForm(body) {
    const values = {
      subject: line(body.subject, 120),
      text: String(body.text == null ? '' : body.text).replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, 6000),
      buttonLabel: line(body.buttonLabel, 40),
      buttonLink: line(body.buttonLink, 500),
    };
    const errors = [];
    if (values.subject.length < 5) errors.push('Write a subject of at least 5 characters.');
    if (values.text.length < 20) errors.push('Write at least a sentence or two in the message.');
    if (Boolean(values.buttonLabel) !== Boolean(values.buttonLink)) errors.push('A button needs both its words and its link.');
    if (values.buttonLink && !/^(https:\/\/[^\s]+|\/[^\s/][^\s]*)$/.test(values.buttonLink)) errors.push('The button link must start with https:// or be a page on this site, such as /jobs.');
    return { values, errors };
  }
  const linkOf = (c) => (c.buttonLink && c.buttonLink.startsWith('/') ? `${baseUrl}${c.buttonLink}` : c.buttonLink);
  const postal = () => line(realContact(site).address, 300);
  const mailOf = (c, unsubscribe) => ({ subject: c.subject, text: c.text, buttonLabel: c.buttonLabel, buttonLink: linkOf(c), unsubscribe, postal: postal() });

  // ---------- sending ----------
  let ticking = false;
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const c = all().find((x) => x.status === 'sending');
      if (!c) return;
      const batch = db.where(QUEUE, 'campaignId', c.id).slice(0, BATCH);
      if (batch.length) {
        // Consent as it is now, not as it was when the campaign started.
        const current = new Map(subscribers().map((s) => [lower(s.email), s]));
        const counts = { sent: 0, skipped: 0, failed: 0 };
        // Out of the queue first: a crash may lose an email but never sends one twice.
        db.remove(QUEUE, batch.map((r) => r.id));
        for (const row of batch) {
          const s = current.get(lower(row.email));
          if (!s || !canSendTo(s.email)) { counts.skipped += 1; continue; }
          try {
            const ok = await mailer.campaign(s.email, mailOf(c, `${baseUrl}/newsletter/unsubscribe/${tokenFor(s.id, c.id)}`));
            counts[ok === false ? 'failed' : 'sent'] += 1;
          } catch (e) {
            counts.failed += 1;
            console.error('A campaign email failed:', e.message);
          }
        }
        const now = find(c.id) || c;
        db.update(CAMPAIGNS, { ...now, sent: (now.sent || 0) + counts.sent, skipped: (now.skipped || 0) + counts.skipped, failed: (now.failed || 0) + counts.failed });
      }
      if (!db.where(QUEUE, 'campaignId', c.id).length) {
        const now = find(c.id) || c;
        if (now.status === 'sending') db.update(CAMPAIGNS, { ...now, status: 'sent', finishedAt: iso() });
      }
    } finally {
      ticking = false;
    }
  }
  const tracked = ops && ops.track ? ops.track('email-campaigns', tick, TICK_MS) : tick;
  setInterval(() => { Promise.resolve(tracked()).catch((e) => console.error('Campaign sending failed:', e.message)); }, TICK_MS).unref();

  // ---------- pages ----------
  const view = (req, res, section, locals = {}, status = 200) => {
    res.status(status).set('Cache-Control', 'no-store').render('admin-campaigns', {
      title: 'Email campaigns', page: 'admin', noindex: true, section, msg: line(req.query.msg, 200), errors: [], campaign: null, values: {}, preview: '', list: [], audienceCount: audience().length, listCount: subscribers().length, ...locals,
    });
  };
  const back = (res, id, msg) => res.redirect(303, `/admin/campaigns${id ? `/${id}` : ''}?msg=${encodeURIComponent(msg)}`);
  const previewOf = (c) => mailer.campaignPreview(mailOf(c, '#'));
  const open = (req, res, c, locals = {}, status = 200) => view(req, res, 'one', { campaign: c, values: c, preview: previewOf(c), ...locals }, status);

  app.get('/admin/campaigns', adminAuth, requireAdmin, (req, res) => view(req, res, 'list', { list: all() }));
  app.get('/admin/campaigns/new', adminAuth, requireAdmin, (req, res) => view(req, res, 'new'));
  app.post('/admin/campaigns', adminAuth, requireAdmin, limit('campaigns', 30), sameOrigin, (req, res) => {
    const { values, errors } = readForm(req.body);
    if (errors.length) return view(req, res, 'new', { errors, values }, 400);
    const c = { id: crypto.randomUUID(), ...values, status: 'draft', createdAt: iso(), createdBy: req.admin.name, createdById: req.admin.id, testedAt: null, total: 0, sent: 0, skipped: 0, failed: 0, unsubscribed: 0 };
    db.prepend(CAMPAIGNS, c);
    team.log(req.admin, 'Wrote an email campaign draft', c.subject);
    back(res, c.id, 'Saved as a draft. Send yourself a test next.');
  });
  app.get('/admin/campaigns/:id', adminAuth, requireAdmin, (req, res, next) => {
    const c = find(req.params.id);
    if (!c) return next();
    open(req, res, c);
  });
  app.post('/admin/campaigns/:id', adminAuth, requireAdmin, limit('campaigns', 30), sameOrigin, (req, res, next) => {
    const c = find(req.params.id);
    if (!c) return next();
    if (c.status !== 'draft') return back(res, c.id, 'This campaign has been sent, so it can no longer be changed.');
    const { values, errors } = readForm(req.body);
    if (errors.length) return open(req, res, c, { errors, values }, 400);
    const changed = ['subject', 'text', 'buttonLabel', 'buttonLink'].some((k) => (c[k] || '') !== values[k]);
    db.update(CAMPAIGNS, { ...c, ...values, testedAt: changed ? null : c.testedAt });
    back(res, c.id, changed ? 'Saved. The wording changed, so send yourself a new test.' : 'Saved.');
  });
  app.post('/admin/campaigns/:id/test', adminAuth, requireAdmin, limit('campaign-test', 20), sameOrigin, async (req, res, next) => {
    const c = find(req.params.id);
    if (!c) return next();
    if (c.status !== 'draft') return back(res, c.id, 'This campaign has been sent.');
    if (!req.admin.email) return back(res, c.id, 'Your team account has no email address to send the test to.');
    let ok = false;
    try { ok = await mailer.campaign(req.admin.email, mailOf(c, `${baseUrl}/newsletter/unsubscribe/${tokenFor('test', c.id)}`)) !== false; } catch (e) { console.error('A campaign test failed:', e.message); }
    if (!ok) return back(res, c.id, 'The test could not be sent. Check the email settings and try again.');
    db.update(CAMPAIGNS, { ...find(c.id), testedAt: iso() });
    back(res, c.id, `Test sent to ${req.admin.email}. Check it, then send the campaign.`);
  });
  app.post('/admin/campaigns/:id/send', adminAuth, requireAdmin, limit('campaign-send', 10), sameOrigin, requireConfirmed, (req, res, next) => {
    const c = find(req.params.id);
    if (!c) return next();
    if (c.status !== 'draft') return back(res, c.id, 'This campaign has already been sent.');
    if (!c.testedAt) return back(res, c.id, 'Send yourself a test of this wording first.');
    if (all().some((x) => x.status === 'sending')) return back(res, c.id, 'Another campaign is still sending. Wait until it finishes.');
    const people = audience();
    if (!people.length) return back(res, c.id, 'Nobody has asked for these emails yet.');
    db.transaction(() => {
      db.update(CAMPAIGNS, { ...c, status: 'sending', startedAt: iso(), startedBy: req.admin.name, total: people.length });
      for (const s of people) db.prepend(QUEUE, { id: crypto.randomUUID(), campaignId: c.id, email: lower(s.email) });
    });
    team.log(req.admin, `Sent an email campaign to ${people.length} people`, c.subject);
    back(res, c.id, `Sending to ${people.length} ${people.length === 1 ? 'person' : 'people'}. This page shows how far it has got.`);
  });
  app.post('/admin/campaigns/:id/stop', adminAuth, requireAdmin, limit('campaigns', 30), sameOrigin, (req, res, next) => {
    const c = find(req.params.id);
    if (!c) return next();
    if (c.status !== 'sending') return back(res, c.id, 'This campaign is not sending.');
    db.transaction(() => {
      db.remove(QUEUE, db.where(QUEUE, 'campaignId', c.id).map((r) => r.id));
      db.update(CAMPAIGNS, { ...find(c.id), status: 'stopped', finishedAt: iso() });
    });
    team.log(req.admin, 'Stopped an email campaign', c.subject);
    back(res, c.id, 'Stopped. Nobody else will get it.');
  });
  app.post('/admin/campaigns/:id/delete', adminAuth, requireAdmin, limit('campaigns', 30), sameOrigin, (req, res, next) => {
    const c = find(req.params.id);
    if (!c) return next();
    if (c.status !== 'draft') return back(res, c.id, 'Only a draft can be deleted: this one is kept as a record of what was sent.');
    db.remove(CAMPAIGNS, [c.id]);
    team.log(req.admin, 'Deleted an email campaign draft', c.subject);
    back(res, '', 'Draft deleted.');
  });

  // ---------- leaving the list ----------
  // Opening the link only asks: mail scanners open links. The button, or the mail
  // program's own one-click request, is what takes the person off the list.
  const ask = (res, token, done, status = 200) => res.status(status).render('newsletter-unsubscribe', { title: 'Stop these emails', page: '', noindex: true, token, done });
  app.get('/newsletter/unsubscribe/:token', limit('newsletter-unsubscribe', 60), (req, res) => {
    const t = readToken(req.params.token);
    if (!t) return res.status(404).render('thanks', { title: 'Link not recognised', page: '', ok: false, message: 'This link is not valid. You can change your email choices in your account, or write to us.', noindex: true });
    res.set('Cache-Control', 'no-store');
    ask(res, req.params.token, !subscribers().some((s) => s.id === t.subscriberId));
  });
  app.post('/newsletter/unsubscribe/:token', limit('newsletter-unsubscribe', 60), (req, res) => {
    const t = readToken(req.params.token);
    if (!t) return res.status(404).render('thanks', { title: 'Link not recognised', page: '', ok: false, message: 'This link is not valid. You can change your email choices in your account, or write to us.', noindex: true });
    res.set('Cache-Control', 'no-store');
    const s = subscribers().find((x) => x.id === t.subscriberId);
    if (s) {
      privacy.setMarketing(s.email, false, 'unsubscribe link');
      const c = find(t.campaignId);
      if (c) db.update(CAMPAIGNS, { ...c, unsubscribed: (c.unsubscribed || 0) + 1 });
    }
    ask(res, req.params.token, true);
  });

  return { tick, audience };
}

module.exports = { register };
