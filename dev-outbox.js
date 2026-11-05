// Local outbox viewer for development. Without SMTP_HOST (or an SMS provider)
// emails and text messages are only written to data/outbox, so sign-in links
// and codes never reach a real inbox. /dev/outbox lists those messages, newest
// first, with their links and codes, so every sign-in works on a laptop.
//
// Only on: NODE_ENV is not "production", SITE_ENV is not "staging", and the
// request comes straight from this computer (127.0.0.1 / ::1, not a forwarded
// address). Anywhere else the path is a normal 404.
const fs = require('fs');
const path = require('path');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const enabled = (env = process.env) => env.NODE_ENV !== 'production' && env.SITE_ENV !== 'staging';
const fromThisComputer = (req) => /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(String(req.socket && req.socket.remoteAddress));

const qp = (s) => Buffer.from(s.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8');

// Headers and the plain-text part of an .eml written by nodemailer.
function parseEml(raw) {
  const split = raw.search(/\r?\n\r?\n/);
  const head = (split === -1 ? raw : raw.slice(0, split)).replace(/\r?\n[ \t]+/g, ' ');
  const header = (name) => { const m = head.match(new RegExp(`^${name}:\\s*(.*)$`, 'im')); return m ? m[1].trim() : ''; };
  let text = '';
  const part = raw.match(/Content-Type: text\/plain[^\r\n]*\r?\n(?:[^\r\n]+\r?\n)*?\r?\n([\s\S]*?)(?:\r?\n--)/i);
  if (part) {
    const before = raw.slice(0, raw.indexOf(part[1]));
    const encoding = (before.match(/Content-Transfer-Encoding:\s*(\S+)[^]*$/i) || [])[1] || '';
    text = /quoted-printable/i.test(encoding) ? qp(part[1]) : /base64/i.test(encoding) ? Buffer.from(part[1], 'base64').toString('utf8') : part[1];
  } else if (split !== -1) {
    text = raw.slice(split).trim();
  }
  return { to: header('To'), subject: header('Subject'), date: header('Date'), text: text.trim() };
}

const linksIn = (text) => [...new Set((text.match(/https?:\/\/[^\s)<>"]+/g) || []))];
const codesIn = (text) => [...new Set((text.match(/\b\d{6}\b/g) || []))];

function readOutbox(dir, limit = 50) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /\.(eml|txt)$/.test(f)); } catch { return []; }
  return files.sort().reverse().slice(0, limit).map((file) => {
    const raw = fs.readFileSync(path.join(dir, file), 'utf8');
    const sms = /\.sms\.txt$/.test(file) || !/\.eml$/.test(file);
    const msg = sms ? { to: (raw.match(/^To:\s*(.*)$/im) || [])[1] || '', subject: /whatsapp/.test(file) ? 'WhatsApp message' : 'Text message', date: '', text: raw.trim() } : parseEml(raw);
    const at = Number(file.split('-')[0]);
    return { file, sms, ...msg, when: Number.isFinite(at) ? new Date(at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : msg.date, links: linksIn(msg.text), codes: /code/i.test(msg.text) ? codesIn(msg.text) : [] };
  });
}

function pageHtml(list, filter) {
  const rows = list.map((m) => `<article>
<header><strong>${esc(m.subject)}</strong><span>${esc(m.when)}</span></header>
<p class="to">To: ${esc(m.to)}</p>
${m.codes.length ? `<p class="code">Code: ${m.codes.map((c) => `<b>${esc(c)}</b>`).join(' ')}</p>` : ''}
${m.links.length ? `<ul>${m.links.map((l) => `<li><a href="${esc(l)}">${esc(l)}</a></li>`).join('')}</ul>` : ''}
<details><summary>Full message</summary><pre>${esc(m.text)}</pre></details>
</article>`).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Local outbox · Hireriv</title>
<style>body{font-family:Arial,Helvetica,sans-serif;margin:0;background:#f3f7fb;color:#16243d}main{max-width:820px;margin:0 auto;padding:24px 16px}h1{font-size:22px;margin:0 0 6px}.note{color:#5b6782;margin:0 0 18px}form{margin:0 0 18px;display:flex;gap:8px}input{flex:1;padding:8px 10px;border:1px solid #c9d3e3;border-radius:8px}button{padding:8px 14px;border:0;border-radius:8px;background:#123B70;color:#fff}article{background:#fff;border-radius:12px;padding:14px 16px;margin:0 0 12px;box-shadow:0 1px 3px rgba(0,0,0,.06)}article header{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}article header span,.to{color:#5b6782;font-size:13px}.to{margin:4px 0 8px}.code b{font-size:20px;letter-spacing:2px;background:#e6fffa;padding:2px 8px;border-radius:6px}ul{margin:6px 0;padding-left:18px}li{word-break:break-all;margin:4px 0}a{color:#123B70}pre{white-space:pre-wrap;font-size:13px;background:#f7f9fc;padding:10px;border-radius:8px}</style></head>
<body><main><h1>Local outbox</h1>
<p class="note">Emails and text messages saved on this computer instead of being sent (no SMTP_HOST / SMS provider set). Open a link here to sign in, or copy the code. Only shown on this computer, never on the live site.</p>
<form method="get" action="/dev/outbox"><input name="to" value="${esc(filter)}" placeholder="Filter by email or mobile" aria-label="Filter by email or mobile"><button>Filter</button></form>
${rows || '<p>No messages yet. Sign in or register, then reload this page.</p>'}
</main></body></html>`;
}

function register(app, { outboxDir }) {
  if (!enabled()) return false;
  app.get('/dev/outbox', (req, res, next) => {
    if (!fromThisComputer(req)) return next();
    const filter = String(req.query.to || '').trim().toLowerCase().slice(0, 160);
    const list = readOutbox(outboxDir).filter((m) => !filter || m.to.toLowerCase().includes(filter));
    res.set('Cache-Control', 'no-store').set('X-Robots-Tag', 'noindex').type('html').send(pageHtml(list, filter));
  });
  return true;
}

module.exports = { register, enabled, readOutbox, parseEml };
