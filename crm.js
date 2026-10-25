// Hireriv's own sales CRM: leads from website inquiries, employer sign-ups,
// the team and authorised imports; opportunities through the pipeline;
// calls, meetings and follow-ups; proposals with versions and the client's
// answer; and a controlled hand-over of a won client to recruitment
// operations. It sits beside the employer portal, the agency desk and
// billing and reuses them: a won client becomes (or is linked to) an employer
// account through employers.js, its accepted terms become a Draft contract
// through agency.js (active only once signed, client-portal.js), and revenue
// is read from payments recorded in billing (placements.js), never from CRM
// estimates. Nothing here issues invoices.
//
// Every page and API call checks the signed-in team member's role on the
// server (agency-roles.js crm.*). Representatives see the leads,
// opportunities and activities they own or created; Sales Managers and
// Admins see all of them.
const crypto = require('crypto');
const roles = require('./agency-roles');
const { parseContract, paiseFrom } = require('./agency');

const DAY = 86400000;
const iso = () => new Date().toISOString();
const todayIst = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const inr = (paise) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format((paise || 0) / 100);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^[+\d][\d\s-]{7,16}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s) => DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

const STAGES = ['New Lead', 'Contacted', 'Meeting', 'Proposal', 'Negotiation', 'Won', 'Lost'];
// Where an opportunity may go next. Won is final; a lost one is reopened by a manager.
const MOVES = {
  'New Lead': ['Contacted', 'Lost'],
  Contacted: ['Meeting', 'New Lead', 'Lost'],
  Meeting: ['Proposal', 'Contacted', 'Lost'],
  Proposal: ['Negotiation', 'Meeting', 'Won', 'Lost'],
  Negotiation: ['Won', 'Proposal', 'Lost'],
  Won: [],
  Lost: ['New Lead'],
};
const OPEN_STAGES = ['New Lead', 'Contacted', 'Meeting', 'Proposal', 'Negotiation'];
const LOST_REASONS = ['Price', 'Chose another agency', 'Hiring paused', 'No response', 'Not a fit for our services', 'Hiring in-house', 'Other'];
const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'unqualified', 'converted', 'lost'];
const LEAD_LABEL = { new: 'New', contacted: 'Contacted', qualified: 'Qualified', unqualified: 'Unqualified', converted: 'Converted', lost: 'Lost' };
const SOURCES = ['Website inquiry', 'Employer registration', 'Referral', 'Manual', 'Import', 'Event'];
// Why we may hold a business contact's details (required for anything not
// sent to us by the contact themselves).
const BASES = ['Asked us to contact them', 'Existing business relationship', 'Referral with permission', 'Met at an event', 'Published business contact'];
const ACTIVITY_KINDS = ['call', 'meeting', 'email', 'note', 'task'];
const ACTIVITY_LABEL = { call: 'Call', meeting: 'Meeting', email: 'Email', note: 'Note', task: 'Follow-up' };
const SERVICES = ['Permanent recruitment', 'Temporary & contract staffing', 'Bulk hiring', 'Executive search', 'Payroll & compliance'];
const PROPOSAL_STATUSES = ['draft', 'approved', 'sent', 'accepted', 'rejected', 'expired', 'withdrawn'];
const PROPOSAL_LABEL = { draft: 'Draft', approved: 'Approved', sent: 'Sent', accepted: 'Accepted', rejected: 'Rejected', expired: 'Expired', withdrawn: 'Withdrawn' };
const PROPOSAL_FINAL = ['accepted', 'rejected', 'expired', 'withdrawn'];
const MAX_IMPORT = 500;
const RETENTION_MONTHS = 24;

// Business email domains say which company a contact works for; free mail doesn't.
const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.in', 'yahoo.in', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'rediffmail.com', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'zoho.com', 'zohomail.in', 'ymail.com', 'gmx.com', 'mail.com']);
const emailKey = (e) => String(e || '').trim().toLowerCase();
const phoneKey = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : ''; };
const domainOf = (e) => { const d = emailKey(e).split('@')[1] || ''; return d && !FREE_MAIL.has(d) ? d : ''; };
const companyKey = (s) => String(s || '').toLowerCase().replace(/&/g, ' and ')
  .replace(/\b(private|pvt|limited|ltd|llp|inc|incorporated|co|company|corp|corporation|the|india|opc|services|solutions)\b\.?/g, ' ')
  .replace(/[^a-z0-9]+/g, '');
const urlCount = (s) => (String(s || '').match(/https?:\/\/|www\./gi) || []).length;

// A date-time from a form (taken as India time when it has no zone) or ISO.
function parseDue(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  if (DATE_RE.test(s)) return validDate(s) ? new Date(`${s}T18:00:00+05:30`).toISOString() : NaN;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s)) { const t = Date.parse(`${s}+05:30`); return Number.isNaN(t) ? NaN : new Date(t).toISOString(); }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(s)) { const t = Date.parse(s); return Number.isNaN(t) ? NaN : new Date(t).toISOString(); }
  return NaN;
}
const istText = (isoString) => (isoString ? new Date(isoString).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) : '');

// Reads a body: only the listed fields (strict), trimmed strings.
function reader(input, allowed, strict) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { errors: ['send the details as an object'], has: () => false, str: () => '' };
  if (strict) for (const k of Object.keys(input)) if (!allowed.includes(k)) errors.push(`${k} is not a field you can set`);
  const has = (k) => Object.prototype.hasOwnProperty.call(input, k) && input[k] !== undefined;
  const str = (k, max) => (input[k] === null || input[k] === undefined ? '' : String(input[k]).trim().slice(0, max + 1));
  return { errors, has, str };
}
const truthy = (v) => v === true || v === 'true' || v === '1' || v === 'on' || v === 'yes';

const LEAD_FIELDS = ['companyName', 'contactName', 'designation', 'email', 'phone', 'industry', 'location', 'hiringNeeds', 'headcount', 'source', 'sourceDetail', 'lawfulBasis', 'marketingConsent', 'notes', 'ownerId', 'confirmDuplicate'];
const LEAD_EDITABLE = ['companyName', 'contactName', 'designation', 'email', 'phone', 'industry', 'location', 'hiringNeeds', 'headcount', 'notes', 'status', 'reason', 'marketingConsent'];
// A lead's details. With `existing`, only the fields sent change.
function parseLead(input, { strict = true, existing = null, fields = LEAD_FIELDS } = {}) {
  const r = reader(input, fields, strict);
  const { errors } = r;
  const out = {};
  const want = (k) => fields.includes(k) && (r.has(k) || !existing);
  const text = (k, label, max, required) => {
    if (!want(k)) return;
    const v = r.str(k, max).replace(/[ \t]+/g, ' ');
    if (v.length > max) errors.push(`${label} must be ${max} characters or fewer`);
    if (required && !v) errors.push(`${label} is required`);
    out[k] = v.slice(0, max);
  };
  text('companyName', 'company', 120, true);
  text('contactName', 'contact name', 120, true);
  text('designation', 'designation', 80);
  text('industry', 'industry', 80);
  text('location', 'location', 120);
  text('hiringNeeds', 'hiring needs', 1000);
  text('notes', 'notes', 2000);
  text('sourceDetail', 'source detail', 120);
  if (want('email')) { const e = emailKey(r.str('email', 160)); if (e && !EMAIL_RE.test(e)) errors.push('email is invalid'); out.email = e.slice(0, 160); }
  if (want('phone')) { const p = r.str('phone', 20); if (p && !PHONE_RE.test(p)) errors.push('phone is invalid'); out.phone = p.slice(0, 20); }
  if (want('headcount')) {
    const h = r.str('headcount', 6);
    if (h && (!/^\d{1,6}$/.test(h) || Number(h) < 1)) errors.push('headcount must be a whole number');
    out.headcount = h ? Number(h) : null;
  }
  if (want('source')) { const s = r.str('source', 40) || 'Manual'; if (!SOURCES.includes(s)) errors.push(`source must be one of: ${SOURCES.join(', ')}`); out.source = s; }
  if (want('lawfulBasis')) { const b = r.str('lawfulBasis', 60); if (b && !BASES.includes(b)) errors.push(`lawfulBasis must be one of: ${BASES.join(', ')}`); out.lawfulBasis = b; }
  if (r.has('marketingConsent') && fields.includes('marketingConsent')) out.marketingConsent = truthy(input.marketingConsent);
  if (r.has('ownerId') && fields.includes('ownerId')) out.ownerId = r.str('ownerId', 60);
  if (r.has('confirmDuplicate') && fields.includes('confirmDuplicate')) out.confirmDuplicate = truthy(input.confirmDuplicate);
  if (r.has('status') && fields.includes('status')) out.status = r.str('status', 20);
  if (r.has('reason') && fields.includes('reason')) out.reason = r.str('reason', 300).slice(0, 300);
  const email = out.email !== undefined ? out.email : existing && existing.email;
  const phone = out.phone !== undefined ? out.phone : existing && existing.phone;
  if (!email && !phone) errors.push('an email or a phone number is required');
  return { errors: [...new Set(errors)], values: out };
}
const keysOf = (l) => ({ emailKey: emailKey(l.email), phoneKey: phoneKey(l.phone), domain: domainOf(l.email), companyKey: companyKey(l.companyName) });

// Proposal terms are a contract's terms (agency.js parseContract) plus the
// services, scope, validity and an estimated value.
const PROPOSAL_FIELDS = ['opportunityId', 'title', 'kind', 'services', 'scope', 'feeMode', 'feePercent', 'flatFee', 'guaranteeDays', 'paymentDays', 'markupPercent', 'validUntil', 'estimatedValue', 'internalNotes'];
function parseProposal(input, { strict = true, fields = PROPOSAL_FIELDS } = {}) {
  const r = reader(input, fields, strict);
  const errors = [...r.errors];
  const title = r.str('title', 120);
  if (!title) errors.push('title is required');
  if (title.length > 120) errors.push('title must be 120 characters or fewer');
  let services = input && input.services;
  if (typeof services === 'string') services = services.split(/[,\n]/);
  services = [...new Set((Array.isArray(services) ? services : []).map((s) => String(s).trim()).filter(Boolean))];
  if (!services.length) errors.push('choose at least one service');
  const bad = services.filter((s) => !SERVICES.includes(s));
  if (bad.length) errors.push(`services must be from: ${SERVICES.join(', ')}`);
  const scope = r.str('scope', 5000);
  if (scope.length > 5000) errors.push('scope must be 5,000 characters or fewer');
  const internalNotes = r.str('internalNotes', 2000);
  if (internalNotes.length > 2000) errors.push('internal notes must be 2,000 characters or fewer');
  const validUntil = r.str('validUntil', 10);
  if (!validDate(validUntil)) errors.push('validUntil must be a date like 2026-12-31');
  else if (validUntil < todayIst()) errors.push('validUntil is in the past');
  const value = paiseFrom(r.str('estimatedValue', 20));
  if (Number.isNaN(value)) errors.push('estimated value must be an amount in rupees with up to 2 decimals');
  const c = parseContract({
    reference: 'proposal', status: 'Draft', startsOn: todayIst(), kind: r.str('kind', 40),
    feeMode: r.str('feeMode', 10), feePercent: r.str('feePercent', 10), flatFee: r.str('flatFee', 20),
    guaranteeDays: r.str('guaranteeDays', 4), paymentDays: r.str('paymentDays', 4), markupPercent: r.str('markupPercent', 10),
  });
  errors.push(...c.errors);
  const t = c.values;
  const terms = { kind: t.kind, feeMode: t.feeMode, feeBp: t.feeBp, flatFeePaise: t.flatFeePaise, guaranteeDays: t.guaranteeDays, paymentDays: t.paymentDays, markupBp: t.markupBp };
  return { errors: [...new Set(errors)], values: { title: title.slice(0, 120), services, scope, internalNotes, validUntil, valuePaise: Number.isNaN(value) ? null : value, terms } };
}
// The text a client reads and accepts; its SHA-256 is the evidence.
function proposalText(site, p, v, lead) {
  const t = v.terms;
  const pct = (bp) => `${bp / 100}%`;
  const lines = [
    `${site.name} proposal ${p.number}, version ${v.version}: ${v.title}`,
    `For ${lead.companyName}${lead.contactName ? `, attention ${lead.contactName}` : ''}.`,
    `Services: ${v.services.join(', ')}.`,
    `Engagement: ${t.kind}.`,
  ];
  if (t.kind !== 'Temporary & contract staffing') {
    lines.push(t.feeMode === 'flat' ? `Permanent recruitment fee: ${inr(t.flatFeePaise)} per hire, plus GST.` : `Permanent recruitment fee: ${pct(t.feeBp)} of the hire's annual CTC, plus GST.`);
    if (t.guaranteeDays !== null && t.guaranteeDays !== undefined) lines.push(`Replacement guarantee: ${t.guaranteeDays} days from joining.`);
  }
  if (t.markupBp !== null && t.markupBp !== undefined) lines.push(`Temporary and contract staffing: markup of ${pct(t.markupBp)} on pay, billed per assignment.`);
  lines.push(`Payment: within ${t.paymentDays} days of each invoice.`);
  lines.push(`This quotation is valid until ${v.validUntil}. Accepting it records your agreement to these commercial terms; the services start under a client agreement signed in the ${site.name} client portal.`);
  if (v.scope) lines.push('', v.scope);
  return lines.join('\n');
}

