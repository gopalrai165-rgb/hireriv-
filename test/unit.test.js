// Unit tests for the pure helpers: billing maths, validation, matching and
// parsing. Run with `npm test`.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const placements = require('../placements');
const content = require('../content');
const { skillMatch, buildPool, searchPool } = require('../match');
const seo = require('../seo');
const { analyze } = require('../resume-parse');
const history = require('../history');
const timesheets = require('../timesheets');

// ---------- invoices ----------
test('amount in words uses Indian lakh and crore', () => {
  assert.equal(placements.amountInWords(0), 'Rupees Zero Only');
  assert.equal(placements.amountInWords(118000), 'Rupees One Lakh Eighteen Thousand Only');
  assert.equal(placements.amountInWords(12345678.5), 'Rupees One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight and Fifty Paise Only');
  assert.equal(placements.amountInWords(101), 'Rupees One Hundred One Only');
});

test('GST is split into CGST + SGST within the state, IGST across states', () => {
  const intra = placements.invoiceTotals(100000, 18, 'intra');
  assert.deepEqual(intra.taxLines.map((l) => [l.label, l.amount]), [['CGST @ 9%', 9000], ['SGST @ 9%', 9000]]);
  assert.equal(intra.total, 118000);

  const inter = placements.invoiceTotals(100000, 18, 'inter');
  assert.deepEqual(inter.taxLines.map((l) => [l.label, l.amount]), [['IGST @ 18%', 18000]]);
  assert.equal(inter.total, 118000);

  // Odd paise: CGST and SGST always add up to the GST total.
  const odd = placements.invoiceTotals(333.33, 18, 'intra');
  assert.equal(odd.taxLines[0].amount + odd.taxLines[1].amount, odd.gst);

  assert.deepEqual(placements.invoiceTotals(5000, 0, 'intra').taxLines, []);
});

test('financial year runs April to March', () => {
  assert.equal(placements.financialYear('2026-03-31'), '2025-26');
  assert.equal(placements.financialYear('2026-04-01'), '2026-27');
  assert.equal(placements.financialYear('2099-12-01'), '2099-00');
});

test('invoice status follows payments, TDS, credit notes and refunds', () => {
  const inv = { total: 118000, payments: [], creditNotes: [], refunds: [], status: 'Unpaid' };
  assert.equal(placements.refreshStatus(inv).status, 'Unpaid');

  inv.payments.push({ date: '2026-10-01', amount: 50000, tds: 0 });
  assert.equal(placements.refreshStatus(inv).status, 'Part paid');
  assert.equal(placements.accountOf(inv).balance, 68000);

  // The client pays the rest less 10% TDS on the fee: still fully settled.
  inv.payments.push({ date: '2026-10-05', amount: 58000, tds: 10000 });
  placements.refreshStatus(inv);
  assert.equal(inv.status, 'Paid');
  assert.equal(inv.paidAt, '2026-10-05');

  // A credit note after full payment means a refund is due.
  inv.creditNotes.push({ total: 20000, subtotal: 16949.15 });
  assert.equal(placements.accountOf(inv).refundDue, 20000);
  inv.refunds.push({ amount: 20000 });
  assert.equal(placements.accountOf(inv).refundDue, 0);
  assert.equal(placements.accountOf(inv).balance, 0);

  const credited = { total: 1000, payments: [], creditNotes: [{ total: 1000 }], status: 'Unpaid' };
  assert.equal(placements.refreshStatus(credited).status, 'Credited');
});

test('placement form: percent fee, monthly contracts and validation', () => {
  const base = { type: 'Permanent', company: 'Acme', joiningDate: '2026-10-01', status: 'Awaiting joining', guaranteeDays: '90', taxType: 'intra' };

  const pct = placements.parsePlacement({ ...base, feeMode: 'percent', ctc: '12,00,000', feePercent: '8.33' });
  assert.deepEqual(pct.errors, []);
  assert.equal(pct.data.fee, 99960);
  assert.equal(pct.data.billingName, 'Acme');

  const monthlyPermanent = placements.parsePlacement({ ...base, feeMode: 'monthly', monthlyRate: '90000' });
  assert.ok(monthlyPermanent.errors.includes('monthly billing is for contract placements'));

  const bad = placements.parsePlacement({ ...base, company: '', joiningDate: 'soon', feeMode: 'percent', ctc: '', feePercent: '200', clientGstin: 'XYZ', guaranteeDays: '999' });
  for (const e of ['client company is required', 'joining date is required', 'guarantee must be 0–365 days', 'annual CTC is required for a % fee', 'fee % must be between 0 and 100']) {
    assert.ok(bad.errors.includes(e), e);
  }
  // Invalid numbers are shown back as empty fields, never "NaN".
  assert.equal(bad.f.ctc, '');

  const ends = placements.parsePlacement({ ...base, type: 'Contract', feeMode: 'monthly', monthlyRate: '90000', contractEnd: '2026-09-01' });
  assert.ok(ends.errors.includes('contract end is before the joining date'));
});

