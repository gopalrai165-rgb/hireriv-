// Take-home pay from a salary (Step 150): PF, ESI, professional tax and
// income tax under the new tax regime, for FY 2026-27 (the slabs, the
// ₹75,000 standard deduction and the section 87A rebate up to ₹12 lakh were
// unchanged by Budget 2026). An estimate: the payslip decides.

const FY = '2026-27';
const STANDARD_DEDUCTION = 75000;
const REBATE_LIMIT = 1200000;
// New regime slabs: [upper limit of the band, rate].
const SLABS = [[400000, 0], [800000, 0.05], [1200000, 0.10], [1600000, 0.15], [2000000, 0.20], [2400000, 0.25], [Infinity, 0.30]];
const PF_RATE = 0.12;
const PF_WAGE_CEILING = 15000; // a month: PF on at most this much basic when "capped"
const ESI_RATE = 0.0075; // the employee's share
const ESI_LIMIT = 21000; // a month: ESI applies up to this gross pay

function slabTax(taxable) {
  let tax = 0; let from = 0;
  for (const [to, rate] of SLABS) {
    if (taxable > from) tax += (Math.min(taxable, to) - from) * rate;
    from = to;
  }
  return tax;
}
// Income tax for the year on a salary: the standard deduction, the rebate
// (no tax up to ₹12 lakh taxable), marginal relief just above it, 4% cess.
function incomeTax(grossYear) {
  const taxable = Math.max(0, grossYear - STANDARD_DEDUCTION);
  let tax = slabTax(taxable);
  if (taxable <= REBATE_LIMIT) tax = 0;
  else tax = Math.min(tax, taxable - REBATE_LIMIT);
  return { taxable, tax: Math.round(tax * 1.04) };
}

const PF_MODES = ['capped', 'full', 'none'];
// input: { amount, per: 'month'|'year', basicPercent, pf, pt, ctcIncludesPf }
function parse(q) {
  const num = (v) => Number(String(v ?? '').replace(/[₹,\s]/g, ''));
  const out = {
    amount: num(q.amount), per: q.per === 'year' ? 'year' : 'month',
    basicPercent: q.basicPercent === undefined || q.basicPercent === '' ? 50 : num(q.basicPercent),
    pf: PF_MODES.includes(q.pf) ? q.pf : 'capped',
    pt: q.pt === undefined || q.pt === '' ? 200 : num(q.pt),
    ctcIncludesPf: q.per === 'year' ? q.ctcIncludesPf !== '0' : false,
  };
  const errors = [];
  if (!(out.amount > 0)) errors.push('enter the salary in rupees');
  else if (out.amount > (out.per === 'year' ? 100000000 : 10000000)) errors.push('that salary is too large for this calculator');
  if (!(out.basicPercent >= 20 && out.basicPercent <= 100)) errors.push('basic pay should be between 20% and 100% of the salary');
  if (!(out.pt >= 0 && out.pt <= 300)) errors.push('professional tax is at most ₹300 a month');
  return { input: out, errors };
}

function compute(i) {
  const r = (x) => Math.round(x);
  // A yearly CTC often includes the employer's PF; take it out to get gross pay.
  let grossYear = i.per === 'year' ? i.amount : i.amount * 12;
  let employerPfYear = 0;
  const pfOn = (basicMonth) => (i.pf === 'none' ? 0 : PF_RATE * (i.pf === 'capped' ? Math.min(basicMonth, PF_WAGE_CEILING) : basicMonth));
  if (i.per === 'year' && i.ctcIncludesPf && i.pf !== 'none') {
    // CTC = gross + employer PF, and basic is a share of gross.
    const capped = i.pf === 'capped';
    const share = (i.basicPercent / 100) * PF_RATE;
    grossYear = capped && (i.amount / (1 + share) / 12) * (i.basicPercent / 100) > PF_WAGE_CEILING ? i.amount - PF_RATE * PF_WAGE_CEILING * 12 : i.amount / (1 + share);
    employerPfYear = i.amount - grossYear;
  }
  const grossMonth = grossYear / 12;
  const basicMonth = grossMonth * (i.basicPercent / 100);
  const pf = pfOn(basicMonth);
  const esi = grossMonth <= ESI_LIMIT ? Math.ceil(grossMonth * ESI_RATE) : 0;
  const pt = i.pt;
  const t = incomeTax(grossYear);
  const taxMonth = t.tax / 12;
  const inHand = grossMonth - pf - esi - pt - taxMonth;
  return {
    fy: FY, ctcYear: r(i.per === 'year' ? i.amount : grossYear), employerPfYear: r(employerPfYear),
    grossMonth: r(grossMonth), basicMonth: r(basicMonth), pf: r(pf), esi, pt, taxMonth: r(taxMonth), taxYear: t.tax, taxable: r(t.taxable),
    inHandMonth: r(inHand), inHandYear: r(inHand * 12), noTax: t.tax === 0,
  };
}

const rupees = (n) => `₹${Math.round(n).toLocaleString('en-IN')}`;

module.exports = { FY, SLABS, STANDARD_DEDUCTION, REBATE_LIMIT, ESI_LIMIT, PF_WAGE_CEILING, parse, compute, incomeTax, rupees };
