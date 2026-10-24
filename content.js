// Blog post helpers for the admin editor.

const slugify = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

// Paragraphs are separated by a blank line in the editor.
const toParagraphs = (text) =>
  String(text || '')
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.replace(/\s*\r?\n\s*/g, ' ').trim())
    .filter(Boolean);

function parsePost(body, posts, currentSlug) {
  const f = {};
  for (const k of ['title', 'slug', 'category', 'date', 'excerpt', 'body', 'status']) f[k] = String(body[k] ?? '').trim();
  const errors = [];
  const post = {
    slug: slugify(f.slug || f.title),
    title: f.title.slice(0, 200),
    date: /^\d{4}-\d{2}-\d{2}$/.test(f.date) ? f.date : new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }),
    category: f.category.slice(0, 60) || 'Insights',
    excerpt: f.excerpt.slice(0, 300),
    body: toParagraphs(f.body.slice(0, 50000)),
    status: f.status === 'draft' ? 'draft' : 'published',
  };
  if (!post.title) errors.push('title is required');
  if (!post.slug) errors.push('slug is required');
  if (!post.excerpt) errors.push('summary is required');
  if (!post.body.length) errors.push('article text is required');
  if (post.slug && posts.some((p) => p.slug === post.slug && p.slug !== currentSlug)) errors.push(`another article already uses the link /blog/${post.slug}`);
  return { post, errors };
}

// Site settings form → the shape of data/site.json. Links must be http(s) so a
// saved value can never become a javascript: URL in the footer.
const SOCIAL = ['linkedin', 'instagram', 'facebook', 'x'];

// Job categories offered on the job form, the Find Work filters and job alerts.
// Editable in Admin → Settings; this list is used until they are saved.
const DEFAULT_JOB_CATEGORIES = [
  'Technology', 'Finance & Accounting', 'Banking & Insurance', 'Sales & Business Development',
  'Marketing & Creative', 'Human Resources', 'Logistics & Operations', 'Engineering & Manufacturing',
  'Healthcare & Pharma', 'Customer Support & BPO', 'Retail & E-commerce', 'Education & Training',
  'Legal & Compliance', 'Admin & Office Support', 'Construction & Real Estate', 'Hospitality & Travel',
  // Skilled, industrial, field and service work (added in Step 41).
  'Skilled Trades', 'Technicians & Field Service', 'Healthcare Technicians & Nursing',
  'Factory & Production', 'Warehouse & Packing', 'Delivery & Driving', 'Construction & Site Work',
  'Security Services', 'Housekeeping & Facility Services', 'Hotel & Restaurant Staff', 'Store & Counter Staff',
  'Domestic Help & Caregiving', 'Events & Promotions', 'Agriculture & Farm Work',
];

// Kinds of work, so office jobs and shop-floor jobs are both easy to find.
// Each job gets one from its category unless the job form picks another.
const WORK_KINDS = [
  { key: 'office', label: 'Office & professional', examples: 'Developers, accountants, sales, HR, marketing, managers' },
  { key: 'skilled', label: 'Skilled & technical', examples: 'Electricians, welders, CNC operators, field technicians, lab and nursing staff' },
  { key: 'field', label: 'Industrial, field & service', examples: 'Factory, warehouse, delivery, drivers, security, housekeeping, kitchen, store staff' },
];
const WORK_KEYS = WORK_KINDS.map((c) => c.key);
const CATEGORY_WORK = {
  'Skilled Trades': 'skilled', 'Technicians & Field Service': 'skilled', 'Healthcare Technicians & Nursing': 'skilled',
  'Factory & Production': 'field', 'Warehouse & Packing': 'field', 'Delivery & Driving': 'field', 'Construction & Site Work': 'field',
  'Security Services': 'field', 'Housekeeping & Facility Services': 'field', 'Hotel & Restaurant Staff': 'field', 'Store & Counter Staff': 'field',
  'Domestic Help & Caregiving': 'field', 'Events & Promotions': 'field', 'Agriculture & Farm Work': 'field',
};
// Categories added in Settings count as office work unless a job says otherwise.
const workOfCategory = (category) => CATEGORY_WORK[category] || 'office';
const workOf = (job) => (WORK_KEYS.includes(job.work) ? job.work : workOfCategory(job.category));