test('monthly billing periods are pro-rated from joining to contract end', () => {
  const p = { joiningDate: '2026-02-10', contractEnd: '2026-03-15' };
  assert.deepEqual(placements.monthPeriod(p, '2026-02'), { month: '2026-02', from: '2026-02-10', to: '2026-02-28', days: 19, daysInMonth: 28 });
  assert.equal(placements.monthPeriod(p, '2026-03').days, 15);
  assert.equal(placements.monthPeriod(p, '2026-04'), null);
});

// ---------- settings and blog ----------
const validSettings = {
  tagline: 'Hiring', phone: '+91 98765 43210', whatsapp: '919876543210', email: 'hi@example.in', address: 'Kolkata', hours: '9-6',
  stat_value_0: '10', stat_label_0: 'Hires', jobCategories: 'Tech\nFinance\ntech', jobLocations: 'Pune',
  billing_feePercent: '8.33', billing_guaranteeDays: '90', billing_gstPercent: '18', billing_paymentDays: '15', billing_tdsPercent: '10',
};

test('settings: valid input saves, duplicate categories are dropped', () => {
  const { settings, errors } = content.parseSettings(validSettings, { name: 'Hireriv' });
  assert.deepEqual(errors, []);
  assert.deepEqual(settings.jobCategories, ['Tech', 'Finance']);
  assert.equal(settings.social.linkedin, '#');
});

test('settings: rejects unsafe links and malformed tax IDs', () => {
  const { errors } = content.parseSettings({ ...validSettings, social_linkedin: 'javascript:alert(1)', billing_gstin: '123', billing_pan: 'abc', billing_gstPercent: '15', whatsapp: '12345' }, { name: 'Hireriv' });
  for (const e of ['linkedin link must start with https://', 'GSTIN should be 15 characters (e.g. 29ABCDE1234F1Z5)', 'PAN should look like ABCDE1234F', 'GST rate must be 0, 5, 12, 18 or 28%']) {
    assert.ok(errors.includes(e), e);
  }
  assert.ok(errors.some((e) => e.startsWith('WhatsApp number')));
});

test('blog posts: slug from title, paragraphs from blank lines, unique links', () => {
  const { post, errors } = content.parsePost({ title: 'Café Hiring Tips!', excerpt: 'x', body: 'One\nline.\n\nTwo.' }, [], null);
  assert.deepEqual(errors, []);
  assert.equal(post.slug, 'cafe-hiring-tips');
  assert.deepEqual(post.body, ['One line.', 'Two.']);

  const dup = content.parsePost({ title: 'Café Hiring Tips', excerpt: 'x', body: 'y' }, [{ slug: 'cafe-hiring-tips' }], null);
  assert.ok(dup.errors.some((e) => e.includes('already uses')));
  // Editing the same post keeps its own slug.
  assert.deepEqual(content.parsePost({ title: 'Café Hiring Tips', excerpt: 'x', body: 'y' }, [{ slug: 'cafe-hiring-tips' }], 'cafe-hiring-tips').errors, []);
});

// ---------- matching ----------
test('skill match does not confuse Java with JavaScript', () => {
  const job = { skills: ['Java', 'Node.js', 'C++'] };
  const m = skillMatch({ skills: 'JavaScript, node.js, c++' }, job);
  assert.deepEqual(m.matched, ['Node.js', 'C++']);
  assert.deepEqual(m.missing, ['Java']);
  assert.equal(m.score, 67);
  assert.equal(skillMatch({ skills: 'x' }, { skills: [] }), null);
});

test('skills found only in the resume still count', () => {
  const m = skillMatch({ skills: '', resumeSkills: ['Terraform'] }, { skills: ['Terraform'] });
  assert.equal(m.score, 100);
});

