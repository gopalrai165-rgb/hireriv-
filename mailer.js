// Email notifications. Sends through SMTP when SMTP_HOST is set; otherwise every
// message is written to data/outbox/*.eml so it can be previewed during development.
const nodemailer = require('nodemailer');
const identity = require('./identity');
const path = require('path');
const fs = require('fs');
const { jobPath } = require('./content');

const OUTBOX_DIR = process.env.OUTBOX_DIR ? path.resolve(process.env.OUTBOX_DIR) : path.join(__dirname, 'data', 'outbox');
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

// One responsive layout for every email: a single 560px column that shrinks to
// the screen on phones, the Hireriv header, and the footer. `preheader` is the
// preview line mail apps show after the subject; `footer` says why the person
// got the email and where to change their settings.
function layout(site, heading, bodyHtml, { preheader = '', footer = '' } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting"><title>${esc(heading)}</title></head><body style="margin:0;background:#f3f7fb;font-family:Arial,Helvetica,sans-serif;color:#16243d">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${esc(preheader || heading)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:14px;overflow:hidden">
<tr><td style="background:#0b1b34;padding:18px 28px;color:#fff;font-size:20px;font-weight:bold">Hire<span style="color:#2dd4bf">riv</span></td></tr>
<tr><td style="padding:28px">
<h1 style="font-size:20px;margin:0 0 16px">${esc(heading)}</h1>
${bodyHtml}
</td></tr>
${footer ? `<tr><td style="padding:14px 28px 0;color:#6b7690;font-size:12px;line-height:1.5">${footer}</td></tr>` : ''}
<tr><td style="padding:16px 28px;background:#f3f7fb;color:#6b7690;font-size:12px">${esc(site.name)} by Raigozen · ${esc(site.phone)} · ${esc(site.email)}</td></tr>
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

const describeAlert = (sub) => (sub.name ? `your saved search “${sub.name}”` : [sub.category || 'all', 'jobs', sub.location ? `in ${sub.location}` : ''].filter(Boolean).join(' '));

const button = (href, label) =>
  `<p style="margin:20px 0 0"><a href="${esc(href)}" style="background:#123B70;color:#fff;padding:12px 22px;border-radius:999px;text-decoration:none;font-weight:bold;display:inline-block">${esc(label)}</a></p>`;

// Plain-text version of an email body, sent alongside the HTML. Text-only mail
// apps show it, and spam filters treat HTML-only mail with more suspicion.
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };
function htmlToText(html) {
  return String(html)
    .replace(/<tr>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/g, '$1: $2\n') // details rows
    .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g, (m, href, label) => {
      const text = label.replace(/<[^>]+>/g, '').trim();
      return text && text !== href ? `${text} (${href})` : href;
    })
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<\/(p|table|h1|h2|li)>/g, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (e) => ENTITIES[e])
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
function toText(site, heading, html, footer = '') {
  const foot = footer ? `\n\n${htmlToText(footer)}` : '';
  return `${heading}\n\n${htmlToText(html)}${foot}\n\n--\n${site.name} · ${site.phone} · ${site.email}\n`;
}

// Outbox files are named in the order emails were sent (not the order the
// async rendering finishes), so the newest file is always the latest email.
let sent = 0;

// Never let a mail failure break a form submission; log it and move on.
// Resolves to the message id once the email is handed over (or saved to the
// outbox), so delivery reports can be matched to it; false when there is no
// address or sending failed.
async function send(site, { to, subject, heading, html, replyTo, headers, icalEvent, preheader, footer }) {
  // Mobile-only job seekers have a placeholder address (identity.js): skip it.
  if (to) to = String(to).split(',').map((x) => x.trim()).filter((x) => x && !identity.isMobileOnly(x)).join(', ');
  if (!to) return false;
  const order = `${Date.now()}-${String(++sent).padStart(6, '0')}`;
  try {
    const info = await transport.sendMail({
      from: MAIL_FROM || `"${site.name}" <${site.email}>`,
      to,
      replyTo,
      subject: subject.replace(/[\r\n]+/g, ' '),
      html: layout(site, heading, html, { preheader, footer }),
      text: toText(site, heading, html, footer),
      headers,
      icalEvent,
    });
    if (!SMTP_HOST) {
      fs.mkdirSync(OUTBOX_DIR, { recursive: true });
      const safe = subject.replace(/[^a-z0-9]+/gi, '-').slice(0, 50).toLowerCase();
      fs.writeFileSync(path.join(OUTBOX_DIR, `${order}-${safe}.eml`), info.message);
    }
    return info.messageId || true;
  } catch (err) {
    console.error(`Email "${subject}" to ${to} failed:`, err.message);
    return false;
  }
}

