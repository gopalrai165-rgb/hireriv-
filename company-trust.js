// Company verification as the company sends it (Step 64): business details,
// an optional authorised representative and business documents, kept
// encrypted in private storage and opened only by verification reviewers
// through signed, logged links (trust.js). Also the public company page with
// "Report this company", and the labels candidates see on jobs and companies.
//
// What a label claims is exactly what was checked, and when; verification is
// never presented as a guarantee. We never ask for Aadhaar, PAN, bank details
// or anything else personal to verify a company.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const vault = require('./vault');
const { DOCUMENT_TYPES } = require('./uploads');
const { isFreeEmail, verificationOf } = require('./employers');

const DAY = 86400000;
const CHECKS = 'employer-verifications';
const MAX_DOCUMENTS = 5;
// Documents are deleted this long after the check is decided; the decision stays.
const DOCUMENT_RETENTION_DAYS = 365;
const DOC_TYPES = {
  'gst-certificate': 'GST registration certificate',
  'incorporation-certificate': 'Certificate of incorporation',
  'udyam-certificate': 'Udyam registration certificate',
  'shop-establishment': 'Shop & establishment licence',
  'authorization-letter': 'Letter on company letterhead authorising the representative',
  'other-business': 'Other business registration document',
};
const NOT_A_GUARANTEE = 'Verification means our team checked these details at that time. It is not a guarantee about the employer or the job. Never pay to apply, and never share bank details, Aadhaar, an OTP or a UPI PIN.';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MOBILE_RE = /^(?:\+?91)?[6-9]\d{9}$/;
const clip = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const iso = (ms = Date.now()) => new Date(ms).toISOString();
const dateIn = (s) => (s ? new Date(s).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '');
const hostOf = (url) => String(url || '').replace(/^https?:\/\//i, '').split(/[/?#:]/)[0].replace(/^www\./, '').toLowerCase();

function register(app, deps) {
  const { db, clients, getJobs, jobPath, readSubmissions, writeSubmissions, saveSubmission, sameOrigin, limit, isBot, mailer, site, baseUrl, uploadsDir, vetDocument, trust, isLive } = deps;
  const { requireEmployer, requireEmployerApi, allow, team } = clients;
  const { OPEN_CHECKS, verificationDetails } = clients.verification;

  // ---------- documents ----------
  const docDir = path.join(uploadsDir, 'verification-documents');
  fs.mkdirSync(docDir, { recursive: true });
  const upload = multer({
    storage: multer.diskStorage({ destination: docDir, filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`) }),
    limits: { fileSize: 5 * 1024 * 1024, files: 3, fields: 30 },
    fileFilter: (req, file, cb) => {
      const ok = DOCUMENT_TYPES.includes(path.extname(file.originalname).toLowerCase());
      cb(ok ? null : Object.assign(new Error('Documents must be PDF, JPG or PNG files'), { status: 400 }), ok);
    },
  });
  const dropAll = (files) => { for (const f of files || []) fs.unlink(f.path, () => {}); };
  // Multer problems (wrong type, too big) as a clear answer, not a crash.
  const takeDocuments = (req, res, next) => upload.array('documents', 3)(req, res, (err) => {
    if (!err) return next();
    dropAll(req.files);
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'Each document can be up to 5 MB' : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE' ? 'Send up to 3 documents at a time' : err.status === 400 ? err.message : 'That upload did not work';
    if (req.path.startsWith('/api/')) return res.status(400).json({ ok: false, errors: [message] });
    res.redirect(`/employer/company?msg=${encodeURIComponent(message)}`);
  });

  // The representative: optional (it speeds up checking) but checked when given.
  function parseRepresentative(input, errors) {
    const src = input.representative && typeof input.representative === 'object' ? input.representative : { name: input.repName, designation: input.repDesignation, email: input.repEmail, phone: input.repPhone };
    const rep = { name: clip(src.name, 120), designation: clip(src.designation, 80), email: clip(src.email, 160).toLowerCase(), phone: clip(src.phone, 16).replace(/[\s-]/g, '') };
    if (!rep.name && !rep.designation && !rep.email && !rep.phone) return null;
    if (rep.name.length < 2) errors.push("Representative: enter the person's full name.");
    if (rep.designation.length < 2) errors.push('Representative: enter their designation (for example HR Manager or Director).');
    if (!EMAIL_RE.test(rep.email)) errors.push('Representative: enter their work email.');
    if (!MOBILE_RE.test(rep.phone)) errors.push('Representative: enter a 10-digit Indian mobile number.');
    return rep;
  }

  // { status, errors?, check? }. The company comes from the session, never the request.
  async function submitVerification(req, input, files) {
    const emp = clients.read().find((e) => e.id === req.employer.id);
    const errors = [];
    if (verificationOf(emp) === 'verified' && !emp.recheck) { dropAll(files); return { status: 409, errors: ['Your company is already verified.'] }; }
    const rep = parseRepresentative(input, errors);
    // The form has a type beside each file box; only chosen types count, in order.
    const types = [].concat(input.docType ?? input.docTypes ?? []).map(String).filter(Boolean);
    (files || []).forEach((f, i) => { if (!DOC_TYPES[types[i]]) errors.push(`Choose what document ${i + 1} is.`); });
    if (errors.length) { dropAll(files); return { status: 400, errors: [...new Set(errors)] }; }
    const list = readSubmissions(CHECKS);
    const open = list.find((v) => v.employerId === emp.id && OPEN_CHECKS.includes(v.status));
    const kept = open ? (open.documents || []).filter((d) => !d.purgedAt).length : 0;
    if (kept + (files || []).length > MAX_DOCUMENTS) { dropAll(files); return { status: 400, errors: [`Up to ${MAX_DOCUMENTS} documents can be sent for one check.`] }; }
    if (!emp.gstin && !emp.cin && !emp.udyam && !emp.website && !kept && !(files || []).length) { dropAll(files); return { status: 400, errors: ['Add a GSTIN, CIN, Udyam number or website to your company details, or attach a business registration document, so our team can check the company.'] }; }
    // Each file is checked (real PDF or image, no active content) and sealed.
    const docs = [];
    for (const [i, f] of (files || []).entries()) {
      const bad = await vetDocument(f);
      if (bad) { dropAll(files); return { status: 400, errors: [bad] }; }
      docs.push({ id: crypto.randomUUID(), type: types[i], typeLabel: DOC_TYPES[types[i]], file: path.basename(f.filename), originalName: clip(f.originalname, 120), size: f.size, sha256: sha256(vault.readSync(f.path)), by: req.employerUser.name, at: iso() });
    }
    const reply = clip(input.reply, 1000);
    const fields = { details: verificationDetails(emp), submittedBy: req.employerUser.name, ...(rep ? { representative: rep } : {}), ...(reply ? { reply } : {}) };
    let check;
    if (open) {
      // An answer to our question, or more documents, puts the check back in the queue.
      Object.assign(open, fields, { status: 'pending', resubmittedAt: iso(), documents: [...(open.documents || []), ...docs] });
      writeSubmissions(CHECKS, list);
      check = open;
    } else check = saveSubmission(CHECKS, { employerId: emp.id, status: 'pending', ...fields, documents: docs });
    if (emp.infoRequestedAt) { const all = clients.read(); const e = all.find((x) => x.id === emp.id); delete e.infoRequestedAt; clients.write(all); }
    team.audit(emp.id, req.employerUser, 'verification-requested', docs.length ? `${docs.length} document${docs.length === 1 ? '' : 's'}` : '');
    mailer.employerVerificationRequested(emp, req.employerUser, `${baseUrl}/admin/verifications`);
    return { status: 202, check };
  }
  // What the company sees of its own check: never other people's notes.
  const checkJson = (c) => ({
    id: c.id, status: c.status, kind: c.kind || 'first', submittedAt: c.resubmittedAt || c.createdAt,
    representative: c.representative ? { name: c.representative.name, designation: c.representative.designation } : null,
    documents: (c.documents || []).map((d) => ({ id: d.id, type: d.type, typeLabel: d.typeLabel, name: d.purgedAt ? null : d.originalName, size: d.size, at: d.at, deleted: Boolean(d.purgedAt) })),
    question: c.status === 'info-requested' ? c.note || '' : null,
  });

  app.post('/employer/company/verify', requireEmployer, allow('company.verify'), limit('employer-company', 20), sameOrigin, takeDocuments, async (req, res, next) => {
    try {
      const r = await submitVerification(req, req.body || {}, req.files || []);
      res.redirect(`/employer/company?msg=${encodeURIComponent(r.errors ? r.errors.join(' ') : 'Sent to our team. We usually check companies within one working day.')}`);
    } catch (err) { next(err); }
  });
  // The API: the company in the address must be the signed-in person's own (404 otherwise).
  app.post('/api/companies/:id/verification', requireEmployerApi, allow('company.verify'), limit('employer-company', 20), sameOrigin, takeDocuments, async (req, res, next) => {
    try {
      if (req.params.id !== req.employer.id) { dropAll(req.files); return res.status(404).json({ ok: false, errors: ['company not found'] }); }
      const r = await submitVerification(req, req.body || {}, req.files || []);
      if (r.errors) return res.status(r.status).json({ ok: false, errors: r.errors });
      res.status(202).json({ ok: true, verification: checkJson(r.check) });
    } catch (err) { next(err); }
  });
  app.get('/api/companies/:id/verification', requireEmployerApi, (req, res) => {
    if (req.params.id !== req.employer.id) return res.status(404).json({ ok: false, errors: ['company not found'] });
    const checks = readSubmissions(CHECKS).filter((v) => v.employerId === req.employer.id).slice(0, 10);
    res.json({ ok: true, verificationStatus: verificationOf(req.employer), recheck: Boolean(req.employer.recheck), label: companyBadge(req.employer), checks: checks.map(checkJson) });
  });

  // ---------- labels candidates see ----------
  const documentsChecked = (emp) => readSubmissions(CHECKS).some((v) => v.employerId === emp.id && v.status === 'verified' && (v.documents || []).length);
  function companyBadge(emp) {
    if (!emp) return null;
    if (!emp.selfSignup) return { level: 'business', label: 'Verified employer', explain: `A client company the ${site.name} team set up and checked directly.`, note: NOT_A_GUARANTEE };
    if (emp.approvedAt) {
      return {
        level: 'business', label: emp.recheck ? 'Verified employer · new details being checked' : 'Verified employer', checkedAt: emp.checkedAt || emp.approvedAt,
        explain: `${site.name} checked this company's registration details${documentsChecked(emp) ? ' and business documents' : ''} on ${dateIn(emp.checkedAt || emp.approvedAt)}.${emp.recheck ? ' It recently changed its name or registration numbers, and our team is checking the new details.' : ''}`,
        note: NOT_A_GUARANTEE,
      };
    }
    const owner = (team.owners(emp.id) || []).map((m) => team.userById(m.userId)).find(Boolean);
    if (emp.emailVerifiedAt && owner && owner.phoneVerifiedAt) return { level: 'contact', label: 'Contact details confirmed', explain: `The company's email address and mobile number are confirmed. ${site.name} has not finished checking the business yet, so its jobs are reviewed by our team before they go live.`, note: NOT_A_GUARANTEE };
    return { level: 'none', label: 'Not yet verified', explain: `${site.name} has not checked this company yet. Until it does, the company can only send a few jobs, and each one is reviewed by our team before it goes live.`, note: NOT_A_GUARANTEE };
  }
  // The person who posted the job: their email and mobile, and whether the
  // email is on the company's own website domain. No name or contact shown.
  function recruiterLabel(job, emp) {
    const u = job.createdByUser && team.userById(job.createdByUser);
    if (!u || !u.emailVerifiedAt || !u.phoneVerifiedAt) return null;
    const site = hostOf(emp && emp.website);
    const onDomain = site && !isFreeEmail(u.email) && String(u.email).toLowerCase().endsWith(`@${site}`);
    return { label: onDomain ? 'Recruiter uses a work email on the company domain' : "Recruiter's email and mobile confirmed", explain: onDomain ? `The person who posted this job confirmed an email address on ${site} and a mobile number.` : 'The person who posted this job confirmed their email address and mobile number.' };
  }
  // "Call HR" for people who applied: the confirmed mobile and first name of
  // the person who created the job, when the company chose to share it.
  function hrContactFor(job) {
    if (!job || !job.hrCall || job.createdBy !== 'employer' || job.status !== 'open') return null;
    const u = job.createdByUser && team.userById(job.createdByUser);
    if (!u || u.active === false || !u.phone || !u.phoneVerifiedAt) return null;
    return { name: String(u.name || '').trim().split(/\s+/)[0] || '', phone: u.phone };
  }
  function labelsFor(job) {
    if (!job || job.sample) return null;
    const emp = job.employerId ? clients.read().find((e) => e.id === job.employerId) : null;
    const listing = job.createdBy === 'employer'
      ? (job.approvedAt ? { label: `Listing checked by ${site.name}`, explain: `Our team reviewed this listing before it went live (${dateIn(job.approvedAt)}). Changes the company makes are checked again before they show.` } : null)
      : { label: `Posted by ${site.name}`, explain: `Our recruitment team posted this role for a client and handles applications.` };
    return { company: emp ? companyBadge(emp) : null, listing, recruiter: emp ? recruiterLabel(job, emp) : null, profileUrl: emp && publicCompany(emp.id) ? `/companies/${encodeURIComponent(emp.id)}` : null, note: NOT_A_GUARANTEE };
  }

  // ---------- the public company page ----------
  // Only companies with live jobs have a page; anything else is not found.
  function publicCompany(id) {
    const emp = clients.read().find((e) => e.id === id && e.active && !e.terminatedAt && !e.suspension);
    if (!emp) return null;
    const jobs = getJobs().filter((j) => j.employerId === emp.id && isLive(j) && !j.sample);
    return jobs.length ? { emp, jobs } : null;
  }
  app.get('/companies/:id', limit('company-page', 120), (req, res, next) => {
    const found = publicCompany(String(req.params.id).slice(0, 80));
    if (!found) return next();
    const { emp, jobs } = found;
    res.render('company', {
      title: `${emp.company} · Jobs and company details`, page: 'jobs', metaDescription: `${emp.company}${emp.industry ? ` (${emp.industry})` : ''}: ${jobs.length} open job${jobs.length === 1 ? '' : 's'} on ${site.name}.`.slice(0, 300),
      company: { id: emp.id, name: emp.company, industry: emp.industry || '', size: emp.size || '', city: emp.city || '', state: emp.state || '', website: /^https:\/\//i.test(emp.website || '') ? emp.website : '', about: emp.about || '' },
      badge: companyBadge(emp), jobs, reportReasons: Object.keys(trust.REASON_CATEGORY), help: trust.CYBERCRIME_HELP,
    });
  });

  // ---------- retention ----------
  // Documents go a year after the check is decided (or the sign-up closed);
  // the check, its decision and the document's fingerprint stay.
  function prune() {
    const cutoff = iso(Date.now() - DOCUMENT_RETENTION_DAYS * DAY);
    const list = readSubmissions(CHECKS);
    let n = 0;
    for (const c of list.filter((v) => !OPEN_CHECKS.includes(v.status) && (v.reviewedAt || v.updatedAt || v.createdAt) < cutoff)) {
      for (const d of (c.documents || []).filter((x) => !x.purgedAt)) {
        fs.unlink(path.join(docDir, path.basename(d.file)), () => {});
        Object.assign(d, { purgedAt: iso(), originalName: 'deleted', file: '' });
        n++;
      }
      if (c.representative && c.representative.phone) { c.representative = { name: c.representative.name, designation: c.representative.designation, email: '', phone: '', purgedAt: iso() }; n++; }
    }
    if (n) writeSubmissions(CHECKS, list);
    return n;
  }
  setInterval(() => { try { prune(); } catch (e) { console.error('Verification document retention failed:', e.message); } }, DAY).unref();

  return { labelsFor, hrContactFor, companyBadge, submitVerification, prune, DOC_TYPES };
}

module.exports = { register, DOC_TYPES, NOT_A_GUARANTEE };
