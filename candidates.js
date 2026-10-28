// Candidate accounts: registration, sign-in by emailed link or an optional
// password (with reset), a structured profile (preferences, experience,
// education, skills, certifications, languages), up to three resumes, one-click
// applying, jobs that match the profile, job alerts, saved jobs, application
// tracking, interviews, privacy and contact settings, an activity log, and
// download / delete-my-data. A registration is also stored as a general
// application, so the team sees new sign-ups in Applications and the Talent
// pool like any CV. Pages live under /account; /candidate/* addresses lead there.
const crypto = require('crypto');
const fs = require('fs');
const vault = require('./vault');
const path = require('path');
const { jobPath } = require('./content');
const { hashPassword, checkPassword } = require('./employers');
const sms = require('./sms');
const identity = require('./identity');
const cp = require('./candidate-profile');
const resumePdf = require('./resume-pdf');

const COOKIE = 'hr_cand';
const LINK_MINUTES = 30;
const RESET_MINUTES = 30;
// Mobile sign-in codes: 6 digits, valid 10 minutes, 5 tries, 3 sent to one
// number in 15 minutes.
const OTP_MINUTES = 10;
const OTP_TRIES = 5;
const OTP_SENDS = 3;
const OTP_WINDOW_MS = 15 * 60 * 1000;
const WELCOME_HOURS = 24; // the link in the welcome email after registering
const SESSION_DAYS = 7;
const MAX_RESUMES = 3;
const ACTIVITY_DAYS = 365; // how long the account activity log is kept
// Wrong passwords for one email before password sign-in pauses for a while.
const MAX_FAILURES = 8;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = cp.PHONE_RE;
const PROFILE_FIELDS = ['name', 'phone', 'skills', 'experience', 'location', 'noticePeriod', 'linkedin'];
const { EXPERIENCE, NOTICE } = cp;

// What candidates see instead of internal pipeline names.
const CANDIDATE_STAGE = require('./ats').CANDIDATE_LABELS;
const STEPS = ['Received', 'Under review', 'Interview', 'Offer', 'Hired'];
// Shown in Settings → Recent activity.
const ACTIVITY_LABELS = {
  registered: 'Account created', 'signed-in': 'Signed in', 'sign-in-failed': 'Wrong password entered', 'signed-out': 'Signed out',
  'sessions-revoked': 'Signed out on all devices', 'password-set': 'Password set', 'password-changed': 'Password changed', 'password-reset': 'Password reset by email link',
  'profile-updated': 'Profile updated', 'resume-added': 'Resume uploaded', 'resume-made': 'Resume made from the profile', 'resume-removed': 'Resume deleted', 'settings-changed': 'Settings changed',
  'interview-confirmed': 'Interview confirmed', 'interview-reschedule': 'Asked for another interview time',
  'saved-search-added': 'Search saved', 'phone-verified': 'Mobile number confirmed', 'registered-mobile': 'Account created with your mobile number', 'email-added': 'Email address added',
};

