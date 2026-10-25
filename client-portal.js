// The client employer's self-service portal on top of what exists: contracts
// with Hireriv as versioned documents the client reviews and signs, bulk
// hiring requests, the shortlist with recorded reasons, interviews, invoices,
// reports and the team, under /client/* and /api/client/*.
//
// The company always comes from the signed-in person's membership
// (employers.js context), never from the request, and each action is checked
// against their role there (employer-team.js can()). Contract documents are
// written by the Hireriv team (agency-roles.js clients.manage), reviewed by a
// second person before they go to the client, and signed by a company owner;
// the signature keeps its evidence and the exact text's SHA-256.
const crypto = require('crypto');
const roles = require('./agency-roles');
const { parseRequisition } = require('./agency');

const DAY = 86400000;
const iso = () => new Date().toISOString();
const todayIst = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const inr = (paise) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(paise / 100);
const pct = (bp) => `${bp / 100}%`;

// draft → pending_review → sent → signed → active → expired, or terminated
// at any point before it expires. A client asking for changes ends that
// version; the next one starts as a new draft.
const STATUSES = ['draft', 'pending_review', 'sent', 'signed', 'active', 'expired', 'terminated'];
const LABEL = { draft: 'Draft', pending_review: 'Waiting for review', sent: 'Sent for signature', signed: 'Signed', active: 'Active', expired: 'Expired', terminated: 'Terminated' };
const CLIENT_SEES = ['sent', 'signed', 'active', 'expired', 'terminated'];
const MAX_BULK = 20;

