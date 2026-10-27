// Launch configuration checks. With NODE_ENV=production the server refuses to
// start while any "error" below is present, so a live site can't come up with
// a placeholder password, plain-http links, file encryption keyed from inside
// the database, half-set payment keys or test-only providers. "Warnings" are
// printed but don't stop it. `npm run check:config` prints the same report
// for the settings in .env (or the environment) without starting anything.
const vault = require('./vault');
const sms = require('./sms');

// The placeholder in .env.example and other values nobody should go live with.
const WEAK_PASSWORDS = new Set(['change-me-to-a-long-password', 'admin', 'password', 'changeme', 'hireriv']);
const MIN_ADMIN_PASS = 12;
const MIN_SECRET = 16;

function check(env = process.env) {
  const errors = [];
  const warnings = [];
  const set = (k) => String(env[k] || '').trim() !== '';
  const production = env.NODE_ENV === 'production';

  // Addresses: every link, sitemap entry, canonical and cookie flag depends on it.
  let site = null;
  if (!set('SITE_URL')) errors.push('SITE_URL is not set (links, the sitemap and job data would point at localhost)');
  else {
    try { site = new URL(env.SITE_URL); } catch (e) { errors.push('SITE_URL is not a valid address'); }
    if (site && site.protocol !== 'https:') errors.push('SITE_URL must start with https://');
    if (site && /^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(site.hostname)) errors.push('SITE_URL points at this computer, not the live domain');
  }

  // The owner account.
  if (set('ADMIN_PASS')) {
    if (WEAK_PASSWORDS.has(String(env.ADMIN_PASS).toLowerCase())) errors.push('ADMIN_PASS is still a placeholder; choose a long, unique password');
    else if (String(env.ADMIN_PASS).length < MIN_ADMIN_PASS) errors.push(`ADMIN_PASS must be at least ${MIN_ADMIN_PASS} characters`);
  } else warnings.push('ADMIN_PASS is not set: only team members already invited can sign in to the admin panel');
  if (set('RESET_OWNER_2FA')) warnings.push('RESET_OWNER_2FA is set: it removes the owner\'s two-step sign-in on every start; remove it after one start');

  // Encryption at rest: the key must live apart from the database and its backups.
  if (!set('FILE_ENCRYPTION_KEY')) errors.push('FILE_ENCRYPTION_KEY is not set (uploaded documents would be encrypted with a key kept in the database; see docs/SECURITY.md)');
  else {
    try { vault.parseKey(env.FILE_ENCRYPTION_KEY); } catch (e) { errors.push(`FILE_ENCRYPTION_KEY is not valid: ${e.message}`); }
  }
  for (const k of String(env.FILE_ENCRYPTION_KEYS_OLD || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    try { vault.parseKey(k); } catch (e) { errors.push('FILE_ENCRYPTION_KEYS_OLD has a key that is not valid'); break; }
  }

  // Email: sign-in links, verification codes and application emails need it.
  if (!set('SMTP_HOST')) errors.push('SMTP_HOST is not set (sign-in links and application emails would only be saved to the outbox folder)');
  else if (!set('SMTP_USER') || !set('SMTP_PASS')) warnings.push('SMTP_HOST is set without SMTP_USER / SMTP_PASS; most providers refuse unauthenticated mail');
  if (!set('MAIL_FROM')) warnings.push('MAIL_FROM is not set: emails come from the site email in Admin → Settings');
  if (set('EMAIL_WEBHOOK_SECRET') && String(env.EMAIL_WEBHOOK_SECRET).length < MIN_SECRET) errors.push(`EMAIL_WEBHOOK_SECRET must be at least ${MIN_SECRET} characters`);

  // Text messages: mobile sign-in and sign-up are hidden without a provider.
  const smsGaps = sms.missing(env);
  if (smsGaps.length) errors.push(`Text messages are half set up (SMS_PROVIDER=${sms.provider(env)}): ${smsGaps.join(', ')} missing`);
  else if (!sms.provider(env)) warnings.push('No text-message provider (SMS_PROVIDER): signing in and signing up with a mobile code are hidden, and employer mobile codes are only saved to the outbox folder');
  else if (sms.provider(env) === 'webhook' && !/^https:/.test(String(env.SMS_WEBHOOK_URL))) errors.push('SMS_WEBHOOK_URL must start with https://');

  // Payments: all three Razorpay values together, or none.
  const rzp = ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'];
  const rzpSet = rzp.filter(set);
  if (rzpSet.length && rzpSet.length < rzp.length) errors.push(`Payments are half set up: ${rzp.filter((k) => !set(k)).join(', ')} missing`);
  if (set('RAZORPAY_KEY_ID') && /^rzp_test_/.test(env.RAZORPAY_KEY_ID)) warnings.push('Razorpay test keys are set: payments run in the sandbox (switch to live keys after the checks in docs/BILLING.md)');
  if (!rzpSet.length) warnings.push('Online payments are not set up (Razorpay keys missing); paid plans can\'t be bought');

  // Providers that exist only for tests.
  if (env.AI_PROVIDER === 'mock') errors.push('AI_PROVIDER=mock is for tests only');

  // Storage and safety nets.
  if (!set('DB_FILE')) warnings.push('DB_FILE is not set: the database is kept in data/ next to the code, not on a persistent disk');
  if (!set('UPLOADS_DIR')) warnings.push('UPLOADS_DIR is not set: resumes are kept in uploads/ next to the code');
  if (!set('BACKUP_DIR')) warnings.push('BACKUP_DIR is not set: daily backups sit on the same disk as the database');
  else if (set('DB_FILE') && require('path').resolve(env.BACKUP_DIR).startsWith(require('path').dirname(require('path').resolve(env.DB_FILE)))) warnings.push('BACKUP_DIR is inside the database folder; use a second disk or a synced folder');
  if (!set('CLAMAV_HOST')) warnings.push('CLAMAV_HOST is not set: uploaded files are type-checked but not virus-scanned');
  if (!set('TRUST_PROXY')) warnings.push('TRUST_PROXY is not set: behind a proxy, rate limits and logs would see the proxy\'s address');
  if (env.NOTIFY_WORKER === 'off') warnings.push('NOTIFY_WORKER=off: this server sends no queued emails (fine only if another copy does)');

  if (!production) warnings.unshift('NODE_ENV is not "production": these checks only stop the server from starting in production');
  return { ok: errors.length === 0, production, errors, warnings };
}

// Printed at start-up and by `npm run check:config`.
function report({ errors, warnings }) {
  const lines = [];
  for (const e of errors) lines.push(`[config] ERROR   ${e}`);
  for (const w of warnings) lines.push(`[config] warning ${w}`);
  if (!errors.length) lines.push('[config] No blocking problems');
  return lines.join('\n');
}

module.exports = { check, report, MIN_ADMIN_PASS };

if (require.main === module) {
  const result = check();
  console.log(report(result));
  process.exitCode = result.errors.length ? 1 : 0;
}