// Indian mobile numbers as 10 digits (drops +91, 91 or a leading 0), or ''.
function mobileOf(value) {
  let d = String(value || '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : '';
}

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

// Where to go after signing in: only pages on this site that a candidate uses.
// Anything else (other sites, "//host", backslashes, sign-in pages) is dropped.
const NEXT_PREFIXES = ['/account', '/jobs', '/saved', '/candidate', '/notifications'];
function safeNext(value) {
  const s = String(value || '');
  if (!s || s.length > 300 || s[0] !== '/' || s.startsWith('//') || /[\\\s\x00-\x1f]/.test(s)) return '';
  let u;
  try { u = new URL(s, 'http://hireriv.invalid'); } catch (e) { return ''; }
  if (u.host !== 'hireriv.invalid') return '';
  if (!NEXT_PREFIXES.some((x) => u.pathname === x || u.pathname.startsWith(`${x}/`))) return '';
  if (/^\/(account|candidate)\/(login|logout|verify|reset|forgot|register|delete)/.test(u.pathname)) return '';
  return u.pathname + u.search + u.hash;
}

function passwordProblem(pw, confirm) {
  if (pw.length < 10) return 'Password must be at least 10 characters.';
  if (pw.length > 200) return 'Password is too long.';
  if (pw !== confirm) return "Passwords don't match.";
  return '';
}

function register(app, deps) {
  const { db, mailer, baseUrl, sameOrigin, limit, readSubmissions, writeSubmissions, uploadsDir, getJobs, interviewIcs, site, contractsFor } = deps;
  const { upload, saveApplication, isBot, isSample, isLive, resumeNeeded, skillMatch, saveSubmission, jobCategories, jobLocations, vetUpload, downloadLinks, linkExpired } = deps;
  const { jobTypes, modes, stateOf, interviewResponded, events, notify, push, recommendFor, privacy } = deps;
  const track = (event, label, req) => { if (deps.analytics) deps.analytics.track(event, label, req); };
  const secureCookie = /^https:/.test(baseUrl);

  // Mobile codes need a text-message provider on the live site; without one
  // they would only be saved to the outbox folder, so the option is hidden.
  const smsReady = () => sms.configured() || process.env.NODE_ENV !== 'production';
  const mine = (email) => readSubmissions('applications').filter((a) => String(a.email).toLowerCase() === email);
  const nowIso = () => new Date().toISOString();

  // ---------- the candidate record ----------
  const candidateOf = (email) => readSubmissions('candidates').find((c) => c.email === email) || null;
  function saveCandidate(c) {
    c.updatedAt = nowIso();
    const list = readSubmissions('candidates');
    const i = list.findIndex((x) => x.id === c.id);
    if (i === -1) saveSubmission('candidates', c);
    else { list[i] = c; writeSubmissions('candidates', list); }
    return c;
  }

  // The profile from applications alone: the newest non-empty value of each
  // field, and the newest resume. People who applied before accounts existed
  // start their profile from this.
  const newestFirst = (x, y) => String(y.updatedAt || y.createdAt).localeCompare(String(x.updatedAt || x.createdAt));
  function fromApplications(email) {
    const list = mine(email).sort(newestFirst);
    const flat = {};
    for (const a of list) for (const k of PROFILE_FIELDS) if (!flat[k] && a[k]) flat[k] = a[k];
    const withResume = list.find((a) => a.resume);
    return { flat, withResume };
  }

  // Creates the record the first time someone registers or signs in.
  function ensureCandidate(email) {
    const existing = candidateOf(email);
    if (existing) return existing;
    const { flat, withResume } = fromApplications(email);
    const city = String(flat.location || '').split(',')[0].trim();
    const profile = {
      ...cp.emptyProfile(),
      name: flat.name || '', phone: flat.phone || '', city, state: stateOf(city) || '', linkedin: flat.linkedin || '',
      experienceLevel: EXPERIENCE.includes(flat.experience) ? flat.experience : '',
      availability: { noticePeriod: NOTICE.includes(flat.noticePeriod) ? flat.noticePeriod : '', availableFrom: '' },
      skills: [...new Map(String(flat.skills || '').split(',').map((s) => s.trim().slice(0, 40)).filter(Boolean).map((s) => [s.toLowerCase(), s])).values()].slice(0, cp.LIMITS.skills),
    };
    const c = { id: crypto.randomUUID(), email, createdAt: nowIso(), emailVerifiedAt: null, passwordHash: null, profile, privacy: cp.defaultPrivacy(), comms: cp.defaultComms(), resumes: [], defaultResumeId: null };
    // Their newest resume becomes the first in their list (as a copy, so the
    // application keeps its own file).
    if (withResume) {
      const r = copyIntoLibrary(withResume.resume, 'Resume from your application', withResume.updatedAt || withResume.createdAt);
      if (r) { c.resumes.push(r); c.defaultResumeId = r.id; }
    }
    return saveCandidate(c);
  }

  function copyIntoLibrary(file, name, at) {
    const ext = path.extname(file).toLowerCase();
    const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
    try {
      fs.copyFileSync(path.join(uploadsDir, path.basename(file)), path.join(uploadsDir, filename));
      return { id: crypto.randomBytes(6).toString('hex'), file: filename, name, uploadedAt: at || nowIso(), size: fs.statSync(path.join(uploadsDir, filename)).size };
    } catch (e) {
      return null;
    }
  }

  // ---------- activity log ----------
  function activity(email, event, detail = '') {
    saveSubmission('candidate-activity', { email, event, detail: String(detail).slice(0, 200) });
  }
  function pruneActivity() {
    const cutoff = new Date(Date.now() - ACTIVITY_DAYS * 86400000).toISOString();
    const list = readSubmissions('candidate-activity');
    const keep = list.filter((e) => e.createdAt >= cutoff);
    if (keep.length !== list.length) writeSubmissions('candidate-activity', keep);
  }
  pruneActivity();
  setInterval(pruneActivity, 6 * 3600000).unref();

  // ---------- sessions & links ----------
  function currentEmail(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    const s = token && db.sessions.get('candidate', sha(token));
    return s ? s.subject : null;
  }
  function startSession(res, email) {
    const token = newToken();
    db.sessions.set('candidate', sha(token), email, Date.now() + SESSION_DAYS * 86400000);
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: secureCookie, maxAge: SESSION_DAYS * 86400000, path: '/' });
  }
  function endSession(req, res) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) db.sessions.delete('candidate', sha(token));
    res.clearCookie(COOKIE, { path: '/' });
  }
  // A one-time emailed link; `next` is where it leads after signing in.
  function issueLink(kind, email, minutes, next = '') {
    const token = newToken();
    const exp = Date.now() + minutes * 60000;
    db.sessions.set(kind, sha(token), email, exp);
    if (next) db.sessions.set(`${kind}-next`, sha(token), next, exp);
    return token;
  }
  function useLink(kind, token) {
    const key = sha(token);
    const l = db.sessions.get(kind, key);
    const n = db.sessions.get(`${kind}-next`, key);
    db.sessions.delete(kind, key);
    db.sessions.delete(`${kind}-next`, key);
    return l ? { email: l.subject, next: n ? safeNext(n.subject) : '' } : null;
  }

  const loginUrl = (next) => (next && next !== '/account' ? `/account/login?next=${encodeURIComponent(next)}` : '/account/login');
  const requireCandidate = (req, res, next) => {
    const email = currentEmail(req);
    if (!email) return res.redirect(loginUrl(req.method === 'GET' ? safeNext(req.originalUrl) : ''));
    req.candidateEmail = email;
    res.set('Cache-Control', 'no-store');
    next();
  };
  setInterval(() => db.sessions.purgeExpired(), 600000).unref();

  // ---------- the profile as the rest of the site uses it ----------
  // Flat details (as applications carry them) and the resume one-click
  // applying sends: the default resume from their list, else the newest one
  // from an application.
  function profileFor(email) {
    const c = candidateOf(email);
    const { flat, withResume } = fromApplications(email);
    const profile = { ...flat };
    if (c) for (const [k, v] of Object.entries(cp.applicationFields(c.profile))) if (v) profile[k] = v;
    const r = c && (c.resumes.find((x) => x.id === c.defaultResumeId) || c.resumes[0]);
    if (r) profile.resume = { id: r.id, file: r.file, at: r.uploadedAt, href: `/account/resumes/${r.id}` };
    else profile.resume = withResume ? { appId: withResume.id, file: withResume.resume, at: withResume.updatedAt || withResume.createdAt, href: `/account/resume/${withResume.id}` } : null;
    profile.resumeSkills = withResume ? withResume.resumeSkills || [] : [];
    return profile;
  }
  const profileContext = () => ({ categories: jobCategories(), cities: jobLocations(), types: jobTypes, modes });

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

  // One-tap apply from job lists: for a signed-in job seeker, which jobs they
  // already applied to and whether their profile has what a quick application
  // needs (jobs that need a resume also need one on file). Null when signed out.
  function oneTapFor(req) {
    const email = currentEmail(req);
    if (!email) return null;
    const profile = profileFor(email);
    const applied = new Set(mine(email).filter((a) => !a.withdrawnAt).map((a) => a.jobId));
    return { applied: [...applied], ready: Boolean(profile.name && profile.phone), hasResume: Boolean(profile.resume) };
  }

  // Saves profile changes, and copies the flat details onto every application
  // from this email so recruiters and matching see the latest.
  function updateProfile(email, patch) {
    const c = ensureCandidate(email);
    const kept = c.mobileOnly ? c.profile.phone : null;
    c.profile = cp.applyPatch(c.profile, patch);
    if (c.mobileOnly) c.profile.phone = kept;
    saveCandidate(c);
    const flat = cp.applicationFields(c.profile);
    const list = readSubmissions('applications');
    let n = 0;
    for (const a of list) {
      if (String(a.email).toLowerCase() !== email) continue;
      for (const [k, v] of Object.entries(flat)) if (v) a[k] = v;
      a.profileUpdatedAt = nowIso();
      n++;
    }
    if (n) writeSubmissions('applications', list);
    activity(email, 'profile-updated', Object.keys(patch).join(', '));
    return { candidate: c, applications: n };
  }

  const page = (res, view, locals, status = 200) => res.status(status).render(view, { page: 'account', noindex: true, errors: [], ...locals });
  const back = (res, msg, to = '/account') => res.redirect(`${to}?msg=${encodeURIComponent(msg)}`);
  const sendToNext = (res, next, fallback = '/account') => res.redirect(safeNext(next) || fallback);
  // The sub-navigation and completion meter every account page shows.
  function shell(email, tab) {
    const c = ensureCandidate(email);
    const profile = profileFor(email);
    return { email, tab, candidate: c, profile, completion: cp.completion(c.profile, { hasResume: Boolean(profile.resume) }) };
  }

  // ---------- register ----------
  const registerPage = (res, locals, status = 200) =>
    page(res, 'account-register', { title: 'Create your job-seeker account', values: {}, done: false, next: '', experienceOptions: EXPERIENCE, noticeOptions: NOTICE, method: 'email', codeStep: false, phone: '', smsReady: smsReady(), locations: jobLocations(), ...locals }, status);

  // Shared by the form and POST /api/auth/register. Returns errors, or [] once
  // the welcome email is on its way.
  function registerValues(body) {
    const get = (k, max) => String(body[k] ?? '').trim().slice(0, max);
    const values = {
      name: get('name', 120), email: get('email', 160).toLowerCase(), phone: get('phone', 20), location: get('location', 120),
      experience: EXPERIENCE.includes(body.experience) ? body.experience : '',
      noticePeriod: NOTICE.includes(body.noticePeriod) ? body.noticePeriod : '',
      skills: get('skills', 500), linkedin: get('linkedin', 300),
    };
    const errors = [];
    if (!values.name) errors.push('Please enter your name.');
    if (!EMAIL_RE.test(values.email)) errors.push('Please enter a valid email.');
    if (!PHONE_RE.test(values.phone)) errors.push('Please enter a valid mobile number.');
    if (values.linkedin && !/^https?:\/\/[^\s"'<>]+$/i.test(values.linkedin)) errors.push('LinkedIn / portfolio must be a full link starting with https://');
    if (!(body.agree === true || body.agree === '1' || body.agree === 'on' || body.agree === 'true')) errors.push('Please agree to the Privacy Policy and Terms of Use.');
    return { values, errors };
  }
  async function createAccount(values, file, { next = '', whatsapp = false, considered = false, req = null, source = 'registration form' } = {}) {
    const { app: a, updated } = await saveApplication({ jobId: 'general', ...values, source: 'account' }, file, null, { registeredAt: nowIso() });
    const c = ensureCandidate(values.email);
    // Consent is recorded for new accounts, one purpose at a time: agreeing to
    // the terms doesn't make the profile visible for other jobs or sign anyone
    // up for messages. An existing account keeps its settings.
    if (!c.consentAt) {
      c.consentAt = nowIso();
      c.comms.whatsapp = Boolean(whatsapp);
      c.privacy.visibleToRecruiters = Boolean(considered);
      saveCandidate(c);
      privacy.consent(c.email, 'account', true, source);
      privacy.consent(c.email, 'recruiter-visibility', Boolean(considered), source);
      privacy.consent(c.email, 'whatsapp', Boolean(whatsapp), source);
      activity(values.email, 'registered');
      track('candidate-registration', file ? 'With resume' : 'Without resume', req);
    }
    // The welcome email carries a sign-in link, so only the owner of the
    // address can open the account. Someone who already has one gets the same
    // reply and a fresh link, so the form can't reveal who is registered.
    const token = issueLink('candidate-link', values.email, WELCOME_HOURS * 60, next);
    mailer.candidateRegistered(a, `${baseUrl}/account/verify/${token}`, WELCOME_HOURS, !updated);
  }

  app.get('/account/register', (req, res) => {
    if (currentEmail(req)) return sendToNext(res, req.query.next);
    registerPage(res, { next: safeNext(req.query.next), method: req.query.with === 'phone' && smsReady() ? 'phone' : 'email' });
  });

  app.post('/account/register', limit('account-register', 5), sameOrigin, (req, res) => {
    upload.single('resume')(req, res, (err) => {
      const drop = () => req.file && fs.unlink(req.file.path, () => {});
      if (!err && isBot(req.body)) { drop(); return registerPage(res, { done: true, title: 'Check your email' }); }
      const { values, errors } = registerValues(req.body);
      const next = safeNext(req.body.next);
      if (err) errors.unshift(err.code === 'LIMIT_FILE_SIZE' ? 'Resume must be under 5 MB.' : `${err.message}.`);
      if (errors.length) { drop(); return registerPage(res, { values, errors, next }, 400); }
      vetUpload(req.file).then((bad) => {
        if (bad) return registerPage(res, { values, errors: [bad], next }, 400);
        return createAccount(values, req.file, { next, whatsapp: req.body.whatsapp === '1', considered: req.body.considered === '1', req }).then(() => registerPage(res, { done: true, title: 'Check your email' }));
      }).catch((e) => {
        console.error(e);
        drop();
        registerPage(res, { values, errors: ['Could not create your account. Please try again.'], next }, 500);
      });
    });
  });

  // ---------- sign in ----------
  const loginPage = (res, locals, status = 200) => page(res, 'account-login', { title: 'Sign in to your account', sent: false, next: '', email: '', method: 'email', phone: '', codeSent: false, smsReady: smsReady(), ...locals }, status);
  app.get('/account/login', (req, res) => {
    if (currentEmail(req)) return sendToNext(res, req.query.next);
    loginPage(res, { next: safeNext(req.query.next), method: req.query.with === 'phone' ? 'phone' : 'email' });
  });

  // Wrong passwords per email (in memory). Unknown emails count the same way,
  // so the lock-out can't reveal who has an account.
  const failures = new Map();
  const recentFailures = (email) => (failures.get(email) || []).filter((t) => t > Date.now() - FAILURE_WINDOW_MS);
  // Checks an email and password. Returns { email } or { status, error }.
  function passwordSignIn(emailInput, password) {
    const email = String(emailInput || '').trim().toLowerCase().slice(0, 160);
    const wrong = { status: 401, error: 'That email and password don’t match. Check them, or sign in with an email link instead.' };
    if (!EMAIL_RE.test(email) || !password) return { status: 400, error: 'Enter your email and password.' };
    if (recentFailures(email).length >= MAX_FAILURES) return { status: 429, error: 'Too many wrong passwords. Wait 15 minutes, or sign in with an email link instead.' };
    const c = candidateOf(email);
    // Hash even when there's no account, so the reply takes as long either way.
    const ok = c && c.passwordHash ? checkPassword(String(password).slice(0, 200), c.passwordHash) : (hashPassword(String(password).slice(0, 200)), false);
    if (!ok) {
      failures.set(email, [...recentFailures(email), Date.now()]);
      if (c) activity(email, 'sign-in-failed');
      return wrong;
    }
    failures.delete(email);
    if (!c.emailVerifiedAt) {
      const token = issueLink('candidate-link', email, LINK_MINUTES);
      mailer.candidateSignIn(email, `${baseUrl}/account/verify/${token}`, LINK_MINUTES);
      return { status: 403, error: 'Please confirm your email first. We’ve sent you a new link.' };
    }
    return { email };
  }
  setInterval(() => { for (const [k] of failures) if (!recentFailures(k).length) failures.delete(k); }, FAILURE_WINDOW_MS).unref();

  app.post('/account/login', limit('account-login', 10), sameOrigin, (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase().slice(0, 160);
    const next = safeNext(req.body.next);
    if (req.body.password !== undefined) {
      const r = passwordSignIn(email, String(req.body.password || ''));
      if (r.error) return loginPage(res, { errors: [r.error], next, email }, r.status);
      startSession(res, r.email);
      activity(r.email, 'signed-in', 'password');
      return sendToNext(res, next);
    }
    if (!EMAIL_RE.test(email)) return loginPage(res, { errors: ['Please enter a valid email.'], next }, 400);
    // Only emails that have registered or applied get a link; the reply is identical either way.
    if (candidateOf(email) || mine(email).length) {
      const token = issueLink('candidate-link', email, LINK_MINUTES, next);
      mailer.candidateSignIn(email, `${baseUrl}/account/verify/${token}`, LINK_MINUTES);
    }
    loginPage(res, { title: 'Check your email', sent: true });
  });

  // GET shows a button (mail scanners prefetch links); POST consumes the token.
  const expiredLink = (res) => loginPage(res, { title: 'Link expired', errors: ['That sign-in link has expired or was already used. Enter your email for a new one.'] }, 410);
  app.get('/account/verify/:token', (req, res) => {
    const l = db.sessions.get('candidate-link', sha(req.params.token));
    if (!l) return expiredLink(res);
    page(res, 'account-verify', { title: 'Sign in', email: l.subject });
  });

  // Using an emailed link confirms the address.
  function signInWithLink(token, res) {
    const l = useLink('candidate-link', token);
    if (!l) return null;
    const c = ensureCandidate(l.email);
    const firstTime = !c.emailVerifiedAt;
    if (firstTime) { c.emailVerifiedAt = nowIso(); saveCandidate(c); }
    startSession(res, l.email);
    activity(l.email, 'signed-in', 'email link');
    return { ...l, welcome: firstTime && !c.passwordHash };
  }
  app.post('/account/verify/:token', sameOrigin, (req, res) => {
    const l = signInWithLink(req.params.token, res);
    if (!l) return expiredLink(res);
    if (l.welcome) track('candidate-verified', '', req);
    sendToNext(res, l.next, l.welcome ? '/account?welcome=1' : '/account');
  });

  app.post('/account/logout', sameOrigin, (req, res) => {
    const email = currentEmail(req);
    endSession(req, res);
    if (email) activity(email, 'signed-out');
    res.redirect('/account/login');
  });

  // ---------- sign in with a mobile code ----------
  // Only a number the job seeker confirmed with a code while signed in (in
  // Settings) can sign in, so a mistyped number on a profile never opens
  // someone else's account. The reply is the same whether or not the number
  // is on an account, and codes are kept only as hashes.
  const phoneConfirmed = (c) => Boolean(c && (c.emailVerifiedAt || c.mobileOnly) && c.phoneVerified && c.phoneVerified.phone === mobileOf(c.profile && c.profile.phone));
  const accountsForMobile = (mobile) => readSubmissions('candidates').filter((c) => phoneConfirmed(c) && c.phoneVerified.phone === mobile);
  const otpSends = new Map();
  const otpTries = new Map();
  const recentSends = (mobile) => (otpSends.get(mobile) || []).filter((t) => t > Date.now() - OTP_WINDOW_MS);
  setInterval(() => { for (const [k] of otpSends) if (!recentSends(k).length) otpSends.delete(k); }, OTP_WINDOW_MS).unref();
  // Counts a code for this number; false when it has had too many lately.
  function countSend(mobile) {
    if (recentSends(mobile).length >= OTP_SENDS) return false;
    otpSends.set(mobile, [...recentSends(mobile), Date.now()]);
    return true;
  }
  // Sends a code for `purpose` (signing in, or confirming the number on an account).
  function sendCode(purpose, mobile, key) {
    if (!countSend(mobile)) return false;
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    db.sessions.set(purpose, key, sha(`${key}:${code}`), Date.now() + OTP_MINUTES * 60000);
    otpTries.delete(`${purpose}:${key}`);
    sms.send(`+91${mobile}`, `${code} is your ${site.name} code. It expires in ${OTP_MINUTES} minutes. Never share it with anyone, including ${site.name} staff.`, { code });
    return true;
  }
  // True once, for the right code. Wrong codes count, and the fifth ends it.
  function checkCode(purpose, key, code) {
    const s = db.sessions.get(purpose, key);
    const n = (otpTries.get(`${purpose}:${key}`) || 0) + 1;
    otpTries.set(`${purpose}:${key}`, n);
    if (!s || n > OTP_TRIES) { db.sessions.delete(purpose, key); return false; }
    const typed = String(code || '').trim();
    const ok = /^\d{6}$/.test(typed) && crypto.timingSafeEqual(Buffer.from(s.subject), Buffer.from(sha(`${key}:${typed}`)));
    if (ok) { db.sessions.delete(purpose, key); otpTries.delete(`${purpose}:${key}`); }
    return ok;
  }

  const phonePage = (res, locals, status = 200) => loginPage(res, { method: 'phone', ...locals }, status);
  app.post('/account/login/phone', limit('account-otp', 10), sameOrigin, (req, res) => {
    if (!smsReady()) return loginPage(res, { errors: ['Signing in with a mobile code isn’t available right now. Sign in with your email.'] }, 503);
    const mobile = mobileOf(req.body.phone);
    const next = safeNext(req.body.next);
    if (!mobile) return phonePage(res, { errors: ['Enter your 10-digit mobile number.'], next, phone: String(req.body.phone || '').slice(0, 20) }, 400);
    // A number on no account is counted the same way, so the replies match.
    const sent = accountsForMobile(mobile).length ? sendCode('candidate-otp', mobile, sha(`mobile:${mobile}`)) : countSend(mobile);
    if (!sent) return phonePage(res, { errors: ['Too many codes for this number. Wait 15 minutes, or sign in with your email.'], next, phone: mobile }, 429);
    phonePage(res, { codeSent: true, next, phone: mobile, title: 'Enter your code' });
  });
  app.post('/account/login/phone/verify', limit('account-otp-check', 20), sameOrigin, (req, res) => {
    const mobile = mobileOf(req.body.phone);
    const next = safeNext(req.body.next);
    if (!mobile) return phonePage(res, { errors: ['Enter your 10-digit mobile number.'], next }, 400);
    if (!checkCode('candidate-otp', sha(`mobile:${mobile}`), req.body.code)) {
      return phonePage(res, { codeSent: true, next, phone: mobile, title: 'Enter your code', errors: ['That code is wrong or has expired. Check it, or ask for a new one.'] }, 401);
    }
    const accounts = accountsForMobile(mobile);
    if (accounts.length !== 1) return loginPage(res, { errors: ['This number is on more than one account. Sign in with your email instead.'], next }, 409);
    startSession(res, accounts[0].email);
    activity(accounts[0].email, 'signed-in', 'mobile code');
    sendToNext(res, next);
  });

  // ---------- sign up with only a mobile number ----------
  // Name, mobile and consent, then a code by text message. The details wait
  // (with the code's hash) until the code is entered. A number already
  // confirmed on an account signs in to that account instead of making a
  // second one, and the reply is the same either way.
  const SIGNUP_FIELDS = ['name', 'location', 'whatsapp', 'considered'];
  const signupKey = (mobile) => sha(`signup:${mobile}`);
  const registerPhonePage = (res, locals, status = 200) => registerPage(res, { method: 'phone', ...locals }, status);
  app.post('/account/register/phone', limit('account-register-phone', 5), sameOrigin, (req, res) => {
    const next = safeNext(req.body.next);
    if (isBot(req.body)) return registerPhonePage(res, { codeStep: true, phone: '', next });
    const values = { name: String(req.body.name || '').trim().slice(0, 120), location: String(req.body.location || '').trim().slice(0, 120), phone: String(req.body.phone || '').trim().slice(0, 20), whatsapp: req.body.whatsapp === '1', considered: req.body.considered === '1' };
    const mobile = mobileOf(values.phone);
    const errors = [];
    if (!smsReady()) errors.push('Signing up with a mobile code isn’t available right now. Use your email instead.');
    if (!values.name) errors.push('Please enter your name.');
    if (!mobile) errors.push('Enter your 10-digit mobile number.');
    if (req.body.agree !== '1') errors.push('Please agree to the Privacy Policy and Terms to create an account.');
    if (errors.length) return registerPhonePage(res, { values, errors, next }, 400);
    if (!countSend(mobile)) return registerPhonePage(res, { values, errors: ['Too many codes for this number. Wait 15 minutes and try again.'], next }, 429);
    // countSend was used above, so send without counting twice.
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const exp = Date.now() + OTP_MINUTES * 60000;
    db.sessions.set('candidate-signup', signupKey(mobile), sha(`${signupKey(mobile)}:${code}`), exp);
    db.sessions.set('candidate-signup-data', signupKey(mobile), JSON.stringify(Object.fromEntries(SIGNUP_FIELDS.map((k) => [k, values[k]]))), exp);
    otpTries.delete(`candidate-signup:${signupKey(mobile)}`);
    sms.send(`+91${mobile}`, `${code} is your ${site.name} code. It expires in ${OTP_MINUTES} minutes. Never share it with anyone, including ${site.name} staff.`, { code });
    registerPhonePage(res, { codeStep: true, phone: mobile, next, title: 'Enter your code' });
  });
  app.post('/account/register/phone/verify', limit('account-otp-check', 20), sameOrigin, async (req, res) => {
    const mobile = mobileOf(req.body.phone);
    const next = safeNext(req.body.next);
    const again = (msg, status) => registerPhonePage(res, { codeStep: true, phone: mobile, next, title: 'Enter your code', errors: [msg] }, status);
    if (!mobile) return registerPhonePage(res, { errors: ['Enter your 10-digit mobile number.'], next }, 400);
    const key = signupKey(mobile);
    const pending = db.sessions.get('candidate-signup-data', key);
    if (!checkCode('candidate-signup', key, req.body.code)) return again('That code is wrong or has expired. Check it, or start again for a new one.', 401);
    db.sessions.delete('candidate-signup-data', key);
    // Already confirmed on an account: that account, not a new one.
    const existing = accountsForMobile(mobile);
    if (existing.length === 1) {
      startSession(res, existing[0].email);
      activity(existing[0].email, 'signed-in', 'mobile code');
      return sendToNext(res, next);
    }
    if (existing.length > 1) return loginPage(res, { errors: ['This number is on more than one account. Sign in with your email instead.'], next }, 409);
    let details = {};
    try { details = JSON.parse((pending && pending.subject) || '{}'); } catch (e) { details = {}; }
    if (!details.name) return again('Those details have expired. Please start again.', 410);
    const email = identity.mobileEmail(mobile);
    try {
      if (!candidateOf(email)) {
        await saveApplication({ jobId: 'general', name: details.name, email, phone: mobile, location: details.location || '', source: 'account' }, null, null, { registeredAt: nowIso() });
        const c = ensureCandidate(email);
        Object.assign(c, { mobileOnly: true, phoneVerified: { phone: mobile, at: nowIso() }, consentAt: nowIso() });
        c.comms.whatsapp = Boolean(details.whatsapp);
        c.privacy.visibleToRecruiters = Boolean(details.considered);
        saveCandidate(c);
        privacy.consent(email, 'account', true, 'mobile registration');
        privacy.consent(email, 'recruiter-visibility', Boolean(details.considered), 'mobile registration');
        privacy.consent(email, 'whatsapp', Boolean(details.whatsapp), 'mobile registration');
        activity(email, 'registered-mobile');
        track('candidate-registration', 'Mobile only', req);
      }
    } catch (e) {
      console.error(e);
      return again('Could not create your account. Please try again.', 500);
    }
    startSession(res, email);
    activity(email, 'signed-in', 'mobile code');
    sendToNext(res, next, '/account?welcome=1');
  });

  // Confirming the mobile number on the account (Settings) turns on signing
  // in with it. Changing the number on the profile turns it off again.
  app.post('/account/phone/send', requireCandidate, limit('account-otp', 10), sameOrigin, (req, res) => {
    const c = ensureCandidate(req.candidateEmail);
    const mobile = mobileOf(c.profile.phone);
    if (!smsReady()) return back(res, 'Text messages aren’t available right now. Please try again later.', '/account/settings');
    if (!mobile) return back(res, 'Add a 10-digit Indian mobile number to your profile first.', '/account/settings');
    if (!sendCode('candidate-phone', mobile, sha(`confirm:${c.id}:${mobile}`))) return back(res, 'Too many codes for this number. Wait 15 minutes and try again.', '/account/settings');
    res.redirect('/account/settings?code=sent#mobile');
  });
  app.post('/account/phone/verify', requireCandidate, limit('account-otp-check', 20), sameOrigin, (req, res) => {
    const c = ensureCandidate(req.candidateEmail);
    const mobile = mobileOf(c.profile.phone);
    if (!mobile || !checkCode('candidate-phone', sha(`confirm:${c.id}:${mobile}`), req.body.code)) {
      return res.redirect(`/account/settings?code=sent&msg=${encodeURIComponent('That code is wrong or has expired. Check it, or send a new one.')}#mobile`);
    }
    if (accountsForMobile(mobile).some((x) => x.id !== c.id)) return back(res, 'This number is already confirmed on another account. Sign in with it to use that account.', '/account/settings');
    c.phoneVerified = { phone: mobile, at: nowIso() };
    saveCandidate(c);
    activity(c.email, 'phone-verified');
    back(res, 'Mobile number confirmed. You can now sign in with a code sent to it.', '/account/settings');
  });

  // ---------- forgot / reset password ----------
  app.get('/account/forgot', (req, res) => page(res, 'account-forgot', { title: 'Reset your password', sent: false }));
  app.post('/account/forgot', limit('account-forgot', 5), sameOrigin, (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase().slice(0, 160);
    if (!EMAIL_RE.test(email)) return page(res, 'account-forgot', { title: 'Reset your password', sent: false, errors: ['Please enter a valid email.'] }, 400);
    // Same reply whether or not there's an account.
    if (candidateOf(email) || mine(email).length) {
      const token = issueLink('candidate-reset', email, RESET_MINUTES);
      mailer.candidatePasswordReset(email, `${baseUrl}/account/reset/${token}`, RESET_MINUTES);
    }
    page(res, 'account-forgot', { title: 'Check your email', sent: true });
  });
  const expiredReset = (res) => page(res, 'account-forgot', { title: 'Link expired', sent: false, errors: ['That reset link has expired or was already used. Ask for a new one below.'] }, 410);
  app.get('/account/reset/:token', (req, res) => {
    const l = db.sessions.get('candidate-reset', sha(req.params.token));
    if (!l) return expiredReset(res);
    page(res, 'account-reset', { title: 'Choose a new password', email: l.subject });
  });
  app.post('/account/reset/:token', limit('account-reset', 10), sameOrigin, (req, res) => {
    const l = db.sessions.get('candidate-reset', sha(req.params.token));
    if (!l) return expiredReset(res);
    const problem = passwordProblem(String(req.body.password || ''), String(req.body.confirm || ''));
    if (problem) return page(res, 'account-reset', { title: 'Choose a new password', email: l.subject, errors: [problem] }, 400);
    useLink('candidate-reset', req.params.token);
    const c = ensureCandidate(l.subject);
    // The link came to their inbox, so the email is confirmed too.
    Object.assign(c, { passwordHash: hashPassword(String(req.body.password)), passwordSetAt: nowIso(), emailVerifiedAt: c.emailVerifiedAt || nowIso() });
    saveCandidate(c);
    failures.delete(c.email);
    db.sessions.deleteSubject('candidate', c.email);
    db.sessions.deleteSubject('candidate-reset', c.email);
    startSession(res, c.email);
    activity(c.email, 'password-reset');
    mailer.candidatePasswordChanged(c.email, 'reset');
    events.accountSecurity(c.email, 'Password reset', 'Your password was reset with an email link. Wasn\'t you? Reset it again and tell us.');
    back(res, 'New password saved. You are signed in.');
  });

  // ---------- dashboard ----------
  const stageOf = (a) => (a.withdrawnAt ? 'Withdrawn' : CANDIDATE_STAGE[a.status || 'New'] || 'Received');
  const upcoming = (iv, now) => iv.status === 'scheduled' && new Date(iv.at).getTime() + iv.duration * 60000 > now;

  app.get('/account', requireCandidate, (req, res) => {
    const email = req.candidateEmail;
    const jobs = getJobs();
    const now = Date.now();
    const apps = mine(email)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((a) => {
        const job = jobs.find((j) => j.id === a.jobId);
        const stage = stageOf(a);
        const interviews = (a.interviews || []).filter((iv) => upcoming(iv, now)).sort((x, y) => x.at.localeCompare(y.at));
        return { id: a.id, jobTitle: a.jobTitle, job: job && isLive(job) ? job : null, createdAt: a.createdAt, stage, stepIndex: STEPS.indexOf(stage), withdrawn: Boolean(a.withdrawnAt), closedOut: ['Hired', 'Rejected'].includes(a.status), hasResume: Boolean(a.resume), interviews };
      });
    const s = shell(email, 'dashboard');
    page(res, 'account', {
      title: 'My account', ...s, apps, steps: STEPS,
      msg: String(req.query.msg || ''), welcome: req.query.welcome === '1' && !s.candidate.passwordHash, contracts: contractsFor(email),
      matches: recommendFor(email, { limit: 6 }), alerts: readSubmissions('job-alerts').filter((x) => x.email === email), categories: jobCategories(), locations: jobLocations(),
      savedCount: savedOf(email).length,
    });
  });

  // ---------- profile ----------
  app.get('/account/profile', requireCandidate, (req, res) => {
    const s = shell(req.candidateEmail, 'profile');
    page(res, 'account-profile', {
      title: 'Your profile', ...s, msg: String(req.query.msg || ''), ctx: profileContext(), opts: cp, maxResumes: MAX_RESUMES,
    });
  });

  // The profile page's sections, each saved on its own.
  const lines = (v) => String(v || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const SECTION_INPUT = {
    basics: (b) => ({ name: b.name, phone: b.phone, city: b.city, state: b.state, headline: b.headline, linkedin: b.linkedin, experienceLevel: b.experienceLevel }),
    preferences: (b) => ({
      preferences: { roles: b.roles, categories: b.categories, locations: b.locations, types: b.types, arrangements: b.arrangements, shifts: b.shifts, relocate: b.relocate },
      salary: { expected: b.salaryExpected, period: b.salaryPeriod },
      availability: { noticePeriod: b.noticePeriod, availableFrom: b.availableFrom },
    }),
    skills: (b) => ({
      skills: b.skills,
      certifications: lines(b.certifications),
      languages: [0, 1, 2, 3].map((i) => ({ name: b[`language${i}`], level: b[`languageLevel${i}`] })).filter((l) => String(l.name || '').trim()),
    }),
  };
  app.post('/account/profile/:section', requireCandidate, limit('account-profile', 40), sameOrigin, (req, res, next) => {
    const email = req.candidateEmail;
    const c = ensureCandidate(email);
    const to = (msg, hash) => res.redirect(`/account/profile?msg=${encodeURIComponent(msg)}#${hash}`);
    let input;
    const section = req.params.section;
    if (SECTION_INPUT[section]) input = SECTION_INPUT[section](req.body);
    else if (section === 'experience') {
      input = { experiences: [{ title: req.body.title, company: req.body.company, from: req.body.from, to: req.body.to, current: req.body.current, summary: req.body.summary }, ...c.profile.experiences] };
    } else if (section === 'education') {
      input = { education: [...c.profile.education, { level: req.body.level, course: req.body.course, institution: req.body.institution, year: req.body.year }] };
    } else return next();
    // A mobile-only account's number is its sign-in and isn't on the form.
    if (c.mobileOnly && 'phone' in input) input.phone = c.profile.phone;
    const { patch, errors } = cp.parsePatch(input, profileContext());
    if (errors.length) return to(errors.join(' '), section);
    updateProfile(email, patch);
    to(section === 'experience' ? 'Job added to your experience.' : section === 'education' ? 'Education added.' : 'Saved.', section);
  });
  // Removing one entry from experience or education.
  app.post('/account/profile/:section/:id/delete', requireCandidate, limit('account-profile', 40), sameOrigin, (req, res, next) => {
    const key = { experience: 'experiences', education: 'education' }[req.params.section];
    if (!key) return next();
    const c = ensureCandidate(req.candidateEmail);
    const rest = c.profile[key].filter((e) => e.id !== req.params.id);
    if (rest.length !== c.profile[key].length) updateProfile(req.candidateEmail, { [key]: rest });
    res.redirect(`/account/profile?msg=${encodeURIComponent('Removed.')}#${req.params.section}`);
  });

  // The short profile form (older pages and links): blank fields are left as they were.
  app.post('/account/profile', requireCandidate, limit('account-profile', 40), sameOrigin, (req, res) => {
    const get = (k, max) => String(req.body[k] ?? '').trim().slice(0, max);
    const input = {};
    if (get('name', 120)) input.name = get('name', 120);
    if (get('phone', 20)) input.phone = get('phone', 20);
    if (get('skills', 500)) input.skills = get('skills', 500);
    if (EXPERIENCE.includes(req.body.experience)) input.experienceLevel = req.body.experience;
    if (get('location', 120)) { input.city = get('location', 80); }
    if (get('linkedin', 300)) input.linkedin = get('linkedin', 300);
    if (NOTICE.includes(req.body.noticePeriod)) input.availability = { ...ensureCandidate(req.candidateEmail).profile.availability, noticePeriod: req.body.noticePeriod };
    const { patch, errors } = cp.parsePatch(input, profileContext());
    if (errors.length) return back(res, errors.join(' '));
    const { applications: n } = updateProfile(req.candidateEmail, patch);
    back(res, `Profile updated on ${n} ${n === 1 ? 'application' : 'applications'}.`);
  });

  // ---------- resumes ----------
  // Upload: checked, kept in their list (up to three, newest is the default),
  // and attached to their general application so recruiters see the latest.
  function addResume(req, res, done) {
    upload.single('resume')(req, res, (err) => {
      if (err) return done(err.code === 'LIMIT_FILE_SIZE' ? 'Resume must be under 5 MB.' : `${err.message}.`);
      if (!req.file) return done('Choose a resume file to upload.');
      storeResume(req.candidateEmail, req.file, done);
    });
  }
  // A resume file already in the uploads folder (uploaded, or made by the
  // resume builder): checked, kept in their list and attached to their
  // general application. `file` is { path, filename, originalname }.
  function storeResume(email, file, done, { what = 'resume-added' } = {}) {
    const drop = () => fs.unlink(file.path, () => {});
    const c = ensureCandidate(email);
    if (c.resumes.length >= MAX_RESUMES) { drop(); return done(`You can keep up to ${MAX_RESUMES} resumes. Delete one first.`); }
    vetUpload(file).then(async (bad) => {
      if (bad) return done(bad);
      const original = path.basename(String(file.originalname || 'resume')).replace(/[^\w .()-]+/g, '').slice(0, 80) || 'Resume';
      const r = copyIntoLibrary(file.filename, original, nowIso());
      if (!r) { drop(); return done('Could not save your resume. Please try again.'); }
      const data = { jobId: 'general', email, source: 'account' };
      const profile = profileFor(email);
      for (const k of PROFILE_FIELDS) if (profile[k]) data[k] = profile[k];
      const { app: a } = await saveApplication(data, file, null);
      r.appFile = a.resume;
      const fresh = candidateOf(email);
      fresh.resumes.unshift(r);
      fresh.defaultResumeId = r.id;
      saveCandidate(fresh);
      activity(email, what, original);
      done(null, r);
    }).catch((e) => {
      console.error(e);
      done('Could not save your resume. Please try again.');
    });
  }
  // Deleting one removes its file; if it's the copy recruiters see on the
  // general application, that goes too. Applications already sent keep theirs.
  function deleteResume(email, id) {
    const c = ensureCandidate(email);
    const r = c.resumes.find((x) => x.id === id);
    if (!r) return false;
    fs.unlink(path.join(uploadsDir, path.basename(r.file)), () => {});
    c.resumes = c.resumes.filter((x) => x.id !== id);
    if (c.defaultResumeId === id) c.defaultResumeId = c.resumes[0] ? c.resumes[0].id : null;
    saveCandidate(c);
    if (r.appFile) {
      const list = readSubmissions('applications');
      const general = list.find((a) => String(a.email).toLowerCase() === email && a.jobId === 'general' && a.resume === r.appFile);
      if (general) {
        fs.unlink(path.join(uploadsDir, path.basename(general.resume)), () => {});
        Object.assign(general, { resume: '', resumeText: '', resumeSkills: [] });
        writeSubmissions('applications', list);
      }
    }
    activity(email, 'resume-removed', r.name);
    return true;
  }
  const resumeView = (c) => c.resumes.map((r) => ({ id: r.id, name: r.name, uploadedAt: r.uploadedAt, size: r.size, isDefault: r.id === c.defaultResumeId }));

  for (const resumePath of ['/account/resume', '/account/resumes']) {
    app.post(resumePath, requireCandidate, limit('account-resume', 10), sameOrigin, (req, res) => {
      const to = resumePath === '/account/resume' ? '/account' : '/account/profile';
      addResume(req, res, (err) => (err ? back(res, err, to) : back(res, 'Resume updated. It will be used for your next applications.', to)));
    });
  }
  app.post('/account/resumes/:id/default', requireCandidate, limit('account-resume', 20), sameOrigin, (req, res, next) => {
    const c = ensureCandidate(req.candidateEmail);
    if (!c.resumes.some((r) => r.id === req.params.id)) return next();
    c.defaultResumeId = req.params.id;
    saveCandidate(c);
    back(res, 'That resume will be sent with your next applications.', '/account/profile');
  });
  app.post('/account/resumes/:id/delete', requireCandidate, limit('account-resume', 20), sameOrigin, (req, res, next) => {
    if (!deleteResume(req.candidateEmail, req.params.id)) return next();
    back(res, 'Resume deleted. Applications you already sent keep the resume they were sent with.', '/account/profile');
  });
  app.get('/account/resumes/:id', requireCandidate, (req, res, next) => {
    const c = candidateOf(req.candidateEmail);
    const r = c && c.resumes.find((x) => x.id === req.params.id);
    if (!r) return next();
    if (!downloadLinks.valid(req)) return linkExpired(res, '/account/profile');
    vault.send(res, path.join(uploadsDir, path.basename(r.file)), `my-resume${path.extname(r.file)}`, 'Own resume');
  });

  // ---------- resume builder ----------
  // A resume made from the profile (resume-pdf.js) for people who don't have
  // one: previewed on the page, downloaded, or saved to their resumes, where
  // it is checked, encrypted and sent with applications like an upload.
  const SUMMARY_MAX = 600;
  function builderInput(req) {
    const c = ensureCandidate(req.candidateEmail);
    const p = c.profile || cp.emptyProfile();
    const summary = req.method === 'POST' ? String(req.body.summary ?? '').trim().replace(/\s+/g, ' ').slice(0, SUMMARY_MAX) : ((c.builder && c.builder.summary) || '');
    const email = identity.isMobileOnly(req.candidateEmail) ? '' : req.candidateEmail;
    const contact = [[p.city, p.state].filter(Boolean).join(', '), p.phone, email, p.linkedin];
    return { c, p, summary, contact };
  }
  const builderPage = (req, res, { status = 200, errors = [] } = {}) => {
    const { c, p, summary, contact } = builderInput(req);
    const made = resumePdf.build(p, { summary });
    page(res, 'account-resume-builder', {
      title: 'Make a resume', tab: 'profile', email: req.candidateEmail, candidate: c, msg: String(req.query.msg || ''), errors,
      summary, summaryMax: SUMMARY_MAX, sections: resumePdf.sections(p, { summary }), gaps: resumePdf.gaps(p), dropped: made.dropped,
      contact: contact.filter(Boolean), full: c.resumes.length >= MAX_RESUMES, maxResumes: MAX_RESUMES,
    }, status);
  };
  const keepSummary = (c, summary) => {
    const fresh = candidateOf(c.email) || c;
    fresh.builder = { summary, updatedAt: nowIso() };
    saveCandidate(fresh);
  };
  app.get('/account/resume-builder', requireCandidate, (req, res) => builderPage(req, res));
  app.post('/account/resume-builder', requireCandidate, limit('resume-builder', 30), sameOrigin, (req, res) => {
    const { c, summary } = builderInput(req);
    keepSummary(c, summary);
    res.redirect(303, '/account/resume-builder');
  });
  app.post('/account/resume-builder/download', requireCandidate, limit('resume-builder', 30), sameOrigin, (req, res) => {
    const { c, p, summary, contact } = builderInput(req);
    if (!p.name) return builderPage(req, res, { status: 400, errors: ['Add your name to your profile first.'] });
    keepSummary(c, summary);
    const { pdf } = resumePdf.build(p, { summary, contact, title: `${p.name} - resume` });
    activity(req.candidateEmail, 'resume-made', 'Downloaded');
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="my-resume.pdf"', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }).send(pdf);
  });
  app.post('/account/resume-builder/save', requireCandidate, limit('resume-builder', 30), sameOrigin, (req, res) => {
    const { c, p, summary, contact } = builderInput(req);
    if (!p.name) return builderPage(req, res, { status: 400, errors: ['Add your name to your profile first.'] });
    keepSummary(c, summary);
    const filename = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.pdf`;
    const file = { path: path.join(uploadsDir, filename), filename, originalname: 'Resume made on Hireriv.pdf' };
    try {
      fs.writeFileSync(file.path, resumePdf.build(p, { summary, contact, title: `${p.name} - resume` }).pdf);
    } catch (e) {
      return builderPage(req, res, { status: 500, errors: ['Could not save your resume. Please try again.'] });
    }
    storeResume(req.candidateEmail, file, (err) => (err ? builderPage(req, res, { status: 400, errors: [err] }) : back(res, 'Resume saved. It will be sent with your next applications.', '/account/profile')), { what: 'resume-made' });
  });

  // ---------- one-click apply ----------
  app.post('/account/apply/:jobId', requireCandidate, limit('account-apply', 20), sameOrigin, (req, res, next) => {
    const job = getJobs().find((j) => j.id === req.params.jobId);
    if (!job) return next();
    const toJob = (msg) => res.redirect(`${jobPath(job)}?msg=${encodeURIComponent(msg)}#apply`);
    if (!isLive(job) || isSample(job)) return toJob("This job isn't taking applications.");
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
    saveApplication(data, file, job, { oneClick: true }, { announce: true })
      .then(({ updated }) => {
        if (!updated) track('application-submitted', req.body.from === 'card' ? 'One-tap' : 'One-click', req);
        // From a job list, the job page shows what's next (and the hiring contact, where the employer shares it).
        if (req.body.from === 'card') return toJob(`Applied for ${job.title}. A recruiter will be in touch within 2 working days.`);
        back(res, `Applied for ${job.title}. A recruiter will be in touch within 2 working days.`);
      })
      .catch((e) => {
        console.error(e);
        toJob('Could not send your application. Please try again.');
      });
  });

  // ---------- job alerts ----------
  // Set up from the account they're on straight away: the email is already confirmed.
  app.post('/account/alerts', requireCandidate, limit('account-alerts', 20), sameOrigin, (req, res) => {
    const category = String(req.body.category || '');
    const location = String(req.body.location || '');
    if ((category && !jobCategories().includes(category)) || (location && !jobLocations().includes(location))) return back(res, 'Choose a category and city from the lists.');
    const subs = readSubmissions('job-alerts');
    const existing = subs.find((s) => s.email === req.candidateEmail && s.category === category && s.location === location);
    if (existing && existing.confirmed) return back(res, 'You already have that job alert.');
    const now = nowIso();
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

  // ---------- saved jobs ----------
  const savedOf = (email) => readSubmissions('saved-jobs').filter((s) => s.email === email);
  function unsave(email, jobId) {
    const list = readSubmissions('saved-jobs');
    const rest = list.filter((s) => !(s.email === email && s.jobId === jobId));
    if (rest.length !== list.length) writeSubmissions('saved-jobs', rest);
  }
  app.get('/account/saved', requireCandidate, (req, res) => {
    const jobs = getJobs();
    const saved = savedOf(req.candidateEmail).map((s) => {
      const job = jobs.find((j) => j.id === s.jobId) || null;
      // Drafts and jobs waiting for review were never public: shown as removed.
      const known = job && ['open', 'closed'].includes(job.status);
      return { savedAt: s.createdAt, jobId: s.jobId, job, open: Boolean(job && isLive(job)), title: known ? job.title : '' };
    });
    page(res, 'account-saved', { title: 'Saved jobs', ...shell(req.candidateEmail, 'saved'), saved, msg: String(req.query.msg || '') });
  });
  app.post('/account/saved/:jobId/delete', requireCandidate, limit('saved-jobs', 120), sameOrigin, (req, res) => {
    unsave(req.candidateEmail, req.params.jobId);
    back(res, 'Removed from your saved jobs.', '/account/saved');
  });

  // ---------- interviews ----------
  app.get('/account/interviews', requireCandidate, (req, res) => {
    const now = Date.now();
    const all = mine(req.candidateEmail).flatMap((a) => (a.interviews || []).map((iv) => ({ ...iv, appId: a.id, jobTitle: a.jobTitle })));
    const next = all.filter((iv) => upcoming(iv, now)).sort((x, y) => x.at.localeCompare(y.at));
    const past = all.filter((iv) => !upcoming(iv, now)).sort((x, y) => y.at.localeCompare(x.at)).slice(0, 30);
    page(res, 'account-interviews', { title: 'Your interviews', ...shell(req.candidateEmail, 'interviews'), upcoming: next, past, msg: String(req.query.msg || '') });
  });

  // The candidate confirms an interview, or asks for another time. Only their
  // own upcoming interviews; the people running the hiring are told.
  for (const answer of ['confirm', 'reschedule']) {
    app.post(`/account/interviews/:appId/:ivId/${answer}`, requireCandidate, limit('interview-answer', 20), sameOrigin, (req, res, next) => {
      const list = readSubmissions('applications');
      const a = list.find((x) => x.id === req.params.appId && String(x.email).toLowerCase() === req.candidateEmail && !x.withdrawnAt);
      const iv = a && (a.interviews || []).find((x) => x.id === req.params.ivId);
      if (!iv || !upcoming(iv, Date.now())) return next();
      const note = String(req.body.note || '').trim().slice(0, 300);
      if (answer === 'reschedule' && !note) return back(res, 'Tell them which days and times suit you.', '/account/interviews');
      const status = answer === 'confirm' ? 'confirmed' : 'reschedule-requested';
      if (iv.confirmation !== status || (note && note !== iv.candidateNote)) {
        Object.assign(iv, { confirmation: status, candidateNote: note, answeredAt: new Date().toISOString() });
        writeSubmissions('applications', list);
        activity(req.candidateEmail, answer === 'confirm' ? 'interview-confirmed' : 'interview-reschedule', a.jobTitle);
        if (interviewResponded) interviewResponded(a, iv, answer === 'confirm', note);
      }
      back(res, answer === 'confirm' ? 'Thanks, your interview is confirmed.' : 'We\'ve asked for another time. They\'ll be in touch with a new slot.', '/account/interviews');
    });
  }

  // ---------- settings ----------
  // News and career tips follow the marketing choice in notification settings.
  const marketingOn = (email) => notify.prefsOf(notify.candidateRk(email)).marketing.email === true;
  // Saves visibility and contact choices, recording each change as consent given or withdrawn.
  function saveChoices(c, nextPrivacy, nextComms, source, marketing) {
    const purposes = [['recruiter-visibility', nextPrivacy.visibleToRecruiters], ['employer-discovery', nextPrivacy.discoverable], ['whatsapp', nextComms.whatsapp], ['sms', nextComms.sms]];
    const was = { 'recruiter-visibility': c.privacy.visibleToRecruiters, 'employer-discovery': c.privacy.discoverable, whatsapp: c.comms.whatsapp, sms: c.comms.sms };
    c.privacy = { visibleToRecruiters: Boolean(nextPrivacy.visibleToRecruiters), discoverable: Boolean(nextPrivacy.discoverable) };
    c.comms = { whatsapp: Boolean(nextComms.whatsapp), sms: Boolean(nextComms.sms), offers: Boolean(nextComms.offers) };
    saveCandidate(c);
    for (const [purpose, on] of purposes) if (Boolean(on) !== Boolean(was[purpose])) privacy.consent(c.email, purpose, Boolean(on), source);
    if (typeof marketing === 'boolean') privacy.setMarketing(c.email, marketing, source);
  }
  app.get('/account/settings', requireCandidate, (req, res) => {
    const email = req.candidateEmail;
    const log = readSubmissions('candidate-activity').filter((e) => e.email === email).slice(0, 20)
      .map((e) => ({ at: e.createdAt, label: ACTIVITY_LABELS[e.event] || e.event, detail: e.event === 'signed-in' ? e.detail : '' }));
    const c = candidateOf(email);
    const mobile = { number: mobileOf(c && c.profile.phone), confirmed: phoneConfirmed(c), codeSent: req.query.code === 'sent' };
    page(res, 'account-settings', { title: 'Account settings', ...shell(email, 'settings'), log, marketingOn: marketingOn(email), msg: String(req.query.msg || ''), errors: [], mobile });
  });
  app.post('/account/password', requireCandidate, limit('account-password', 10), sameOrigin, (req, res) => {
    const c = ensureCandidate(req.candidateEmail);
    const fail = (msg) => back(res, msg, '/account/settings');
    if (c.passwordHash && !checkPassword(String(req.body.current || '').slice(0, 200), c.passwordHash)) return fail('Your current password is not right.');
    const problem = passwordProblem(String(req.body.password || ''), String(req.body.confirm || ''));
    if (problem) return fail(problem);
    const what = c.passwordHash ? 'changed' : 'set';
    Object.assign(c, { passwordHash: hashPassword(String(req.body.password)), passwordSetAt: nowIso() });
    saveCandidate(c);
    // Signed out everywhere else; this browser gets a fresh session.
    db.sessions.deleteSubject('candidate', c.email);
    startSession(res, c.email);
    activity(c.email, `password-${what}`);
    mailer.candidatePasswordChanged(c.email, what);
    events.accountSecurity(c.email, `Password ${what}`, 'You were signed out on your other devices. Wasn\'t you? Reset your password straight away.');
    back(res, what === 'set' ? 'Password saved. You can now sign in with it, or keep using email links.' : 'Password changed. You were signed out on your other devices.', '/account/settings');
  });
  app.post('/account/settings', requireCandidate, limit('account-settings', 20), sameOrigin, (req, res) => {
    const c = ensureCandidate(req.candidateEmail);
    const on = (k) => req.body[k] === '1';
    saveChoices(c, { visibleToRecruiters: on('visibleToRecruiters'), discoverable: on('discoverable') }, { whatsapp: on('whatsapp'), sms: on('sms'), offers: on('offers') }, 'account settings', on('offers'));
    activity(c.email, 'settings-changed');
    back(res, 'Settings saved.', '/account/settings');
  });
  app.post('/account/sessions/revoke', requireCandidate, limit('account-settings', 20), sameOrigin, (req, res) => {
    db.sessions.deleteSubject('candidate', req.candidateEmail);
    res.clearCookie(COOKIE, { path: '/' });
    activity(req.candidateEmail, 'sessions-revoked');
    res.redirect('/account/login');
  });

  // ---------- applications ----------
  app.post('/account/applications/:id/withdraw', requireCandidate, limit('account-withdraw', 20), sameOrigin, (req, res, next) => {
    const list = readSubmissions('applications');
    const a = list.find((x) => x.id === req.params.id && String(x.email).toLowerCase() === req.candidateEmail);
    if (!a) return next();
    if (!a.withdrawnAt && !['Hired', 'Rejected'].includes(a.status)) {
      a.withdrawnAt = nowIso();
      // Cancel any interviews still on the calendar.
      for (const iv of a.interviews || []) if (iv.status === 'scheduled') { iv.status = 'cancelled'; iv.sequence = (iv.sequence || 0) + 1; iv.cancelledAt = a.withdrawnAt; }
      writeSubmissions('applications', list);
      mailer.applicationWithdrawn(a);
    }
    back(res, `You've withdrawn your application for ${a.jobTitle}.`);
  });

  // Right of access: everything the candidate gave us and what happened to it,
  // as a file they can keep. Recruiters' private notes and interview scorecards
  // are internal assessments and are not part of the download.
  app.get('/account/my-data.json', requireCandidate, (req, res) => {
    const email = req.candidateEmail;
    const subs = (type) => readSubmissions(type).filter((s) => String(s.email).toLowerCase() === email);
    const c = candidateOf(email);
    const data = {
      exportedAt: nowIso(),
      about: `Your data held by ${site.name}. Questions or corrections: ${site.email}`,
      email,
      account: c ? {
        createdAt: c.createdAt, emailConfirmedAt: c.emailVerifiedAt, consentGivenAt: c.consentAt || null, hasPassword: Boolean(c.passwordHash),
        profile: c.profile, privacy: c.privacy, contactPreferences: c.comms,
        resumes: c.resumes.map((r) => ({ name: r.name, uploadedAt: r.uploadedAt })),
      } : null,
      applications: mine(email).map((a) => ({
        job: a.jobTitle,
        appliedAt: a.createdAt,
        status: stageOf(a),
        details: Object.fromEntries(['name', 'phone', 'skills', 'experience', 'location', 'noticePeriod', 'linkedin', 'message', 'source'].filter((k) => a[k]).map((k) => [k, a[k]])),
        resumeFile: a.resume ? `Uploaded resume (${path.extname(a.resume).slice(1).toUpperCase()})` : null,
        skillsFoundInResume: a.resumeSkills || [],
        reappliedAt: a.reapplied || [],
        stageChanges: (a.history || []).map((h) => ({ at: h.at, from: CANDIDATE_STAGE[h.from] || h.from, to: CANDIDATE_STAGE[h.to] || h.to })).filter((h) => h.from !== h.to),
        interviews: (a.interviews || []).map((iv) => ({ at: iv.at, durationMinutes: iv.duration, format: iv.mode, status: iv.status })),
        emailsSent: (a.emails || []).map((m) => ({ at: m.at, subject: m.subject })),
        sharedWithClient: a.shared ? { at: a.shared.sharedAt } : null,
        withdrawnAt: a.withdrawnAt || null,
      })),
      savedJobs: savedOf(email).map((s) => ({ jobId: s.jobId, savedAt: s.createdAt })),
      jobAlerts: subs('job-alerts').map((s) => (s.filters
        ? { savedSearch: s.name, filters: s.filters, alerts: s.alertEnabled !== false ? s.frequency || 'instant' : 'off', since: s.createdAt }
        : { category: s.category || 'Any', location: s.location || 'Any', confirmed: Boolean(s.confirmed), since: s.createdAt })),
      invitationsFromEmployers: c ? readSubmissions('candidate-invites').filter((i) => i.candidateId === c.id).map((i) => {
        const job = getJobs().find((j) => j.id === i.jobId);
        return { at: i.createdAt, job: job ? job.title : 'A job that was removed', company: job ? job.company : '' };
      }) : [],
      newsletter: subs('newsletter').map((s) => ({ since: s.createdAt })),
      notifications: notify.list({ rk: notify.candidateRk(email) }, { limit: 1000 }).items.map((n) => ({ at: n.createdAt, title: n.title, text: n.body, readAt: n.readAt })),
      notificationSettings: notify.prefsOf(notify.candidateRk(email)),
      consents: { policyVersion: privacy.POLICY_VERSION, current: privacy.current(email), history: privacy.historyOf(email).map(({ subject, ...r }) => r) },
      dataRequests: readSubmissions('data-requests').filter((r) => r.email === email && r.status !== 'awaiting-verification').map((r) => ({ number: r.number, type: r.type, status: r.status, createdAt: r.createdAt, closedAt: r.closedAt, resolution: r.resolution })),
      accountActivity: readSubmissions('candidate-activity').filter((e) => e.email === email).map((e) => ({ at: e.createdAt, event: ACTIVITY_LABELS[e.event] || e.event })),
    };
    res.set('Cache-Control', 'no-store').attachment(`my-data-${new Date().toISOString().slice(0, 10)}.json`).type('application/json').send(JSON.stringify(data, null, 2));
  });

  // A candidate's resume as sent with one of their applications.
  app.get('/account/resume/:appId', requireCandidate, (req, res, next) => {
    const a = mine(req.candidateEmail).find((x) => x.id === req.params.appId);
    if (!a || !a.resume) return next();
    if (!downloadLinks.valid(req)) return linkExpired(res, '/account');
    const file = path.basename(a.resume);
    vault.send(res, path.join(uploadsDir, file), `my-resume${path.extname(file)}`, 'Own resume');
  });

  // Interview invite for the candidate's own calendar.
  app.get('/account/interviews/:appId/:ivId.ics', requireCandidate, (req, res, next) => {
    const a = mine(req.candidateEmail).find((x) => x.id === req.params.appId);
    const iv = a && (a.interviews || []).find((x) => x.id === req.params.ivId && x.status === 'scheduled');
    if (!iv) return next();
    res.type('text/calendar').attachment('interview.ics').send(interviewIcs({ method: 'REQUEST', interview: iv, candidate: a, jobTitle: a.jobTitle, site }));
  });

  // ---------- adding an email to a mobile-only account ----------
  // A link goes to the new address; opening it moves the account from its
  // placeholder (identity.js) onto that email. Every record holding the
  // placeholder, or a key made from it (notifications, push, the assistant),
  // is rewritten in one transaction, except the hash-chained audit trail,
  // which gets an entry for the move instead. The reply is the same whether
  // or not the email already has an account; one that does is never merged.
  const EMAIL_ADD_HOURS = 24;
  const AUDIT_TRAIL = 'trust-audit';
  const assistantKey = (email) => `cand:${require('./ai-provider').hash(String(email).toLowerCase()).slice(0, 32)}`;
  function moveAccount(from, to) {
    const n = require('./notify');
    return db.replaceEverywhere([
      [from, to],
      [n.candidateRk(from), n.candidateRk(to)],
      [n.addressHash(from), n.addressHash(to)],
      [assistantKey(from), assistantKey(to)],
    ], { skip: [AUDIT_TRAIL] });
  }
  const emailAddExpired = (res) => loginPage(res, { title: 'Link expired', errors: ['That link has expired or was already used. Sign in with your mobile number and add the email again from Settings.'] }, 410);
  app.post('/account/email/add', requireCandidate, limit('account-email-add', 5), sameOrigin, (req, res) => {
    const from = req.candidateEmail;
    const c = candidateOf(from);
    if (!c || !c.mobileOnly) return back(res, 'This account already has an email address.', '/account/settings');
    const to = String(req.body.email || '').trim().toLowerCase().slice(0, 254);
    if (!EMAIL_RE.test(to) || identity.isMobileOnly(to)) return back(res, 'Please enter a valid email.', '/account/settings');
    if (candidateOf(to)) mailer.candidateEmailTaken(to, `${baseUrl}/account/login`);
    else {
      const token = newToken();
      db.sessions.set('candidate-email-add', sha(token), JSON.stringify({ from, to }), Date.now() + EMAIL_ADD_HOURS * 3600000);
      mailer.candidateEmailAdd(to, `${baseUrl}/account/email/confirm/${token}`, EMAIL_ADD_HOURS);
    }
    back(res, `We’ve sent a link to ${to}. Open it within ${EMAIL_ADD_HOURS} hours to add the address. Nothing arrived? Check spam, or that the address is right.`, '/account/settings');
  });
  // GET shows a button (mail scanners prefetch links); POST makes the move.
  app.get('/account/email/confirm/:token', (req, res) => {
    const l = db.sessions.get('candidate-email-add', sha(req.params.token));
    if (!l) return emailAddExpired(res);
    let to = '';
    try { to = JSON.parse(l.subject).to; } catch (e) { return emailAddExpired(res); }
    page(res, 'account-verify', { title: 'Add your email', heading: 'Add your email', email: to, intro: 'Add this address to your account:', button: 'Add this email' });
  });
  app.post('/account/email/confirm/:token', limit('account-email-add', 10), sameOrigin, (req, res) => {
    const key = sha(req.params.token);
    const l = db.sessions.get('candidate-email-add', key);
    db.sessions.delete('candidate-email-add', key);
    if (!l) return emailAddExpired(res);
    let from = '';
    let to = '';
    try { ({ from, to } = JSON.parse(l.subject)); } catch (e) { return emailAddExpired(res); }
    const c = candidateOf(from);
    if (!c || !c.mobileOnly) return emailAddExpired(res);
    const taken = (msg) => loginPage(res, { errors: [msg] }, 409);
    if (candidateOf(to)) return taken('That email already has its own account, so it can’t be added. Sign in with it instead.');
    try {
      moveAccount(from, to);
    } catch (err) {
      if (err.code !== 'ERR_UNIQUE') throw err;
      return taken('That email has already applied to some of the same jobs, so the accounts can’t be joined here. Contact us and we’ll help.');
    }
    const moved = candidateOf(to);
    moved.mobileOnly = false;
    moved.emailVerifiedAt = nowIso();
    saveCandidate(moved);
    activity(to, 'email-added');
    // The audit trail never holds the address itself: the account id links the two.
    if (deps.audit) deps.audit(null, 'candidate-email-added', { entityType: 'candidate', entityId: moved.id, detail: 'Mobile-only account moved onto a confirmed email address' });
    startSession(res, to);
    res.redirect(`/account/settings?msg=${encodeURIComponent(`${to} is added. You can now sign in with it or with your mobile number.`)}`);
  });

  // Right to erasure: the account, every application and resume for this
  // email, job alerts, newsletter, saved jobs, activity and sign-ins.
  function deleteEverything(email) {
    const list = readSubmissions('applications');
    const keep = [];
    for (const a of list) {
      if (String(a.email).toLowerCase() === email) {
        if (a.resume) fs.unlink(path.join(uploadsDir, path.basename(a.resume)), () => {});
      } else keep.push(a);
    }
    writeSubmissions('applications', keep);
    const c = candidateOf(email);
    if (c) for (const r of c.resumes) fs.unlink(path.join(uploadsDir, path.basename(r.file)), () => {});
    if (c) {
      const invites = readSubmissions('candidate-invites');
      const rest = invites.filter((i) => i.candidateId !== c.id);
      if (rest.length !== invites.length) writeSubmissions('candidate-invites', rest);
    }
    for (const type of ['job-alerts', 'newsletter', 'saved-jobs', 'candidates', 'candidate-activity']) {
      const subs = readSubmissions(type);
      const rest = subs.filter((s) => String(s.email).toLowerCase() !== email);
      if (rest.length !== subs.length) writeSubmissions(type, rest);
    }
    for (const kind of ['candidate', 'candidate-link', 'candidate-reset']) db.sessions.deleteSubject(kind, email);
    failures.delete(email);
    notify.forget(notify.candidateRk(email));
    if (push) push.forget(notify.candidateRk(email));
    privacy.erased(email);
  }
  app.post('/account/delete', requireCandidate, limit('account-delete', 5), sameOrigin, (req, res) => {
    if (String(req.body.confirm || '').trim().toUpperCase() !== 'DELETE') return back(res, 'Type DELETE to confirm deleting your data.', '/account/settings');
    const email = req.candidateEmail;
    deleteEverything(email);
    // The confirmation goes straight out: nothing about them is kept to queue it.
    mailer.accountDeleted(email);
    res.clearCookie(COOKIE, { path: '/' });
    loginPage(res, { title: 'Your data has been deleted', deleted: true });
  });

  // ---------- /candidate/* addresses ----------
  // The same pages under the names used in the product plan.
  const ALIASES = {
    '': '/account', '/dashboard': '/account', '/register': '/account/register', '/login': '/account/login', '/forgot-password': '/account/forgot',
    '/profile': '/account/profile', '/resumes': '/account/profile#resume', '/applications': '/account#applications', '/saved-jobs': '/account/saved',
    '/alerts': '/account/saved-searches', '/interviews': '/account/interviews', '/settings': '/account/settings',
    '/recommendations': '/account/recommendations', '/saved-searches': '/account/saved-searches',
  };
  for (const [from, to] of Object.entries(ALIASES)) {
    app.get(`/candidate${from}`, (req, res) => {
      const i = req.originalUrl.indexOf('?');
      const [p, hash] = to.split('#');
      res.redirect(301, p + (i === -1 ? '' : req.originalUrl.slice(i)) + (hash ? `#${hash}` : ''));
    });
  }

  // ---------- JSON API ----------
  // Same sign-in as the pages, but a 401 instead of a redirect.
  const requireCandidateApi = (req, res, next) => {
    const email = currentEmail(req);
    if (!email) return res.status(401).json({ ok: false, errors: ['sign in to your account first'] });
    req.candidateEmail = email;
    res.set('Cache-Control', 'no-store');
    next();
  };
  const jsonErrors = (res, status, errors) => res.status(status).json({ ok: false, errors: [].concat(errors) });

  // Also POST /api/public/candidate-registrations.
  function registerApi(req, res) {
    const body = req.body || {};
    const reply = () => res.status(202).json({ ok: true, message: 'Check your email: we sent you a link to open your account.' });
    if (isBot(body)) return reply();
    const { values, errors } = registerValues(body);
    if (errors.length) return jsonErrors(res, 400, errors);
    createAccount(values, null, { whatsapp: body.whatsapp === true, considered: body.considered === true, req, source: 'registration API' }).then(reply).catch((e) => {
      console.error(e);
      jsonErrors(res, 500, 'Could not create your account. Please try again.');
    });
  }
  app.post('/api/auth/register', limit('account-register', 5), sameOrigin, (req, res) => registerApi(req, res));
  app.post('/api/public/candidate-registrations', limit('account-register', 5), sameOrigin, (req, res) => registerApi(req, res));
  app.post('/api/auth/login', limit('account-login', 10), sameOrigin, (req, res) => {
    const body = req.body || {};
    const r = passwordSignIn(body.email, typeof body.password === 'string' ? body.password : '');
    if (r.error) return jsonErrors(res, r.status, r.error);
    startSession(res, r.email);
    activity(r.email, 'signed-in', 'password');
    res.set('Cache-Control', 'no-store').json({ ok: true, redirect: safeNext(body.next) || '/account' });
  });
  app.post('/api/auth/logout', sameOrigin, (req, res) => {
    const email = currentEmail(req);
    endSession(req, res);
    if (email) activity(email, 'signed-out');
    res.json({ ok: true });
  });
  app.post('/api/auth/verify-email', limit('account-verify', 20), sameOrigin, (req, res) => {
    const token = String((req.body || {}).token || '');
    const l = /^[a-f0-9]{64}$/.test(token) && signInWithLink(token, res);
    if (!l) return jsonErrors(res, 410, 'that link has expired or was already used');
    res.set('Cache-Control', 'no-store').json({ ok: true, redirect: l.next || '/account' });
  });

  // The profile, resumes (names and short-lived download links only), and settings.
  function profileJson(email) {
    const c = ensureCandidate(email);
    const profile = profileFor(email);
    return {
      ok: true, email, emailVerified: Boolean(c.emailVerifiedAt), hasPassword: Boolean(c.passwordHash),
      profile: c.profile, privacy: c.privacy, comms: c.comms,
      completion: cp.completion(c.profile, { hasResume: Boolean(profile.resume) }),
      resumes: resumeView(c).map((r) => ({ ...r, download: downloadLinks.signed(`/account/resumes/${r.id}`) })),
    };
  }
  app.get('/api/candidate/profile', requireCandidateApi, (req, res) => res.json(profileJson(req.candidateEmail)));
  app.patch('/api/candidate/profile', requireCandidateApi, limit('account-profile', 40), sameOrigin, (req, res) => {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? { ...req.body } : null;
    if (!body) return jsonErrors(res, 400, 'send the profile changes as a JSON object');
    const { privacy, comms } = body;
    delete body.privacy;
    delete body.comms;
    const { patch, errors } = cp.parsePatch(body, profileContext());
    const flags = (v, keys, label) => {
      if (v === undefined) return null;
      if (!v || typeof v !== 'object' || Object.keys(v).some((k) => !keys.includes(k) || typeof v[k] !== 'boolean')) { errors.push(`${label} takes ${keys.join(', ')} as true or false`); return null; }
      return v;
    };
    const p = flags(privacy, ['visibleToRecruiters', 'discoverable'], 'privacy');
    const m = flags(comms, ['whatsapp', 'sms', 'offers'], 'comms');
    if (errors.length) return jsonErrors(res, 400, errors);
    if (Object.keys(patch).length) updateProfile(req.candidateEmail, patch);
    if (p || m) {
      const c = ensureCandidate(req.candidateEmail);
      saveChoices(c, p ? { ...c.privacy, ...p } : c.privacy, m ? { ...c.comms, ...m } : c.comms, 'profile API', m && typeof m.offers === 'boolean' ? m.offers : undefined);
      activity(req.candidateEmail, 'settings-changed');
    }
    res.json(profileJson(req.candidateEmail));
  });
  app.post('/api/candidate/resumes', requireCandidateApi, limit('account-resume', 10), sameOrigin, (req, res) => {
    addResume(req, res, (err, r) => {
      if (err) return jsonErrors(res, 400, err);
      res.status(201).json({ ok: true, resume: { id: r.id, name: r.name, uploadedAt: r.uploadedAt, size: r.size, isDefault: true, download: downloadLinks.signed(`/account/resumes/${r.id}`) } });
    });
  });
  app.delete('/api/candidate/resumes/:id', requireCandidateApi, limit('account-resume', 20), sameOrigin, (req, res) => {
    if (!deleteResume(req.candidateEmail, req.params.id)) return jsonErrors(res, 404, 'resume not found');
    res.json({ ok: true });
  });

  // Saved jobs follow a signed-in candidate to every device. The browser keeps
  // its own copy too, so saving still works signed out.
  app.get('/api/candidate/saved-jobs', requireCandidateApi, (req, res) => {
    res.json({ ok: true, jobIds: savedOf(req.candidateEmail).map((s) => s.jobId) });
  });
  app.put('/api/candidate/saved-jobs/:jobId', requireCandidateApi, limit('saved-jobs', 120), sameOrigin, (req, res) => {
    if (!getJobs().some((j) => j.id === req.params.jobId)) return res.status(404).json({ ok: false, errors: ['job not found'] });
    if (!savedOf(req.candidateEmail).some((s) => s.jobId === req.params.jobId)) saveSubmission('saved-jobs', { email: req.candidateEmail, jobId: req.params.jobId });
    res.json({ ok: true });
  });
  app.delete('/api/candidate/saved-jobs/:jobId', requireCandidateApi, limit('saved-jobs', 120), sameOrigin, (req, res) => {
    unsave(req.candidateEmail, req.params.jobId);
    res.json({ ok: true });
  });

  // The signed-in candidate's own applications, newest first.
  app.get('/api/candidate/applications', requireCandidateApi, (req, res) => {
    res.json({
      ok: true,
      applications: mine(req.candidateEmail).sort(newestFirst).map((a) => ({
        id: a.id, jobId: a.jobId === 'general' ? null : a.jobId, job: a.jobTitle, appliedAt: a.createdAt, status: stageOf(a),
      })),
    });
  });

  app.delete('/api/candidate/account', requireCandidateApi, limit('account-delete', 5), sameOrigin, (req, res) => {
    if (String((req.body || {}).confirm || '').trim().toUpperCase() !== 'DELETE') return jsonErrors(res, 400, 'send {"confirm": "DELETE"} to delete your account and data');
    deleteEverything(req.candidateEmail);
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  // People who chose not to be found: the team still sees their applications,
  // but they're left out of talent-pool searches for other roles.
  const hiddenFromSearch = () => new Set(readSubmissions('candidates').filter((c) => c.privacy && c.privacy.visibleToRecruiters === false).map((c) => c.email));

  // When data retention removes every application of a person, their account,
  // resumes and activity go with it.
  function pruneAccounts() {
    const emails = new Set(readSubmissions('applications').map((a) => String(a.email).toLowerCase()));
    const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
    for (const c of readSubmissions('candidates')) if (!emails.has(c.email) && c.createdAt < cutoff) deleteEverything(c.email);
  }

  // What the recommendations and saved searches (job-recommendations.js) build on.
  const helpers = {
    requireCandidate, requireCandidateApi, candidateOf, saveCandidate, ensureCandidate, profileFor, updateProfile, profileContext, shell, page, back, mine, savedOf, activity,
  };
  return { requireCandidate, currentEmail, accountForJob, oneTapFor, hiddenFromSearch, pruneAccounts, deleteEverything, helpers };
}

module.exports = { register, CANDIDATE_STAGE, safeNext };
