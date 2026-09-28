// Placements & invoicing: when a candidate is hired, record the joining date,
// CTC and fee, follow the replacement-guarantee period, and bill the client
// with a numbered GST invoice. Placements are their own collection (not part of
// the application), so billing records survive a candidate deleting their data.
const crypto = require('crypto');

const STATUSES = ['Awaiting joining', 'Joined', 'Did not join', 'Left in guarantee'];
const TYPES = ['Permanent', 'Contract', 'Contract-to-hire'];
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
  // Invoices marked paid before payments were recorded count as settled.
  const legacyPaid = inv.status === 'Paid' && !(inv.payments || []).length && !(inv.creditNotes || []).length;
  const balance = legacyPaid ? 0 : round2(inv.total - received - tds - credited);
  return { received, tds, credited, creditedTaxable, balance: Math.max(balance, 0), refundDue: Math.max(-balance, 0) };
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

// Derived, display-only facts about a placement (never stored).
function describe(p) {
  const today = todayIst();
  const guaranteeEnds = p.joiningDate ? addDays(p.joiningDate, p.guaranteeDays || 0) : '';
  const inv = p.invoice;
  return {
    ...p,
    guaranteeEnds,
    inGuarantee: p.status === 'Joined' && guaranteeEnds && today <= guaranteeEnds,
    guaranteeDaysLeft: guaranteeEnds ? daysBetween(today, guaranteeEnds) : null,
    acct: inv ? accountOf(inv) : null,
    overdue: Boolean(inv && OPEN.includes(inv.status) && inv.dueDate < today),
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
    feeMode: get('feeMode', 10) === 'flat' ? 'flat' : 'percent',
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
  } else {
    if (!(f.flatFee > 0)) errors.push('enter the fee amount');
    else fee = round2(f.flatFee);
    if (Number.isNaN(f.ctc)) f.ctc = 0;
  }
  if (f.ctc < 0) errors.push('CTC cannot be negative');
  if (!f.billingName) f.billingName = f.company;
  // Blank or invalid numbers are shown back as empty fields, not "NaN".
  const numbers = { ctc: f.ctc, feePercent: f.feePercent, guaranteeDays: f.guaranteeDays };
  for (const k of ['ctc', 'feePercent', 'flatFee', 'guaranteeDays']) if (Number.isNaN(f[k])) f[k] = '';
  return {
    errors,
    f,
    data: {
      type: f.type, company: f.company, billingName: f.billingName, billingAddress: f.billingAddress, clientGstin: f.clientGstin, taxType: f.taxType,
      joiningDate: f.joiningDate, ctc: numbers.ctc || 0, feeMode: f.feeMode, feePercent: f.feeMode === 'percent' ? numbers.feePercent : null, fee,
      guaranteeDays: numbers.guaranteeDays, status: f.status, notes: f.notes,
    },
  };
}

