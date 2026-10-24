// Candidate accounts: registration, passwordless sign-in by emailed link, a
// profile and resume kept on file, one-click applying, jobs that match the
// profile, job alerts, application tracking, interviews, withdraw, and
// delete-my-data. A registration is stored as a general application, so the
// team sees new sign-ups in Applications and the Talent pool like any CV.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const COOKIE = 'hr_cand';
const LINK_MINUTES = 30;
const WELCOME_HOURS = 24; // the link in the welcome email after registering
const SESSION_DAYS = 7;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^[+\d][\d\s-]{7,16}$/;
const PROFILE_FIELDS = ['name', 'phone', 'skills', 'experience', 'location', 'noticePeriod', 'linkedin'];

// What candidates see instead of internal pipeline names.
const CANDIDATE_STAGE = { New: 'Received', Screening: 'Under review', Interview: 'Interview', Offered: 'Offer', Hired: 'Hired', Rejected: 'Not selected' };
const STEPS = ['Received', 'Under review', 'Interview', 'Offer', 'Hired'];
const EXPERIENCE = ['Fresher', '0-1 years', '1-3 years', '3-5 years', '5-10 years', '10+ years'];
const NOTICE = ['Immediate', '15 days', '30 days', '60 days', '90 days'];

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('hex');

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function register(app, deps) {
  const { db, mailer, baseUrl, sameOrigin, limit, readSubmissions, writeSubmissions, uploadsDir, getJobs, formatIst, interviewIcs, site, contractsFor } = deps;
  const { upload, saveApplication, isBot, isSample, resumeNeeded, skillMatch, saveSubmission, jobCategories, jobLocations } = deps;
  const secureCookie = /^https:/.test(baseUrl);

  const mine = (email) => readSubmissions('applications').filter((a) => String(a.email).toLowerCase() === email);

  function currentEmail(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    const s = token && db.sessions.get('candidate', sha(token));
    return s ? s.subject : null;
  }
  const requireCandidate = (req, res, next) => {
    const email = currentEmail(req);
    if (!email) return res.redirect('/account/login');
    req.candidateEmail = email;
    next();
  };
  setInterval(() => db.sessions.purgeExpired(), 600000).unref();

  const newestFirst = (x, y) => String(y.updatedAt || y.createdAt).localeCompare(String(x.updatedAt || x.createdAt));
  // The profile: the newest non-empty value of each field across all their
  // applications, so a later application with blanks never hides details given
  // earlier, and the newest resume on file.
  function profileFor(email) {
    const list = mine(email).sort(newestFirst);
    const profile = {};
    for (const a of list) for (const k of PROFILE_FIELDS) if (!profile[k] && a[k]) profile[k] = a[k];
    const withResume = list.find((a) => a.resume);
    profile.resume = withResume ? { appId: withResume.id, file: withResume.resume, at: withResume.updatedAt || withResume.createdAt } : null;
    profile.resumeSkills = withResume ? withResume.resumeSkills || [] : [];
    return profile;
  }
  // What the job page needs to offer one-click applying to a signed-in candidate.
  function accountForJob(req, job) {
    const email = currentEmail(req);
    if (!email) return null;
    const profile = profileFor(email);
    const applied = mine(email).find((a) => a.jobId === job.id && !a.withdrawnAt);
    const missing = [];
    if (!profile.name) missing.push('your name');
    if (!profile.phone) missing.push('a phone number');
    if (resumeNeeded(job) && !profile.resume) missing.push('a resume');
    return { email, name: profile.name || '', phone: profile.phone || '', hasResume: Boolean(profile.resume), applied: applied ? applied.createdAt : null, missing };
  }

  const page = (res, view, locals, status = 200) => res.status(status).render(view, { page: 'account', noindex: true, errors: [], ...locals });
  const back = (res, msg) => res.redirect('/account?msg=' + encodeURIComponent(msg));

  // ---------- register ----------
  const registerPage = (res, locals, status = 200) =>
    page(res, 'account-register', { title: 'Create your job-seeker account', values: {}, done: false, experienceOptions: EXPERIENCE, noticeOptions: NOTICE, ...locals }, status);

  app.get('/account/register', (req, res) => {
    if (currentEmail(req)) return res.redirect('/account');
    registerPage(res, {});
  });

  app.post('/account/register', limit('account-register', 5), sameOrigin, (req, res) => {
    upload.single('resume')(req, res, (err) => {
      const drop = () => req.file && fs.unlink(req.file.path, () => {});
      if (!err && isBot(req.body)) { drop(); return registerPage(res, { done: true, title: 'Check your email' }); }
      const get = (k, max) => String(req.body[k] ?? '').trim().slice(0, max);
      const values = {
        name: get('name', 120), email: get('email', 160).toLowerCase(), phone: get('phone', 20), location: get('location', 120),
        experience: EXPERIENCE.includes(req.body.experience) ? req.body.experience : '',
        noticePeriod: NOTICE.includes(req.body.noticePeriod) ? req.body.noticePeriod : '',
        skills: get('skills', 500), linkedin: get('linkedin', 300),
      };
      const errors = [];
      if (err) errors.push(err.code === 'LIMIT_FILE_SIZE' ? 'Resume must be under 5 MB.' : `${err.message}.`);
      if (!values.name) errors.push('Please enter your name.');
      if (!EMAIL_RE.test(values.email)) errors.push('Please enter a valid email.');
      if (!PHONE_RE.test(values.phone)) errors.push('Please enter a valid mobile number.');
      if (values.linkedin && !/^https?:\/\/[^\s"'<>]+$/i.test(values.linkedin)) errors.push('LinkedIn / portfolio must be a full link starting with https://');
      if (!req.body.agree) errors.push('Please agree to the Privacy Policy and Terms of Use.');
      if (errors.length) { drop(); return registerPage(res, { values, errors }, 400); }

      saveApplication({ jobId: 'general', ...values, source: 'account' }, req.file, null, { registeredAt: new Date().toISOString() })
        .then(({ app: a, updated }) => {
          // The welcome email carries a sign-in link, so only the owner of the
          // address can open the account. Someone who already has one gets the
          // same reply and a fresh link, so the form can't reveal who is registered.
          const token = newToken();
          db.sessions.set('candidate-link', sha(token), values.email, Date.now() + WELCOME_HOURS * 3600000);
          mailer.candidateRegistered(a, `${baseUrl}/account/verify/${token}`, WELCOME_HOURS, !updated);
          registerPage(res, { done: true, title: 'Check your email' });
        })
        .catch((e) => {
          console.error(e);
          drop();
          registerPage(res, { values, errors: ['Could not create your account. Please try again.'] }, 500);
        });
    });
  });

  // ---------- sign in ----------
  app.get('/account/login', (req, res) => {
    if (currentEmail(req)) return res.redirect('/account');
    page(res, 'account-login', { title: 'Sign in to your account', sent: false });
  });

  app.post('/account/login', limit('account-login', 5), sameOrigin, (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase().slice(0, 160);
    if (!EMAIL_RE.test(email)) return page(res, 'account-login', { title: 'Sign in to your account', sent: false, errors: ['Please enter a valid email.'] }, 400);
    // Only emails that have registered or applied get a link; the reply is identical either way.
    if (mine(email).length) {
      const token = newToken();
      db.sessions.set('candidate-link', sha(token), email, Date.now() + LINK_MINUTES * 60000);
      mailer.candidateSignIn(email, `${baseUrl}/account/verify/${token}`, LINK_MINUTES);
    }
    page(res, 'account-login', { title: 'Check your email', sent: true });
  });

  // GET shows a button (mail scanners prefetch links); POST consumes the token.
  app.get('/account/verify/:token', (req, res) => {
    const l = db.sessions.get('candidate-link', sha(req.params.token));
    if (!l) return page(res, 'account-login', { title: 'Link expired', sent: false, errors: ['That sign-in link has expired or was already used. Enter your email for a new one.'] }, 410);
    page(res, 'account-verify', { title: 'Sign in', email: l.subject });
  });

  app.post('/account/verify/:token', sameOrigin, (req, res) => {
    const key = sha(req.params.token);
    const l = db.sessions.get('candidate-link', key);
    db.sessions.delete('candidate-link', key);
    if (!l) return page(res, 'account-login', { title: 'Link expired', sent: false, errors: ['That sign-in link has expired or was already used. Enter your email for a new one.'] }, 410);
    const token = newToken();
    db.sessions.set('candidate', sha(token), l.subject, Date.now() + SESSION_DAYS * 86400000);
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: secureCookie, maxAge: SESSION_DAYS * 86400000, path: '/' });
    res.redirect('/account');
  });

  app.post('/account/logout', sameOrigin, (req, res) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) db.sessions.delete('candidate', sha(token));
    res.clearCookie(COOKIE, { path: '/' });
    res.redirect('/account/login');
  });

  // ---------- dashboard ----------
  app.get('/account', requireCandidate, (req, res) => {
    const email = req.candidateEmail;
    const jobs = getJobs();
    const now = Date.now();
    const apps = mine(email)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((a) => {
        const job = jobs.find((j) => j.id === a.jobId);
        const stage = a.withdrawnAt ? 'Withdrawn' : CANDIDATE_STAGE[a.status || 'New'] || 'Received';
        const interviews = (a.interviews || [])
          .filter((iv) => iv.status === 'scheduled' && new Date(iv.at).getTime() + iv.duration * 60000 > now)
          .sort((x, y) => x.at.localeCompare(y.at));
        return { id: a.id, jobTitle: a.jobTitle, jobId: job ? job.id : null, jobOpen: job ? job.status === 'open' : false, createdAt: a.createdAt, stage, stepIndex: STEPS.indexOf(stage), withdrawn: Boolean(a.withdrawnAt), closedOut: ['Hired', 'Rejected'].includes(a.status), hasResume: Boolean(a.resume), interviews };
      });
    const profile = profileFor(email);
    page(res, 'account', {
      title: 'My account', email, apps, steps: STEPS, profile,
      experienceOptions: EXPERIENCE, noticeOptions: NOTICE, msg: String(req.query.msg || ''), contracts: contractsFor(email),
      matches: jobsFor(email, profile), alerts: readSubmissions('job-alerts').filter((s) => s.email === email), categories: jobCategories(), locations: jobLocations(),
    });
  });

  // Open jobs that fit the profile: required skills they mention, then their
  // city (or remote). Jobs they've applied to and sample listings are left out.
  function jobsFor(email, profile) {
    const appliedTo = new Set(mine(email).filter((a) => !a.withdrawnAt).map((a) => a.jobId));
    const city = String(profile.location || '').toLowerCase();
    const near = (j) => j.mode === 'Remote' || (Boolean(city) && (city.includes(String(j.location).toLowerCase()) || String(j.location).toLowerCase().includes(city)));
    return getJobs()
      .filter((j) => j.status === 'open' && !isSample(j) && !appliedTo.has(j.id))
      .map((j) => {
        const m = skillMatch(profile, j);
        return { job: j, score: m ? m.score : 0, near: near(j), matched: m ? m.matched : [] };
      })
      .filter((x) => x.score > 0 || (x.near && city))
      .sort((x, y) => y.score + (y.near ? 25 : 0) - (x.score + (x.near ? 25 : 0)) || String(y.job.posted).localeCompare(String(x.job.posted)))
      .slice(0, 6);
  }

  // One-click apply with the details and resume already on file.
  app.post('/account/apply/:jobId', requireCandidate, limit('account-apply', 20), sameOrigin, (req, res, next) => {
    const job = getJobs().find((j) => j.id === req.params.jobId);
    if (!job) return next();
    const toJob = (msg) => res.redirect(`/jobs/${job.id}?msg=${encodeURIComponent(msg)}#apply`);
    if (job.status !== 'open' || isSample(job)) return toJob("This job isn't taking applications.");
    const account = accountForJob(req, job);
    if (account.applied) return toJob("You've already applied for this job.");
    if (account.missing.length) return toJob(`Add ${account.missing.join(' and ')} to your profile first.`);
    const profile = profileFor(req.candidateEmail);
    const data = { jobId: job.id, email: req.candidateEmail, source: 'account' };
    for (const k of PROFILE_FIELDS) if (profile[k]) data[k] = profile[k];
    // Each application keeps its own copy of the resume, so withdrawing or
    // replacing one never removes another's file.
    let file = null;
    if (profile.resume) {
      const ext = path.extname(profile.resume.file).toLowerCase();
      const filename = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
      try {
        fs.copyFileSync(path.join(uploadsDir, path.basename(profile.resume.file)), path.join(uploadsDir, filename));
        file = { path: path.join(uploadsDir, filename), filename, originalname: `resume${ext}` };
      } catch (e) {
        if (resumeNeeded(job)) return toJob("We couldn't find your resume. Upload it again in My account.");
      }
    }
    saveApplication(data, file, job, { oneClick: true })
      .then(({ app: a }) => {
        mailer.applicationReceived(a);
        back(res, `Applied for ${job.title}. A recruiter will be in touch within 2 working days.`);
      })
      .catch((e) => {
        console.error(e);
        toJob('Could not send your application. Please try again.');
      });
  });

  // Replace the resume on file. It's kept on their general application, so
  // future one-click applications use it; earlier applications keep theirs.
  app.post('/account/resume', requireCandidate, limit('account-resume', 10), sameOrigin, (req, res) => {
    upload.single('resume')(req, res, (err) => {
      if (err) return back(res, err.code === 'LIMIT_FILE_SIZE' ? 'Resume must be under 5 MB.' : `${err.message}.`);
      if (!req.file) return back(res, 'Choose a resume file to upload.');
      const profile = profileFor(req.candidateEmail);
      const data = { jobId: 'general', email: req.candidateEmail, source: 'account' };
      for (const k of PROFILE_FIELDS) if (profile[k]) data[k] = profile[k];
      saveApplication(data, req.file, null)
        .then(() => back(res, 'Resume updated. It will be used for your next applications.'))
        .catch((e) => {
          console.error(e);
          back(res, 'Could not save your resume. Please try again.');
        });
    });
  });

  // Job alerts set up from the account are on straight away: the email is already confirmed.
  app.post('/account/alerts', requireCandidate, limit('account-alerts', 20), sameOrigin, (req, res) => {
    const category = String(req.body.category || '');
    const location = String(req.body.location || '');
    if ((category && !jobCategories().includes(category)) || (location && !jobLocations().includes(location))) return back(res, 'Choose a category and city from the lists.');
    const subs = readSubmissions('job-alerts');
    const existing = subs.find((s) => s.email === req.candidateEmail && s.category === category && s.location === location);
    if (existing && existing.confirmed) return back(res, 'You already have that job alert.');
    const now = new Date().toISOString();
    if (existing) {
      Object.assign(existing, { confirmed: true, confirmedAt: now });
      writeSubmissions('job-alerts', subs);
    } else {
      saveSubmission('job-alerts', { email: req.candidateEmail, category, location, confirmed: true, confirmedAt: now, token: crypto.randomBytes(24).toString('hex') });
    }
    back(res, `Job alert on: we'll email you ${[category || 'all', 'jobs', location ? `in ${location}` : ''].filter(Boolean).join(' ')}.`);
  });

  app.post('/account/alerts/:id/delete', requireCandidate, limit('account-alerts', 20), sameOrigin, (req, res) => {
    const subs = readSubmissions('job-alerts');
    const rest = subs.filter((s) => !(s.id === req.params.id && s.email === req.candidateEmail));
    if (rest.length !== subs.length) writeSubmissions('job-alerts', rest);
    back(res, 'Job alert removed.');
  });

  // Right of access: everything the candidate gave us and what happened to it,
  // as a file they can keep. Recruiters' private notes and interview scorecards
  // are internal assessments and are not part of the download.
  app.get('/account/my-data.json', requireCandidate, (req, res) => {
    const email = req.candidateEmail;
    const subs = (type) => readSubmissions(type).filter((s) => String(s.email).toLowerCase() === email);
    const data = {
      exportedAt: new Date().toISOString(),
      about: `Your data held by ${site.name}. Questions or corrections: ${site.email}`,
      email,
      applications: mine(email).map((a) => ({
        job: a.jobTitle,
        appliedAt: a.createdAt,
        status: a.withdrawnAt ? 'Withdrawn' : CANDIDATE_STAGE[a.status || 'New'] || 'Received',
        details: Object.fromEntries(['name', 'phone', 'skills', 'experience', 'location', 'noticePeriod', 'linkedin', 'message', 'source'].filter((k) => a[k]).map((k) => [k, a[k]])),
        resumeFile: a.resume ? `Uploaded resume (${path.extname(a.resume).slice(1).toUpperCase()})` : null,
        skillsFoundInResume: a.resumeSkills || [],
        reappliedAt: a.reapplied || [],
        stageChanges: (a.history || []).map((h) => ({ at: h.at, from: CANDIDATE_STAGE[h.from] || h.from, to: CANDIDATE_STAGE[h.to] || h.to })),
        interviews: (a.interviews || []).map((iv) => ({ at: iv.at, durationMinutes: iv.duration, format: iv.mode, status: iv.status })),
        emailsSent: (a.emails || []).map((m) => ({ at: m.at, subject: m.subject })),
        sharedWithClient: a.shared ? { at: a.shared.sharedAt } : null,
        withdrawnAt: a.withdrawnAt || null,
      })),
      jobAlerts: subs('job-alerts').map((s) => ({ category: s.category || 'Any', location: s.location || 'Any', confirmed: Boolean(s.confirmed), since: s.createdAt })),
      newsletter: subs('newsletter').map((s) => ({ since: s.createdAt })),
    };
    res.set('Cache-Control', 'no-store').attachment(`my-data-${new Date().toISOString().slice(0, 10)}.json`).type('application/json').send(JSON.stringify(data, null, 2));
  });

  // A candidate's own uploaded resume.
  app.get('/account/resume/:appId', requireCandidate, (req, res, next) => {
    const a = mine(req.candidateEmail).find((x) => x.id === req.params.appId);
    if (!a || !a.resume) return next();
    const file = path.basename(a.resume);
    res.download(path.join(uploadsDir, file), `my-resume${path.extname(file)}`, (err) => err && !res.headersSent && res.status(404).end());
  });

  // Interview invite for the candidate's own calendar.
  app.get('/account/interviews/:appId/:ivId.ics', requireCandidate, (req, res, next) => {
    const a = mine(req.candidateEmail).find((x) => x.id === req.params.appId);
    const iv = a && (a.interviews || []).find((x) => x.id === req.params.ivId && x.status === 'scheduled');
    if (!iv) return next();
    res.type('text/calendar').attachment('interview.ics').send(interviewIcs({ method: 'REQUEST', interview: iv, candidate: a, jobTitle: a.jobTitle, site }));
  });

  // Profile changes apply to every application from this email, so recruiters
  // and skill matching see the latest details.
  app.post('/account/profile', requireCandidate, limit('account-profile', 20), sameOrigin, (req, res) => {
    const get = (k, max) => String(req.body[k] ?? '').trim().slice(0, max);
    const update = {
      name: get('name', 120),
      phone: get('phone', 20),
      skills: get('skills', 500),
      experience: EXPERIENCE.includes(req.body.experience) ? req.body.experience : '',
      location: get('location', 120),
      noticePeriod: NOTICE.includes(req.body.noticePeriod) ? req.body.noticePeriod : '',
      linkedin: get('linkedin', 300),
    };
    if (update.phone && !PHONE_RE.test(update.phone)) return back(res, 'Please enter a valid mobile number.');
    if (update.linkedin && !/^https?:\/\/[^\s"'<>]+$/i.test(update.linkedin)) return back(res, 'LinkedIn / portfolio must be a full link starting with https://');
    const list = readSubmissions('applications');
    let n = 0;
    for (const a of list) {
      if (String(a.email).toLowerCase() !== req.candidateEmail) continue;
      for (const [k, v] of Object.entries(update)) if (v) a[k] = v;
      a.profileUpdatedAt = new Date().toISOString();
      n++;
    }
    writeSubmissions('applications', list);
    back(res, `Profile updated on ${n} ${n === 1 ? 'application' : 'applications'}.`);
  });

  app.post('/account/applications/:id/withdraw', requireCandidate, limit('account-withdraw', 20), sameOrigin, (req, res, next) => {
    const list = readSubmissions('applications');
    const a = list.find((x) => x.id === req.params.id && String(x.email).toLowerCase() === req.candidateEmail);
    if (!a) return next();
    if (!a.withdrawnAt && !['Hired', 'Rejected'].includes(a.status)) {
      a.withdrawnAt = new Date().toISOString();
      // Cancel any interviews still on the calendar.
      for (const iv of a.interviews || []) if (iv.status === 'scheduled') { iv.status = 'cancelled'; iv.sequence = (iv.sequence || 0) + 1; iv.cancelledAt = a.withdrawnAt; }
      writeSubmissions('applications', list);
      mailer.applicationWithdrawn(a);
    }
    back(res, `You've withdrawn your application for ${a.jobTitle}.`);
  });

  // Right to erasure: remove every application and resume for this email.
  app.post('/account/delete', requireCandidate, limit('account-delete', 5), sameOrigin, (req, res) => {
    if (String(req.body.confirm || '').trim().toUpperCase() !== 'DELETE') return back(res, 'Type DELETE to confirm deleting your data.');
    const list = readSubmissions('applications');
    const keep = [];
    for (const a of list) {
      if (String(a.email).toLowerCase() === req.candidateEmail) {
        if (a.resume) fs.unlink(path.join(uploadsDir, path.basename(a.resume)), () => {});
      } else keep.push(a);
    }
    writeSubmissions('applications', keep);
    for (const type of ['job-alerts', 'newsletter']) {
      const subs = readSubmissions(type);
      const rest = subs.filter((s) => String(s.email).toLowerCase() !== req.candidateEmail);
      if (rest.length !== subs.length) writeSubmissions(type, rest);
    }
    db.sessions.deleteSubject('candidate', req.candidateEmail);
    res.clearCookie(COOKIE, { path: '/' });
    page(res, 'account-login', { title: 'Your data has been deleted', sent: false, deleted: true });
  });

  return { requireCandidate, currentEmail, accountForJob };
}

module.exports = { register, CANDIDATE_STAGE };
