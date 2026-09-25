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
  return { settings: next, errors };
}

module.exports = { parsePost, slugify, parseSettings, SOCIAL };
