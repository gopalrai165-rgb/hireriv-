// Interview scheduling: book, list and cancel interviews on applications.
// Interviews live on the application record (application.interviews[]).
const crypto = require('crypto');
const { interviewIcs, istToDate, formatIst } = require('./ics');
const { moveStage } = require('./history');

const MODES = ['Video call', 'Phone', 'In person'];
const DURATIONS = [30, 45, 60, 90];
// Interview scorecards: an overall rating and a recommendation, plus notes.
const RECOMMENDATIONS = ['Strong hire', 'Hire', 'No hire', 'Strong no hire'];
const FEEDBACK_DAYS = 14; // interviewer links work until this long after the interview
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const endOf = (iv) => new Date(iv.at).getTime() + iv.duration * 60000;

// Average rating and the most common recommendation across an interview's scorecards.
function feedbackSummary(iv) {
  const fb = iv.feedback || [];
  if (!fb.length) return null;
  const avg = Math.round((fb.reduce((n, f) => n + f.rating, 0) / fb.length) * 10) / 10;
  const counts = {};
  for (const f of fb) counts[f.recommendation] = (counts[f.recommendation] || 0) + 1;
  // Most common verdict; a tie goes to the most recent scorecard, not the most positive.
  const best = Math.max(...Object.values(counts));
  const tied = RECOMMENDATIONS.filter((r) => counts[r] === best);
  const latest = fb.slice().sort((x, y) => y.at.localeCompare(x.at)).find((x) => tied.includes(x.recommendation));
  const top = latest ? latest.recommendation : tied[0];
  return { count: fb.length, avg, recommendation: top };
}

// Interviews that have happened (in the last 30 days) with no scorecard yet.
function feedbackDue(applications) {
  const now = Date.now();
  return allInterviews(applications)
    .filter((iv) => iv.status === 'scheduled' && endOf(iv) + 3600000 < now && endOf(iv) > now - 30 * 86400000 && !(iv.feedback || []).length)
    .sort((a, b) => b.at.localeCompare(a.at));
}

// Every interview across all applications, joined with its candidate.
function allInterviews(applications) {
  const list = [];
  for (const a of applications) for (const iv of a.interviews || []) list.push({ ...iv, app: a });
  return list;
}

// Reminders go out about a day and about an hour before. Each is skipped when
// the interview was booked too close to it, so it never lands right after the
// booking email.
const REMINDERS = [
  { kind: 'day', label: '1 day before', from: 24 * 3600000, to: 2 * 3600000, minLead: 26 * 3600000 },
  { kind: 'hour', label: '1 hour before', from: 75 * 60000, to: 0, minLead: 3 * 3600000 },
];

function remindersDue(applications, now = Date.now()) {
  const due = [];
  for (const a of applications) {
    if (a.withdrawnAt) continue;
    for (const iv of a.interviews || []) {
      if (iv.status !== 'scheduled') continue;
      const start = Date.parse(iv.at);
      const left = start - now;
      const lead = start - Date.parse(iv.createdAt);
      for (const r of REMINDERS) {
        if ((iv.reminders || {})[r.kind]) continue;
        if (left <= r.from && left > r.to && lead >= r.minLead) due.push({ a, iv, kind: r.kind });
      }
    }
  }
  return due;
}

function upcoming(applications, limit = Infinity) {
  const now = Date.now();
  return allInterviews(applications)
    .filter((iv) => iv.status === 'scheduled' && new Date(iv.at).getTime() + iv.duration * 60000 > now)
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(0, limit);
}

