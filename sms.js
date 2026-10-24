// Text messages (mobile verification codes). Set SMS_WEBHOOK_URL to your SMS
// provider's HTTP endpoint (or a small relay in front of it): each message is
// POSTed as JSON { to, message } with SMS_WEBHOOK_TOKEN as a Bearer token.
// Without it, messages are written to the email outbox folder as .sms.txt
// files, like emails during development.
const fs = require('fs');
const path = require('path');

const OUTBOX_DIR = process.env.OUTBOX_DIR ? path.resolve(process.env.OUTBOX_DIR) : path.join(__dirname, 'data', 'outbox');
const URL = process.env.SMS_WEBHOOK_URL || '';
let sent = 0;

const configured = () => Boolean(URL);

async function send(to, message) {
  const order = `${Date.now()}-${String(++sent).padStart(6, '0')}`;
  try {
    if (!URL) {
      fs.mkdirSync(OUTBOX_DIR, { recursive: true });
      fs.writeFileSync(path.join(OUTBOX_DIR, `${order}-sms.sms.txt`), `To: ${to}\n\n${message}\n`);
      return true;
    }
    const res = await fetch(URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(process.env.SMS_WEBHOOK_TOKEN ? { authorization: `Bearer ${process.env.SMS_WEBHOOK_TOKEN}` } : {}) },
      body: JSON.stringify({ to, message }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`SMS provider answered ${res.status}`);
    return true;
  } catch (err) {
    // The number is personal data: log only that it failed.
    console.error(`Text message failed: ${err.message}`);
    return false;
  }
}

module.exports = { send, configured };
