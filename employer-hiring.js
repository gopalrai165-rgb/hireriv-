// Employers hiring for themselves: their jobs (draft → review by the Hireriv
// team → live, paused or closed), the people who applied to the jobs they
// manage, status changes (recorded in each application's history), and
// interviews. Pages under /employer and JSON under /api/employers. Every
// action checks the signed-in person's role in the company (employer-team.js);
// another company's jobs and applicants are simply "not found".
//
// Jobs the Hireriv team runs for a client stay with the team: the client sees
// counts and the candidates the team shortlists, not every applicant.
const path = require('path');
const vault = require('./vault');
const { can } = require('./employer-team');
const ats = require('./ats');
const { RECOMMENDATIONS } = require('./interviews');
const { SHIFTS } = require('./candidate-profile');
const { workOf } = require('./content');

// A company can have this many jobs live, paused or waiting for review.
const MAX_ACTIVE_JOBS = 50;
// Until the company is verified, at most this many can wait for review.
const MAX_WAITING_UNVERIFIED = 5;
const EMPLOYER_JOB_FIELDS = ['title', 'location', 'mode', 'type', 'category', 'work', 'experience', 'salaryMin', 'salaryMax', 'salaryPeriod', 'payNote', 'education', 'schedule', 'shift', 'hours', 'openings', 'address', 'walkIn', 'eligibility', 'mustHave', 'physical', 'immediate', 'skills', 'description', 'responsibilities', 'qualifications', 'benefits', 'closesOn', 'resume', 'overtime', 'workerCosts'];
const STATUS_LABELS = { draft: 'Draft', pending: 'Waiting for review', open: 'Live', paused: 'Paused', closed: 'Closed', rejected: 'Needs changes' };
const ACTIVE = ['open', 'paused', 'pending'];
const selfManaged = (job) => Boolean(job) && job.createdBy === 'employer';
// Restricted or removed by trust & safety (trust.js): only a moderator or an appeal changes it.
const lockedByModeration = (job) => Boolean(job && job.moderation && job.moderation.locked);
const LOCKED_MESSAGE = 'this listing was restricted by our moderators; use the link in our email to appeal';