test('talent pool merges candidates by email and searches resume text', () => {
  const pool = buildPool([
    { email: 'A@x.in', name: 'Asha', jobTitle: 'Dev', skills: 'React', createdAt: '2026-01-01' },
    { email: 'a@x.in', name: 'Asha K', jobTitle: 'Lead', skills: 'Node', createdAt: '2026-02-01', resumeText: 'Worked with Kafka' },
    { email: 'b@x.in', name: 'Bo', jobTitle: 'QA', skills: 'Selenium', createdAt: '2026-01-15' },
  ]);
  assert.equal(pool.length, 2);
  const asha = pool.find((c) => c.email.toLowerCase() === 'a@x.in');
  assert.equal(asha.name, 'Asha K');
  assert.equal(asha.applicationCount, 2);
  assert.deepEqual(asha.jobsApplied, ['Dev', 'Lead']);
  assert.equal(asha.skills, 'React, Node');
  assert.deepEqual(searchPool(pool, { q: 'kafka' }).map((c) => c.name), ['Asha K']);
});

// ---------- resume reading ----------
test('resume analysis finds contact details, experience and skills', () => {
  const text = 'Priya Sharma\nSenior Engineer\npriya.s@Mail.com | +91 98765-43210\nlinkedin.com/in/priya-s\n6.5 years of experience with React and AWS';
  const r = analyze(text, ['React']);
  assert.equal(r.name, 'Priya Sharma');
  assert.equal(r.email, 'priya.s@mail.com');
  assert.equal(r.phone, '+919876543210');
  assert.equal(r.linkedin, 'https://linkedin.com/in/priya-s');
  assert.equal(r.experience, '5-10 years');
  assert.ok(r.skills.includes('React') && r.skills.includes('AWS'));
  assert.deepEqual(analyze('').skills, []);
});

// ---------- stage history ----------
test('stage moves are recorded once and count towards reports', () => {
  const a = { status: 'New', createdAt: '2026-10-01T00:00:00Z' };
  assert.equal(history.moveStage(a, 'Screening', 'Asha', '2026-10-03T00:00:00Z'), true);
  assert.equal(history.moveStage(a, 'Screening', 'Asha'), false);
  history.moveStage(a, 'Rejected', 'Asha', '2026-10-04T00:00:00Z');
  assert.equal(a.history.length, 2);
  assert.equal(history.everReached(a, 'Screening'), true);
  assert.equal(history.everReached(a, 'Interview'), false);
  assert.equal(history.firstResponseDays(a), 2);
  assert.equal(history.timeline({ ...a, jobTitle: 'Dev' })[0].text, 'Screening → Rejected');
});

// ---------- timesheets ----------
test('working days and timesheet month summaries', () => {
  assert.equal(timesheets.workingDaysInMonth('2026-02'), 20);
  assert.equal(timesheets.mondayOf('2026-10-18'), '2026-10-12'); // a Sunday
  const p = { timesheets: [
    { status: 'Approved', days: { '2026-09-29': 1, '2026-09-30': 0.5, '2026-10-01': 1 } },
    { status: 'Submitted', days: { '2026-10-06': 1, '2026-10-07': 1 } },
    { status: 'Rejected', days: { '2026-10-13': 1 } },
  ] };
  assert.deepEqual(timesheets.monthSummary(p, '2026-10'), { approvedDays: 1, pendingDays: 2, approvedWeeks: 1, pendingWeeks: 1, rejectedWeeks: 1 });
  assert.equal(timesheets.monthSummary(p, '2026-09').approvedDays, 1.5);
});

// ---------- SEO ----------
test('salary text becomes a Google for Jobs salary range', () => {
  assert.deepEqual(seo.parseSalary('₹14 – 20 LPA'), { min: 1400000, max: 2000000 });
  assert.deepEqual(seo.parseSalary('₹2.5 – 4 LPA + incentives'), { min: 250000, max: 400000 });
  assert.equal(seo.parseSalary('Competitive'), null);
});

test('job structured data and sitemap escape and include what they should', () => {
  const job = { id: 'j1', title: 'Dev <Lead>', description: 'A & B', responsibilities: [], skills: ['Go'], posted: '2026-10-01', type: 'Full-time', mode: 'Remote', location: 'Remote', category: 'Technology', salary: '' };
  const ld = seo.jobPosting(job, { name: 'Hireriv', social: {} }, 'https://hireriv.com');
  assert.equal(ld.jobLocationType, 'TELECOMMUTE');
  assert.match(ld.description, /A &amp; B/);
  assert.equal(seo.toJsonLd({ t: '</script>' }).includes('</script>'), false);
  const xml = seo.sitemap('https://hireriv.com', { jobs: [job], posts: [], staticPaths: ['/'] });
  assert.match(xml, /<loc>https:\/\/hireriv.com\/jobs\/j1<\/loc><lastmod>2026-10-01<\/lastmod>/);
});

