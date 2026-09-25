// Email notifications. Sends through SMTP when SMTP_HOST is set; otherwise every
// message is written to data/outbox/*.eml so it can be previewed during development.
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');

const OUTBOX_DIR = path.join(__dirname, 'data', 'outbox');
const { SMTP_HOST, SMTP_PORT = '587', SMTP_USER, SMTP_PASS, MAIL_FROM, NOTIFY_EMAIL, SITE_URL } = process.env;

const transport = SMTP_HOST
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT),
      secure: Number(SMTP_PORT) === 465,
      auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
    })
  : nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows' });

const mode = SMTP_HOST ? `SMTP (${SMTP_HOST})` : 'outbox (data/outbox, set SMTP_HOST to send for real)';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function layout(site, heading, bodyHtml) {
  return `<!doctype html><html><body style="margin:0;background:#f3f7fb;font-family:Arial,Helvetica,sans-serif;color:#16243d">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:14px;overflow:hidden">
<tr><td style="background:#0b1b34;padding:18px 28px;color:#fff;font-size:20px;font-weight:bold">Hire<span style="color:#2dd4bf">riv</span></td></tr>
<tr><td style="padding:28px">
<h1 style="font-size:20px;margin:0 0 16px">${esc(heading)}</h1>
${bodyHtml}
</td></tr>
<tr><td style="padding:16px 28px;background:#f3f7fb;color:#6b7690;font-size:12px">${esc(site.name)} · ${esc(site.phone)} · ${esc(site.email)}</td></tr>
</table></td></tr></table></body></html>`;
}

const p = (text) => `<p style="font-size:15px;line-height:1.6;margin:0 0 14px">${text}</p>`;

function detailsTable(rows) {
  const tr = rows
    .filter(([, v]) => v)
    .map(([k, v]) => `<tr><td style="padding:6px 12px 6px 0;color:#6b7690;white-space:nowrap;vertical-align:top">${esc(k)}</td><td style="padding:6px 0">${esc(v)}</td></tr>`)
    .join('');
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;margin:0 0 16px">${tr}</table>`;
}

const button = (href, label) =>
  `<p style="margin:20px 0 0"><a href="${esc(href)}" style="background:#0e8a8f;color:#fff;padding:12px 22px;border-radius:999px;text-decoration:none;font-weight:bold;display:inline-block">${esc(label)}</a></p>`;

// Never let a mail failure break a form submission; log it and move on.
async function send(site, { to, subject, heading, html, replyTo }) {
  if (!to) return;
  try {
    const info = await transport.sendMail({
      from: MAIL_FROM || `"${site.name}" <${site.email}>`,
      to,
      replyTo,
      subject: subject.replace(/[\r\n]+/g, ' '),
      html: layout(site, heading, html),
    });
    if (!SMTP_HOST) {
      fs.mkdirSync(OUTBOX_DIR, { recursive: true });
      const safe = subject.replace(/[^a-z0-9]+/gi, '-').slice(0, 50).toLowerCase();
      fs.writeFileSync(path.join(OUTBOX_DIR, `${Date.now()}-${safe}.eml`), info.message);
    }
  } catch (err) {
    console.error(`Email "${subject}" to ${to} failed:`, err.message);
  }
}

function createMailer(site) {
  const teamInbox = NOTIFY_EMAIL || site.email;
  const baseUrl = (SITE_URL || `http://localhost:${process.env.PORT || 3004}`).replace(/\/$/, '');
  const first = (name) => esc(String(name).split(' ')[0]);

  return {
    mode,

    applicationReceived(a) {
      send(site, {
        to: teamInbox,
        replyTo: a.email,
        subject: `New application: ${a.name} for ${a.jobTitle}`,
        heading: 'New job application',
        html:
          detailsTable([
            ['Job', a.jobTitle], ['Name', a.name], ['Email', a.email], ['Phone', a.phone],
            ['Experience', a.experience], ['Location', a.location], ['Notice period', a.noticePeriod],
            ['LinkedIn', a.linkedin], ['Message', a.message],
          ]) + button(`${baseUrl}/admin?tab=applications`, 'Review in admin'),
      });
      send(site, {
        to: a.email,
        subject: `We've received your application: ${a.jobTitle}`,
        heading: `Thanks for applying, ${String(a.name).split(' ')[0]}!`,
        html:
          p(`Your application for <b>${esc(a.jobTitle)}</b> is with our recruitment team.`) +
          p('A recruiter will review your profile and get back to you within 2 working days. If your experience is a strong match, we\'ll call you to talk about the role and next steps.') +
          p(`Meanwhile, take a look at our other <a href="${esc(baseUrl)}/jobs" style="color:#0e8a8f">open roles</a>.`),
      });
    },

    hireRequestReceived(h) {
      send(site, {
        to: teamInbox,
        replyTo: h.email,
        subject: `New hiring request: ${h.company} (${h.roles})`,
        heading: 'New hiring request',
        html:
          detailsTable([
            ['Company', h.company], ['Contact', h.name], ['Email', h.email], ['Phone', h.phone],
            ['Roles', h.roles], ['Headcount', h.headcount], ['Hiring type', h.hiringType],
            ['Location', h.location], ['Timeline', h.timeline], ['Message', h.message],
          ]) + button(`${baseUrl}/admin?tab=hire-requests`, 'Open in admin'),
      });
    },

    contactReceived(c) {
      send(site, {
        to: teamInbox,
        replyTo: c.email,
        subject: `New message${c.subject ? `: ${c.subject}` : ''} from ${c.name}`,
        heading: 'New contact message',
        html: detailsTable([['Name', c.name], ['Email', c.email], ['Phone', c.phone], ['Subject', c.subject], ['Message', c.message]]),
      });
    },

    // Only the stages a candidate should hear about; New/Screening stay internal.
    statusChanged(a) {
      const job = esc(a.jobTitle);
      const copy = {
        Interview: [`Interview next: ${a.jobTitle}`, 'Good news! You\'re moving to interviews', p(`Hi ${first(a.name)}, your profile for <b>${job}</b> has been shortlisted for interviews. Your recruiter will contact you shortly to schedule a time and help you prepare.`)],
        Offered: [`Offer update: ${a.jobTitle}`, 'An offer is on its way', p(`Hi ${first(a.name)}, congratulations! The hiring team would like to make you an offer for <b>${job}</b>. Your recruiter will walk you through the details and next steps.`)],
        Hired: [`Welcome aboard: ${a.jobTitle}`, 'Congratulations on your new role!', p(`Hi ${first(a.name)}, it's official: you've been hired for <b>${job}</b>. Thank you for trusting ${esc(site.name)} with your career move. We wish you every success.`)],
        Rejected: [`Update on your application: ${a.jobTitle}`, 'An update on your application', p(`Hi ${first(a.name)}, thank you for your interest in <b>${job}</b>. After careful review, the hiring team has decided to go ahead with other candidates for this role.`) + p(`We'll keep your profile on file and get in touch when a better match comes up. You can also browse our <a href="${esc(baseUrl)}/jobs" style="color:#0e8a8f">latest openings</a>.`)],
      }[a.status];
      if (!copy) return false;
      send(site, { to: a.email, subject: copy[0], heading: copy[1], html: copy[2] });
      return true;
    },
  };
}

module.exports = { createMailer };
