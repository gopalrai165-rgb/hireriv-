// Staging mode (SITE_ENV=staging): a full copy of the site for the team to
// try changes on before they reach the live site (docs/LAUNCH.md, stage 0).
//
// - Search engines are kept out: robots.txt disallows everything and every
//   answer carries X-Robots-Tag: noindex.
// - Every page shows a banner saying it is the test site.
// - With STAGING_PASSWORD set, every page asks for that password first
//   (a cookie then remembers it for 30 days). /healthz, the public API
//   (/api/v1, it has its own keys) and provider webhooks stay open so
//   monitors and payment sandboxes work.
// - Emails and text messages reach only the addresses and numbers listed in
//   STAGING_EMAIL_ALLOW / STAGING_SMS_ALLOW; everything else is written to the
//   outbox folder, so a copy of real data can never message real people.
const crypto = require('crypto');

const COOKIE = 'hr_staging';
const COOKIE_DAYS = 30;
// Paths that never ask for the staging password.
const OPEN = [/^\/healthz$/, /^\/robots\.txt$/, /^\/api\/v1\//, /^\/api\/webhooks\//, /^\/webhooks\//, /^\/staging-sign-in$/];

const isStaging = (env = process.env) => env.SITE_ENV === 'staging';

// "a@b.com, @hireriv.com" → does `email` match an address or a whole domain?
function emailAllowed(email, env = process.env) {
  const e = String(email || '').trim().toLowerCase();
  const list = String(env.STAGING_EMAIL_ALLOW || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  return Boolean(e) && list.some((x) => (x.startsWith('@') ? e.endsWith(x) : e === x));
}

// Numbers compared by their last 10 digits, so +91 98220 00001 and 9822000001 match.
const last10 = (n) => String(n || '').replace(/\D/g, '').slice(-10);
function smsAllowed(number, env = process.env) {
  const n = last10(number);
  return n.length === 10 && String(env.STAGING_SMS_ALLOW || '').split(',').map(last10).includes(n);
}

// Splits a recipient list into who may be emailed and who goes to the outbox.
function splitRecipients(to, env = process.env) {
  const all = String(to || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!isStaging(env)) return { send: all, hold: [] };
  // "Name <a@b.com>" is checked by the address inside the brackets.
  const addr = (x) => (x.match(/<([^>]+)>/) || [null, x])[1];
  return { send: all.filter((x) => emailAllowed(addr(x), env)), hold: all.filter((x) => !emailAllowed(addr(x), env)) };
}

function create({ env = process.env, limit = () => (req, res, next) => next() } = {}) {
  const on = isStaging(env);
  const password = String(env.STAGING_PASSWORD || '');
  // The cookie proves the password without holding it; changing the password
  // signs everyone out.
  const token = crypto.createHmac('sha256', password || 'unset').update('hireriv-staging').digest('base64url');
  const hasCookie = (req) => {
    const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
    if (!m) return false;
    const a = Buffer.from(m[1]);
    const b = Buffer.from(token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  const safeNext = (s) => (/^\/(?!\/)[^\s\\]*$/.test(String(s || '')) ? String(s) : '/');

  const page = (next, error) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Staging site</title><link rel="stylesheet" href="/css/style.css"></head>
<body class="page-misc"><main id="main" class="container section"><div class="form-card" style="max-width:420px;margin:48px auto">
<h1>Hireriv staging</h1><p>This is the test copy of Hireriv for the team. Enter the staging password to continue.</p>
${error ? `<p class="notice notice-err" role="alert">${error}</p>` : ''}
<form class="form" method="post" action="/staging-sign-in"><input type="hidden" name="next" value="${safeNext(next).replace(/"/g, '&quot;')}">
<label>Staging password<input type="password" name="password" autocomplete="current-password" required autofocus></label>
<button class="btn btn-primary" type="submit">Continue</button></form>
<p class="muted small">Looking for jobs? Go to the live site instead.</p></div></main></body></html>`;

  // Headers and the banner flag for every answer; the password gate.
  function middleware(req, res, next) {
    if (!on) return next();
    res.set('X-Robots-Tag', 'noindex, nofollow');
    res.locals.staging = true;
    if (!password || OPEN.some((re) => re.test(req.path)) || hasCookie(req)) return next();
    if (req.method === 'GET' || req.method === 'HEAD') return res.status(401).set('Cache-Control', 'no-store').type('html').send(page(req.originalUrl));
    return res.status(401).json({ ok: false, errors: ['Sign in to the staging site first'] });
  }

  function routes(app) {
    if (!on) return;
    app.get('/staging-sign-in', (req, res) => res.set('Cache-Control', 'no-store').type('html').send(page(req.query.next)));
    app.post('/staging-sign-in', limit('staging-sign-in', 10), (req, res) => {
      const given = Buffer.from(String((req.body && req.body.password) || ''));
      const want = Buffer.from(password);
      const ok = password && given.length === want.length && crypto.timingSafeEqual(given, want);
      if (!ok) return res.status(401).set('Cache-Control', 'no-store').type('html').send(page(req.body && req.body.next, 'That password is not right.'));
      const secure = req.secure ? '; Secure' : '';
      res.set('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_DAYS * 86400}${secure}`);
      res.redirect(303, safeNext(req.body && req.body.next));
    });
  }

  const robots = () => 'User-agent: *\nDisallow: /\n';

  return { on, middleware, routes, robots };
}

module.exports = { create, isStaging, emailAllowed, smsAllowed, splitRecipients, COOKIE };
