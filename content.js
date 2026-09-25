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

module.exports = { parsePost, slugify };