function register(app, deps) {
  const { db, site, mailer, baseUrl, adminAuth, sameOrigin, adminUrl, readSubmissions, writeSubmissions, getJobs, clients, requireEmployer } = deps;
  const read = () => db.all('placements');
  const write = (list) => db.replaceAll('placements', list);
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
      types: TYPES, statuses: STATUSES, clientOptions: clients.read(), billing: billingOf(site), inr, ...locals,
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
    formPage(res, {
      a,
      p: {
        type: job && job.type === 'Contract' ? 'Contract' : 'Permanent', company: client ? client.company : (job ? job.company : ''), employerId: client ? client.id : '',
        billingName: '', billingAddress: '', clientGstin: '', taxType: 'intra', joiningDate: todayIst(), ctc: '', feeMode: 'percent',
        feePercent: b.feePercent, flatFee: '', guaranteeDays: b.guaranteeDays, status: 'Awaiting joining', notes: '',
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
    if (errors.length) return formPage(res, { a, p: { ...f, employerId }, errors }, 400);
    const now = new Date().toISOString();
    const placement = {
      id: crypto.randomUUID(), appId: a.id, candidateName: a.name, candidateEmail: a.email, jobId: a.jobId, jobTitle: a.jobTitle,
      employerId, ...data, invoice: null, cancelledInvoices: [], createdAt: now, updatedAt: now,
    };
    list.unshift(placement);
    write(list);
    // A recorded placement means the offer was accepted.
    if (a.status !== 'Hired') {
      Object.assign(a, { status: 'Hired', updatedAt: now });
      writeSubmissions('applications', apps);
    }
    res.redirect(adminUrl('placements', `Placement recorded for ${a.name} at ${data.company} · fee ${inr(data.fee)}`));
  });

  // ----- edit -----
  const findPlacement = (id) => {
    const list = read();
    return { list, p: list.find((x) => x.id === id) };
  };

  app.get('/admin/placements/:id/edit', adminAuth, (req, res, next) => {
    const { p } = findPlacement(req.params.id);
    if (!p) return next();
    formPage(res, { a: { name: p.candidateName, email: p.candidateEmail, jobTitle: p.jobTitle }, p: { ...p, flatFee: p.feeMode === 'flat' ? p.fee : '' } });
  });

  app.post('/admin/placements/:id', adminAuth, sameOrigin, (req, res, next) => {
    const { list, p } = findPlacement(req.params.id);
    if (!p) return next();
    const { errors, f, data } = parsePlacement(req.body);
    const employerId = clientById(f.employerId) ? f.employerId : '';
    if (errors.length) return formPage(res, { a: { name: p.candidateName, email: p.candidateEmail, jobTitle: p.jobTitle }, p: { ...f, id: p.id, employerId, invoice: p.invoice }, errors }, 400);
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
  app.post('/admin/placements/:id/delete', adminAuth, sameOrigin, (req, res, next) => {
    const { list, p } = findPlacement(req.params.id);
    if (!p) return next();
    if (p.invoice || (p.cancelledInvoices || []).length) return res.redirect(adminUrl('placements', "Placements with an invoice can't be deleted (invoices are tax records)"));
    write(list.filter((x) => x !== p));
    res.redirect(adminUrl('placements', `Deleted the placement for ${p.candidateName}`));
  });

  // ----- invoices -----
  app.post('/admin/placements/:id/invoice', adminAuth, sameOrigin, (req, res, next) => {
    const { list, p } = findPlacement(req.params.id);
    if (!p) return next();
    if (p.invoice) return res.redirect(adminUrl('placements', `Invoice ${p.invoice.number} is already issued`));
    if (!(p.fee > 0)) return res.redirect(adminUrl('placements', 'Set a fee on the placement before invoicing'));
    const b = billingOf(site);
    const date = todayIst();
    // Snapshot everything the invoice shows, so later edits never change an issued invoice.
    p.invoice = {
      number: nextInvoiceNumber(date), date, dueDate: addDays(date, b.paymentDays), gstPercent: b.gstPercent, taxType: p.taxType,
      ...invoiceTotals(p.fee, b.gstPercent, p.taxType),
      seller: { name: b.legalName || site.name, address: site.address, gstin: b.gstin, pan: b.pan, stateName: b.stateName, bank: b.bank, email: site.email, phone: site.phone },
      buyer: { name: p.billingName || p.company, address: p.billingAddress, gstin: p.clientGstin },
      item: `Recruitment fee – ${p.jobTitle} (${p.candidateName}), joined ${formatYmd(p.joiningDate)}${p.feeMode === 'percent' ? ` · ${p.feePercent}% of annual CTC ${inr(p.ctc)}` : ''}`,
      // SAC codes: 998512 permanent placement, 998513 contract staffing.
      sac: p.type === 'Contract' ? '998513' : '998512',
      status: 'Unpaid', paidAt: null, sentAt: null, payments: [], creditNotes: [],
    };
    const client = clientById(p.employerId);
    const emailed = req.body.email === '1' && client && client.active;
    if (emailed) {
      p.invoice.sentAt = new Date().toISOString();
      mailer.invoiceIssued(client, p.invoice, `${baseUrl}/employer/invoices/${p.id}`);
    }
    write(list);
    res.redirect(adminUrl('placements', `Invoice ${p.invoice.number} issued for ${inr(p.invoice.total)}${emailed ? ` · emailed to ${client.email}` : ''}`));
  });

  // Cancelling keeps the number on record (no gaps are reused) and lets you reissue.
  // Once money or a credit note is recorded, use a credit note instead (GST rules).
  app.post('/admin/placements/:id/invoice/cancel', adminAuth, sameOrigin, (req, res, next) => {
    const { list, p } = findPlacement(req.params.id);
    if (!p || !p.invoice) return next();
    if ((p.invoice.payments || []).length || (p.invoice.creditNotes || []).length || p.invoice.status === 'Paid') {
      return res.redirect(adminUrl('placements', `Invoice ${p.invoice.number} has payments or credit notes, so it can't be cancelled. Issue a credit note instead.`));
    }
    const inv = { ...p.invoice, status: 'Cancelled', cancelledAt: todayIst() };
    p.cancelledInvoices = [...(p.cancelledInvoices || []), inv];
    p.invoice = null;
    write(list);
    res.redirect(adminUrl('placements', `Invoice ${inv.number} cancelled. You can issue a new one.`));
  });

  // ----- payments & credit notes -----
  const paymentsUrl = (p, msg) => `/admin/placements/${p.id}/payments${msg ? `?msg=${encodeURIComponent(msg)}` : ''}`;
  const moneyIn = (v) => {
    const raw = String(v ?? '').replace(/[,₹\s]/g, '');
    return raw === '' ? 0 : Number(raw);
  };

  function paymentsPage(res, p, extra = {}, status = 200) {
    const inv = p.invoice;
    const acct = accountOf(inv);
    const b = billingOf(site);
    // Suggest the usual split: TDS on the taxable value, the rest in cash.
    const tds = Math.min(round2((inv.subtotal * b.tdsPercent) / 100), acct.balance);
    res.status(status).render('admin-payments', {
      title: `Payments · ${inv.number}`, page: 'admin', noindex: true, p, inv, acct, inr, formatYmd, modes: PAY_MODES, reasons: CN_REASONS,
      tdsPercent: b.tdsPercent, errors: [], msg: '', portalClient: clientById(p.employerId),
      pay: { date: todayIst(), amount: round2(acct.balance - tds) || '', tds: tds || '', mode: 'Bank transfer', reference: '' },
      cn: { amount: round2(inv.subtotal - acct.creditedTaxable) || '', reason: CN_REASONS[0], note: '' },
      ...extra,
    });
  }

  app.get('/admin/placements/:id/payments', adminAuth, (req, res, next) => {
    const { p } = findPlacement(req.params.id);
    if (!p || !p.invoice) return next();
    paymentsPage(res, p, { msg: String(req.query.msg || '') });
  });

  app.post('/admin/placements/:id/payments', adminAuth, sameOrigin, (req, res, next) => {
    const { list, p } = findPlacement(req.params.id);
    if (!p || !p.invoice) return next();
    const inv = p.invoice;
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
    if (errors.length) return paymentsPage(res, p, { errors, pay: { ...pay, amount: req.body.amount, tds: req.body.tds } }, 400);
    inv.payments = [...(inv.payments || []), { id: crypto.randomUUID(), ...pay, amount: round2(pay.amount), tds: round2(pay.tds), recordedAt: new Date().toISOString() }];
    refreshStatus(inv);
    write(list);
    res.redirect(paymentsUrl(p, `Recorded ${inr(pay.amount)}${pay.tds ? ` + ${inr(pay.tds)} TDS` : ''} · invoice is ${inv.status.toLowerCase()}`));
  });

  app.post('/admin/placements/:id/payments/:payId/delete', adminAuth, sameOrigin, (req, res, next) => {
    const { list, p } = findPlacement(req.params.id);
    const inv = p && p.invoice;
    if (!inv || !(inv.payments || []).some((x) => x.id === req.params.payId)) return next();
    inv.payments = inv.payments.filter((x) => x.id !== req.params.payId);
    refreshStatus(inv);
    write(list);
    res.redirect(paymentsUrl(p, `Payment removed · invoice is ${inv.status.toLowerCase()}`));
  });

  // A credit note reduces what the client owes (or creates a refund if they've paid).
  // It carries GST at the invoice's rate and split, and its own number series.
  app.post('/admin/placements/:id/credit-notes', adminAuth, sameOrigin, (req, res, next) => {
    const { list, p } = findPlacement(req.params.id);
    if (!p || !p.invoice) return next();
    const inv = p.invoice;
    const amount = moneyIn(req.body.amount);
    const reason = String(req.body.reason || '');
    const note = String(req.body.note || '').trim().slice(0, 300);
    const room = round2(inv.subtotal - accountOf(inv).creditedTaxable);
    const errors = [];
    if (!(amount > 0)) errors.push('enter the amount to credit (before GST)');
    else if (amount > room + 0.01) errors.push(`you can credit at most ${inr(room)} before GST on this invoice`);
    if (!CN_REASONS.includes(reason)) errors.push('choose a reason');
    if (reason === 'Other' && !note) errors.push('describe the reason');
    if (errors.length) return paymentsPage(res, p, { errors, cn: { amount: req.body.amount, reason, note } }, 400);
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
    res.redirect(paymentsUrl(p, `Credit note ${cn.number} issued for ${inr(cn.total)}${refund ? ` · refund due to client: ${inr(refund)}` : ''}${emailed ? ` · emailed to ${client.email}` : ''}`));
  });

  const invoicePage = (res, p, inv, back, cn = null, cnBase = '') =>
    res.render('invoice', {
      title: cn ? `Credit note ${cn.number}` : `Invoice ${inv.number}`, page: 'invoice', noindex: true,
      p, inv, cn, back, cnBase, acct: accountOf(inv), inr, amountInWords, formatYmd,
    });

  app.get('/admin/placements/:id/invoice', adminAuth, (req, res, next) => {
    const { p } = findPlacement(req.params.id);
    const inv = p && (req.query.n ? (p.cancelledInvoices || []).find((i) => i.number === req.query.n) : p.invoice);
    if (!inv) return next();
    invoicePage(res, p, inv, '/admin?tab=placements', null, `/admin/placements/${p.id}/credit-notes`);
  });

  app.get('/admin/placements/:id/credit-notes/:cnId', adminAuth, (req, res, next) => {
    const { p } = findPlacement(req.params.id);
    const cn = p && p.invoice && (p.invoice.creditNotes || []).find((c) => c.id === req.params.cnId);
    if (!cn) return next();
    invoicePage(res, p, p.invoice, `/admin/placements/${p.id}/payments`, cn);
  });

  // ----- client portal -----
  app.get('/employer/invoices/:id', requireEmployer, (req, res, next) => {
    const { p } = findPlacement(req.params.id);
    // Only this client's own invoices, never by guessing ids.
    if (!p || !p.invoice || p.employerId !== req.employer.id) return next();
    invoicePage(res, p, p.invoice, '/employer#billing', null, `/employer/invoices/${p.id}/credit-notes`);
  });

  app.get('/employer/invoices/:id/credit-notes/:cnId', requireEmployer, (req, res, next) => {
    const { p } = findPlacement(req.params.id);
    if (!p || !p.invoice || p.employerId !== req.employer.id) return next();
    const cn = (p.invoice.creditNotes || []).find((c) => c.id === req.params.cnId);
    if (!cn) return next();
    invoicePage(res, p, p.invoice, `/employer/invoices/${p.id}`, cn);
  });

  // What a client sees about their placements: no CTC, fee terms or notes beyond the invoice.
  const forClient = (emp) =>
    read()
      .filter((p) => p.employerId === emp.id)
      .map(describe)
      .map((p) => ({
        id: p.id, candidateName: p.candidateName, jobTitle: p.jobTitle, joiningDate: p.joiningDate, status: p.status,
        guaranteeEnds: p.guaranteeEnds, inGuarantee: p.inGuarantee, overdue: p.overdue,
        invoice: p.invoice ? {
          number: p.invoice.number, date: p.invoice.date, dueDate: p.invoice.dueDate, total: p.invoice.total, status: p.invoice.status,
          balance: p.acct.balance, refundDue: p.acct.refundDue,
          creditNotes: (p.invoice.creditNotes || []).map((c) => ({ id: c.id, number: c.number, total: c.total })),
        } : null,
      }));

  // ----- admin tab & dashboard numbers -----
  function summary(list = read().map(describe)) {
    const fy = financialYear(todayIst());
    const issued = list.filter((p) => p.invoice);
    const unpaid = issued.filter((p) => OPEN.includes(p.invoice.status));
    const inFy = (d) => financialYear(d) === fy;
    const payments = issued.flatMap((p) => p.invoice.payments || []).filter((x) => inFy(x.date));
    const credits = issued.flatMap((p) => p.invoice.creditNotes || []).filter((c) => inFy(c.date));
    return {
      fy,
      count: list.length,
      // Net of credit notes issued in the same financial year.
      billedFy: round2(issued.filter((p) => inFy(p.invoice.date)).reduce((n, p) => n + p.invoice.total, 0) - sum(credits, 'total')),
      receivedFy: sum(payments, 'amount'),
      tdsFy: sum(payments, 'tds'),
      refundsDue: round2(issued.reduce((n, p) => n + p.acct.refundDue, 0)),
      outstanding: round2(unpaid.reduce((n, p) => n + p.acct.balance, 0)),
      unpaidCount: unpaid.length,
      overdueCount: list.filter((p) => p.overdue).length,
      toInvoice: list.filter((p) => !p.invoice && p.status === 'Joined').length,
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
      if (p.overdue) items.push({ at: p.invoice.dueDate, kind: 'Overdue', cls: 'st-rejected', text: `${p.invoice.number} · ${p.company} · ${inr(p.acct.balance)} due` });
      if (p.acct && p.acct.refundDue) items.push({ at: p.invoice.date, kind: 'Refund due', cls: 'st-interview', text: `${p.company} · ${inr(p.acct.refundDue)} (${p.invoice.number})` });
      if (p.status === 'Joined' && !p.invoice) items.push({ at: p.joiningDate, kind: 'To invoice', cls: 'st-new', text: `${p.candidateName} at ${p.company} · ${inr(p.fee)}` });
    }
    return items.sort((a, b) => a.at.localeCompare(b.at)).slice(0, limit);
  }

  function csvRows() {
    return read().map(describe).map((p) => ({
      candidate: p.candidateName, email: p.candidateEmail, job: p.jobTitle, client: p.company, type: p.type, status: p.status,
      joiningDate: p.joiningDate, guaranteeEnds: p.guaranteeEnds, ctc: p.ctc, feePercent: p.feePercent ?? '', fee: p.fee,
      invoiceNumber: p.invoice ? p.invoice.number : '', invoiceDate: p.invoice ? p.invoice.date : '', invoiceTotal: p.invoice ? p.invoice.total : '',
      invoiceStatus: p.invoice ? (p.overdue ? 'Overdue' : p.invoice.status) : '',
      received: p.acct ? p.acct.received : '', tds: p.acct ? p.acct.tds : '', credited: p.acct ? p.acct.credited : '',
      balance: p.acct ? p.acct.balance : '', refundDue: p.acct ? p.acct.refundDue : '',
      creditNotes: p.invoice ? (p.invoice.creditNotes || []).map((c) => c.number).join('; ') : '',
      paidOn: p.invoice ? p.invoice.paidAt || '' : '', notes: p.notes,
    }));
  }

  return { read, describe, summary, followUps, forClient, csvRows, STATUSES, inr };
}

const formatYmd = (ymd) => (ymd ? new Date(`${ymd}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');

module.exports = { register, billingOf, BILLING_DEFAULTS, amountInWords, invoiceTotals, accountOf, refreshStatus, financialYear, formatYmd, inr };
