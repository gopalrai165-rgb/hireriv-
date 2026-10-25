// Interface languages (Step 67). Translations live in version-controlled
// locale files (locales/<code>.json) with stable keys, so a page never holds
// the words themselves; a missing key falls back to English, then to the key.
//
// Which language a page uses, in order:
//   1. ?lang=xx on the address (also remembered, so shared links work);
//   2. the hr_lang cookie the language selector sets (anonymous visitors too);
//   3. the language saved on a signed-in candidate's account;
//   4. English.
// The browser's Accept-Language is never used to switch a page by itself.
//
// Search terms people type in Hindi or Telugu ("ड्राइवर", "హైదరాబాద్") are
// mapped to the English words jobs are written in (searchTerms below), so
// search works whatever language the interface is in.
const fs = require('fs');
const path = require('path');

// Every language Hireriv plans to support. A language is offered in the
// selector when it is listed in LANGUAGES (default "en,hi") and has a locale
// file. The others are listed here so adding one needs no code changes.
const LANGUAGES = {
  en: { name: 'English', native: 'English', tag: 'en-IN', script: 'Latn' },
  hi: { name: 'Hindi', native: 'हिन्दी', tag: 'hi-IN', script: 'Deva', font: 'Noto+Sans+Devanagari:wght@400;500;600;700' },
  te: { name: 'Telugu', native: 'తెలుగు', tag: 'te-IN', script: 'Telu', font: 'Noto+Sans+Telugu:wght@400;500;600;700' },
  ta: { name: 'Tamil', native: 'தமிழ்', tag: 'ta-IN', script: 'Taml', font: 'Noto+Sans+Tamil:wght@400;500;600;700' },
  bn: { name: 'Bengali', native: 'বাংলা', tag: 'bn-IN', script: 'Beng', font: 'Noto+Sans+Bengali:wght@400;500;600;700' },
  mr: { name: 'Marathi', native: 'मराठी', tag: 'mr-IN', script: 'Deva', font: 'Noto+Sans+Devanagari:wght@400;500;600;700' },
};
const DEFAULT = 'en';
const COOKIE = 'hr_lang';
const YEAR = 365 * 86400000;
const DIR = path.join(__dirname, 'locales');

