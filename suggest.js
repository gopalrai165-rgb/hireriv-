// Search suggestions as you type (GET /api/suggest): job titles, skills,
// categories and cities from the live jobs, matched at the start of any word
// first and anywhere second. Words typed in Hindi or Telugu are matched as the
// English words the jobs use (i18n.searchTerms), so "ड्राइवर" suggests
// "Driver". Only public listing words are returned, never anything about
// people, and the typed text is not stored.
const MAX = 8;
const MIN_CHARS = 2;

const norm = (s) => String(s || '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();

// 2 = a word starts with the text, 1 = contains it, 0 = no match (`t` is
// already normalised).
function matchScore(t, q) {
  if (!q || !t.includes(q)) return 0;
  return t.startsWith(q) || t.includes(` ${q}`) ? 2 : 1;
}

// Every candidate word, with how many live jobs use it. `jobs`: live, public
// jobs. `cities`, `categories`: the site's lists. The server keeps the result
// until the jobs change, instead of building it on every keystroke.
function buildPool({ jobs = [], cities = [], categories = [] } = {}) {
  const pool = new Map();
  const add = (type, text, weight = 1) => {
    const key = `${type}:${norm(text)}`;
    if (!text) return;
    const e = pool.get(key) || { type, text: String(text).trim(), count: 0, weight };
    e.count++;
    pool.set(key, e);
  };
  for (const j of jobs) {
    add('title', j.title, 3);
    for (const s of j.skills || []) add('skill', s, 2);
    add('category', j.category, 2);
    if (j.location && j.location !== 'Multiple locations') add('city', j.location, 2);
  }
  // Cities and categories with no live job yet still help people search.
  for (const c of cities) if (c !== 'Multiple locations' && !pool.has(`city:${norm(c)}`)) pool.set(`city:${norm(c)}`, { type: 'city', text: c, count: 0, weight: 1 });
  for (const c of categories) if (!pool.has(`category:${norm(c)}`)) pool.set(`category:${norm(c)}`, { type: 'category', text: c, count: 0, weight: 1 });
  return [...pool.values()].map((e) => ({ ...e, n: norm(e.text) }));
}

// `pool` from buildPool, or the jobs, cities and categories to build one from.
// `translate(q)`: { q, location } from i18n.searchTerms, or null.
function suggestions(input, { pool = null, jobs = [], cities = [], categories = [], translate = null } = {}) {
  const raw = norm(input).slice(0, 60);
  if (raw.length < MIN_CHARS) return [];
  const t = translate ? translate(raw) : null;
  const queries = [...new Set([raw, t && t.changed ? norm(t.q) : '', t && t.location ? norm(t.location) : ''].filter((x) => x.length >= MIN_CHARS))];
  const scored = [];
  for (const e of pool || buildPool({ jobs, cities, categories })) {
    const best = Math.max(...queries.map((q) => matchScore(e.n, q)));
    if (best) scored.push({ ...e, score: best * 10 + e.weight + Math.min(e.count, 20) / 10 });
  }
  scored.sort((a, b) => b.score - a.score || a.text.localeCompare(b.text));
  return scored.slice(0, MAX).map(({ type, text, count }) => ({ type, text, count, href: hrefFor(type, text) }));
}

function hrefFor(type, text) {
  const v = encodeURIComponent(text);
  if (type === 'city') return `/jobs?location=${v}`;
  if (type === 'category') return `/jobs?category=${v}`;
  if (type === 'skill') return `/jobs?skill=${v}`;
  return `/jobs?q=${v}`;
}

module.exports = { suggestions, buildPool, MAX, MIN_CHARS };