test('validThrough uses the closing date, and is left out once an undated job is old', () => {
  const site = { name: 'Hireriv', social: {} };
  const job = { id: 'j1', title: 'Dev', description: 'x', responsibilities: [], skills: [], type: 'Full-time', mode: 'On-site', location: 'Pune', category: 'Technology', salary: '' };
  const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
  assert.equal(seo.jobPosting({ ...job, posted: day(-5), closesOn: '2026-12-31' }, site, '').validThrough, '2026-12-31T23:59:59+05:30');
  assert.equal(seo.jobPosting({ ...job, posted: day(-5) }, site, '').validThrough, day(55));
  assert.equal('validThrough' in seo.jobPosting({ ...job, posted: day(-90) }, site, ''), false);
});

// ---------- share images ----------
const og = require('../og');

test('share image titles wrap, shrink to fit and never overflow', () => {
  assert.deepEqual(og.fit('Data Scientist', 1056, 3, [68, 60]).lines, ['Data Scientist']);
  const long = og.fit('Senior Principal Site Reliability Engineer – Payments Infrastructure & Platform Observability (Hybrid) for a Global Bank', 1056, 3, [68, 60, 54, 48]);
  assert.equal(long.lines.length, 3);
  assert.equal(long.size, 48);
  assert.ok(long.lines[2].endsWith('…'));
  // A single word too long for the line is cut rather than spilling off the image.
  assert.ok(og.wrap('x'.repeat(200), 68, 1056, 3)[0].endsWith('…'));
});

test('share image text is escaped', () => {
  const svg = og.jobSvg({ title: 'R&D <Lead>', company: 'A "B"', location: 'Pune', mode: 'Remote', type: 'Full-time' }, {}, 'hireriv.com');
  assert.match(svg, /R&amp;D &lt;Lead&gt;/);
  assert.doesNotMatch(svg, /<Lead>/);
});

// ---------- data retention ----------
const retention = require('../retention');

test('retention: last activity looks at every kind of event', () => {
  const a = { createdAt: '2024-01-01T00:00:00Z', history: [{ at: '2024-03-01T00:00:00Z' }], interviews: [{ createdAt: '2024-02-01T00:00:00Z', at: '2024-04-01T00:00:00Z', feedback: [{ at: '2024-05-01T00:00:00Z' }] }], shared: { sharedAt: '2024-02-15T00:00:00Z' } };
  assert.equal(retention.lastActivity(a), '2024-05-01T00:00:00Z');
});

test('retention: only inactive candidates without active placements or interviews are due', () => {
  const now = new Date('2026-10-16T00:00:00Z');
  const old = '2024-01-01T00:00:00Z';
  const apps = [
    { id: '1', email: 'old@x.in', createdAt: old },
    { id: '2', email: 'Mixed@x.in', createdAt: old },
    { id: '3', email: 'mixed@x.in', createdAt: '2026-09-01T00:00:00Z' }, // recent application keeps the person
    { id: '4', email: 'placed@x.in', createdAt: old },
    { id: '5', email: 'interview@x.in', createdAt: old, interviews: [{ status: 'scheduled', at: '2026-11-01T10:00:00Z' }] },
    { id: '6', email: 'left@x.in', createdAt: old },
  ];
  const placements = [{ candidateEmail: 'placed@x.in', status: 'Joined' }, { candidateEmail: 'left@x.in', status: 'Left in guarantee' }];
  const due = retention.candidatesDue(apps, placements, { months: 24, now });
  assert.deepEqual(due.map((c) => c.email).sort(), ['left@x.in', 'old@x.in']);
  assert.deepEqual(retention.candidatesDue(apps, placements, { months: 0, now }), []);
  // 36 months back from Oct 2026 is Oct 2023, so January 2024 is not due yet.
  assert.deepEqual(retention.candidatesDue(apps, placements, { months: 36, now }), []);
});

test('retention: settings accept only the offered periods', () => {
  assert.equal(content.parseSettings({ ...validSettings, retentionMonths: '24' }, { name: 'H' }).settings.retentionMonths, 24);
  assert.ok(content.parseSettings({ ...validSettings, retentionMonths: '5' }, { name: 'H' }).errors.includes('data retention must be off, 12, 24 or 36 months'));
});
