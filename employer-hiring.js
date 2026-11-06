// Employers hiring for themselves: their jobs (draft → review by the Hireriv
// team → live, paused or closed), the people who applied to the jobs they
// manage, status changes (recorded in each application's history), and
// interviews. Pages under /employer and JSON under /api/employers. Every
// action checks the signed-in person's role in the company (employer-team.js);
// another company's jobs and applicants are simply "not found".
//
// Jobs the Hireriv team runs for a client stay with the team: the client sees
// counts and the candidates the team shortlists, not every applicant.
const messages = require('./messages');
const rejectReasons = require('./reject-reasons');
const screening = require('./screening');
const messageTemplates = require('./message-templates');
const path = require('path');
const crypto = require('crypto');
const vault = require('./vault');
const { can } = require('./employer-team');
const ats = require('./ats');
const { RECOMMENDATIONS } = require('./interviews');
const { SHIFTS } = require('./candidate-profile');
const { workOf } = require('./content');
const multer = require('multer');
const jobImport = require('./job-import');
const jobParse = require('./job-parse');

// A company can have this many jobs live, paused or waiting for review.
const MAX_ACTIVE_JOBS = 50;
// Until the company is verified, at most this many can wait for review.
const MAX_WAITING_UNVERIFIED = 5;
const EMPLOYER_JOB_FIELDS = ['title', 'location', 'mode', 'type', 'category', 'work', 'experience', 'salaryMin', 'salaryMax', 'salaryPeriod', 'payNote', 'education', 'schedule', 'shift', 'hours', 'openings', 'address', 'walkIn', 'walkInFrom', 'walkInTo', 'walkInTime', 'walkInContact', 'english', 'eligibility', 'mustHave', 'physical', 'immediate', 'skills', 'description', 'responsibilities', 'qualifications', 'benefits', 'closesOn', 'resume', 'overtime', 'workerCosts', 'minEducation', 'perks', 'bring', 'area'];
const STATUS_LABELS = { draft: 'Draft', pending: 'Waiting for review', open: 'Live', paused: 'Paused', closed: 'Closed', rejected: 'Needs changes' };
const ACTIVE = ['open', 'paused', 'pending'];
const selfManaged = (job) => Boolean(job) && job.createdBy === 'employer';
// Restricted or removed by trust & safety (trust.js): only a moderator or an appeal changes it.
const lockedByModeration = (job) => Boolean(job && job.moderation && job.moderation.locked);
const LOCKED_MESSAGE = 'this listing was restricted by our moderators; use the link in our email to appeal';

function register(app, deps) {
  const { site, mailer, baseUrl, limit, sameOrigin, adminAuth, adminUrl, clients, readSubmissions, writeSubmissions, uploadsDir, downloadLinks, linkExpired, sendCsv } = deps;
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
    openings: j.openings ? String(j.openings) : '', address: j.address || '', walkIn: j.walkIn ? '1' : '', walkInFrom: j.walkInFrom || '', walkInTo: j.walkInTo || '', walkInTime: j.walkInTime || '', walkInContact: j.walkInContact || '', english: j.english || '', eligibility: (j.eligibility || []).join('\n'),
    mustHave: (j.mustHave || []).join('\n'), physical: j.physical || '', immediate: j.immediate ? '1' : '',
    skills: (j.skills || []).join(', '), description: j.description, responsibilities: (j.responsibilities || []).join('\n'),
    qualifications: (j.qualifications || []).join('\n'), benefits: (j.benefits || []).join('\n'), closesOn: j.closesOn || '', resume: j.resume || '',
    overtime: j.overtime || '', workerCosts: j.workerCosts || '', minEducation: j.minEducation || '', perks: (j.perks || []).join(','), bring: (j.bring || []).join(','), area: j.area || '', screeningQuestions: j.screeningQuestions || [],
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
      body[k] = Array.isArray(src[k]) ? src[k].join(k === 'skills' || k === 'perks' || k === 'bring' ? ', ' : '\n') : String(src[k]);
      if (['salaryMin', 'salaryMax'].includes(k)) body.salary = '';
    }
    // The form's rows, or the API's list; neither sent keeps the questions as they are.
    if (src.screeningQuestions !== undefined) body.screeningQuestions = src.screeningQuestions;
    for (const k of Object.keys(src)) if (screening.FORM_KEY.test(k)) body[k] = src[k];
    const out = parseJob({ ...body, company: emp.company, employerId: emp.id, ownerId: existing ? existing.ownerId : '', status: 'open' });
    // Whether people who applied may call or WhatsApp the person who created
    // the job (their confirmed mobile; company-trust.js hrContactFor). The form
    // sends hrCallShown so an unticked box turns it off; the API sends hrCall.
    const tick = (v) => v === true || ['1', 'on', 'true'].includes(String(v));
    out.job.hrCall = src.hrCall !== undefined || src.hrCallShown ? tick(src.hrCall) : Boolean(existing && existing.hrCall);
    return out;
  }
  const employerJobView = (j) => ({ ...publicJob(j), screeningQuestions: screening.employerQuestions(j), status: j.status, statusLabel: STATUS_LABELS[j.status] || j.status, submittedAt: j.submittedAt || null, rejectedReason: j.status === 'rejected' ? j.rejectedReason || '' : null });
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
    page(res, 'employer-jobs', { title: 'Jobs', tab: 'jobs', rows, counts, status, labels: STATUS_LABELS, msg: String(req.query.msg || ''), today: todayIst() });
  });