function register(app, deps) {
  const {
    team, clients, billing, agency, workforce, readSubmissions, writeSubmissions, saveSubmission, adminAuth, sameOrigin, limit, site, mailer, baseUrl,
    requireEmployer, requireEmployerApi, can: employerCan, getJobs, secret,
  } = deps;
  const versions = () => readSubmissions('contract-versions');
  const contracts = () => readSubmissions('client-contracts');
  const clientById = (id) => clients.read().find((c) => c.id === id) || null;
  const update = (collection, id, fn) => {
    const list = readSubmissions(collection);
    const rec = list.find((x) => x.id === id);
    if (!rec) return null;
    fn(rec);
    rec.updatedAt = iso();
    writeSubmissions(collection, list);
    return rec;
  };
  function teamAudit(user, action, entityId, detail, employerId) {
    saveSubmission('agency-audit', { actorId: user ? user.id : '', actorName: user ? user.name : 'System', role: user ? user.role : '', action, entity: 'contract-version', entityId, employerId, detail: String(detail).slice(0, 300) });
    if (user) team.log(user, `${action}: ${detail}`.slice(0, 300), 'clients');
  }
  const clientAudit = (req, event, detail) => clients.team.audit(req.employer.id, req.employerUser, event, detail);
  const canManageClient = (u, employerId) => {
    if (!roles.can(u, 'clients.manage')) return false;
    if (u.role !== 'Account Manager') return true;
    const c = clientById(employerId);
    return Boolean(c && c.accountManagerId === u.id);
  };

  // ---------- contract documents ----------
  // The text the client signs: the contract's terms as recorded, then the
  // clauses written for this version.
  function documentText(c, client, title, clauses) {
    const lines = [
      title,
      '',
      `Between ${site.name} ("Hireriv") and ${client.company} ("the Client")${client.gstin ? `, GSTIN ${client.gstin}` : ''}.`,
      `Contract reference: ${c.reference}. Covers: ${c.kind}.`,
      `Term: from ${c.startsOn}${c.endsOn ? ` to ${c.endsOn}` : ', with no fixed end date'}.`,
    ];
    if (c.kind !== 'Temporary & contract staffing') {
      lines.push(c.feeMode === 'flat' ? `Permanent recruitment fee: ${inr(c.flatFeePaise)} per hire, plus GST.` : `Permanent recruitment fee: ${pct(c.feeBp)} of the hire's annual CTC, plus GST.`);
      if (c.guaranteeDays !== null && c.guaranteeDays !== undefined) lines.push(`Replacement guarantee: ${c.guaranteeDays} days from joining.`);
    }
    if (c.markupBp !== null && c.markupBp !== undefined) lines.push(`Temporary and contract staffing: billed per assignment at the agreed bill rates (markup ${pct(c.markupBp)} on pay).`);
    lines.push(`Payment: within ${c.paymentDays} days of each invoice.`);
    if (clauses) lines.push('', clauses);
    return lines.join('\n');
  }
  // Activation and expiry follow the dates; run on every read and hourly.
  function refresh() {
    const list = versions();
    const today = todayIst();
    let changed = false;
    const cs = contracts();
    let csChanged = false;
    for (const v of list) {
      const c = cs.find((x) => x.id === v.contractId);
      if (!c) continue;
      if (v.status === 'signed' && c.startsOn <= today) {
        v.status = 'active';
        v.history.push({ at: iso(), by: 'Hireriv', text: 'Active from its start date' });
        // An earlier active version of the same contract is replaced.
        for (const o of list) if (o.contractId === v.contractId && o.id !== v.id && o.status === 'active') { o.status = 'expired'; o.history.push({ at: iso(), by: 'Hireriv', text: `Replaced by version ${v.version}` }); }
        if (c.status !== 'Active') { c.status = 'Active'; csChanged = true; }
        c.documentVersionId = v.id;
        csChanged = true;
        changed = true;
      }
      if (['active', 'signed'].includes(v.status) && c.endsOn && c.endsOn < today) {
        v.status = 'expired';
        v.history.push({ at: iso(), by: 'Hireriv', text: `Expired on ${c.endsOn}` });
        changed = true;
      }
    }
    if (changed) writeSubmissions('contract-versions', list);
    if (csChanged) writeSubmissions('client-contracts', cs);
  }
  const FIELDS = ['title', 'clauses'];
  function createVersion(user, contractId, input) {
    const c = contracts().find((x) => x.id === contractId);
    if (!c) return { status: 404, errors: ['contract not found'] };
    if (!canManageClient(user, c.employerId)) return { status: 403, errors: ["only an Admin or this client's account manager writes its contracts"] };
    const body = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const unknown = Object.keys(body).filter((k) => !FIELDS.includes(k));
    if (unknown.length) return { status: 400, errors: unknown.map((k) => `${k} is not a field you can set`) };
    const title = String(body.title || '').trim().replace(/\s+/g, ' ') || `${c.kind} agreement`;
    const clauses = String(body.clauses || '').replace(/\r\n/g, '\n').trim();
    const errors = [];
    if (title.length > 120) errors.push('title must be 120 characters or fewer');
    if (clauses.length > 20000) errors.push('clauses must be 20,000 characters or fewer');
    if (errors.length) return { status: 400, errors };
    if (versions().some((v) => v.contractId === c.id && ['draft', 'pending_review', 'sent'].includes(v.status))) return { status: 409, errors: ['this contract already has a version in progress: finish or terminate it first'] };
    const client = clientById(c.employerId);
    const text = documentText(c, client, title, clauses);
    const version = versions().filter((v) => v.contractId === c.id).length + 1;
    const v = saveSubmission('contract-versions', {
      contractId: c.id, employerId: c.employerId, reference: c.reference, version, title, clauses, text, sha256: sha256(text), status: 'draft',
      authorId: user.id, authorName: user.name, reviewerId: null, signature: null, history: [{ at: iso(), by: user.name, text: `Version ${version} drafted` }],
    });
    teamAudit(user, 'contract-drafted', v.id, `${c.reference} v${version}`, c.employerId);
    return { status: 201, version: v };
  }
  function changeVersion(user, id, input) {
    const v = versions().find((x) => x.id === id);
    if (!v) return { status: 404, errors: ['version not found'] };
    if (!canManageClient(user, v.employerId)) return { status: 403, errors: ["only an Admin or this client's account manager writes its contracts"] };
    if (v.status !== 'draft') return { status: 409, errors: [`a version is changed only as a draft; this one is ${LABEL[v.status].toLowerCase()}`] };
    const c = contracts().find((x) => x.id === v.contractId);
    const body = input && typeof input === 'object' ? input : {};
    const unknown = Object.keys(body).filter((k) => !FIELDS.includes(k));
    if (unknown.length) return { status: 400, errors: unknown.map((k) => `${k} is not a field you can set`) };
    const title = body.title === undefined ? v.title : String(body.title).trim().replace(/\s+/g, ' ');
    const clauses = body.clauses === undefined ? v.clauses : String(body.clauses).replace(/\r\n/g, '\n').trim();
    if (!title || title.length > 120 || clauses.length > 20000) return { status: 400, errors: ['title must be 1–120 characters and clauses at most 20,000'] };
    const text = documentText(c, clientById(v.employerId), title, clauses);
    const saved = update('contract-versions', id, (x) => { Object.assign(x, { title, clauses, text, sha256: sha256(text) }); x.history.push({ at: iso(), by: user.name, text: 'Draft changed' }); });
    return { status: 200, version: saved };
  }
  // Moves the team makes; sending needs a second person's review.
  function moveVersion(user, id, action, input = {}) {
    const v = versions().find((x) => x.id === id);
    if (!v) return { status: 404, errors: ['version not found'] };
    if (!canManageClient(user, v.employerId)) return { status: 403, errors: ["only an Admin or this client's account manager handles its contracts"] };
    const reason = String((input && input.reason) || '').trim().slice(0, 300);
    let next;
    let text;
    if (action === 'submit') {
      if (v.status !== 'draft') return { status: 409, errors: ['only a draft goes for review'] };
      next = 'pending_review';
      text = 'Sent for internal review';
    } else if (action === 'send') {
      if (v.status !== 'pending_review') return { status: 409, errors: ['a version is reviewed before it is sent'] };
      if (v.authorId === user.id) return { status: 403, errors: ['someone other than the author reviews and sends it'] };
      next = 'sent';
      text = `Reviewed by ${user.name} and sent to the client`;
    } else if (action === 'back') {
      if (v.status !== 'pending_review') return { status: 409, errors: ['only a version waiting for review goes back'] };
      if (!reason) return { status: 400, errors: ['say what needs changing'] };
      next = 'draft';
      text = `Sent back by ${user.name}: ${reason}`;
    } else if (action === 'terminate') {
      if (['expired', 'terminated'].includes(v.status)) return { status: 409, errors: [`already ${LABEL[v.status].toLowerCase()}`] };
      if (!reason) return { status: 400, errors: ['say why it ends'] };
      next = 'terminated';
      text = `Terminated by ${user.name}: ${reason}`;
    } else return { status: 400, errors: ['unknown action'] };
    const before = v.status;
    const saved = update('contract-versions', id, (x) => {
      x.status = next;
      if (action === 'send') Object.assign(x, { reviewerId: user.id, reviewerName: user.name, sentAt: iso() });
      if (action === 'terminate') Object.assign(x, { terminatedAt: iso(), terminationReason: reason });
      x.history.push({ at: iso(), by: user.name, text });
    });
    // Ending the active version ends the contract's terms for new placements.
    if (action === 'terminate' && before === 'active') update('client-contracts', v.contractId, (c) => { c.status = 'Ended'; c.endsOn = c.endsOn && c.endsOn < todayIst() ? c.endsOn : todayIst(); });
    teamAudit(user, `contract-${action}`, id, `${v.reference} v${v.version}: ${LABEL[before]} → ${LABEL[next]}${reason ? ` (${reason})` : ''}`, v.employerId);
    if (action === 'send') tellOwners(v, 'sent');
    return { status: 200, version: saved };
  }
  // Company owners hear about a contract waiting for their signature.
  function tellOwners(v, kind) {
    const store = clients.team;
    const emp = clientById(v.employerId);
    for (const m of store.owners(v.employerId)) {
      const u = store.userById(m.userId);
      if (!u || !u.active || !u.emailVerifiedAt || !emp) continue;
      mailer.notice({ name: u.name, email: u.email, kind: 'employer' }, kind === 'sent'
        ? { subject: `Contract to review and sign: ${v.reference}`, heading: 'A contract is ready for you', intro: `${site.name} sent ${emp.company} version ${v.version} of "${v.title}". Please read it and sign it, or ask for changes.`, rows: [['Reference', v.reference], ['Version', String(v.version)]], link: `${baseUrl}/employer/contracts/${v.id}`, label: 'Review the contract' }
        : { subject: `Contract signed: ${v.reference}`, heading: 'Contract signed', intro: `${v.signature.name} signed version ${v.version} of "${v.title}" for ${emp.company}. Keep this email for your records.`, rows: [['Signed', v.signature.at], ['Document fingerprint (SHA-256)', v.sha256]], link: `${baseUrl}/employer/contracts/${v.id}`, label: 'Open the contract' });
    }
  }
  // The client's signature: an owner, the exact text they saw (its SHA-256),
  // their typed name and a tick, with when and from where (hashed).
  function sign(req, id, input) {
    const v = versions().find((x) => x.id === id && x.employerId === req.employer.id && CLIENT_SEES.includes(x.status));
    if (!v) return { status: 404, errors: ['contract not found'] };
    if (!employerCan(req.member, 'contracts.sign')) return { status: 403, errors: ['only a company owner signs contracts'] };
    if (v.status !== 'sent') return v.status === 'signed' || v.status === 'active' ? { status: 200, version: v, existed: true } : { status: 409, errors: [`this version is ${LABEL[v.status].toLowerCase()}`] };
    const body = input && typeof input === 'object' ? input : {};
    const errors = [];
    const typed = String(body.typedName || '').trim().replace(/\s+/g, ' ');
    const designation = String(body.designation || '').trim().slice(0, 80);
    if (!(body.accept === true || body.accept === '1' || body.accept === 'on' || body.accept === 'true')) errors.push('tick that you have read the contract and agree to it for your company');
    if (typed.toLowerCase() !== String(req.employerUser.name).trim().replace(/\s+/g, ' ').toLowerCase()) errors.push(`type your name exactly as on your account (${req.employerUser.name})`);
    if (!designation) errors.push('give your designation');
    if (String(body.sha256 || '') !== v.sha256) errors.push('the contract changed since you opened it: reload it and read it again');
    if (errors.length) return { status: 400, errors };
    const signature = {
      userId: req.employerUser.id, name: req.employerUser.name, email: req.employerUser.email, typedName: typed, designation, at: iso(),
      ipHash: sha256(`${secret}|${req.ip}`).slice(0, 32), userAgent: String(req.get('User-Agent') || '').slice(0, 200), documentSha256: v.sha256, version: v.version,
    };
    const saved = update('contract-versions', id, (x) => { x.status = 'signed'; x.signature = signature; x.history.push({ at: signature.at, by: `${signature.name} (${req.employer.company})`, text: `Signed as ${designation}` }); });
    clientAudit(req, 'contract-signed', `${v.reference} v${v.version} (${v.sha256.slice(0, 12)})`);
    teamAudit(null, 'contract-signed', id, `${req.employer.company}: ${v.reference} v${v.version} signed by ${signature.name}`, v.employerId);
    refresh();
    const now = versions().find((x) => x.id === id);
    tellOwners(now, 'signed');
    return { status: 200, version: now };
  }
  function requestChanges(req, id, input) {
    const v = versions().find((x) => x.id === id && x.employerId === req.employer.id && CLIENT_SEES.includes(x.status));
    if (!v) return { status: 404, errors: ['contract not found'] };
    if (!employerCan(req.member, 'contracts.sign')) return { status: 403, errors: ['only a company owner answers contracts'] };
    if (v.status !== 'sent') return { status: 409, errors: [`this version is ${LABEL[v.status].toLowerCase()}`] };
    const comment = String((input && input.comment) || '').trim().slice(0, 2000);
    if (!comment) return { status: 400, errors: ['say what you would like changed'] };
    const saved = update('contract-versions', id, (x) => { x.status = 'terminated'; x.terminationReason = `Client asked for changes: ${comment}`; x.clientComment = comment; x.history.push({ at: iso(), by: `${req.employerUser.name} (${req.employer.company})`, text: `Asked for changes: ${comment}` }); });
    clientAudit(req, 'contract-changes-requested', `${v.reference} v${v.version}`);
    teamAudit(null, 'contract-changes-requested', id, `${req.employer.company}: ${comment}`, v.employerId);
    const c = clientById(v.employerId);
    const am = c && c.accountManagerId && team.byId(c.accountManagerId);
    if (am && am.email) mailer.notice({ name: am.name, email: am.email, kind: 'team' }, { subject: `${req.employer.company} asked for contract changes`, heading: 'A client asked for changes', intro: `${req.employerUser.name} asked for changes to ${v.reference} version ${v.version}: ${comment}`, rows: [], link: `${baseUrl}/admin/clients/${v.employerId}/contract-documents`, label: 'Open the contract' });
    return { status: 200, version: saved };
  }
  const clientVersionJson = (v) => ({
    id: v.id, reference: v.reference, version: v.version, title: v.title, status: v.status, statusLabel: LABEL[v.status], text: v.text, sha256: v.sha256, sentAt: v.sentAt || null,
    signature: v.signature ? { name: v.signature.name, designation: v.signature.designation, at: v.signature.at, documentSha256: v.signature.documentSha256 } : null,
    terminationReason: v.status === 'terminated' ? v.terminationReason || '' : '',
  });
  const teamVersionJson = (v) => ({ ...clientVersionJson(v), contractId: v.contractId, clientId: v.employerId, author: v.authorName, reviewer: v.reviewerName || null, signature: v.signature, history: v.history });
  const clientVersions = (employerId) => { refresh(); return versions().filter((v) => v.employerId === employerId && CLIENT_SEES.includes(v.status)).sort((a, b) => (b.sentAt || '').localeCompare(a.sentAt || '')); };

  // ---------- hiring requests (single or bulk) ----------
  function hiringRequest(req, input) {
    if (!employerCan(req.member, 'requirements.send')) return { status: 403, errors: ['your role in this company does not allow that'] };
    const body = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    if (!Array.isArray(body.lines)) {
      const r = agency.clientRequisition(req.employer, req.employerUser, body, true);
      return r.errors ? r : { status: 201, requests: [agency.clientReqView(r.requisition, req.member)] };
    }
    const extra = Object.keys(body).filter((k) => !['lines', 'note'].includes(k));
    if (extra.length) return { status: 400, errors: extra.map((k) => `${k} is not a field you can set`) };
    if (!body.lines.length || body.lines.length > MAX_BULK) return { status: 400, errors: [`a bulk order has 1 to ${MAX_BULK} lines`] };
    // All lines are checked before any is saved: an order goes in whole or not at all.
    const errors = [];
    body.lines.forEach((line, i) => {
      const unknown = line && typeof line === 'object' ? Object.keys(line).filter((k) => !agency.CLIENT_REQ_FIELDS.includes(k)) : [];
      const { errors: e } = parseRequisition(line, { strict: true, fields: agency.CLIENT_REQ_FIELDS });
      for (const x of [...unknown.map((k) => `${k} is not a field you can set`), ...e]) errors.push(`line ${i + 1}: ${x}`);
    });
    if (errors.length) return { status: 400, errors: [...new Set(errors)] };
    const orderNumber = `ORD-${String(new Set(agency.requisitions().map((r) => r.orderNumber).filter(Boolean)).size + 1).padStart(4, '0')}`;
    const made = body.lines.map((line) => agency.clientRequisition(req.employer, req.employerUser, line, true, { orderNumber, orderNote: String(body.note || '').slice(0, 500) }).requisition);
    clientAudit(req, 'bulk-order', `${orderNumber}: ${made.length} line(s), ${made.reduce((n, r) => n + r.openings, 0)} opening(s)`);
    return { status: 201, orderNumber, requests: made.map((r) => agency.clientReqView(r, req.member)) };
  }

  // ---------- interviews, reports, dashboard ----------
  function interviewsFor(req) {
    const jobs = new Map(getJobs().filter((j) => j.employerId === req.employer.id).map((j) => [j.id, j]));
    const out = [];
    for (const a of readSubmissions('applications')) {
      const job = jobs.get(a.jobId);
      const shared = a.shared && a.shared.employerId === req.employer.id;
      if (!(job && employerCan(req.member, 'applicants.view', job)) && !(shared && employerCan(req.member, 'shortlist.feedback'))) continue;
      for (const iv of a.interviews || []) out.push({ id: iv.id, applicationId: a.id, candidate: a.name, jobTitle: a.jobTitle, at: iv.at, duration: iv.duration, mode: iv.mode, status: iv.status, confirmation: iv.confirmation || null, feedback: (iv.feedback || []).length });
    }
    return out.sort((x, y) => String(y.at).localeCompare(String(x.at))).slice(0, 200);
  }
  function report(req) {
    const emp = req.employer;
    const reqs = agency.requisitions().filter((r) => r.employerId === emp.id).map((r) => agency.describeReq(r));
    const live = reqs.filter((r) => ['Requested', 'Open', 'On hold'].includes(r.status));
    const shortlist = clients.shortlistFor(emp);
    const decided = shortlist.filter((s) => s.feedback);
    const as = agency.assignments().filter((a) => a.employerId === emp.id);
    const since = new Date(Date.now() - 30 * DAY).toISOString().slice(0, 10);
    const ts = workforce ? workforce.timesheets().filter((t) => t.employerId === emp.id && t.status === 'Approved' && t.to >= since) : [];
    const fills = reqs.filter((r) => r.status === 'Filled' && r.closedAt).map((r) => Math.round((Date.parse(r.closedAt) - Date.parse(r.createdAt)) / DAY)).sort((a, b) => a - b);
    const out = {
      requisitions: { open: live.length, openingsLeft: live.reduce((n, r) => n + r.remaining, 0), awaitingReview: live.filter((r) => r.status === 'Requested').length, filled: reqs.filter((r) => r.status === 'Filled').length, medianDaysToFill: fills.length ? fills[Math.floor((fills.length - 1) / 2)] : null },
      shortlist: { shared: shortlist.length, answered: decided.length, interested: decided.filter((s) => s.feedback.decision === 'Interested').length, notAFit: decided.filter((s) => s.feedback.decision === 'Not a fit').length },
      interviews: { upcoming: interviewsFor(req).filter((iv) => iv.status === 'scheduled' && iv.at > iso()).length },
      workforce: { active: as.filter((a) => a.status === 'Active').length, scheduled: as.filter((a) => a.status === 'Scheduled').length, approvedHoursLast30Days: Number((ts.reduce((n, t) => n + t.totals.payableMinutes, 0) / 60).toFixed(2)) },
    };
    if (employerCan(req.member, 'billing.view')) {
      const inv = billing.forClient(emp).flatMap((p) => p.invoices);
      out.billing = { invoices: inv.length, invoicedPaise: Math.round(inv.reduce((n, i) => n + i.total * 100, 0)), outstandingPaise: Math.round(inv.reduce((n, i) => n + Math.max(0, i.balance) * 100, 0)), overdue: inv.filter((i) => i.overdue).length };
    }
    return out;
  }
  const teamJson = (req) => clients.team.membersOf(req.employer.id).map((m) => {
    const u = clients.team.userById(m.userId) || {};
    return { id: m.id, name: u.name, role: m.role, you: m.userId === req.employerUser.id, ...(employerCan(req.member, 'team.manage') ? { email: u.email } : {}) };
  });

  // ---------- client JSON API ----------
  const apiLimit = limit('client-api', 120, 60 * 1000);
  const signLimit = limit('client-sign', 10);
  const need = (action) => (req, res, next) => (employerCan(req.member, action) ? next() : clients.forbid(req, res));
  const out = (res, r, map = (x) => x) => (r.errors ? res.status(r.status).json({ ok: false, errors: r.errors }) : res.status(r.status).json({ ok: true, ...(r.existed ? { existed: true } : {}), ...map(r) }));
  app.get('/api/client/dashboard', requireEmployerApi, apiLimit, (req, res) => {
    if (req.member.role === 'supervisor') return res.json({ ok: true, company: req.employer.company, role: req.member.role, workforce: report(req).workforce });
    const v = employerCan(req.member, 'contracts.view') ? clientVersions(req.employer.id) : [];
    res.json({ ok: true, company: req.employer.company, role: req.member.role, verification: clients.verificationOf(req.employer), ...report(req), contractsToSign: v.filter((x) => x.status === 'sent').length });
  });
  app.get('/api/client/hiring-requests', requireEmployerApi, apiLimit, (req, res) => {
    res.json({ ok: true, requests: agency.requisitions().filter((r) => r.employerId === req.employer.id).map((r) => ({ ...agency.clientReqView(r, req.member), orderNumber: r.orderNumber || null })) });
  });
  app.get('/api/client/hiring-requests/:id', requireEmployerApi, apiLimit, (req, res) => {
    const r = agency.requisitions().find((x) => x.id === req.params.id && x.employerId === req.employer.id);
    if (!r) return res.status(404).json({ ok: false, errors: ['request not found'] });
    res.json({ ok: true, request: { ...agency.clientReqView(r, req.member), orderNumber: r.orderNumber || null, history: r.history.filter((h) => !/internal/i.test(h.text)).map((h) => ({ at: h.at, text: h.text })) } });
  });
  app.post('/api/client/hiring-requests', requireEmployerApi, limit('client-requests', 10), sameOrigin, (req, res) => out(res, hiringRequest(req, req.body)));
  app.get('/api/client/candidates', requireEmployerApi, need('shortlist.feedback'), apiLimit, (req, res) => res.json({ ok: true, candidates: clients.shortlistFor(req.employer) }));
  app.post('/api/client/candidates/:id/feedback', requireEmployerApi, need('shortlist.feedback'), limit('employer-feedback', 60), sameOrigin, (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const unknown = Object.keys(body).filter((k) => !['decision', 'reason'].includes(k));
    if (unknown.length) return res.status(400).json({ ok: false, errors: unknown.map((k) => `${k} is not a field you can set`) });
    out(res, clients.shortlistFeedback(req, req.params.id, body.decision, body.reason), (r) => ({ feedback: { decision: r.feedback.decision, reason: r.feedback.comment, at: r.feedback.at } }));
  });
  app.get('/api/client/interviews', requireEmployerApi, apiLimit, (req, res) => res.json({ ok: true, interviews: interviewsFor(req) }));
  app.get('/api/client/contracts', requireEmployerApi, need('contracts.view'), apiLimit, (req, res) => res.json({ ok: true, contracts: clientVersions(req.employer.id).map(clientVersionJson) }));
  app.get('/api/client/contracts/:id', requireEmployerApi, need('contracts.view'), apiLimit, (req, res) => {
    const v = clientVersions(req.employer.id).find((x) => x.id === req.params.id);
    if (!v) return res.status(404).json({ ok: false, errors: ['contract not found'] });
    res.json({ ok: true, contract: clientVersionJson(v) });
  });
  app.post('/api/client/contracts/:id/sign', requireEmployerApi, signLimit, sameOrigin, (req, res) => out(res, sign(req, req.params.id, req.body), (r) => ({ contract: clientVersionJson(r.version) })));
  app.post('/api/client/contracts/:id/request-changes', requireEmployerApi, signLimit, sameOrigin, (req, res) => out(res, requestChanges(req, req.params.id, req.body), (r) => ({ contract: clientVersionJson(r.version) })));
  app.get('/api/client/invoices', requireEmployerApi, need('billing.view'), apiLimit, (req, res) => res.json({ ok: true, placements: billing.forClient(req.employer) }));
  app.get('/api/client/reports', requireEmployerApi, need('reports.view'), apiLimit, (req, res) => res.json({ ok: true, report: report(req) }));
  app.get('/api/client/team', requireEmployerApi, apiLimit, (req, res) => res.json({ ok: true, team: teamJson(req) }));

  // ---------- client pages ----------
  const page = (req, res, view, locals, status = 200) => res.status(status).render(view, { page: 'employer', noindex: true, errors: [], msg: String(req.query.msg || ''), LABEL, ...locals });
  app.get('/employer/contracts', requireEmployer, need('contracts.view'), (req, res) => page(req, res, 'employer-contracts', { title: `${req.employer.company} · Contracts`, tab: 'contracts', rows: clientVersions(req.employer.id), v: null }));
  app.get('/employer/contracts/:id', requireEmployer, need('contracts.view'), (req, res, next) => {
    const v = clientVersions(req.employer.id).find((x) => x.id === req.params.id);
    if (!v) return next();
    page(req, res, 'employer-contracts', { title: `${v.reference} · Contract`, tab: 'contracts', rows: [], v, canSign: employerCan(req.member, 'contracts.sign') });
  });
  const back = (res, id, r, ok) => res.redirect(303, `/employer/contracts/${id}?msg=${encodeURIComponent(r.errors ? r.errors.join(' ') : ok)}`);
  app.post('/employer/contracts/:id/sign', requireEmployer, signLimit, sameOrigin, (req, res) => back(res, req.params.id, sign(req, req.params.id, req.body), 'Signed. A copy is on its way to your email.'));
  app.post('/employer/contracts/:id/request-changes', requireEmployer, signLimit, sameOrigin, (req, res) => back(res, req.params.id, requestChanges(req, req.params.id, req.body), 'Sent to your account manager. They will send a new version.'));
  app.get('/employer/invoices', requireEmployer, need('billing.view'), (req, res) => page(req, res, 'employer-invoices', { title: `${req.employer.company} · Invoices`, tab: 'invoices', placements: billing.forClient(req.employer) }));
  app.get('/employer/reports', requireEmployer, need('reports.view'), (req, res) => page(req, res, 'employer-reports', { title: `${req.employer.company} · Reports`, tab: 'reports', report: report(req), inr }));
  app.post('/employer/requisitions/bulk', requireEmployer, limit('client-requests', 10), sameOrigin, (req, res) => {
    // One line per row: "openings × role, location".
    const lines = String(req.body.lines || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
      const m = /^(\d{1,3})\s*[x×]\s*([^,]+?)(?:\s*,\s*(.+))?$/i.exec(l);
      return m ? { openings: m[1], title: m[2].trim(), location: (m[3] || '').trim(), kind: String(req.body.kind || 'Permanent') } : { title: l, openings: 'x' };
    });
    const r = hiringRequest(req, { lines, note: req.body.note || '' });
    res.redirect(303, `/employer/requisitions?msg=${encodeURIComponent(r.errors ? r.errors.join(' ') : `Order ${r.orderNumber} sent: ${r.requests.length} request(s). Hireriv reviews each one before it opens.`)}`);
  });

  // Short links from the planned client routes.
  app.get('/client/dashboard', (req, res) => res.redirect('/employer'));
  app.get('/client/company-profile', (req, res) => res.redirect('/employer/company'));
  app.get('/client/hiring-requests', (req, res) => res.redirect('/employer/requisitions'));
  app.get('/client/interviews', (req, res) => res.redirect('/employer/interviews'));
  app.get('/client/contracts', (req, res) => res.redirect('/employer/contracts'));
  app.get('/client/invoices', (req, res) => res.redirect('/employer/invoices'));
  app.get('/client/reports', (req, res) => res.redirect('/employer/reports'));
  app.get('/client/team', (req, res) => res.redirect('/employer/team'));

  // ---------- team side ----------
  const teamApi = (action) => (req, res, next) => {
    const user = team.currentUser(req);
    if (!user) return res.status(401).json({ ok: false, errors: ['sign in to the team admin first'] });
    if (team.requires2fa() && !team.has2fa(user.id)) return res.status(403).json({ ok: false, errors: ['your team requires two-step sign-in: set it up first'] });
    if (!roles.can(user, action)) return res.status(403).json({ ok: false, errors: ['your role does not allow that'] });
    req.admin = user;
    res.set('Cache-Control', 'no-store');
    next();
  };
  app.get('/api/contracts/:id/versions', teamApi('contracts.view'), apiLimit, (req, res) => {
    refresh();
    const c = contracts().find((x) => x.id === req.params.id);
    if (!c) return res.status(404).json({ ok: false, errors: ['contract not found'] });
    res.json({ ok: true, versions: versions().filter((v) => v.contractId === c.id).map(teamVersionJson) });
  });
  app.post('/api/contracts/:id/versions', teamApi('clients.manage'), apiLimit, sameOrigin, (req, res) => out(res, createVersion(req.admin, req.params.id, req.body), (r) => ({ version: teamVersionJson(r.version) })));
  app.patch('/api/contract-versions/:id', teamApi('clients.manage'), apiLimit, sameOrigin, (req, res) => out(res, changeVersion(req.admin, req.params.id, req.body), (r) => ({ version: teamVersionJson(r.version) })));
  app.post('/api/contract-versions/:id/:action', teamApi('clients.manage'), apiLimit, sameOrigin, (req, res) => out(res, moveVersion(req.admin, req.params.id, req.params.action, req.body), (r) => ({ version: teamVersionJson(r.version) })));
  app.get('/admin/clients/:id/contract-documents', adminAuth, (req, res, next) => {
    if (!roles.can(req.admin, 'contracts.view')) return res.status(403).render('thanks', { title: 'Not part of your role', page: '', ok: false, message: 'Your role does not include contracts.', noindex: true });
    const c = clientById(req.params.id);
    if (!c) return next();
    refresh();
    const cs = contracts().filter((k) => k.employerId === c.id);
    res.render('admin-contract-documents', {
      title: `${c.company} · Contract documents`, page: 'admin', noindex: true, errors: [], msg: String(req.query.msg || ''), c, cs, LABEL,
      versions: versions().filter((v) => v.employerId === c.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), canManage: canManageClient(req.admin, c.id), me: req.admin.id,
      can: (a) => roles.can(req.admin, a), tab: 'clients',
    });
  });
  const adminBack = (res, employerId, r, ok) => res.redirect(303, `/admin/clients/${employerId}/contract-documents?msg=${encodeURIComponent(r.errors ? r.errors.join(' ') : ok)}`);
  app.post('/admin/contracts/:id/versions', adminAuth, sameOrigin, (req, res) => {
    const c = contracts().find((x) => x.id === req.params.id);
    if (!c) return res.status(404).send('Not found');
    adminBack(res, c.employerId, createVersion(req.admin, c.id, { title: req.body.title, clauses: req.body.clauses }), 'Draft saved. Send it for review when ready.');
  });
  app.post('/admin/contract-versions/:id/:action', adminAuth, sameOrigin, (req, res) => {
    const v = versions().find((x) => x.id === req.params.id);
    if (!v) return res.status(404).send('Not found');
    const r = req.params.action === 'edit' ? changeVersion(req.admin, v.id, { title: req.body.title, clauses: req.body.clauses }) : moveVersion(req.admin, v.id, req.params.action, { reason: req.body.reason });
    adminBack(res, v.employerId, r, { edit: 'Draft saved.', submit: 'Sent for review.', send: 'Sent to the client for signature.', back: 'Sent back to the author.', terminate: 'Terminated.' }[req.params.action] || 'Saved.');
  });

  setInterval(() => { try { refresh(); } catch (e) { console.error('Contract check failed:', e.message); } }, 60 * 60 * 1000).unref();
  return { refresh, versions, STATUSES };
}

module.exports = { register, STATUSES, LABEL };
