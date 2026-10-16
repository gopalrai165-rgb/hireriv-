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
    date: /^\d{4}-\d{2}-\d{2}$/.test(f.date) ? f.date : new Date().toISOString().slice(0, 10),
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
];

// Job locations offered on the job form, the Find Work filter and job alerts.
const DEFAULT_JOB_LOCATIONS = [
  'Remote', 'Bengaluru', 'Mumbai', 'Navi Mumbai', 'Thane', 'Delhi', 'Delhi NCR', 'Gurugram', 'Noida',
  'Hyderabad', 'Chennai', 'Pune', 'Kolkata', 'Ahmedabad', 'Jaipur', 'Chandigarh', 'Kochi', 'Coimbatore',
  'Indore', 'Lucknow', 'Bhubaneswar', 'Nagpur', 'Visakhapatnam', 'Vadodara', 'Surat', 'Mysuru',
  'Thiruvananthapuram', 'Guwahati', 'Bhopal', 'Patna', 'Goa', 'Multiple locations',
];

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

module.exports = { parsePost, slugify, parseSettings, SOCIAL, DEFAULT_JOB_CATEGORIES, DEFAULT_JOB_LOCATIONS };
