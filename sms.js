// Text messages (mobile verification codes). Pick a provider with SMS_PROVIDER:
//   msg91   MSG91's Flow API with a DLT-approved template (MSG91_AUTH_KEY,
//           MSG91_TEMPLATE_ID; the code goes in the template variable named
//           by MSG91_CODE_VAR, default "OTP")
//   twilio  Twilio's Messages API (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and
//           TWILIO_FROM or TWILIO_MESSAGING_SERVICE_SID)
//   webhook your own relay: each message is POSTed as JSON { to, message } to
//           SMS_WEBHOOK_URL with SMS_WEBHOOK_TOKEN as a Bearer token
// SMS_WEBHOOK_URL alone still means "webhook". With no provider, messages are
// written to the email outbox folder as .sms.txt files, like emails during
// development. Settings are read when a message is sent, so a restart is not
// needed to test them from the command line (`npm run sms:test`).
const fs = require('fs');
const path = require('path');

const OUTBOX_DIR = process.env.OUTBOX_DIR ? path.resolve(process.env.OUTBOX_DIR) : path.join(__dirname, 'data', 'outbox');
const PROVIDERS = ['msg91', 'twilio', 'webhook'];
const NEEDS = {
  msg91: ['MSG91_AUTH_KEY', 'MSG91_TEMPLATE_ID'],
  twilio: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'],
  webhook: ['SMS_WEBHOOK_URL'],
};
let sent = 0;

// Indian numbers in any common form become +91 and ten digits; others keep their digits.
const e164 = (to) => { const d = String(to || '').replace(/\D/g, ''); const m = d.match(/^(?:91|0)?([6-9]\d{9})$/); return m ? `+91${m[1]}` : `+${d}`; };
const val = (env, k) => String(env[k] || '').trim();
function provider(env = process.env) {
  const p = val(env, 'SMS_PROVIDER').toLowerCase();
  if (p) return p;
  return val(env, 'SMS_WEBHOOK_URL') ? 'webhook' : '';
}
// Settings the chosen provider still needs ([] when ready or none chosen).
function missing(env = process.env) {
  const p = provider(env);
  if (!p) return [];
  if (!PROVIDERS.includes(p)) return [`SMS_PROVIDER (unknown: ${p})`];
  const out = NEEDS[p].filter((k) => !val(env, k));
  if (p === 'twilio' && !val(env, 'TWILIO_FROM') && !val(env, 'TWILIO_MESSAGING_SERVICE_SID')) out.push('TWILIO_FROM or TWILIO_MESSAGING_SERVICE_SID');
  return out;
}
const configured = (env = process.env) => Boolean(provider(env)) && !missing(env).length;

// One request per provider. `to` is "+91" and ten digits.
const request = {
  async msg91(env, to, message, code) {
    // DLT rules in India: the text is the approved template, only the code varies.
    if (!code) throw new Error('MSG91 sends approved templates only; this message has no code');
    const res = await fetch(val(env, 'MSG91_API_URL') || 'https://control.msg91.com/api/v5/flow', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', authkey: val(env, 'MSG91_AUTH_KEY') },
      body: JSON.stringify({ template_id: val(env, 'MSG91_TEMPLATE_ID'), short_url: '0', recipients: [{ mobiles: to.replace(/^\+/, ''), [val(env, 'MSG91_CODE_VAR') || 'OTP']: code }] }),
      signal: AbortSignal.timeout(10000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.type === 'error') throw new Error(`MSG91 answered ${res.status}${body.message ? `: ${String(body.message).slice(0, 120)}` : ''}`);
  },
  async twilio(env, to, message) {
    const sid = val(env, 'TWILIO_ACCOUNT_SID');
    const form = new URLSearchParams({ To: to, Body: message });
    if (val(env, 'TWILIO_MESSAGING_SERVICE_SID')) form.set('MessagingServiceSid', val(env, 'TWILIO_MESSAGING_SERVICE_SID'));
    else form.set('From', val(env, 'TWILIO_FROM'));
    const base = val(env, 'TWILIO_API_URL') || 'https://api.twilio.com';
    const res = await fetch(`${base}/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(`${sid}:${val(env, 'TWILIO_AUTH_TOKEN')}`).toString('base64')}` },
      body: form,
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`Twilio answered ${res.status}${body.code ? ` (error ${body.code})` : ''}`);
    }
  },
  async webhook(env, to, message) {
    const res = await fetch(val(env, 'SMS_WEBHOOK_URL'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(val(env, 'SMS_WEBHOOK_TOKEN') ? { authorization: `Bearer ${val(env, 'SMS_WEBHOOK_TOKEN')}` } : {}) },
      body: JSON.stringify({ to, message }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`SMS provider answered ${res.status}`);
  },
};

// `code` is the verification code inside `message` (template providers send
// only the code). Resolves true when the provider accepted the message.
async function send(to, message, { code = '' } = {}, env = process.env) {
  to = e164(to);
  const order = `${Date.now()}-${String(++sent).padStart(6, '0')}`;
  try {
    const p = provider(env);
    if (!p) {
      fs.mkdirSync(OUTBOX_DIR, { recursive: true });
      fs.writeFileSync(path.join(OUTBOX_DIR, `${order}-sms.sms.txt`), `To: ${to}\n\n${message}\n`);
      return true;
    }
    const gaps = missing(env);
    if (gaps.length) throw new Error(`text messages are not set up: ${gaps.join(', ')} missing`);
    await request[p](env, to, message, code);
    return true;
  } catch (err) {
    // The number is personal data: log only that it failed.
    console.error(`Text message failed: ${err.message}`);
    return false;
  }
}

module.exports = { send, configured, provider, missing, e164, PROVIDERS };

// `npm run sms:test -- 9876543210` sends one test code with the settings in .env.
if (require.main === module) {
  const mobile = String(process.argv[2] || '').replace(/\D/g, '').replace(/^(91|0)(?=\d{10}$)/, '');
  if (!/^[6-9]\d{9}$/.test(mobile)) {
    console.log('Usage: npm run sms:test -- <10-digit Indian mobile number>');
    process.exitCode = 1;
  } else {
    console.log(provider() ? `Sending a test code with ${provider()}…` : 'No SMS_PROVIDER set: the message goes to the outbox folder.');
    send(`+91${mobile}`, '123456 is your test code. If you did not expect it, ignore this message.', { code: '123456' })
      .then((ok) => { console.log(ok ? 'Accepted by the provider. Check the phone.' : 'Not sent (see the error above).'); process.exitCode = ok ? 0 : 1; });
  }
}
