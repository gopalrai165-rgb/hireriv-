// Candidate self-service ("My applications"): passwordless sign-in by emailed link,
// application tracking, interviews, profile updates, withdraw, and delete-my-data.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const COOKIE = 'hr_cand';
const LINK_MINUTES = 30;
const SESSION_DAYS = 7;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

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
  const { db, mailer, baseUrl, sameOrigin, limit, readSubmissions, writeSubmissions, uploadsDir, getJobs, formatIst, interviewIcs, site } = deps;
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

  const page = (res, view, locals, status = 200) => res.status(status).render(view, { page: 'account', noindex: true, errors: [], ...locals });
  const back = (res, msg) => res.redirect('/account?msg=' + encodeURIComponent(msg));

  // ---------- sign in ----------
  app.get('/account/login', (req, res) => {
    if (currentEmail(req)) return res.redirect('/account');
    page(res, 'account-login', { title: 'Track your applications', sent: false });
  });

  app.post('/account/login', limit('account-login', 5), sameOrigin, (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase().slice(0, 160);
    if (!EMAIL_RE.test(email)) return page(res, 'account-login', { title: 'Track your applications', sent: false, errors: ['Please enter a valid email.'] }, 400);
    // Only emails that have applied get a link; the reply is identical either way.
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
        return { id: a.id, jobTitle: a.jobTitle, jobId: job ? job.id : null, jobOpen: job ? job.status === 'open' : false, createdAt: a.createdAt, stage, stepIndex: STEPS.indexOf(stage), withdrawn: Boolean(a.withdrawnAt), closedOut: ['Hired', 'Rejected'].includes(a.status), interviews };
      });
    // Newest non-empty value of each field across all their applications, so a
    // later application with blanks never hides details given earlier.
    const latest = {};
    for (const a of mine(email).sort((x, y) => y.createdAt.localeCompare(x.createdAt))) {
      for (const k of ['name', 'skills', 'experience', 'location', 'noticePeriod', 'linkedin']) if (!latest[k] && a[k]) latest[k] = a[k];
    }
    page(res, 'account', {
      title: 'My applications', email, apps, steps: STEPS, profile: latest,
      experienceOptions: EXPERIENCE, noticeOptions: NOTICE, msg: String(req.query.msg || ''),
    });
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
      skills: get('skills', 500),
      experience: EXPERIENCE.includes(req.body.experience) ? req.body.experience : '',
      location: get('location', 120),
      noticePeriod: NOTICE.includes(req.body.noticePeriod) ? req.body.noticePeriod : '',
      linkedin: get('linkedin', 300),
    };
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
}

module.exports = { register, CANDIDATE_STAGE };
