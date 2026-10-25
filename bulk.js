// Email templates and bulk actions on applications: move many candidates to a
// stage, assign an owner, email them from a template, or (Admins) delete them.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { moveStage } = require('./history');

const MAX_BULK = 200;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// {placeholders} a template can use, with what they become.
const PLACEHOLDERS = {
  first_name: 'Candidate first name',
  name: 'Candidate full name',
  job: 'Job title they applied for',
  company: 'Company on the job',
  location: 'Job location',
  recruiter: 'Your name',
  site_name: 'Your company name',
  site_phone: 'Your phone number',
};

const DEFAULT_TEMPLATES = [
  {
    name: 'Shortlisted: next steps',
    subject: 'Next steps for {job}',
    body: 'Hi {first_name},\n\nGood news: your profile for {job} has been shortlisted. I would like to set up a short call to understand your current role, notice period and expectations.\n\nPlease reply with two or three times that work for you this week.\n\nRegards,\n{recruiter}\n{site_name} · {site_phone}',
  },
  {
    name: 'Documents needed',
    subject: 'Documents for your {job} application',
    body: 'Hi {first_name},\n\nTo move your application for {job} forward, please reply with:\n- Your latest resume\n- Last 3 months\' payslips\n- A photo ID\n\nThanks,\n{recruiter}\n{site_name}',
  },
  {
    name: 'Not selected (kind)',
    subject: 'An update on your application for {job}',
    body: 'Hi {first_name},\n\nThank you for your time and interest in the {job} role. After careful review, the hiring team has decided to go ahead with other candidates this time.\n\nWe will keep your profile on file and reach out when a better match comes up.\n\nBest wishes,\n{recruiter}\n{site_name}',
  },
  {
    name: 'Still interested?',
    subject: 'Are you still looking? ({job})',
    body: 'Hi {first_name},\n\nYou applied for {job} with us a while ago. Are you still open to new roles? If so, reply with your current notice period and expected salary, and I will share matching openings.\n\nRegards,\n{recruiter}\n{site_name}',
  },
];