function loadLocales(dir = DIR) {
  const out = {};
  for (const code of Object.keys(LANGUAGES)) {
    const file = path.join(dir, `${code}.json`);
    if (fs.existsSync(file)) out[code] = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  return out;
}
const LOCALES = loadLocales();

// The languages offered in the selector, English always first.
function offered(env = process.env) {
  const asked = String(env.LANGUAGES || 'en,hi').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return [DEFAULT, ...asked.filter((c) => c !== DEFAULT)].filter((c, i, a) => LANGUAGES[c] && LOCALES[c] && a.indexOf(c) === i);
}

const get = (obj, key) => key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Values given as html(…) go into th() output as they are; everything else is escaped.
const html = (s) => ({ __html: String(s) });

function translator(code) {
  const lang = LOCALES[code] ? code : DEFAULT;
  const L = LOCALES[lang];
  const EN = LOCALES[DEFAULT];
  const info = LANGUAGES[lang];
  const plural = new Intl.PluralRules(info.tag);
  const raw = (key) => {
    const v = get(L, key);
    return v === undefined ? get(EN, key) : v;
  };
  const fill = (s, vars, escape) => String(s).replace(/\{(\w+)\}/g, (m, k) => {
    if (!vars || vars[k] === undefined || vars[k] === null) return m;
    const v = vars[k];
    if (v && typeof v === 'object' && '__html' in v) return escape ? v.__html : v.__html.replace(/<[^>]*>/g, '');
    return escape ? esc(v) : String(v);
  });
  const pick = (v, vars) => {
    if (v && typeof v === 'object' && !Array.isArray(v) && ('other' in v)) {
      const n = Number(vars && vars.count);
      return v[plural.select(Number.isFinite(n) ? n : 0)] || v.other;
    }
    return v;
  };
  // t('nav.findJobs'), t('jobs.found', { count: 3 }): plain text (EJS escapes it).
  function t(key, vars) {
    const v = pick(raw(key), vars);
    return typeof v === 'string' ? fill(v, vars, false) : key;
  }
  // The same, as HTML: the text is escaped and html(...) values are kept.
  function th(key, vars) {
    const v = pick(raw(key), vars);
    return typeof v === 'string' ? fill(esc(v), vars, true) : esc(key);
  }
  // A stored English value (a job type, a shift, a category) in this language.
  // The stored value never changes, so filters and records stay the same.
  function tv(group, value) {
    if (value === undefined || value === null || value === '') return '';
    const v = get(L, `values.${group}`);
    return (v && typeof v[value] === 'string' && v[value]) || String(value);
  }
  // Messages that the server builds in English (errors, notices, page titles).
  // Unknown messages are shown as they are.
  function tm(text) {
    const s = String(text == null ? '' : text);
    if (lang === DEFAULT || !s) return s;
    const phrases = L.phrases || {};
    if (phrases[s]) return phrases[s];
    // "a, b" lists of errors, translated one by one.
    if (s.includes(', ')) {
      const parts = s.split(', ');
      if (parts.every((p) => phrases[p])) return parts.map((p) => phrases[p]).join(', ');
    }
    return s;
  }
  const number = (n, opts) => new Intl.NumberFormat(info.tag, { numberingSystem: 'latn', ...opts }).format(n);
  const date = (d, opts = { day: 'numeric', month: 'short', year: 'numeric' }) => new Date(d).toLocaleDateString(info.tag, { numberingSystem: 'latn', ...opts });
  // Rupees always in Indian digit grouping (₹1,20,000), whatever the language,
  // so amounts read the same in every version of a page.
  const inr = (n) => Math.round(n).toLocaleString('en-IN');
  const lakhs = (n) => `${Number((n / 100000).toFixed(2))}`;
  // Pay from the job's numbers, in this language. English keeps search.payText's wording.
  function pay(p) {
    if (!p || !(p.min || p.max)) return '';
    const { min, max, period } = p;
    const lpa = period === 'year' && (min || max) >= 100000;
    const amount = (n) => (lpa ? lakhs(n) : inr(n));
    const unit = lpa ? t('pay.lpa') : t(`pay.per.${period}`);
    if (min && max && min !== max) return t('pay.range', { min: amount(min), max: amount(max), unit }).trim();
    return t(min && !max ? 'pay.from' : !min ? 'pay.upTo' : 'pay.exact', { amount: amount(min || max), unit }).trim();
  }
  function daysAgo(d) {
    const days = Math.floor((Date.now() - new Date(d)) / 86400000);
    return days <= 0 ? t('time.today') : t('time.daysAgo', { count: days });
  }
  // The strings the page scripts need, for this language only.
  const scriptStrings = () => ({ ...(EN.js || {}), ...(L.js || {}) });
  // Lists and other structured entries (the glossary), with English as the fallback.
  const list = (key) => { const v = raw(key); return Array.isArray(v) ? v : []; };
  return { code: lang, info, t, th, tv, tm, number, date, pay, daysAgo, scriptStrings, html, esc, list };
}
const translators = new Map();
const translatorFor = (code) => {
  if (!translators.has(code)) translators.set(code, translator(code));
  return translators.get(code);
};

// ---------- search in other languages ----------
// "ड्राइवर दिल्ली" → { q: 'driver', location: 'Delhi' }. Every locale's search
// words are used, whatever the interface language. Native digits become 0-9,
// and invisible joiners (which only change how letters are drawn) are dropped.
const DIGITS = '०१२३४५६७८९౦౧౨౩౪౫౬౭౮౯';
const normalise = (s) => String(s || '').normalize('NFC').replace(/[\u200b-\u200d\u2060\ufeff]/g, '').replace(/[\u0966-\u096f\u0c66-\u0c6f]/g, (d) => String(DIGITS.indexOf(d) % 10)).toLowerCase();
let searchIndex = null;
function buildSearchIndex() {
  const terms = new Map(); // native phrase → English words, or "type:Part-time" style filters
  const places = new Map(); // native place name → the place as jobs store it
  const stop = new Set();
  for (const L of Object.values(LOCALES)) {
    const s = L.search || {};
    for (const [k, v] of Object.entries(s.terms || {})) terms.set(normalise(k), v);
    for (const [k, v] of Object.entries(s.places || {})) places.set(normalise(k), v);
    for (const w of s.ignore || []) stop.add(normalise(w));
    // Translated category names are search words; job types, work arrangements
    // and shifts become filters.
    for (const [en, local] of Object.entries((L.values || {}).category || {})) if (local && local !== en) terms.set(normalise(local), en.toLowerCase());
    for (const group of ['type', 'mode', 'shift']) {
      for (const [en, local] of Object.entries((L.values || {})[group] || {})) if (local && local !== en) terms.set(normalise(local), `${group}:${en}`);
    }
  }
  const phrases = [...terms.keys(), ...places.keys()].sort((a, b) => b.length - a.length);
  return { terms, places, stop, phrases };
}
// The English keywords, plus filters for what was named in another language:
// a place, a job type, a work arrangement or a shift. Text already in English
// is left exactly as it is.
function searchTerms(q) {
  if (!searchIndex) searchIndex = buildSearchIndex();
  const { terms, places, stop, phrases } = searchIndex;
  const found = { location: '', type: '', mode: '', shift: '' };
  let rest = ` ${normalise(q).replace(/[,;|]+/g, ' ').replace(/\s+/g, ' ')} `;
  if (!/[^\x00-\x7f]/.test(rest)) return { q: String(q || ''), ...found, changed: false };
  const out = [];
  for (const p of phrases) {
    const needle = ` ${p} `;
    while (rest.includes(needle)) {
      const v = terms.has(p) ? terms.get(p) : `location:${places.get(p)}`;
      const m = v.match(/^(location|type|mode|shift):(.+)$/);
      if (!m) out.push(v);
      else if (!found[m[1]]) found[m[1]] = m[2];
      rest = rest.replace(needle, ' ');
    }
  }
  const left = rest.split(' ').filter((w) => w && !stop.has(w));
  const english = [...out, ...left].join(' ').replace(/\s+/g, ' ').trim();
  return { q: english, ...found, changed: true };
}

// ---------- the request ----------
const parseCookie = (header, name) => {
  const m = String(header || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : '';
};
// An address on this site to go back to after choosing a language.
function safeBack(value) {
  const s = String(value || '');
  if (!s || s.length > 500 || s[0] !== '/' || s.startsWith('//') || /[\\\s\x00-\x1f]/.test(s)) return '/';
  try {
    const u = new URL(s, 'http://hireriv.invalid');
    if (u.host !== 'hireriv.invalid') return '/';
    u.searchParams.delete('lang');
    return u.pathname + (u.search === '?' ? '' : u.search) + u.hash;
  } catch (e) {
    return '/';
  }
}
// The address of this page in another language (?lang=xx, or none for English).
function urlIn(url, code) {
  const u = new URL(url, 'http://hireriv.invalid');
  u.searchParams.delete('lang');
  if (code && code !== DEFAULT) u.searchParams.set('lang', code);
  const out = u.host === 'hireriv.invalid' ? u.pathname + u.search : u.toString();
  return out;
}

function create({ env = process.env, secure = false, preferenceOf = () => '', savePreference = () => {}, track = () => {}, sameOrigin, limit } = {}) {
  const codes = offered(env);
  const languages = codes.map((c) => ({ code: c, ...LANGUAGES[c] }));
  const isOffered = (c) => codes.includes(c);
  const remember = (res, code) => res.cookie(COOKIE, code, { maxAge: YEAR, httpOnly: true, sameSite: 'lax', secure, path: '/' });

  function localeOf(req, res) {
    const asked = String((req.query && req.query.lang) || '').toLowerCase();
    if (asked && isOffered(asked)) {
      if (req.method === 'GET' && parseCookie(req.headers.cookie, COOKIE) !== asked) remember(res, asked);
      return { code: asked, fromQuery: true };
    }
    const saved = parseCookie(req.headers.cookie, COOKIE);
    if (isOffered(saved)) return { code: saved, fromQuery: false };
    const pref = preferenceOf(req);
    if (pref && isOffered(pref)) {
      remember(res, pref);
      return { code: pref, fromQuery: false };
    }
    return { code: DEFAULT, fromQuery: false };
  }

  function middleware(req, res, next) {
    const { code, fromQuery } = localeOf(req, res);
    const tr = translatorFor(code);
    req.locale = code;
    req.t = tr;
    if (req.method === 'GET') res.vary('Cookie');
    Object.assign(res.locals, {
      locale: code, langInfo: tr.info, languages, langFromQuery: fromQuery,
      t: tr.t, th: tr.th, tv: tr.tv, tm: tr.tm, html: tr.html, fmtNumber: tr.number, payLabel: (job) => (job.pay && code !== DEFAULT ? tr.pay(job.pay) : job.salary || ''),
      formatDate: (d) => tr.date(d), daysAgo: tr.daysAgo, urlIn, scriptStrings: tr.scriptStrings, esc, tlist: tr.list,
      currentPath: req.originalUrl,
      // Another language's words, for pages shown in several at once (offline).
      tIn: (lang, key, vars) => translatorFor(isOffered(lang) ? lang : DEFAULT).t(key, vars),
      tlistIn: (lang, key) => translatorFor(isOffered(lang) ? lang : DEFAULT).list(key),
    });
    next();
  }

  function register(app) {
    // The language selector (a form, so it works without JavaScript).
    app.post('/language', limit('language', 60), sameOrigin, (req, res) => {
      const code = String((req.body && req.body.lang) || '').toLowerCase();
      const back = safeBack(req.body && req.body.back);
      if (!isOffered(code)) return res.redirect(303, back);
      remember(res, code);
      try { savePreference(req, code); } catch (e) { /* the cookie still remembers it */ }
      track('language-selected', code, req);
      res.redirect(303, back);
    });
  }
  return { middleware, register, languages, isOffered, translatorFor, codes };
}

module.exports = { create, LANGUAGES, LOCALES, DEFAULT, COOKIE, offered, translator: translatorFor, searchTerms, normalise, safeBack, urlIn, loadLocales, esc };