function createMailer(site) {
  const teamInbox = NOTIFY_EMAIL || site.email;
  const baseUrl = (SITE_URL || `http://localhost:${process.env.PORT || 3004}`).replace(/\/$/, '');
  const first = (name) => esc(String(name).split(' ')[0]);
  // "You're getting this because…" with a link to notification settings.
  const manageFooter = (what, account = true) =>
    `You're getting this email about ${esc(what)}${account ? ` because of your notification settings. <a href="${esc(baseUrl)}/notifications/settings" style="color:#6b7690">Change what we email you</a>.` : '.'}`;

  return {
    mode,

    // The team's copy of a new application.
    applicationToTeam(a) {
      return send(site, {
        to: teamInbox,
        replyTo: a.email,
        subject: `New application for ${a.jobTitle}`,
        heading: 'New job application',
        html:
          detailsTable([
            ['Job', a.jobTitle], ['Name', a.name], ['Email', a.email || 'Not given: call or WhatsApp them'], ['Phone', a.phone], ['Skills', a.skills],
            ['Experience', a.experience], ['Location', a.location], ['Notice period', a.noticePeriod],
            ['LinkedIn', a.linkedin], ['Message', a.message],
          ]) + button(`${baseUrl}/admin?tab=applications`, 'Review in admin'),
      });
    },

    // The candidate's confirmation.
    applicationConfirmation(a) {
      return send(site, {
        to: a.email,
        subject: `We've received your application: ${a.jobTitle}`,
        heading: `Thanks for applying, ${String(a.name).split(' ')[0]}!`,
        html:
          p(`Your application for <b>${esc(a.jobTitle)}</b> is with our recruitment team.`) +
          p('A recruiter will review your profile and get back to you within 2 working days. If your experience is a strong match, we\'ll call you to talk about the role and next steps.') +
          p(`You can follow your application any time at <a href="${esc(baseUrl)}/account/login" style="color:#123B70">your account</a> (sign in with this email address, no password needed).`) +
          p(`Meanwhile, take a look at our other <a href="${esc(baseUrl)}/jobs" style="color:#123B70">open roles</a>.`),
      });
    },

    // The same person applied for the same job again; their application was updated.
    applicationUpdatedToTeam(a) {
      return send(site, {
        to: teamInbox,
        replyTo: a.email,
        subject: `Updated application for ${a.jobTitle}`,
        heading: 'A candidate updated their application',
        html:
          p(`${esc(a.name)} applied again for <b>${esc(a.jobTitle)}</b>, so their existing application now has the new resume and details. Its stage (<b>${esc(a.status || 'New')}</b>), notes and history are unchanged.`) +
          detailsTable([['Phone', a.phone], ['Skills', a.skills], ['Experience', a.experience], ['Location', a.location], ['Notice period', a.noticePeriod], ['Message', a.message]]) +
          button(`${baseUrl}/admin?tab=applications`, 'Review in admin'),
      });
    },

    applicationUpdatedConfirmation(a) {
      return send(site, {
        to: a.email,
        subject: `We've updated your application: ${a.jobTitle}`,
        heading: `Thanks, ${first(a.name)}`,
        html:
          p(`You'd already applied for <b>${esc(a.jobTitle)}</b>, so instead of a second application we've updated your existing one with your new resume and details. Your recruiter can see the changes.`) +
          p(`You can follow your application any time at <a href="${esc(baseUrl)}/account/login" style="color:#123B70">your account</a> (sign in with this email address, no password needed).`),
      });
    },

    hireRequestReceived(h) {
      return send(site, {
        to: teamInbox,
        replyTo: h.email,
        subject: `New hiring request: ${h.company} (${h.roles})`,
        heading: 'New hiring request',
        html:
          detailsTable([
            ['Company', h.company], ['Contact', h.name], ['Email', h.email], ['Phone', h.phone],
            ['Roles', h.roles], ['Headcount', h.headcount], ['Hiring type', h.hiringType],
            ['Location', h.location], ['Timeline', h.timeline], ['Budget', h.budget], ['Source', h.source], ['Message', h.message],
          ]) + button(`${baseUrl}/admin?tab=hire-requests`, 'Open in admin'),
      });
    },

    contactReceived(c) {
      return send(site, {
        to: teamInbox,
        replyTo: c.email,
        subject: `New message${c.subject ? `: ${c.subject}` : ''} from ${c.name}`,
        heading: 'New contact message',
        html: detailsTable([['Name', c.name], ['Email', c.email], ['Phone', c.phone], ['Subject', c.subject], ['Message', c.message]]),
      });
    },

    // The calendar invite rides along as a text/calendar part, so mail apps show
    // Accept/Decline and add it to the calendar.
    interviewScheduled(a, iv, ics, when) {
      const joinLink = /^https?:\/\//.test(iv.where) ? iv.where : '';
      return send(site, {
        to: a.email,
        replyTo: teamInbox,
        subject: `Interview scheduled: ${a.jobTitle} on ${when}`,
        heading: `Your interview is booked, ${String(a.name).split(' ')[0]}`,
        icalEvent: { method: 'REQUEST', filename: 'interview.ics', content: ics },
        html:
          p(`Great news! Here are the details for your interview for <b>${esc(a.jobTitle)}</b>.`) +
          detailsTable([['When', when], ['Duration', `${iv.duration} minutes`], ['Format', iv.mode], [iv.mode === 'In person' ? 'Address' : iv.mode === 'Phone' ? 'Phone' : 'Link', iv.where], ['Interviewer', iv.interviewer]]) +
          (iv.message ? p(esc(iv.message)) : '') +
          (joinLink ? button(joinLink, 'Join the interview') : '') +
          p(`Please confirm you can make it, or ask for another time, in <a href="${esc(baseUrl)}/account/interviews" style="color:#123B70">your account</a> (sign in with this email address).`) +
          p(`<span style="color:#6b7690;font-size:13px">The invite is attached, so you can add it to your calendar. You can also reply to this email or call ${esc(site.phone)}.</span>`),
      });
    },

    // The interviewer's briefing: what, when, and their private scorecard link.
    interviewerBriefing(email, a, iv, when, link) {
      return send(site, {
        to: email,
        replyTo: teamInbox,
        subject: `Interview for ${a.jobTitle}, ${when}`,
        heading: `You're interviewing ${String(a.name).split(' ')[0]}`,
        html:
          p(`Thanks for interviewing for <b>${esc(a.jobTitle)}</b>. Here are the details. Afterwards, please share your feedback using the button below. It takes about a minute.`) +
          detailsTable([['Candidate', a.name], ['When', when], ['Duration', `${iv.duration} minutes`], ['Format', iv.mode], [iv.mode === 'In person' ? 'Address' : iv.mode === 'Phone' ? 'Phone' : 'Link', iv.where]]) +
          button(link, 'Give interview feedback') +
          p(`<span style="color:#6b7690;font-size:13px">This link is just for you and works until two weeks after the interview. Questions? Reply to this email.</span>`),
      });
    },

    // Sent about a day and about an hour before (see REMINDERS in interviews.js).
    interviewReminder(a, iv, when, kind) {
      const joinLink = /^https?:\/\//.test(iv.where) ? iv.where : '';
      const soon = kind === 'hour';
      return send(site, {
        to: a.email,
        replyTo: teamInbox,
        subject: `${soon ? 'Starting soon' : 'Tomorrow'}: your interview for ${a.jobTitle}, ${when}`,
        heading: soon ? `Your interview starts in about an hour, ${first(a.name)}` : `A reminder about your interview, ${first(a.name)}`,
        html:
          p(soon ? `Your interview for <b>${esc(a.jobTitle)}</b> starts soon. All the best!` : `Just a reminder that your interview for <b>${esc(a.jobTitle)}</b> is coming up. A little preparation goes a long way: read the job description again and think of an example for each key skill.`) +
          detailsTable([['When', when], ['Duration', `${iv.duration} minutes`], ['Format', iv.mode], [iv.mode === 'In person' ? 'Address' : iv.mode === 'Phone' ? 'Phone' : 'Link', iv.where], ['Interviewer', iv.interviewer]]) +
          (joinLink ? button(joinLink, 'Join the interview') : '') +
          p(`<span style="color:#6b7690;font-size:13px">${soon && iv.mode === 'Video call' ? 'Join a couple of minutes early to check your camera and microphone. ' : ''}Can't make it? Reply to this email or call ${esc(site.phone)} as soon as you can.</span>`),
      });
    },

    interviewerReminder(email, a, iv, when, kind) {
      const joinLink = /^https?:\/\//.test(iv.where) ? iv.where : '';
      return send(site, {
        to: email,
        replyTo: teamInbox,
        subject: `${kind === 'hour' ? 'Starting soon' : 'Tomorrow'}: interview for ${a.jobTitle}, ${when}`,
        heading: kind === 'hour' ? 'Your interview starts in about an hour' : 'A reminder about your interview',
        html:
          detailsTable([['Candidate', a.name], ['Role', a.jobTitle], ['When', when], ['Duration', `${iv.duration} minutes`], ['Format', iv.mode], [iv.mode === 'In person' ? 'Address' : iv.mode === 'Phone' ? 'Phone' : 'Link', iv.where]]) +
          (joinLink ? button(joinLink, 'Join the interview') : '') +
          p(`<span style="color:#6b7690;font-size:13px">Afterwards, please use the feedback link in your briefing email. Questions? Reply to this email.</span>`),
      });
    },

    interviewFeedbackReceived(a, iv, fb, by, link) {
      return send(site, {
        to: teamInbox,
        subject: `Interview feedback for ${a.jobTitle}`,
        heading: `Feedback on ${a.name}`,
        html:
          detailsTable([['Candidate', `${a.name} (${a.jobTitle})`], ['Interviewer', by], ['Rating', `${fb.rating} / 5`], ['Recommendation', fb.recommendation], ['Strengths', fb.strengths], ['Concerns', fb.concerns]]) +
          button(link, 'Open interviews'),
      });
    },

    interviewCancelled(a, iv, ics, when) {
      return send(site, {
        to: a.email,
        replyTo: teamInbox,
        subject: `Interview cancelled: ${a.jobTitle} on ${when}`,
        heading: 'Your interview has been cancelled',
        icalEvent: { method: 'CANCEL', filename: 'interview.ics', content: ics },
        html:
          p(`Hi ${first(a.name)}, the interview for <b>${esc(a.jobTitle)}</b> on <b>${esc(when)}</b> has been cancelled, and we've removed it from your calendar.`) +
          p('Your recruiter will be in touch about next steps. If you have questions, just reply to this email.'),
      });
    },

    teamInvite(user, by, link, hours) {
      const reset = Boolean(user.passwordHash);
      return send(site, {
        to: user.email,
        replyTo: teamInbox,
        subject: reset ? `Reset your ${site.name} team password` : `${by.name} invited you to the ${site.name} team`,
        heading: reset ? 'Choose a new password' : `Welcome to the ${site.name} team`,
        html:
          p(reset
            ? `Hi ${first(user.name)}, ${esc(by.name)} sent you a link to choose a new password for the ${esc(site.name)} admin panel.`
            : `Hi ${first(user.name)}, ${esc(by.name)} added you to the ${esc(site.name)} admin panel as <b>${esc(user.role)}</b>. Choose a password to get started.`) +
          button(link, reset ? 'Choose a new password' : 'Set up my account') +
          p(`<span style="color:#6b7690;font-size:13px">This link works once and expires in ${hours} hours. After that, sign in at ${esc(baseUrl)}/admin/login with ${esc(user.email)}.</span>`),
      });
    },

    // Two-step sign-in changes, so someone notices if it wasn't them.
    teamSecurityNotice(user, subject, message) {
      return send(site, {
        to: user.email,
        replyTo: teamInbox,
        subject: `${site.name}: ${subject}`,
        heading: subject,
        html: p(`Hi ${first(user.name)}, ${esc(message)}`) + button(`${baseUrl}/admin/security`, 'Review sign-in security'),
      });
    },

    // ---------- employer self-signup ----------
    employerVerify(emp, link, hours) {
      return send(site, {
        to: emp.email,
        replyTo: teamInbox,
        subject: `Confirm your email for ${site.name}`,
        heading: `Confirm your email, ${first(emp.name)}`,
        html:
          p(`Thanks for creating an employer account for <b>${esc(emp.company)}</b>. Confirm this is your email to finish signing up.`) +
          button(link, 'Confirm my email') +
          p('Next, our team checks your company (usually within one working day). You can draft jobs straight away; they go live once your company and each job are approved.') +
          p(`<span style="color:#6b7690;font-size:13px">This link works once and expires in ${hours} hours. Didn't sign up? Ignore this email.</span>`),
      });
    },

    // Someone tried to register an email that already has an employer account.
    employerAlreadyRegistered(emp) {
      return send(site, {
        to: emp.email,
        replyTo: teamInbox,
        subject: `You already have a ${site.name} employer account`,
        heading: 'You already have an account',
        html:
          p(`Someone (probably you) tried to create a new employer account with this email, but <b>${esc(emp.company)}</b> already has one.`) +
          button(`${baseUrl}/employer/login`, 'Log in') +
          p(`Forgotten your password? <a href="${esc(baseUrl)}/employer/forgot" style="color:#123B70">Reset it here</a>. If this wasn't you, you can ignore this email.`),
      });
    },

    employerSignedUp(emp, adminLink) {
      return send(site, {
        to: teamInbox,
        replyTo: emp.email,
        subject: `New employer sign-up to approve: ${emp.company}`,
        heading: 'A new employer signed up',
        html:
          p('They have confirmed their email. Check the company before approving it: their jobs can only go live after that.') +
          detailsTable([
            ['Company', emp.company], ['Contact', emp.name], ['Email', `${emp.email}${emp.freeEmail ? ' (personal mailbox)' : ''}`], ['Phone', emp.phone], ['GSTIN', emp.gstin || 'Not given'],
          ]) + button(adminLink, 'Review in admin'),
      });
    },

    employerApproved(emp) {
      return send(site, {
        to: emp.email,
        replyTo: teamInbox,
        subject: `${emp.company} is approved on ${site.name}`,
        heading: `You're approved, ${first(emp.name)}!`,
        html:
          p(`Our team has checked <b>${esc(emp.company)}</b>. Jobs you send for review can now go live, usually within one working day.`) +
          button(`${baseUrl}/employer/jobs/new`, 'Post a job'),
      });
    },

    employerRejected(emp, reason, appealUrl) {
      return send(site, {
        to: emp.email,
        replyTo: teamInbox,
        subject: `About your ${site.name} employer account`,
        heading: 'We could not approve your account',
        html:
          p(`Thanks for signing up <b>${esc(emp.company)}</b>. We weren't able to verify the company, so the account has been closed.`) +
          (reason ? p(`<b>Reason:</b> ${esc(reason)}`) : '') +
          (appealUrl
            ? p('If you think this is a mistake, you can ask for the decision to be reviewed by someone else on our team.') + button(appealUrl, 'Appeal this decision')
            : p('If you think this is a mistake, reply to this email with your company details (GSTIN, website or registration certificate) and we will look again.')),
      });
    },

    // The verification team needs more before it can decide.
    employerInfoRequested(emp, note) {
      return send(site, {
        to: emp.email,
        replyTo: teamInbox,
        subject: `${site.name} needs a little more about ${emp.company}`,
        heading: 'We need more information to verify your company',
        html:
          p(`Thanks for signing up <b>${esc(emp.company)}</b>. Before we can verify the company, our team needs:`) +
          p(`<b>${esc(note)}</b>`) +
          p('Open your company profile, update the details if needed and send your answer. We never ask for Aadhaar or bank details to verify a company.') +
          button(`${baseUrl}/employer/company`, 'Open company profile'),
      });
    },

    // A trust & safety decision about a company's listing or account, with
    // the way to ask for a review when one is offered.
    trustDecision(to, { subject, heading, lines, appealUrl }) {
      return send(site, {
        to: to.email,
        replyTo: teamInbox,
        subject,
        heading,
        html:
          p(`Hi ${first(to.name)},`) +
          lines.map((l) => p(esc(l))).join('') +
          (appealUrl ? p('If you think this decision is wrong, you can appeal within 30 days. Someone who did not make the decision will review it.') + button(appealUrl, 'Appeal this decision') : ''),
      });
    },

    // To someone who reported a listing or account: no details of what we did
    // to the other party, only that the report was handled or what we need.
    trustReporterUpdate(email, { number, kind, text }) {
      return send(site, {
        to: email,
        replyTo: teamInbox,
        subject: kind === 'question' ? `About your report ${number}: a question from ${site.name}` : `Your report ${number} to ${site.name}`,
        heading: kind === 'question' ? 'We need a little more information' : 'Thanks for your report',
        html:
          p(kind === 'question' ? `Thanks for reporting this to us. To look into it, our team would like to know:` : 'Thanks for telling us. Our team has reviewed your report.') +
          p(`<b>${esc(text)}</b>`) +
          p(kind === 'question' ? 'Just reply to this email. Please do not send passwords, OTPs, Aadhaar or bank details.' : 'For privacy, we cannot share what action was taken about another person or company.'),
      });
    },

    employerJobSubmitted(job, emp, approved, isChange) {
      return send(site, {
        to: teamInbox,
        replyTo: emp.email,
        subject: `${isChange ? 'Changed job' : 'Job'} to review: ${job.title} (${emp.company})`,
        heading: isChange ? 'An employer changed a job' : 'An employer sent a job for review',
        html:
          p(approved ? 'Check the listing, then approve it or send it back with a reason.' : `<b>${esc(emp.company)} isn't approved yet.</b> Approve the company under Clients before this job can go live.`) +
          detailsTable([['Job', `${job.title} (${job.id})`], ['Company', emp.company], ['Location', `${job.location} (${job.mode})`], ['Type', job.type], ['Pay', job.salary || 'Not disclosed']]) +
          button(`${baseUrl}/admin?tab=jobs`, 'Review jobs'),
      });
    },

    employerJobDecision(emp, job, approved, reason, link) {
      return send(site, {
        to: emp.email,
        replyTo: teamInbox,
        subject: approved ? `Your job is live: ${job.title}` : `Changes needed: ${job.title}`,
        heading: approved ? 'Your job is live' : 'Your job needs changes',
        html: approved
          ? p(`<b>${esc(job.title)}</b> is now live on ${esc(site.name)}. We'll screen applicants and share the strongest with you in your portal.`) + button(link, 'See the job')
          : p(`We couldn't publish <b>${esc(job.title)}</b> yet.`) + p(`<b>What to change:</b> ${esc(reason)}`) + button(link, 'Edit the job'),
      });
    },

    // Someone with a login was given access to another company.
    employerMemberAdded(who, role, link, by) {
      return send(site, {
        to: who.email,
        replyTo: teamInbox,
        subject: `You now have access to ${who.company} on ${site.name}`,
        heading: `You've been added to ${who.company}`,
        html:
          p(`Hi ${first(who.name)}, ${by ? `${esc(by)} added you` : 'you were added'} to <b>${esc(who.company)}</b> as <b>${esc(role)}</b>. Log in as usual and pick the company from the menu at the top of the portal.`) +
          button(link, 'Log in'),
      });
    },

    // A company owner invited a new team member.
    employerTeamInvite(who, role, by, link, hours) {
      return send(site, {
        to: who.email,
        replyTo: teamInbox,
        subject: `${by} invited you to ${who.company} on ${site.name}`,
        heading: `Join ${who.company} on ${site.name}`,
        html:
          p(`Hi ${first(who.name)}, ${esc(by)} invited you to help with hiring at <b>${esc(who.company)}</b> as <b>${esc(role)}</b>.`) +
          button(link, 'Set your password') +
          p(`<span style="color:#6b7690;font-size:13px">This link works once and expires in ${hours} hours. Not expecting this? Ignore this email.</span>`),
      });
    },

    employerVerificationRequested(emp, user, adminLink) {
      return send(site, {
        to: teamInbox,
        replyTo: user.email,
        subject: `Company to verify: ${emp.company}`,
        heading: 'A company sent its details for verification',
        html:
          detailsTable([
            ['Company', emp.company], ['Sent by', `${user.name} (${user.email})`], ['GSTIN', emp.gstin || 'Not given'], ['CIN', emp.cin || 'Not given'], ['Udyam', emp.udyam || 'Not given'],
            ['Website', emp.website || 'Not given'], ['Address', [emp.addressLine, emp.city, emp.state, emp.pincode].filter(Boolean).join(', ') || 'Not given'],
          ]) + button(adminLink, 'Review in admin'),
      });
    },

    // A verified company changed its name or registration numbers.
    employerDetailsChanged(emp, user, fields, adminLink) {
      return send(site, {
        to: teamInbox,
        replyTo: user.email,
        subject: `Verified company changed its details: ${emp.company}`,
        heading: 'A verified company changed key details',
        html:
          p(`${esc(user.name)} changed: <b>${esc(fields.join(', '))}</b>. Check that the company is still the one you verified.`) +
          detailsTable([['Company', emp.company], ['GSTIN', emp.gstin || 'Not given'], ['CIN', emp.cin || 'Not given'], ['Udyam', emp.udyam || 'Not given']]) +
          button(adminLink, 'Review in admin'),
      });
    },

    // Someone applied to a job the employer manages themselves.
    employerNewApplication(who, a, link) {
      return send(site, {
        footer: manageFooter('new applications', true),
        to: who.email,
        replyTo: teamInbox,
        subject: `New applicant for ${a.jobTitle}`,
        heading: 'You have a new applicant',
        html:
          p(`Hi ${first(who.name)}, <b>${esc(a.name)}</b> applied for <b>${esc(a.jobTitle)}</b> at ${esc(who.company)}.`) +
          button(link, 'Review applicants'),
      });
    },

    // The candidate confirmed an interview or asked for another time.
    interviewResponse(who, a, iv, when, confirmed, note, link) {
      return send(site, {
        footer: who.inbox ? '' : manageFooter('answers to interview invitations', true),
        to: who.email,
        replyTo: teamInbox,
        subject: `${confirmed ? 'Interview confirmed' : 'New time requested'} for ${a.jobTitle}`,
        heading: confirmed ? 'Interview confirmed' : 'The candidate asked for another time',
        html:
          p(`Hi ${first(who.name)}, <b>${esc(a.name)}</b> ${confirmed ? 'confirmed' : "can't make"} the interview for <b>${esc(a.jobTitle)}</b> on <b>${esc(when)}</b>.`) +
          (note ? p(`Their note: “${esc(note)}”`) : '') +
          (confirmed ? '' : p('Cancel it and book a new time that suits them.')) +
          button(link, 'Open the applicant'),
      });
    },

    // The interview moved: the calendar entry updates in place (same UID, higher sequence).
    interviewRescheduled(a, iv, ics, when, previous) {
      const joinLink = /^https?:\/\//.test(iv.where) ? iv.where : '';
      return send(site, {
        to: a.email,
        replyTo: teamInbox,
        subject: `Interview moved: ${a.jobTitle}, now ${when}`,
        heading: 'Your interview has a new time',
        icalEvent: { method: 'REQUEST', filename: 'interview.ics', content: ics },
        html:
          p(`Hi ${first(a.name)}, your interview for <b>${esc(a.jobTitle)}</b>${previous ? ` (was ${esc(previous)})` : ''} is now at the time below. Your calendar entry has been updated.`) +
          detailsTable([['When', when], ['Duration', `${iv.duration} minutes`], ['Format', iv.mode], [iv.mode === 'In person' ? 'Address' : iv.mode === 'Phone' ? 'Phone' : 'Link', iv.where], ['Interviewer', iv.interviewer]]) +
          (joinLink ? button(joinLink, 'Join the interview') : '') +
          p(`Please confirm the new time, or ask for another one, in <a href="${esc(baseUrl)}/account/interviews" style="color:#123B70">your account</a>.`),
      });
    },

    // The offer's respond-by date is close and the candidate hasn't answered.
    offerDeadline(a, company, offer) {
      return send(site, {
        to: a.email,
        replyTo: teamInbox,
        subject: `Reminder: please reply to your offer for ${a.jobTitle}`,
        heading: 'Your offer is waiting for your answer',
        html:
          p(`Hi ${first(a.name)}, <b>${esc(company)}</b> asked for your answer to their offer for <b>${esc(a.jobTitle)}</b> by <b>${esc(offer.respondBy)}</b>.`) +
          p('Tell the company whether you accept, or ask them for more time if you need it.') +
          p(`<span style="color:#6b7690;font-size:13px">A genuine employer never asks you to pay for an offer, joining, training or a uniform. If anyone does, report it to ${esc(site.email)}.</span>`),
      });
    },

    // A short notice for employer people and the team, mirroring an in-app
    // notification: what happened, a few details, and a link to act on it.
    notice(who, { subject, heading, intro, rows = [], link, label = 'Open', why }) {
      return send(site, {
        to: who.email,
        replyTo: teamInbox,
        subject,
        heading,
        preheader: intro,
        footer: why ? manageFooter(why, who.kind !== 'team') : '',
        html: p(`Hi ${first(who.name)}, ${esc(intro)}`) + detailsTable(rows) + (link ? button(link, label) : ''),
      });
    },

    // A sales proposal to a business contact (crm.js): only once it has been
    // approved, never to anyone who unsubscribed, always with a way to stop.
    crmProposal(to, { number, title, validUntil, link, unsubscribe, owner }) {
      return send(site, {
        to: to.email,
        replyTo: owner && owner.email ? owner.email : teamInbox,
        subject: `${site.name} proposal ${number}: ${title}`,
        heading: 'Your proposal from Hireriv',
        preheader: `Valid until ${validUntil}`,
        headers: { 'List-Unsubscribe': `<${unsubscribe}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
        html:
          p(`Hi ${first(to.name)}, thank you for your time. Here is our proposal <b>${esc(number)}</b> for ${esc(title)}. It is valid until ${esc(validUntil)}.`) +
          p('You can read it, accept it or tell us it is not right for you on the page below.') +
          button(link, 'Read the proposal') +
          (owner ? p(`<span style="color:#6b7690;font-size:13px">Questions? Reply to this email to reach ${esc(owner.name)}.</span>`) : ''),
        footer: `You're getting this because you discussed hiring with ${esc(site.name)}. <a href="${esc(unsubscribe)}" style="color:#6b7690">Don't email me about this again</a>`,
      });
    },

    // Confirms a privacy request: the candidate's data was deleted.
    accountDeleted(email) {
      return send(site, {
        to: email,
        subject: `Your ${site.name} data has been deleted`,
        heading: 'Your data has been deleted',
        html:
          p('As you asked, we deleted your job-seeker account and everything in it: your profile, applications, resumes, job alerts, saved jobs, notifications and account activity.') +
          p(`Invoices and placement records that Indian tax law requires us to keep are not affected. Questions? Reply to this email or write to ${esc(site.email)}.`) +
          p(`<span style="color:#6b7690;font-size:13px">Didn't ask for this? Reply to this email straight away.</span>`),
      });
    },

    // An approved offer: the candidate hears about it and what happens next.
    offerMade(a, company, offer) {
      return send(site, {
        to: a.email,
        replyTo: teamInbox,
        subject: `Job offer: ${a.jobTitle} at ${company}`,
        heading: `Congratulations, ${first(a.name)}!`,
        html:
          p(`<b>${esc(company)}</b> would like to offer you the role of <b>${esc(a.jobTitle)}</b>.`) +
          detailsTable([['Joining date', offer.joiningDate || 'To be agreed'], ['Respond by', offer.respondBy || '']]) +
          p('The company will share the offer letter and talk you through it. Tell them whether you accept, and ask them anything you need to know first.') +
          p(`<span style="color:#6b7690;font-size:13px">A genuine employer never asks you to pay for an offer, joining, training or a uniform. If anyone does, report it to ${esc(site.email)}.</span>`),
      });
    },

    employerInvite(emp, link, hours) {
      return send(site, {
        to: emp.email,
        replyTo: teamInbox,
        subject: `Your ${site.name} client portal is ready`,
        heading: `Welcome to ${site.name}, ${String(emp.name).split(' ')[0]}`,
        html:
          p(`We've set up a client portal for <b>${esc(emp.company)}</b>. Use it to send new hiring requirements and follow the progress of your open roles.`) +
          button(link, 'Set your password') +
          p(`<span style="color:#6b7690;font-size:13px">This link works once and expires in ${hours} hours. If it expires, ask your account manager for a new one.</span>`),
      });
    },

    candidateShared(emp, a, link) {
      return send(site, {
        to: emp.email,
        replyTo: teamInbox,
        subject: `New candidate for ${a.jobTitle}: ${a.name}`,
        heading: 'A new candidate is on your shortlist',
        html:
          p(`Hi ${first(emp.name)}, we've shortlisted <b>${esc(a.name)}</b> for <b>${esc(a.jobTitle)}</b>.`) +
          detailsTable([['Experience', a.experience], ['Location', a.location], ['Notice period', a.noticePeriod], ['Skills', a.skills]]) +
          (a.shared && a.shared.summary ? p(`<b>Recruiter's note:</b> ${esc(a.shared.summary)}`) : '') +
          button(link, 'Review in your portal') +
          p('<span style="color:#6b7690;font-size:13px">Let us know if you\'re interested and we\'ll arrange the next step.</span>'),
      });
    },

    clientFeedback(emp, a, fb, link) {
      return send(site, {
        to: teamInbox,
        replyTo: emp.email,
        subject: `${emp.company}: ${fb.decision} – ${a.name} (${a.jobTitle})`,
        heading: `Client feedback: ${fb.decision}`,
        html:
          detailsTable([['Client', `${emp.company} (${fb.by})`], ['Candidate', a.name], ['Job', a.jobTitle], ['Decision', fb.decision], ['Comment', fb.comment]]) +
          button(link, 'Open applications'),
      });
    },

    invoiceIssued(emp, inv, link) {
      const money = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(inv.total);
      const due = new Date(`${inv.dueDate}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
      return send(site, {
        to: emp.email,
        replyTo: teamInbox,
        subject: `Invoice ${inv.number} from ${site.name} – ${money}`,
        heading: `Invoice ${inv.number}`,
        html:
          p(`Hi ${first(emp.name)}, thank you for hiring with ${esc(site.name)}. Your invoice for the placement below is ready in your client portal, where you can view, print or save it as a PDF.`) +
          detailsTable([['Invoice', inv.number], ['For', inv.item], ['Amount (incl. GST)', money], ['Due by', due]]) +
          button(link, 'View invoice') +
          p(`<span style="color:#6b7690;font-size:13px">Questions about this invoice? Just reply to this email.</span>`),
      });
    },

    // To the client's portal contact, or the team when the client isn't on the portal.
    timesheetSubmitted(client, pl, ts, total, week, link) {
      return send(site, {
        to: client ? client.email : teamInbox,
        replyTo: client ? teamInbox : undefined,
        subject: `Timesheet to approve: ${pl.candidateName}, ${week}`,
        heading: 'A timesheet is waiting for approval',
        html:
          p(client
            ? `Hi ${first(client.name)}, ${esc(pl.candidateName)} has submitted their timesheet. Please approve it, or send it back with a note if something needs changing.`
            : `${esc(pl.candidateName)} submitted a timesheet for ${esc(pl.company)}, who isn't on the client portal. An Admin can approve it on the "Bill a month" page.`) +
          detailsTable([['Contractor', `${pl.candidateName} (${pl.jobTitle})`], ['Week', week], ['Days worked', String(total)], ['Note', ts.note]]) +
          button(link, client ? 'Review timesheet' : 'Open in admin'),
      });
    },

    timesheetReviewed(pl, ts, total, week, link) {
      const ok = ts.status === 'Approved';
      return send(site, {
        to: pl.candidateEmail,
        replyTo: teamInbox,
        subject: `Timesheet ${ok ? 'approved' : 'needs changes'}: ${week}`,
        heading: ok ? 'Your timesheet is approved' : 'Your timesheet needs a change',
        html:
          p(ok
            ? `Your timesheet for <b>${esc(week)}</b> (${total} day${total === 1 ? '' : 's'}) at ${esc(pl.company)} has been approved.`
            : `Your timesheet for <b>${esc(week)}</b> at ${esc(pl.company)} was sent back. Please update it and submit again.`) +
          (ts.reviewNote ? detailsTable([['Note', ts.reviewNote]]) : '') +
          button(link, ok ? 'View timesheets' : 'Update timesheet'),
      });
    },

    invoiceReminder(emp, inv, balance, daysOverdue, link) {
      const money = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(balance);
      const due = new Date(`${inv.dueDate}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
      return send(site, {
        to: emp.email,
        replyTo: teamInbox,
        subject: `Payment reminder: invoice ${inv.number} – ${money} ${daysOverdue ? 'overdue' : 'due'}`,
        heading: 'Friendly payment reminder',
        html:
          p(`Hi ${first(emp.name)}, this is a reminder that invoice <b>${esc(inv.number)}</b> ${daysOverdue ? `was due on ${esc(due)} (${daysOverdue} day${daysOverdue === 1 ? '' : 's'} ago)` : `is due on ${esc(due)}`}.`) +
          detailsTable([['Invoice', inv.number], ['For', inv.item], ['Balance due', money], ['Due date', due]]) +
          button(link, 'View invoice') +
          p(`<span style="color:#6b7690;font-size:13px">If you've already paid, thank you, and please ignore this email. Reply with the payment reference and any TDS deducted so we can update our records.</span>`),
      });
    },

    creditNoteIssued(emp, inv, cn, link) {
      const money = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(cn.total);
      return send(site, {
        to: emp.email,
        replyTo: teamInbox,
        subject: `Credit note ${cn.number} from ${site.name} – ${money}`,
        heading: `Credit note ${cn.number}`,
        html:
          p(`Hi ${first(emp.name)}, we've issued a credit note against invoice <b>${esc(inv.number)}</b>. It reduces the amount due on that invoice, or will be refunded if you've already paid.`) +
          detailsTable([['Credit note', cn.number], ['Against invoice', inv.number], ['Reason', cn.note ? `${cn.reason}: ${cn.note}` : cn.reason], ['Amount (incl. GST)', money]]) +
          button(link, 'View credit note') +
          p(`<span style="color:#6b7690;font-size:13px">Questions? Just reply to this email.</span>`),
      });
    },

    employerReset(emp, link, hours) {
      return send(site, {
        to: emp.email,
        replyTo: teamInbox,
        subject: `Reset your ${site.name} client portal password`,
        heading: 'Choose a new password',
        html:
          p(`Someone asked to reset the password for the <b>${esc(emp.company)}</b> client portal. If that was you, use the button below.`) +
          button(link, 'Choose a new password') +
          p(`<span style="color:#6b7690;font-size:13px">This link works once and expires in ${hours} hours. Didn't ask for this? Ignore this email and your password stays the same.</span>`),
      });
    },

    // A job seeker created an account (stored as a general application). The
    // team hears about new sign-ups only; the candidate always gets a link.
    candidateRegistered(a, link, hours, isNew) {
      if (isNew) {
        send(site, {
          to: teamInbox,
          replyTo: a.email,
          subject: 'New candidate account',
          heading: 'A job seeker created an account',
          html:
            detailsTable([
              ['Name', a.name], ['Email', a.email], ['Phone', a.phone], ['Skills', a.skills], ['Experience', a.experience],
              ['Location', a.location], ['Notice period', a.noticePeriod], ['LinkedIn', a.linkedin], ['Resume', a.resume ? 'Uploaded' : 'Not yet'],
            ]) + button(`${baseUrl}/admin?tab=applications`, 'See in admin'),
        });
      }
      return send(site, {
        to: a.email,
        subject: `Welcome to ${site.name}: open your account`,
        heading: `Welcome, ${first(a.name)}!`,
        html:
          p(isNew ? 'Your job-seeker account is ready. Use the button below to sign in and see jobs that match your profile.' : 'You already have an account with this email, so we\'ve updated your profile with the details you just gave. Use the button below to sign in.') +
          button(link, 'Open my account') +
          p('In your account you can apply to jobs in one click with your saved profile and resume, set up job alerts and follow every application.') +
          p(`<span style="color:#6b7690;font-size:13px">This link works once and expires in ${hours} hours. Later, sign in any time at ${esc(baseUrl)}/account/login with this email. Didn't create an account? Ignore this email.</span>`),
      });
    },

    // Someone flagged a job listing as suspicious or misleading.
    jobReported(r) {
      return send(site, {
        to: teamInbox,
        ...(r.email ? { replyTo: r.email } : {}),
        subject: `Job reported: ${r.jobTitle} (${r.reason})`,
        heading: 'A visitor reported a job listing',
        html:
          p('Please check this listing within one working day. If it breaks the rules, close or edit it.') +
          detailsTable([['Job', `${r.jobTitle} · ${r.company} (${r.jobId})`], ['Reason', r.reason], ['Details', r.details], ['Their email', r.email || 'Not given']]) +
          button(`${baseUrl}/admin/jobs/${encodeURIComponent(r.jobId)}/edit`, 'Open the job') +
          button(`${baseUrl}/admin?tab=job-reports`, 'All reported jobs'),
      });
    },

    candidateSignIn(email, link, minutes) {
      return send(site, {
        to: email,
        subject: `Your ${site.name} sign-in link`,
        heading: 'Sign in to your account',
        html:
          p('Use the button below to see your applications, upcoming interviews, jobs that match your profile and your job alerts.') +
          button(link, 'Sign in') +
          p(`<span style="color:#6b7690;font-size:13px">This link works once and expires in ${minutes} minutes. Didn't ask for it? You can ignore this email.</span>`),
      });
    },

    // Adding an email to an account made with only a mobile number.
    candidateEmailAdd(email, link, hours) {
      return send(site, {
        to: email,
        subject: `Add this email to your ${site.name} account`,
        heading: 'Confirm your email address',
        html:
          p(`Someone signed in to a ${site.name} job-seeker account with a mobile number asked to add this email address to it. Once it is added, you can sign in with this email too, and job alerts and updates can come here.`) +
          button(link, 'Add this email') +
          p(`<span style="color:#6b7690;font-size:13px">This link works once and expires in ${hours} hours. Didn't ask for it? Ignore this email and nothing changes.</span>`),
      });
    },
    // The same request for an address that already has an account: nothing is added.
    candidateEmailTaken(email, signInLink) {
      return send(site, {
        to: email,
        subject: `Your ${site.name} account`,
        heading: 'This email already has an account',
        html:
          p(`Someone signed in to a ${site.name} job-seeker account with a mobile number asked to add this email address to it. This email already has its own account, so nothing was added.`) +
          p('If it was you, sign in with this email instead. Your applications under the mobile number stay on that account.') +
          button(signInLink, 'Sign in') +
          p('<span style="color:#6b7690;font-size:13px">Didn\'t ask for it? You can ignore this email.</span>'),
      });
    },

    candidatePasswordReset(email, link, minutes) {
      return send(site, {
        to: email,
        subject: `Reset your ${site.name} password`,
        heading: 'Choose a new password',
        html:
          p('Someone (hopefully you) asked to reset the password for your job-seeker account. Use the button below to choose a new one.') +
          button(link, 'Choose a new password') +
          p(`<span style="color:#6b7690;font-size:13px">This link works once and expires in ${minutes} minutes. Didn't ask for it? Ignore this email and your password stays the same.</span>`),
      });
    },

    // A security notice whenever the password is set, changed or reset.
    candidatePasswordChanged(email, what) {
      return send(site, {
        to: email,
        subject: `Your ${site.name} password was ${what}`,
        heading: `Password ${what}`,
        html:
          p(`The password for your job-seeker account was ${what} just now, and you were signed out on your other devices.`) +
          p(`Wasn't you? Use "Forgot password" on the sign-in page to choose a new one, and reply to this email so we can help.`),
      });
    },

    applicationWithdrawn(a) {
      return send(site, {
        to: teamInbox,
        replyTo: a.email,
        subject: `Application withdrawn for ${a.jobTitle}`,
        heading: 'A candidate withdrew their application',
        html: detailsTable([['Candidate', a.name], ['Email', a.email], ['Job', a.jobTitle], ['Stage at withdrawal', a.status || 'New']]) +
          p('Any scheduled interviews for this application were cancelled.'),
      });
    },

    jobAlertConfirm(sub) {
      const what = describeAlert(sub);
      return send(site, {
        to: sub.email,
        subject: 'Confirm your Hireriv job alert',
        heading: 'One click to switch on your job alert',
        html:
          p(`You asked us to email you about <b>${esc(what)}</b>. Please confirm it's really you.`) +
          button(`${baseUrl}/job-alerts/confirm/${sub.token}`, 'Confirm job alert') +
          p(`<span style="color:#6b7690;font-size:13px">Didn't ask for this? Just ignore this email and you won't hear from us.</span>`),
      });
    },

    jobAlert(sub, job) {
      const unsubscribe = `${baseUrl}/job-alerts/unsubscribe/${sub.token}`;
      return send(site, {
        to: sub.email,
        subject: `New job: ${job.title} in ${job.location}`,
        heading: 'A new job matches your alert',
        headers: { 'List-Unsubscribe': `<${unsubscribe}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
        html:
          `<h2 style="font-size:18px;margin:0 0 4px">${esc(job.title)}</h2>` +
          p(`<span style="color:#6b7690">${esc(job.company)}</span>`) +
          detailsTable([['Location', `${job.location} (${job.mode})`], ['Type', job.type], ['Experience', job.experience], ['Salary', job.salary], ['Skills', job.skills.join(', ')]]) +
          p(esc(job.description)) +
          button(`${baseUrl}${jobPath(job)}?utm_source=job-alert`, 'View job & apply') +
          p(`<span style="color:#6b7690;font-size:12px">You're getting this because you set up an alert for ${esc(describeAlert(sub))}. <a href="${esc(unsubscribe)}" style="color:#6b7690">Unsubscribe</a> · <a href="${esc(baseUrl)}/notifications/settings" style="color:#6b7690">Notification settings</a></span>`),
      });
    },

    // The daily or weekly email of a saved search: the new jobs since the last one.
    jobDigest(sub, jobs, frequency) {
      const unsubscribe = `${baseUrl}/job-alerts/unsubscribe/${sub.token}`;
      const n = jobs.length;
      const rows = jobs.map((job) =>
        `<tr><td style="padding:12px 0;border-top:1px solid #e3e8f2"><a href="${esc(`${baseUrl}${jobPath(job)}?utm_source=job-alert`)}" style="color:#123B70;font-weight:bold;text-decoration:none">${esc(job.title)}</a><br>` +
        `<span style="color:#6b7690;font-size:13px">${esc([job.company, `${job.location} (${job.mode})`, job.type, job.salary].filter(Boolean).join(' · '))}</span></td></tr>`).join('');
      return send(site, {
        to: sub.email,
        subject: `${n} new ${n === 1 ? 'job' : 'jobs'} for ${sub.name || 'your saved search'}`,
        heading: `New jobs for your saved search`,
        preheader: jobs.slice(0, 3).map((j) => j.title).join(', '),
        headers: { 'List-Unsubscribe': `<${unsubscribe}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
        html:
          p(`${n === 1 ? 'This job was' : `These ${n} jobs were`} posted since your last ${frequency === 'weekly' ? 'weekly' : 'daily'} email and ${n === 1 ? 'matches' : 'match'} <b>${esc(sub.name || 'your saved search')}</b>.`) +
          `<table role="presentation" style="width:100%;border-collapse:collapse">${rows}</table>` +
          button(`${baseUrl}/account/saved-searches`, 'Manage saved searches'),
        footer: `You're getting this because you saved this search and chose a ${frequency === 'weekly' ? 'weekly' : 'daily'} email. <a href="${esc(unsubscribe)}" style="color:#6b7690">Stop these emails</a> · <a href="${esc(baseUrl)}/notifications/settings" style="color:#6b7690">Notification settings</a>`,
      });
    },

    // A verified employer found the candidate's profile (they agreed to be
    // found) and invites them to apply. The employer has no contact details
    // until the candidate applies.
    jobInvite(c, job) {
      return send(site, {
        to: c.email,
        subject: `Invitation to apply: ${job.title} at ${job.company}`,
        heading: `${job.company} would like you to apply`,
        preheader: `${job.title} · ${job.location}`,
        html:
          p(`Hi ${first(c.profile.name || 'there')}, <b>${esc(job.company)}</b> saw your profile on ${esc(site.name)} and invites you to apply for this job.`) +
          detailsTable([['Job', job.title], ['Location', `${job.location} (${job.mode})`], ['Type', job.type], ['Salary', job.salary]]) +
          p(`They haven't seen your name, phone number, email or resume. They will only if you decide to apply. You don't have to reply.`) +
          button(`${baseUrl}${jobPath(job)}?utm_source=invite`, 'View the job'),
        footer: `You're getting this because you let verified employers find your profile. <a href="${esc(baseUrl)}/account/settings" style="color:#6b7690">Change this in your settings</a> · <a href="${esc(baseUrl)}/notifications/settings" style="color:#6b7690">Notification settings</a>`,
      });
    },

    // Only the stages a candidate should hear about; New/Screening stay internal.
    statusChanged(a) {
      const job = esc(a.jobTitle);
      const copy = {
        Interview: [`Interview next: ${a.jobTitle}`, 'Good news! You\'re moving to interviews', p(`Hi ${first(a.name)}, your profile for <b>${job}</b> has been shortlisted for interviews. Your recruiter will contact you shortly to schedule a time and help you prepare.`)],
        Offered: [`Offer update: ${a.jobTitle}`, 'An offer is on its way', p(`Hi ${first(a.name)}, congratulations! The hiring team would like to make you an offer for <b>${job}</b>. Your recruiter will walk you through the details and next steps.`)],
        Hired: [`Welcome aboard: ${a.jobTitle}`, 'Congratulations on your new role!', p(`Hi ${first(a.name)}, it's official: you've been hired for <b>${job}</b>. Thank you for trusting ${esc(site.name)} with your career move. We wish you every success.`)],
        Rejected: [`Update on your application: ${a.jobTitle}`, 'An update on your application', p(`Hi ${first(a.name)}, thank you for your interest in <b>${job}</b>. After careful review, the hiring team has decided to go ahead with other candidates for this role.`) + p(`We'll keep your profile on file and get in touch when a better match comes up. You can also browse our <a href="${esc(baseUrl)}/jobs" style="color:#123B70">latest openings</a>.`)],
      }[a.status];
      if (!copy) return false;
      return send(site, { to: a.email, subject: copy[0], heading: copy[1], html: copy[2], footer: manageFooter('updates on your applications') });
    },

    // A recruiter's own message (from a template or typed): plain text, blank
    // lines start new paragraphs. Replies go to the recruiter who sent it.
    candidateMessage(a, subject, text, replyTo) {
      const html = String(text)
        .split(/\r?\n\s*\r?\n/)
        .map((para) => para.trim())
        .filter(Boolean)
        .map((para) => p(esc(para).replace(/\r?\n/g, '<br>')))
        .join('');
      return send(site, { to: a.email, replyTo: replyTo || teamInbox, subject, heading: subject, html });
    },
  };
}

module.exports = { createMailer, toText };
