// WhatsApp updates for job seekers who said yes to them (Settings, "How we may
// contact you"). Only application and interview updates are sent, never
// marketing. Pick a provider with WHATSAPP_PROVIDER:
//   meta     WhatsApp Cloud API (WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID,
//            WHATSAPP_TEMPLATE). Messages a business starts must use a template
//            Meta has approved: create a Utility template with one body
//            variable, e.g. "{{1}}", and give its name here
//            (WHATSAPP_TEMPLATE_LANG, default "en").
//   webhook  your own relay: each message is POSTed as JSON { to, message } to
//            WHATSAPP_WEBHOOK_URL with WHATSAPP_WEBHOOK_TOKEN as a Bearer token
// With no provider, messages are written to the email outbox folder as
// .whatsapp.txt files, like emails during development.
const fs = require('fs');
const path = require('path');
const staging = require('./staging');
const { e164 } = require('./sms');

const OUTBOX_DIR = process.env.OUTBOX_DIR ? path.resolve(process.env.OUTBOX_DIR) : path.join(__dirname, 'data', 'outbox');
const PROVIDERS = ['meta', 'webhook'];
const NEEDS = { meta: ['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_TEMPLATE'], webhook: ['WHATSAPP_WEBHOOK_URL'] };
// Notification categories that may go to WhatsApp.
const CATEGORIES = ['applications', 'interviews'];
let sent = 0;

const val = (env, k) => String(env[k] || '').trim();
const provider = (env = process.env) => val(env, 'WHATSAPP_PROVIDER').toLowerCase();
function missing(env = process.env) {
  const p = provider(env);
  if (!p) return [];
  if (!PROVIDERS.includes(p)) return [`WHATSAPP_PROVIDER (unknown: ${p})`];
  return NEEDS[p].filter((k) => !val(env, k));
}
const configured = (env = process.env) => Boolean(provider(env)) && !missing(env).length;

const request = {
  async meta(env, to, message) {
    const base = val(env, 'WHATSAPP_API_URL') || 'https://graph.facebook.com/v21.0';
    const res = await fetch(`${base}/${encodeURIComponent(val(env, 'WHATSAPP_PHONE_NUMBER_ID'))}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${val(env, 'WHATSAPP_TOKEN')}` },
      body: JSON.stringify({
        messaging_product: 'whatsapp', to: to.replace(/^\+/, ''), type: 'template',
        template: { name: val(env, 'WHATSAPP_TEMPLATE'), language: { code: val(env, 'WHATSAPP_TEMPLATE_LANG') || 'en' }, components: [{ type: 'body', parameters: [{ type: 'text', text: message.slice(0, 1000) }] }] },
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`WhatsApp answered ${res.status}${body.error && body.error.code ? ` (error ${body.error.code})` : ''}`);
    }
  },
  async webhook(env, to, message) {
    const res = await fetch(val(env, 'WHATSAPP_WEBHOOK_URL'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(val(env, 'WHATSAPP_WEBHOOK_TOKEN') ? { authorization: `Bearer ${val(env, 'WHATSAPP_WEBHOOK_TOKEN')}` } : {}) },
      body: JSON.stringify({ to, message }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`WhatsApp relay answered ${res.status}`);
  },
};

// Resolves true when the provider (or the outbox) took the message.
async function send(to, message, env = process.env) {
  to = e164(to);
  const order = `${Date.now()}-${String(++sent).padStart(6, '0')}`;
  try {
    const p = provider(env);
    // Staging sends only to the numbers in STAGING_SMS_ALLOW (staging.js).
    if (!p || (staging.isStaging(env) && !staging.smsAllowed(to, env))) {
      fs.mkdirSync(OUTBOX_DIR, { recursive: true });
      fs.writeFileSync(path.join(OUTBOX_DIR, `${order}-whatsapp.whatsapp.txt`), `To: ${to}\n\n${message}\n`);
      return true;
    }
    const gaps = missing(env);
    if (gaps.length) throw new Error(`WhatsApp is not set up: ${gaps.join(', ')} missing`);
    await request[p](env, to, message);
    return true;
  } catch (err) {
    // The number is personal data: log only that it failed.
    console.error(`WhatsApp message failed: ${err.message}`);
    return false;
  }
}

// The listener for new in-app notifications: a job seeker who agreed to
// WhatsApp updates and has a mobile number gets application and interview
// updates there too. `candidates()` lists the accounts; `rkOf(email)` is the
// notification key of an account.
function notifier({ candidates, rkOf, siteName, baseUrl, env = process.env }) {
  return (n) => {
    if (!n || !String(n.rk || '').startsWith('c:') || !CATEGORIES.includes(n.category)) return null;
    const c = candidates().find((x) => x.comms && x.comms.whatsapp && x.profile && x.profile.phone && rkOf(x.email) === n.rk);
    if (!c) return null;
    const link = n.link ? ` ${String(baseUrl || '').replace(/\/$/, '')}${n.link}` : '';
    return send(c.profile.phone, `${siteName}: ${n.title}. ${n.body || ''}${link}`.replace(/\s+/g, ' ').trim(), env);
  };
}

module.exports = { send, notifier, configured, provider, missing, PROVIDERS, CATEGORIES };