function register(app, deps) {
  const { site, mailer, baseUrl, limit, sameOrigin, adminAuth, adminUrl, clients, readSubmissions, writeSubmissions, uploadsDir, downloadLinks, linkExpired } = deps;
  const { getJobs, saveJobs, parseJob, nextJobId, todayIst, publicJob, jobPath, sendJobAlerts, alertedNote, appStatuses, moveStage, interviewDesk, parseInterview, interviewModes, interviewDurations, formatIst, skillMatch, jobFormLocals } = deps;
  const { requireEmployer, requireEmployerApi, team, addressed } = clients;
  const { events } = deps;
  const agencyRoles = require('./agency-roles');
  // Set by trust.js: the configurable limit for companies not yet verified.
  const hooks = {};
  const waitingLimit = () => (hooks.waitingLimit ? hooks.waitingLimit() : MAX_WAITING_UNVERIFIED);
  const actorOf = (req) => ({ label: byLine(req), kind: 'employer', userId: req.employerUser.id });
  const now = () => new Date().toISOString();
  const page = (res, view, locals, status = 200) => res.status(status).render(view, { page: 'employer', noindex: true, errors: [], msg: '', ...locals });
  const byLine = (req) => `${req.employerUser.name} (${req.employer.company})`;

  // ---------- jobs ----------
  const jobAsForm = (j) => ({
    title: j.title, location: j.location, mode: j.mode, type: j.type, category: j.category, work: j.work || '', experience: j.experience || '',
    salaryMin: j.pay && j.pay.min ? String(j.pay.min) : '', salaryMax: j.pay && j.pay.max ? String(j.pay.max) : '', salaryPeriod: (j.pay && j.pay.period) || 'month',
    payNote: j.payNote || '', salary: j.pay ? '' : j.salary || '', education: j.education || '', schedule: j.schedule || '', shift: j.shift || '', hours: j.hours || '',
    openings: j.openings ? String(j.openings) : '', address: j.address || '', walkIn: j.walkIn ? '1' : '', eligibility: (j.eligibility || []).join('\n'),
    mustHave: (j.mustHave || []).join('\n'), physical: j.physical || '', immediate: j.immediate ? '1' : '',
    skills: (j.skills || []).join(', '), description: j.description, responsibilities: (j.responsibilities || []).join('\n'),
    qualifications: (j.qualifications || []).join('\n'), benefits: (j.benefits || []).join('\n'), closesOn: j.closesOn || '', resume: j.resume || '',
    overtime: j.overtime || '', workerCosts: j.workerCosts || '',
  });
  // The employer's input (a form, or JSON where lists may be arrays and pay an
  // object) on top of the job as it is, with the company and owner fixed.
  function employerJobInput(emp, input, existing) {
    const body = existing ? jobAsForm(existing) : { mode: 'On-site', type: 'Full-time', salaryPeriod: 'month' };
    const src = { ...input };
    if (src.pay && typeof src.pay === 'object') Object.assign(src, { salaryMin: src.pay.min ?? '', salaryMax: src.pay.max ?? '', salaryPeriod: src.pay.period ?? body.salaryPeriod });
    // A form sends nothing for an unticked box.
    if (!existing && src.walkIn === undefined) src.walkIn = '';
    if (!existing && src.immediate === undefined) src.immediate = '';
    for (const k of EMPLOYER_JOB_FIELDS) {
      if (src[k] === undefined || src[k] === null) continue;
      if (k === 'walkIn' || k === 'immediate') { body[k] = src[k] === true || src[k] === '1' || src[k] === 'on' ? '1' : ''; continue; }
      body[k] = Array.isArray(src[k]) ? src[k].join(k === 'skills' ? ', ' : '\n') : String(src[k]);
      if (['salaryMin', 'salaryMax'].includes(k)) body.salary = '';
    }
    return parseJob({ ...body, company: emp.company, employerId: emp.id, ownerId: existing ? existing.ownerId : '', status: 'open' });
  }
  const employerJobView = (j) => ({ ...publicJob(j), status: j.status, statusLabel: STATUS_LABELS[j.status] || j.status, submittedAt: j.submittedAt || null, rejectedReason: j.status === 'rejected' ? j.rejectedReason || '' : null });
  // A job of this company that this member may see (404 for anything else).
  const companyJob = (req, id) => getJobs().find((j) => j.id === id && j.employerId === req.employer.id && can(req.member, 'job.view', j)) || null;
  const visibleJobs = (m) => getJobs().filter((j) => j.employerId === m.employerId && can(m, 'job.view', j));

  function createEmployerJob(req, input) {
    const { job, errors } = employerJobInput(req.employer, input, null);
    if (errors.length) return { errors };
    const created = { id: nextJobId(), ...job, status: 'draft', posted: todayIst(), createdBy: 'employer', createdByUser: req.employerUser.id, sample: false };
    getJobs().push(created);
    saveJobs();
    team.audit(req.employer.id, req.employerUser, 'job-created', `${created.title} (${created.id})`);
    return { job: created, errors: [] };
  }
  function updateEmployerJob(req, job, input) {
    const { job: next, errors } = employerJobInput(req.employer, input, job);
    if (errors.length) return { errors };
    // A change to a live, paused or waiting job is checked again before it shows.
    const status = ACTIVE.includes(job.status) ? 'pending' : job.status === 'closed' ? 'closed' : 'draft';
    if (lockedByModeration(job)) return { errors: [LOCKED_MESSAGE] };
    if (status === 'pending' && job.status !== 'pending') {
      const problem = submitProblem(req, { ...job, ...next });
      if (problem) return { errors: [problem] };
    }
    const before = { ...job, pay: job.pay ? { ...job.pay } : null };
    Object.assign(job, next, { status, updatedAt: now() });
    if (hooks.changed && status === 'pending') hooks.changed(before, job);
    delete job.closedReason;
    if (status === 'pending') {
      job.submittedAt = job.updatedAt;
      mailer.employerJobSubmitted(job, addressed(req.employer, req.employerUser), clients.isApproved(req.employer), true);
      events.jobSubmitted(job);
    }
    saveJobs();
    if (status === 'pending' && hooks.submitted) hooks.submitted(job);
    team.audit(req.employer.id, req.employerUser, 'job-updated', `${job.title} (${job.id})`);
    return { job, errors: [] };
  }
  // Before a job goes to the team: the person's mobile is verified (for
  // companies that signed up themselves), the company is within its limits,
  // and the job says what candidates need to know.
  function submitProblem(req, job) {
    const emp = req.employer;
    if (emp.selfSignup && !req.employerUser.phoneVerifiedAt) return 'verify your mobile number in Settings before sending jobs for review';
    // Set by trust.js: a moderator's hold on new postings, or a burst of them.
    const held = hooks.postingProblem ? hooks.postingProblem(emp, job) : '';
    if (held) return held;
    const mine = getJobs().filter((j) => j.employerId === emp.id && j.id !== job.id);
    // The plan's job limit (subscriptions.js), never more than MAX_ACTIVE_JOBS.
    const allowed = hooks.jobLimit ? Math.min(hooks.jobLimit(emp), MAX_ACTIVE_JOBS) : MAX_ACTIVE_JOBS;
    if (mine.filter((j) => ACTIVE.includes(j.status)).length >= allowed) {
      return allowed < MAX_ACTIVE_JOBS ? `your plan allows ${allowed} job${allowed === 1 ? '' : 's'} live, paused or waiting for review at a time; close one, or upgrade under Billing` : `a company can have up to ${MAX_ACTIVE_JOBS} jobs live, paused or waiting for review; close one first`;
    }
    const most = waitingLimit();
    if (!clients.isApproved(emp) && mine.filter((j) => j.status === 'pending').length >= most) return most ? `until your company is verified, up to ${most} job${most === 1 ? '' : 's'} can wait for review` : 'jobs can be sent for review once your company is verified';
    // Last, what this job itself is missing (account-wide blocks come first).
    const missing = qualityGaps(job);
    if (missing.length) return `before sending this job for review, add ${missing.length > 1 ? `${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]}` : missing[0]}`;
    return '';
  }
  // What a candidate needs to judge a job, checked before it goes for review:
  // what the work is, the pay (or how it is decided), and for industrial,
  // field and service work the hours or shift.
  function qualityGaps(job) {
    const missing = [];
    if (!(job.responsibilities || []).length) missing.push('the main responsibilities (one per line)');
    if (!job.pay && !String(job.payNote || '').trim()) missing.push('the pay, or how pay is decided (for example "Fixed monthly salary, discussed at interview")');
    if (workOf(job) === 'field' && !job.hours && !job.shift && !job.schedule) missing.push('the working hours or shift');
    return missing;
  }
  function submitJob(req, job) {
    if (job.status === 'pending') return { job, errors: [] };
    if (lockedByModeration(job)) return { errors: [LOCKED_MESSAGE] };
    if (!['draft', 'rejected', 'closed'].includes(job.status)) return { errors: ['only drafts, jobs sent back and closed jobs can be sent for review'] };
    const { errors } = employerJobInput(req.employer, {}, job);
    if (errors.length) return { errors };
    const problem = submitProblem(req, job);
    if (problem) return { errors: [problem] };
    const reopening = job.status === 'closed';
    Object.assign(job, { status: 'pending', submittedAt: now() });
    delete job.rejectedReason;
    delete job.closedReason;
    // Reopening needs a closing date that hasn't passed.
    if (reopening && job.closesOn && job.closesOn < todayIst()) job.closesOn = null;
    saveJobs();
    mailer.employerJobSubmitted(job, addressed(req.employer, req.employerUser), clients.isApproved(req.employer), reopening);
    events.jobSubmitted(job);
    team.audit(req.employer.id, req.employerUser, 'job-submitted', `${job.title} (${job.id})`);
    if (hooks.submitted) hooks.submitted(job);
    return { job, errors: [] };
  }
  // Pause (hidden, back with one click), resume, and close.
  function setJobState(req, job, action) {
    const from = job.status;
    if (action === 'pause') { if (from !== 'open') return { errors: ['only live jobs can be paused'] }; job.status = 'paused'; job.pausedAt = now(); }
    else if (action === 'resume') { if (from !== 'paused') return { errors: ['only paused jobs can be resumed'] }; job.status = 'open'; delete job.pausedAt; if (job.closesOn && job.closesOn < todayIst()) job.closesOn = null; }
    else if (action === 'close') { if (from === 'closed') return { job, errors: [] }; job.status = 'closed'; job.closedReason = 'Closed by the employer'; job.closedAt = now(); }
    else return { errors: ['unknown action'] };
    job.updatedAt = now();
    saveJobs();
    team.audit(req.employer.id, req.employerUser, `job-${action === 'resume' ? 'resumed' : action === 'pause' ? 'paused' : 'closed'}`, `${job.title} (${job.id})`);
    // Set by integrations.js: webhooks for jobs the employer closed.
    if (hooks.stateChanged) hooks.stateChanged(job, from);
    return { job, errors: [] };
  }

  const jobFormPage = (req, res, job, errors, status = 200) => res.status(status).render('employer-job', {
    ...jobFormLocals(job, errors), title: job.id ? 'Edit job' : 'Post a job', page: 'employer', noindex: true, emp: req.employer, tab: 'jobs',
    approved: clients.isApproved(req.employer), shifts: SHIFTS, needsMobile: req.employer.selfSignup && !req.employerUser.phoneVerifiedAt,
  });
  const toJobs = (res, msg) => res.redirect(`/employer/jobs?msg=${encodeURIComponent(msg)}`);

  app.get('/employer/jobs', requireEmployer, (req, res) => {
    const apps = readSubmissions('applications').filter((a) => !a.duplicateOf && !a.withdrawnAt);
    const status = Object.keys(STATUS_LABELS).includes(req.query.status) ? req.query.status : '';
    const all = visibleJobs(req.member).sort((a, b) => String(b.updatedAt || b.posted).localeCompare(String(a.updatedAt || a.posted)));
    const rows = all.filter((j) => !status || j.status === status).map((j) => ({ ...j, applicants: apps.filter((a) => a.jobId === j.id).length, fresh: apps.filter((a) => a.jobId === j.id && (a.status || 'New') === 'New').length }));
    const counts = Object.fromEntries(Object.keys(STATUS_LABELS).map((s) => [s, all.filter((j) => j.status === s).length]));
    page(res, 'employer-jobs', { title: 'Jobs', tab: 'jobs', rows, counts, status, labels: STATUS_LABELS, msg: String(req.query.msg || '') });
  });

  app.get('/employer/jobs/new', requireEmployer, clients.allow('jobs.create'), (req, res) => jobFormPage(req, res, { mode: 'On-site', type: 'Full-time', status: 'draft', skills: [], responsibilities: [] }, []));

  app.post('/employer/jobs', requireEmployer, clients.allow('jobs.create'), limit('employer-jobs', 30), sameOrigin, (req, res) => {
    const { job, errors } = createEmployerJob(req, req.body);
    if (errors.length) return jobFormPage(req, res, { ...employerJobInput(req.employer, req.body, null).job, status: 'draft' }, errors, 400);
    if (req.body.action === 'publish') {
      const r = submitJob(req, job);
      if (r.errors.length) return toJobs(res, `"${job.title}" was saved as a draft, but not sent: ${r.errors.join(', ')}.`);
      return toJobs(res, `"${job.title}" was sent to the ${site.name} team for a quick check. It goes live once approved.`);
    }
    toJobs(res, `"${job.title}" was saved as a draft.`);
  });

  app.get('/employer/jobs/:id/edit', requireEmployer, (req, res, next) => {
    const job = companyJob(req, req.params.id);
    if (!job || !selfManaged(job)) return next();
    if (!can(req.member, 'job.edit', job)) return clients.forbid(req, res);
    jobFormPage(req, res, job, []);
  });

  // Middleware: the job from the URL, if this member may do `action` with it.
  // Anything else is "not found" (next('route') skips this route's handlers).
  const withJob = (action, { api = false } = {}) => (req, res, next) => {
    const job = companyJob(req, req.params.id);
    if (!job || !selfManaged(job)) return api ? res.status(404).json({ ok: false, errors: ['job not found'] }) : next('route');
    if (!can(req.member, action, job)) return api ? res.status(403).json({ ok: false, errors: ['your role in this company does not allow that'] }) : clients.forbid(req, res);
    req.job = job;
    next();
  };

  app.post('/employer/jobs/:id', requireEmployer, withJob('job.edit'), limit('employer-jobs', 30), sameOrigin, (req, res) => {
    const job = req.job;
    const was = job.status;
    const { errors } = updateEmployerJob(req, job, req.body);
    if (errors.length) return jobFormPage(req, res, { ...employerJobInput(req.employer, req.body, job).job, id: job.id, status: job.status }, errors, 400);
    if (req.body.action === 'publish' && job.status === 'draft') {
      const r = submitJob(req, job);
      return toJobs(res, r.errors.length ? `Saved "${job.title}", but not sent: ${r.errors.join(', ')}.` : `"${job.title}" was sent for a quick check. It goes live once approved.`);
    }
    toJobs(res, ACTIVE.includes(was) && was !== 'pending' ? `Changes to "${job.title}" were sent for a quick check; the job is hidden until they're approved.` : `Saved "${job.title}".`);
  });

  for (const action of ['publish', 'pause', 'resume', 'close']) {
    app.post(`/employer/jobs/:id/${action}`, requireEmployer, withJob('job.edit'), limit('employer-jobs', 30), sameOrigin, (req, res) => {
      const job = req.job;
      const r = action === 'publish' ? submitJob(req, job) : setJobState(req, job, action);
      const done = { publish: `"${job.title}" was sent for a quick check. It goes live once approved.`, pause: `"${job.title}" is paused and hidden from job seekers.`, resume: `"${job.title}" is live again.`, close: `"${job.title}" is closed.` }[action];
      toJobs(res, r.errors.length ? `Could not change "${job.title}": ${r.errors.join(', ')}.` : done);
    });
  }

  // ---------- applicants ----------
  const applicationsFor = (req) => {
    const jobs = new Map(visibleJobs(req.member).filter((j) => selfManaged(j) && can(req.member, 'applicants.view', j)).map((j) => [j.id, j]));
    return { jobs, apps: readSubmissions('applications').filter((a) => jobs.has(a.jobId) && !a.duplicateOf) };
  };
  // What an employer sees. Contact details, resumes and the cover message only
  // for people allowed to contact applicants on that job.
  function applicantView(req, a, job) {
    const may = (action) => can(req.member, action, job);
    const assignee = a.assignedTo ? team.userById(a.assignedTo) : null;
    const v = {
      id: a.id, jobId: a.jobId, jobTitle: job.title, appliedAt: a.createdAt, status: ats.stageOf(a), stageLabel: ats.label(ats.stageOf(a)), withdrawn: Boolean(a.withdrawnAt),
      name: a.name, experience: a.experience || '', location: a.location || '', noticePeriod: a.noticePeriod || '', skills: a.skills || '',
      match: skillMatch(a, job),
      assignedTo: assignee ? { userId: assignee.id, name: assignee.name } : null,
      history: (a.history || []).map((h) => ({ at: h.at, from: h.from, to: h.to, by: h.by, ...(h.correction ? { correction: true, reason: h.reason } : {}) })),
      interviews: (a.interviews || []).map((iv) => ({
        id: iv.id, at: iv.at, duration: iv.duration, mode: iv.mode, status: iv.status, interviewer: iv.interviewer || '', confirmation: iv.status === 'scheduled' ? iv.confirmation || 'confirmed' : null,
        ...(may('feedback.view') ? { feedback: (iv.feedback || []).map((f) => ({ by: f.by, at: f.at, rating: f.rating, recommendation: f.recommendation, strengths: f.strengths || '', concerns: f.concerns || '' })) } : {}),
      })),
      allowedMoves: may('applicants.manage') ? ats.allowedMoves(a) : [],
    };
    if (may('applicants.contact')) Object.assign(v, { email: a.email || '', phone: a.phone || '', linkedin: a.linkedin || '', message: a.message || '', hasResume: Boolean(a.resume) });
    // Internal: never shown to candidates.
    if (may('applicants.notes')) v.notes = (a.atsNotes || []).map((n) => ({ id: n.id, at: n.at, by: n.by, text: n.text }));
    if (may('offers.create') || may('offers.approve')) v.offers = (a.offers || []).map((o) => ({ ...o, createdByUserId: undefined, approval: { ...o.approval, userId: undefined } }));
    return v;
  }

  app.get('/employer/applicants', requireEmployer, (req, res) => {
    const { jobs, apps } = applicationsFor(req);
    const jobId = jobs.has(req.query.job) ? req.query.job : '';
    const status = [...appStatuses, 'Withdrawn'].includes(req.query.status) ? req.query.status : '';
    // Newest first, or (for one job) the best skill match first. Sorting only:
    // everyone stays in the list for a person to review.
    const sort = req.query.sort === 'match' && jobId ? 'match' : 'newest';
    const newest = (x, y) => String(y.appliedAt).localeCompare(String(x.appliedAt));
    const rows = apps.filter((a) => (!jobId || a.jobId === jobId))
      .map((a) => applicantView(req, a, jobs.get(a.jobId)))
      .filter((v) => !status || v.status === status)
      .sort(sort === 'match' ? (x, y) => ((y.match && y.match.score) || 0) - ((x.match && x.match.score) || 0) || newest(x, y) : newest);
    page(res, 'employer-applicants', { title: 'Applicants', tab: 'applicants', rows, jobs: [...jobs.values()], jobId, status, sort, statuses: appStatuses, msg: String(req.query.msg || '') });
  });

  // The applicant from the URL, if this member may see them.
  const withApplicant = (action, { api = false } = {}) => (req, res, next) => {
    const list = readSubmissions('applications');
    const a = list.find((x) => x.id === req.params.id && !x.duplicateOf);
    const job = a && getJobs().find((j) => j.id === a.jobId && j.employerId === req.employer.id);
    if (!a || !job || !selfManaged(job) || !can(req.member, 'applicants.view', job)) return api ? res.status(404).json({ ok: false, errors: ['application not found'] }) : next('route');
    if (!can(req.member, action, job)) return api ? res.status(403).json({ ok: false, errors: ['your role in this company does not allow that'] }) : clients.forbid(req, res);
    Object.assign(req, { applications: list, application: a, job });
    next();
  };

  app.get('/employer/applicants/:id', requireEmployer, withApplicant('applicants.view'), (req, res) => {
    const v = applicantView(req, req.application, req.job);
    // Opening someone's details is recorded.
    team.audit(req.employer.id, req.employerUser, 'applicant-viewed', `${req.application.name} for ${req.job.title}`);
    const workers = team.membersOf(req.employer.id).filter((m) => can(m, 'applicants.manage', req.job)).map((m) => ({ userId: m.userId, name: (team.userById(m.userId) || {}).name || 'Unknown' }));
    page(res, 'employer-applicant', {
      title: `${v.name} · Applicant`, tab: 'applicants', v, job: req.job, stages: ats.STAGES, label: ats.label, workers, recommendations: RECOMMENDATIONS,
      today: todayIst(), nowMs: Date.now(), msg: String(req.query.msg || ''),
    });
  });

  app.get('/employer/applicants/:id/resume', requireEmployer, withApplicant('applicants.contact'), (req, res, next) => {
    const a = req.application;
    if (!a.resume) return next();
    if (!downloadLinks.valid(req)) return linkExpired(res, `/employer/applicants/${a.id}`);
    team.audit(req.employer.id, req.employerUser, 'resume-downloaded', `${a.name} for ${req.job.title}`);
    const file = path.basename(a.resume);
    vault.send(res, path.join(uploadsDir, file), `${String(a.name).replace(/[^a-z0-9]+/gi, '-')}-resume${path.extname(file)}`, 'Resume');
  });

  // Moves an application along the workflow; the change is kept in its
  // history. An owner can correct a mistake outside the workflow, with a reason.
  function changeStatus(req, to, { correction = false, reason = '' } = {}) {
    const a = req.application;
    if (!ats.STAGES.includes(to)) return { status: 400, error: `status must be one of: ${ats.STAGES.join(', ')}` };
    if (a.withdrawnAt) return { status: 409, error: 'the candidate withdrew this application' };
    const from = a.status || 'New';
    if (correction) {
      if (!can(req.member, 'stage.correct', req.job)) return { status: 403, error: 'only a company owner can correct a stage' };
      reason = String(reason || '').trim().slice(0, 300);
      if (reason.length < 5) return { status: 400, error: 'say why the stage is being corrected' };
    } else {
      const problem = ats.moveProblem(a, to);
      if (problem) return { status: 409, error: problem };
    }
    if (!ats.recordMove(moveStage, a, to, actorOf(req), { correction, reason })) return { changed: false };
    writeSubmissions('applications', req.applications);
    team.audit(req.employer.id, req.employerUser, correction ? 'stage-corrected' : 'status-changed', `${a.name}: ${ats.label(from)} → ${ats.label(to)} (${req.job.title})${correction ? `: ${reason}` : ''}`);
    return { changed: true };
  }
  app.post('/employer/applicants/:id/status', requireEmployer, withApplicant('applicants.manage'), limit('employer-status', 120), sameOrigin, (req, res) => {
    const correction = req.body.correction === '1';
    const r = changeStatus(req, String(req.body.status || ''), { correction, reason: req.body.reason });
    if (r.status === 403) return clients.forbid(req, res);
    const back = req.body.back === 'ats' ? '/employer/ats?' : `/employer/applicants/${req.application.id}?`;
    res.redirect(`${back}msg=${encodeURIComponent(r.error ? `Not changed: ${r.error}.` : r.changed ? `${req.application.name}: moved to ${ats.label(req.body.status)}.` : 'No change.')}`);
  });

  // ---------- interviews ----------
  const tomorrow = () => new Date(Date.now() + 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const interviewForm = (req, res, f, errors, status = 200) => page(res, 'employer-interview', { title: 'Schedule an interview', tab: 'interviews', a: req.application, job: req.job, f, errors, modes: interviewModes, durations: interviewDurations }, status);
  app.get('/employer/applicants/:id/interview', requireEmployer, withApplicant('interviews.manage'), (req, res) =>
    interviewForm(req, res, { date: tomorrow(), time: '11:00', duration: 45, mode: 'Video call', where: '', interviewer: req.employerUser.name, interviewerEmail: req.employerUser.email, message: '' }, []));

  function bookInterview(req, body) {
    const a = req.application;
    if (a.withdrawnAt) return { status: 409, errors: ['the candidate withdrew this application'] };
    if (ats.CLOSED.includes(a.status)) return { status: 409, errors: [`the application is ${ats.label(a.status)}`] };
    const { f, at, errors } = parseInterview(body, a);
    if (!errors.length) {
      const company = new Set(getJobs().filter((j) => j.employerId === req.employer.id).map((j) => j.id));
      const problem = ats.scheduleProblem(req.applications.filter((x) => company.has(x.jobId)), a, at, f.duration, f.interviewerEmail);
      if (problem) errors.push(problem);
    }
    if (errors.length) return { status: 400, errors, f };
    if (!a.assignedTo && can(req.member, 'applicants.manage', req.job)) a.assignedTo = req.employerUser.id;
    const { iv } = interviewDesk.book(req.applications, a, f, at, `${byLine(req)} (interview booked)`, { actor: 'employer', userId: req.employerUser.id });
    team.audit(req.employer.id, req.employerUser, 'interview-scheduled', `${a.name} on ${formatIst(at)} (${req.job.title})`);
    return { iv, at, errors: [] };
  }
  app.post('/employer/applicants/:id/interview', requireEmployer, withApplicant('interviews.manage'), limit('employer-interviews', 30), sameOrigin, (req, res) => {
    const r = bookInterview(req, req.body);
    if (r.errors.length) return r.f ? interviewForm(req, res, r.f, r.errors, r.status) : res.redirect(`/employer/applicants/${req.application.id}?msg=${encodeURIComponent(r.errors.join(', '))}`);
    res.redirect(`/employer/applicants/${req.application.id}?msg=${encodeURIComponent(`Interview booked for ${formatIst(r.at)}. ${req.application.email ? 'The candidate was emailed an invite.' : 'They have no email on file, so call them with the details.'}`)}`);
  });

  app.get('/employer/interviews', requireEmployer, (req, res) => {
    const { jobs, apps } = applicationsFor(req);
    const nowMs = Date.now();
    const all = apps.flatMap((a) => (a.interviews || []).map((iv) => ({ ...iv, appId: a.id, candidate: a.name, jobTitle: jobs.get(a.jobId).title })));
    const upcoming = all.filter((iv) => iv.status === 'scheduled' && new Date(iv.at).getTime() + iv.duration * 60000 > nowMs).sort((x, y) => x.at.localeCompare(y.at));
    const past = all.filter((iv) => !upcoming.includes(iv)).sort((x, y) => y.at.localeCompare(x.at)).slice(0, 50);
    page(res, 'employer-interviews', { title: 'Interviews', tab: 'interviews', upcoming, past });
  });


  // ---------- JSON API ----------
  const fail = (res, status, errors) => res.status(status).json({ ok: false, errors: [].concat(errors) });
  const createJson = (req, res) => {
    if (!can(req.member, 'jobs.create')) return fail(res, 403, 'your role in this company does not allow that');
    const { job, errors } = createEmployerJob(req, req.body || {});
    if (errors.length) return fail(res, 400, errors);
    res.status(201).json({ ok: true, job: employerJobView(job) });
  };
  const patchJson = (req, res) => {
    const { errors } = updateEmployerJob(req, req.job, req.body || {});
    if (errors.length) return fail(res, 400, errors);
    res.json({ ok: true, job: employerJobView(req.job) });
  };
  const submitJson = (req, res) => {
    const { errors } = submitJob(req, req.job);
    if (errors.length) return fail(res, 400, errors);
    res.json({ ok: true, job: employerJobView(req.job) });
  };
  app.post('/api/employers/jobs', requireEmployerApi, limit('employer-jobs', 30), sameOrigin, createJson);
  app.get('/api/employers/jobs', requireEmployerApi, (req, res) => {
    const apps = readSubmissions('applications').filter((a) => !a.duplicateOf && !a.withdrawnAt);
    res.json({ ok: true, jobs: visibleJobs(req.member).map((j) => ({ ...employerJobView(j), managedBy: selfManaged(j) ? 'employer' : 'hireriv', applicants: apps.filter((a) => a.jobId === j.id).length })) });
  });
  app.patch('/api/employers/jobs/:id', requireEmployerApi, withJob('job.edit', { api: true }), limit('employer-jobs', 30), sameOrigin, patchJson);
  app.post('/api/employers/jobs/:id/submit', requireEmployerApi, withJob('job.edit', { api: true }), limit('employer-jobs', 30), sameOrigin, submitJson);
  app.post('/api/employers/jobs/:id/close', requireEmployerApi, withJob('job.edit', { api: true }), limit('employer-jobs', 30), sameOrigin, (req, res) => {
    setJobState(req, req.job, 'close');
    res.json({ ok: true, job: employerJobView(req.job) });
  });
  app.get('/api/employers/jobs/:id/applications', requireEmployerApi, withJob('applicants.view', { api: true }), (req, res) => {
    const apps = readSubmissions('applications').filter((a) => a.jobId === req.job.id && !a.duplicateOf);
    res.json({ ok: true, applications: apps.map((a) => applicantView(req, a, req.job)) });
  });
  app.patch('/api/employers/applications/:id/status', requireEmployerApi, withApplicant('applicants.manage', { api: true }), limit('employer-status', 120), sameOrigin, (req, res) => {
    const r = changeStatus(req, String((req.body || {}).status || ''));
    if (r.error) return fail(res, r.status, r.error);
    res.json({ ok: true, changed: r.changed, application: applicantView(req, req.application, req.job) });
  });
  app.post('/api/employers/interviews', requireEmployerApi, limit('employer-interviews', 30), sameOrigin, (req, res, next) => {
    req.params.id = String((req.body || {}).applicationId || '');
    withApplicant('interviews.manage', { api: true })(req, res, () => {
      const r = bookInterview(req, req.body || {});
      if (r.errors.length) return fail(res, r.status, r.errors);
      res.status(201).json({ ok: true, interview: { id: r.iv.id, at: r.iv.at, duration: r.iv.duration, mode: r.iv.mode, status: r.iv.status } });
    });
  });

  // The first version of the API (Step 47), kept working.
  app.post('/api/jobs', requireEmployerApi, limit('employer-jobs', 30), sameOrigin, createJson);
  app.patch('/api/jobs/:id', requireEmployerApi, withJob('job.edit', { api: true }), limit('employer-jobs', 30), sameOrigin, patchJson);
  app.post('/api/jobs/:id/publish', requireEmployerApi, withJob('job.edit', { api: true }), limit('employer-jobs', 30), sameOrigin, submitJson);

  // ---------- the team's decision on a job sent for review ----------
  // The person who posted it and the company's owners hear about it (notify-events.js).
  // Shared with the moderation queue (trust.js). `by` is the team member.
  function approveJob(job, by) {
    if (!job || job.status !== 'pending') return { status: 409, errors: ['this job is no longer waiting for review'] };
    const emp = clients.read().find((c) => c.id === job.employerId);
    if (emp && !clients.isApproved(emp)) return { status: 409, errors: [`verify ${emp.company} first, then this job`] };
    // A listing paused for a check goes back live without changing its date.
    Object.assign(job, { status: 'open', posted: job.reviewHold ? job.posted : todayIst(), approvedAt: now(), approvedBy: by.name });
    const alerted = sendJobAlerts(job);
    saveJobs();
    if (emp) {
      team.audit(emp.id, null, 'job-published', `${job.title} (${job.id}) by ${by.name}`);
      events.jobDecision(job, emp, true, '');
    }
    return { status: 200, job, alerted };
  }
  // Back to the employer with what to change: a job waiting for review, or
  // (by a moderator) a live or paused one.
  function sendBackJob(job, by, reason, { live = false } = {}) {
    const allowed = live ? ['pending', 'open', 'paused'] : ['pending'];
    if (!job || !allowed.includes(job.status)) return { status: 409, errors: [live ? 'only jobs waiting for review, live or paused can be sent back' : 'this job is no longer waiting for review'] };
    if (!job.employerId) return { status: 409, errors: ['only jobs posted by employers can be sent back for changes'] };
    const text = String(reason || '').trim().slice(0, 500) || 'It does not meet our listing rules.';
    Object.assign(job, { status: 'rejected', rejectedReason: text, rejectedAt: now(), rejectedBy: by.name });
    saveJobs();
    const emp = clients.read().find((c) => c.id === job.employerId);
    if (emp) {
      team.audit(emp.id, null, 'job-sent-back', `${job.title} (${job.id}): ${text}`);
      events.jobDecision(job, emp, false, text);
    }
    return { status: 200, job };
  }
  const reviewGate = (req, res, next) => (agencyRoles.can(req.admin, 'jobs.review') ? next() : res.status(403).render('thanks', { title: 'Not part of your role', page: '', ok: false, message: 'Your role does not include reviewing jobs.', noindex: true }));

  app.post('/admin/jobs/:id/approve', adminAuth, reviewGate, sameOrigin, (req, res, next) => {
    const job = getJobs().find((j) => j.id === req.params.id && j.status === 'pending');
    if (!job) return next();
    const r = approveJob(job, req.admin);
    if (r.errors) return res.redirect(adminUrl('jobs', r.errors[0].replace(/^verify (.*) first/, 'Verify $1 under Clients first')));
    if (hooks.decided) hooks.decided(req.admin, 'approve', job, '');
    res.redirect(adminUrl('jobs', `"${job.title}" is live${alertedNote(r.alerted)}`));
  });

  app.post('/admin/jobs/:id/reject', adminAuth, reviewGate, sameOrigin, (req, res, next) => {
    const job = getJobs().find((j) => j.id === req.params.id && j.status === 'pending');
    if (!job) return next();
    const r = sendBackJob(job, req.admin, req.body.reason);
    if (r.errors) return res.redirect(adminUrl('jobs', r.errors[0]));
    if (hooks.decided) hooks.decided(req.admin, 'request-correction', job, job.rejectedReason);
    res.redirect(adminUrl('jobs', `"${job.title}" was sent back to the employer`));
  });

  return {
    hooks, approveJob, sendBackJob, lockedByModeration, selfManaged, STATUS_LABELS, applicantView, applicationsFor, withApplicant, withJob, visibleJobs, companyJob, changeStatus, bookInterview, actorOf, byLine,
    createEmployerJob, updateEmployerJob, submitJob, setJobState, employerJobView,
  };
}

module.exports = { register, lockedByModeration, selfManaged, STATUS_LABELS, MAX_ACTIVE_JOBS, MAX_WAITING_UNVERIFIED };