function register(app, deps) {
  const {
    team, clients, billing, agency, notify, mailer, site, limit, sameOrigin, adminAuth, readSubmissions, writeSubmissions, saveSubmission, baseUrl, secret,
  } = deps;
  const leads = () => readSubmissions('crm-leads');
  const opps = () => readSubmissions('crm-opportunities');
  const activities = () => readSubmissions('crm-activities');
  const proposals = () => readSubmissions('crm-proposals');
  const update = (collection, id, fn) => {
    const list = readSubmissions(collection);
    const rec = list.find((x) => x.id === id);
    if (!rec) return null;
    fn(rec);
    rec.updatedAt = iso();
    writeSubmissions(collection, list);
    return rec;
  };
  const hmac = (s) => crypto.createHmac('sha256', secret || 'crm').update(String(s)).digest('hex');
  const ipHash = (ip) => hmac(`ip:${ip || ''}`).slice(0, 32);
  const nameOf = (id) => { const u = id && team.byId(id); return u ? u.name : ''; };
  const salesPeople = () => team.members().filter((u) => roles.can(u, 'crm.view'));
  const managers = () => team.members().filter((u) => roles.can(u, 'crm.manage') && u.email);

  // ---------- who sees what ----------
  const isManager = (u) => roles.can(u, 'crm.manage');
  const seesLead = (u, l) => Boolean(l) && (isManager(u) || l.ownerId === u.id || l.createdBy === u.id);
  const leadById = (id) => leads().find((l) => l.id === id) || null;
  const seesOpp = (u, o) => Boolean(o) && (isManager(u) || o.ownerId === u.id || o.createdBy === u.id || seesLead(u, leadById(o.leadId)));
  const seesActivity = (u, a) => Boolean(a) && (isManager(u) || a.ownerId === u.id || a.createdBy === u.id || seesLead(u, leadById(a.leadId)));
  const oppById = (id) => opps().find((o) => o.id === id) || null;
  const seesProposal = (u, p) => Boolean(p) && seesOpp(u, oppById(p.opportunityId));

  function audit(user, action, entity, entityId, detail) {
    saveSubmission('crm-audit', { actorId: user ? user.id : '', actorName: user ? user.name : 'System', role: user ? user.role : '', action, entity, entityId, detail: String(detail).slice(0, 300) });
    if (user) team.log(user, `${action}: ${detail}`.slice(0, 300), 'crm');
  }
  const history = (rec, by, text) => { rec.history = [...(rec.history || []), { at: iso(), by: by ? by.name : 'System', text: String(text).slice(0, 300) }]; };

  // ---------- notifications ----------
  const LINK = '/admin/crm';
  if (notify) notify.template('crm', {
    version: 1,
    resolve: (refs, to) => {
      const u = to.kind === 'team' && team.byId(to.userId);
      if (!u || u.active === false || !u.email || !roles.can(u, 'crm.view')) return null;
      if (refs.activityId) {
        const a = activities().find((x) => x.id === refs.activityId);
        // Stale reminders aren't sent: done, cancelled, moved or handed over.
        if (!a || a.status !== 'open' || a.dueAt !== refs.dueAt || a.ownerId !== u.id) return null;
        const l = leadById(a.leadId);
        return { to: u.email, send: () => mailer.notice({ name: u.name, email: u.email, kind: 'team' }, { subject: `${refs.overdue ? 'Overdue' : 'Due soon'}: ${a.subject}`, heading: refs.overdue ? 'A follow-up is overdue' : 'A follow-up is due soon', intro: refs.overdue ? 'this follow-up is past its due time.' : 'this follow-up is due within a day.', rows: [['Follow-up', a.subject], ['Company', l ? l.companyName : ''], ['Due', istText(a.dueAt)]], link: `${baseUrl}${LINK}/leads/${a.leadId}`, label: 'Open the lead' }) };
      }
      const l = refs.leadId && leadById(refs.leadId);
      if (!l || !seesLead(u, l)) return null;
      return { to: u.email, send: () => mailer.notice({ name: u.name, email: u.email, kind: 'team' }, { subject: refs.subject, heading: refs.subject, intro: refs.intro, rows: [['Company', l.companyName], ['Source', l.source]], link: `${baseUrl}${LINK}/leads/${l.id}`, label: 'Open the lead' }) };
    },
  });
  function tell(users, key, type, refs, title, body) {
    if (!notify) return;
    try {
      const to = users.filter(Boolean).map((u) => ({ kind: 'team', userId: u.id }));
      if (to.length) notify.emit({ key, type, to, inApp: { title, body, link: refs.activityId || refs.leadId ? `${LINK}/leads/${refs.leadId}` : LINK }, email: { template: 'crm', refs } });
    } catch (e) { console.error('CRM notification failed:', e.message); }
  }

  // ---------- duplicates ----------
  // Leads and clients that look like the same company or contact.
  function duplicatesOf(v, exceptId = '', user = null) {
    const k = keysOf(v);
    const why = (x) => [
      k.emailKey && x.emailKey === k.emailKey && 'same email',
      k.phoneKey && x.phoneKey === k.phoneKey && 'same phone',
      k.domain && x.domain === k.domain && 'same company email domain',
      k.companyKey && x.companyKey === k.companyKey && 'same company name',
    ].filter(Boolean);
    const leadHits = leads().filter((l) => l.id !== exceptId && !l.anonymizedAt).map((l) => ({ l, why: why(l) })).filter((x) => x.why.length)
      // Someone else's lead shows only that it exists and who has it.
      .map(({ l, why: w }) => ({ id: l.id, companyName: l.companyName, ...(!user || seesLead(user, l) ? { contactName: l.contactName } : {}), status: l.status, ownerName: nameOf(l.ownerId) || null, why: w }));
    const clientHits = clients.read().map((c) => ({ c, why: why({ emailKey: emailKey(c.email), phoneKey: phoneKey(c.phone), domain: domainOf(c.email), companyKey: companyKey(c.company) }) }))
      .filter((x) => x.why.length).map(({ c, why: w }) => ({ id: c.id, company: c.company, why: w }));
    return { leads: leadHits, clients: clientHits };
  }

  // ---------- leads ----------
  const leadJson = (l) => {
    const { emailKey: a, phoneKey: b, domain: c, companyKey: d, ...rest } = l;
    return { ...rest, ownerName: nameOf(l.ownerId) };
  };
  function newLead(values, by, extra = {}) {
    const l = saveSubmission('crm-leads', {
      companyName: values.companyName, contactName: values.contactName, designation: values.designation || '', email: values.email || '', phone: values.phone || '',
      industry: values.industry || '', location: values.location || '', hiringNeeds: values.hiringNeeds || '', headcount: values.headcount ?? null,
      source: values.source || 'Manual', sourceDetail: values.sourceDetail || '', lawfulBasis: values.lawfulBasis || '', notes: values.notes || '',
      consent: { marketing: Boolean(values.marketingConsent), at: values.marketingConsent ? iso() : null, how: values.marketingConsent ? (by ? `recorded by ${by.name}` : values.source) : null },
      unsubscribedAt: null, status: 'new', ownerId: values.ownerId || null, createdBy: by ? by.id : null, employerId: null,
      lastActivityAt: iso(), updatedAt: iso(), ...keysOf(values), history: [{ at: iso(), by: by ? by.name : 'System', text: `Lead created (${values.source || 'Manual'})` }], ...extra,
    });
    return l;
  }
  function assignable(ownerId) {
    const u = ownerId && team.byId(ownerId);
    return u && u.active !== false && roles.can(u, 'crm.view') ? u : null;
  }
  function createLead(user, input) {
    if (!roles.can(user, 'crm.view')) return { status: 403, errors: ['your role does not include the sales CRM'] };
    const { errors, values } = parseLead(input);
    if (['Website inquiry', 'Employer registration'].includes(values.source)) errors.push('website inquiries and sign-ups are captured automatically; choose another source');
    if (!values.lawfulBasis) errors.push('say why we may hold this contact (lawfulBasis)');
    if (values.ownerId && !isManager(user) && values.ownerId !== user.id) errors.push('only a Sales Manager assigns leads to someone else');
    if (values.ownerId && !assignable(values.ownerId)) errors.push('the owner must be an active member of the sales team');
    if (errors.length) return { status: 400, errors };
    const dup = duplicatesOf(values, '', user);
    if ((dup.leads.length || dup.clients.length) && !values.confirmDuplicate) {
      return { status: 409, errors: ['this looks like a lead or client we already have; check them, then confirm to add it anyway'], duplicates: dup };
    }
    const l = newLead({ ...values, ownerId: values.ownerId || (isManager(user) ? null : user.id) }, user, dup.leads.length || dup.clients.length ? { possibleDuplicates: dup.leads.map((x) => x.id), matchingClients: dup.clients.map((x) => x.id) } : {});
    audit(user, 'lead-created', 'lead', l.id, `${l.companyName} (${l.source})${values.confirmDuplicate && (dup.leads.length || dup.clients.length) ? ', added despite a possible duplicate' : ''}`);
    if (l.ownerId && l.ownerId !== user.id) tell([team.byId(l.ownerId)], `crm-assigned:${l.id}:${l.ownerId}`, 'crm-lead', { leadId: l.id, subject: 'A lead was assigned to you', intro: `${user.name} assigned you a lead.` }, 'A lead was assigned to you', l.companyName);
    return { status: 201, lead: l };
  }

  // Captured from the website (POST /api/hire) and employer sign-ups. The
  // public reply never changes; an inquiry from someone we already have is
  // added to that lead as an activity instead of a new lead.
  function capture(source, input, extra = {}) {
    try {
      const values = {
        companyName: String(input.company || '').trim().slice(0, 120), contactName: String(input.name || '').trim().slice(0, 120),
        email: emailKey(input.email).slice(0, 160), phone: String(input.phone || '').trim().slice(0, 20), industry: String(input.industry || '').trim().slice(0, 80),
        location: String(input.location || input.city || '').trim().slice(0, 120), designation: '',
        hiringNeeds: [input.roles && `Roles: ${input.roles}`, input.headcount && `Headcount: ${input.headcount}`, input.hiringType && `Type: ${input.hiringType}`, input.timeline && `Timeline: ${input.timeline}`, input.message].filter(Boolean).join('\n').slice(0, 1000),
        source, sourceDetail: extra.sourceDetail || '', lawfulBasis: 'Asked us to contact them', marketingConsent: false,
      };
      if (!values.companyName || !values.contactName || (!EMAIL_RE.test(values.email) && !PHONE_RE.test(values.phone))) return null;
      // Link-stuffed messages are spam, not leads.
      if (urlCount(input.message) + urlCount(input.roles) > 3) return null;
      const k = keysOf(values);
      const existing = leads().find((l) => !l.anonymizedAt && !['converted'].includes(l.status) && ((k.emailKey && l.emailKey === k.emailKey) || (k.phoneKey && l.phoneKey === k.phoneKey)));
      if (existing) {
        saveSubmission('crm-activities', { leadId: existing.id, opportunityId: null, kind: 'note', subject: `${source} again`, notes: values.hiringNeeds, status: 'done', dueAt: null, completedAt: iso(), ownerId: existing.ownerId, createdBy: null, outcome: '', updatedAt: iso() });
        update('crm-leads', existing.id, (l) => {
          l.lastActivityAt = iso();
          if (l.unsubscribedAt && source === 'Website inquiry') history(l, null, 'Contacted us again (still unsubscribed from emails)');
          if (extra.employerId && !l.employerId) l.employerId = extra.employerId;
          if (['lost', 'unqualified'].includes(l.status)) { l.status = 'new'; history(l, null, `Reopened: ${source.toLowerCase()} received`); }
        });
        tell(existing.ownerId ? [team.byId(existing.ownerId)] : managers(), `crm-again:${existing.id}:${Date.now()}`, 'crm-lead', { leadId: existing.id, subject: `${source}: ${existing.companyName} again`, intro: 'a lead you have contacted us again.' }, `${source}: ${existing.companyName} again`, values.hiringNeeds.slice(0, 200));
        return existing;
      }
      const dup = duplicatesOf(values);
      const l = newLead(values, null, { sourceRef: extra.sourceRef || null, employerId: extra.employerId || null, ...(dup.leads.length || dup.clients.length ? { possibleDuplicates: dup.leads.map((x) => x.id), matchingClients: dup.clients.map((x) => x.id) } : {}) });
      audit(null, 'lead-captured', 'lead', l.id, `${l.companyName} (${source})`);
      tell(managers(), `crm-new:${l.id}`, 'crm-lead', { leadId: l.id, subject: `New lead: ${l.companyName}`, intro: `a new lead came in (${source.toLowerCase()}). Assign it to a representative.` }, `New lead: ${l.companyName}`, source);
      return l;
    } catch (e) {
      console.error('Lead capture failed:', e.message);
      return null;
    }
  }

  // Status moves a person makes; converted comes only from a conversion and
  // the pipeline keeps the rest in step.
  const MANUAL_STATUS = ['new', 'contacted', 'qualified', 'unqualified', 'lost'];
  function changeLead(user, id, input) {
    const l = leadById(id);
    if (!l || !seesLead(user, l)) return { status: 404, errors: ['lead not found'] };
    if (l.anonymizedAt) return { status: 409, errors: ['this lead was anonymised under the retention rules'] };
    const { errors, values } = parseLead(input, { existing: l, fields: LEAD_EDITABLE });
    if (values.status !== undefined) {
      if (!MANUAL_STATUS.includes(values.status)) errors.push(`status must be one of: ${MANUAL_STATUS.join(', ')} (converted comes from converting a won opportunity)`);
      else if (l.status === 'converted') errors.push('a converted lead stays converted');
      else if (['unqualified', 'lost'].includes(values.status) && values.status !== l.status && !values.reason) errors.push(`say why the lead is ${values.status}`);
    }
    if (errors.length) return { status: 400, errors };
    const changed = Object.keys(values).filter((k) => k !== 'reason' && k !== 'marketingConsent' && values[k] !== l[k]);
    if (values.email !== undefined || values.phone !== undefined || values.companyName !== undefined) {
      const dup = duplicatesOf({ ...l, ...values }, l.id);
      if (dup.leads.length) l.possibleDuplicates = dup.leads.map((x) => x.id);
    }
    const saved = update('crm-leads', id, (x) => {
      for (const k of changed) x[k] = values[k];
      if (values.marketingConsent !== undefined && values.marketingConsent !== Boolean(x.consent && x.consent.marketing)) {
        x.consent = values.marketingConsent ? { marketing: true, at: iso(), how: `recorded by ${user.name}` } : { marketing: false, at: iso(), how: `withdrawn, recorded by ${user.name}` };
        history(x, user, values.marketingConsent ? 'Agreed to sales emails' : 'Withdrew agreement to sales emails');
      }
      Object.assign(x, keysOf(x));
      if (l.possibleDuplicates) x.possibleDuplicates = l.possibleDuplicates;
      if (values.status !== undefined && values.status !== l.status) history(x, user, `Status ${LEAD_LABEL[l.status]} → ${LEAD_LABEL[values.status]}${values.reason ? `: ${values.reason}` : ''}`);
      else if (changed.length) history(x, user, `Changed ${changed.join(', ')}`);
    });
    if (values.status !== undefined && values.status !== l.status) audit(user, 'lead-status', 'lead', id, `${l.companyName}: ${l.status} → ${values.status}${values.reason ? ` (${values.reason})` : ''}`);
    return { status: 200, lead: saved };
  }
  function assignLead(user, id, input) {
    if (!roles.can(user, 'crm.manage')) return { status: 403, errors: ['only a Sales Manager or an Admin assigns leads'] };
    const l = leadById(id);
    if (!l) return { status: 404, errors: ['lead not found'] };
    const ownerId = String((input && input.ownerId) || '').trim();
    const owner = assignable(ownerId);
    if (!owner) return { status: 400, errors: ['choose an active member of the sales team'] };
    if (l.ownerId === owner.id) return { status: 200, lead: l };
    const before = l.ownerId;
    const saved = update('crm-leads', id, (x) => { x.ownerId = owner.id; history(x, user, `Assigned to ${owner.name}${before ? ` (was ${nameOf(before) || 'someone else'})` : ''}`); });
    // Open opportunities and follow-ups move with the lead.
    const os = opps();
    let moved = 0;
    for (const o of os) if (o.leadId === id && OPEN_STAGES.includes(o.stage) && o.ownerId === before) { o.ownerId = owner.id; o.updatedAt = iso(); moved++; }
    if (moved) writeSubmissions('crm-opportunities', os);
    const as = activities();
    let movedA = 0;
    for (const a of as) if (a.leadId === id && a.status === 'open' && a.ownerId === before) { a.ownerId = owner.id; a.updatedAt = iso(); movedA++; }
    if (movedA) writeSubmissions('crm-activities', as);
    audit(user, 'lead-assigned', 'lead', id, `${l.companyName}: ${nameOf(before) || 'unassigned'} → ${owner.name}`);
    if (owner.id !== user.id) tell([owner], `crm-assigned:${id}:${owner.id}:${Date.now()}`, 'crm-lead', { leadId: id, subject: 'A lead was assigned to you', intro: `${user.name} assigned you a lead.` }, 'A lead was assigned to you', l.companyName);
    return { status: 200, lead: saved };
  }
  function searchLeads(user, q = {}) {
    const text = String(q.q || '').trim().toLowerCase().slice(0, 80);
    const status = LEAD_STATUSES.includes(q.status) ? q.status : '';
    const source = SOURCES.includes(q.source) ? q.source : '';
    const owner = String(q.owner || '');
    return leads().filter((l) => seesLead(user, l)
      && (!status || l.status === status) && (!source || l.source === source)
      && (!owner || (owner === 'none' ? !l.ownerId : l.ownerId === owner))
      && (!text || [l.companyName, l.contactName, l.email, l.phone, l.industry, l.location].some((v) => String(v || '').toLowerCase().includes(text))))
      .sort((a, b) => String(b.lastActivityAt || b.createdAt).localeCompare(String(a.lastActivityAt || a.createdAt)));
  }

  // ---------- import ----------
  // CSV with a header row; columns named like the lead fields.
  function parseCsv(text) {
    const rows = [];
    let row = [], cell = '', quoted = false;
    const s = String(text || '').replace(/^﻿/, '');
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (quoted) {
        if (ch === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && s[i + 1] === '\n') i++;
        row.push(cell); cell = '';
        if (row.some((c) => c.trim())) rows.push(row);
        row = [];
      } else cell += ch;
    }
    row.push(cell);
    if (row.some((c) => c.trim())) rows.push(row);
    return rows;
  }
  const IMPORT_COLUMNS = ['companyName', 'contactName', 'designation', 'email', 'phone', 'industry', 'location', 'hiringNeeds', 'headcount'];
  const HEADER_ALIASES = { company: 'companyName', 'company name': 'companyName', contact: 'contactName', name: 'contactName', 'contact name': 'contactName', mobile: 'phone', 'hiring needs': 'hiringNeeds', needs: 'hiringNeeds', city: 'location', title: 'designation' };
  function importLeads(user, input) {
    if (!roles.can(user, 'crm.import')) return { status: 403, errors: ['only a Sales Manager or an Admin imports leads'] };
    const body = input || {};
    const errors = [];
    const lawfulBasis = String(body.lawfulBasis || '').trim();
    if (!BASES.includes(lawfulBasis)) errors.push(`say why we may hold these contacts: one of ${BASES.join(', ')}`);
    const sourceDetail = String(body.sourceDetail || '').trim().slice(0, 120);
    const ownerId = String(body.ownerId || '').trim();
    if (ownerId && !assignable(ownerId)) errors.push('the owner must be an active member of the sales team');
    let rows = body.rows;
    if (!Array.isArray(rows) && typeof body.csv === 'string') {
      const table = parseCsv(body.csv);
      const head = (table.shift() || []).map((h) => { const k = h.trim().toLowerCase(); return HEADER_ALIASES[k] || IMPORT_COLUMNS.find((c) => c.toLowerCase() === k.replace(/\s+/g, '')) || null; });
      if (!head.includes('companyName') || !head.includes('contactName')) errors.push('the first line must name the columns, including company and contact name');
      rows = table.map((cells) => Object.fromEntries(head.map((h, i) => [h, cells[i]]).filter(([h]) => h)));
    }
    if (!Array.isArray(rows) || !rows.length) errors.push('send rows (or csv) with at least one lead');
    else if (rows.length > MAX_IMPORT) errors.push(`import at most ${MAX_IMPORT} rows at a time`);
    if (errors.length) return { status: 400, errors };
    const created = [], skipped = [], failed = [];
    const seen = { e: new Set(), p: new Set() };
    rows.forEach((raw, i) => {
      const n = i + 1;
      const picked = raw && typeof raw === 'object' ? Object.fromEntries(Object.entries(raw).filter(([k]) => IMPORT_COLUMNS.includes(k))) : raw;
      const { errors: e, values } = parseLead({ ...picked }, { fields: IMPORT_COLUMNS });
      if (raw && typeof raw === 'object') { const extra = Object.keys(raw).filter((k) => !IMPORT_COLUMNS.includes(k)); if (extra.length) e.push(`${extra.join(', ')} ${extra.length === 1 ? 'is not a column' : 'are not columns'} you can import`); }
      if (e.length) return failed.push({ row: n, errors: e });
      const k = keysOf(values);
      if ((k.emailKey && seen.e.has(k.emailKey)) || (k.phoneKey && seen.p.has(k.phoneKey))) return skipped.push({ row: n, reason: 'repeated in this file' });
      const dup = duplicatesOf(values);
      if (dup.leads.length || dup.clients.length) return skipped.push({ row: n, reason: `already have ${dup.leads.length ? `lead ${dup.leads[0].companyName}` : `client ${dup.clients[0].company}`} (${(dup.leads[0] || dup.clients[0]).why.join(', ')})` });
      if (k.emailKey) seen.e.add(k.emailKey);
      if (k.phoneKey) seen.p.add(k.phoneKey);
      const l = newLead({ ...values, source: 'Import', sourceDetail, lawfulBasis, ownerId: ownerId || null }, user);
      created.push({ row: n, id: l.id, companyName: l.companyName });
    });
    audit(user, 'leads-imported', 'lead', '', `${created.length} imported, ${skipped.length} duplicates skipped, ${failed.length} with errors${sourceDetail ? ` (${sourceDetail})` : ''}; basis: ${lawfulBasis}`);
    return { status: created.length ? 201 : 200, created, skipped, failed };
  }

  // ---------- activities ----------
  const ACTIVITY_FIELDS = ['leadId', 'opportunityId', 'kind', 'subject', 'notes', 'dueAt', 'status', 'outcome', 'ownerId'];
  function parseActivity(input, { existing = null, fields = ACTIVITY_FIELDS } = {}) {
    const r = reader(input, fields, true);
    const errors = [...r.errors];
    const out = {};
    const want = (k) => fields.includes(k) && (r.has(k) || !existing);
    if (want('kind')) { const k = r.str('kind', 10) || 'task'; if (!ACTIVITY_KINDS.includes(k)) errors.push(`kind must be one of: ${ACTIVITY_KINDS.join(', ')}`); out.kind = k; }
    if (want('subject')) { const s = r.str('subject', 160); if (!s) errors.push('subject is required'); if (s.length > 160) errors.push('subject must be 160 characters or fewer'); out.subject = s.slice(0, 160); }
    if (want('notes')) { const s = r.str('notes', 2000); if (s.length > 2000) errors.push('notes must be 2,000 characters or fewer'); out.notes = s.slice(0, 2000); }
    if (want('outcome')) { const s = r.str('outcome', 300); if (s.length > 300) errors.push('outcome must be 300 characters or fewer'); out.outcome = s.slice(0, 300); }
    if (want('dueAt')) { const d = parseDue(r.str('dueAt', 40)); if (Number.isNaN(d)) errors.push('dueAt must be a date and time like 2026-11-02T10:30'); out.dueAt = Number.isNaN(d) ? null : d; }
    if (want('status')) { const s = r.str('status', 10) || 'open'; if (!['open', 'done', 'cancelled'].includes(s)) errors.push('status must be open, done or cancelled'); out.status = s; }
    if (r.has('ownerId') && fields.includes('ownerId')) out.ownerId = r.str('ownerId', 60);
    if (r.has('opportunityId') && fields.includes('opportunityId')) out.opportunityId = r.str('opportunityId', 60) || null;
    if (r.has('leadId') && fields.includes('leadId')) out.leadId = r.str('leadId', 60);
    return { errors: [...new Set(errors)], values: out };
  }
  function touchLead(leadId, fn) { update('crm-leads', leadId, (l) => { l.lastActivityAt = iso(); if (fn) fn(l); }); }
  function addActivity(user, input, leadId = null) {
    if (!roles.can(user, 'crm.view')) return { status: 403, errors: ['your role does not include the sales CRM'] };
    const { errors, values } = parseActivity(leadId ? { ...input, leadId } : input);
    let opp = null;
    if (values.opportunityId) { opp = oppById(values.opportunityId); if (!opp || !seesOpp(user, opp)) errors.push('opportunity not found'); }
    const id = values.leadId || (opp && opp.leadId);
    const l = id && leadById(id);
    if (!l || !seesLead(user, l)) return { status: 404, errors: ['lead not found'] };
    if (opp && opp.leadId !== l.id) errors.push('that opportunity belongs to another lead');
    if (l.anonymizedAt) errors.push('this lead was anonymised under the retention rules');
    if (values.status === 'open' && !values.dueAt) errors.push('a follow-up still to do needs a due date');
    if (values.status === 'cancelled') errors.push('a new activity is either open or done');
    if (values.ownerId && values.ownerId !== user.id && !isManager(user)) errors.push('only a Sales Manager gives follow-ups to someone else');
    if (values.ownerId && !assignable(values.ownerId)) errors.push('the owner must be an active member of the sales team');
    if (errors.length) return { status: 400, errors };
    const a = saveSubmission('crm-activities', {
      leadId: l.id, opportunityId: opp ? opp.id : null, kind: values.kind, subject: values.subject, notes: values.notes || '', outcome: values.outcome || '',
      dueAt: values.dueAt || null, status: values.status, completedAt: values.status === 'done' ? iso() : null, ownerId: values.ownerId || user.id, createdBy: user.id, updatedAt: iso(),
    });
    // Talking to the contact moves a new lead on.
    touchLead(l.id, (x) => {
      if (a.status === 'done' && ['call', 'meeting', 'email'].includes(a.kind) && x.status === 'new') { x.status = 'contacted'; history(x, user, `Status New → Contacted (${ACTIVITY_LABEL[a.kind].toLowerCase()} logged)`); }
    });
    return { status: 201, activity: a };
  }
  function changeActivity(user, id, input) {
    const a = activities().find((x) => x.id === id);
    if (!a || !seesActivity(user, a)) return { status: 404, errors: ['activity not found'] };
    if (a.ownerId !== user.id && a.createdBy !== user.id && !isManager(user)) return { status: 403, errors: ['only its owner or a Sales Manager changes this'] };
    const { errors, values } = parseActivity(input, { existing: a, fields: ['subject', 'notes', 'dueAt', 'status', 'outcome', 'ownerId'] });
    if (values.ownerId && values.ownerId !== a.ownerId) {
      if (!isManager(user)) errors.push('only a Sales Manager gives follow-ups to someone else');
      else if (!assignable(values.ownerId)) errors.push('the owner must be an active member of the sales team');
    }
    if (a.status !== 'open' && values.status === undefined && Object.keys(values).some((k) => k !== 'notes' && k !== 'outcome')) errors.push(`this activity is ${a.status}; reopen it first`);
    if ((values.status || a.status) === 'open' && values.dueAt === null && 'dueAt' in values) errors.push('a follow-up still to do needs a due date');
    if (errors.length) return { status: 400, errors };
    const saved = update('crm-activities', id, (x) => {
      for (const [k, v] of Object.entries(values)) x[k] = v;
      if (values.status === 'done' && a.status !== 'done') x.completedAt = iso();
      if (values.status === 'open') x.completedAt = null;
      if (values.status === 'cancelled') x.cancelledAt = iso();
    });
    if (values.status === 'done' && a.status !== 'done') {
      touchLead(a.leadId, (x) => { if (['call', 'meeting', 'email'].includes(a.kind) && x.status === 'new') { x.status = 'contacted'; history(x, user, `Status New → Contacted (${ACTIVITY_LABEL[a.kind].toLowerCase()} done)`); } });
    }
    if (values.ownerId && values.ownerId !== a.ownerId) audit(user, 'activity-reassigned', 'activity', id, `${a.subject}: ${nameOf(a.ownerId)} → ${nameOf(values.ownerId)}`);
    return { status: 200, activity: saved };
  }
  function listActivities(user, q = {}) {
    const now = iso();
    const view = String(q.view || '');
    return activities().filter((a) => seesActivity(user, a)
      && (!q.leadId || a.leadId === q.leadId)
      && (view !== 'mine' || a.ownerId === user.id)
      && (view !== 'overdue' || (a.status === 'open' && a.dueAt && a.dueAt < now))
      && (view !== 'open' || a.status === 'open'))
      .sort((a, b) => (a.status === 'open') !== (b.status === 'open') ? (a.status === 'open' ? -1 : 1) : String(a.dueAt || a.createdAt).localeCompare(String(b.dueAt || b.createdAt)));
  }

  // ---------- opportunities ----------
  const OPP_FIELDS = ['leadId', 'title', 'estimatedValue', 'expectedCloseOn', 'nextAction', 'nextActionOn', 'services'];
  function parseOpp(input, { existing = null, fields = OPP_FIELDS } = {}) {
    const r = reader(input, fields, true);
    const errors = [...r.errors];
    const out = {};
    const want = (k) => fields.includes(k) && (r.has(k) || !existing);
    if (want('title')) { const s = r.str('title', 120); if (!s) errors.push('title is required'); if (s.length > 120) errors.push('title must be 120 characters or fewer'); out.title = s.slice(0, 120); }
    if (want('estimatedValue')) { const v = paiseFrom(r.str('estimatedValue', 20)); if (Number.isNaN(v)) errors.push('estimated value must be an amount in rupees with up to 2 decimals'); out.valuePaise = Number.isNaN(v) ? null : v; }
    if (want('expectedCloseOn')) { const d = r.str('expectedCloseOn', 10); if (d && !validDate(d)) errors.push('expectedCloseOn must be a date like 2026-12-31'); out.expectedCloseOn = d || null; }
    if (want('nextAction')) { const s = r.str('nextAction', 200); if (s.length > 200) errors.push('next action must be 200 characters or fewer'); out.nextAction = s.slice(0, 200); }
    if (want('nextActionOn')) { const d = r.str('nextActionOn', 10); if (d && !validDate(d)) errors.push('nextActionOn must be a date like 2026-11-05'); out.nextActionOn = d || null; }
    if (want('services')) {
      let s = input.services;
      if (typeof s === 'string') s = s.split(/[,\n]/);
      s = [...new Set((Array.isArray(s) ? s : []).map((x) => String(x).trim()).filter(Boolean))];
      if (s.some((x) => !SERVICES.includes(x))) errors.push(`services must be from: ${SERVICES.join(', ')}`);
      out.services = s;
    }
    if (r.has('leadId') && fields.includes('leadId')) out.leadId = r.str('leadId', 60);
    return { errors: [...new Set(errors)], values: out };
  }
  function createOpp(user, input) {
    if (!roles.can(user, 'crm.view')) return { status: 403, errors: ['your role does not include the sales CRM'] };
    const { errors, values } = parseOpp(input);
    const l = values.leadId && leadById(values.leadId);
    if (!l || !seesLead(user, l)) return { status: 404, errors: ['lead not found'] };
    if (['converted', 'lost', 'unqualified'].includes(l.status)) errors.push(`this lead is ${LEAD_LABEL[l.status].toLowerCase()}; reopen it first`);
    if (l.anonymizedAt) errors.push('this lead was anonymised under the retention rules');
    if (errors.length) return { status: 400, errors };
    const o = saveSubmission('crm-opportunities', {
      leadId: l.id, title: values.title, stage: 'New Lead', valuePaise: values.valuePaise ?? null, expectedCloseOn: values.expectedCloseOn || null,
      nextAction: values.nextAction || '', nextActionOn: values.nextActionOn || null, services: values.services || [], lostReason: null, lostDetail: '',
      ownerId: l.ownerId || user.id, createdBy: user.id, stageHistory: [{ from: null, to: 'New Lead', at: iso(), by: user.name }], wonAt: null, lostAt: null, conversion: null, updatedAt: iso(),
    });
    touchLead(l.id, (x) => history(x, user, `Opportunity added: ${o.title}`));
    audit(user, 'opportunity-created', 'opportunity', o.id, `${l.companyName}: ${o.title}${o.valuePaise ? ` (${inr(o.valuePaise)})` : ''}`);
    return { status: 201, opportunity: o };
  }
  function changeOpp(user, id, input) {
    const o = oppById(id);
    if (!o || !seesOpp(user, o)) return { status: 404, errors: ['opportunity not found'] };
    if (['Won', 'Lost'].includes(o.stage)) return { status: 409, errors: [`this opportunity is ${o.stage.toLowerCase()}`] };
    const { errors, values } = parseOpp(input, { existing: o, fields: OPP_FIELDS.filter((f) => f !== 'leadId') });
    if (errors.length) return { status: 400, errors };
    const valueChanged = values.valuePaise !== undefined && values.valuePaise !== o.valuePaise;
    const saved = update('crm-opportunities', id, (x) => Object.assign(x, values));
    if (valueChanged) audit(user, 'opportunity-value', 'opportunity', id, `${o.title}: ${o.valuePaise === null ? 'none' : inr(o.valuePaise)} → ${values.valuePaise === null ? 'none' : inr(values.valuePaise)}`);
    touchLead(o.leadId);
    return { status: 200, opportunity: saved };
  }
  // The lead follows its opportunities: talking → contacted, a meeting or
  // later → qualified, all lost → lost. A converted lead never changes.
  function syncLead(user, leadId) {
    const os = opps().filter((o) => o.leadId === leadId);
    update('crm-leads', leadId, (l) => {
      if (l.status === 'converted') return;
      const reached = (s) => os.some((o) => o.stageHistory.some((h) => h.to === s));
      let next = l.status;
      if (os.length && os.every((o) => o.stage === 'Lost')) next = 'lost';
      else if (['Meeting', 'Proposal', 'Negotiation', 'Won'].some(reached)) next = 'qualified';
      else if (reached('Contacted') && ['new', 'lost'].includes(l.status)) next = 'contacted';
      else if (l.status === 'lost' && os.some((o) => OPEN_STAGES.includes(o.stage))) next = 'new';
      if (next !== l.status) { history(l, user, `Status ${LEAD_LABEL[l.status]} → ${LEAD_LABEL[next]} (pipeline)`); l.status = next; }
      l.lastActivityAt = iso();
    });
  }
  function moveStage(user, id, input) {
    const o = oppById(id);
    if (!o || !seesOpp(user, o)) return { status: 404, errors: ['opportunity not found'] };
    const body = input || {};
    const stage = String(body.stage || '').trim();
    if (!STAGES.includes(stage)) return { status: 400, errors: [`stage must be one of: ${STAGES.join(', ')}`] };
    if (stage === o.stage) return { status: 200, opportunity: o };
    if (!MOVES[o.stage].includes(stage)) return { status: 409, errors: [`an opportunity moves from ${o.stage} only to ${MOVES[o.stage].join(' or ') || 'nowhere: it is final'}`] };
    if (o.stage === 'Lost' && !isManager(user)) return { status: 403, errors: ['only a Sales Manager reopens a lost opportunity'] };
    const reason = String(body.reason || body.lostReason || '').trim();
    const detail = String(body.detail || body.note || '').trim().slice(0, 300);
    if (stage === 'Lost') {
      if (!LOST_REASONS.includes(reason)) return { status: 400, errors: [`say why it was lost: one of ${LOST_REASONS.join(', ')}`] };
      if (reason === 'Other' && !detail) return { status: 400, errors: ['describe the reason'] };
    }
    if (stage === 'Won' && !proposals().some((p) => p.opportunityId === o.id && ['sent', 'accepted'].includes(p.status))) {
      return { status: 409, errors: ['send the client a proposal before marking it won'] };
    }
    const saved = update('crm-opportunities', id, (x) => {
      x.stageHistory = [...x.stageHistory, { from: o.stage, to: stage, at: iso(), by: user.name, ...(reason ? { reason } : {}), ...(detail ? { detail } : {}) }];
      x.stage = stage;
      if (stage === 'Lost') Object.assign(x, { lostReason: reason, lostDetail: detail, lostAt: iso() });
      if (stage === 'Won') x.wonAt = iso();
      if (o.stage === 'Lost') Object.assign(x, { lostReason: null, lostDetail: '', lostAt: null });
    });
    syncLead(user, o.leadId);
    audit(user, 'opportunity-stage', 'opportunity', id, `${o.title}: ${o.stage} → ${stage}${reason ? ` (${reason}${detail ? `: ${detail}` : ''})` : ''}`);
    if (stage === 'Won') tell(managers().filter((m) => m.id !== user.id), `crm-won:${id}`, 'crm-lead', { leadId: o.leadId, subject: `Won: ${o.title}`, intro: `${user.name} marked an opportunity won. Convert it to hand the client over to recruitment.` }, `Won: ${o.title}`, 'Ready to convert');
    return { status: 200, opportunity: saved };
  }

  // ---------- proposals ----------
  const nextNumber = () => `PRO-${String(proposals().reduce((n, p) => Math.max(n, Number(String(p.number).slice(4)) || 0), 0) + 1).padStart(4, '0')}`;
  const latest = (p) => p.versions[p.versions.length - 1];
  // A sent proposal past its validity expires.
  function refresh() {
    const list = proposals();
    const today = todayIst();
    let changed = false;
    for (const p of list) {
      if (p.status === 'sent' && latest(p).validUntil < today) {
        p.status = 'expired'; p.updatedAt = iso(); p.history = [...(p.history || []), { at: iso(), by: 'System', text: 'Expired: past its validity date' }];
        changed = true;
      }
    }
    if (changed) writeSubmissions('crm-proposals', list);
  }
  function createProposal(user, input) {
    if (!roles.can(user, 'crm.view')) return { status: 403, errors: ['your role does not include the sales CRM'] };
    const o = input && oppById(String(input.opportunityId || ''));
    if (!o || !seesOpp(user, o)) return { status: 404, errors: ['opportunity not found'] };
    if (['Won', 'Lost'].includes(o.stage)) return { status: 409, errors: [`this opportunity is ${o.stage.toLowerCase()}`] };
    if (proposals().some((p) => p.opportunityId === o.id && ['draft', 'approved', 'sent'].includes(p.status))) return { status: 409, errors: ['this opportunity already has a proposal in progress: change that one (a new version) or withdraw it'] };
    const { errors, values } = parseProposal(input);
    if (errors.length) return { status: 400, errors };
    const l = leadById(o.leadId);
    const p = saveSubmission('crm-proposals', {
      number: nextNumber(), opportunityId: o.id, leadId: o.leadId, status: 'draft', internalNotes: values.internalNotes,
      versions: [], approvedBy: null, approvedAt: null, sentAt: null, tokenHash: null, response: null, createdBy: user.id, history: [], updatedAt: iso(),
    });
    const saved = update('crm-proposals', p.id, (x) => { x.versions = [versionOf(x, values, user, l, 1)]; x.history = [{ at: iso(), by: user.name, text: 'Version 1 written' }]; });
    audit(user, 'proposal-created', 'proposal', p.id, `${p.number} for ${l.companyName}`);
    return { status: 201, proposal: saved };
  }
  function versionOf(p, values, user, l, version) {
    const v = { version, title: values.title, services: values.services, scope: values.scope, validUntil: values.validUntil, valuePaise: values.valuePaise, terms: values.terms, createdBy: user.id, createdByName: user.name, at: iso() };
    v.text = proposalText(site, p, v, l);
    v.sha256 = sha256(v.text);
    return v;
  }
  // Any change is a new version: an approved or sent one goes back to draft,
  // its approval and link no longer count.
  function reviseProposal(user, id, input) {
    refresh();
    const p = proposals().find((x) => x.id === id);
    if (!p || !seesProposal(user, p)) return { status: 404, errors: ['proposal not found'] };
    if (PROPOSAL_FINAL.includes(p.status)) return { status: 409, errors: [`this proposal is ${PROPOSAL_LABEL[p.status].toLowerCase()}; write a new one`] };
    const merged = { ...versionInput(latest(p)), internalNotes: p.internalNotes, ...input };
    delete merged.opportunityId;
    const { errors, values } = parseProposal(merged, { fields: PROPOSAL_FIELDS.filter((f) => f !== 'opportunityId') });
    if (errors.length) return { status: 400, errors };
    const l = leadById(p.leadId);
    const was = p.status;
    const saved = update('crm-proposals', id, (x) => {
      const v = versionOf(x, values, user, l, x.versions.length + 1);
      x.versions = [...x.versions, v];
      x.internalNotes = values.internalNotes;
      Object.assign(x, { status: 'draft', approvedBy: null, approvedAt: null, tokenHash: null });
      x.history = [...x.history, { at: iso(), by: user.name, text: `Version ${v.version} written${was !== 'draft' ? ` (was ${PROPOSAL_LABEL[was].toLowerCase()}; back to draft)` : ''}` }];
    });
    audit(user, 'proposal-revised', 'proposal', id, `${p.number}: version ${saved.versions.length}${was !== 'draft' ? ` (was ${was})` : ''}`);
    return { status: 200, proposal: saved };
  }
  // A version's values as a form would send them.
  const versionInput = (v) => ({
    title: v.title, services: v.services, scope: v.scope, validUntil: v.validUntil, estimatedValue: v.valuePaise === null || v.valuePaise === undefined ? '' : (v.valuePaise / 100).toFixed(2),
    kind: v.terms.kind, feeMode: v.terms.feeMode, feePercent: v.terms.feeBp === null || v.terms.feeBp === undefined ? '' : String(v.terms.feeBp / 100),
    flatFee: v.terms.flatFeePaise === null || v.terms.flatFeePaise === undefined ? '' : (v.terms.flatFeePaise / 100).toFixed(2),
    guaranteeDays: v.terms.guaranteeDays === null || v.terms.guaranteeDays === undefined ? '' : String(v.terms.guaranteeDays), paymentDays: String(v.terms.paymentDays ?? ''),
    markupPercent: v.terms.markupBp === null || v.terms.markupBp === undefined ? '' : String(v.terms.markupBp / 100),
  });
  const unsubscribeToken = (leadId) => `${leadId}.${hmac(`unsubscribe:${leadId}`).slice(0, 32)}`;
  const leadFromUnsubscribe = (token) => {
    const [id, sig] = String(token || '').split('.');
    if (!id || !sig || sig.length !== 32) return null;
    const want = hmac(`unsubscribe:${id}`).slice(0, 32);
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want)) ? leadById(id) : null;
  };
  async function actOnProposal(user, id, action, input = {}) {
    refresh();
    const p = proposals().find((x) => x.id === id);
    if (!p || !seesProposal(user, p)) return { status: 404, errors: ['proposal not found'] };
    const v = latest(p);
    const l = leadById(p.leadId);
    const o = oppById(p.opportunityId);
    if (action === 'approve') {
      if (!roles.can(user, 'crm.approve')) return { status: 403, errors: ['only a Sales Manager or an Admin approves proposals'] };
      if (p.status !== 'draft') return { status: 409, errors: ['only a draft is approved'] };
      if (v.createdBy === user.id) return { status: 403, errors: ['someone other than the author of this version approves it'] };
      const saved = update('crm-proposals', id, (x) => { Object.assign(x, { status: 'approved', approvedBy: user.id, approvedAt: iso() }); x.history = [...x.history, { at: iso(), by: user.name, text: `Version ${v.version} approved` }]; });
      audit(user, 'proposal-approved', 'proposal', id, `${p.number} version ${v.version}`);
      return { status: 200, proposal: saved };
    }
    if (action === 'send') {
      if (p.status !== 'approved') return { status: 409, errors: ['a proposal is approved before it is sent'] };
      if (v.validUntil < todayIst()) return { status: 409, errors: ['its validity date has passed: write a new version'] };
      if (!l || !l.email) return { status: 409, errors: ['the lead has no email address: add one, or record the client\'s answer yourself'] };
      if (l.unsubscribedAt) return { status: 409, errors: ['this contact asked us not to email them; share the proposal another way and record their answer'] };
      if (!l.lawfulBasis && !(l.consent && l.consent.marketing)) return { status: 409, errors: ['we have no recorded reason to email this contact'] };
      const token = crypto.randomBytes(24).toString('base64url');
      const owner = l.ownerId ? team.byId(l.ownerId) : null;
      const saved = update('crm-proposals', id, (x) => {
        Object.assign(x, { status: 'sent', sentAt: iso(), sentVersion: v.version, tokenHash: sha256(token) });
        x.history = [...x.history, { at: iso(), by: user.name, text: `Version ${v.version} sent to ${l.email}` }];
      });
      if (o && ['New Lead', 'Contacted', 'Meeting'].includes(o.stage)) {
        update('crm-opportunities', o.id, (x) => { x.stageHistory = [...x.stageHistory, { from: o.stage, to: 'Proposal', at: iso(), by: user.name, detail: `${p.number} sent` }]; x.stage = 'Proposal'; });
        syncLead(user, o.leadId);
      }
      saveSubmission('crm-activities', { leadId: l.id, opportunityId: p.opportunityId, kind: 'email', subject: `Proposal ${p.number} v${v.version} sent`, notes: '', outcome: '', status: 'done', dueAt: null, completedAt: iso(), ownerId: user.id, createdBy: user.id, updatedAt: iso() });
      touchLead(l.id);
      audit(user, 'proposal-sent', 'proposal', id, `${p.number} version ${v.version}`);
      const sent = await mailer.crmProposal({ name: l.contactName, email: l.email }, { number: p.number, title: v.title, validUntil: v.validUntil, link: `${baseUrl}/crm/proposal/${token}`, unsubscribe: `${baseUrl}/crm/unsubscribe/${unsubscribeToken(l.id)}`, owner: owner ? { name: owner.name, email: owner.email } : null });
      if (!sent) update('crm-proposals', id, (x) => { x.history = [...x.history, { at: iso(), by: 'System', text: 'The email could not be sent: send it again or share the proposal another way' }]; });
      return { status: 200, proposal: saved, emailed: Boolean(sent) };
    }
    if (action === 'withdraw') {
      if (PROPOSAL_FINAL.includes(p.status)) return { status: 409, errors: [`already ${PROPOSAL_LABEL[p.status].toLowerCase()}`] };
      const reason = String(input.reason || '').trim().slice(0, 300);
      if (!reason) return { status: 400, errors: ['say why it is withdrawn'] };
      const saved = update('crm-proposals', id, (x) => { Object.assign(x, { status: 'withdrawn', tokenHash: null }); x.history = [...x.history, { at: iso(), by: user.name, text: `Withdrawn: ${reason}` }]; });
      audit(user, 'proposal-withdrawn', 'proposal', id, `${p.number}: ${reason}`);
      return { status: 200, proposal: saved };
    }
    if (action === 'response') {
      // The client answered by phone, email or in person: the team records it.
      if (p.status !== 'sent') return { status: 409, errors: ['record an answer to a proposal that was sent'] };
      const decision = String(input.decision || '').trim();
      const note = String(input.note || '').trim().slice(0, 500);
      const channel = String(input.channel || '').trim();
      if (!['accepted', 'rejected'].includes(decision)) return { status: 400, errors: ['decision must be accepted or rejected'] };
      if (!['Email', 'Phone', 'Meeting', 'Letter'].includes(channel)) return { status: 400, errors: ['channel must be Email, Phone, Meeting or Letter'] };
      if (!note) return { status: 400, errors: ['note what the client said, and who said it'] };
      if (decision === 'accepted' && !roles.can(user, 'crm.approve')) return { status: 403, errors: ['a Sales Manager or an Admin records an acceptance'] };
      const saved = update('crm-proposals', id, (x) => {
        Object.assign(x, { status: decision, tokenHash: null, response: { decision, version: v.version, sha256: v.sha256, at: iso(), recordedBy: user.id, recordedByName: user.name, channel, note } });
        x.history = [...x.history, { at: iso(), by: user.name, text: `${decision === 'accepted' ? 'Accepted' : 'Rejected'} by the client (${channel.toLowerCase()}): ${note}` }];
      });
      afterResponse(user, saved, decision);
      return { status: 200, proposal: saved };
    }
    return { status: 400, errors: ['unknown action'] };
  }
  function afterResponse(user, p, decision) {
    const o = oppById(p.opportunityId);
    if (o && decision === 'accepted' && o.stage === 'Proposal') {
      update('crm-opportunities', o.id, (x) => { x.stageHistory = [...x.stageHistory, { from: 'Proposal', to: 'Negotiation', at: iso(), by: user ? user.name : 'Client', detail: `${p.number} accepted` }]; x.stage = 'Negotiation'; });
    }
    touchLead(p.leadId);
    audit(user, `proposal-${decision}`, 'proposal', p.id, `${p.number} version ${p.response.version} ${decision}${user ? '' : ' by the client online'}`);
    if (o) {
      const owner = o.ownerId && team.byId(o.ownerId);
      tell([owner, ...(decision === 'accepted' ? managers() : [])], `crm-answer:${p.id}:${p.response.version}`, 'crm-lead', { leadId: p.leadId, subject: `Proposal ${p.number} ${decision}`, intro: `the client ${decision} proposal ${p.number}.` }, `Proposal ${p.number} ${decision}`, o.title);
    }
  }
  const proposalByToken = (token) => {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(String(token || ''))) return null;
    refresh();
    const h = sha256(token);
    return proposals().find((p) => p.tokenHash && p.tokenHash === h) || null;
  };
  // The client's answer on the proposal page: typed name, designation and
  // agreement for an acceptance, with evidence.
  function clientAnswer(req, token, decision) {
    const p = proposalByToken(token);
    if (!p) return { status: 404, errors: ['this link is no longer valid'] };
    if (p.status !== 'sent') return { status: 409, errors: [`this proposal is ${PROPOSAL_LABEL[p.status].toLowerCase()}`] };
    const v = latest(p);
    const body = req.body || {};
    const name = String(body.name || '').trim().slice(0, 120);
    const designation = String(body.designation || '').trim().slice(0, 80);
    const comment = String(body.comment || '').trim().slice(0, 1000);
    const errors = [];
    if (!name) errors.push('type your full name');
    if (decision === 'accepted') {
      if (!designation) errors.push('type your designation');
      if (!truthy(body.agree)) errors.push('tick the box to confirm you accept these terms for your company');
      if (String(body.sha256 || '') !== v.sha256) errors.push('this proposal changed since you opened it: reload the page and read it again');
    }
    if (errors.length) return { status: 400, errors };
    const saved = update('crm-proposals', p.id, (x) => {
      Object.assign(x, { status: decision, tokenHash: null, response: { decision, version: v.version, sha256: v.sha256, at: iso(), name, designation, comment, ipHash: ipHash(req.ip), userAgent: String(req.get('User-Agent') || '').slice(0, 200), online: true } });
      x.history = [...x.history, { at: iso(), by: `${name} (client)`, text: `${decision === 'accepted' ? 'Accepted' : 'Declined'} version ${v.version} online${comment ? `: ${comment}` : ''}` }];
    });
    afterResponse(null, saved, decision);
    return { status: 200, proposal: saved };
  }

  // ---------- conversion ----------
  // A won opportunity becomes a client: an existing employer account is
  // linked, or a new one is created through the employer portal's own
  // invitation. The accepted proposal's terms can become a Draft contract;
  // it is signed in the client portal before it applies. Nothing is invoiced.
  const converting = new Set();
  function matchingClients(l) {
    const k = keysOf(l);
    return clients.read().filter((c) => (l.employerId && c.id === l.employerId) || (k.emailKey && emailKey(c.email) === k.emailKey)
      || (k.domain && domainOf(c.email) === k.domain) || (k.companyKey && companyKey(c.company) === k.companyKey));
  }
  function convert(user, id, input, idemKey) {
    const o = oppById(id);
    if (!o || !seesOpp(user, o)) return { status: 404, errors: ['opportunity not found'] };
    const l = leadById(o.leadId);
    if (o.conversion && o.conversion.status === 'done') return { status: 200, existed: true, opportunity: o, conversion: o.conversion };
    if (o.stage !== 'Won') return { status: 409, errors: ['only a won opportunity is converted'] };
    if (!l || l.anonymizedAt) return { status: 409, errors: ['the lead behind this opportunity is gone'] };
    const body = input || {};
    // Representatives ask; a Sales Manager or an Admin converts.
    if (!roles.can(user, 'crm.convert')) {
      if (o.conversion && o.conversion.status === 'requested') return { status: 202, existed: true, opportunity: o, conversion: o.conversion };
      const note = String(body.note || '').trim().slice(0, 300);
      const saved = update('crm-opportunities', id, (x) => { x.conversion = { status: 'requested', requestedBy: user.id, requestedByName: user.name, requestedAt: iso(), note }; });
      audit(user, 'conversion-requested', 'opportunity', id, `${l.companyName}: ${o.title}`);
      tell(managers(), `crm-convert:${id}`, 'crm-lead', { leadId: l.id, subject: `Convert ${l.companyName}`, intro: `${user.name} asks you to convert a won client and hand it to recruitment.` }, `Convert ${l.companyName}`, o.title);
      return { status: 202, opportunity: saved, conversion: saved.conversion };
    }
    if (converting.has(id)) return { status: 409, errors: ['this opportunity is being converted already'] };
    const key = String(idemKey || body.idempotencyKey || '').slice(0, 100);
    converting.add(id);
    try {
      const errors = [];
      const employerId = String(body.employerId || '').trim();
      const createNew = truthy(body.createNew);
      const matches = matchingClients(l);
      let employer = null;
      if (employerId) {
        employer = clients.read().find((c) => c.id === employerId) || null;
        if (!employer) errors.push('that client account does not exist');
      } else if (createNew) {
        const exact = matches.filter((c) => emailKey(c.email) === emailKey(l.email) || (l.employerId && c.id === l.employerId));
        if (exact.length) return { status: 409, errors: ['a client account with this contact already exists: link it instead of creating another'], matches: matches.map(clientMatch) };
        if (!l.email) errors.push('the lead needs an email address to invite the client\'s owner');
      } else if (matches.length) {
        return { status: 409, errors: ['link an existing client account (employerId) or confirm a new one (createNew)'], matches: matches.map(clientMatch) };
      } else return { status: 400, errors: ['no client account matches this lead: confirm a new one (createNew)'], matches: [] };
      // The accepted proposal's terms as a Draft contract.
      const wantContract = truthy(body.contract);
      let contractInput = null;
      if (wantContract) {
        const accepted = proposals().filter((p) => p.opportunityId === o.id && p.status === 'accepted').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
        if (!accepted) errors.push('the client has not accepted a proposal, so there are no agreed terms for a contract');
        else {
          const v = accepted.versions.find((x) => x.version === accepted.response.version) || latest(accepted);
          const reference = String(body.contractReference || '').trim();
          const startsOn = String(body.startsOn || '').trim();
          const vi = versionInput(v);
          contractInput = { reference, kind: vi.kind, startsOn, endsOn: String(body.endsOn || '').trim(), feeMode: vi.feeMode, feePercent: vi.feePercent, flatFee: vi.flatFee, guaranteeDays: vi.guaranteeDays, paymentDays: vi.paymentDays, markupPercent: vi.markupPercent, notes: `From proposal ${accepted.number} version ${v.version} (SHA-256 ${v.sha256.slice(0, 16)}…)` };
          const check = parseContract({ ...contractInput, status: 'Draft' }, { strict: true });
          errors.push(...check.errors);
        }
      }
      if (errors.length) return { status: 400, errors: [...new Set(errors)] };
      let created = false;
      if (!employer) {
        const r = clients.createClient({ company: l.companyName, name: l.contactName, email: l.email, extra: { phone: l.phone || '', industry: l.industry || '', source: 'crm', crmLeadId: l.id } }, user.name);
        if (r.errors.length) return { status: 400, errors: r.errors };
        employer = r.employer;
        created = true;
      }
      let contractId = null;
      if (contractInput) {
        const r = agency.handoverContract(user, employer.id, contractInput, `CRM ${o.title}`);
        if (r.errors) {
          // The account stays (it is real and invited); the contract is added later.
          audit(user, 'conversion-contract-failed', 'opportunity', id, `${employer.company}: ${r.errors.join('; ')}`);
          return { status: r.status, errors: [...r.errors, created ? 'the client account was created; add the contract from its page' : ''].filter(Boolean), employerId: employer.id };
        }
        contractId = r.contract.id;
      }
      const conversion = { status: 'done', employerId: employer.id, company: employer.company, createdClient: created, contractId, by: user.id, byName: user.name, at: iso(), key: key || null, ...(o.conversion && o.conversion.requestedBy ? { requestedBy: o.conversion.requestedBy, requestedAt: o.conversion.requestedAt } : {}) };
      const saved = update('crm-opportunities', id, (x) => { x.conversion = conversion; });
      update('crm-leads', l.id, (x) => { history(x, user, `Converted: ${created ? 'new client account' : 'linked to'} ${employer.company}${contractId ? ', draft contract added' : ''}`); x.status = 'converted'; x.employerId = employer.id; x.convertedAt = iso(); });
      audit(user, 'converted', 'opportunity', id, `${l.companyName} → ${created ? 'new client' : 'existing client'} ${employer.company}${contractId ? ' with a draft contract' : ''}`);
      return { status: 201, opportunity: saved, conversion };
    } finally {
      converting.delete(id);
    }
  }
  const clientMatch = (c) => ({ id: c.id, company: c.company, contact: c.name, active: c.active !== false });

  // ---------- reports ----------
  function report(user, q = {}) {
    const to = validDate(String(q.to || '')) ? q.to : todayIst();
    const from = validDate(String(q.from || '')) ? q.from : new Date(Date.parse(`${to}T00:00:00Z`) - 89 * DAY).toISOString().slice(0, 10);
    const inRange = (t) => { const d = t ? new Date(t).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) : ''; return d && d >= from && d <= to; };
    // Representatives see their own numbers; managers and finance see everyone's.
    const all = isManager(user) || !roles.can(user, 'crm.view');
    const L = leads().filter((l) => all || seesLead(user, l));
    const O = opps().filter((o) => all || seesOpp(user, o));
    const A = activities().filter((a) => all || seesActivity(user, a));
    const P = proposals().filter((p) => all || seesProposal(user, p));
    const received = L.filter((l) => inRange(l.createdAt));
    const qualified = received.filter((l) => ['qualified', 'converted'].includes(l.status) || O.some((o) => o.leadId === l.id && o.stageHistory.some((h) => ['Meeting', 'Proposal', 'Negotiation', 'Won'].includes(h.to))));
    const converted = received.filter((l) => l.status === 'converted');
    const won = O.filter((o) => o.stage === 'Won' && inRange(o.wonAt));
    const cycles = won.map((o) => Math.round((Date.parse(o.wonAt) - Date.parse(o.createdAt)) / DAY)).sort((a, b) => a - b);
    const open = O.filter((o) => OPEN_STAGES.includes(o.stage));
    const now = iso();
    const people = new Map();
    const person = (id) => { const k = id || 'none'; if (!people.has(k)) people.set(k, { id: id || null, name: id ? nameOf(id) || 'Former member' : 'Unassigned', leads: 0, converted: 0, openValuePaise: 0, won: 0, wonValuePaise: 0, activitiesDone: 0, overdue: 0 }); return people.get(k); };
    for (const l of received) { const p = person(l.ownerId); p.leads++; if (l.status === 'converted') p.converted++; }
    for (const o of open) person(o.ownerId).openValuePaise += o.valuePaise || 0;
    for (const o of won) { const p = person(o.ownerId); p.won++; p.wonValuePaise += o.valuePaise || 0; }
    for (const a of A) {
      if (a.status === 'done' && inRange(a.completedAt)) person(a.ownerId).activitiesDone++;
      if (a.status === 'open' && a.dueAt && a.dueAt < now) person(a.ownerId).overdue++;
    }
    const out = {
      period: { from, to },
      scope: all ? 'everyone' : 'yours',
      leads: { received: received.length, qualified: qualified.length, converted: converted.length, conversionRatePercent: received.length ? Number(((converted.length / received.length) * 100).toFixed(1)) : null },
      meetingsDone: A.filter((a) => a.kind === 'meeting' && a.status === 'done' && inRange(a.completedAt)).length,
      followUpsOverdue: A.filter((a) => a.status === 'open' && a.dueAt && a.dueAt < now).length,
      proposals: { sent: P.filter((p) => inRange(p.sentAt)).length, accepted: P.filter((p) => p.status === 'accepted' && inRange(p.response && p.response.at)).length, rejected: P.filter((p) => p.status === 'rejected' && inRange(p.response && p.response.at)).length },
      opportunities: { won: won.length, wonValuePaise: won.reduce((n, o) => n + (o.valuePaise || 0), 0), lost: O.filter((o) => o.stage === 'Lost' && inRange(o.lostAt)).length, medianSalesCycleDays: cycles.length ? cycles[Math.floor((cycles.length - 1) / 2)] : null },
      pipeline: OPEN_STAGES.map((s) => { const os = open.filter((o) => o.stage === s); return { stage: s, count: os.length, valuePaise: os.reduce((n, o) => n + (o.valuePaise || 0), 0) }; }),
      lostReasons: LOST_REASONS.map((r) => ({ reason: r, count: O.filter((o) => o.stage === 'Lost' && o.lostReason === r && inRange(o.lostAt)).length })).filter((x) => x.count),
      byRepresentative: [...people.values()].sort((a, b) => b.wonValuePaise - a.wonValuePaise || b.leads - a.leads),
      bySource: SOURCES.map((s) => { const ls = received.filter((l) => l.source === s); const c = ls.filter((l) => l.status === 'converted').length; return { source: s, leads: ls.length, converted: c, conversionRatePercent: ls.length ? Number(((c / ls.length) * 100).toFixed(1)) : null }; }).filter((x) => x.leads),
    };
    if (roles.can(user, 'crm.revenue')) out.revenue = revenue(L, from, to);
    return out;
  }
  // Money received from clients won through the CRM: payments (and TDS)
  // recorded on their invoices in billing, less refunds, by payment date.
  // Estimates and unpaid invoices never count.
  function revenue(L, from, to) {
    const won = new Map();
    for (const l of L) if (l.status === 'converted' && l.employerId) won.set(l.employerId, l);
    const rows = new Map();
    const paise = (x) => Math.round(Number(x || 0) * 100);
    for (const p of billing.read()) {
      if (!won.has(p.employerId)) continue;
      for (const inv of billing.invoicesOf(p)) {
        const row = rows.get(p.employerId) || { employerId: p.employerId, company: won.get(p.employerId).companyName, source: won.get(p.employerId).source, receivedPaise: 0, invoices: 0 };
        let counted = false;
        for (const pay of inv.payments || []) if (pay.date >= from && pay.date <= to) { row.receivedPaise += paise(pay.amount) + paise(pay.tds); counted = true; }
        for (const r of inv.refunds || []) if (r.date >= from && r.date <= to) { row.receivedPaise -= paise(r.amount); counted = true; }
        if (counted) row.invoices++;
        rows.set(p.employerId, row);
      }
    }
    const byClient = [...rows.values()].filter((r) => r.receivedPaise || r.invoices).sort((a, b) => b.receivedPaise - a.receivedPaise);
    const bySource = {};
    for (const r of byClient) bySource[r.source] = (bySource[r.source] || 0) + r.receivedPaise;
    return { basis: 'payments recorded in billing, including TDS, less refunds, by payment date', receivedPaise: byClient.reduce((n, r) => n + r.receivedPaise, 0), byClient, bySource: Object.entries(bySource).map(([source, receivedPaise]) => ({ source, receivedPaise })) };
  }

  // ---------- reminders and retention ----------
  // Follow-ups due within a day and overdue ones, once each per due time,
  // through the notification queue (which retries failed emails).
  function scan() {
    const now = Date.now();
    let sent = 0;
    for (const a of activities()) {
      if (a.status !== 'open' || !a.dueAt || !a.ownerId) continue;
      const due = Date.parse(a.dueAt);
      const overdue = due < now;
      if (!overdue && due - now > DAY) continue;
      const u = team.byId(a.ownerId);
      if (!u) continue;
      const kind = overdue ? 'overdue' : 'soon';
      tell([u], `crm-due:${a.id}:${a.dueAt}:${kind}`, 'crm-follow-up', { activityId: a.id, leadId: a.leadId, dueAt: a.dueAt, overdue }, overdue ? `Overdue: ${a.subject}` : `Due soon: ${a.subject}`, istText(a.dueAt));
      sent++;
    }
    return sent;
  }
  // Leads that went nowhere keep their company and history but lose the
  // person's contact details after the retention period.
  function prune(months = Number(process.env.CRM_RETENTION_MONTHS) || RETENTION_MONTHS) {
    const cutoff = new Date(Date.now() - months * 30.44 * DAY).toISOString();
    const list = leads();
    const gone = [];
    for (const l of list) {
      if (l.anonymizedAt || !['lost', 'unqualified'].includes(l.status) || String(l.lastActivityAt || l.updatedAt || l.createdAt) > cutoff) continue;
      Object.assign(l, { contactName: 'Removed', designation: '', email: '', phone: '', notes: '', hiringNeeds: '', emailKey: '', phoneKey: '', anonymizedAt: iso(), updatedAt: iso() });
      history(l, null, `Contact details removed after ${months} months without activity`);
      gone.push(l.id);
    }
    if (!gone.length) return 0;
    writeSubmissions('crm-leads', list);
    const as = activities();
    for (const a of as) if (gone.includes(a.leadId)) { a.notes = ''; a.outcome = ''; }
    writeSubmissions('crm-activities', as);
    audit(null, 'leads-anonymised', 'lead', '', `${gone.length} leads past the ${months}-month retention period`);
    return gone.length;
  }
  function unsubscribe(token) {
    const l = leadFromUnsubscribe(token);
    if (!l) return null;
    if (!l.unsubscribedAt) {
      update('crm-leads', l.id, (x) => { x.unsubscribedAt = iso(); x.consent = { marketing: false, at: iso(), how: 'unsubscribed by email link' }; history(x, null, 'Unsubscribed from sales emails'); });
      audit(null, 'lead-unsubscribed', 'lead', l.id, l.companyName);
    }
    return l;
  }

  // ---------- JSON API ----------
  const teamApi = (action) => (req, res, next) => {
    const user = team.currentUser(req);
    if (!user) return res.status(401).json({ ok: false, errors: ['sign in to the team admin first'] });
    if (team.requires2fa() && !team.has2fa(user.id)) return res.status(403).json({ ok: false, errors: ['your team requires two-step sign-in: set it up first'] });
    if (!roles.can(user, action)) return res.status(403).json({ ok: false, errors: ['your role does not allow that'] });
    req.admin = user;
    res.set('Cache-Control', 'no-store');
    next();
  };
  const apiLimit = limit('crm-api', 240, 60 * 1000);
  const out = (res, r, map = (x) => x) => (r.errors ? res.status(r.status).json({ ok: false, errors: r.errors, ...(r.duplicates ? { duplicates: r.duplicates } : {}), ...(r.matches ? { matches: r.matches } : {}) }) : res.status(r.status).json({ ok: true, ...(r.existed ? { existed: true } : {}), ...map(r) }));
  const actJson = (a) => ({ ...a, ownerName: nameOf(a.ownerId), overdue: a.status === 'open' && Boolean(a.dueAt) && a.dueAt < iso() });
  const oppJson = (o) => { const l = leadById(o.leadId); return { ...o, companyName: l ? l.companyName : '', ownerName: nameOf(o.ownerId) }; };
  const proposalJson = (p) => { const { tokenHash, ...rest } = p; return { ...rest, current: latest(p) }; };

  app.get('/api/crm/leads', teamApi('crm.view'), apiLimit, (req, res) => res.json({ ok: true, leads: searchLeads(req.admin, req.query).slice(0, 500).map(leadJson) }));
  app.post('/api/crm/leads', teamApi('crm.view'), apiLimit, sameOrigin, (req, res) => out(res, createLead(req.admin, req.body), (r) => ({ lead: leadJson(r.lead) })));
  app.post('/api/crm/leads/import', teamApi('crm.import'), limit('crm-import', 10, 10 * 60 * 1000), sameOrigin, (req, res) => out(res, importLeads(req.admin, req.body)));
  app.get('/api/crm/leads/:id', teamApi('crm.view'), apiLimit, (req, res) => {
    const l = leadById(req.params.id);
    if (!seesLead(req.admin, l)) return res.status(404).json({ ok: false, errors: ['lead not found'] });
    res.json({ ok: true, lead: leadJson(l), opportunities: opps().filter((o) => o.leadId === l.id).map(oppJson), activities: listActivities(req.admin, { leadId: l.id }).map(actJson), proposals: proposals().filter((p) => p.leadId === l.id && seesProposal(req.admin, p)).map(proposalJson), duplicates: duplicatesOf(l, l.id, req.admin) });
  });
  app.patch('/api/crm/leads/:id', teamApi('crm.view'), apiLimit, sameOrigin, (req, res) => out(res, changeLead(req.admin, req.params.id, req.body), (r) => ({ lead: leadJson(r.lead) })));
  app.post('/api/crm/leads/:id/assign', teamApi('crm.manage'), apiLimit, sameOrigin, (req, res) => out(res, assignLead(req.admin, req.params.id, req.body), (r) => ({ lead: leadJson(r.lead) })));
  app.post('/api/crm/leads/:id/activities', teamApi('crm.view'), apiLimit, sameOrigin, (req, res) => out(res, addActivity(req.admin, req.body, req.params.id), (r) => ({ activity: actJson(r.activity) })));
  app.get('/api/crm/activities', teamApi('crm.view'), apiLimit, (req, res) => res.json({ ok: true, activities: listActivities(req.admin, req.query).slice(0, 500).map(actJson) }));
  app.post('/api/crm/activities', teamApi('crm.view'), apiLimit, sameOrigin, (req, res) => out(res, addActivity(req.admin, req.body), (r) => ({ activity: actJson(r.activity) })));
  app.patch('/api/crm/activities/:id', teamApi('crm.view'), apiLimit, sameOrigin, (req, res) => out(res, changeActivity(req.admin, req.params.id, req.body), (r) => ({ activity: actJson(r.activity) })));
  app.get('/api/crm/opportunities', teamApi('crm.view'), apiLimit, (req, res) => {
    const stage = STAGES.includes(req.query.stage) ? req.query.stage : '';
    res.json({ ok: true, opportunities: opps().filter((o) => seesOpp(req.admin, o) && (!stage || o.stage === stage)).map(oppJson) });
  });
  app.post('/api/crm/opportunities', teamApi('crm.view'), apiLimit, sameOrigin, (req, res) => out(res, createOpp(req.admin, req.body), (r) => ({ opportunity: oppJson(r.opportunity) })));
  app.patch('/api/crm/opportunities/:id', teamApi('crm.view'), apiLimit, sameOrigin, (req, res) => out(res, changeOpp(req.admin, req.params.id, req.body), (r) => ({ opportunity: oppJson(r.opportunity) })));
  app.patch('/api/crm/opportunities/:id/stage', teamApi('crm.view'), apiLimit, sameOrigin, (req, res) => out(res, moveStage(req.admin, req.params.id, req.body), (r) => ({ opportunity: oppJson(r.opportunity) })));
  app.post('/api/crm/opportunities/:id/convert', teamApi('crm.view'), limit('crm-convert', 20, 10 * 60 * 1000), sameOrigin, (req, res) => out(res, convert(req.admin, req.params.id, req.body, req.get('Idempotency-Key')), (r) => ({ opportunity: oppJson(r.opportunity), conversion: r.conversion })));
  app.get('/api/crm/proposals', teamApi('crm.view'), apiLimit, (req, res) => { refresh(); res.json({ ok: true, proposals: proposals().filter((p) => seesProposal(req.admin, p)).map(proposalJson) }); });
  app.post('/api/crm/proposals', teamApi('crm.view'), apiLimit, sameOrigin, (req, res) => out(res, createProposal(req.admin, req.body), (r) => ({ proposal: proposalJson(r.proposal) })));
  app.get('/api/crm/proposals/:id', teamApi('crm.view'), apiLimit, (req, res) => {
    refresh();
    const p = proposals().find((x) => x.id === req.params.id);
    if (!seesProposal(req.admin, p)) return res.status(404).json({ ok: false, errors: ['proposal not found'] });
    res.json({ ok: true, proposal: proposalJson(p) });
  });
  app.patch('/api/crm/proposals/:id', teamApi('crm.view'), apiLimit, sameOrigin, (req, res) => out(res, reviseProposal(req.admin, req.params.id, req.body), (r) => ({ proposal: proposalJson(r.proposal) })));
  app.post('/api/crm/proposals/:id/:action', teamApi('crm.view'), apiLimit, sameOrigin, async (req, res) => out(res, await actOnProposal(req.admin, req.params.id, req.params.action, req.body), (r) => ({ proposal: proposalJson(r.proposal), ...(r.emailed !== undefined ? { emailed: r.emailed } : {}) })));
  app.get('/api/crm/companies', teamApi('crm.view'), apiLimit, (req, res) => res.json({ ok: true, companies: companies(req.admin) }));
  app.get('/api/crm/reports', teamApi('crm.reports'), apiLimit, (req, res) => res.json({ ok: true, report: report(req.admin, req.query) }));

  // Companies: client accounts (no contacts beyond the company) and the leads behind them.
  function companies(user) {
    const L = leads().filter((l) => seesLead(user, l));
    const fromLeads = new Map();
    for (const l of L) if (l.employerId) fromLeads.set(l.employerId, [...(fromLeads.get(l.employerId) || []), l]);
    return clients.read().filter((c) => isManager(user) || fromLeads.has(c.id)).map((c) => ({
      id: c.id, company: c.company, industry: c.industry || '', active: c.active !== false, approved: Boolean(c.approvedAt), since: c.createdAt,
      accountManager: nameOf(c.accountManagerId), leads: (fromLeads.get(c.id) || []).map((l) => ({ id: l.id, status: l.status, source: l.source })),
    })).sort((a, b) => a.company.localeCompare(b.company));
  }

  // ---------- pages ----------
  const crmPage = (req, res, view, locals, status = 200) => res.status(status).render(view, {
    page: 'admin', noindex: true, errors: [], msg: String(req.query.msg || '').slice(0, 300), admin: req.admin, me: req.admin.id,
    roleLabel: (roles.ROLE_INFO[req.admin.role] || {}).label || req.admin.role, can: (a) => roles.can(req.admin, a),
    STAGES, OPEN_STAGES, MOVES, LOST_REASONS, LEAD_STATUSES, LEAD_LABEL, SOURCES, BASES, ACTIVITY_KINDS, ACTIVITY_LABEL, SERVICES, PROPOSAL_LABEL, inr, istText, nameOf,
    people: salesPeople(), today: todayIst(), ...locals,
  });
  const gate = (action) => (req, res, next) => (roles.can(req.admin, action) ? next() : res.status(403).render('thanks', { title: 'Not part of your role', page: '', ok: false, message: 'Your role does not include this part of the sales CRM.', noindex: true }));
  const back = (res, to, r, ok) => res.redirect(303, `${to}${to.includes('?') ? '&' : '?'}msg=${encodeURIComponent(r.errors ? r.errors.join(' ') : ok)}`);
  const safeBack = (v, fallback) => (/^\/admin\/crm(\/[A-Za-z0-9/_-]*)?(\?[A-Za-z0-9=&_-]*)?$/.test(String(v || '')) ? String(v) : fallback);

  function dashboard(user) {
    const now = iso();
    const mine = activities().filter((a) => a.status === 'open' && a.ownerId === user.id).sort((a, b) => String(a.dueAt).localeCompare(String(b.dueAt)));
    return {
      followUps: mine.slice(0, 15), overdue: mine.filter((a) => a.dueAt && a.dueAt < now).length,
      newLeads: searchLeads(user, { status: 'new' }).slice(0, 10),
      unassigned: isManager(user) ? leads().filter((l) => !l.ownerId && !['converted', 'lost', 'unqualified'].includes(l.status)).length : 0,
      conversionRequests: isManager(user) ? opps().filter((o) => o.conversion && o.conversion.status === 'requested') : [],
      toApprove: roles.can(user, 'crm.approve') ? proposals().filter((p) => p.status === 'draft' && latest(p).createdBy !== user.id && p.versions.length) : [],
      report: report(user, {}),
    };
  }
  app.get('/admin/crm', adminAuth, gate('crm.view'), (req, res) => crmPage(req, res, 'admin-crm', { title: 'Sales CRM', section: 'dashboard', d: dashboard(req.admin), leadById }));
  app.get('/admin/crm/leads', adminAuth, gate('crm.view'), (req, res) => crmPage(req, res, 'admin-crm', { title: 'Leads', section: 'leads', q: req.query, rows: searchLeads(req.admin, req.query).slice(0, 300), f: {}, duplicates: null }));
  app.post('/admin/crm/leads', adminAuth, gate('crm.view'), sameOrigin, (req, res) => {
    const f = { ...req.body };
    if (!f.ownerId) delete f.ownerId;
    const r = createLead(req.admin, f);
    if (r.errors) return crmPage(req, res, 'admin-crm', { title: 'Leads', section: 'leads', q: {}, rows: searchLeads(req.admin, {}).slice(0, 300), f: req.body, errors: r.errors, duplicates: r.duplicates || null }, r.status);
    res.redirect(303, `/admin/crm/leads/${r.lead.id}?msg=${encodeURIComponent('Lead added.')}`);
  });
  app.get('/admin/crm/leads/:id', adminAuth, gate('crm.view'), (req, res, next) => {
    const l = leadById(req.params.id);
    if (!seesLead(req.admin, l)) return next();
    refresh();
    crmPage(req, res, 'admin-crm-lead', {
      title: l.companyName, l, os: opps().filter((o) => o.leadId === l.id), acts: listActivities(req.admin, { leadId: l.id }),
      ps: proposals().filter((p) => p.leadId === l.id), duplicates: duplicatesOf(l, l.id, req.admin), matches: matchingClients(l).map(clientMatch), latest,
    });
  });
  app.post('/admin/crm/leads/:id', adminAuth, gate('crm.view'), sameOrigin, (req, res) => {
    const body = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => LEAD_EDITABLE.includes(k)));
    if ('marketingConsent' in req.body || req.body.consentField) body.marketingConsent = truthy(req.body.marketingConsent);
    back(res, `/admin/crm/leads/${req.params.id}`, changeLead(req.admin, req.params.id, body), 'Saved.');
  });
  app.post('/admin/crm/leads/:id/assign', adminAuth, gate('crm.manage'), sameOrigin, (req, res) => back(res, safeBack(req.body.back, `/admin/crm/leads/${req.params.id}`), assignLead(req.admin, req.params.id, { ownerId: req.body.ownerId }), 'Assigned.'));
  app.post('/admin/crm/leads/:id/activities', adminAuth, gate('crm.view'), sameOrigin, (req, res) => {
    const { kind, subject, notes, dueAt, status, outcome, opportunityId } = req.body;
    back(res, `/admin/crm/leads/${req.params.id}`, addActivity(req.admin, { kind, subject, notes, dueAt, status, outcome, ...(opportunityId ? { opportunityId } : {}) }, req.params.id), status === 'done' ? 'Logged.' : 'Follow-up added.');
  });
  app.get('/admin/crm/activities', adminAuth, gate('crm.view'), (req, res) => crmPage(req, res, 'admin-crm', { title: 'Activities', section: 'activities', q: req.query, rows: listActivities(req.admin, { view: req.query.view || 'open' }).slice(0, 300), leadById }));
  app.post('/admin/crm/activities/:id', adminAuth, gate('crm.view'), sameOrigin, (req, res) => {
    const pick = Object.fromEntries(['subject', 'notes', 'dueAt', 'status', 'outcome', 'ownerId'].filter((k) => req.body[k] !== undefined && req.body[k] !== '').map((k) => [k, req.body[k]]));
    back(res, safeBack(req.body.back, '/admin/crm/activities'), changeActivity(req.admin, req.params.id, pick), 'Saved.');
  });
  app.get('/admin/crm/pipeline', adminAuth, gate('crm.view'), (req, res) => crmPage(req, res, 'admin-crm', { title: 'Pipeline', section: 'pipeline', rows: opps().filter((o) => seesOpp(req.admin, o)).map(oppJson) }));
  app.post('/admin/crm/opportunities', adminAuth, gate('crm.view'), sameOrigin, (req, res) => {
    const { leadId, title, estimatedValue, expectedCloseOn, nextAction, nextActionOn } = req.body;
    const services = [].concat(req.body.services || []);
    back(res, `/admin/crm/leads/${String(leadId || '').replace(/[^A-Za-z0-9-]/g, '')}`, createOpp(req.admin, { leadId, title, estimatedValue, expectedCloseOn, nextAction, nextActionOn, services }), 'Opportunity added.');
  });
  app.post('/admin/crm/opportunities/:id', adminAuth, gate('crm.view'), sameOrigin, (req, res) => {
    const o = oppById(req.params.id);
    const { title, estimatedValue, expectedCloseOn, nextAction, nextActionOn } = req.body;
    back(res, o ? `/admin/crm/leads/${o.leadId}` : '/admin/crm/pipeline', changeOpp(req.admin, req.params.id, { title, estimatedValue, expectedCloseOn, nextAction, nextActionOn }), 'Saved.');
  });
  app.post('/admin/crm/opportunities/:id/stage', adminAuth, gate('crm.view'), sameOrigin, (req, res) => {
    const o = oppById(req.params.id);
    back(res, safeBack(req.body.back, o ? `/admin/crm/leads/${o.leadId}` : '/admin/crm/pipeline'), moveStage(req.admin, req.params.id, { stage: req.body.stage, reason: req.body.reason, detail: req.body.detail }), `Moved to ${req.body.stage}.`);
  });
  app.post('/admin/crm/opportunities/:id/convert', adminAuth, gate('crm.view'), sameOrigin, (req, res) => {
    const o = oppById(req.params.id);
    const r = convert(req.admin, req.params.id, req.body, req.body.idempotencyKey);
    const ok = r.status === 202 ? 'Asked a Sales Manager to convert it.' : r.conversion ? `Converted: ${r.conversion.company} is a client${r.conversion.contractId ? ' with a draft contract to send for signature' : ''}. Assign an account manager on the client page.` : 'Done.';
    back(res, o ? `/admin/crm/leads/${o.leadId}` : '/admin/crm/pipeline', r.matches && r.errors ? { errors: [...r.errors, `Matches: ${r.matches.map((m) => m.company).join(', ')}`] } : r, ok);
  });
  app.get('/admin/crm/proposals', adminAuth, gate('crm.view'), (req, res) => { refresh(); crmPage(req, res, 'admin-crm', { title: 'Proposals', section: 'proposals', rows: proposals().filter((p) => seesProposal(req.admin, p)), leadById, latest }); });
  app.get('/admin/crm/proposals/:id', adminAuth, gate('crm.view'), (req, res, next) => {
    refresh();
    const p = proposals().find((x) => x.id === req.params.id);
    if (!seesProposal(req.admin, p)) return next();
    crmPage(req, res, 'admin-crm-proposal', { title: `Proposal ${p.number}`, p, l: leadById(p.leadId), o: oppById(p.opportunityId), v: latest(p), form: versionInput(latest(p)) });
  });
  const proposalBody = (b) => ({ ...Object.fromEntries(['title', 'kind', 'scope', 'feeMode', 'feePercent', 'flatFee', 'guaranteeDays', 'paymentDays', 'markupPercent', 'validUntil', 'estimatedValue', 'internalNotes'].map((k) => [k, b[k] ?? ''])), services: [].concat(b.services || []) });
  app.post('/admin/crm/proposals', adminAuth, gate('crm.view'), sameOrigin, (req, res) => {
    const o = oppById(req.body.opportunityId);
    const r = createProposal(req.admin, { opportunityId: req.body.opportunityId, ...proposalBody(req.body) });
    if (r.errors) return back(res, o ? `/admin/crm/leads/${o.leadId}` : '/admin/crm/proposals', r, '');
    res.redirect(303, `/admin/crm/proposals/${r.proposal.id}?msg=${encodeURIComponent('Draft saved. Someone else approves it before it is sent.')}`);
  });
  app.post('/admin/crm/proposals/:id', adminAuth, gate('crm.view'), sameOrigin, (req, res) => back(res, `/admin/crm/proposals/${req.params.id}`, reviseProposal(req.admin, req.params.id, proposalBody(req.body)), 'New version saved as a draft.'));
  app.post('/admin/crm/proposals/:id/:action', adminAuth, gate('crm.view'), sameOrigin, async (req, res) => {
    const r = await actOnProposal(req.admin, req.params.id, req.params.action, req.body);
    back(res, `/admin/crm/proposals/${req.params.id}`, r, { approve: 'Approved.', send: r.emailed === false ? 'Marked sent, but the email failed: try again later or share it another way.' : 'Sent to the client.', withdraw: 'Withdrawn.', response: 'Answer recorded.' }[req.params.action] || 'Saved.');
  });
  app.get('/admin/crm/companies', adminAuth, gate('crm.view'), (req, res) => crmPage(req, res, 'admin-crm', { title: 'Companies', section: 'companies', rows: companies(req.admin) }));
  app.get('/admin/crm/reports', adminAuth, gate('crm.reports'), (req, res) => crmPage(req, res, 'admin-crm', { title: 'Sales reports', section: 'reports', report: report(req.admin, req.query) }));
  app.get('/admin/crm/import', adminAuth, gate('crm.import'), (req, res) => crmPage(req, res, 'admin-crm', { title: 'Import leads', section: 'import', result: null, f: {} }));
  app.post('/admin/crm/import', adminAuth, gate('crm.import'), limit('crm-import', 10, 10 * 60 * 1000), sameOrigin, (req, res) => {
    const r = importLeads(req.admin, { csv: String(req.body.csv || ''), lawfulBasis: req.body.lawfulBasis, sourceDetail: req.body.sourceDetail, ownerId: req.body.ownerId });
    crmPage(req, res, 'admin-crm', { title: 'Import leads', section: 'import', result: r.errors ? null : r, errors: r.errors || [], f: r.errors ? req.body : {} }, r.errors ? r.status : 200);
  });

  // Short links from the planned /crm/* addresses.
  app.get('/crm', (req, res) => res.redirect('/admin/crm'));
  app.get('/crm/dashboard', (req, res) => res.redirect('/admin/crm'));
  app.get('/crm/leads', (req, res) => res.redirect('/admin/crm/leads'));
  app.get('/crm/leads/:id', (req, res) => res.redirect(`/admin/crm/leads/${encodeURIComponent(req.params.id)}`));
  app.get('/crm/pipeline', (req, res) => res.redirect('/admin/crm/pipeline'));
  app.get('/crm/activities', (req, res) => res.redirect('/admin/crm/activities'));
  app.get('/crm/proposals', (req, res) => res.redirect('/admin/crm/proposals'));
  app.get('/crm/companies', (req, res) => res.redirect('/admin/crm/companies'));
  app.get('/crm/reports', (req, res) => res.redirect('/admin/crm/reports'));

  // ---------- public: the client's proposal page and unsubscribing ----------
  const publicLimit = limit('crm-public', 30);
  const proposalPage = (res, p, locals = {}, status = 200) => {
    const v = p && latest(p);
    res.status(status).render('crm-proposal', { title: p ? `Proposal ${p.number}` : 'Proposal', page: '', noindex: true, errors: [], p, v, done: '', f: {}, ...locals });
  };
  app.get('/crm/proposal/:token', publicLimit, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    const p = proposalByToken(req.params.token);
    if (!p) return res.status(404).render('thanks', { title: 'Link not valid', page: '', ok: false, message: 'This proposal link is no longer valid: it was replaced by a newer version, answered, withdrawn or has expired. Reply to the email you received and we will help.', noindex: true });
    proposalPage(res, p, { token: req.params.token });
  });
  function answer(req, res, decision) {
    res.set('Cache-Control', 'no-store');
    const r = clientAnswer(req, req.params.token, decision);
    if (r.status === 404) return res.status(404).render('thanks', { title: 'Link not valid', page: '', ok: false, message: 'This proposal link is no longer valid.', noindex: true });
    if (r.errors) return proposalPage(res, proposalByToken(req.params.token), { token: req.params.token, errors: r.errors, f: req.body }, r.status);
    res.render('thanks', { title: decision === 'accepted' ? 'Proposal accepted' : 'Answer sent', page: '', ok: true, message: decision === 'accepted' ? 'Thank you. We have recorded your acceptance and will be in touch to set up your client account and agreement.' : 'Thank you for letting us know. We have passed your answer to the team.', noindex: true });
  }
  app.post('/crm/proposal/:token/accept', publicLimit, sameOrigin, (req, res) => answer(req, res, 'accepted'));
  app.post('/crm/proposal/:token/decline', publicLimit, sameOrigin, (req, res) => answer(req, res, 'rejected'));
  app.get('/crm/unsubscribe/:token', publicLimit, (req, res) => {
    const l = leadFromUnsubscribe(req.params.token);
    if (!l) return res.status(404).render('thanks', { title: 'Link not valid', page: '', ok: false, message: 'This link is not valid.', noindex: true });
    res.render('crm-unsubscribe', { title: 'Stop sales emails', page: '', noindex: true, token: req.params.token, done: Boolean(l.unsubscribedAt) });
  });
  // POST works from the page and as a one-click unsubscribe from the mail client.
  app.post('/crm/unsubscribe/:token', publicLimit, (req, res) => {
    const l = unsubscribe(req.params.token);
    if (!l) return res.status(404).render('thanks', { title: 'Link not valid', page: '', ok: false, message: 'This link is not valid.', noindex: true });
    res.render('crm-unsubscribe', { title: 'Stop sales emails', page: '', noindex: true, token: req.params.token, done: true });
  });

  setInterval(() => { try { refresh(); scan(); } catch (e) { console.error('CRM check failed:', e.message); } }, Number(process.env.CRM_SCAN_MS) || 15 * 60 * 1000).unref();
  try { prune(); } catch (e) { console.error('CRM retention failed:', e.message); }
  setInterval(() => { try { prune(); } catch (e) { console.error('CRM retention failed:', e.message); } }, 24 * 3600000).unref();
  return { capture, scan, prune, refresh, report, leads, opportunities: opps, activities, proposals, duplicatesOf };
}

module.exports = { register, STAGES, MOVES, LOST_REASONS, SOURCES, BASES, SERVICES, parseLead, parseProposal, companyKey, phoneKey, domainOf };
