// Employer workspaces: companies (invited by the team or signed up, then
// verified by the team), the people who work in them (see employer-team.js:
// one login per person, a role in each company), password login, the company
// profile, team, personal settings with mobile verification, and the portal.
const crypto = require('crypto');
const path = require('path');
const vault = require('./vault');
const teamStore = require('./employer-team');
const agencyRoles = require('./agency-roles');

const { can, ROLES, ROLE_KEYS } = teamStore;

const SESSION_DAYS = 7;
const INVITE_HOURS = 72;
const RESET_HOURS = 2;
const COOKIE = 'hr_emp';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^[+\d][\d\s-]{7,16}$/;
const VERIFY_HOURS = 24;
// Personal mailboxes: allowed (many small employers use them) but flagged for
// the team, who check every self-signup before its jobs can go live.
const FREE_EMAIL = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.in', 'ymail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'rediffmail.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'zohomail.in', 'gmx.com', 'mail.com']);
const isFreeEmail = (email) => FREE_EMAIL.has(String(email).split('@')[1] || '');

// GSTIN: 2-digit state code, PAN, entity number, Z, and a check character.
const GST_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
function gstinCheckChar(first14) {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const product = GST_CHARS.indexOf(first14[i]) * (i % 2 ? 2 : 1);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GST_CHARS[(36 - (sum % 36)) % 36];
}
const validGstin = (g) => /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g) && gstinCheckChar(g.slice(0, 14)) === g[14];

// Clients the team added are approved; self-signups once the team approves them.
const isApproved = (emp) => Boolean(emp) && emp.active && (!emp.selfSignup || Boolean(emp.approvedAt));

// ---------- passwords & tokens ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function checkPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

// Only a SHA-256 of each emailed link token is stored, so a leaked data file
// cannot be used to take over accounts.
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('hex');

