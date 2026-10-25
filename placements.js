// Placements & invoicing: when a candidate is hired, record the joining date,
// CTC and fee, follow the replacement-guarantee period, and bill the client
// with a numbered GST invoice. Placements are their own collection (not part of
// the application), so billing records survive a candidate deleting their data.
const crypto = require('crypto');
const timesheets = require('./timesheets');
const { moveStage } = require('./history');

const STATUSES = ['Awaiting joining', 'Joined', 'Did not join', 'Left in guarantee', 'Contract ended'];
const TYPES = ['Permanent', 'Temporary', 'Contract', 'Contract-to-hire'];
const DAY_MS = 86400000;

// Defaults used until billing details are saved in Admin → Settings.
const BILLING_DEFAULTS = { legalName: '', gstin: '', pan: '', stateName: '', bank: '', feePercent: 8.33, guaranteeDays: 90, gstPercent: 18, paymentDays: 15, tdsPercent: 10 };
const billingOf = (site) => ({ ...BILLING_DEFAULTS, ...(site.billing || {}) });

const round2 = (n) => Math.round(n * 100) / 100;
const inr = (n) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(Number(n) || 0);
const todayIst = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const addDays = (ymd, days) => new Date(Date.parse(`${ymd}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

// Indian financial year (April–March), e.g. "2026-27".
function financialYear(ymd) {
  const [y, m] = ymd.split('-').map(Number);
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

// Amount in words, Indian style (lakh / crore), for the invoice footer.
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
function below1000(n) {
  const h = Math.floor(n / 100);
  const r = n % 100;
  const rest = r < 20 ? ONES[r] : `${TENS[Math.floor(r / 10)]}${r % 10 ? ` ${ONES[r % 10]}` : ''}`;
  return [h ? `${ONES[h]} Hundred` : '', rest].filter(Boolean).join(' ');
}
function toWords(n) {
  if (n === 0) return 'Zero';
  const parts = [];
  for (const [size, name] of [[1e7, 'Crore'], [1e5, 'Lakh'], [1e3, 'Thousand']]) {
    if (n >= size) {
      parts.push(`${toWords(Math.floor(n / size))} ${name}`);
      n %= size;
    }
  }
  if (n) parts.push(below1000(n));
  return parts.join(' ');
}
function amountInWords(amount) {
  const rupees = Math.floor(amount);
  const paise = Math.round((amount - rupees) * 100);
  return `Rupees ${toWords(rupees)}${paise ? ` and ${toWords(paise)} Paise` : ''} Only`;
}

// ----- invoice balance -----
// An invoice is settled by payments (cash received + TDS the client deducted)
// and by credit notes. Status is recalculated from these after every change.
const OPEN = ['Unpaid', 'Part paid'];
const PAY_MODES = ['Bank transfer', 'UPI', 'Cheque', 'Cash', 'Other'];
const CN_REASONS = ['Candidate did not join', 'Candidate left in guarantee period', 'Fee revised', 'Billing error', 'Other'];
const sum = (list, k) => round2((list || []).reduce((n, x) => n + (Number(x[k]) || 0), 0));

function accountOf(inv) {
  const received = sum(inv.payments, 'amount');
  const tds = sum(inv.payments, 'tds');
  const credited = sum(inv.creditNotes, 'total');
  const creditedTaxable = sum(inv.creditNotes, 'subtotal');
  // Money sent back to the client after a credit note (reduces what they've paid).
  const refunded = sum(inv.refunds, 'amount');
  // Invoices marked paid before payments were recorded count as settled.
  const legacyPaid = inv.status === 'Paid' && !(inv.payments || []).length && !(inv.creditNotes || []).length;
  const balance = legacyPaid ? 0 : round2(inv.total - received - tds - credited + refunded);
  return { received, tds, credited, creditedTaxable, refunded, balance: Math.max(balance, 0), refundDue: Math.max(-balance, 0) };
}

function refreshStatus(inv) {
  const a = accountOf(inv);
  const settledByMoney = a.received + a.tds > 0;
  if (a.balance <= 0.01) {
    inv.status = settledByMoney ? 'Paid' : 'Credited';
    const last = (inv.payments || []).map((x) => x.date).sort().pop();
    inv.paidAt = settledByMoney ? last || inv.paidAt || todayIst() : null;
  } else {
    inv.status = settledByMoney || a.credited > 0 ? 'Part paid' : 'Unpaid';
    inv.paidAt = null;
  }
  return inv;
}

// ----- many invoices per placement -----
// A permanent placement has one fee invoice (p.invoice); a monthly contract has
// one invoice per month (p.monthlyInvoices). Every invoice is addressed by its
// key: its id, or "main" for the one-time invoice. Temporary and contract
// workers placed on staffing assignments are billed per assignment period
// (p.staffingInvoices), from drafts the team approves (agency.js).
const invoicesOf = (p) => [p.invoice, ...(p.monthlyInvoices || []), ...(p.staffingInvoices || [])].filter(Boolean);
const invKey = (inv) => inv.id || 'main';
const isOverdue = (inv) => OPEN.includes(inv.status) && inv.dueDate < todayIst();

// ----- monthly contract billing -----
const monthOf = (ymd) => ymd.slice(0, 7);
const daysInMonth = (ym) => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate();
const monthLabel = (ym) => new Date(`${ym}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const nextMonth = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
};

// The slice of a month the contractor was deployed: from joining to contract end.
function monthPeriod(p, ym) {
  const first = `${ym}-01`;
  const last = `${ym}-${String(daysInMonth(ym)).padStart(2, '0')}`;
  const from = p.joiningDate > first ? p.joiningDate : first;
  const to = p.contractEnd && p.contractEnd < last ? p.contractEnd : last;
  return from > to ? null : { month: ym, from, to, days: daysBetween(from, to) + 1, daysInMonth: daysInMonth(ym) };
}

// Months that can still be billed: joining month up to this month (or contract end).
function billableMonths(p) {
  if (p.feeMode !== 'monthly' || !p.joiningDate) return [];
  const billed = new Set((p.monthlyInvoices || []).map((i) => i.period.month));
  const stop = monthOf(p.contractEnd && p.contractEnd < todayIst() ? p.contractEnd : todayIst());
  const out = [];
  for (let ym = monthOf(p.joiningDate); ym <= stop && out.length < 60; ym = nextMonth(ym)) if (!billed.has(ym) && monthPeriod(p, ym)) out.push(ym);
  return out;
}

// Completed months not yet billed (the current month is billed once it ends).
const monthsDue = (p) => (['Joined', 'Contract ended'].includes(p.status) ? billableMonths(p).filter((ym) => ym < monthOf(todayIst())) : []);

// Derived, display-only facts about a placement (never stored).
function describe(p) {
  const today = todayIst();
  const guaranteeEnds = p.joiningDate ? addDays(p.joiningDate, p.guaranteeDays || 0) : '';
  const inv = p.invoice;
  const invoices = invoicesOf(p).map((i) => ({ inv: i, key: invKey(i), acct: accountOf(i), overdue: isOverdue(i) }));
  return {
    ...p,
    guaranteeEnds,
    inGuarantee: !['monthly', 'assignment'].includes(p.feeMode) && p.status === 'Joined' && guaranteeEnds && today <= guaranteeEnds,
    guaranteeDaysLeft: guaranteeEnds ? daysBetween(today, guaranteeEnds) : null,
    acct: inv ? accountOf(inv) : null,
    overdue: Boolean(inv && isOverdue(inv)),
    invoices,
    monthsDue: monthsDue(p),
    timesheetsPending: (p.timesheets || []).filter((t) => t.status === 'Submitted').length,
  };
}

// Invoice totals. Same-state clients pay CGST + SGST (half each); others pay IGST.
function invoiceTotals(fee, gstPercent, taxType) {
  const subtotal = round2(fee);
  const gst = round2((subtotal * gstPercent) / 100);
  const lines = !gstPercent ? [] : taxType === 'intra'
    ? [{ label: `CGST @ ${gstPercent / 2}%`, amount: round2(gst / 2) }, { label: `SGST @ ${gstPercent / 2}%`, amount: round2(gst - round2(gst / 2)) }]
    : [{ label: `IGST @ ${gstPercent}%`, amount: gst }];
  return { subtotal, gst, taxLines: lines, total: round2(subtotal + gst) };
}

function parsePlacement(body) {
  const get = (k, max = 300) => String(body[k] ?? '').trim().slice(0, max);
  const num = (k) => {
    const raw = get(k, 20).replace(/[,₹\s]/g, '');
    return raw === '' ? NaN : Number(raw);
  };
  const f = {
    type: get('type', 30),
    company: get('company', 160),
    employerId: get('employerId', 60),
    billingName: get('billingName', 160),
    billingAddress: get('billingAddress', 400),
    clientGstin: get('clientGstin', 15).toUpperCase(),
    taxType: get('taxType', 5) === 'intra' ? 'intra' : 'inter',
    joiningDate: get('joiningDate', 10),
    ctc: num('ctc'),
    feeMode: ['flat', 'free', 'monthly', 'assignment'].includes(get('feeMode', 10)) ? get('feeMode', 10) : 'percent',
    monthlyRate: num('monthlyRate'),
    contractEnd: get('contractEnd', 10),
    feePercent: num('feePercent'),
    flatFee: num('flatFee'),
    guaranteeDays: num('guaranteeDays'),
    status: get('status', 30),
    notes: get('notes', 1000),
  };
  const errors = [];
  if (!TYPES.includes(f.type)) errors.push('placement type is invalid');
  if (!f.company) errors.push('client company is required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.joiningDate) || Number.isNaN(Date.parse(f.joiningDate))) errors.push('joining date is required');
  if (!STATUSES.includes(f.status)) errors.push('status is invalid');
  if (f.clientGstin && !/^\d{2}[A-Z0-9]{13}$/.test(f.clientGstin)) errors.push("client GSTIN should be 15 characters (e.g. 29ABCDE1234F1Z5)");
  if (!Number.isInteger(f.guaranteeDays) || f.guaranteeDays < 0 || f.guaranteeDays > 365) errors.push('guarantee must be 0–365 days');
  let fee = 0;
  if (f.feeMode === 'percent') {
    if (!(f.ctc > 0)) errors.push('annual CTC is required for a % fee');
    if (!(f.feePercent > 0 && f.feePercent <= 100)) errors.push('fee % must be between 0 and 100');
    if (!errors.length) fee = round2((f.ctc * f.feePercent) / 100);
  } else if (f.feeMode === 'flat') {
    if (!(f.flatFee > 0)) errors.push('enter the fee amount');
    else fee = round2(f.flatFee);
    if (Number.isNaN(f.ctc)) f.ctc = 0;
  } else if (f.feeMode === 'monthly') {
    // Contract staffing: the client is billed every month at this rate.
    if (f.type === 'Permanent') errors.push('monthly billing is for contract placements');
    if (!(f.monthlyRate > 0)) errors.push('enter the monthly bill rate');
    if (Number.isNaN(f.ctc)) f.ctc = 0;
  } else if (f.feeMode === 'assignment') {
    // Temporary and contract staffing billed from each assignment's rates.
    if (f.type === 'Permanent') errors.push('billing per staffing assignment is for temporary and contract placements');
    if (Number.isNaN(f.ctc)) f.ctc = 0;
  } else if (Number.isNaN(f.ctc)) {
    // Free replacement under the original placement's guarantee: no fee, no invoice.
    f.ctc = 0;
  }
  if (f.contractEnd && (!/^\d{4}-\d{2}-\d{2}$/.test(f.contractEnd) || Number.isNaN(Date.parse(f.contractEnd)))) errors.push('contract end date is invalid');
  else if (f.contractEnd && f.joiningDate && f.contractEnd < f.joiningDate) errors.push('contract end is before the joining date');
  if (f.ctc < 0) errors.push('CTC cannot be negative');
  if (!f.billingName) f.billingName = f.company;
  // Blank or invalid numbers are shown back as empty fields, not "NaN".
  const numbers = { ctc: f.ctc, feePercent: f.feePercent, guaranteeDays: f.guaranteeDays, monthlyRate: f.monthlyRate };
  for (const k of ['ctc', 'feePercent', 'flatFee', 'guaranteeDays', 'monthlyRate']) if (Number.isNaN(f[k])) f[k] = '';
  return {
    errors,
    f,
    data: {
      type: f.type, company: f.company, billingName: f.billingName, billingAddress: f.billingAddress, clientGstin: f.clientGstin, taxType: f.taxType,
      joiningDate: f.joiningDate, ctc: numbers.ctc || 0, feeMode: f.feeMode, feePercent: f.feeMode === 'percent' ? numbers.feePercent : null, fee,
      guaranteeDays: numbers.guaranteeDays, status: f.status, notes: f.notes,
      monthlyRate: f.feeMode === 'monthly' ? round2(numbers.monthlyRate) : null, contractEnd: f.contractEnd || null,
    },
  };
}

// Amounts typed as "1,50,000" or "₹1,50,000"; blank is 0.
const moneyIn = (v) => {
  const raw = String(v ?? '').replace(/[,₹\s]/g, '');
  return raw === '' ? 0 : Number(raw);
};

function register(app, deps) {
  const { db, site, mailer, baseUrl, adminAuth, requireAdmin, requireBilling, sameOrigin, adminUrl, readSubmissions, writeSubmissions, getJobs, clients, requireEmployer } = deps;
  const read = () => db.all('placements');
  const write = (list) => db.replaceAll('placements', list);
  // Filled in by agency.js: the requisition and contract a placement belongs to.
  const hooks = deps.hooks || {};
  const clientById = (id) => clients.read().find((c) => c.id === id);

  // Numbers never repeat, even when an invoice is cancelled: INV/2026-27/0001.
  // Credit notes have their own series: CN/2026-27/0001.
  function nextNumber(prefix, date) {
    const fy = financialYear(date);
    const key = `${prefix === 'INV' ? 'invoice' : 'credit'}-seq:${fy}`;
    const n = Number(db.metaGet(key) || 0) + 1;
    db.metaSet(key, n);
    return `${prefix}/${fy}/${String(n).padStart(4, '0')}`;
  }
  const nextInvoiceNumber = (date) => nextNumber('INV', date);

  const formPage = (res, locals, status = 200) =>
    res.status(status).render('admin-placement', {
      title: locals.p.id ? 'Edit placement' : 'Record placement', page: 'admin', noindex: true, errors: [],
      types: TYPES, statuses: STATUSES, clientOptions: clients.read(), billing: billingOf(site), inr, replaces: null, ...locals,
    });

  // ----- record a placement from an application -----
  app.get('/admin/applications/:id/placement', adminAuth, (req, res, next) => {
    const a = readSubmissions('applications').find((x) => x.id === req.params.id);
    if (!a) return next();
    const existing = read().find((p) => p.appId === a.id);
    if (existing) return res.redirect(`/admin/placements/${existing.id}/edit`);
    const job = getJobs().find((j) => j.id === a.jobId);
    const employerId = (job && job.employerId) || (a.shared && a.shared.employerId) || '';
    const client = clientById(employerId);
    const b = billingOf(site);
    const orig = replaceable(String(req.query.replaces || ''));
    if (orig) {
      // A replacement keeps the original client, billing details and guarantee, free of charge.
      const { company, employerId: origClient, billingName, billingAddress, clientGstin, taxType, type, guaranteeDays } = orig;
      return formPage(res, {
        a, replaces: orig,
        p: { type, company, employerId: origClient, billingName, billingAddress, clientGstin, taxType, joiningDate: todayIst(), ctc: '', feeMode: 'free', feePercent: b.feePercent, flatFee: '', guaranteeDays, status: 'Awaiting joining', notes: `Replacement for ${orig.candidateName}` },
      });
    }
    // Terms come from the client's active contract when the job belongs to a requisition under one, else from Settings.
    const terms = hooks.termsFor ? hooks.termsFor(a) : null;
    formPage(res, {
      a, terms,
      p: {
        type: terms && terms.type ? terms.type : job && job.type === 'Contract' ? 'Contract' : 'Permanent', company: client ? client.company : (job ? job.company : ''), employerId: client ? client.id : '',
        billingName: '', billingAddress: '', clientGstin: '', taxType: 'intra', joiningDate: todayIst(), ctc: '', feeMode: terms && terms.feeMode ? terms.feeMode : 'percent',
        feePercent: terms && terms.feePercent !== undefined ? terms.feePercent : b.feePercent, flatFee: terms && terms.flatFee ? terms.flatFee : '',
        guaranteeDays: terms && terms.guaranteeDays !== undefined ? terms.guaranteeDays : b.guaranteeDays, status: 'Awaiting joining', notes: '',
      },
    });
  });

  app.post('/admin/applications/:id/placement', adminAuth, sameOrigin, (req, res, next) => {
    const apps = readSubmissions('applications');
    const a = apps.find((x) => x.id === req.params.id);
    if (!a) return next();
    const list = read();
    if (list.some((p) => p.appId === a.id)) return res.redirect(adminUrl('placements', `${a.name} already has a placement`));
    const { errors, f, data } = parsePlacement(req.body);
    const employerId = clientById(f.employerId) ? f.employerId : '';
    const orig = req.body.replaces ? list.find((x) => x.id === String(req.body.replaces) && isReplaceable(x)) : null;
    if (req.body.replaces && !orig) errors.push('the original placement already has a replacement');
    if (data.feeMode === 'free' && !orig) errors.push('only a replacement can be free of charge');
    if (errors.length) return formPage(res, { a, replaces: orig, p: { ...f, employerId }, errors }, 400);
    const now = new Date().toISOString();
    const link = hooks.linkFor ? hooks.linkFor(a, employerId) : {};
    const placement = {
      id: crypto.randomUUID(), appId: a.id, candidateName: a.name, candidateEmail: a.email, jobId: a.jobId, jobTitle: a.jobTitle,
      employerId, ...data, replacementFor: orig ? orig.id : null, invoice: null, cancelledInvoices: [], createdAt: now, updatedAt: now,
      requisitionId: link.requisitionId || null, contractId: link.contractId || null, recruiterId: link.recruiterId || req.admin.id,
    };
    if (orig) Object.assign(orig, { replacedBy: placement.id, updatedAt: now });
    list.unshift(placement);
    write(list);
    // A recorded placement means the offer was accepted.
    if (a.status !== 'Hired') {
      moveStage(a, 'Hired', `${req.admin.name} (placement recorded)`, now);
      writeSubmissions('applications', apps);
    }
    if (hooks.placed) hooks.placed(placement, req.admin);
    res.redirect(adminUrl('placements', orig ? `${a.name} recorded as the replacement for ${orig.candidateName} at ${data.company}` : `Placement recorded for ${a.name} at ${data.company} · fee ${inr(data.fee)}`));
  });

  // ----- edit -----
  const findPlacement = (id) => {
    const list = read();
    return { list, p: list.find((x) => x.id === id) };
  };
  // A placement that fell through and hasn't been replaced yet.
  const isReplaceable = (p) => ['Left in guarantee', 'Did not join'].includes(p.status) && !p.replacedBy;
  const replaceable = (id) => {
    const p = read().find((x) => x.id === id);
    return p && isReplaceable(p) ? p : null;
  };

  app.get('/admin/placements/:id/edit', adminAuth, (req, res, next) => {
    const { p } = findPlacement(req.params.id);
    if (!p) return next();
    const replaces = p.replacementFor ? read().find((x) => x.id === p.replacementFor) : null;
    formPage(res, { a: { name: p.candidateName, email: p.candidateEmail, jobTitle: p.jobTitle }, replaces, p: { ...p, flatFee: p.feeMode === 'flat' ? p.fee : '' } });
  });

  app.post('/admin/placements/:id', adminAuth, sameOrigin, (req, res, next) => {
    const { list, p } = findPlacement(req.params.id);
    if (!p) return next();
    const { errors, f, data } = parsePlacement(req.body);
    const employerId = clientById(f.employerId) ? f.employerId : '';
    if (data.feeMode === 'free' && !p.replacementFor) errors.push('only a replacement can be free of charge');
    if (data.feeMode === 'free' && p.invoice) errors.push('this placement has an invoice; issue a credit note instead of making it free');
    if (data.feeMode === 'monthly' && p.invoice) errors.push('this placement already has a one-time fee invoice');
    if (data.feeMode !== 'monthly' && (p.monthlyInvoices || []).length) errors.push('this placement has monthly invoices, so it must stay on monthly billing');
    if (data.feeMode !== 'assignment' && (p.staffingInvoices || []).length) errors.push('this placement has staffing invoices, so it must stay billed per assignment');
    if (data.feeMode === 'assignment' && p.invoice) errors.push('this placement already has a one-time fee invoice');
    const replaces = p.replacementFor ? list.find((x) => x.id === p.replacementFor) : null;
    if (errors.length) return formPage(res, { a: { name: p.candidateName, email: p.candidateEmail, jobTitle: p.jobTitle }, replaces, p: { ...f, id: p.id, employerId, invoice: p.invoice }, errors }, 400);
    Object.assign(p, data, { employerId, updatedAt: new Date().toISOString() });
    write(list);
    const note = p.invoice && p.invoice.status !== 'Cancelled' && p.invoice.subtotal !== p.fee ? ' · the issued invoice keeps its original amount; cancel and reissue it to bill the new fee' : '';
    res.redirect(adminUrl('placements', `Saved placement for ${p.candidateName}${note}`));
  });

  app.post('/admin/placements/:id/status', adminAuth, sameOrigin, (req, res, next) => {
    const { list, p } = findPlacement(req.params.id);
    if (!p) return next();
    const status = String(req.body.status || '');
    if (!STATUSES.includes(status)) return res.status(400).send('Invalid status');
    p.status = status;
    p.updatedAt = new Date().toISOString();
    write(list);
    const fellThrough = ['Did not join', 'Left in guarantee'].includes(status);
    const hint = !fellThrough ? ''
      : p.invoice && p.invoice.status !== 'Credited' ? ` · invoice ${p.invoice.number} is still on the books: issue a credit note from Payments if the fee is waived or refunded, or keep it if a replacement is due`
      : ' · check the client agreement for a replacement or refund';
    res.redirect(adminUrl('placements', `${p.candidateName}: ${status}${hint}`));
  });

  // Issued invoices are tax records, so a placement with one can't be deleted.
  app.post('/admin/placements/:id/delete', adminAuth, requireAdmin, sameOrigin, (req, res, next) => {
    const { list, p } = findPlacement(req.params.id);
    if (!p) return next();
    if (invoicesOf(p).length || (p.cancelledInvoices || []).length) return res.redirect(adminUrl('placements', "Placements with an invoice can't be deleted (invoices are tax records)"));
    for (const x of list) if (x.replacedBy === p.id) x.replacedBy = null;
    write(list.filter((x) => x !== p));
    res.redirect(adminUrl('placements', `Deleted the placement for ${p.candidateName}`));
  });

  // ----- invoices -----
  // Snapshot everything an invoice shows, so later edits never change an issued invoice.
  function newInvoice(p, subtotal, extra) {
    const b = billingOf(site);
    const date = todayIst();
    return {
      number: nextInvoiceNumber(date), date, dueDate: addDays(date, b.paymentDays), gstPercent: b.gstPercent, taxType: p.taxType,
      ...invoiceTotals(subtotal, b.gstPercent, p.taxType),
      seller: { name: b.legalName || site.name, address: site.address, gstin: b.gstin, pan: b.pan, stateName: b.stateName, bank: b.bank, email: site.email, phone: site.phone },
      buyer: { name: p.billingName || p.company, address: p.billingAddress, gstin: p.clientGstin },
      // SAC codes: 998512 permanent placement, 998513 contract staffing.
      sac: p.type === 'Contract' || p.type === 'Temporary' || ['monthly', 'assignment'].includes(p.feeMode) ? '998513' : '998512',
      status: 'Unpaid', paidAt: null, sentAt: null, payments: [], creditNotes: [],
      ...extra,
    };
  }
  const invoiceLink = (p, inv) => `${baseUrl}/employer/invoices/${p.id}${inv.id ? `?inv=${inv.id}` : ''}`;

  // The one-time fee invoice, from this page or from an approved draft.
  function issueFee(id, { email = false } = {}) {
    const { list, p } = findPlacement(id);
    if (!p) return { error: 'placement not found', status: 404 };
    if (p.invoice) return { error: `invoice ${p.invoice.number} is already issued`, status: 409, p };
    if (['monthly', 'assignment'].includes(p.feeMode)) return { error: 'this placement is billed by month or by assignment, not with a one-time fee', status: 409, p };
    if (!(p.fee > 0)) return { error: 'set a fee on the placement before invoicing', status: 409, p };
    p.invoice = newInvoice(p, p.fee, {
      item: `Recruitment fee – ${p.jobTitle} (${p.candidateName}), joined ${formatYmd(p.joiningDate)}${p.feeMode === 'percent' ? ` · ${p.feePercent}% of annual CTC ${inr(p.ctc)}` : ''}`,
    });
    const client = clientById(p.employerId);
    const emailed = email && client && client.active;
    if (emailed) {
      p.invoice.sentAt = new Date().toISOString();
      mailer.invoiceIssued(client, p.invoice, invoiceLink(p, p.invoice));
    }
    write(list);
    return { p, inv: p.invoice, emailedTo: emailed ? client.email : '' };
  }
  // An invoice for one staffing assignment period (amounts in rupees, already exact to the paisa).
  function issueStaffing(id, { subtotal, lines, period, assignmentId, email = false }) {
    const { list, p } = findPlacement(id);
    if (!p) return { error: 'placement not found', status: 404 };
    if (p.feeMode !== 'assignment') return { error: 'this placement is not billed per staffing assignment', status: 409, p };
    if (!(subtotal > 0)) return { error: 'the invoice total must be more than zero', status: 400, p };
    const inv = newInvoice(p, subtotal, { id: crypto.randomUUID(), period, assignmentId, lines, item: lines[0].text });
    p.staffingInvoices = [...(p.staffingInvoices || []), inv];
    const client = clientById(p.employerId);
    const emailed = email && client && client.active;
    if (emailed) {
      inv.sentAt = new Date().toISOString();
      mailer.invoiceIssued(client, inv, invoiceLink(p, inv));
    }
    write(list);
    return { p, inv, emailedTo: emailed ? client.email : '' };
  }

  app.post('/admin/placements/:id/invoice', adminAuth, requireBilling, sameOrigin, (req, res, next) => {
    const { p } = findPlacement(req.params.id);
    if (!p) return next();
    if (p.feeMode === 'monthly' && !p.invoice) return res.redirect(`/admin/placements/${p.id}/bill`);
    if (p.feeMode === 'assignment' && !p.invoice) return res.redirect(adminUrl('placements', 'This placement is billed from its staffing assignments: approve a draft under Invoice drafts'));
    const r = issueFee(p.id, { email: req.body.email === '1' });
    if (r.error) return res.redirect(adminUrl('placements', r.error.charAt(0).toUpperCase() + r.error.slice(1)));
    res.redirect(adminUrl('placements', `Invoice ${r.inv.number} issued for ${inr(r.inv.total)}${r.emailedTo ? ` · emailed to ${r.emailedTo}` : ''}`));
  });

  // ----- monthly contract invoices -----
  // Weekdays (Mon–Fri) inside a deployed period.
  const weekdaysIn = (period) => {
    let n = 0;
    for (let d = period.from; d <= period.to; d = addDays(d, 1)) if (![0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay())) n++;
    return n;
  };

  // With timesheets, a month is billed on working days (approved days out of the
  // month's Mon–Fri); without them, on calendar days deployed.
  function billPage(res, p, ym, extra = {}, status = 200) {
    const months = billableMonths(p);
    const month = months.includes(ym) ? ym : months.find((m) => m < monthOf(todayIst())) || months[0] || '';
    const period = month ? monthPeriod(p, month) : null;
    const ts = month ? timesheets.monthSummary(p, month) : null;
    const hasTs = Boolean(ts && (ts.approvedWeeks || ts.pendingWeeks));
    const basis = extra.basis || (hasTs ? 'working' : 'calendar');
    const pending = (p.timesheets || []).filter((t) => t.status === 'Submitted' && Object.keys(t.days || {}).some((d) => d.startsWith(month)));
    const defaultDays = !period ? '' : hasTs ? ts.approvedDays : basis === 'working' ? weekdaysIn(period) : period.days;
    res.status(status).render('admin-bill-month', {
      title: `Bill a month · ${p.candidateName}`, page: 'admin', noindex: true, p, months, month, period, monthLabel, inr, formatYmd,
      portalClient: clientById(p.employerId), gstPercent: billingOf(site).gstPercent, errors: [], msg: '',
      ts, hasTs, basis, workingDays: month ? timesheets.workingDaysInMonth(month) : 0, weekdaysDeployed: period ? weekdaysIn(period) : 0,
      pending, weekLabel: timesheets.weekLabel, daysOf: timesheets.daysOf,
      f: { days: defaultDays, adjustment: '', adjustmentNote: '' },
      ...extra,
    });
  }

  app.get('/admin/placements/:id/bill', adminAuth, requireBilling, (req, res, next) => {
    const { p } = findPlacement(req.params.id);
    if (!p || p.feeMode !== 'monthly') return next();
    billPage(res, p, String(req.query.month || ''), { msg: String(req.query.msg || '') });
  });

  app.post('/admin/placements/:id/bill', adminAuth, requireBilling, sameOrigin, (req, res, next) => {
    const { list, p } = findPlacement(req.params.id);
    if (!p || p.feeMode !== 'monthly') return next();
    const month = String(req.body.month || '');
    const f = { days: String(req.body.days ?? '').trim(), adjustment: String(req.body.adjustment ?? '').trim(), adjustmentNote: String(req.body.adjustmentNote || '').trim().slice(0, 120) };
    const period = billableMonths(p).includes(month) ? monthPeriod(p, month) : null;
    const basis = req.body.basis === 'working' ? 'working' : 'calendar';
    const basisDays = period ? (basis === 'working' ? timesheets.workingDaysInMonth(month) : period.daysInMonth) : 0;
    const days = Number(f.days);
    const adjustment = f.adjustment === '' ? 0 : moneyIn(f.adjustment);
    const errors = [];
    if (!period) errors.push('that month is already billed or outside the contract');
    else if (!Number.isFinite(days) || days < 0 || days > period.daysInMonth || Math.round(days * 2) !== days * 2) errors.push(`billable days must be between 0 and ${period.daysInMonth} (half days allowed)`);
    if (!Number.isFinite(adjustment)) errors.push('adjustment must be a number (use a minus sign for deductions)');
    if (adjustment && !f.adjustmentNote) errors.push('describe the adjustment (e.g. overtime, unpaid leave)');
    const base = period && Number.isFinite(days) ? round2((p.monthlyRate * days) / basisDays) : 0;
    const subtotal = round2(base + (Number.isFinite(adjustment) ? adjustment : 0));
    if (!errors.length && !(subtotal > 0)) errors.push('the invoice total must be more than zero');
    if (errors.length) return billPage(res, p, month, { errors, f, basis }, 400);
    const lines = [{ text: `Contract staffing – ${p.candidateName} as ${p.jobTitle}, ${monthLabel(month)} (${formatYmd(period.from)} – ${formatYmd(period.to)}): ${days} of ${basisDays} ${basis === 'working' ? 'working days' : 'days'} at ${inr(p.monthlyRate)}/month`, amount: base }];
    if (adjustment) lines.push({ text: f.adjustmentNote, amount: round2(adjustment) });
    const inv = newInvoice(p, subtotal, { id: crypto.randomUUID(), period: { ...period, billedDays: days, basis, basisDays }, lines, item: lines[0].text });
    p.monthlyInvoices = [...(p.monthlyInvoices || []), inv];
    const client = clientById(p.employerId);
    const emailed = req.body.email === '1' && client && client.active;
    if (emailed) {
      inv.sentAt = new Date().toISOString();
      mailer.invoiceIssued(client, inv, invoiceLink(p, inv));
    }
    write(list);
    res.redirect(adminUrl('placements', `Invoice ${inv.number} for ${monthLabel(month)} issued for ${inr(inv.total)}${emailed ? ` · emailed to ${client.email}` : ''}`));
  });

  // Every invoice action names its invoice with ?inv= (or a hidden "inv" field);
  // without it, the one-time fee invoice is meant.
  const keyFrom = (req) => String(req.query.inv || req.body.inv || 'main');
  const pickInvoice = (p, key) => (p ? invoicesOf(p).find((i) => invKey(i) === key) || null : null);

  // Cancelling keeps the number on record (no gaps are reused) and lets you reissue.
  // Once money or a credit note is recorded, use a credit note instead (GST rules).
  app.post('/admin/placements/:id/invoice/cancel', adminAuth, requireBilling, sameOrigin, (req, res, next) => {
    const { list, p } = findPlacement(req.params.id);
    const current = pickInvoice(p, keyFrom(req));
    if (!current) return next();
    if ((current.payments || []).length || (current.creditNotes || []).length || current.status === 'Paid') {
      return res.redirect(adminUrl('placements', `Invoice ${current.number} has payments or credit notes, so it can't be cancelled. Issue a credit note instead.`));
    }
    const inv = { ...current, status: 'Cancelled', cancelledAt: todayIst() };
    p.cancelledInvoices = [...(p.cancelledInvoices || []), inv];
    if (current === p.invoice) p.invoice = null;
    else if ((p.staffingInvoices || []).includes(current)) p.staffingInvoices = p.staffingInvoices.filter((i) => i !== current);
    else p.monthlyInvoices = p.monthlyInvoices.filter((i) => i !== current);
    write(list);
    res.redirect(adminUrl('placements', `Invoice ${inv.number} cancelled. You can issue a new one.`));
  });

  // ----- payments & credit notes -----
  const paymentsUrl = (p, inv, msg) => `/admin/placements/${p.id}/payments?inv=${invKey(inv)}${msg ? `&msg=${encodeURIComponent(msg)}` : ''}`;

  function paymentsPage(res, p, inv, extra = {}, status = 200) {
    const acct = accountOf(inv);
    const b = billingOf(site);
    // Suggest the usual split: TDS on the taxable value, the rest in cash.
    const tds = Math.min(round2((inv.subtotal * b.tdsPercent) / 100), acct.balance);
    res.status(status).render('admin-payments', {
      title: `Payments · ${inv.number}`, page: 'admin', noindex: true, p, inv, key: invKey(inv), acct, inr, formatYmd, modes: PAY_MODES, reasons: CN_REASONS,
      tdsPercent: b.tdsPercent, errors: [], msg: '', portalClient: clientById(p.employerId),
      pay: { date: todayIst(), amount: round2(acct.balance - tds) || '', tds: tds || '', mode: 'Bank transfer', reference: '' },
      cn: { amount: round2(inv.subtotal - acct.creditedTaxable) || '', reason: CN_REASONS[0], note: '' },
      refund: { date: todayIst(), amount: acct.refundDue || '', mode: 'Bank transfer', reference: '' },
      ...extra,
    });
  }

  app.get('/admin/placements/:id/payments', adminAuth, requireBilling, (req, res, next) => {
    const { p } = findPlacement(req.params.id);
    const inv = pickInvoice(p, keyFrom(req));
    if (!inv) return next();
    paymentsPage(res, p, inv, { msg: String(req.query.msg || '') });
  });

  app.post('/admin/placements/:id/payments', adminAuth, requireBilling, sameOrigin, (req, res, next) => {
    const { list, p } = findPlacement(req.params.id);
    const inv = pickInvoice(p, keyFrom(req));
    if (!inv) return next();
    const get = (k, max) => String(req.body[k] ?? '').trim().slice(0, max);
    const pay = { date: get('date', 10), amount: moneyIn(req.body.amount), tds: moneyIn(req.body.tds), mode: get('mode', 20), reference: get('reference', 120) };
    const errors = [];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(pay.date) || Number.isNaN(Date.parse(pay.date))) errors.push('payment date is required');
    else if (pay.date > todayIst()) errors.push("payment date can't be in the future");
    else if (pay.date < inv.date) errors.push('payment date is before the invoice date');
    if (!Number.isFinite(pay.amount) || pay.amount < 0) errors.push('amount received must be a number');
    if (!Number.isFinite(pay.tds) || pay.tds < 0) errors.push('TDS must be a number');
    if (!PAY_MODES.includes(pay.mode)) errors.push('payment mode is invalid');
    const settles = round2((pay.amount || 0) + (pay.tds || 0));
    if (!errors.length && settles <= 0) errors.push('enter the amount received and/or TDS deducted');
    if (!errors.length && settles > accountOf(inv).balance + 0.01) errors.push(`that is more than the balance of ${inr(accountOf(inv).balance)}`);
    if (errors.length) return paymentsPage(res, p, inv, { errors, pay: { ...pay, amount: req.body.amount, tds: req.body.tds } }, 400);
    inv.payments = [...(inv.payments || []), { id: crypto.randomUUID(), ...pay, amount: round2(pay.amount), tds: round2(pay.tds), recordedAt: new Date().toISOString() }];
    refreshStatus(inv);
    write(list);
    res.redirect(paymentsUrl(p, inv, `Recorded ${inr(pay.amount)}${pay.tds ? ` + ${inr(pay.tds)} TDS` : ''} · invoice is ${inv.status.toLowerCase()}`));
  });

  app.post('/admin/placements/:id/payments/:payId/delete', adminAuth, requireBilling, sameOrigin, (req, res, next) => {
    const { list, p } = findPlacement(req.params.id);
    const inv = p && invoicesOf(p).find((i) => (i.payments || []).some((x) => x.id === req.params.payId));
    if (!inv) return next();
    inv.payments = inv.payments.filter((x) => x.id !== req.params.payId);
    refreshStatus(inv);
    write(list);
    res.redirect(paymentsUrl(p, inv, `Payment removed · invoice is ${inv.status.toLowerCase()}`));
  });

  // ----- replacements -----
  // Pick who replaces a candidate who didn't join or left in the guarantee period:
  // applicants to the same job first, then anyone else in the pipeline.
  app.get('/admin/placements/:id/replacement', adminAuth, (req, res, next) => {
    const orig = replaceable(req.params.id);
    if (!orig) return next();
    const placed = new Set(read().map((x) => x.appId));
    const pool = readSubmissions('applications').filter((a) => !placed.has(a.id) && a.status !== 'Rejected' && !a.withdrawnAt);
    res.render('admin-replacement', {
      title: 'Choose a replacement', page: 'admin', noindex: true, orig, formatYmd,
      sameJob: pool.filter((a) => a.jobId === orig.jobId), others: pool.filter((a) => a.jobId !== orig.jobId).slice(0, 40),
    });
  });

  // ----- refunds -----
  app.post('/admin/placements/:id/refunds', adminAuth, requireBilling, sameOrigin, (req, res, next) => {
    const { list, p } = findPlacement(req.params.id);
    const inv = pickInvoice(p, keyFrom(req));
    if (!inv) return next();
    const get = (k, max) => String(req.body[k] ?? '').trim().slice(0, max);
    const refund = { date: get('date', 10), amount: moneyIn(req.body.amount), mode: get('mode', 20), reference: get('reference', 120) };
    const due = accountOf(inv).refundDue;
    const errors = [];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(refund.date) || Number.isNaN(Date.parse(refund.date))) errors.push('refund date is required');
    else if (refund.date > todayIst()) errors.push("refund date can't be in the future");
    if (!(refund.amount > 0)) errors.push('enter the amount refunded');
    else if (refund.amount > due + 0.01) errors.push(`only ${inr(due)} is due as a refund`);
    if (!PAY_MODES.includes(refund.mode)) errors.push('refund mode is invalid');
    if (errors.length) return paymentsPage(res, p, inv, { errors, refund: { ...refund, amount: req.body.amount } }, 400);
    inv.refunds = [...(inv.refunds || []), { id: crypto.randomUUID(), ...refund, amount: round2(refund.amount), recordedAt: new Date().toISOString() }];
    refreshStatus(inv);
    write(list);
    res.redirect(paymentsUrl(p, inv, `Refund of ${inr(refund.amount)} recorded`));
  });

  app.post('/admin/placements/:id/refunds/:refundId/delete', adminAuth, requireBilling, sameOrigin, (req, res, next) => {
    const { list, p } = findPlacement(req.params.id);
    const inv = p && invoicesOf(p).find((i) => (i.refunds || []).some((x) => x.id === req.params.refundId));
    if (!inv) return next();
    inv.refunds = inv.refunds.filter((x) => x.id !== req.params.refundId);
    refreshStatus(inv);
    write(list);
    res.redirect(paymentsUrl(p, inv, 'Refund entry removed'));
  });

  // ----- payment reminders -----
  // Reminders go to the client's portal contact, who can open the invoice there.
  const REMINDER_GAP_DAYS = 7;
  const MAX_AUTO_REMINDERS = 4;
  function sendReminder(p, inv, auto) {
    const client = clientById(p.employerId);
    if (!client || !client.active || !OPEN.includes(inv.status)) return false;
    const daysOverdue = Math.max(daysBetween(inv.dueDate, todayIst()), 0);
    mailer.invoiceReminder(client, inv, accountOf(inv).balance, daysOverdue, invoiceLink(p, inv));
    inv.reminders = [...(inv.reminders || []), { at: new Date().toISOString(), auto }];
    return true;
  }

  app.post('/admin/placements/:id/remind', adminAuth, requireBilling, sameOrigin, (req, res, next) => {
    const { list, p } = findPlacement(req.params.id);
    const inv = pickInvoice(p, keyFrom(req));
    if (!inv) return next();
    const back = req.body.from === 'payments' ? (m) => paymentsUrl(p, inv, m) : (m) => adminUrl('placements', m);
    if (!sendReminder(p, inv, false)) return res.redirect(back('Reminders need an open invoice and an active client-portal account'));
    write(list);
    res.redirect(back(`Payment reminder for ${inv.number} emailed to ${clientById(p.employerId).email}`));
  });

  // Automatic reminders (Settings → Billing): at most one a week per overdue
  // invoice, and no more than four in total.
  function autoRemind() {
    if (!billingOf(site).autoReminders) return 0;
    const list = read();
    const cutoff = Date.now() - REMINDER_GAP_DAYS * DAY_MS;
    let sent = 0;
    for (const p of list) {
      for (const inv of invoicesOf(p)) {
        if (!isOverdue(inv)) continue;
        const reminders = inv.reminders || [];
        if (reminders.filter((r) => r.auto).length >= MAX_AUTO_REMINDERS) continue;
        if (reminders.some((r) => Date.parse(r.at) > cutoff)) continue;
        if (sendReminder(p, inv, true)) sent++;
      }
    }
    if (sent) write(list);
    return sent;
  }
  setInterval(autoRemind, 60 * 60 * 1000).unref();
  setTimeout(autoRemind, 30 * 1000).unref();

  // A credit note reduces what the client owes (or creates a refund if they've paid).
  // It carries GST at the invoice's rate and split, and its own number series.
  app.post('/admin/placements/:id/credit-notes', adminAuth, requireBilling, sameOrigin, (req, res, next) => {
    const { list, p } = findPlacement(req.params.id);
    const inv = pickInvoice(p, keyFrom(req));
    if (!inv) return next();
    const amount = moneyIn(req.body.amount);
    const reason = String(req.body.reason || '');
    const note = String(req.body.note || '').trim().slice(0, 300);
    const room = round2(inv.subtotal - accountOf(inv).creditedTaxable);
    const errors = [];
    if (!(amount > 0)) errors.push('enter the amount to credit (before GST)');
    else if (amount > room + 0.01) errors.push(`you can credit at most ${inr(room)} before GST on this invoice`);
    if (!CN_REASONS.includes(reason)) errors.push('choose a reason');
    if (reason === 'Other' && !note) errors.push('describe the reason');
    if (errors.length) return paymentsPage(res, p, inv, { errors, cn: { amount: req.body.amount, reason, note } }, 400);
    const date = todayIst();
    const cn = {
      id: crypto.randomUUID(), number: nextNumber('CN', date), date, reason, note,
      ...invoiceTotals(amount, inv.gstPercent, inv.taxType), sentAt: null,
    };
    inv.creditNotes = [...(inv.creditNotes || []), cn];
    refreshStatus(inv);
    const client = clientById(p.employerId);
    const emailed = req.body.email === '1' && client && client.active;
    if (emailed) {
      cn.sentAt = new Date().toISOString();
      mailer.creditNoteIssued(client, inv, cn, `${baseUrl}/employer/invoices/${p.id}/credit-notes/${cn.id}`);
    }
    write(list);
    const refund = accountOf(inv).refundDue;
    res.redirect(paymentsUrl(p, inv, `Credit note ${cn.number} issued for ${inr(cn.total)}${refund ? ` · refund due to client: ${inr(refund)}` : ''}${emailed ? ` · emailed to ${client.email}` : ''}`));
  });

  const invoicePage = (res, p, inv, back, cn = null, cnBase = '') =>
    res.render('invoice', {
      title: cn ? `Credit note ${cn.number}` : `Invoice ${inv.number}`, page: 'invoice', noindex: true,
      p, inv, cn, back, cnBase, acct: accountOf(inv), inr, amountInWords, formatYmd,
    });

  app.get('/admin/placements/:id/invoice', adminAuth, requireBilling, (req, res, next) => {
    const { p } = findPlacement(req.params.id);
    const inv = p && (req.query.n ? (p.cancelledInvoices || []).find((i) => i.number === req.query.n) : pickInvoice(p, keyFrom(req)));
    if (!inv) return next();
    invoicePage(res, p, inv, '/admin?tab=placements', null, `/admin/placements/${p.id}/credit-notes`);
  });

  // A credit note is found by its id across all of the placement's invoices.
  const creditNoteIn = (p, cnId) => {
    for (const inv of invoicesOf(p)) {
      const cn = (inv.creditNotes || []).find((c) => c.id === cnId);
      if (cn) return { inv, cn };
    }
    return null;
  };

  app.get('/admin/placements/:id/credit-notes/:cnId', adminAuth, requireBilling, (req, res, next) => {
    const { p } = findPlacement(req.params.id);
    const hit = p && creditNoteIn(p, req.params.cnId);
    if (!hit) return next();
    invoicePage(res, p, hit.inv, paymentsUrl(p, hit.inv), hit.cn);
  });

  // ----- client portal -----
  app.get('/employer/invoices/:id', requireEmployer, clients.allow('billing.view'), (req, res, next) => {
    const { p } = findPlacement(req.params.id);
    // Only this client's own invoices, never by guessing ids.
    if (!p || p.employerId !== req.employer.id) return next();
    const inv = pickInvoice(p, keyFrom(req));
    if (!inv) return next();
    invoicePage(res, p, inv, '/employer#billing', null, `/employer/invoices/${p.id}/credit-notes`);
  });

  app.get('/employer/invoices/:id/credit-notes/:cnId', requireEmployer, clients.allow('billing.view'), (req, res, next) => {
    const { p } = findPlacement(req.params.id);
    if (!p || p.employerId !== req.employer.id) return next();
    const hit = creditNoteIn(p, req.params.cnId);
    if (!hit) return next();
    invoicePage(res, p, hit.inv, invoiceLink(p, hit.inv).replace(baseUrl, ''), hit.cn);
  });

  // What a client sees about their placements: no CTC, fee terms or notes beyond the invoice.
  const forClient = (emp) =>
    read()
      .filter((p) => p.employerId === emp.id)
      .map(describe)
      .map((p) => ({
        id: p.id, candidateName: p.candidateName, jobTitle: p.jobTitle, joiningDate: p.joiningDate, status: p.status,
        guaranteeEnds: p.guaranteeEnds, inGuarantee: p.inGuarantee, monthly: p.feeMode === 'monthly', contractEnd: p.contractEnd,
        invoices: p.invoices.slice().reverse().map(({ inv, key, acct, overdue }) => ({
          key, number: inv.number, date: inv.date, dueDate: inv.dueDate, total: inv.total, status: inv.status, overdue,
          month: inv.period ? (inv.period.month ? monthLabel(inv.period.month) : inv.period.label || '') : '', balance: acct.balance, refundDue: acct.refundDue,
          creditNotes: (inv.creditNotes || []).map((c) => ({ id: c.id, number: c.number, total: c.total })),
        })),
      }));

  // ----- admin tab & dashboard numbers -----
  // Joined with an unbilled one-time fee, or a contract with a finished month to bill.
  const needsInvoice = (p) => (p.feeMode === 'monthly' ? p.monthsDue.length > 0 : p.feeMode === 'assignment' ? false : p.status === 'Joined' && !p.invoice && p.fee > 0);

  function summary(list = read().map(describe)) {
    const fy = financialYear(todayIst());
    const issued = list.flatMap((p) => p.invoices);
    const unpaid = issued.filter((x) => OPEN.includes(x.inv.status));
    const inFy = (d) => financialYear(d) === fy;
    const payments = issued.flatMap((x) => x.inv.payments || []).filter((x) => inFy(x.date));
    const credits = issued.flatMap((x) => x.inv.creditNotes || []).filter((c) => inFy(c.date));
    return {
      fy,
      count: list.length,
      // Net of credit notes issued in the same financial year.
      billedFy: round2(issued.filter((x) => inFy(x.inv.date)).reduce((n, x) => n + x.inv.total, 0) - sum(credits, 'total')),
      receivedFy: sum(payments, 'amount'),
      tdsFy: sum(payments, 'tds'),
      refundsDue: round2(issued.reduce((n, x) => n + x.acct.refundDue, 0)),
      outstanding: round2(unpaid.reduce((n, x) => n + x.acct.balance, 0)),
      unpaidCount: unpaid.length,
      overdueCount: issued.filter((x) => x.overdue).length,
      toInvoice: list.filter(needsInvoice).length,
      contracts: list.filter((p) => p.feeMode === 'monthly' && p.status === 'Joined').length,
      awaitingJoining: list.filter((p) => p.status === 'Awaiting joining').length,
      inGuarantee: list.filter((p) => p.inGuarantee).length,
    };
  }

  // Things a recruiter should act on: joinings due, guarantees ending, overdue invoices.
  function followUps(limit = 6) {
    const today = todayIst();
    const soon = addDays(today, 7);
    const items = [];
    for (const p of read().map(describe)) {
      if (p.status === 'Awaiting joining' && p.joiningDate <= soon) items.push({ at: p.joiningDate, kind: p.joiningDate < today ? 'Confirm joining' : 'Joining', cls: 'st-screening', text: `${p.candidateName} at ${p.company}` });
      if (p.inGuarantee && p.guaranteeDaysLeft <= 14) items.push({ at: p.guaranteeEnds, kind: 'Guarantee ends', cls: 'st-offered', text: `${p.candidateName} at ${p.company}` });
      for (const x of p.invoices) {
        if (x.overdue) items.push({ at: x.inv.dueDate, kind: 'Overdue', cls: 'st-rejected', text: `${x.inv.number} · ${p.company} · ${inr(x.acct.balance)} due` });
        if (x.acct.refundDue) items.push({ at: x.inv.date, kind: 'Refund due', cls: 'st-interview', text: `${p.company} · ${inr(x.acct.refundDue)} (${x.inv.number})` });
      }
      if (p.status === 'Left in guarantee' && !p.replacedBy && !(p.invoice && (p.invoice.creditNotes || []).length)) items.push({ at: p.updatedAt.slice(0, 10), kind: 'Find replacement', cls: 'st-screening', text: `${p.candidateName} left ${p.company}` });
      if (p.feeMode !== 'monthly' && needsInvoice(p)) items.push({ at: p.joiningDate, kind: 'To invoice', cls: 'st-new', text: `${p.candidateName} at ${p.company} · ${inr(p.fee)}` });
      if (p.timesheetsPending) items.push({ at: todayIst(), kind: 'Timesheets', cls: 'st-screening', text: `${p.timesheetsPending} waiting for approval · ${p.candidateName} at ${p.company}` });
      if (p.monthsDue.length) items.push({ at: `${p.monthsDue[0]}-28`, kind: 'Bill month', cls: 'st-new', text: `${p.candidateName} at ${p.company} · ${p.monthsDue.map(monthLabel).join(', ')}` });
    }
    return items.sort((a, b) => a.at.localeCompare(b.at)).slice(0, limit);
  }

  function csvRows() {
    return read().map(describe).map((p) => ({
      candidate: p.candidateName, email: p.candidateEmail, job: p.jobTitle, client: p.company, type: p.type, status: p.status,
      joiningDate: p.joiningDate, guaranteeEnds: p.feeMode === 'monthly' ? '' : p.guaranteeEnds, ctc: p.ctc, feePercent: p.feePercent ?? '', fee: p.fee,
      monthlyRate: p.monthlyRate || '', contractEnd: p.contractEnd || '', monthlyInvoices: (p.monthlyInvoices || []).length || '',
      monthlyBilled: (p.monthlyInvoices || []).length ? round2(p.invoices.filter((x) => x.inv.period).reduce((n, x) => n + x.inv.total - x.acct.credited, 0)) : '',
      monthlyOutstanding: (p.monthlyInvoices || []).length ? round2(p.invoices.filter((x) => x.inv.period).reduce((n, x) => n + x.acct.balance, 0)) : '',
      invoiceNumber: p.invoice ? p.invoice.number : '', invoiceDate: p.invoice ? p.invoice.date : '', invoiceTotal: p.invoice ? p.invoice.total : '',
      invoiceStatus: p.invoice ? (p.overdue ? 'Overdue' : p.invoice.status) : '',
      received: p.acct ? p.acct.received : '', tds: p.acct ? p.acct.tds : '', credited: p.acct ? p.acct.credited : '',
      refunded: p.acct ? p.acct.refunded : '', balance: p.acct ? p.acct.balance : '', refundDue: p.acct ? p.acct.refundDue : '',
      reminders: p.invoice ? (p.invoice.reminders || []).length : '', replacementFor: p.replacementFor ? 'yes' : '', replacedBy: p.replacedBy ? 'yes' : '',
      creditNotes: p.invoice ? (p.invoice.creditNotes || []).map((c) => c.number).join('; ') : '',
      paidOn: p.invoice ? p.invoice.paidAt || '' : '', notes: p.notes,
    }));
  }

  // Placements and money per client-portal account, for the Clients tab.
  function byClient() {
    const out = {};
    for (const p of read().map(describe)) {
      if (!p.employerId) continue;
      const t = (out[p.employerId] = out[p.employerId] || { placements: 0, billed: 0, received: 0, outstanding: 0 });
      t.placements++;
      for (const x of p.invoices) {
        t.billed = round2(t.billed + x.inv.total - x.acct.credited);
        t.received = round2(t.received + x.acct.received + x.acct.tds - x.acct.refunded);
        t.outstanding = round2(t.outstanding + x.acct.balance);
      }
    }
    return out;
  }

  return { read, write, describe, summary, followUps, forClient, csvRows, byClient, autoRemind, needsInvoice, monthLabel, issueFee, issueStaffing, invoicesOf, STATUSES, TYPES, inr };
}

const formatYmd = (ymd) => (ymd ? new Date(`${ymd}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');

module.exports = { register, billingOf, BILLING_DEFAULTS, amountInWords, invoiceTotals, accountOf, refreshStatus, financialYear, formatYmd, inr, parsePlacement, monthPeriod };