function parseInterview(body, candidate) {
  const get = (k, max = 300) => String(body[k] ?? '').trim().slice(0, max);
  const f = { date: get('date', 10), time: get('time', 5), duration: Number(get('duration', 3)), mode: get('mode', 20), where: get('where'), interviewer: get('interviewer', 120), interviewerEmail: get('interviewerEmail', 160).toLowerCase(), message: get('message', 1000) };
  const errors = [];
  if (f.interviewerEmail && !EMAIL_RE.test(f.interviewerEmail)) errors.push("interviewer's email is invalid");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date) || !/^\d{2}:\d{2}$/.test(f.time)) errors.push('pick a date and time');
  const at = istToDate(f.date, f.time);
  if (Number.isNaN(at.getTime())) errors.push('date or time is invalid');
  else if (at.getTime() < Date.now() - 5 * 60000) errors.push('the interview time is in the past');
  if (!DURATIONS.includes(f.duration)) errors.push('duration is invalid');
  if (!MODES.includes(f.mode)) errors.push('format is invalid');
  if (f.mode === 'Video call' && !/^https:\/\/[^\s"'<>]+$/i.test(f.where)) errors.push('add the video meeting link (starting with https://)');
  if (f.mode === 'In person' && !f.where) errors.push('add the interview address');
  if (f.mode === 'Phone' && !f.where) f.where = candidate.phone || '';
  return { f, at, errors };
}

function register(app, { adminAuth, sameOrigin, readSubmissions, writeSubmissions, mailer, site, adminUrl, baseUrl, limit }) {
  const icsFor = (method, iv, a) => interviewIcs({ method, interview: iv, candidate: a, jobTitle: a.jobTitle, site });

  // ---------- reminders ----------
  function sendReminders() {
    const list = readSubmissions('applications');
    const due = remindersDue(list);
    if (!due.length) return 0;
    for (const { a, iv, kind } of due) {
      iv.reminders = { ...(iv.reminders || {}), [kind]: new Date().toISOString() };
      const when = formatIst(new Date(iv.at));
      mailer.interviewReminder(a, iv, when, kind);
      if (iv.interviewerEmail) mailer.interviewerReminder(iv.interviewerEmail, a, iv, when, kind);
    }
    writeSubmissions('applications', list);
    return due.length;
  }
  sendReminders();
  setInterval(sendReminders, 5 * 60000).unref();

  // Books an interview on application `a` (part of `list`), saves, and emails
  // the candidate and the interviewer. Used by the team and by employers.
  function book(list, a, f, at, by) {
    const iv = {
      id: crypto.randomUUID(),
      at: at.toISOString(),
      duration: f.duration,
      mode: f.mode,
      where: f.where,
      interviewer: f.interviewer,
      interviewerEmail: f.interviewerEmail,
      message: f.message,
      status: 'scheduled',
      sequence: 0,
      createdAt: new Date().toISOString(),
      feedback: [],
    };
    // The interviewer (often at the client) gets a private link for their scorecard;
    // only its hash is stored, and it stops working two weeks after the interview.
    let feedbackUrl = '';
    if (f.interviewerEmail) {
      const token = crypto.randomBytes(32).toString('hex');
      iv.feedbackLink = { hash: sha(token), exp: endOf(iv) + FEEDBACK_DAYS * 86400000 };
      feedbackUrl = `${baseUrl}/feedback/${token}`;
    }
    a.interviews = [...(a.interviews || []), iv];
    // Booking an interview moves early-stage candidates forward automatically.
    if (['New', 'Screening', undefined, ''].includes(a.status)) moveStage(a, 'Interview', by, iv.createdAt);
    a.updatedAt = iv.createdAt;
    writeSubmissions('applications', list);
    mailer.interviewScheduled(a, iv, icsFor('REQUEST', iv, a), formatIst(at));
    if (feedbackUrl) mailer.interviewerBriefing(f.interviewerEmail, a, iv, formatIst(at), feedbackUrl);
    return { iv, feedbackUrl };
  }

  const formPage = (res, a, f, errors, status = 200) =>
    res.status(status).render('admin-interview', { title: 'Schedule interview', page: 'admin', a, f, errors, modes: MODES, durations: DURATIONS, noindex: true });

  app.get('/admin/applications/:id/interview', adminAuth, (req, res, next) => {
    const a = readSubmissions('applications').find((x) => x.id === req.params.id);
    if (!a) return next();
    // Default: tomorrow at 11:00 India time.
    const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    formPage(res, a, { date: tomorrow, time: '11:00', duration: 45, mode: 'Video call', where: '', interviewer: '', interviewerEmail: '', message: '' }, []);
  });

  app.post('/admin/applications/:id/interview', adminAuth, sameOrigin, (req, res, next) => {
    const list = readSubmissions('applications');
    const a = list.find((x) => x.id === req.params.id);
    if (!a) return next();
    const { f, at, errors } = parseInterview(req.body, a);
    if (errors.length) return formPage(res, a, f, errors, 400);

    const { feedbackUrl } = book(list, a, f, at, `${req.admin.name} (interview booked)`);
    res.redirect(adminUrl('interviews', `Interview booked with ${a.name} for ${formatIst(at)} · ${a.email ? 'invite emailed' : 'no email on file, so tell them by phone or WhatsApp'}${feedbackUrl ? ` · feedback link sent to ${f.interviewerEmail}` : ''}`));
  });

  // ---------- scorecards ----------
  function parseScorecard(body) {
    const get = (k, max) => String(body[k] ?? '').trim().slice(0, max);
    const fb = { rating: Number(get('rating', 1)), recommendation: get('recommendation', 20), strengths: get('strengths', 2000), concerns: get('concerns', 2000) };
    const errors = [];
    if (![1, 2, 3, 4, 5].includes(fb.rating)) errors.push('choose an overall rating from 1 to 5');
    if (!RECOMMENDATIONS.includes(fb.recommendation)) errors.push('choose a recommendation');
    return { fb, errors };
  }
  const scorecardPage = (res, locals, status = 200) =>
    res.status(status).render('interview-feedback', { noindex: true, errors: [], recommendations: RECOMMENDATIONS, formatIst, ...locals });

  // One scorecard per person: submitting again replaces your own.
  function saveScorecard(iv, fb, by, byType) {
    const entry = { id: crypto.randomUUID(), ...fb, by, byType, at: new Date().toISOString() };
    iv.feedback = [...(iv.feedback || []).filter((x) => x.by !== by), entry];
    return entry;
  }

  const findIv = (list, appId, ivId) => {
    const a = list.find((x) => x.id === appId);
    const iv = a && (a.interviews || []).find((x) => x.id === ivId);
    return { a, iv };
  };

  app.get('/admin/interviews/:appId/:ivId/feedback', adminAuth, (req, res, next) => {
    const { a, iv } = findIv(readSubmissions('applications'), req.params.appId, req.params.ivId);
    if (!iv) return next();
    const mine = (iv.feedback || []).find((x) => x.by === req.admin.name) || {};
    scorecardPage(res, { title: 'Interview feedback', page: 'admin', a, iv, external: false, f: mine, action: `/admin/interviews/${a.id}/${iv.id}/feedback`, others: (iv.feedback || []) });
  });

  app.post('/admin/interviews/:appId/:ivId/feedback', adminAuth, sameOrigin, (req, res, next) => {
    const list = readSubmissions('applications');
    const { a, iv } = findIv(list, req.params.appId, req.params.ivId);
    if (!iv) return next();
    const { fb, errors } = parseScorecard(req.body);
    if (errors.length) return scorecardPage(res, { title: 'Interview feedback', page: 'admin', a, iv, external: false, f: fb, action: req.originalUrl, others: iv.feedback || [], errors }, 400);
    saveScorecard(iv, fb, req.admin.name, 'team');
    writeSubmissions('applications', list);
    res.redirect(adminUrl('interviews', `Feedback saved for ${a.name}: ${fb.recommendation}, ${fb.rating}/5`));
  });

  // ---------- interviewer link (no login) ----------
  function byToken(token) {
    const list = readSubmissions('applications');
    if (!/^[a-f0-9]{64}$/.test(token)) return { list };
    const hash = sha(token);
    for (const a of list) for (const iv of a.interviews || []) if (iv.feedbackLink && iv.feedbackLink.hash === hash) return { list, a, iv };
    return { list };
  }
  const linkDead = (iv) => !iv || iv.status !== 'scheduled' || iv.feedbackLink.exp < Date.now();
  const expired = (res) => res.status(410).render('thanks', { title: 'Link expired', page: '', ok: false, message: 'This feedback link has expired or the interview was cancelled. Please reply to the interview email with your feedback instead.', noindex: true });
  // The interviewer sees only the candidate's name, the role and the interview time.
  const publicView = (a) => ({ name: a.name, jobTitle: a.jobTitle });

  app.get('/feedback/:token', (req, res) => {
    const { a, iv } = byToken(req.params.token);
    if (linkDead(iv)) return expired(res);
    const mine = (iv.feedback || []).find((x) => x.byType === 'interviewer') || {};
    scorecardPage(res, { title: 'Interview feedback', page: '', a: publicView(a), iv, external: true, f: mine, action: req.originalUrl, others: [], early: Date.now() < new Date(iv.at).getTime() });
  });

  app.post('/feedback/:token', limit('interview-feedback', 20), sameOrigin, (req, res) => {
    const { list, a, iv } = byToken(req.params.token);
    if (linkDead(iv)) return expired(res);
    const { fb, errors } = parseScorecard(req.body);
    if (errors.length) return scorecardPage(res, { title: 'Interview feedback', page: '', a: publicView(a), iv, external: true, f: fb, action: req.originalUrl, others: [], errors }, 400);
    const by = iv.interviewer || iv.interviewerEmail;
    saveScorecard(iv, fb, by, 'interviewer');
    writeSubmissions('applications', list);
    mailer.interviewFeedbackReceived(a, iv, fb, by, `${baseUrl}/admin?tab=interviews`);
    res.render('thanks', { title: 'Thank you', page: '', ok: true, message: `Thanks! Your feedback on ${a.name} has been sent to the recruitment team. You can use the same link to update it for the next ${FEEDBACK_DAYS} days.`, noindex: true });
  });

  app.post('/admin/interviews/:appId/:ivId/cancel', adminAuth, sameOrigin, (req, res, next) => {
    const list = readSubmissions('applications');
    const a = list.find((x) => x.id === req.params.appId);
    const iv = a && (a.interviews || []).find((x) => x.id === req.params.ivId);
    if (!iv) return next();
    if (iv.status === 'scheduled') {
      iv.status = 'cancelled';
      iv.sequence = (iv.sequence || 0) + 1;
      iv.cancelledAt = new Date().toISOString();
      writeSubmissions('applications', list);
      mailer.interviewCancelled(a, iv, icsFor('CANCEL', iv, a), formatIst(iv.at));
    }
    res.redirect(adminUrl('interviews', `Cancelled the interview with ${a.name} · candidate notified`));
  });

  // Download the invite (e.g. to forward to the interviewer's calendar).
  app.get('/admin/interviews/:appId/:ivId.ics', adminAuth, (req, res, next) => {
    const a = readSubmissions('applications').find((x) => x.id === req.params.appId);
    const iv = a && (a.interviews || []).find((x) => x.id === req.params.ivId);
    if (!iv) return next();
    res.type('text/calendar').attachment(`interview-${a.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.ics`).send(icsFor(iv.status === 'cancelled' ? 'CANCEL' : 'REQUEST', iv, a));
  });

  return { book };
}

module.exports = { register, parseInterview, MODES, DURATIONS, allInterviews, upcoming, formatIst, feedbackSummary, feedbackDue, remindersDue, REMINDERS, RECOMMENDATIONS };