function passwordProblem(pw, confirm) {
  if (pw.length < 10) return 'password must be at least 10 characters';
  if (pw.length > 200) return 'password is too long';
  if (pw !== confirm) return "passwords don't match";
  return '';
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// ---------- company details ----------
const INDUSTRIES = [
  'Manufacturing', 'Logistics & Warehousing', 'Retail & E-commerce', 'IT & Software', 'Banking, Finance & Insurance', 'Healthcare & Pharma',
  'Construction & Real Estate', 'Hospitality & Food', 'Education', 'Facility & Security Services', 'Automotive', 'Agriculture',
  'Telecom', 'Media & Marketing', 'Professional Services', 'Staffing & HR', 'Government & Public Sector', 'Other',
];
const COMPANY_SIZES = ['1-10', '11-50', '51-200', '201-1,000', '1,001-5,000', '5,000+'];
const CIN_RE = /^[LU]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6}$/;
const UDYAM_RE = /^UDYAM-[A-Z]{2}-\d{2}-\d{7}$/;
const PIN_RE = /^[1-9]\d{5}$/;
const URL_RE = /^https?:\/\/[^\s"'<>]+\.[^\s"'<>]+$/i;
// Fields an owner can change on the company profile (and PATCH /api/employers/me).
const COMPANY_FIELDS = ['company', 'industry', 'website', 'size', 'hiringLocations', 'about', 'gstin', 'cin', 'udyam', 'addressLine', 'city', 'state', 'pincode'];

// Checks company details. `input` holds only what's being changed; `ctx.cities`
// are the site's job locations, `ctx.states` the states. Unknown fields are refused.
function parseCompany(input, ctx, { required = [] } = {}) {
  const errors = [];
  const out = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { values: out, errors: ['send the company details as an object'] };
  const has = (k) => Object.prototype.hasOwnProperty.call(input, k);
  const str = (k, max) => String(input[k] ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
  for (const k of required) if (!String(input[k] ?? '').trim()) errors.push(`${{ company: 'Company name', industry: 'Industry', size: 'Company size' }[k] || k} is required.`);
  if (has('company')) out.company = str('company', 120);
  if (has('industry')) { out.industry = str('industry', 60); if (out.industry && !INDUSTRIES.includes(out.industry)) errors.push('Industry: choose from the list.'); }
  if (has('size')) { out.size = str('size', 20); if (out.size && !COMPANY_SIZES.includes(out.size)) errors.push('Company size: choose from the list.'); }
  if (has('website')) { out.website = str('website', 200); if (out.website && !URL_RE.test(out.website)) errors.push('Website must be a full address starting with https://'); }
  if (has('about')) out.about = String(input.about ?? '').trim().slice(0, 1000);
  if (has('hiringLocations')) {
    const list = [...new Set([].concat(input.hiringLocations ?? []).map(String).filter(Boolean))];
    if (list.some((c) => !ctx.cities.includes(c))) errors.push('Hiring locations: choose from the list.');
    if (list.length > 20) errors.push('Hiring locations: choose up to 20.');
    out.hiringLocations = list.filter((c) => ctx.cities.includes(c)).slice(0, 20);
  }
  if (has('gstin')) { out.gstin = str('gstin', 20).toUpperCase().replace(/\s+/g, ''); if (out.gstin && !validGstin(out.gstin)) errors.push("That GSTIN doesn't look right. Check it, or leave it blank and we'll ask for other proof."); }
  if (has('cin')) { out.cin = str('cin', 21).toUpperCase(); if (out.cin && !CIN_RE.test(out.cin)) errors.push("That CIN doesn't look right (21 characters, e.g. U74999MH2015PTC123456)."); }
  if (has('udyam')) { out.udyam = str('udyam', 19).toUpperCase(); if (out.udyam && !UDYAM_RE.test(out.udyam)) errors.push('Udyam number looks like UDYAM-MH-12-1234567.'); }
  if (has('addressLine')) out.addressLine = str('addressLine', 200);
  if (has('city')) out.city = str('city', 80);
  if (has('state')) { out.state = str('state', 60); if (out.state && !ctx.states.includes(out.state)) errors.push('State: choose from the list.'); }
  if (has('pincode')) { out.pincode = str('pincode', 6); if (out.pincode && !PIN_RE.test(out.pincode)) errors.push('PIN code must be 6 digits.'); }
  if (has('company') && !out.company) errors.push('Company name is required.');
  return { values: out, errors: [...new Set(errors)] };
}

// Where the team's check of a company stands.
function verificationOf(c) {
  if (!c) return 'none';
  if (c.rejectedAt && !c.active) return 'declined';
  if (!c.selfSignup || c.approvedAt) return 'verified';
  return 'pending';
}

const ALIASES = {
  '/employers': '/employer', '/employers/register': '/employer/register', '/employers/login': '/employer/login', '/employers/dashboard': '/employer',
  '/employers/company-profile': '/employer/company', '/employers/jobs': '/employer/jobs', '/employers/jobs/create': '/employer/jobs/new',
  '/employers/applicants': '/employer/applicants', '/employers/ats': '/employer/ats', '/employers/interviews': '/employer/interviews', '/employers/team': '/employer/team', '/employers/settings': '/employer/settings',
};
const OTP_MINUTES = 10;

function register(app, deps) {
  const { db, site, mailer, baseUrl, adminAuth, sameOrigin, adminUrl, limit, readSubmissions, saveSubmission, getJobs, appStatuses, placementsFor, timesheetsFor } = deps;
  const { writeSubmissions, uploadsDir, skillMatch, downloadLinks, linkExpired, sms, companyContext } = deps;
  const read = () => db.all('employers');
  const write = (list) => db.replaceAll('employers', list);
  const secureCookie = /^https:/.test(baseUrl);
  const team = teamStore.create({ readSubmissions, writeSubmissions, saveSubmission });
  // Set by trust.js: records verification decisions and offers an appeal.
  const hooks = {};
  const roleGate = (action) => (req, res, next) => (agencyRoles.can(req.admin, action) ? next() : res.status(403).render('thanks', { title: 'Not part of your role', page: '', ok: false, message: 'Your role does not include checking companies.', noindex: true }));
  const now = () => new Date().toISOString();

  // Logins used to belong to companies; once, each becomes a person who owns it.
  if (!db.metaGet('upgraded:employer-users-v1')) {
    const list = read();
    const moved = team.migrate(list);
    write(list);
    if (moved) console.log(`Moved ${moved} client login${moved === 1 ? '' : 's'} to company owners`);
    db.metaSet('upgraded:employer-users-v1', now());
  }
  team.pruneAudit();
  setInterval(team.pruneAudit, 24 * 3600000).unref();

  // A company's details for emails to one person (their name and email, the company's name).
  const addressed = (company, user) => ({ ...company, name: user.name, email: user.email });

  // ---------- sessions: one person, working in one company at a time ----------
  // The session's subject is "userId:companyId"; changing company issues a new one.
  const subjectOf = (userId, employerId) => `${userId}:${employerId}`;
  function startSession(res, userId, employerId) {
    const token = newToken();
    db.sessions.set('employer', sha(token), subjectOf(userId, employerId), Date.now() + SESSION_DAYS * 86400000);
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: secureCookie, maxAge: SESSION_DAYS * 86400000, path: '/' });
    const u = team.userById(userId);
    if (u && u.lastEmployerId !== employerId) { u.lastEmployerId = employerId; team.saveUser(u); }
  }
  function endSession(req, res) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) db.sessions.delete('employer', sha(token));
    res.clearCookie(COOKIE, { path: '/' });
  }
  // Signs a person out everywhere, or everyone out of one company.
  const endUserSessions = (userId) => { for (const m of team.membershipsOf(userId)) db.sessions.deleteSubject('employer', subjectOf(userId, m.employerId)); };
  const endCompanySessions = (employerId) => { for (const m of team.membersOf(employerId)) db.sessions.deleteSubject('employer', subjectOf(m.userId, employerId)); db.sessions.deleteSubject('employer', employerId); };

  // The signed-in person, their membership and the company, or null.
  function context(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return null;
    const s = db.sessions.get('employer', sha(token));
    if (!s) return null;
    let [userId, employerId] = s.subject.split(':');
    // Sessions from before people had their own logins name only the company.
    if (!employerId) {
      employerId = userId;
      const owner = team.owners(employerId)[0];
      userId = owner ? owner.userId : '';
    }
    const user = team.userById(userId);
    const member = user && team.membership(user.id, employerId);
    const emp = member && read().find((e) => e.id === employerId);
    if (!user || !user.active || !user.emailVerifiedAt || !emp || !emp.active) return null;
    return { user, member, employer: emp };
  }
  const currentEmployer = (req) => { const c = context(req); return c ? c.employer : null; };
  const companiesOf = (userId) => {
    const list = read();
    return team.membershipsOf(userId).map((m) => ({ member: m, employer: list.find((e) => e.id === m.employerId) })).filter((x) => x.employer && x.employer.active);
  };
  function attach(req, res, c) {
    Object.assign(req, { employer: c.employer, employerUser: c.user, member: c.member });
    Object.assign(res.locals, {
      employer: c.employer, employerUser: c.user, member: c.member, roleLabel: ROLES[c.member.role].label,
      can: (action, job) => can(c.member, action, job), myCompanies: companiesOf(c.user.id),
    });
  }
  const requireEmployer = (req, res, next) => {
    const c = context(req);
    if (!c) return res.redirect('/employer/login');
    attach(req, res, c);
    res.set('Cache-Control', 'no-store');
    next();
  };
  // The same for JSON: a 401 instead of the login page.
  const requireEmployerApi = (req, res, next) => {
    const c = context(req);
    if (!c) return res.status(401).json({ ok: false, errors: ['sign in to your employer account first'] });
    attach(req, res, c);
    res.set('Cache-Control', 'no-store');
    next();
  };
  // Refuses (403) members whose role doesn't allow `action`.
  function forbid(req, res) {
    if (req.path.startsWith('/api/')) return res.status(403).json({ ok: false, errors: ['your role in this company does not allow that'] });
    page(res, 'employer-message', { title: 'Not allowed', heading: 'Your role does not allow this', message: `Ask a company owner at ${req.employer.company} if you need access.` }, 403);
  }
  const allow = (action) => (req, res, next) => (can(req.member, action) ? next() : forbid(req, res));
  setInterval(() => db.sessions.purgeExpired(), 3600000).unref();

  // One link kind at a time per person; issuing a new link voids the old one.
  function issueLink(user, kind, hours) {
    const token = newToken();
    user.link = { kind, hash: sha(token), exp: Date.now() + hours * 3600000 };
    team.saveUser(user);
    return `${baseUrl}/employer/${{ invite: 'setup', reset: 'reset', verify: 'verify' }[kind]}/${token}`;
  }
  function userByLink(token, kind) {
    const u = /^[a-f0-9]{64}$/.test(token) ? team.users().find((x) => x.link && x.link.kind === kind && x.link.hash === sha(token)) : null;
    return u && u.link.exp >= Date.now() && u.active ? u : null;
  }
  // The company to open for a person: the one they used last, else the first.
  function defaultCompany(user) {
    const mine = companiesOf(user.id);
    return (mine.find((x) => x.employer.id === user.lastEmployerId) || mine[0] || {}).employer || null;
  }

  const page = (res, view, locals, status = 200) => res.status(status).render(view, { page: 'employer', noindex: true, errors: [], ...locals });
  const ctx = () => companyContext();

  // ---------- admin: manage clients ----------
  // A client added by the team (also from a won sales opportunity, crm.js):
  // the contact becomes the company's owner. Someone who already has a login
  // (e.g. they work with another client) simply gets access to this one too.
  function createClient({ company: c, name: n, email: e, extra = {} }, byName) {
    const company = String(c || '').trim().slice(0, 120);
    const name = String(n || '').trim().slice(0, 120);
    const email = String(e || '').trim().toLowerCase().slice(0, 160);
    const list = read();
    const errors = [];
    if (!company) errors.push('company is required');
    if (!name) errors.push('contact name is required');
    if (!EMAIL_RE.test(email)) errors.push('email is invalid');
    if (list.some((x) => x.email === email && x.company.toLowerCase() === company.toLowerCase())) errors.push('this client already exists');
    if (errors.length) return { errors };
    const emp = { id: crypto.randomUUID(), company, name, email, active: true, createdAt: now(), ...extra };
    list.push(emp);
    write(list);
    const existing = team.userByEmail(email);
    const user = existing || team.newUser({ email, name });
    team.addMember(emp.id, user.id, 'owner', { by: byName });
    team.audit(emp.id, null, 'company-created', `by ${byName}`);
    const joined = Boolean(existing && existing.passwordHash);
    if (joined) mailer.employerMemberAdded(addressed(emp, user), ROLES.owner.label, `${baseUrl}/employer/login`, null);
    else mailer.employerInvite(addressed(emp, user), issueLink(user, 'invite', INVITE_HOURS), INVITE_HOURS);
    return { errors: [], employer: emp, joined };
  }
  app.post('/admin/clients', adminAuth, sameOrigin, (req, res) => {
    const r = createClient(req.body, req.admin.name);
    if (r.errors.length) return res.redirect(adminUrl('clients', `Could not add client: ${r.errors.join(', ')}`));
    res.redirect(adminUrl('clients', `Invited ${r.employer.name} (${r.employer.company}) · ${r.joined ? 'added to their existing login' : 'setup link emailed'}`));
  });

  // A new set-up or reset link for the company's owners.
  app.post('/admin/clients/:id/invite', adminAuth, sameOrigin, (req, res, next) => {
    const emp = read().find((e) => e.id === req.params.id);
    if (!emp) return next();
    const sentTo = [];
    for (const m of team.owners(emp.id)) {
      const u = team.userById(m.userId);
      if (!u) continue;
      if (u.passwordHash) mailer.employerReset(addressed(emp, u), issueLink(u, 'reset', INVITE_HOURS), INVITE_HOURS);
      else mailer.employerInvite(addressed(emp, u), issueLink(u, 'invite', INVITE_HOURS), INVITE_HOURS);
      sentTo.push(u.email);
    }
    res.redirect(adminUrl('clients', sentTo.length ? `New link emailed to ${sentTo.join(', ')}` : `${emp.company} has no owner to email`));
  });

  app.post('/admin/clients/:id/toggle', adminAuth, sameOrigin, (req, res, next) => {
    const list = read();
    const emp = list.find((e) => e.id === req.params.id);
    if (!emp) return next();
    // A suspension or closure by trust & safety is lifted only from its case or an appeal.
    if (emp.suspension || emp.terminatedAt) return res.redirect(adminUrl('clients', `${emp.company} was ${emp.terminatedAt ? 'closed' : 'suspended'} by trust & safety: change it from its case`));
    emp.active = !emp.active;
    write(list);
    // Deactivating signs everyone at the company out.
    if (!emp.active) endCompanySessions(emp.id);
    team.audit(emp.id, null, emp.active ? 'company-reactivated' : 'company-deactivated', `by ${req.admin.name}`);
    res.redirect(adminUrl('clients', `${emp.company} ${emp.active ? 're-activated' : 'deactivated'}`));
  });

  // Company verification (separate from approving each job): the team checks
  // the company (GSTIN, CIN, website, a call) and verifies or declines it.
  // An open check is waiting for the team, or for the company's answer to a question.
  const OPEN_CHECKS = ['pending', 'info-requested'];
  function closeVerification(emp, outcome, by, note = '') {
    const list = readSubmissions('employer-verifications');
    const open = list.find((v) => v.employerId === emp.id && OPEN_CHECKS.includes(v.status));
    if (open) {
      Object.assign(open, { status: outcome, reviewedAt: now(), reviewedBy: by.name, reviewedById: by.id || '', note });
      writeSubmissions('employer-verifications', list);
      return open;
    }
    return saveSubmission('employer-verifications', { employerId: emp.id, status: outcome, submittedBy: '', reviewedAt: now(), reviewedBy: by.name, reviewedById: by.id || '', note, details: verificationDetails(emp) });
  }
  const verificationDetails = (emp) => Object.fromEntries(['company', 'gstin', 'cin', 'udyam', 'website', 'industry', 'addressLine', 'city', 'state', 'pincode'].map((k) => [k, emp[k] || '']));
  const ownersOf = (emp) => team.owners(emp.id).map((m) => team.userById(m.userId)).filter(Boolean).map((u) => addressed(emp, u));

  // The team's decisions on a company that signed up itself. `by` is the
  // team member ({ id, name }); each returns { errors } or the record.
  function verifyCompany(empId, by) {
    const list = read();
    const emp = list.find((e) => e.id === empId && e.selfSignup);
    if (!emp) return { status: 404, errors: ['company not found'] };
    if (emp.approvedAt) return { status: 409, errors: ['this company is already verified'] };
    if (!emp.active) return { status: 409, errors: ['this company is closed or suspended'] };
    Object.assign(emp, { approvedAt: now(), approvedBy: by.name });
    delete emp.infoRequestedAt;
    write(list);
    const record = closeVerification(emp, 'verified', by);
    team.audit(emp.id, null, 'company-verified', `by ${by.name}`);
    for (const owner of ownersOf(emp)) mailer.employerApproved(owner);
    return { status: 200, employer: emp, record };
  }
  function declineCompany(empId, by, reason) {
    const list = read();
    const emp = list.find((e) => e.id === empId && e.selfSignup && !e.approvedAt);
    if (!emp) return { status: 404, errors: ['company not found or already verified'] };
    if (emp.rejectedAt) return { status: 409, errors: ['this sign-up was already declined'] };
    Object.assign(emp, { active: false, rejectedAt: now(), rejectedReason: reason });
    write(list);
    endCompanySessions(emp.id);
    const record = closeVerification(emp, 'declined', by, reason);
    team.audit(emp.id, null, 'company-declined', reason);
    return { status: 200, employer: emp, record, owners: ownersOf(emp) };
  }
  // Asks the company for more (a document, a website, a call); the company
  // answers by sending its details again from its Company profile.
  function requestCompanyInfo(empId, by, note) {
    const list = read();
    const emp = list.find((e) => e.id === empId && e.selfSignup && !e.approvedAt && e.active);
    if (!emp) return { status: 404, errors: ['company not found or already decided'] };
    const checks = readSubmissions('employer-verifications');
    let record = checks.find((v) => v.employerId === emp.id && OPEN_CHECKS.includes(v.status));
    if (record && record.status === 'info-requested') return { status: 409, errors: ['we are already waiting for this company to answer'] };
    if (record) {
      Object.assign(record, { status: 'info-requested', note, infoRequestedAt: now(), infoRequestedBy: by.name, infoRequestedById: by.id || '' });
      writeSubmissions('employer-verifications', checks);
    } else record = saveSubmission('employer-verifications', { employerId: emp.id, status: 'info-requested', submittedBy: 'sign-up', note, infoRequestedAt: now(), infoRequestedBy: by.name, infoRequestedById: by.id || '', details: verificationDetails(emp) });
    emp.infoRequestedAt = now();
    write(list);
    team.audit(emp.id, null, 'verification-info-requested', note);
    for (const owner of ownersOf(emp)) mailer.employerInfoRequested(owner, note);
    return { status: 200, employer: emp, record };
  }
  // Trust & safety: a suspension (reversible) or a closure; both sign everyone out.
  function restrictCompany(empId, fields) {
    const list = read();
    const emp = list.find((e) => e.id === empId);
    if (!emp) return null;
    Object.assign(emp, { active: false, ...fields });
    write(list);
    endCompanySessions(emp.id);
    team.audit(emp.id, null, fields.terminatedAt ? 'company-closed' : 'company-suspended', fields.suspension ? fields.suspension.reason : fields.terminationReason || '');
    return emp;
  }
  function reinstateCompany(empId, by) {
    const list = read();
    const emp = list.find((e) => e.id === empId);
    if (!emp) return null;
    const history = [...(emp.restrictionHistory || []), { at: now(), by: by.name, suspension: emp.suspension || null, terminatedAt: emp.terminatedAt || null }];
    for (const k of ['suspension', 'terminatedAt', 'terminatedBy', 'terminationReason']) delete emp[k];
    Object.assign(emp, { active: true, restrictionHistory: history.slice(-20) });
    write(list);
    team.audit(emp.id, null, 'company-reinstated', `by ${by.name}`);
    return emp;
  }
  // An appeal against a declined sign-up was upheld: back in the queue.
  function reopenVerification(empId, by) {
    const list = read();
    const emp = list.find((e) => e.id === empId && e.selfSignup && !e.approvedAt);
    if (!emp) return null;
    emp.active = true;
    delete emp.rejectedAt;
    delete emp.rejectedReason;
    write(list);
    saveSubmission('employer-verifications', { employerId: emp.id, status: 'pending', submittedBy: `appeal (reopened by ${by.name})`, details: verificationDetails(emp) });
    team.audit(emp.id, null, 'verification-reopened', `appeal upheld by ${by.name}`);
    return emp;
  }

  app.post('/admin/clients/:id/approve', adminAuth, roleGate('verify.review'), sameOrigin, (req, res, next) => {
    const r = verifyCompany(req.params.id, req.admin);
    if (r.status === 404) return next();
    const emp = r.employer || read().find((e) => e.id === req.params.id);
    if (r.errors && r.status !== 409) return res.redirect(adminUrl('clients', r.errors.join(', ')));
    if (hooks.decided) hooks.decided(req.admin, 'verify', emp, '');
    res.redirect(adminUrl('clients', `${emp.company} approved · their jobs can now go live after review`));
  });

  app.post('/admin/clients/:id/reject', adminAuth, roleGate('verify.review'), sameOrigin, (req, res, next) => {
    const reason = String(req.body.reason || '').trim().slice(0, 500);
    const r = declineCompany(req.params.id, req.admin, reason);
    if (r.errors) return next();
    if (hooks.decided) hooks.decided(req.admin, 'decline', r.employer, reason);
    else for (const owner of r.owners) mailer.employerRejected(owner, reason);
    res.redirect(adminUrl('clients', `${r.employer.company}'s sign-up was declined and the account closed`));
  });

  // ---------- employer: self-signup and email confirmation ----------
  const registerPage = (res, locals, status = 200) => page(res, 'employer-register', { title: 'Create an employer account', values: {}, done: false, industries: INDUSTRIES, sizes: COMPANY_SIZES, ...ctx(), ...locals }, status);
  app.get('/employer/register', (req, res) => {
    if (currentEmployer(req)) return res.redirect('/employer');
    registerPage(res, {});
  });

  // Shared by the form and POST /api/employers/register. Returns errors, or []
  // once the confirmation email is on its way (the same for existing emails).
  function signUp(body) {
    const get = (k, max) => String(body[k] ?? '').trim().slice(0, max);
    const person = { name: get('name', 120), email: get('email', 160).toLowerCase(), phone: get('phone', 20) };
    const { values: company, errors } = parseCompany(
      { company: body.company, industry: body.industry, size: body.size, website: body.website ?? '', gstin: body.gstin ?? '', hiringLocations: body.hiringLocations ?? [], city: body.city ?? '', state: body.state ?? '' },
      ctx(), { required: ['company', 'industry', 'size'] });
    if (!person.name) errors.push('Please enter your name.');
    if (!EMAIL_RE.test(person.email)) errors.push('Please enter a valid work email.');
    if (!PHONE_RE.test(person.phone)) errors.push('Please enter a valid mobile number.');
    const problem = passwordProblem(String(body.password || ''), String(body.confirm ?? body.password ?? ''));
    if (problem) errors.push(`${problem[0].toUpperCase()}${problem.slice(1)}.`);
    if (!(body.agree === true || body.agree === '1' || body.agree === 'on')) errors.push('Please agree to the Terms of Use, Job posting rules and Privacy Policy.');
    if (errors.length) return { errors: [...new Set(errors)], person, company };

    // The same reply either way, so the form can't reveal who has an account.
    const existing = team.userByEmail(person.email);
    if (existing) {
      const own = companiesOf(existing.id)[0];
      mailer.employerAlreadyRegistered({ company: own ? own.employer.company : company.company, name: existing.name, email: existing.email });
      return { errors: [] };
    }
    const emp = {
      id: crypto.randomUUID(), ...company, name: person.name, email: person.email, phone: person.phone, freeEmail: isFreeEmail(person.email),
      active: true, selfSignup: true, createdAt: now(), emailVerifiedAt: null, approvedAt: null, termsAcceptedAt: now(),
    };
    const list = read();
    list.push(emp);
    write(list);
    const user = team.newUser({ ...person, passwordHash: hashPassword(String(body.password)) });
    team.addMember(emp.id, user.id, 'owner', { by: 'sign-up' });
    team.audit(emp.id, user, 'company-registered');
    if (deps.leadCapture) deps.leadCapture.capture('Employer registration', { company: emp.company, name: person.name, email: person.email, phone: person.phone, industry: emp.industry, city: emp.city }, { employerId: emp.id, sourceDetail: 'Employer sign-up' });
    mailer.employerVerify(addressed(emp, user), issueLink(user, 'verify', VERIFY_HOURS), VERIFY_HOURS);
    return { errors: [] };
  }

  app.post('/employer/register', limit('employer-register', 5), sameOrigin, (req, res) => {
    if (String(req.body.website_url || req.body.fax || '').trim()) return registerPage(res, { done: true, title: 'Check your email' }); // bot trap
    const r = signUp(req.body);
    if (r.errors.length) return registerPage(res, { values: { ...req.body, password: '', confirm: '' }, errors: r.errors }, 400);
    registerPage(res, { done: true, title: 'Check your email' });
  });
  app.post('/api/employers/register', limit('employer-register', 5), sameOrigin, (req, res) => {
    const body = req.body || {};
    if (String(body.website_url || '').trim()) return res.status(202).json({ ok: true });
    const r = signUp(body);
    if (r.errors.length) return res.status(400).json({ ok: false, errors: r.errors });
    res.status(202).json({ ok: true, message: 'Check your email: confirm it to open your employer account.' });
  });

  const expired = (res, message) => page(res, 'employer-message', { title: 'Link expired', heading: 'This link has expired', message }, 410);
  // GET shows a button (mail scanners open links); POST confirms.
  app.get('/employer/verify/:token', (req, res) => {
    const user = userByLink(req.params.token, 'verify');
    const emp = user && companiesOf(user.id).map((x) => x.employer)[0];
    if (!user) return expired(res, 'Confirmation links work once and expire after 24 hours. Log in with your email and password and we\'ll send a new one.');
    page(res, 'employer-verify', { title: 'Confirm your email', emp: emp ? addressed(emp, user) : { company: '', email: user.email } });
  });

  app.post('/employer/verify/:token', limit('employer-password', 10), sameOrigin, (req, res) => {
    const user = userByLink(req.params.token, 'verify');
    if (!user) return expired(res, 'Log in with your email and password and we\'ll send a new confirmation link.');
    Object.assign(user, { emailVerifiedAt: now(), link: null });
    team.saveUser(user);
    const list = read();
    const emp = defaultCompany(user) && list.find((e) => e.id === defaultCompany(user).id);
    if (!emp) return expired(res, 'This account is no longer linked to a company.');
    if (!emp.emailVerifiedAt) {
      emp.emailVerifiedAt = user.emailVerifiedAt;
      write(list);
      // Signing up is the company's first request for verification.
      if (!readSubmissions('employer-verifications').some((v) => v.employerId === emp.id && OPEN_CHECKS.includes(v.status))) saveSubmission('employer-verifications', { employerId: emp.id, status: 'pending', submittedBy: user.name, details: verificationDetails(emp) });
      mailer.employerSignedUp(emp, `${baseUrl}/admin?tab=clients`);
    }
    team.audit(emp.id, user, 'email-confirmed');
    startSession(res, user.id, emp.id);
    res.redirect('/employer?welcome=1');
  });

  // ---------- set password (invite) / reset ----------
  for (const kind of ['invite', 'reset']) {
    const route = `/employer/${kind === 'invite' ? 'setup' : 'reset'}/:token`;
    app.get(route, (req, res) => {
      const user = userByLink(req.params.token, kind);
      if (!user) return expired(res, 'Set-up and reset links work once and expire. Ask your Hireriv account manager or a company owner for a new one, or use "Forgot password" on the login page.');
      const emp = defaultCompany(user) || { company: site.name };
      page(res, 'employer-password', { title: kind === 'invite' ? 'Set up your account' : 'Choose a new password', emp: addressed(emp, user), kind });
    });
    app.post(route, limit('employer-password', 10), sameOrigin, (req, res) => {
      const user = userByLink(req.params.token, kind);
      if (!user) return expired(res, 'Ask your Hireriv account manager or a company owner for a new link.');
      const emp = defaultCompany(user);
      const pw = String(req.body.password || '');
      const problem = passwordProblem(pw, String(req.body.confirm || ''));
      if (problem) return page(res, 'employer-password', { title: 'Set your password', emp: addressed(emp || { company: site.name }, user), kind, errors: [problem] }, 400);
      // The link reached their inbox, so the email is confirmed too.
      Object.assign(user, { passwordHash: hashPassword(pw), link: null, passwordSetAt: now(), emailVerifiedAt: user.emailVerifiedAt || now() });
      team.saveUser(user);
      // A password change ends every other session for this person.
      endUserSessions(user.id);
      if (!emp) return expired(res, 'Your password is saved, but your login is not linked to a company any more.');
      team.audit(emp.id, user, kind === 'invite' ? 'joined' : 'password-reset');
      startSession(res, user.id, emp.id);
      res.redirect(kind === 'invite' ? '/employer?welcome=1' : '/employer?msg=' + encodeURIComponent('Password updated. You are signed in.'));
    });
  }

  // ---------- login / logout / forgot / switch company ----------
  app.get('/employer/login', (req, res) => {
    if (currentEmployer(req)) return res.redirect('/employer');
    page(res, 'employer-login', { title: 'Employer login', email: '' });
  });

  app.post('/employer/login', limit('employer-login', 10, 15 * 60 * 1000), sameOrigin, (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const pw = String(req.body.password || '');
    const user = team.userByEmail(email);
    // Same message and similar work for unknown emails, so accounts can't be probed.
    const ok = user && user.active && user.passwordHash ? checkPassword(pw, user.passwordHash) : (hashPassword(pw), false);
    if (!ok) return page(res, 'employer-login', { title: 'Employer login', email, errors: ['Email or password is incorrect.'] }, 401);
    const emp = defaultCompany(user);
    if (!user.emailVerifiedAt) {
      if (emp) mailer.employerVerify(addressed(emp, user), issueLink(user, 'verify', VERIFY_HOURS), VERIFY_HOURS);
      return page(res, 'employer-login', { title: 'Employer login', email, errors: ['Please confirm your email first. We\'ve sent you a new confirmation link.'] }, 403);
    }
    if (!emp) return page(res, 'employer-login', { title: 'Employer login', email, errors: ['Your login is not linked to an active company. Ask a company owner to add you again, or contact us.'] }, 403);
    startSession(res, user.id, emp.id);
    team.audit(emp.id, user, 'signed-in');
    res.redirect('/employer');
  });

  app.post('/employer/logout', sameOrigin, (req, res) => {
    endSession(req, res);
    res.redirect('/employer/login');
  });

  app.get('/employer/forgot', (req, res) => page(res, 'employer-forgot', { title: 'Reset your password', sent: false }));

  app.post('/employer/forgot', limit('employer-forgot', 5), sameOrigin, (req, res) => {
    const user = team.userByEmail(String(req.body.email || '').trim());
    if (user && user.active && user.passwordHash) {
      const emp = defaultCompany(user) || { company: site.name };
      mailer.employerReset(addressed(emp, user), issueLink(user, 'reset', RESET_HOURS), RESET_HOURS);
    }
    page(res, 'employer-forgot', { title: 'Reset your password', sent: true });
  });

  // People who work with several companies switch between them; the company
  // comes from their own memberships, never from what the browser asks for alone.
  app.post('/employer/switch', requireEmployer, limit('employer-switch', 30), sameOrigin, (req, res) => {
    const target = companiesOf(req.employerUser.id).find((x) => x.employer.id === String(req.body.employerId || ''));
    if (!target) return res.redirect('/employer?msg=' + encodeURIComponent('You are not a member of that company.'));
    endSession(req, res);
    startSession(res, req.employerUser.id, target.employer.id);
    res.redirect('/employer?msg=' + encodeURIComponent(`Now working in ${target.employer.company}.`));
  });

  // /employers/* addresses from the product plan lead to the portal pages.
  for (const [from, to] of Object.entries(ALIASES)) {
    app.get(from, (req, res) => res.redirect(301, to));
  }
  app.get('/employers/jobs/:id/edit', (req, res) => res.redirect(301, `/employer/jobs/${encodeURIComponent(req.params.id)}/edit`));

  // ---------- requirements (the team sources the role) ----------
  app.post('/employer/requirements', requireEmployer, allow('requirements.send'), limit('employer-req', 10), sameOrigin, (req, res) => {
    const emp = req.employer;
    const get = (k, max = 2000) => String(req.body[k] ?? '').trim().slice(0, max);
    const data = { roles: get('roles', 300), headcount: get('headcount', 10), hiringType: get('hiringType', 40), location: get('location', 120), timeline: get('timeline', 60), budget: get('budget', 120), message: get('message') };
    if (!data.roles) return res.redirect('/employer?msg=' + encodeURIComponent('Please describe the role(s) you need.'));
    const entry = saveSubmission('hire-requests', { company: emp.company, name: req.employerUser.name, email: req.employerUser.email, phone: req.employerUser.phone || '', ...data, employerId: emp.id, source: 'Client portal', status: 'Received' });
    mailer.hireRequestReceived(entry);
    deps.events.staffingRequest(entry);
    team.audit(emp.id, req.employerUser, 'requirement-sent', data.roles);
    res.redirect('/employer?msg=' + encodeURIComponent('Requirement sent. Your account manager will be in touch within one working day.'));
  });

  // ---------- company profile and verification ----------
  const companyPage = (req, res, locals = {}, status = 200) => page(res, 'employer-company', {
    title: `${req.employer.company} · Company profile`, tab: 'company', industries: INDUSTRIES, sizes: COMPANY_SIZES, ...ctx(),
    verification: verificationOf(req.employer), checks: readSubmissions('employer-verifications').filter((v) => v.employerId === req.employer.id).slice(0, 10),
    values: req.employer, msg: String(req.query.msg || ''), ...locals,
  }, status);
  app.get('/employer/company', requireEmployer, (req, res) => companyPage(req, res));

  // Saves company details. Changing the name or registration numbers of a
  // company awaiting checks sends the new details to the team.
  function updateCompany(req, input) {
    const { values, errors } = parseCompany(input, ctx());
    if (errors.length) return { errors };
    const list = read();
    const emp = list.find((e) => e.id === req.employer.id);
    const changed = Object.keys(values).filter((k) => JSON.stringify(emp[k] ?? '') !== JSON.stringify(values[k]));
    Object.assign(emp, values, { updatedAt: now() });
    write(list);
    if (changed.length) team.audit(emp.id, req.employerUser, 'company-updated', changed.join(', '));
    const identity = changed.filter((k) => ['company', 'gstin', 'cin', 'udyam'].includes(k));
    if (identity.length && verificationOf(emp) === 'verified' && emp.selfSignup) mailer.employerDetailsChanged(emp, req.employerUser, identity, `${baseUrl}/admin?tab=clients`);
    return { employer: emp, errors: [] };
  }
  app.post('/employer/company', requireEmployer, allow('company.edit'), limit('employer-company', 20), sameOrigin, (req, res) => {
    const input = Object.fromEntries(COMPANY_FIELDS.filter((k) => k !== 'hiringLocations').map((k) => [k, req.body[k] ?? '']));
    input.hiringLocations = req.body.hiringLocations ?? [];
    const r = updateCompany(req, input);
    if (r.errors.length) return companyPage(req, res, { values: { ...req.employer, ...input }, errors: r.errors }, 400);
    res.redirect('/employer/company?msg=' + encodeURIComponent('Company profile saved.'));
  });
  // Sends the current details for the team to check (once at a time).
  app.post('/employer/company/verify', requireEmployer, allow('company.verify'), limit('employer-company', 20), sameOrigin, (req, res) => {
    const emp = req.employer;
    if (verificationOf(emp) !== 'pending') return res.redirect('/employer/company?msg=' + encodeURIComponent('Your company is already verified.'));
    if (!emp.gstin && !emp.cin && !emp.udyam && !emp.website) return res.redirect('/employer/company?msg=' + encodeURIComponent('Add a GSTIN, CIN, Udyam number or website first, so our team can check the company.'));
    const list = readSubmissions('employer-verifications');
    const open = list.find((v) => v.employerId === emp.id && OPEN_CHECKS.includes(v.status));
    const reply = String(req.body.reply || '').trim().slice(0, 1000);
    if (open) {
      // An answer to our question puts the check back in the queue.
      Object.assign(open, { status: 'pending', details: verificationDetails(emp), resubmittedAt: now(), submittedBy: req.employerUser.name, ...(reply ? { reply } : {}) });
      writeSubmissions('employer-verifications', list);
    } else saveSubmission('employer-verifications', { employerId: emp.id, status: 'pending', submittedBy: req.employerUser.name, details: verificationDetails(emp), ...(reply ? { reply } : {}) });
    if (emp.infoRequestedAt) { const all = read(); const e = all.find((x) => x.id === emp.id); delete e.infoRequestedAt; write(all); }
    team.audit(emp.id, req.employerUser, 'verification-requested');
    mailer.employerVerificationRequested(emp, req.employerUser, `${baseUrl}/admin?tab=clients`);
    res.redirect('/employer/company?msg=' + encodeURIComponent('Sent to our team. We usually check companies within one working day.'));
  });

  // ---------- team ----------
  const teamPage = (req, res, locals = {}, status = 200) => {
    const users = team.users();
    const rows = team.membersOf(req.employer.id).map((m) => {
      const u = users.find((x) => x.id === m.userId) || {};
      return { ...m, name: u.name, email: u.email, joined: Boolean(u.passwordHash), you: m.userId === req.employerUser.id };
    });
    const jobs = getJobs().filter((j) => j.employerId === req.employer.id);
    page(res, 'employer-team', { title: `${req.employer.company} · Team`, tab: 'team', rows, roles: ROLES, jobs, log: can(req.member, 'team.manage') ? team.auditOf(req.employer.id, 40) : [], msg: String(req.query.msg || ''), values: {}, ...locals }, status);
  };
  const toTeam = (res, msg) => res.redirect('/employer/team?msg=' + encodeURIComponent(msg));
  app.get('/employer/team', requireEmployer, (req, res) => teamPage(req, res));

  app.post('/employer/team', requireEmployer, allow('team.manage'), limit('employer-team', 20), sameOrigin, (req, res) => {
    const name = String(req.body.name || '').trim().slice(0, 120);
    const email = String(req.body.email || '').trim().toLowerCase().slice(0, 160);
    const role = String(req.body.role || '');
    const jobIds = ownJobIds(req, req.body.jobIds);
    const errors = [];
    if (!name) errors.push('Enter their name.');
    if (!EMAIL_RE.test(email)) errors.push('Enter a valid email.');
    if (!ROLE_KEYS.includes(role)) errors.push('Choose a role.');
    // The plan's team seats (subscriptions.js), never more than 50.
    const seats = hooks.seatLimit ? hooks.seatLimit(req.employer) : 50;
    if (team.membersOf(req.employer.id).length >= seats) errors.push(seats < 50 ? `Your plan includes ${seats} team member${seats === 1 ? '' : 's'}. Upgrade under Billing, or remove someone first.` : 'A company can have up to 50 team members.');
    if (errors.length) return teamPage(req, res, { errors, values: { name, email, role } }, 400);
    let user = team.userByEmail(email);
    if (user && team.membership(user.id, req.employer.id)) return toTeam(res, `${email} is already in your team.`);
    const isNew = !user;
    if (!user) user = team.newUser({ email, name });
    team.addMember(req.employer.id, user.id, role, { jobIds, by: req.employerUser.name });
    team.audit(req.employer.id, req.employerUser, 'member-added', `${email} as ${ROLES[role].label}`);
    const who = addressed(req.employer, user);
    if (user.passwordHash) mailer.employerMemberAdded(who, ROLES[role].label, `${baseUrl}/employer/login`, req.employerUser.name);
    else mailer.employerTeamInvite(who, ROLES[role].label, req.employerUser.name, issueLink(user, 'invite', INVITE_HOURS), INVITE_HOURS);
    toTeam(res, isNew || !user.passwordHash ? `Invitation sent to ${email}.` : `${user.name} can now open ${req.employer.company} from their login.`);
  });
  // Only this company's jobs can be assigned.
  function ownJobIds(req, input) {
    const mine = new Set(getJobs().filter((j) => j.employerId === req.employer.id).map((j) => j.id));
    return [...new Set([].concat(input ?? []).map(String))].filter((id) => mine.has(id));
  }
  // The last owner can't be removed or demoted, so a company is never locked out.
  const lastOwner = (m) => m.role === 'owner' && team.owners(m.employerId).length === 1;

  app.post('/employer/team/:id', requireEmployer, allow('team.manage'), limit('employer-team', 40), sameOrigin, (req, res, next) => {
    const m = team.membersOf(req.employer.id).find((x) => x.id === req.params.id);
    if (!m) return next();
    const role = String(req.body.role || m.role);
    if (!ROLE_KEYS.includes(role)) return toTeam(res, 'Choose a role.');
    if (role !== 'owner' && lastOwner(m)) return toTeam(res, 'A company needs at least one owner. Make someone else an owner first.');
    // Nobody changes their own role: another owner does.
    if (m.userId === req.employerUser.id && role !== m.role) return toTeam(res, "You can't change your own role. Ask another owner.");
    team.updateMember(m.id, { role, jobIds: ownJobIds(req, req.body.jobIds) });
    const u = team.userById(m.userId) || {};
    team.audit(req.employer.id, req.employerUser, 'member-changed', `${u.email}: ${ROLES[role].label}`);
    toTeam(res, `Saved ${u.name || 'their'} access.`);
  });
  app.post('/employer/team/:id/remove', requireEmployer, allow('team.manage'), limit('employer-team', 40), sameOrigin, (req, res, next) => {
    const m = team.membersOf(req.employer.id).find((x) => x.id === req.params.id);
    if (!m) return next();
    if (lastOwner(m)) return toTeam(res, 'A company needs at least one owner. Make someone else an owner first.');
    team.removeMember(m.id);
    db.sessions.deleteSubject('employer', subjectOf(m.userId, req.employer.id));
    // They keep nothing from this company, notifications included.
    deps.notify.forgetCompany(`e:${m.userId}`, req.employer.id);
    const u = team.userById(m.userId) || {};
    team.audit(req.employer.id, req.employerUser, 'member-removed', u.email);
    if (m.userId === req.employerUser.id) { res.clearCookie(COOKIE, { path: '/' }); return res.redirect('/employer/login'); }
    toTeam(res, `${u.name || 'They'} no longer ${u.name ? 'has' : 'have'} access to ${req.employer.company}.`);
  });

  // ---------- personal settings: name, mobile verification, password ----------
  const settingsPage = (req, res, locals = {}, status = 200) => page(res, 'employer-settings', {
    title: 'Your settings', tab: 'settings', user: req.employerUser, msg: String(req.query.msg || ''), smsReady: sms.configured(), codeSent: req.query.code === 'sent', ...locals,
  }, status);
  const toSettings = (res, msg, extra = '') => res.redirect(`/employer/settings?msg=${encodeURIComponent(msg)}${extra}`);
  app.get('/employer/settings', requireEmployer, (req, res) => settingsPage(req, res));
  app.post('/employer/settings', requireEmployer, limit('employer-settings', 20), sameOrigin, (req, res) => {
    const u = team.userById(req.employerUser.id);
    const name = String(req.body.name || '').trim().slice(0, 120);
    const phone = String(req.body.phone || '').trim().slice(0, 20);
    if (!name) return toSettings(res, 'Enter your name.');
    if (phone && !PHONE_RE.test(phone)) return toSettings(res, 'Enter a valid mobile number.');
    // A new number needs verifying again.
    if (phone !== u.phone) Object.assign(u, { phone, phoneVerifiedAt: null });
    u.name = name;
    team.saveUser(u);
    toSettings(res, 'Saved.');
  });
  // A 6-digit code by text message; it works once, for 10 minutes.
  const otpKey = (u) => sha(`otp:${u.id}:${u.phone}`);
  app.post('/employer/settings/phone/send', requireEmployer, limit('employer-otp', 5, 60 * 60 * 1000), sameOrigin, (req, res) => {
    const u = req.employerUser;
    if (!PHONE_RE.test(u.phone || '')) return toSettings(res, 'Add your mobile number first.');
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    db.sessions.set('employer-otp', otpKey(u), sha(code), Date.now() + OTP_MINUTES * 60000);
    sms.send(u.phone, `${code} is your ${site.name} verification code. It expires in ${OTP_MINUTES} minutes. Never share it with anyone.`);
    toSettings(res, `We sent a code to ${u.phone}.`, '&code=sent');
  });
  const otpTries = new Map();
  app.post('/employer/settings/phone/verify', requireEmployer, limit('employer-otp-check', 10, 60 * 60 * 1000), sameOrigin, (req, res) => {
    const u = team.userById(req.employerUser.id);
    const s = db.sessions.get('employer-otp', otpKey(u));
    const tries = (otpTries.get(u.id) || 0) + 1;
    otpTries.set(u.id, tries);
    if (!s || tries > 5) { db.sessions.delete('employer-otp', otpKey(u)); return toSettings(res, 'That code has expired. Send a new one.'); }
    const given = String(req.body.code || '').trim();
    if (!/^\d{6}$/.test(given) || !crypto.timingSafeEqual(Buffer.from(sha(given)), Buffer.from(s.subject))) return toSettings(res, 'That code is not right. Check the message and try again.', '&code=sent');
    db.sessions.delete('employer-otp', otpKey(u));
    otpTries.delete(u.id);
    u.phoneVerifiedAt = now();
    team.saveUser(u);
    team.audit(req.employer.id, u, 'mobile-verified');
    toSettings(res, 'Mobile number verified.');
  });
  app.post('/employer/settings/password', requireEmployer, limit('employer-password', 10), sameOrigin, (req, res) => {
    const u = team.userById(req.employerUser.id);
    if (!checkPassword(String(req.body.current || '').slice(0, 200), u.passwordHash)) return toSettings(res, 'Your current password is not right.');
    const problem = passwordProblem(String(req.body.password || ''), String(req.body.confirm || ''));
    if (problem) return toSettings(res, `${problem[0].toUpperCase()}${problem.slice(1)}.`);
    Object.assign(u, { passwordHash: hashPassword(String(req.body.password)), passwordSetAt: now() });
    team.saveUser(u);
    endUserSessions(u.id);
    startSession(res, u.id, req.employer.id);
    team.audit(req.employer.id, u, 'password-changed');
    toSettings(res, 'Password changed. You were signed out on your other devices.');
  });

  // ---------- JSON: the company profile ----------
  const companyJson = (req) => ({
    ok: true,
    company: Object.fromEntries(['id', ...COMPANY_FIELDS].map((k) => [k, req.employer[k] ?? (k === 'hiringLocations' ? [] : '')])),
    verification: verificationOf(req.employer),
    you: { name: req.employerUser.name, email: req.employerUser.email, role: req.member.role, mobileVerified: Boolean(req.employerUser.phoneVerifiedAt) },
    companies: companiesOf(req.employerUser.id).map((x) => ({ id: x.employer.id, company: x.employer.company, role: x.member.role })),
  });
  function patchCompany(req, res) {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
    if (!body) return res.status(400).json({ ok: false, errors: ['send the company details as a JSON object'] });
    const unknown = Object.keys(body).filter((k) => !COMPANY_FIELDS.includes(k));
    if (unknown.length) return res.status(400).json({ ok: false, errors: unknown.map((k) => `${k} can't be changed here`) });
    const r = updateCompany(req, body);
    if (r.errors.length) return res.status(400).json({ ok: false, errors: r.errors });
    req.employer = r.employer;
    res.json(companyJson(req));
  }
  app.get('/api/employers/me', requireEmployerApi, (req, res) => res.json(companyJson(req)));
  app.patch('/api/employers/me', requireEmployerApi, allow('company.edit'), limit('employer-company', 20), sameOrigin, (req, res) => patchCompany(req, res));
  // The same under the client portal's address.
  app.get('/api/client/company-profile', requireEmployerApi, (req, res) => res.json(companyJson(req)));
  app.patch('/api/client/company-profile', requireEmployerApi, allow('company.edit'), limit('employer-company', 20), sameOrigin, (req, res) => patchCompany(req, res));

  // ---------- portal dashboard ----------
  // Jobs this member can see, with applicant counts per stage.
  function visibleJobs(m) {
    return getJobs().filter((j) => j.employerId === m.employerId && can(m, 'job.view', j));
  }
  app.get('/employer', requireEmployer, (req, res) => {
    // Site supervisors work only with the workers they supervise.
    if (req.member.role === 'supervisor') return res.redirect('/employer/workforce');
    if (req.member.role === 'billing') return res.redirect('/employer/billing');
    const emp = req.employer;
    const apps = readSubmissions('applications').filter((a) => !a.duplicateOf);
    const statusOf = (a) => a.status || 'New';
    const myJobs = visibleJobs(req.member).map((j) => {
      const forJob = apps.filter((a) => a.jobId === j.id && !a.withdrawnAt);
      return { ...j, total: forJob.length, fresh: forJob.filter((a) => statusOf(a) === 'New').length, stages: Object.fromEntries(appStatuses.map((s) => [s, forJob.filter((a) => statusOf(a) === s).length])) };
    });
    const count = (s) => myJobs.filter((j) => j.status === s).length;
    const ownIds = new Set(myJobs.filter((j) => j.createdBy === 'employer').map((j) => j.id));
    const nowMs = Date.now();
    const interviews = apps.filter((a) => ownIds.has(a.jobId)).flatMap((a) => (a.interviews || []).filter((iv) => iv.status === 'scheduled' && new Date(iv.at).getTime() > nowMs).map((iv) => ({ ...iv, candidate: a.name, jobTitle: a.jobTitle, appId: a.id })))
      .sort((x, y) => x.at.localeCompare(y.at)).slice(0, 5);
    const requirements = readSubmissions('hire-requests').filter((h) => h.employerId === emp.id);
    page(res, 'employer-dashboard', {
      title: `${emp.company} · Employer dashboard`, tab: 'dashboard', approved: isApproved(emp), verification: verificationOf(emp), myJobs, requirements, stages: appStatuses,
      counts: { open: count('open'), draft: count('draft'), pending: count('pending'), paused: count('paused'), closed: count('closed'), rejected: count('rejected') },
      newApplicants: myJobs.filter((j) => j.createdBy === 'employer').reduce((n, j) => n + j.fresh, 0), interviews,
      shortlist: shortlistFor(emp), placements: can(req.member, 'billing.view') ? placementsFor(emp) : [], timesheets: can(req.member, 'timesheets.review') ? timesheetsFor(emp) : [],
      decisions: DECISIONS, welcome: req.query.welcome === '1', msg: String(req.query.msg || ''), mobileVerified: Boolean(req.employerUser.phoneVerifiedAt),
    });
  });

  // ---------- shortlist sharing (jobs the Hireriv team runs) ----------
  const DECISIONS = ['Interested', 'Maybe', 'Not a fit'];

  // What a client may see about a candidate: no email or phone, so introductions
  // always go through the recruiter.
  const clientView = (a) => {
    const job = getJobs().find((j) => j.id === a.jobId);
    return {
      id: a.id, name: a.name, jobTitle: a.jobTitle, experience: a.experience, location: a.location,
      noticePeriod: a.noticePeriod, skills: a.skills, hasResume: Boolean(a.resume),
      summary: a.shared.summary, sharedAt: a.shared.sharedAt, feedback: a.shared.feedback || null,
      match: skillMatch(a, job),
    };
  };

  app.post('/admin/applications/:id/share', adminAuth, sameOrigin, (req, res, next) => {
    const list = readSubmissions('applications');
    const a = list.find((x) => x.id === req.params.id);
    if (!a) return next();
    const emp = read().find((e) => e.id === req.body.employerId && e.active);
    if (!emp) return res.redirect(adminUrl('applications', 'Pick an active client to share with'));
    const alreadyWithThisClient = a.shared && a.shared.employerId === emp.id;
    a.shared = {
      employerId: emp.id,
      sharedAt: alreadyWithThisClient ? a.shared.sharedAt : now(),
      summary: String(req.body.summary || '').trim().slice(0, 1000),
      feedback: alreadyWithThisClient ? a.shared.feedback : null,
    };
    writeSubmissions('applications', list);
    if (!alreadyWithThisClient) {
      team.audit(emp.id, null, 'candidate-shared', `${a.name} by ${req.admin.name}`);
      for (const m of team.membersOf(emp.id).filter((x) => can(x, 'shortlist.feedback'))) {
        const u = team.userById(m.userId);
        if (u) mailer.candidateShared(addressed(emp, u), a, `${baseUrl}/employer#shortlist`);
      }
    }
    res.redirect(adminUrl('applications', alreadyWithThisClient ? `Updated the summary ${emp.company} sees for ${a.name}` : `Shared ${a.name} with ${emp.company} · client emailed`));
  });

  app.post('/admin/applications/:id/unshare', adminAuth, sameOrigin, (req, res, next) => {
    const list = readSubmissions('applications');
    const a = list.find((x) => x.id === req.params.id);
    if (!a || !a.shared) return next();
    const emp = read().find((e) => e.id === a.shared.employerId);
    delete a.shared;
    writeSubmissions('applications', list);
    res.redirect(adminUrl('applications', `${a.name} is no longer shared${emp ? ` with ${emp.company}` : ''}`));
  });

  const shortlistFor = (emp) =>
    readSubmissions('applications')
      .filter((a) => a.shared && a.shared.employerId === emp.id)
      .sort((x, y) => y.shared.sharedAt.localeCompare(x.shared.sharedAt))
      .map(clientView);

  app.get('/employer/resume/:appId', requireEmployer, allow('shortlist.feedback'), (req, res, next) => {
    const a = readSubmissions('applications').find((x) => x.id === req.params.appId);
    // Only candidates shared with this client, never by guessing ids.
    if (!a || !a.shared || a.shared.employerId !== req.employer.id || !a.resume) return next();
    if (!downloadLinks.valid(req)) return linkExpired(res, '/employer');
    team.audit(req.employer.id, req.employerUser, 'resume-downloaded', `${a.name} (shortlist)`);
    const file = path.basename(a.resume);
    const safeName = `${String(a.name).replace(/[^a-z0-9]+/gi, '-')}-resume${path.extname(file)}`;
    vault.send(res, path.join(uploadsDir, file), safeName, 'Resume');
  });

  app.post('/employer/candidates/:appId/feedback', requireEmployer, allow('shortlist.feedback'), limit('employer-feedback', 60), sameOrigin, (req, res, next) => {
    const list = readSubmissions('applications');
    const a = list.find((x) => x.id === req.params.appId);
    if (!a || !a.shared || a.shared.employerId !== req.employer.id) return next();
    const r = shortlistFeedback(req, a.id, req.body.decision, req.body.comment);
    res.redirect('/employer?msg=' + encodeURIComponent(r.errors ? r.errors.join(' ') : `Thanks! Your feedback on ${r.name} was sent to your account manager.`) + '#shortlist');
  });
  // A client's answer on a shared candidate. A reason is kept with every
  // "Not a fit", and earlier answers stay in the history.
  function shortlistFeedback(req, appId, decisionIn, commentIn) {
    const list = readSubmissions('applications');
    const a = list.find((x) => x.id === appId);
    if (!a || !a.shared || a.shared.employerId !== req.employer.id) return { status: 404, errors: ['candidate not found'] };
    const decision = String(decisionIn || '');
    const comment = String(commentIn || '').trim().slice(0, 1000);
    if (!DECISIONS.includes(decision)) return { status: 400, errors: ['Choose Interested, Maybe or Not a fit.'] };
    if (decision === 'Not a fit' && !comment) return { status: 400, errors: ['Say why they are not a fit, so your recruiter can find better matches.'] };
    if (a.shared.feedback) a.shared.feedbackHistory = [...(a.shared.feedbackHistory || []), a.shared.feedback].slice(-20);
    a.shared.feedback = { decision, comment, by: req.employerUser.name, userId: req.employerUser.id, at: now() };
    writeSubmissions('applications', list);
    team.audit(req.employer.id, req.employerUser, 'shortlist-feedback', `${a.name}: ${decision}${comment ? ` (${comment.slice(0, 120)})` : ''}`);
    mailer.clientFeedback(addressed(req.employer, req.employerUser), a, a.shared.feedback, `${baseUrl}/admin?tab=applications`);
    return { status: 200, name: a.name, feedback: a.shared.feedback };
  }

  const verification = { verifyCompany, declineCompany, requestCompanyInfo, restrictCompany, reinstateCompany, reopenVerification, OPEN_CHECKS };
  return { verification, hooks, read, write, team, context, currentEmployer, requireEmployer, requireEmployerApi, allow, forbid, shortlistFor, shortlistFeedback, clientView, createClient, DECISIONS, isApproved, verificationOf, addressed, membersWith: (employerId, action, job) => team.membersOf(employerId).filter((m) => can(m, action, job)) };
}

module.exports = { register, hashPassword, checkPassword, validGstin, gstinCheckChar, isFreeEmail, isApproved, parseCompany, verificationOf, INDUSTRIES, COMPANY_SIZES };