// Category groups for the homepage tiles and the Job Categories page. A group
// is a set of categories, or a rule (kind of work, freshers).
const isFresherJob = (job) => ['Internship', 'Apprenticeship'].includes(job.type) || /fresher|no experience|^\s*0\s*[-–]\s*[12]\b/i.test(job.experience || '');
const JOB_GROUPS = [
  { key: 'office', label: 'Office jobs', icon: 'i-briefcase', text: 'Professional, desk and management roles', match: (j) => workOf(j) === 'office' },
  { key: 'skilled-field', label: 'Skilled & field jobs', icon: 'i-truck', text: 'Trades, technicians, factory, delivery and service work', match: (j) => workOf(j) !== 'office' },
  { key: 'it-engineering', label: 'IT & Engineering', icon: 'i-code', categories: ['Technology', 'Engineering & Manufacturing'] },
  { key: 'healthcare', label: 'Healthcare', icon: 'i-health', categories: ['Healthcare & Pharma', 'Healthcare Technicians & Nursing'] },
  { key: 'manufacturing', label: 'Manufacturing', icon: 'i-gear', categories: ['Factory & Production', 'Engineering & Manufacturing', 'Skilled Trades'] },
  { key: 'logistics', label: 'Logistics & Delivery', icon: 'i-truck', categories: ['Logistics & Operations', 'Warehouse & Packing', 'Delivery & Driving'] },
  { key: 'construction', label: 'Construction', icon: 'i-hardhat', categories: ['Construction & Real Estate', 'Construction & Site Work'] },
  { key: 'retail', label: 'Retail', icon: 'i-cart', categories: ['Retail & E-commerce', 'Store & Counter Staff'] },
  { key: 'hospitality', label: 'Hospitality', icon: 'i-utensils', categories: ['Hospitality & Travel', 'Hotel & Restaurant Staff'] },
  { key: 'sales', label: 'Sales', icon: 'i-target', categories: ['Sales & Business Development'] },
  { key: 'finance', label: 'Finance & Banking', icon: 'i-finance', categories: ['Finance & Accounting', 'Banking & Insurance'] },
  { key: 'freshers', label: 'Fresher jobs', icon: 'i-graduation', text: 'Internships, apprenticeships and no-experience roles', match: isFresherJob },
];
const inGroup = (group, job) => (group.match ? group.match(job) : group.categories.includes(job.category));

// Skilled and field jobs take a quick application (name and phone are enough);
// office jobs ask for a resume and email. The job form can override either way.
const RESUME_OPTIONS = ['required', 'optional'];
const resumeNeeded = (job) => !job || job.resume === 'required' || (job.resume !== 'optional' && workOf(job) === 'office');

// Job locations offered on the job form, the Find Work filter and job alerts.
const DEFAULT_JOB_LOCATIONS = [
  'Remote', 'Bengaluru', 'Mumbai', 'Navi Mumbai', 'Thane', 'Delhi', 'Delhi NCR', 'Gurugram', 'Noida',
  'Hyderabad', 'Chennai', 'Pune', 'Kolkata', 'Ahmedabad', 'Jaipur', 'Chandigarh', 'Kochi', 'Coimbatore',
  'Indore', 'Lucknow', 'Bhubaneswar', 'Nagpur', 'Visakhapatnam', 'Vadodara', 'Surat', 'Mysuru',
  'Thiruvananthapuram', 'Guwahati', 'Bhopal', 'Patna', 'Goa', 'Multiple locations',
];

// Shown on the homepage until real testimonials are saved in Admin → Settings.
const SAMPLE_TESTIMONIALS = [
  { quote: 'We needed eight engineers in a month. Hireriv sent a shortlist in three days, and every person we hired is still with us.', name: 'Head of Engineering', detail: 'Fintech startup', rating: 5 },
  { quote: 'Their recruiter understood what I wanted better than any job portal. I had two offers within three weeks.', name: 'Data Analyst', detail: 'Placed candidate', rating: 5 },
  { quote: 'The background verification and onboarding support took a huge load off our small HR team.', name: 'HR Manager', detail: 'Logistics company', rating: 5 },
];
const MAX_TESTIMONIALS = 6;

// Testimonials from the settings form. Saving other settings never replaces
// the samples by accident: rows left empty keep the samples until real ones
// are entered or the section is hidden on purpose.
function parseTestimonials(body, current, errors) {
  const get = (k, max) => String(body[k] ?? '').trim().slice(0, max);
  const list = [];
  for (let i = 0; i < MAX_TESTIMONIALS; i++) {
    const t = { quote: get(`testimonial_quote_${i}`, 400), name: get(`testimonial_name_${i}`, 80), detail: get(`testimonial_detail_${i}`, 80), rating: Number(get(`testimonial_rating_${i}`, 1)) || 5 };
    if (!t.quote && !t.name && !t.detail) continue;
    if (!t.quote) errors.push(`testimonial ${i + 1} needs the quote`);
    if (!t.name) errors.push(`testimonial ${i + 1} needs a name or role`);
    if (![1, 2, 3, 4, 5].includes(t.rating)) t.rating = 5;
    list.push(t);
  }
  if (body.testimonials_hide === '1') return [];
  if (list.length) return list;
  return Array.isArray(current) ? [] : undefined; // cleared real ones hide the section; samples stay until replaced
}

