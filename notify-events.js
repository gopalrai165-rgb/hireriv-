// Which business events notify whom, and how each email is rebuilt when it is
// sent. Modules call the event functions below right after (or in the same
// transaction as) the change; notify.js stores the notifications and delivery
// tasks and sends them.
//
// Recipients are decided here, on the server, from the records: candidates by
// the application's email, employer people by their membership and role on the
// job (employer-team.js can()), the team by job ownership. Templates check the
// same things again when the email goes out, so someone who lost access or a
// record that was deleted gets nothing.
const { can } = require('./employer-team');
const ats = require('./ats');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DAY = 86400000;
// At most this many job-alert emails per person a day; more stay in-app.
const JOB_ALERTS_PER_DAY = 10;
// Feedback is "due" this long after an interview ends, for up to two weeks.
const FEEDBACK_DUE_HOURS = 2;
const FEEDBACK_WINDOW_DAYS = 14;

function create(deps) {
  const { notify, mailer, site, baseUrl, db, readSubmissions, getJobs, formatIst, interviewIcs, appOwner, team, hasAccount, jobPath } = deps;
  const clients = () => deps.clients();
  const inboxAddress = () => process.env.NOTIFY_EMAIL || site.email;

  // ---------- lookups ----------
  const appById = (id) => readSubmissions('applications').find((a) => a.id === id) || null;
  const jobById = (id) => getJobs().find((j) => j.id === id) || null;
  const selfManaged = (job) => Boolean(job) && job.createdBy === 'employer';
  const employerOf = (job) => (selfManaged(job) ? clients().read().find((e) => e.id === job.employerId && e.active) || null : null);
  const ivOf = (a, id) => (a && (a.interviews || []).find((iv) => iv.id === id)) || null;
  const when = (iv) => formatIst(new Date(iv.at));
  const ics = (method, iv, a) => interviewIcs({ method, interview: iv, candidate: a, jobTitle: a.jobTitle, site });
  const first = (name) => String(name || '').split(' ')[0];

  // Employer people on a job allowed to do `action`, with a confirmed email.
  function jobPeople(job, action, { except } = {}) {
    const emp = employerOf(job);
    if (!emp) return [];
    const store = clients().team;
    return store.membersOf(emp.id).filter((m) => can(m, action, job) && m.userId !== except)
      .map((m) => store.userById(m.userId)).filter((u) => u && u.active && u.emailVerifiedAt)
      .map((u) => ({ kind: 'employer', userId: u.id, employerId: emp.id }));
  }
  const employerPerson = (userId, job) => {
    const emp = employerOf(job);
    return emp ? { kind: 'employer', userId, employerId: emp.id } : null;
  };
  // The recruiter on the team who owns this application (team-run jobs).
  function teamOwner(a) {
    const id = appOwner(a);
    return id && team.byId(id) ? { kind: 'team', userId: id } : null;
  }
  // Who is responsible for an application: its assignee, or the team owner.
  function responsible(a, job) {
    if (selfManaged(job)) return a.assignedTo ? [employerPerson(a.assignedTo, job)].filter(Boolean) : [];
    return [teamOwner(a)].filter(Boolean);
  }
  const messagesOf = (a) => (a && Array.isArray(a.messages) ? a.messages : []);
  const candidate = (a) => (a && a.email && EMAIL_RE.test(a.email) ? { kind: 'candidate', email: a.email } : null);

  // The person behind a recipient, if they may still receive it. For employer
  // people `action` (and `job`) must still be allowed by their current role.
  function person(to, job, action) {
    if (to.kind === 'inbox') return { name: `${site.name} team`, email: inboxAddress(), kind: 'team', inbox: true };
    if (to.kind === 'team') {
      const u = team.byId(to.userId);
      return u && EMAIL_RE.test(u.email || '') ? { name: u.name, email: u.email, kind: 'team' } : null;
    }
    if (to.kind === 'employer') {
      const store = clients().team;
      const u = store.userById(to.userId);
      const m = u && store.membership(u.id, to.employerId);
      const emp = m && clients().read().find((e) => e.id === to.employerId && e.active);
      if (!u || !u.active || !u.emailVerifiedAt || !emp) return null;
      if (action && !can(m, action, job)) return null;
      return { name: u.name, email: u.email, company: emp.company, kind: 'employer', member: m, employer: emp };
    }
    return null;
  }
  // The application, only if it belongs to the candidate this was meant for.
  const candidateApp = (refs, to) => {
    const a = appById(refs.applicationId);
    return a && a.email && notify.candidateRk(a.email) === to.rk ? a : null;
  };
  const applicantLink = (who, a, tab = 'applications') => (who.kind === 'employer' ? `${baseUrl}/employer/applicants/${a.id}` : `${baseUrl}/admin?tab=${tab}`);
  const inAppApplicant = (r, a, tab = 'applications') => (r.kind === 'employer' ? `/employer/applicants/${a.id}` : `/admin?tab=${tab}`);

  // ---------- email templates ----------
  const T = (name, resolve, version = 1) => notify.template(name, { version, resolve });

  T('application-confirmation', (refs, to) => {
    const a = candidateApp(refs, to);
    return a && { to: a.email, send: () => (refs.updated ? mailer.applicationUpdatedConfirmation(a) : mailer.applicationConfirmation(a)) };
  });
  T('application-to-team', (refs) => {
    const a = appById(refs.applicationId);
    return a && { to: inboxAddress(), send: () => (refs.updated ? mailer.applicationUpdatedToTeam(a) : mailer.applicationToTeam(a)) };
  });
  T('employer-new-application', (refs, to) => {
    const a = appById(refs.applicationId);
    const job = a && jobById(a.jobId);
    const who = job && person(to, job, 'applicants.manage');
    return who && !a.withdrawnAt && { to: who.email, send: () => mailer.employerNewApplication({ ...who.employer, name: who.name, email: who.email }, a, applicantLink(who, a)) };
  });
  T('interview-invite', (refs, to) => {
    const a = candidateApp(refs, to);
    const iv = ivOf(a, refs.interviewId);
    return iv && iv.status === 'scheduled' && Date.parse(iv.at) > Date.now() && { to: a.email, send: () => mailer.interviewScheduled(a, iv, ics('REQUEST', iv, a), when(iv)) };
  });
  T('interview-rescheduled', (refs, to) => {
    const a = candidateApp(refs, to);
    const iv = ivOf(a, refs.interviewId);
    return iv && iv.status === 'scheduled' && Date.parse(iv.at) > Date.now() && { to: a.email, send: () => mailer.interviewRescheduled(a, iv, ics('REQUEST', iv, a), when(iv), refs.previous ? formatIst(new Date(refs.previous)) : '') };
  });
  T('interview-cancelled', (refs, to) => {
    const a = candidateApp(refs, to);
    const iv = ivOf(a, refs.interviewId);
    return iv && iv.status === 'cancelled' && { to: a.email, send: () => mailer.interviewCancelled(a, iv, ics('CANCEL', iv, a), when(iv)) };
  });
  T('interview-reminder', (refs, to) => {
    const a = candidateApp(refs, to);
    const iv = ivOf(a, refs.interviewId);
    return iv && iv.status === 'scheduled' && !a.withdrawnAt && Date.parse(iv.at) > Date.now() && { to: a.email, send: () => mailer.interviewReminder(a, iv, when(iv), refs.kind) };
  });
  T('interviewer-reminder', (refs) => {
    const a = appById(refs.applicationId);
    const iv = ivOf(a, refs.interviewId);
    return iv && iv.status === 'scheduled' && iv.interviewerEmail && Date.parse(iv.at) > Date.now() && { to: iv.interviewerEmail, send: () => mailer.interviewerReminder(iv.interviewerEmail, a, iv, when(iv), refs.kind) };
  });
  T('interview-response', (refs, to) => {
    const a = appById(refs.applicationId);
    const iv = ivOf(a, refs.interviewId);
    const job = a && jobById(a.jobId);
    const who = iv && person(to, job, 'interviews.manage');
    return who && { to: who.email, send: () => mailer.interviewResponse(who, a, iv, when(iv), refs.confirmed, iv.candidateNote, applicantLink(who, a, 'interviews')) };
  });
  const companyOf = (a) => {
    const job = jobById(a.jobId);
    const emp = employerOf(job);
    return emp ? emp.company : (job && job.company) || site.name;
  };
  T('offer-made', (refs, to) => {
    const a = candidateApp(refs, to);
    const o = a && ats.findOffer(a, refs.offerId);
    return o && o.approval.status === 'approved' && o.response.status === 'awaiting' && { to: a.email, send: () => mailer.offerMade(a, companyOf(a), o) };
  });
  T('offer-deadline', (refs, to) => {
    const a = candidateApp(refs, to);
    const o = a && ats.findOffer(a, refs.offerId);
    return o && o.approval.status === 'approved' && o.response.status === 'awaiting' && o.respondBy && { to: a.email, send: () => mailer.offerDeadline(a, companyOf(a), o) };
  });
  T('status-update', (refs, to) => {
    const a = candidateApp(refs, to);
    return a && a.status === refs.status && !a.withdrawnAt && { to: a.email, send: () => mailer.statusChanged(a) };
  });
  T('job-alert', (refs, to) => {
    const sub = readSubmissions('job-alerts').find((s) => s.id === refs.alertId);
    const job = jobById(refs.jobId);
    return sub && sub.confirmed && sub.alertEnabled !== false && notify.candidateRk(sub.email) === to.rk && job && job.status === 'open' && { to: sub.email, send: () => mailer.jobAlert(sub, job) };
  });
  T('job-digest', (refs, to) => {
    const sub = readSubmissions('job-alerts').find((s) => s.id === refs.alertId);
    if (!sub || !sub.confirmed || sub.alertEnabled === false || notify.candidateRk(sub.email) !== to.rk) return null;
    const jobs = (refs.jobIds || []).map(jobById).filter((j) => j && j.status === 'open');
    return jobs.length ? { to: sub.email, send: () => mailer.jobDigest(sub, jobs, refs.frequency) } : null;
  });
  // Only while the candidate still lets employers find them, and the job is open.
  T('job-invite', (refs, to) => {
    const c = readSubmissions('candidates').find((x) => x.id === refs.candidateId);
    const job = jobById(refs.jobId);
    return c && c.privacy && c.privacy.discoverable === true && notify.candidateRk(c.email) === to.rk && job && job.status === 'open' && employerOf(job)
      ? { to: c.email, send: () => mailer.jobInvite(c, job) } : null;
  });
  T('job-decision', (refs, to) => {
    const job = jobById(refs.jobId);
    const who = job && person(to, job);
    if (!who) return null;
    const link = refs.approved ? `${baseUrl}${jobPath(job)}` : `${baseUrl}/employer/jobs/${job.id}/edit`;
    return { to: who.email, send: () => mailer.employerJobDecision({ ...who.employer, name: who.name, email: who.email }, job, refs.approved, refs.reason || '', link) };
  });

  // Short notices to employer people and the team, built from the records.
  const NOTICES = {
    assigned(refs, to) {
      const a = appById(refs.applicationId);
      const job = a && jobById(a.jobId);
      const who = job && person(to, job, 'applicants.view');
      if (!who || (who.kind === 'employer' && a.assignedTo !== to.userId)) return null;
      return { who, subject: `An applicant for ${job.title} is now yours`, heading: 'You have a new applicant to look after', intro: `you're now responsible for ${first(a.name)}'s application for ${job.title}.`, rows: [['Stage', ats.label(a.status)]], link: applicantLink(who, a), label: 'Open the applicant', why: 'applicants assigned to you' };
    },
    'feedback-due'(refs, to) {
      const a = appById(refs.applicationId);
      const iv = ivOf(a, refs.interviewId);
      const job = a && jobById(a.jobId);
      const who = iv && person(to, job, 'feedback.submit');
      if (!who || iv.status !== 'scheduled' || (iv.feedback || []).length) return null;
      return { who, subject: `Interview feedback due for ${job ? job.title : a.jobTitle}`, heading: 'Please add your interview feedback', intro: `the interview with ${first(a.name)} on ${when(iv)} has no scorecard yet. A quick rating helps decide the next step.`, rows: [], link: applicantLink(who, a, 'interviews'), label: 'Add feedback', why: 'interview feedback that is due' };
    },
    'offer-response'(refs, to) {
      const a = appById(refs.applicationId);
      const job = a && jobById(a.jobId);
      const o = a && ats.findOffer(a, refs.offerId);
      const who = o && !o.withdrawnAt && ['accepted', 'declined'].includes(o.response.status) && person(to, job, 'offers.respond');
      if (!who) return null;
      const accepted = o.response.status === 'accepted';
      return {
        who, subject: `${first(a.name)} ${accepted ? 'accepted' : 'declined'} your offer for ${job.title}`, heading: accepted ? 'Your offer was accepted' : 'Your offer was declined',
        intro: accepted ? `${first(a.name)} accepted your offer for ${job.title}. Confirm the joining details with them, then mark them Hired when they join.` : `${first(a.name)} declined your offer for ${job.title}.`,
        rows: [['Joining date', o.joiningDate || ''], ['Their note', o.response.note || '']], link: applicantLink(who, a), label: 'Open the applicant', why: 'answers to your job offers',
      };
    },
    'hiring-milestone'(refs, to) {
      const a = appById(refs.applicationId);
      const job = a && jobById(a.jobId);
      const who = job && person(to, job, 'applicants.view');
      if (!who) return null;
      const what = refs.milestone === 'offer-accepted' ? 'accepted the offer' : 'was hired';
      return { who, subject: `Hiring update for ${job.title}`, heading: refs.milestone === 'offer-accepted' ? 'An offer was accepted' : 'Someone was hired', intro: `${first(a.name)} ${what} for ${job.title}.`, rows: [['Openings', job.openings ? String(job.openings) : '']], link: applicantLink(who, a), label: 'Open the applicant', why: 'hiring milestones' };
    },
    'offer-approval'(refs, to) {
      const a = appById(refs.applicationId);
      const job = a && jobById(a.jobId);
      const o = a && ats.findOffer(a, refs.offerId);
      const who = o && person(to, job, 'offers.approve');
      if (!who || o.approval.status !== 'pending' || o.createdByUserId === to.userId) return null;
      return { who, subject: `An offer for ${job.title} needs your approval`, heading: 'An offer is waiting for approval', intro: `${o.createdBy || 'A colleague'} made an offer to ${first(a.name)} for ${job.title}. It goes to the candidate once someone approves it.`, rows: [['Joining date', o.joiningDate || 'To be agreed']], link: applicantLink(who, a), label: 'Review the offer', why: 'offers waiting for approval' };
    },
    'job-closing-soon'(refs, to) {
      const job = jobById(refs.jobId);
      const who = job && person(to, job, 'job.view');
      if (!who || job.status !== 'open' || job.closesOn !== refs.closesOn) return null;
      return { who, subject: `Closing soon: ${job.title}`, heading: 'A job is about to close', intro: `${job.title} takes applications until ${job.closesOn}, then closes by itself. Still hiring? Keep it open for 30 more days from your jobs, in one click.`, rows: [], link: `${baseUrl}/employer/jobs?status=open`, label: 'Keep it open', why: 'your jobs closing' };
    },
    'job-expired'(refs, to) {
      const job = jobById(refs.jobId);
      const who = job && person(to, job, 'job.view');
      if (!who || job.status !== 'closed') return null;
      return { who, subject: `Your job closed: ${job.title}`, heading: 'A job reached its closing date', intro: `${job.title} passed its last day to apply (${job.closesOn}) and closed by itself. Reopen it from your jobs if you're still hiring.`, rows: [], link: `${baseUrl}/employer/jobs`, label: 'Your jobs', why: 'your jobs closing' };
    },
  };
  // A message about an application (messages.js). The email says only that
  // there is one: the words stay on the site, where they can be reported.
  NOTICES['message-to-candidate'] = (refs) => {
    const a = appById(refs.applicationId);
    if (!a || a.withdrawnAt || !candidate(a)) return null;
    const job = jobById(a.jobId);
    return {
      who: { name: a.name, email: a.email, kind: 'candidate' }, subject: `New message about your application: ${a.jobTitle}`, heading: 'You have a new message',
      intro: `${job ? job.company : 'The employer'} sent you a message about ${a.jobTitle}. Sign in to read it and reply.`,
      rows: [], link: `${baseUrl}/account/messages/${a.id}`, label: 'Read the message', why: 'your job applications',
    };
  };
  NOTICES['message-to-hiring'] = (refs, to) => {
    const a = appById(refs.applicationId);
    const job = a && jobById(a.jobId);
    const who = job && person(to, job, 'applicants.contact');
    if (!who) return null;
    return { who, subject: `${first(a.name)} replied about ${job.title}`, heading: 'An applicant replied', intro: `${first(a.name)} replied to your message about ${job.title}.`, rows: [], link: applicantLink(who, a) + '#messages', label: 'Read the reply' };
  };
  NOTICES['hire-request-overdue'] = (refs, to) => {
    const h = readSubmissions('hire-requests').find((x) => x.id === refs.hireRequestId);
    const who = h && person(to);
    if (!who || (h.followUp || 'New') !== 'New') return null;
    return {
      who, subject: `Call ${h.company} today: enquiry not yet contacted`, heading: 'An employer enquiry is waiting for a call',
      intro: `${h.company} asked about hiring more than a working day ago and is still marked New. Please call ${h.name}${h.phone ? ` on ${h.phone}` : ''}, then set the status to Contacted.`,
      rows: [['Requirement', h.roles], ['Number of employees', h.headcount || ''], ['Location', h.location || '']], link: `${baseUrl}/admin?tab=hire-requests`, label: 'Open hire requests', why: 'employer enquiries waiting for a call',
    };
  };
  // The week's employer enquiries in numbers (enquiry-stats.js), worked out when the email is sent.
  const IST = 5.5 * 3600000;
  const enquiryStats = require('./enquiry-stats');
  const leadSummary = (isOverdue, endMs) => enquiryStats.summarise(readSubmissions('hire-requests'), { isOverdue, period: '7', now: endMs });
  NOTICES['lead-summary'] = (refs, to) => {
    const who = person(to);
    if (!who) return null;
    const s = { ...leadSummary(() => false, refs.endMs), waiting: refs.overdue || 0 };
    const list = (pairs) => pairs.map(([k, n]) => `${k}: ${n}`).join(', ') || 'None';
    const openByStatus = s.byStatus.filter(([k, n]) => k !== 'Closed' && n);
    return {
      who, subject: `Employer enquiries this week: ${s.received} new${s.waiting ? `, ${s.waiting} waiting for a call` : ''}`, heading: 'Your weekly enquiry summary',
      intro: `${s.received} new employer enquir${s.received === 1 ? 'y' : 'ies'} in the last 7 days, ${s.open} still open${s.waiting ? ` and ${s.waiting} not yet contacted after a working day` : ''}.`,
      rows: [['Where they came from', list(s.sources)], ['Which page', list(s.pages)], ['Open by status', list(openByStatus)], ['Closed this week', String(s.closed)],
        ['Median time to first call', s.medianHours === null ? '' : enquiryStats.formatHours(s.medianHours)]],
      link: `${baseUrl}/admin?tab=hire-requests`, label: 'Open hire requests', why: 'the weekly summary of employer enquiries',
    };
  };
  // Second-Admin approval for exports (export-approval.js).
  const exportRequestOf = (id) => readSubmissions('export-requests').find((r) => r.id === id) || null;
  NOTICES['export-request'] = (refs, to) => {
    const who = person(to);
    const r = who && exportRequestOf(refs.requestId);
    if (!r || r.status !== 'pending') return null;
    return {
      who, subject: `Approve an export? ${r.requesterName} asked for ${r.name}`, heading: 'An export is waiting for your approval',
      intro: `${r.requesterName} wants to download ${r.name}. Exports need a second Admin. Approve only if you know why it is needed.`,
      rows: [['Export', r.name], ['Reason given', r.reason], ['Asked by', r.requesterName]],
      link: `${baseUrl}/admin/export-requests`, label: 'Approve or decline', why: 'export approvals for your team',
    };
  };
  NOTICES['export-decision'] = (refs, to) => {
    const who = person(to);
    const r = who && exportRequestOf(refs.requestId);
    if (!r || !['approved', 'declined', 'used'].includes(r.status)) return null;
    const ok = r.status !== 'declined';
    return {
      who, subject: ok ? `Approved: you can download ${r.name}` : `Declined: ${r.name}`, heading: ok ? 'Your export was approved' : 'Your export was declined',
      intro: ok ? `${r.decidedByName} approved your export of ${r.name}. You can download it once in the next 24 hours.` : `${r.decidedByName} declined your export of ${r.name}. Talk to them if you still need it.`,
      rows: [['Export', r.name], ['Reason you gave', r.reason]],
      link: `${baseUrl}/admin/export-requests`, label: 'Open export approvals', why: 'your export request',
    };
  };
  function exportRequested(r, adminIds) {
    if (!adminIds.length) return 0;
    return emit({
      key: `export-request:${r.id}`, type: 'export-request', to: adminIds.map((userId) => ({ kind: 'team', userId })),
      inApp: { title: `Approve an export? ${r.requesterName}: ${r.name}`, body: r.reason, link: '/admin/export-requests' },
      email: { template: 'notice', refs: { kind: 'export-request', requestId: r.id } },
    }).notifications;
  }
  function exportDecided(r) {
    const ok = r.status === 'approved';
    return emit({
      key: `export-decision:${r.id}`, type: 'export-decision', to: [{ kind: 'team', userId: r.requesterId }],
      inApp: { title: ok ? `Approved: ${r.name}` : `Declined: ${r.name}`, body: ok ? `${r.decidedByName} approved it. Download it once within 24 hours.` : `${r.decidedByName} declined it.`, link: ok ? r.target : '/admin/export-requests' },
      email: { template: 'notice', refs: { kind: 'export-decision', requestId: r.id } },
    }).notifications;
  }

  // Monday's analytics email (analytics.js weekly): the last 7 days against the 7 before.
  const weeklyOf = (to, endMs) => (deps.analyticsWeekly ? deps.analyticsWeekly()(to, endMs) : null);
  const kpiText = (k) => {
    if (k.value === null || k.value === undefined) return 'Not enough data';
    const v = k.unit === 'paise' ? `Rs ${(k.value / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}` : k.unit === '%' ? `${k.value}%` : k.unit === 'days' ? `${k.value} days` : Number(k.value).toLocaleString('en-IN');
    const c = k.change;
    if (!c) return v;
    if (c.better === 'same') return `${v} (same as the week before)`;
    if (c.from0) return `${v} (none the week before)`;
    return `${v} (${c.by > 0 ? 'up' : 'down'} ${Math.abs(c.by)}${c.kind === 'percent' ? '%' : c.kind === 'points' ? ' points' : ' days'})`;
  };
  NOTICES['analytics-weekly'] = (refs, to) => {
    const who = person(to);
    const w = who && weeklyOf(to, refs.endMs);
    if (!w) return null;
    const apps = w.kpis.find((k) => k.id === 'applications');
    return {
      who, subject: `${w.company ? `${w.company}: ` : ''}your week in numbers, ${apps ? apps.value : 0} application${apps && apps.value === 1 ? '' : 's'}`, heading: 'Your weekly hiring numbers',
      intro: `${w.f.from} to ${w.f.to} (India dates), compared with the 7 days before.`,
      rows: w.kpis.map((k) => [k.label, kpiText(k)]),
      link: `${baseUrl}${w.link}`, label: 'Open analytics', why: 'the weekly analytics email you turned on',
    };
  };
  // Interview times offered for the candidate to choose from.
  NOTICES['interview-options'] = (refs, to) => {
    const a = appById(refs.applicationId);
    const offer = a && a.interviewOptions;
    if (!offer || offer.id !== refs.offerId || offer.status !== 'open') return null;
    const job = jobById(a.jobId);
    const slots = offer.slots.filter((s) => Date.parse(s.at) > Date.now());
    if (!slots.length) return null;
    return {
      who: { name: a.name, email: a.email, kind: 'candidate' }, subject: `Choose a time for your interview: ${a.jobTitle}`, heading: 'Pick a time for your interview',
      intro: `${job ? job.company : 'The employer'} would like to interview you for ${a.jobTitle} and offered ${slots.length} times (${offer.f.mode}, ${offer.f.duration} minutes). Choose the one that suits you; the others are released.`,
      rows: slots.map((s, i) => [`Option ${i + 1}`, formatIst(new Date(s.at))]), link: `${baseUrl}/account/interviews#choose`, label: 'Choose a time', why: 'your job applications',
    };
  };
  T('notice', (refs, to) => {
    const n = NOTICES[refs.kind] && NOTICES[refs.kind](refs, to);
    if (!n) return null;
    const { who, ...content } = n;
    return { to: who.email, send: () => mailer.notice(who, content) };
  });

  // ---------- events ----------
  const emit = (e) => notify.emit(e);

  // A new or updated application: the candidate's confirmation and the team's copy.
  function applicationSubmitted(a, job, { updated = false } = {}) {
    const key = updated ? `application-updated:${a.id}:${a.updatedAt}` : `application:${a.id}`;
    const title = job ? job.title : a.jobTitle;
    emit({ key, type: 'application-submitted', to: [candidate(a)], inApp: { title: updated ? `Application updated: ${title}` : `Application received: ${title}`, body: 'You can follow its progress in your account.', link: '/account#applications' }, email: { template: 'application-confirmation', refs: { applicationId: a.id, updated } } });
    emit({ key, type: 'new-application', to: [{ kind: 'inbox' }], email: { template: 'application-to-team', refs: { applicationId: a.id, updated } } });
  }
  // Someone applied to a job: the people working on it hear about it.
  function newApplication(a, job, match) {
    const strong = typeof match === 'number' && match >= 70;
    const people = selfManaged(job) ? jobPeople(job, 'applicants.manage') : [teamOwner(a)].filter(Boolean).map((r) => ({ ...r, mail: false }));
    emit({
      key: `new-application:${a.id}`, type: 'new-application', to: people,
      inApp: (r) => ({ title: `${strong ? 'Strong match: n' : 'N'}ew application for ${job.title}`, body: `${first(a.name)} applied${strong ? ` and matches ${match}% of the skills` : ''}.`, link: inAppApplicant(r, a), jobId: job.id, perm: 'applicants.view' }),
      email: { template: 'employer-new-application', refs: { applicationId: a.id } },
    });
  }

  // Every stage move (history.onMove): the candidate sees what changed for them,
  // the person responsible hears when someone else moved their applicant, and
  // a hire is a milestone for the people running the job.
  function stageMoved(a, h) {
    const job = jobById(a.jobId);
    const key = `stage:${a.id}:${h.at}:${h.to}`;
    const seen = (s) => ats.CANDIDATE_LABELS[s] || ats.CANDIDATE_LABELS.New;
    if (seen(h.from) !== seen(h.to)) {
      emit({ key, type: 'application-status', to: [candidate(a)], inApp: { title: `Update on your application: ${a.jobTitle}`, body: `Status: ${seen(h.to)}.`, link: '/account#applications' } });
    }
    const others = responsible(a, job).filter((r) => r.userId !== h.userId);
    if (others.length && job) {
      emit({ key, type: 'stage-changed', to: others, inApp: (r) => ({ title: `Stage changed for ${job.title}`, body: `${first(a.name)}: ${ats.label(h.from)} → ${ats.label(h.to)}${h.correction ? ' (correction)' : ''}.`, link: inAppApplicant(r, a), jobId: job.id, perm: 'applicants.view' }) });
    }
    if (h.to === 'Hired' && job) milestone(a, job, 'hired', h.userId);
  }
  function milestone(a, job, kind, actorId) {
    const people = selfManaged(job) ? jobPeople(job, 'applicants.assign', { except: actorId }) : [teamOwner(a)].filter((r) => r && r.userId !== actorId).map((r) => ({ ...r, mail: false }));
    emit({
      key: `milestone:${a.id}:${kind}`, type: 'hiring-milestone', to: people,
      inApp: (r) => ({ title: kind === 'hired' ? `Hired for ${job.title}` : `Offer accepted for ${job.title}`, body: `${first(a.name)} ${kind === 'hired' ? 'was hired' : 'accepted the offer'}.`, link: inAppApplicant(r, a), jobId: job.id, perm: 'applicants.view' }),
      email: { template: 'notice', refs: { kind: 'hiring-milestone', applicationId: a.id, milestone: kind } },
    });
  }
  // The team ticked "email the candidate" on a stage change. Returns whether an
  // email was queued (only for stages a candidate hears about).
  function statusEmail(a) {
    if (!['Interview', 'Offered', 'Hired', 'Rejected'].includes(a.status) || a.withdrawnAt || !candidate(a)) return false;
    const h = (a.history || [])[a.history.length - 1];
    return emit({ key: `status-email:${a.id}:${a.status}:${h ? h.at : a.updatedAt}`, type: 'application-status', to: [candidate(a)], email: { template: 'status-update', refs: { applicationId: a.id, status: a.status } } }).deliveries > 0;
  }

  // ---------- interviews ----------
  function interviewBooked(a, iv) {
    emit({ key: `interview-invite:${iv.id}`, type: 'interview-invited', to: [candidate(a)], inApp: { title: `Interview invitation: ${a.jobTitle}`, body: `${when(iv)} (${iv.mode}). Please confirm or ask for another time.`, link: '/account/interviews' }, email: { template: 'interview-invite', refs: { applicationId: a.id, interviewId: iv.id } } });
  }
  function interviewOptionsOffered(a, offer) {
    emit({ key: `interview-options:${offer.id}`, type: 'interview-options', to: [candidate(a)], inApp: { title: `Choose an interview time: ${a.jobTitle}`, body: `${offer.slots.length} times to choose from. Pick the one that suits you.`, link: '/account/interviews#choose' }, email: { template: 'notice', refs: { kind: 'interview-options', applicationId: a.id, offerId: offer.id } } });
  }
  function interviewRescheduled(a, iv, previous) {
    emit({ key: `interview-moved:${iv.id}:${iv.sequence}`, type: 'interview-rescheduled', to: [candidate(a)], inApp: { title: `Interview moved: ${a.jobTitle}`, body: `New time: ${when(iv)}. Please confirm it.`, link: '/account/interviews' }, email: { template: 'interview-rescheduled', refs: { applicationId: a.id, interviewId: iv.id, previous } } });
  }
  function interviewCancelled(a, iv) {
    emit({ key: `interview-cancelled:${iv.id}`, type: 'interview-cancelled', to: [candidate(a)], inApp: { title: `Interview cancelled: ${a.jobTitle}`, body: `The interview on ${when(iv)} won't go ahead.`, link: '/account/interviews' }, email: { template: 'interview-cancelled', refs: { applicationId: a.id, interviewId: iv.id } } });
  }
  function interviewReminder(a, iv, kind) {
    const key = `interview-reminder:${iv.id}:${kind}`;
    const soon = kind === 'hour' ? 'in about an hour' : 'tomorrow';
    emit({ key, type: 'interview-reminder', to: [candidate(a)], inApp: { title: `Interview ${soon}: ${a.jobTitle}`, body: `${when(iv)} (${iv.mode}).`, link: '/account/interviews' }, email: { template: 'interview-reminder', refs: { applicationId: a.id, interviewId: iv.id, kind } } });
    if (iv.interviewerEmail) emit({ key, type: 'interview-reminder', to: [{ kind: 'interviewer', interviewId: iv.id }], email: { template: 'interviewer-reminder', refs: { applicationId: a.id, interviewId: iv.id, kind } } });
    const job = jobById(a.jobId);
    if (job) emit({ key, type: 'interview-upcoming', to: responsible(a, job).map((r) => ({ ...r, mail: false })), inApp: (r) => ({ title: `Interview ${soon} for ${job.title}`, body: `${first(a.name)} at ${when(iv)}${iv.confirmation === 'confirmed' ? ', confirmed by the candidate' : ''}.`, link: inAppApplicant(r, a, 'interviews'), jobId: job.id, perm: 'applicants.view' }) });
  }
  // The candidate confirmed or asked for another time.
  function interviewAnswered(a, iv, confirmed) {
    const job = jobById(a.jobId);
    const key = `interview-answer:${iv.id}:${iv.confirmation}:${iv.answeredAt}`;
    const to = selfManaged(job) ? jobPeople(job, 'interviews.manage') : [{ kind: 'inbox' }, ...[teamOwner(a)].filter(Boolean).map((r) => ({ ...r, mail: false }))];
    emit({
      key, type: 'interview-response', to,
      inApp: (r) => ({ title: `${confirmed ? 'Interview confirmed' : 'New time requested'} for ${a.jobTitle}`, body: `${first(a.name)} ${confirmed ? 'will attend' : "can't make"} the interview on ${when(iv)}.`, link: inAppApplicant(r, a, 'interviews'), jobId: a.jobId, perm: 'applicants.view' }),
      email: { template: 'interview-response', refs: { applicationId: a.id, interviewId: iv.id, confirmed } },
    });
  }
  // Interviews that ended a while ago with no scorecard: the person responsible
  // (or the people who can write one) is reminded once.
  function feedbackDueScan(nowMs = Date.now()) {
    let n = 0;
    for (const a of readSubmissions('applications')) {
      if (a.withdrawnAt) continue;
      const job = jobById(a.jobId);
      for (const iv of a.interviews || []) {
        const end = Date.parse(iv.at) + (iv.duration || 0) * 60000;
        if (iv.status !== 'scheduled' || (iv.feedback || []).length || nowMs - end < FEEDBACK_DUE_HOURS * 3600000 || nowMs - end > FEEDBACK_WINDOW_DAYS * DAY || !job) continue;
        const people = selfManaged(job) ? (a.assignedTo ? responsible(a, job) : jobPeople(job, 'feedback.submit')) : responsible(a, job);
        n += emit({
          key: `feedback-due:${iv.id}`, type: 'feedback-due', to: people,
          inApp: (r) => ({ title: `Feedback due for ${job.title}`, body: `Add your scorecard for ${first(a.name)}'s interview on ${when(iv)}.`, link: inAppApplicant(r, a, 'interviews'), jobId: job.id, perm: 'feedback.submit' }),
          email: { template: 'notice', refs: { kind: 'feedback-due', applicationId: a.id, interviewId: iv.id } },
        }).notifications;
      }
    }
    return n;
  }

  // ---------- offers ----------
  function offerCreated(a, job, o, byUserId) {
    emit({
      key: `offer-approval:${o.id}`, type: 'offer-approval', to: jobPeople(job, 'offers.approve', { except: byUserId }),
      inApp: { title: `Offer to approve for ${job.title}`, body: `${first(a.name)}: approve it so it goes to the candidate.`, link: `/employer/applicants/${a.id}`, jobId: job.id, perm: 'offers.approve' },
      email: { template: 'notice', refs: { kind: 'offer-approval', applicationId: a.id, offerId: o.id } },
    });
  }
  function offerApproved(a, o) {
    emit({ key: `offer-made:${o.id}`, type: 'offer-received', to: [candidate(a)], inApp: { title: `Job offer: ${a.jobTitle}`, body: o.respondBy ? `Please reply by ${o.respondBy}.` : 'The company will share the details with you.', link: '/account#offers' }, email: { template: 'offer-made', refs: { applicationId: a.id, offerId: o.id } } });
  }
  // The candidate accepted or declined an offer from their account: the people
  // who record offer answers hear about it (the team inbox for desk jobs).
  function offerAnsweredByCandidate(a, o) {
    const job = jobById(a.jobId);
    if (!job) return;
    const accepted = o.response.status === 'accepted';
    const to = selfManaged(job) ? jobPeople(job, 'offers.respond') : [{ kind: 'inbox' }, ...[teamOwner(a)].filter(Boolean).map((r) => ({ ...r, mail: false }))];
    emit({
      key: `offer-answer:${o.id}`, type: 'offer-response', to,
      inApp: (r) => ({ title: `Offer ${accepted ? 'accepted' : 'declined'}: ${job.title}`, body: `${first(a.name)} ${accepted ? 'accepted' : 'declined'} your offer${o.response.note ? `: "${o.response.note.slice(0, 120)}"` : '.'}`, link: inAppApplicant(r, a), jobId: job.id, perm: 'applicants.view' }),
      email: { template: 'notice', refs: { kind: 'offer-response', applicationId: a.id, offerId: o.id } },
    });
  }
  function offerAnswered(a, job, o, byUserId) {
    if (o.response.status === 'accepted') milestone(a, job, 'offer-accepted', byUserId);
  }
  // Approved offers with no answer, due tomorrow or today.
  function offerDeadlineScan(today) {
    let n = 0;
    const tomorrow = new Date(Date.parse(today) + DAY).toISOString().slice(0, 10);
    for (const a of readSubmissions('applications')) {
      if (a.withdrawnAt) continue;
      for (const o of ats.liveOffers(a)) {
        if (o.approval.status !== 'approved' || o.response.status !== 'awaiting' || !o.respondBy || o.respondBy < today || o.respondBy > tomorrow) continue;
        const job = jobById(a.jobId);
        n += emit({ key: `offer-deadline:${o.id}`, type: 'offer-deadline', to: [candidate(a)], inApp: { title: `Reply to your offer: ${a.jobTitle}`, body: `The company asked for your answer by ${o.respondBy}.`, link: '/account#offers' }, email: { template: 'offer-deadline', refs: { applicationId: a.id, offerId: o.id } } }).deliveries;
        if (job) emit({ key: `offer-deadline:${o.id}`, type: 'offer-deadline', to: jobPeople(job, 'offers.respond').map((r) => ({ ...r, mail: false })), inApp: { title: `Offer answer due for ${job.title}`, body: `${first(a.name)} was asked to reply by ${o.respondBy}. Record their answer when you have it.`, link: `/employer/applicants/${a.id}`, jobId: job.id, perm: 'offers.respond' } });
      }
    }
    return n;
  }

  // ---------- assignments ----------
  function assigned(a, job, userId, byUserId) {
    if (!userId || userId === byUserId) return;
    const to = selfManaged(job) ? [employerPerson(userId, job)] : [team.byId(userId) ? { kind: 'team', userId } : null];
    emit({ key: `assigned:${a.id}:${userId}:${a.updatedAt || ''}`, type: 'candidate-assigned', to, inApp: (r) => ({ title: `Assigned to you: ${job.title}`, body: `${first(a.name)}'s application (${ats.label(a.status)}).`, link: inAppApplicant(r, a), jobId: job.id, perm: 'applicants.view' }), email: { template: 'notice', refs: { kind: 'assigned', applicationId: a.id } } });
  }

  // ---------- jobs ----------
  // The team approved or sent back a job: the person who posted it and the owners.
  function jobDecision(job, emp, approved, reason) {
    const store = clients().team;
    const ids = [...new Set([job.createdByUser, ...store.owners(emp.id).map((m) => m.userId)].filter(Boolean))];
    const to = ids.filter((id) => store.membership(id, emp.id)).map((id) => ({ kind: 'employer', userId: id, employerId: emp.id }));
    emit({ key: `job-decision:${job.id}:${approved ? `approved:${job.approvedAt}` : `sent-back:${job.rejectedAt}`}`, type: 'job-decision', to, inApp: { title: approved ? `Your job is live: ${job.title}` : `Changes needed: ${job.title}`, body: approved ? 'It is on the site and taking applications.' : `The team's note: ${reason}`, link: approved ? `/employer/jobs` : `/employer/jobs/${job.id}/edit`, jobId: job.id, perm: 'job.view' }, email: { template: 'job-decision', refs: { jobId: job.id, approved, reason } } });
  }
  // Three days before a job's last day to apply: one reminder to the people
  // who may edit it (again only if the closing date changes).
  const CLOSING_SOON_DAYS = 3;
  function jobClosingSoonScan(today) {
    let n = 0;
    for (const job of getJobs()) {
      if (job.status !== 'open' || !job.closesOn || !selfManaged(job) || job.closesOn < today) continue;
      const left = Math.round((Date.parse(job.closesOn) - Date.parse(today)) / 86400000);
      if (left > CLOSING_SOON_DAYS) continue;
      const r = emit({
        key: `job-closing:${job.id}:${job.closesOn}`, type: 'job-closing-soon', to: jobPeople(job, 'job.edit'),
        inApp: { title: `Closing ${left === 0 ? 'today' : left === 1 ? 'tomorrow' : `in ${left} days`}: ${job.title}`, body: `Last day to apply: ${job.closesOn}. Keep it open for 30 more days if you're still hiring.`, link: '/employer/jobs?status=open', jobId: job.id, perm: 'job.view' },
        email: { template: 'notice', refs: { kind: 'job-closing-soon', jobId: job.id, closesOn: job.closesOn } },
      });
      n += r.notifications + r.deliveries ? 1 : 0;
    }
    return n;
  }
  // A job reached its closing date.
  function jobExpired(job) {
    if (!selfManaged(job)) return;
    emit({ key: `job-expired:${job.id}:${job.closedAt}`, type: 'job-expired', to: jobPeople(job, 'job.edit'), inApp: { title: `Job closed: ${job.title}`, body: `Its last day to apply (${job.closesOn}) has passed. Reopen it if you're still hiring.`, link: '/employer/jobs', jobId: job.id, perm: 'job.view' }, email: { template: 'notice', refs: { kind: 'job-expired', jobId: job.id } } });
  }
  // An employer sent a job for review: the team's Admins see it in-app (the
  // team inbox already gets the email).
  function jobSubmitted(job) {
    const admins = team.members().filter((u) => u.role === 'Admin').map((u) => ({ kind: 'team', userId: u.id }));
    emit({ key: `job-review:${job.id}:${job.submittedAt || job.updatedAt}`, type: 'job-review', to: admins, inApp: { title: `Job waiting for review: ${job.title}`, body: `${job.company} sent it for review.`, link: '/admin?tab=jobs' } });
  }
  // New job alerts: one email per person per job however many of their alerts
  // match, at most JOB_ALERTS_PER_DAY a day, and none when they switched job
  // emails off. People with an account also see it in-app. Returns how many
  // people were told.
  // Job-alert emails (as they happen, and daily or weekly) sent to this person in the last day.
  const alertEmailsToday = (rk) => {
    const since = new Date(Date.now() - DAY).toISOString();
    return db.where('notification-deliveries', 'rk', rk).filter((d) => (d.type === 'job-alert' || d.type === 'job-digest') && d.createdAt >= since).length;
  };
  function jobAlerts(job, subs) {
    const byPerson = new Map();
    for (const s of subs) if (!byPerson.has(s.email)) byPerson.set(s.email, s);
    for (const [email, sub] of byPerson) {
      const rk = notify.candidateRk(email);
      const today = alertEmailsToday(rk);
      const account = hasAccount(email);
      emit({
        key: `job-alert:${job.id}`, type: 'job-alert', to: [{ kind: 'candidate', email, inApp: account, mail: today < JOB_ALERTS_PER_DAY }],
        inApp: { title: `New job: ${job.title}`, body: `${job.company} · ${job.location}`, link: jobPath(job) },
        email: { template: 'job-alert', refs: { alertId: sub.id, jobId: job.id } },
      });
    }
    return byPerson.size;
  }
  // A saved search's daily or weekly email. Jobs the person already heard
  // about as they were posted (another of their searches) aren't repeated.
  // `v` is the saved search as shown to them (name, link, frequency).
  function jobDigest(sub, jobs, v) {
    const email = sub.email;
    const rk = notify.candidateRk(email);
    const told = new Set([
      ...db.where('notification-deliveries', 'rk', rk).filter((d) => d.type === 'job-alert').map((d) => d.event),
      ...db.where('notifications', 'rk', rk).filter((n) => n.type === 'job-alert').map((n) => n.event),
    ]);
    const fresh = jobs.filter((j) => !told.has(`job-alert:${j.id}`));
    if (!fresh.length) return false;
    const n = fresh.length;
    emit({
      key: `job-digest:${sub.id}:${sub.lastDigestAt}`, type: 'job-digest',
      to: [{ kind: 'candidate', email, inApp: hasAccount(email), mail: alertEmailsToday(rk) < JOB_ALERTS_PER_DAY }],
      inApp: { title: `${n} new ${n === 1 ? 'job' : 'jobs'} for “${v.name}”`, body: fresh.slice(0, 3).map((j) => j.title).join(', '), link: v.href },
      email: { template: 'job-digest', refs: { alertId: sub.id, jobIds: fresh.map((j) => j.id), frequency: v.frequency } },
    });
    return true;
  }
  // A verified employer invites a candidate who agreed to be found. Once per
  // candidate and job, however often the button is pressed.
  function jobInvite(c, job) {
    return emit({
      key: `job-invite:${job.id}:${c.id}`, type: 'job-invite', to: [{ kind: 'candidate', email: c.email }],
      inApp: { title: `${job.company} invites you to apply: ${job.title}`, body: `${job.location} · ${job.type}. They see your details only if you apply.`, link: jobPath(job) },
      email: { template: 'job-invite', refs: { candidateId: c.id, jobId: job.id } },
    });
  }
  // A verified employer unlocked a candidate's mobile number (contact-credits.js).
  // Once per company and candidate, in the app.
  function contactUnlocked(c, emp) {
    return emit({
      key: `contact-unlocked:${emp.id}:${c.id}`, type: 'contact-unlocked', to: [{ kind: 'candidate', email: c.email }],
      inApp: { title: `${emp.company} can now see your mobile number`, body: 'They may call or WhatsApp you about a job. Nobody genuine asks you to pay. You can stop showing your number in Settings.', link: '/account/settings#privacy' },
    });
  }
  // An employer opened an application for the first time. Once per
  // application, in the app; never after the person withdrew.
  function applicationViewed(a, job) {
    if (!a || a.withdrawnAt || !job) return null;
    return emit({
      key: `application-viewed:${a.id}`, type: 'application-viewed', to: [candidate(a)],
      inApp: { title: `${job.company} opened your application`, body: `For ${job.title}. They decide the next step; we will tell you when your application moves.`, link: '/account#applications' },
    });
  }
  function messageToCandidate(a, job, m) {
    if (!a || a.withdrawnAt) return null;
    return emit({
      key: `message:${m.id}`, type: 'message-received', to: [candidate(a)],
      inApp: { title: `Message from ${job ? job.company : 'the employer'}`, body: `About ${a.jobTitle}. Read it and reply in your account.`, link: `/account/messages/${a.id}` },
      email: { template: 'notice', refs: { kind: 'message-to-candidate', applicationId: a.id } },
    });
  }
  // A reply goes to the people who started the conversation, or else to
  // everyone who may contact applicants on the job.
  function messageToHiring(a, job, m) {
    if (!a || !job) return null;
    const writers = [...new Set(messagesOf(a).filter((x) => x.from === 'employer' && x.userId).map((x) => x.userId))];
    const people = jobPeople(job, 'applicants.contact');
    const to = writers.length ? people.filter((p) => writers.includes(p.userId)) : people;
    return emit({
      key: `reply:${m.id}`, type: 'candidate-replied', to: to.length ? to : people,
      inApp: { title: `${first(a.name)} replied about ${job.title}`, body: 'Open the application to read it.', link: `/employer/applicants/${a.id}#messages`, jobId: job.id },
      email: { template: 'notice', refs: { kind: 'message-to-hiring', applicationId: a.id } },
    });
  }
  // A staffing request (public form or client portal): everyone on the team sees it.
  function staffingRequest(entry) {
    emit({ key: `staffing-request:${entry.id}`, type: 'staffing-request', to: team.members().map((u) => ({ kind: 'team', userId: u.id })), inApp: { title: `Staffing request from ${entry.company}`, body: `${entry.roles}${entry.headcount ? ` · ${entry.headcount} people` : ''}${entry.location ? ` · ${entry.location}` : ''}`, link: '/admin?tab=hire-requests' } });
  }

  // A team member was made the owner of an employer enquiry.
  function hireRequestAssigned(entry, userId) {
    emit({ key: `hire-request-assigned:${entry.id}:${userId}`, type: 'hire-request-assigned', to: [team.byId(userId) ? { kind: 'team', userId } : null], inApp: { title: `Employer enquiry assigned to you: ${entry.company}`, body: `${entry.roles}. Please call them within one working day.`, link: '/admin?tab=hire-requests' } });
  }

  // A recruiter was given a requisition (in-app only; no candidate details).
  function agencyAssigned(r, userId, client) {
    emit({ key: `requisition-assigned:${r.id}:${userId}`, type: 'requisition-assigned', to: [team.byId(userId) ? { kind: 'team', userId } : null], inApp: { title: `Requisition assigned to you: ${r.number}`, body: `${r.openings} × ${r.title}${client ? ` for ${client.company}` : ''}`, link: `/admin/requisitions/${r.id}` } });
  }

  // An employer enquiry still New after a working day: one reminder to its
  // owner, or to the admins (the team inbox when there are none).
  function hireOverdueScan(isOverdue) {
    let n = 0;
    for (const h of readSubmissions('hire-requests')) {
      if (!isOverdue(h)) continue;
      const owner = h.ownerId && team.byId(h.ownerId);
      const admins = team.members().filter((u) => u.active !== false && u.role === 'Admin');
      const to = owner && owner.active !== false ? [{ kind: 'team', userId: owner.id }] : admins.length ? admins.map((u) => ({ kind: 'team', userId: u.id })) : [{ kind: 'inbox' }];
      const r = emit({
        key: `hire-request-overdue:${h.id}`, type: 'hire-request-overdue', to,
        inApp: to[0].kind === 'inbox' ? undefined : { title: `Not yet contacted: ${h.company}`, body: `Enquiry from ${h.name} is over a working day old. Please call them today.`, link: '/admin?tab=hire-requests' },
        email: { template: 'notice', refs: { kind: 'hire-request-overdue', hireRequestId: h.id } },
      });
      n += r.notifications + r.deliveries ? 1 : 0;
    }
    return n;
  }

  // Monday from 9 am IST: one summary of the week's enquiries to the admins
  // (the team inbox when there are none). Skipped when there is nothing to say.
  function leadSummaryScan(isOverdue, nowMs = Date.now()) {
    const ist = new Date(nowMs + IST);
    if (ist.getUTCDay() !== 1 || ist.getUTCHours() < 9) return 0;
    const s = leadSummary(isOverdue, nowMs);
    if (!s.received && !s.open) return 0;
    const admins = team.members().filter((u) => u.active !== false && u.role === 'Admin');
    const to = admins.length ? admins.map((u) => ({ kind: 'team', userId: u.id })) : [{ kind: 'inbox' }];
    const r = emit({
      key: `lead-summary:${ist.toISOString().slice(0, 10)}`, type: 'lead-summary', to,
      inApp: admins.length ? { title: `This week: ${s.received} new employer enquir${s.received === 1 ? 'y' : 'ies'}`, body: `${s.open} open${s.waiting ? `, ${s.waiting} waiting for a call` : ''}. The full summary is in your email.`, link: '/admin?tab=hire-requests' } : undefined,
      email: { template: 'notice', refs: { kind: 'lead-summary', endMs: nowMs, overdue: s.waiting } },
    });
    return r.notifications + r.deliveries ? 1 : 0;
  }
  // Monday from 9 am IST: everyone who turned on the weekly analytics email.
  function analyticsWeeklyScan(nowMs = Date.now()) {
    const ist = new Date(nowMs + IST);
    if (ist.getUTCDay() !== 1 || ist.getUTCHours() < 9 || !deps.analyticsWeekly) return 0;
    const day = ist.toISOString().slice(0, 10);
    let sent = 0;
    for (const s of readSubmissions('analytics-reports')) {
      const to = s.as === 'team' ? { kind: 'team', userId: s.userId, inApp: false } : { kind: 'employer', userId: s.userId, employerId: s.employerId, inApp: false };
      if (!weeklyOf(to, nowMs)) continue;
      const r = emit({ key: `analytics-weekly:${s.id}:${day}`, type: 'analytics-weekly', to: [to], email: { template: 'notice', refs: { kind: 'analytics-weekly', endMs: nowMs } } });
      sent += r.deliveries ? 1 : 0;
    }
    return sent;
  }
  function analyticsWeeklyNow(to, nowMs = Date.now()) {
    if (!person(to) || !weeklyOf(to, nowMs)) return 0;
    return emit({ key: `analytics-weekly-now:${to.userId}:${to.employerId || ''}:${nowMs}`, type: 'analytics-weekly', to: [{ ...to, inApp: false }], email: { template: 'notice', refs: { kind: 'analytics-weekly', endMs: nowMs } } }).deliveries;
  }
  // The same summary, now, to one team member who asked for it in admin.
  function leadSummaryNow(userId, isOverdue, nowMs = Date.now()) {
    const u = team.byId(userId);
    if (!u || !EMAIL_RE.test(u.email || '')) return 0;
    const s = leadSummary(isOverdue, nowMs);
    const r = emit({ key: `lead-summary-now:${userId}:${nowMs}`, type: 'lead-summary', to: [{ kind: 'team', userId, inApp: false }], email: { template: 'notice', refs: { kind: 'lead-summary', endMs: nowMs, overdue: s.waiting } } });
    return r.deliveries;
  }

  // ---------- account ----------
  function accountSecurity(email, title, body) {
    emit({ key: `security:${notify.candidateRk(email)}:${Date.now()}`, type: 'account-security', to: [{ kind: 'candidate', email }], inApp: { title, body, link: '/account/settings' } });
  }

  // ---------- scheduled checks ----------
  function scan(todayIst) {
    try {
      feedbackDueScan();
      offerDeadlineScan(todayIst());
    } catch (e) {
      console.error('Notification checks failed:', e.message);
    }
  }

  return {
    applicationSubmitted, newApplication, stageMoved, statusEmail, interviewBooked, interviewOptionsOffered, interviewRescheduled, interviewCancelled, interviewReminder, interviewAnswered,
    feedbackDueScan, offerCreated, offerApproved, offerAnswered, offerAnsweredByCandidate, offerDeadlineScan, assigned, jobDecision, jobExpired, jobClosingSoonScan, jobSubmitted, jobAlerts, jobDigest, jobInvite, contactUnlocked, applicationViewed, staffingRequest, hireRequestAssigned, hireOverdueScan, leadSummaryScan, leadSummaryNow, analyticsWeeklyScan, analyticsWeeklyNow, exportRequested, exportDecided, agencyAssigned,
    accountSecurity, scan, JOB_ALERTS_PER_DAY, messageToCandidate, messageToHiring,
  };
}

module.exports = { create, JOB_ALERTS_PER_DAY };
