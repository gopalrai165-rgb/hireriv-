// The employer's applicant tracking: the pipeline (board and table), internal
// notes, who is responsible for each applicant, interview scorecards and
// cancellations, offers (approved separately from being made, with the
// candidate's answer recorded apart), and hiring metrics. Pages under
// /employer/ats and /employer/applicants/:id/…, JSON under /api/ats.
//
// Builds on employer-hiring.js: the same applicants (jobs the company posted
// itself), the same role checks (employer-team.js can()) and the same history.
// Rules live in ats.js.
const ats = require('./ats');
const { can } = require('./employer-team');
const { parseScorecard, RECOMMENDATIONS } = require('./interviews');

function register(app, deps) {
  const { site, mailer, baseUrl, limit, sameOrigin, clients, hiring, readSubmissions, writeSubmissions, getJobs, interviewDesk, moveStage, formatIst, todayIst } = deps;
  const { requireEmployer, requireEmployerApi, team, addressed } = clients;
  const { ledger, applicantView, applicationsFor, withApplicant, withJob, changeStatus, bookInterview, actorOf } = hiring;
  const page = (res, view, locals, status = 200) => res.status(status).render(view, { page: 'employer', noindex: true, errors: [], msg: '', ...locals });
  const fail = (res, status, errors) => res.status(status).json({ ok: false, errors: [].concat(errors) });
  const toApplicant = (res, a, msg) => res.redirect(`/employer/applicants/${a.id}?msg=${encodeURIComponent(msg)}`);
  const save = (req) => writeSubmissions('applications', req.applications);

  // People in the company who can work on `job` (for assigning applicants).
  const workersFor = (employerId, job) => team.membersOf(employerId).filter((m) => can(m, 'applicants.manage', job))
    .map((m) => ({ ...m, name: (team.userById(m.userId) || {}).name || 'Unknown' }));

  // ---------- filters: skills, experience, location, stage, job, assigned ----------
  function filtersOf(q) {
    const str = (k, max = 80) => String(q[k] ?? '').trim().slice(0, max);
    return { job: str('job'), stage: [...ats.STAGES, 'Withdrawn'].includes(q.stage) ? q.stage : '', skills: str('skills').toLowerCase(), experience: str('experience', 40).toLowerCase(), location: str('location').toLowerCase(), mine: q.mine === '1' };
  }
  function filtered(req, f) {
    const { jobs, apps } = applicationsFor(req);
    const want = f.skills.split(',').map((s) => s.trim()).filter(Boolean);
    const rows = apps
      .filter((a) => (!f.job || a.jobId === f.job))
      .filter((a) => !f.stage || ats.stageOf(a) === f.stage)
      .filter((a) => !want.length || want.every((w) => String(a.skills || '').toLowerCase().includes(w) || (a.resumeSkills || []).some((s) => s.toLowerCase().includes(w))))
      .filter((a) => !f.experience || String(a.experience || '').toLowerCase().includes(f.experience))
      .filter((a) => !f.location || String(a.location || '').toLowerCase().includes(f.location))
      .filter((a) => !f.mine || a.assignedTo === req.employerUser.id)
      .map((a) => applicantView(req, a, jobs.get(a.jobId)))
      .sort((x, y) => String(y.appliedAt).localeCompare(String(x.appliedAt)));
    return { jobs, rows };
  }

  // Metrics for the jobs this member may see. Workload only for owners and managers.
  function metricsFor(req, days) {
    const { jobs } = applicationsFor(req);
    const since = days ? new Date(Date.now() - days * 86400000).toISOString() : null;
    const showWorkload = can(req.member, 'workload.view');
    const members = showWorkload ? team.membersOf(req.employer.id).map((m) => ({ ...m, name: (team.userById(m.userId) || {}).name || 'Unknown' })) : [];
    return ats.metrics(readSubmissions('applications'), [...jobs.values()], { since, members });
  }
  const daysOf = (q) => ([30, 90, 365].includes(Number(q.days)) ? Number(q.days) : 0);

  // ---------- pages ----------
  app.get('/employer/ats', requireEmployer, (req, res) => {
    const f = filtersOf(req.query);
    const { jobs, rows } = filtered(req, f);
    const view = req.query.view === 'table' ? 'table' : 'board';
    page(res, 'employer-ats', {
      title: 'Hiring pipeline', tab: 'ats', view, f, rows, jobs: [...jobs.values()], m: metricsFor(req, 0),
      columns: [...ats.PIPELINE, 'On hold'], stages: ats.STAGES, label: ats.label, msg: String(req.query.msg || ''),
      query: (patch) => new URLSearchParams(Object.entries({ ...req.query, ...patch }).filter(([k, v]) => v && k !== 'msg')).toString(),
    });
  });

  app.get('/employer/ats/reports', requireEmployer, (req, res) => {
    const days = daysOf(req.query);
    page(res, 'employer-ats-reports', { title: 'Hiring reports', tab: 'ats', m: metricsFor(req, days), days, showWorkload: can(req.member, 'workload.view') });
  });

  // ---------- notes ----------
  function addNote(req) {
    const r = ats.addNote(req.application, req.employerUser, (req.body || {}).text);
    if (r.error) return r;
    save(req);
    // The note itself stays out of the activity log.
    team.audit(req.employer.id, req.employerUser, 'note-added', `${req.application.name} (${req.job.title})`);
    return r;
  }
  app.post('/employer/applicants/:id/notes', requireEmployer, withApplicant('applicants.notes'), limit('ats-notes', 60), sameOrigin, (req, res) => {
    const r = addNote(req);
    toApplicant(res, req.application, r.error ? `Not saved: ${r.error}.` : 'Note added.');
  });

  // ---------- assigning a recruiter ----------
  function assign(req, userId) {
    const a = req.application;
    if (!userId) {
      if (!a.assignedTo) return { changed: false };
      delete a.assignedTo;
    } else {
      const worker = workersFor(req.employer.id, req.job).find((m) => m.userId === userId);
      if (!worker) return { status: 400, error: 'choose someone who works on this job' };
      if (a.assignedTo === userId) return { changed: false };
      a.assignedTo = userId;
    }
    save(req);
    const who = userId ? team.userById(userId) : null;
    team.audit(req.employer.id, req.employerUser, 'applicant-assigned', `${a.name} (${req.job.title}) → ${who ? who.name : 'nobody'}`);
    return { changed: true };
  }
  app.post('/employer/applicants/:id/assign', requireEmployer, withApplicant('applicants.assign'), limit('ats-assign', 60), sameOrigin, (req, res) => {
    const r = assign(req, String(req.body.userId || ''));
    toApplicant(res, req.application, r.error ? `Not changed: ${r.error}.` : r.changed ? 'Assignment saved.' : 'No change.');
  });

  // ---------- interviews: cancel, scorecards ----------
  const findInterview = (req, ivId) => (req.application.interviews || []).find((iv) => iv.id === ivId) || null;
  function cancelInterview(req, iv) {
    if (iv.status !== 'scheduled') return { error: 'this interview is not scheduled' };
    const delivered = interviewDesk.cancel(req.applications, req.application, iv);
    ledger.once(`interview-cancelled:${iv.id}`, { audience: 'candidate', template: 'interview-cancelled', employerId: req.employer.id, applicationId: req.application.id }, () => delivered);
    team.audit(req.employer.id, req.employerUser, 'interview-cancelled', `${req.application.name} on ${formatIst(iv.at)} (${req.job.title})`);
    return {};
  }
  app.post('/employer/applicants/:id/interviews/:ivId/cancel', requireEmployer, withApplicant('interviews.manage'), limit('employer-interviews', 30), sameOrigin, (req, res, next) => {
    const iv = findInterview(req, req.params.ivId);
    if (!iv) return next();
    const r = cancelInterview(req, iv);
    toApplicant(res, req.application, r.error ? `Not cancelled: ${r.error}.` : 'Interview cancelled. The candidate was sent a calendar cancellation.');
  });

  function submitFeedback(req, iv, body) {
    if (iv.status !== 'scheduled') return { status: 409, errors: ['feedback is for interviews that took place'] };
    if (Date.parse(iv.at) > Date.now()) return { status: 409, errors: ['add feedback after the interview has started'] };
    const { fb, errors } = parseScorecard(body);
    if (errors.length) return { status: 400, errors };
    const entry = interviewDesk.saveScorecard(iv, fb, req.employerUser.name, 'employer');
    entry.userId = req.employerUser.id;
    save(req);
    team.audit(req.employer.id, req.employerUser, 'feedback-submitted', `${req.application.name} (${req.job.title})`);
    return { entry, errors: [] };
  }
  app.post('/employer/applicants/:id/interviews/:ivId/feedback', requireEmployer, withApplicant('feedback.submit'), limit('ats-feedback', 30), sameOrigin, (req, res, next) => {
    const iv = findInterview(req, req.params.ivId);
    if (!iv) return next();
    const r = submitFeedback(req, iv, req.body);
    toApplicant(res, req.application, r.errors.length ? `Not saved: ${r.errors.join(', ')}.` : 'Feedback saved.');
  });

  // ---------- offers ----------
  function makeOffer(req, body) {
    const { offer: fields, errors } = ats.parseOffer(body, todayIst());
    if (errors.length) return { status: 400, errors };
    const r = ats.createOffer(req.application, { ...fields, title: fields.title || req.job.title }, req.employerUser);
    if (r.error) return { status: 409, errors: [r.error] };
    save(req);
    team.audit(req.employer.id, req.employerUser, 'offer-created', `${req.application.name} (${req.job.title})`);
    return { offer: r.offer, errors: [] };
  }
  // approve / reject (needs offers.approve), accepted / declined (offers.respond), withdraw (offers.create).
  const OFFER_ACTIONS = { approve: 'offers.approve', reject: 'offers.approve', accepted: 'offers.respond', declined: 'offers.respond', withdraw: 'offers.create' };
  function offerAction(req, o, action, note) {
    const a = req.application;
    let problem;
    if (action === 'approve' || action === 'reject') problem = ats.decideOffer(o, req.employerUser, req.member.role === 'owner', action === 'approve', note);
    else if (action === 'withdraw') problem = ats.withdrawOffer(o, req.employerUser);
    else problem = ats.recordResponse(o, req.employerUser, action, note);
    if (problem) return { status: 409, error: problem };
    // An approved offer moves the application to Offer and tells the candidate.
    if (action === 'approve' && a.status !== 'Offered' && !ats.moveProblem(a, 'Offered')) ats.recordMove(moveStage, a, 'Offered', actorOf(req));
    save(req);
    if (action === 'approve') ledger.once(`offer-made:${o.id}`, { audience: 'candidate', template: 'offer-made', employerId: req.employer.id, applicationId: a.id }, () => mailer.offerMade(a, req.employer.company, o));
    team.audit(req.employer.id, req.employerUser, `offer-${{ approve: 'approved', reject: 'rejected', withdraw: 'withdrawn', accepted: 'accepted', declined: 'declined' }[action]}`, `${a.name} (${req.job.title})`);
    return {};
  }
  app.post('/employer/applicants/:id/offers', requireEmployer, withApplicant('offers.create'), limit('ats-offers', 30), sameOrigin, (req, res) => {
    const r = makeOffer(req, req.body);
    toApplicant(res, req.application, r.errors.length ? `Offer not saved: ${r.errors.join(', ')}.` : 'Offer saved. It goes to the candidate once approved.');
  });
  app.post('/employer/applicants/:id/offers/:offerId/:action', requireEmployer, (req, res, next) => {
    const need = OFFER_ACTIONS[req.params.action];
    if (!need) return next('route');
    withApplicant(need)(req, res, next);
  }, limit('ats-offers', 30), sameOrigin, (req, res, next) => {
    const o = ats.findOffer(req.application, req.params.offerId);
    if (!o) return next();
    const r = offerAction(req, o, req.params.action, req.body.note);
    const done = { approve: 'Offer approved. The candidate was told.', reject: 'Offer not approved.', withdraw: 'Offer withdrawn.', accepted: 'Recorded: the candidate accepted. You can now mark them Hired.', declined: 'Recorded: the candidate declined.' }[req.params.action];
    toApplicant(res, req.application, r.error ? `Not changed: ${r.error}.` : done);
  });

  // ---------- the candidate answered an interview invite (from candidates.js) ----------
  function interviewResponded(a, iv, confirmed, note) {
    const job = getJobs().find((j) => j.id === a.jobId);
    const when = formatIst(iv.at);
    const key = `interview-answer:${iv.id}:${iv.confirmation}:${iv.answeredAt}`;
    if (job && hiring.selfManaged(job)) {
      const emp = clients.read().find((e) => e.id === job.employerId && e.active);
      if (!emp) return;
      for (const m of team.membersOf(emp.id).filter((x) => can(x, 'interviews.manage', job))) {
        const u = team.userById(m.userId);
        if (u && u.emailVerifiedAt) ledger.once(`${key}:${u.id}`, { audience: 'employer', template: 'interview-answer', employerId: emp.id, applicationId: a.id }, () => mailer.interviewResponse(addressed(emp, u), a, iv, when, confirmed, note, `${baseUrl}/employer/applicants/${a.id}`));
      }
      team.audit(emp.id, null, confirmed ? 'interview-confirmed' : 'interview-reschedule-requested', `${a.name} (${job.title}) by the candidate`);
    } else {
      ledger.once(key, { audience: 'team', template: 'interview-answer', applicationId: a.id }, () => mailer.interviewResponse({ name: `${site.name} team`, email: process.env.NOTIFY_EMAIL || site.email }, a, iv, when, confirmed, note, `${baseUrl}/admin?tab=interviews`));
    }
  }

  // ---------- JSON API ----------
  app.get('/api/ats/jobs/:id/applications', requireEmployerApi, withJob('applicants.view', { api: true }), (req, res) => {
    const f = { ...filtersOf(req.query), job: req.job.id };
    res.json({ ok: true, job: { id: req.job.id, title: req.job.title, status: req.job.status }, applications: filtered(req, f).rows });
  });
  app.get('/api/ats/applications/:id', requireEmployerApi, withApplicant('applicants.view', { api: true }), (req, res) => res.json({ ok: true, application: applicantView(req, req.application, req.job) }));
  app.patch('/api/ats/applications/:id/stage', requireEmployerApi, withApplicant('applicants.manage', { api: true }), limit('employer-status', 120), sameOrigin, (req, res) => {
    const body = req.body || {};
    const r = changeStatus(req, String(body.stage || ''), { correction: body.correction === true, reason: body.reason });
    if (r.error) return fail(res, r.status, r.error);
    res.json({ ok: true, changed: r.changed, application: applicantView(req, req.application, req.job) });
  });
  app.post('/api/ats/applications/:id/assign', requireEmployerApi, withApplicant('applicants.assign', { api: true }), limit('ats-assign', 60), sameOrigin, (req, res) => {
    const r = assign(req, String((req.body || {}).userId || ''));
    if (r.error) return fail(res, r.status, r.error);
    res.json({ ok: true, changed: r.changed, assignedTo: applicantView(req, req.application, req.job).assignedTo });
  });
  app.post('/api/ats/applications/:id/notes', requireEmployerApi, withApplicant('applicants.notes', { api: true }), limit('ats-notes', 60), sameOrigin, (req, res) => {
    const r = addNote(req);
    if (r.error) return fail(res, 400, r.error);
    res.status(201).json({ ok: true, note: { id: r.note.id, at: r.note.at, by: r.note.by, text: r.note.text } });
  });
  app.post('/api/ats/applications/:id/interviews', requireEmployerApi, withApplicant('interviews.manage', { api: true }), limit('employer-interviews', 30), sameOrigin, (req, res) => {
    const r = bookInterview(req, req.body || {});
    if (r.errors.length) return fail(res, r.status, r.errors);
    res.status(201).json({ ok: true, interview: { id: r.iv.id, at: r.iv.at, duration: r.iv.duration, mode: r.iv.mode, status: r.iv.status, confirmation: r.iv.confirmation } });
  });
  app.post('/api/ats/interviews/:ivId/feedback', requireEmployerApi, limit('ats-feedback', 30), sameOrigin, (req, res, next) => {
    // The application that holds this interview, among those the member may see.
    const { apps } = applicationsFor(req);
    const a = apps.find((x) => (x.interviews || []).some((iv) => iv.id === req.params.ivId));
    req.params.id = a ? a.id : '';
    withApplicant('feedback.submit', { api: true })(req, res, () => {
      const r = submitFeedback(req, findInterview(req, req.params.ivId), req.body || {});
      if (r.errors.length) return fail(res, r.status, r.errors);
      res.status(201).json({ ok: true, feedback: { by: r.entry.by, at: r.entry.at, rating: r.entry.rating, recommendation: r.entry.recommendation } });
    });
  });
  app.post('/api/ats/applications/:id/offers', requireEmployerApi, withApplicant('offers.create', { api: true }), limit('ats-offers', 30), sameOrigin, (req, res) => {
    const r = makeOffer(req, req.body || {});
    if (r.errors.length) return fail(res, r.status, r.errors);
    res.status(201).json({ ok: true, offer: applicantView(req, req.application, req.job).offers.find((o) => o.id === r.offer.id) });
  });
  // { "approve": true | false, "note" } and { "response": "accepted" | "declined", "note" }.
  for (const [path, actionOf] of [['approve', (b) => (b.approve === true ? 'approve' : b.approve === false ? 'reject' : '')], ['response', (b) => (ats.RESPONSES.includes(b.response) ? b.response : '')]]) {
    app.post(`/api/ats/offers/:offerId/${path}`, requireEmployerApi, limit('ats-offers', 30), sameOrigin, (req, res) => {
      const body = req.body || {};
      const action = actionOf(body);
      if (!action) return fail(res, 400, path === 'approve' ? 'send "approve": true or false' : 'send "response": "accepted" or "declined"');
      const { apps } = applicationsFor(req);
      const a = apps.find((x) => (x.offers || []).some((o) => o.id === req.params.offerId));
      req.params.id = a ? a.id : '';
      withApplicant(OFFER_ACTIONS[action], { api: true })(req, res, () => {
        const r = offerAction(req, ats.findOffer(req.application, req.params.offerId), action, body.note);
        if (r.error) return fail(res, r.status, r.error);
        res.json({ ok: true, offer: applicantView(req, req.application, req.job).offers.find((o) => o.id === req.params.offerId), stage: req.application.status });
      });
    });
  }
  app.get('/api/ats/analytics', requireEmployerApi, limit('ats-analytics', 60, 60 * 1000), (req, res) => {
    const days = daysOf(req.query);
    res.json({ ok: true, period: days ? `last ${days} days` : 'all time', definitions: DEFINITIONS, metrics: metricsFor(req, days) });
  });

  return { interviewResponded, RECOMMENDATIONS };
}

// Shown with the metrics so every number means the same thing.
const DEFINITIONS = {
  applications: 'Applications to the jobs you can see, not counting duplicates or sample listings; withdrawn ones are counted separately',
  awaitingReview: 'Applications at Applied or Screening',
  funnel: 'How many applications reached each stage (now there, or got there or further before), with the share that went on to the next one',
  timeToHireDays: 'Median days from applying to being moved to Hired',
  timeToFillDays: 'Median days from a job going live to its first hire',
  workload: 'Applications assigned to each person: still open, hired and rejected, and their upcoming interviews',
};

module.exports = { register, DEFINITIONS };