// "Post a similar job": a new job form filled in from one of the company's
  // own jobs (?from=<id>). Dates are left out (closing date, walk-in days),
  // nothing is saved until the employer saves it, and it is checked like any new job.
  const COPIED_FIELDS = ['title', 'location', 'mode', 'type', 'category', 'work', 'experience', 'pay', 'payNote', 'salary', 'education', 'schedule', 'shift', 'hours', 'openings', 'address', 'area', 'walkIn', 'walkInTime', 'walkInContact', 'english', 'eligibility', 'mustHave', 'physical', 'immediate', 'skills', 'description', 'responsibilities', 'qualifications', 'benefits', 'resume', 'overtime', 'workerCosts', 'minEducation', 'perks', 'bring', 'hrCall', 'screeningQuestions'];
  const copyOf = (j) => ({ ...Object.fromEntries(COPIED_FIELDS.filter((k) => j[k] !== undefined).map((k) => [k, Array.isArray(j[k]) ? [...j[k]] : j[k] && typeof j[k] === 'object' ? { ...j[k] } : j[k]])), status: 'draft', copiedFrom: j.title });
  app.get('/employer/jobs/new', requireEmployer, clients.allow('jobs.create'), (req, res) => {
    const source = req.query.from ? companyJob(req, String(req.query.from).slice(0, 60)) : null;
    if (source && selfManaged(source)) return jobFormPage(req, res, copyOf(source), []);
    jobFormPage(req, res, { mode: 'On-site', type: 'Full-time', status: 'draft', skills: [], responsibilities: [] }, []);
  });

  // ---------- bulk upload (CSV) ----------
  // Many jobs at once from a spreadsheet: the file is checked row by row
  // first (nothing saved), then the rows without problems become drafts, and
  // can be sent for review straight away. Each row is checked like the form.
  const importUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: jobImport.MAX_BYTES, fieldSize: jobImport.MAX_BYTES * 2, files: 1 } });
  const importLists = () => {
    const l = jobFormLocals({}, []);
    return { categories: l.categoryGroups.flatMap((g) => g.items || g.categories || []), locations: l.jobLocations, modes: l.modes, types: l.jobTypes, shifts: SHIFTS };
  };
  const importPage = (req, res, locals, status = 200) => page(res, 'employer-job-import', {
    title: 'Upload many jobs', tab: 'jobs', columns: jobImport.COLUMNS, maxRows: jobImport.MAX_ROWS, csv: '', checked: null, done: null, fileErrors: [],
    categories: importLists().categories, locations: importLists().locations, ...locals,
  }, status);
  app.get('/employer/jobs/import', requireEmployer, clients.allow('jobs.create'), (req, res) => importPage(req, res, {}));
  app.get('/employer/jobs/import/template.csv', requireEmployer, clients.allow('jobs.create'), (req, res) => {
    res.set('Content-Disposition', 'attachment; filename="hireriv-jobs-template.csv"');
    res.type('text/csv').send(`\uFEFF${jobImport.template()}`);
  });
  app.post('/employer/jobs/import', requireEmployer, clients.allow('jobs.create'), limit('employer-job-import', 20), sameOrigin, (req, res, next) => {
    importUpload.single('file')(req, res, (err) => {
      if (err) return importPage(req, res, { fileErrors: [err.code === 'LIMIT_FILE_SIZE' ? `the file is too large (up to ${jobImport.MAX_BYTES / 1024} KB)` : 'the file could not be read'] }, 400);
      next();
    });
  }, (req, res) => {
    const csv = req.file ? req.file.buffer.toString('utf8') : String(req.body.csv || '');
    if (!csv.trim()) return importPage(req, res, { fileErrors: ['choose a CSV file, or paste the rows'] }, 400);
    const { rows, errors: fileErrors } = jobImport.read(csv, importLists());
    const checked = rows.map((r) => ({ ...r, errors: employerJobInput(req.employer, r.input, null).errors }));
    const blocking = fileErrors.filter((e) => !e.startsWith('these columns are not recognised'));
    if (req.body.action !== 'create' || blocking.length || !checked.some((r) => !r.errors.length)) {
      return importPage(req, res, { csv, checked, fileErrors }, blocking.length ? 400 : 200);
    }
    const sendNow = req.body.sendNow === '1';
    const done = [];
    for (const r of checked) {
      if (r.errors.length) { done.push({ line: r.line, title: r.title, state: 'skipped', note: r.errors.join(', ') }); continue; }
      const made = createEmployerJob(req, r.input);
      if (made.errors.length) { done.push({ line: r.line, title: r.title, state: 'skipped', note: made.errors.join(', ') }); continue; }
      const entry = { line: r.line, title: made.job.title, id: made.job.id, state: 'draft', note: '' };
      if (sendNow) {
        const s = submitJob(req, made.job);
        if (s.errors.length) entry.note = `saved as a draft, not sent: ${s.errors.join(', ')}`;
        else entry.state = 'sent';
      }
      done.push(entry);
    }
    team.audit(req.employer.id, req.employerUser, 'jobs-imported', `${done.filter((d) => d.id).length} jobs from a CSV file`);
    importPage(req, res, { done, sendNow });
  });

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

  // Every draft this member may edit, sent for review in one go (after a CSV
  // upload, say). Each goes through the usual checks; the first problem that
  // stops one (the plan's job limit, the waiting limit, something missing) is
  // reported and the rest stay drafts.
  app.post('/employer/jobs/submit-drafts', requireEmployer, limit('employer-jobs', 30), sameOrigin, (req, res) => {
    const drafts = visibleJobs(req.member).filter((j) => j.status === 'draft' && selfManaged(j) && can(req.member, 'job.edit', j));
    if (!drafts.length) return toJobs(res, 'There are no drafts to send.');
    let sent = 0; const problems = [];
    for (const j of drafts) {
      const r = submitJob(req, j);
      if (r.errors.length) problems.push(`"${j.title}": ${r.errors[0]}`);
      else sent++;
    }
    const left = drafts.length - sent;
    toJobs(res, `${sent} draft${sent === 1 ? '' : 's'} sent to the ${site.name} team for review.${left ? ` ${left} still a draft: ${problems.slice(0, 2).join('; ')}${problems.length > 2 ? '…' : ''}.` : ''}`);
  });

  // Keep a job open 30 more days: only the closing date moves (from today or
  // the current closing date, whichever is later), so it stays live and is
  // not checked again. Live and paused jobs with a closing date only.
  const EXTEND_DAYS = 30;
  app.post('/employer/jobs/:id/extend', requireEmployer, withJob('job.edit'), limit('employer-jobs', 30), sameOrigin, (req, res) => {
    const job = req.job;
    if (!['open', 'paused'].includes(job.status) || !job.closesOn) return toJobs(res, `"${job.title}" has no closing date to move.`);
    const from = job.closesOn > todayIst() ? job.closesOn : todayIst();
    const next = new Date(Date.parse(from) + EXTEND_DAYS * 86400000).toISOString().slice(0, 10);
    const was = job.closesOn;
    Object.assign(job, { closesOn: next, updatedAt: now() });
    saveJobs();
    team.audit(req.employer.id, req.employerUser, 'job-extended', `${job.title} (${job.id}): closing date ${was} → ${next}`);
    toJobs(res, `"${job.title}" now takes applications until ${next}.`);
  });

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
      id: a.id, jobId: a.jobId, jobTitle: job.title, appliedAt: a.createdAt, viewedAt: a.viewedAt || null, status: ats.stageOf(a), stageLabel: ats.label(ats.stageOf(a)), withdrawn: Boolean(a.withdrawnAt),
      name: a.name, experience: a.experience || '', location: a.location || '', noticePeriod: a.noticePeriod || '', skills: a.skills || '',
      match: skillMatch(a, job),
      screening: screening.view(a, { showTyped: may('applicants.contact') }),
      screeningOutcome: screening.outcome(a),
      screeningLabel: screening.outcomeLabel(a),
      assignedTo: assignee ? { userId: assignee.id, name: assignee.name } : null,
      history: (a.history || []).map((h) => ({ at: h.at, from: h.from, to: h.to, by: h.by, ...(h.correction ? { correction: true, reason: h.reason } : {}), ...(h.rejectReason ? { rejectReason: h.rejectReason, rejectReasonLabel: rejectReasons.labelOf(h.rejectReason) } : {}) })),
      rejectReason: rejectReasons.reasonOf(a) || null,
      unreadMessages: messages.unreadFor(a, 'hiring'),
      interviews: (a.interviews || []).map((iv) => ({
        id: iv.id, at: iv.at, duration: iv.duration, mode: iv.mode, status: iv.status, interviewer: iv.interviewer || '', confirmation: iv.status === 'scheduled' ? iv.confirmation || 'confirmed' : null,
        ...(may('feedback.view') ? { feedback: (iv.feedback || []).map((f) => ({ by: f.by, at: f.at, rating: f.rating, recommendation: f.recommendation, strengths: f.strengths || '', concerns: f.concerns || '' })) } : {}),
      })),
      allowedMoves: may('applicants.manage') ? ats.allowedMoves(a) : [],
      hrContacts: (a.hrContacts || []).map((c) => ({ via: c.via, at: c.at })),
      referredBy: a.referredBy ? a.referredBy.name : '',
      interviewOptions: a.interviewOptions && a.interviewOptions.status === 'open' ? { slots: a.interviewOptions.slots.map((s) => s.at), createdAt: a.interviewOptions.createdAt } : null,
    };
    if (may('applicants.contact')) v.messages = messages.listOf(a).map((m) => ({ id: m.id, at: m.at, from: m.from, by: m.by, text: m.text, readAt: m.readAt }));
    if (may('applicants.contact')) Object.assign(v, { email: require('./identity').realEmail(a.email), phone: a.phone || '', linkedin: a.linkedin || '', message: a.message || '', hasResume: Boolean(a.resume) });
    // Internal: never shown to candidates.
    if (may('applicants.notes')) v.notes = (a.atsNotes || []).map((n) => ({ id: n.id, at: n.at, by: n.by, text: n.text }));
    if (may('offers.create') || may('offers.approve')) v.offers = (a.offers || []).map((o) => ({ ...o, createdByUserId: undefined, approval: { ...o.approval, userId: undefined } }));
    return v;
  }

  // The list and its download follow the same filters.
  function filteredApplicants(req) {
    const { jobs, apps } = applicationsFor(req);
    const jobId = jobs.has(req.query.job) ? req.query.job : '';
    const status = [...appStatuses, 'Withdrawn'].includes(req.query.status) ? req.query.status : '';
    // Newest first, or (for one job) the best skill match first. Sorting only:
    // everyone stays in the list for a person to review.
    const sort = req.query.sort === 'match' && jobId ? 'match' : 'newest';
    // Needed answers narrow what's on screen only. Nobody is rejected or moved by them.
    const answers = ['meets', 'misses'].includes(req.query.answers) ? req.query.answers : '';
    const newest = (x, y) => String(y.appliedAt).localeCompare(String(x.appliedAt));
    const rows = apps.filter((a) => (!jobId || a.jobId === jobId))
      .map((a) => applicantView(req, a, jobs.get(a.jobId)))
      .filter((v) => (!status || v.status === status) && (!answers || v.screeningOutcome === answers))
      .sort(sort === 'match' ? (x, y) => ((y.match && y.match.score) || 0) - ((x.match && x.match.score) || 0) || newest(x, y) : newest);
    return { jobs, rows, jobId, status, sort, answers };
  }

  app.get('/employer/applicants', requireEmployer, (req, res) => {
    const { jobs, rows, jobId, status, sort, answers } = filteredApplicants(req);
    const filters = new URLSearchParams(Object.entries({ job: jobId, status, sort: sort === 'match' ? sort : '', answers }).filter(([, v]) => v)).toString();
    page(res, 'employer-applicants', { title: 'Applicants', tab: 'applicants', rows, filters, jobs: [...jobs.values()], jobId, status, sort, answers, rejectReasons: rejectReasons.REASONS, anyQuestions: [...jobs.values()].some((j) => screening.hasQuestions(j)), statuses: appStatuses, msg: String(req.query.msg || '') });
  });

  // A spreadsheet of what this person can see on the Applicants page. Contact
  // details only where they may contact applicants on the job, and never for
  // someone who withdrew. No notes, messages, offers or resume text. Links last a
  // few minutes, like resumes, and each download is in the company's activity log.
  app.get('/employer/applicants.csv', requireEmployer, limit('employer-applicants-export', 20), (req, res) => {
    if (!downloadLinks.valid(req)) return linkExpired(res, '/employer/applicants');
    const { jobs, rows, jobId } = filteredApplicants(req);
    let withContact = 0;
    const sheet = rows.map((v) => {
      const row = {
        Name: v.name, Job: v.jobTitle, Applied: String(v.appliedAt || '').slice(0, 10), Stage: v.withdrawn ? 'Withdrawn' : v.stageLabel,
        Experience: v.experience, Location: v.location, 'Notice period': v.noticePeriod, Skills: v.skills,
        'Skill match': v.match && v.match.score !== null && v.match.score !== undefined ? `${v.match.score}%` : '',
        'Needed answers': v.screeningLabel || '', 'Answers to questions': v.screening.filter((x) => !x.hidden).map((x) => `${x.text}: ${x.answer}`).join(' | '),
        'Reason not selected': rejectReasons.labelOf(v.rejectReason) || '', 'Assigned to': v.assignedTo ? v.assignedTo.name : '',
      };
      if (can(req.member, 'applicants.contact', jobs.get(v.jobId)) && !v.withdrawn) {
        withContact += 1;
        Object.assign(row, { Email: v.email, Phone: v.phone, LinkedIn: v.linkedin });
      }
      return row;
    });
    team.audit(req.employer.id, req.employerUser, 'applicants-exported', `${rows.length} applicant${rows.length === 1 ? '' : 's'}, ${jobId ? jobs.get(jobId).title : 'all jobs'}, ${withContact ? 'with' : 'without'} contact details`);
    res.set('Cache-Control', 'no-store');
    sendCsv(res, 'applicants', sheet.length ? sheet : [{ note: 'No applicants match these filters' }]);
  });

  // Saved replies on the applicant's page; ?use= fills the message box.
  function savedRepliesFor(req, v) {
    const replies = readSubmissions('message-templates').filter((x) => x.owner === `employer:${req.employer.id}`).sort((a, b) => a.name.localeCompare(b.name));
    const used = replies.find((x) => x.id === req.query.use);
    return { replies, used: used ? used.id : '', prefill: used && !v.withdrawn ? messageTemplates.fill(used.text, { name: v.name, job: v.jobTitle, company: req.employer.company }) : '' };
  }

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
    // Replies are read once someone who may contact the applicant opens the page.
    if (can(req.member, 'applicants.contact', req.job) && messages.markRead(req.application, 'hiring')) writeSubmissions('applications', req.applications);
    const v = applicantView(req, req.application, req.job);
    // Opening someone's details is recorded.
    team.audit(req.employer.id, req.employerUser, 'applicant-viewed', `${req.application.name} for ${req.job.title}`);
    // The first time, the job seeker sees "Seen by the hiring team" and is told once.
    if (!req.application.viewedAt) {
      req.application.viewedAt = now();
      writeSubmissions('applications', req.applications);
      if (events && events.applicationViewed) events.applicationViewed(req.application, req.job);
    }
    const workers = team.membersOf(req.employer.id).filter((m) => can(m, 'applicants.manage', req.job)).map((m) => ({ userId: m.userId, name: (team.userById(m.userId) || {}).name || 'Unknown' }));
    page(res, 'employer-applicant', {
      title: `${v.name} · Applicant`, tab: 'applicants', v, job: req.job, ...savedRepliesFor(req, v), stages: ats.STAGES, label: ats.label, rejectReasons: rejectReasons.REASONS, workers, recommendations: RECOMMENDATIONS,
      today: todayIst(), nowMs: Date.now(), msg: String(req.query.msg || ''),
    });
  });

  // A message to the applicant (messages.js). Only people who may contact
  // applicants on the job; the words are not put in the activity log.
  app.post('/employer/applicants/:id/messages', requireEmployer, withApplicant('applicants.contact'), limit('employer-messages', 60), sameOrigin, (req, res) => {
    const a = req.application;
    const back = (msg) => res.redirect(303, `/employer/applicants/${a.id}?msg=${encodeURIComponent(msg)}#messages`);
    const ok = messages.check(a, req.body.text, 'employer');
    if (ok.error) return back(`Not sent: ${ok.error}.`);
    const m = messages.add(a, { from: 'employer', by: `${req.employerUser.name}, ${req.employer.company}`, userId: req.employerUser.id, text: ok.text });
    writeSubmissions('applications', req.applications);
    team.audit(req.employer.id, req.employerUser, 'message-sent', `${a.name} (${req.job.title})`);
    if (events && events.messageToCandidate) events.messageToCandidate(a, req.job, m);
    back(`Message sent to ${String(a.name).split(' ')[0]}.`);
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
  function changeStatus(req, to, { correction = false, reason = '', rejectReason = '' } = {}) {
    const a = req.application;
    if (!ats.STAGES.includes(to)) return { status: 400, error: `status must be one of: ${ats.STAGES.join(', ')}` };
    // Why they weren't taken: optional, from the fixed list (reject-reasons.js).
    const why = rejectReasons.parse(rejectReason);
    if (why.error) return { status: 400, error: why.error };
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
    if (!ats.recordMove(moveStage, a, to, actorOf(req), { correction, reason, rejectReason: why.key })) return { changed: false };
    writeSubmissions('applications', req.applications);
    team.audit(req.employer.id, req.employerUser, correction ? 'stage-corrected' : 'status-changed', `${a.name}: ${ats.label(from)} → ${ats.label(to)} (${req.job.title})${correction ? `: ${reason}` : ''}`);
    return { changed: true };
  }
  // Several applicants moved to one stage at once (ticked in the list). Each
  // one is checked as if moved on its own: this company's job, the member may
  // manage it, the move is allowed; the rest are skipped and counted.
  const MAX_BULK = 100;
  app.post('/employer/applicants/bulk', requireEmployer, limit('employer-status', 120), sameOrigin, (req, res) => {
    const ids = [...new Set([].concat(req.body.ids || []).map(String))].slice(0, MAX_BULK);
    const to = String(req.body.status || '');
    const rejectReason = to === 'Rejected' ? String(req.body.rejectReason || '') : '';
    const keep = new URLSearchParams(Object.fromEntries(['job', 'status', 'sort', 'answers'].map((k) => [k, String(req.body[`back_${k}`] || '')]).filter(([, v]) => v))).toString();
    const back = (msg) => res.redirect(303, `/employer/applicants?${keep ? `${keep}&` : ''}msg=${encodeURIComponent(msg)}`);
    if (!ids.length) return back('Tick the applicants to move first.');
    if (!ats.STAGES.includes(to)) return back('Choose the stage to move them to.');
    const list = readSubmissions('applications');
    let moved = 0; const skipped = [];
    for (const id of ids) {
      const a = list.find((x) => x.id === id && !x.duplicateOf);
      const job = a && getJobs().find((j) => j.id === a.jobId && j.employerId === req.employer.id);
      if (!a || !job || !selfManaged(job) || !can(req.member, 'applicants.manage', job)) { skipped.push('not yours to change'); continue; }
      const r = changeStatus(Object.assign(Object.create(req), { applications: list, application: a, job }), to, { rejectReason });
      if (r.error) skipped.push(`${a.name}: ${r.error}`);
      else if (r.changed) moved++;
    }
    const label = ats.label(to);
    back(`${moved} applicant${moved === 1 ? '' : 's'} moved to ${label}.${skipped.length ? ` ${skipped.length} not moved: ${skipped.slice(0, 3).join('; ')}${skipped.length > 3 ? '…' : ''}.` : ''}`);
  });

  app.post('/employer/applicants/:id/status', requireEmployer, withApplicant('applicants.manage'), limit('employer-status', 120), sameOrigin, (req, res) => {
    const correction = req.body.correction === '1';
    const to = String(req.body.status || '');
    const r = changeStatus(req, to, { correction, reason: req.body.reason, rejectReason: to === 'Rejected' ? req.body.rejectReason : '' });
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
  // Times for the candidate to choose from (2 to 5): each checked like a
  // booking (in the future, no clash for the interviewer); the candidate picks
  // one from their account and it is booked, already confirmed. A new offer
  // replaces an open one.
  const MAX_OPTIONS = 5;
  const companyApps = (employerId, list) => {
    const ids = new Set(getJobs().filter((j) => j.employerId === employerId).map((j) => j.id));
    return list.filter((x) => ids.has(x.jobId));
  };
  const extraSlots = (body) => [2, 3, 4, 5].filter((i) => String(body[`date${i}`] || '').trim() && String(body[`time${i}`] || '').trim());
  function offerInterviewTimes(req, body) {
    const a = req.application;
    if (a.withdrawnAt) return { status: 409, errors: ['the candidate withdrew this application'] };
    if (ats.CLOSED.includes(a.status)) return { status: 409, errors: [`the application is ${ats.label(a.status)}`] };
    const pairs = [[body.date, body.time], ...extraSlots(body).map((i) => [body[`date${i}`], body[`time${i}`]])].slice(0, MAX_OPTIONS);
    const errors = [];
    const slots = [];
    let f = null;
    pairs.forEach(([date, time], n) => {
      const r = parseInterview({ ...body, date, time }, a);
      f = f || r.f;
      if (r.errors.length) { errors.push(...r.errors.map((e) => `time ${n + 1}: ${e}`)); return; }
      const problem = ats.scheduleProblem(companyApps(req.employer.id, req.applications), a, r.at, r.f.duration, r.f.interviewerEmail);
      if (problem) errors.push(`time ${n + 1}: ${problem}`);
      else if (slots.some((s) => s.at === r.at.toISOString())) errors.push(`time ${n + 1} is the same as another`);
      else slots.push({ at: r.at.toISOString() });
    });
    if (!errors.length && slots.length < 2) errors.push('offer at least two times, or book one');
    if (errors.length) return { status: 400, errors: [...new Set(errors)], f: { ...(f || {}), ...Object.fromEntries([2, 3, 4, 5].flatMap((i) => [[`date${i}`, body[`date${i}`] || ''], [`time${i}`, body[`time${i}`] || '']])) } };
    const offer = {
      id: crypto.randomUUID(), status: 'open', createdAt: now(), byUserId: req.employerUser.id, by: byLine(req),
      f: { duration: f.duration, mode: f.mode, where: f.where, interviewer: f.interviewer, interviewerEmail: f.interviewerEmail, message: f.message },
      slots: slots.sort((x, y) => x.at.localeCompare(y.at)),
    };
    a.interviewOptions = offer;
    if (!a.assignedTo && can(req.member, 'applicants.manage', req.job)) a.assignedTo = req.employerUser.id;
    writeSubmissions('applications', req.applications);
    if (events.interviewOptionsOffered) events.interviewOptionsOffered(a, offer);
    team.audit(req.employer.id, req.employerUser, 'interview-times-offered', `${a.name}: ${slots.length} times (${req.job.title})`);
    return { offer, errors: [] };
  }
  // The candidate (signed in, their own application) picks one of the times.
  function chooseInterviewTime(email, appId, offerId, at) {
    const list = readSubmissions('applications');
    const a = list.find((x) => x.id === appId && String(x.email).toLowerCase() === email && !x.withdrawnAt && !x.duplicateOf);
    const offer = a && a.interviewOptions;
    const job = a && getJobs().find((j) => j.id === a.jobId);
    if (!offer || offer.id !== offerId || offer.status !== 'open' || !job) return { error: 'These times are no longer open. The employer will be in touch.' };
    const slot = offer.slots.find((s) => s.at === at);
    if (!slot || Date.parse(slot.at) <= Date.now()) return { error: 'That time has passed or is not one of the options. Please choose another.' };
    const when = new Date(slot.at);
    const problem = ats.scheduleProblem(companyApps(job.employerId, list), a, when, offer.f.duration, offer.f.interviewerEmail);
    if (problem) return { error: 'That time was just taken. Please choose another one.' };
    const { iv } = interviewDesk.book(list, a, offer.f, when, `${a.name} chose an interview time`, { actor: 'candidate' });
    const fresh = readSubmissions('applications');
    const saved = fresh.find((x) => x.id === a.id);
    const ivSaved = saved && (saved.interviews || []).find((x) => x.id === iv.id);
    if (ivSaved) Object.assign(ivSaved, { confirmation: 'confirmed', answeredAt: now() });
    if (saved) saved.interviewOptions = { ...offer, status: 'chosen', chosenAt: now(), chosen: slot.at, interviewId: iv.id };
    writeSubmissions('applications', fresh);
    if (events.interviewAnswered && saved && ivSaved) events.interviewAnswered(saved, ivSaved, true);
    return { at: when, jobTitle: a.jobTitle };
  }
  app.post('/employer/applicants/:id/interview-options/cancel', requireEmployer, withApplicant('interviews.manage'), limit('employer-interviews', 30), sameOrigin, (req, res) => {
    const a = req.application;
    if (a.interviewOptions && a.interviewOptions.status === 'open') {
      a.interviewOptions = { ...a.interviewOptions, status: 'withdrawn', withdrawnAt: now() };
      writeSubmissions('applications', req.applications);
      team.audit(req.employer.id, req.employerUser, 'interview-times-withdrawn', `${a.name} (${req.job.title})`);
    }
    res.redirect(`/employer/applicants/${a.id}?msg=${encodeURIComponent('The interview times were withdrawn.')}`);
  });

  app.post('/employer/applicants/:id/interview', requireEmployer, withApplicant('interviews.manage'), limit('employer-interviews', 30), sameOrigin, (req, res) => {
    if (extraSlots(req.body).length) {
      const o = offerInterviewTimes(req, req.body);
      if (o.errors.length) return o.f ? interviewForm(req, res, o.f, o.errors, o.status) : res.redirect(`/employer/applicants/${req.application.id}?msg=${encodeURIComponent(o.errors.join(', '))}`);
      return res.redirect(`/employer/applicants/${req.application.id}?msg=${encodeURIComponent(`${o.offer.slots.length} interview times sent. ${req.application.email ? `${req.application.name} was emailed and picks one from their account; it is then booked.` : 'They have no email on file, so call them to agree a time.'}`)}`);
    }
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
  // Fill the job form from a pasted job post (job-parse.js). Nothing is saved.
  app.post('/api/employers/jobs/parse', requireEmployerApi, limit('job-parse', 60), sameOrigin, (req, res) => {
    if (!can(req.member, 'jobs.create') && !can(req.member, 'job.edit')) return fail(res, 403, 'your role in this company does not allow that');
    const text = String((req.body || {}).text || '');
    if (!text.trim()) return fail(res, 400, 'paste the job post first');
    if (text.length > jobParse.MAX_TEXT) return fail(res, 400, `the job post is too long: paste up to ${jobParse.MAX_TEXT.toLocaleString('en-IN')} characters`);
    const l = importLists();
    res.json({ ok: true, ...jobParse.parseJobPost(text, { cities: l.locations, categories: l.categories }) });
  });
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
    createEmployerJob, updateEmployerJob, submitJob, setJobState, employerJobView, chooseInterviewTime,
  };
}

module.exports = { register, lockedByModeration, selfManaged, STATUS_LABELS, MAX_ACTIVE_JOBS, MAX_WAITING_UNVERIFIED };