// One entry per line, trimmed, without case-insensitive duplicates.
function parseList(text, maxLen, maxItems) {
  const seen = new Set();
  return String(text ?? '')
    .split(/\r?\n/)
    .map((c) => c.trim().slice(0, maxLen))
    .filter((c) => c && !seen.has(c.toLowerCase()) && seen.add(c.toLowerCase()))
    .slice(0, maxItems);
}

function parseSettings(body, current) {
  const get = (k, max = 200) => String(body[k] ?? '').trim().slice(0, max);
  const errors = [];
  const next = {
    ...current,
    tagline: get('tagline', 160) || current.tagline,
    phone: get('phone', 40),
    whatsapp: get('whatsapp', 20).replace(/[^\d]/g, ''),
    email: get('email', 120),
    address: get('address', 240),
    hours: get('hours', 120),
    social: {},
    stats: [],
  };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(next.email)) errors.push('email is invalid');
  if (!/^\d{10,15}$/.test(next.whatsapp)) errors.push('WhatsApp number needs the country code, digits only (e.g. 919876543210)');
  if (!next.phone) errors.push('phone is required');
  for (const k of SOCIAL) {
    const url = get(`social_${k}`, 300);
    if (url && !/^https?:\/\/[^\s"'<>]+$/i.test(url)) errors.push(`${k} link must start with https://`);
    next.social[k] = url || '#';
  }
  for (let i = 0; i < 4; i++) {
    const value = Number(get(`stat_value_${i}`, 12));
    const label = get(`stat_label_${i}`, 40);
    if (!label) continue;
    if (!Number.isFinite(value) || value < 0) errors.push(`stat ${i + 1} needs a number`);
    next.stats.push({ value: Math.round(value) || 0, suffix: get(`stat_suffix_${i}`, 3), label });
  }
  if (!next.stats.length) errors.push('add at least one homepage stat');
  next.testimonials = parseTestimonials(body, current.testimonials, errors);
  if (next.testimonials === undefined) delete next.testimonials;
  next.jobCategories = parseList(body.jobCategories, 60, 50);
  if (!next.jobCategories.length) errors.push('add at least one job category');
  next.jobLocations = parseList(body.jobLocations, 60, 150);
  if (!next.jobLocations.length) errors.push('add at least one job location');
  // Billing details printed on invoices, and defaults for new placements.
  const num = (k) => Number(get(k, 12));
  next.billing = {
    legalName: get('billing_legalName', 160),
    gstin: get('billing_gstin', 15).toUpperCase(),
    pan: get('billing_pan', 10).toUpperCase(),
    stateName: get('billing_stateName', 60),
    bank: get('billing_bank', 400),
    feePercent: num('billing_feePercent'),
    guaranteeDays: num('billing_guaranteeDays'),
    gstPercent: num('billing_gstPercent'),
    paymentDays: num('billing_paymentDays'),
    tdsPercent: num('billing_tdsPercent'),
    autoReminders: body.billing_autoReminders === '1',
  };
  // Months of inactivity after which candidate data is deleted; 0 keeps it.
  next.retentionMonths = Number(get('retentionMonths', 3)) || 0;
  if (![0, 12, 24, 36].includes(next.retentionMonths)) errors.push('data retention must be off, 12, 24 or 36 months');
  const b = next.billing;
  if (b.gstin && !/^\d{2}[A-Z0-9]{13}$/.test(b.gstin)) errors.push('GSTIN should be 15 characters (e.g. 29ABCDE1234F1Z5)');
  if (b.pan && !/^[A-Z]{5}\d{4}[A-Z]$/.test(b.pan)) errors.push('PAN should look like ABCDE1234F');
  if (!(b.feePercent > 0 && b.feePercent <= 100)) errors.push('default fee % must be between 0 and 100');
  if (!Number.isInteger(b.guaranteeDays) || b.guaranteeDays < 0 || b.guaranteeDays > 365) errors.push('default guarantee must be 0–365 days');
  if (![0, 5, 12, 18, 28].includes(b.gstPercent)) errors.push('GST rate must be 0, 5, 12, 18 or 28%');
  if (!Number.isInteger(b.paymentDays) || b.paymentDays < 0 || b.paymentDays > 180) errors.push('payment terms must be 0–180 days');
  if (![0, 1, 2, 5, 10].includes(b.tdsPercent)) errors.push('usual TDS rate must be 0, 1, 2, 5 or 10%');
  return { settings: next, errors };
}

module.exports = { parsePost, slugify, parseSettings, SOCIAL, DEFAULT_JOB_CATEGORIES, DEFAULT_JOB_LOCATIONS, SAMPLE_TESTIMONIALS, MAX_TESTIMONIALS, WORK_KINDS, WORK_KEYS, CATEGORY_WORK, workOf, workOfCategory, RESUME_OPTIONS, resumeNeeded, JOB_GROUPS, inGroup, isFresherJob };
