// The company profile employers can read online or download as a PDF: who
// operates Hireriv, what it does, how an engagement works, the commercial
// terms and the contact details. Everything comes from Admin → Settings and
// the service catalogue, so it never says more than the site does.
const catalog = require('./catalog');
const pdf = require('./resume-pdf');

const STEPS = [
  'You share the requirement: roles, numbers, locations, salary range and timelines.',
  'A recruiter calls you within one working day, then sends a written quote.',
  'Once the quote is accepted and the agreement signed, we source and screen candidates.',
  'You receive a shortlist with a recruiter note on every profile.',
  'You interview and choose; we arrange interviews and collect feedback.',
  'We support the offer and follow the candidate through to joining.',
];

// The sections, in order: { heading, blocks: [{ title?, note?, text? }] }.
function sections(site, { companyOf, realContact, billing, priceOf, pricedServices, baseUrl }) {
  const co = companyOf(site);
  const real = realContact(site);
  const out = [];
  const story = co.story ? co.story.split(/\n\s*\n/).map((t) => ({ text: t.replace(/\s*\n\s*/g, ' ') }))
    : [{ text: `${site.name} helps employers fill IT and non-IT roles through permanent recruitment, bulk hiring and contract staffing, and helps job seekers find real vacancies and apply for free. Every job on the site is checked by our team before it goes live.` }];
  out.push({ heading: 'About us', blocks: [{ text: `${site.name} is a recruitment and staffing brand operated by ${co.operator}, India.` }, ...story] });
  if (co.mission || co.vision) out.push({ heading: 'Mission and vision', blocks: [co.mission && { title: 'Mission', text: co.mission }, co.vision && { title: 'Vision', text: co.vision }].filter(Boolean) });

  const main = catalog.PRIORITY_SERVICES;
  const others = catalog.SERVICES.filter((s) => !main.includes(s));
  out.push({
    heading: 'Our services',
    blocks: [
      ...main.map((s) => ({ title: s.name, note: s.need ? `For: ${s.need}` : '', text: s.card })),
      ...(others.length ? [{ text: `Also on request: ${others.map((s) => s.name).join(', ')}.` }] : []),
    ],
  });
  if (co.capabilities.length) out.push({ heading: 'What we can deliver today', blocks: co.capabilities.map((c) => ({ text: `- ${c}` })) });
  out.push({ heading: 'Industries we hire for', blocks: [{ text: `${catalog.INDUSTRIES.map((i) => i.name).join(', ')}.` }] });
  out.push({ heading: 'How we work', blocks: STEPS.map((t, i) => ({ text: `${i + 1}. ${t}` })) });

  const terms = [];
  const prices = pricedServices.filter((p) => priceOf(site, p.slug)).map((p) => `${p.name}: from ${priceOf(site, p.slug)}`);
  terms.push({ title: 'Fees', text: prices.length ? `${prices.join('. ')}. Prices exclude GST; your written quote sets the final price.` : 'Every requirement is quoted in writing before any work starts: a percentage of the annual CTC for permanent hires, a monthly fee for contract staff, and a fee per hire for bulk hiring.' });
  if (billing.guaranteeDays > 0) terms.push({ title: 'Replacement', text: `Permanent hires who leave within ${billing.guaranteeDays} days of joining are replaced at no extra fee, on the conditions in our service terms.` });
  terms.push({ title: 'Payment', text: `Invoices are due within ${billing.paymentDays} days. Every invoice is a GST invoice.` });
  terms.push({ text: `Full terms: ${baseUrl}/service-terms` });
  out.push({ heading: 'Commercial terms', blocks: terms });

  if (co.team.length) out.push({ heading: 'Our team', blocks: co.team.map((m) => ({ title: m.name, note: m.role, text: m.bio || '' })) });

  const details = [
    { title: 'Operated by', text: co.operator },
    co.cin && { title: 'CIN', text: co.cin },
    site.billing && site.billing.gstin && { title: 'GSTIN', text: site.billing.gstin },
    co.founded && { title: 'Founded', text: co.founded },
    real.address && { title: 'Office', text: real.address },
    { title: 'Email', text: site.email },
    real.phone && { title: 'Phone', text: real.phone },
    real.whatsapp && { title: 'WhatsApp', text: `+${real.whatsapp}` },
    { title: 'Website', text: baseUrl.replace(/^https?:\/\//, '') },
  ].filter(Boolean);
  out.push({ heading: 'Company details', blocks: details });
  return out;
}

// The PDF: A4, built-in fonts, from the same sections as the web page.
function buildPdf(site, deps, now = new Date()) {
  const list = sections(site, deps);
  return pdf.build({ name: `${site.name} company profile`, headline: 'Recruitment and staffing across India' }, {
    title: `${site.name} company profile`, contact: [deps.baseUrl.replace(/^https?:\/\//, ''), site.email], now, sections: list,
  });
}

module.exports = { sections, buildPdf, STEPS };