function register(app, deps) {
  const { db, site, mailer, adminAuth, requireAdmin, sameOrigin, adminUrl, readSubmissions, writeSubmissions, getJobs, team, appStatuses, uploadsDir, events } = deps;

  // ---------- templates ----------
  const read = () => {
    if (!db.metaGet('templates-seeded')) {
      db.metaSet('templates-seeded', new Date().toISOString());
      if (!db.count('email-templates')) {
        db.replaceAll('email-templates', DEFAULT_TEMPLATES.map((t) => ({ id: crypto.randomUUID(), ...t, createdAt: new Date().toISOString() })));
      }
    }
    return db.all('email-templates');
  };
  const write = (list) => db.replaceAll('email-templates', list);

  function parseTemplate(body) {
    const t = {
      name: String(body.name || '').trim().slice(0, 80),
      subject: String(body.subject || '').trim().slice(0, 200),
      body: String(body.body || '').trim().slice(0, 5000),
    };
    const errors = [];
    if (!t.name) errors.push('template name is required');
    if (!t.subject) errors.push('subject is required');
    if (!t.body) errors.push('message is required');
    return { t, errors };
  }

  app.post('/admin/templates', adminAuth, sameOrigin, (req, res) => {
    const { t, errors } = parseTemplate(req.body);
    if (errors.length) return res.redirect(adminUrl('templates', `Could not save: ${errors.join(', ')}`));
    const list = read();
    list.push({ id: crypto.randomUUID(), ...t, createdAt: new Date().toISOString(), createdBy: req.admin.name });
    write(list);
    res.redirect(adminUrl('templates', `Saved template "${t.name}"`));
  });

  app.post('/admin/templates/:id', adminAuth, sameOrigin, (req, res, next) => {
    const list = read();
    const existing = list.find((x) => x.id === req.params.id);
    if (!existing) return next();
    const { t, errors } = parseTemplate(req.body);
    if (errors.length) return res.redirect(adminUrl('templates', `Could not save: ${errors.join(', ')}`));
    Object.assign(existing, t, { updatedAt: new Date().toISOString(), updatedBy: req.admin.name });
    write(list);
    res.redirect(adminUrl('templates', `Saved template "${t.name}"`));
  });

  app.post('/admin/templates/:id/delete', adminAuth, requireAdmin, sameOrigin, (req, res, next) => {
    const list = read();
    const t = list.find((x) => x.id === req.params.id);
    if (!t) return next();
    write(list.filter((x) => x !== t));
    res.redirect(adminUrl('templates', `Deleted template "${t.name}"`));
  });

  // ---------- filling in placeholders ----------
  function fill(text, a, sender) {
    const job = getJobs().find((j) => j.id === a.jobId) || {};
    const values = {
      first_name: String(a.name || '').split(' ')[0],
      name: a.name || '',
      job: a.jobTitle || job.title || '',
      company: job.company || '',
      location: job.location || '',
      recruiter: sender.name,
      site_name: site.name,
      site_phone: site.phone,
    };
    return String(text).replace(/\{([a-z_]+)\}/g, (m, key) => (key in values ? values[key] : m));
  }
  const unknownPlaceholders = (text) => [...new Set([...String(text).matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]).filter((k) => !(k in PLACEHOLDERS)))];

  // ---------- bulk actions ----------
  // Only return to the Applications tab (keeping its filters), never elsewhere.
  const backTo = (req, msg) => {
    const back = /^\/admin\?tab=applications(&[\w=%.-]*)*$/.test(String(req.body.back || '')) ? String(req.body.back) : '/admin?tab=applications';
    return `${back.replace(/&msg=[^&]*/, '')}&msg=${encodeURIComponent(msg)}`;
  };
  const selectedIds = (body) => [...new Set([].concat(body.ids || []).map(String))].slice(0, MAX_BULK);

  app.post('/admin/applications/bulk', adminAuth, sameOrigin, (req, res) => {
    const ids = selectedIds(req.body);
    const action = String(req.body.action || '');
    if (!ids.length) return res.redirect(backTo(req, 'Tick at least one application first'));
    const list = readSubmissions('applications');
    const chosen = list.filter((a) => ids.includes(a.id));
    if (!chosen.length) return res.redirect(backTo(req, 'Those applications no longer exist'));
    const now = new Date().toISOString();
    const [kind, value] = [action.split(':')[0], action.slice(action.indexOf(':') + 1)];

    if (kind === 'stage') {
      if (!appStatuses.includes(value)) return res.redirect(backTo(req, 'Choose a stage'));
      let moved = 0;
      let emailed = 0;
      db.transaction(() => {
        for (const a of chosen) {
          if (!moveStage(a, value, req.admin.name, now, { actor: 'team', userId: req.admin.id })) continue;
          moved++;
          if (req.body.notify === '1' && events.statusEmail(a)) {
            a.lastEmailedStatus = value;
            emailed++;
          }
        }
        writeSubmissions('applications', list);
      });
      const skipped = chosen.length - moved;
      return res.redirect(backTo(req, `Moved ${moved} to ${value}${emailed ? ` · ${emailed} emailed` : ''}${skipped ? ` · ${skipped} already there` : ''}`));
    }

    if (kind === 'owner') {
      const member = team.members().find((u) => u.id === value);
      if (value !== 'job' && !member) return res.redirect(backTo(req, 'Choose a team member'));
      for (const a of chosen) Object.assign(a, { ownerId: member ? member.id : '', updatedAt: now });
      db.transaction(() => {
        writeSubmissions('applications', list);
        if (member) for (const a of chosen) { const job = getJobs().find((j) => j.id === a.jobId); if (job) events.assigned(a, job, member.id, req.admin.id); }
      });
      return res.redirect(backTo(req, member ? `Assigned ${chosen.length} to ${member.name}` : `${chosen.length} now follow their job's recruiter`));
    }

    if (kind === 'delete') {
      if (req.admin.role !== 'Admin') return requireAdmin(req, res, () => {});
      writeSubmissions('applications', list.filter((a) => !ids.includes(a.id)));
      for (const a of chosen) if (a.resume) fs.unlink(path.join(uploadsDir, path.basename(a.resume)), () => {});
      return res.redirect(backTo(req, `Deleted ${chosen.length} application${chosen.length === 1 ? '' : 's'} and their resumes`));
    }

    if (kind === 'email') {
      const t = read().find((x) => x.id === value);
      return composePage(res, req, chosen, { subject: t ? t.subject : '', body: t ? t.body : '', templateName: t ? t.name : '' });
    }

    res.redirect(backTo(req, 'Choose what to do with the selected applications'));
  });

  function composePage(res, req, chosen, f, errors = [], status = 200) {
    const sendable = chosen.filter((a) => !a.withdrawnAt && EMAIL_RE.test(a.email || ''));
    const sample = sendable[0] || chosen[0];
    res.status(status).render('admin-bulk-email', {
      title: 'Email candidates', page: 'admin', noindex: true, errors, f, chosen, sendable,
      skipped: chosen.filter((a) => !sendable.includes(a)),
      preview: sample ? { to: sample.name, subject: fill(f.subject, sample, req.admin), body: fill(f.body, sample, req.admin) } : null,
      unknown: unknownPlaceholders(`${f.subject} ${f.body}`), placeholders: PLACEHOLDERS, templates: read(),
      back: String(req.body.back || '/admin?tab=applications'),
    });
  }

  app.post('/admin/applications/bulk-email', adminAuth, sameOrigin, (req, res) => {
    const ids = selectedIds(req.body);
    const list = readSubmissions('applications');
    const chosen = list.filter((a) => ids.includes(a.id));
    const f = { subject: String(req.body.subject || '').trim().slice(0, 200), body: String(req.body.body || '').trim().slice(0, 5000), templateName: String(req.body.templateName || '').slice(0, 80) };
    // "Update preview" re-renders the page with the edited text.
    const errors = [];
    if (!chosen.length) errors.push('no applications selected');
    if (!f.subject) errors.push('subject is required');
    if (!f.body) errors.push('message is required');
    const unknown = unknownPlaceholders(`${f.subject} ${f.body}`);
    if (unknown.length) errors.push(`unknown placeholder${unknown.length === 1 ? '' : 's'}: ${unknown.map((k) => `{${k}}`).join(', ')}`);
    if (req.body.go !== 'send' || errors.length) return composePage(res, req, chosen, f, req.body.go === 'send' ? errors : [], req.body.go === 'send' && errors.length ? 400 : 200);
    const sender = req.admin;
    const replyTo = EMAIL_RE.test(sender.email || '') ? sender.email : undefined;
    let sent = 0;
    const now = new Date().toISOString();
    for (const a of chosen) {
      if (a.withdrawnAt || !EMAIL_RE.test(a.email || '')) continue;
      const subject = fill(f.subject, a, sender);
      mailer.candidateMessage(a, subject, fill(f.body, a, sender), replyTo);
      a.emails = [...(a.emails || []), { at: now, subject, by: sender.name, template: f.templateName || null }].slice(-20);
      sent++;
    }
    writeSubmissions('applications', list);
    res.redirect(backTo(req, `Emailed ${sent} candidate${sent === 1 ? '' : 's'}: "${f.subject}"${chosen.length - sent ? ` · ${chosen.length - sent} skipped (withdrawn or no email)` : ''}`));
  });

  return { read, PLACEHOLDERS, MAX_BULK };
}

module.exports = { register, PLACEHOLDERS };
