// Step 67: automated accessibility checks on the public and candidate pages,
// in English and Hindi. They catch what a machine can (labels, names, alt
// text, headings, language, focus order); keyboard and screen-reader checks
// by people are listed in docs/ACCESSIBILITY.md.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');
const { hashPassword } = require('../employers');
const cp = require('../candidate-profile');
const { jobPath } = require('../content');

const iso = () => new Date().toISOString();
const JOB = { id: 'j1', title: 'Store Helper', company: 'Shop Co', location: 'Pune', mode: 'On-site', type: 'Full-time', category: 'Retail & Sales', experience: 'Fresher', posted: '2026-10-20', skills: ['Stocking'], description: 'Keep shelves stocked.', responsibilities: ['Stock shelves'], status: 'open', sample: false };
let srv;
let meena;
let ip = 0;
const get = (url, cookie) => srv.request(url, { cookie, headers: { 'x-forwarded-for': `10.8.0.${++ip % 250}` } });

before(async () => {
  srv = await startServer({ TRUST_PROXY: '1' }, {
    jobs: [JOB],
    candidates: [{ id: 'c-1', email: 'meena@example.in', createdAt: iso(), emailVerifiedAt: iso(), passwordHash: hashPassword('meena long password'), profile: { ...cp.emptyProfile(), name: 'Meena' }, privacy: cp.defaultPrivacy(), comms: cp.defaultComms(), resumes: [], defaultResumeId: null }],
  });
  meena = srv.cookieFrom(await srv.request('/account/login', { method: 'POST', form: { email: 'meena@example.in', password: 'meena long password' } }));
});
after(async () => { await srv.stop(); });

const strip = (html) => html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<svg[\s\S]*?<\/svg>/g, '<svg></svg>');
const attr = (tag, name) => { const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`)); return m ? m[1] : null; };
const text = (s) => s.replace(/<[^>]+>/g, '').replace(/&[a-z#0-9]+;/g, 'x').trim();

function problems(raw) {
  const html = strip(raw);
  const out = [];
  if (!/<html lang="[a-z]{2}"/.test(raw)) out.push('no page language');
  const h1 = (html.match(/<h1[\s>]/g) || []).length;
  if (h1 !== 1) out.push(`${h1} h1 headings`);
  if (!/<main[\s>]/.test(html)) out.push('no main landmark');
  if (!/class="skip-link"|href="#main"/.test(html)) out.push('no skip link');
  for (const m of html.matchAll(/tabindex="(\d+)"/g)) if (Number(m[1]) > 0) out.push(`positive tabindex ${m[1]}`);
  for (const m of html.matchAll(/<img\b[^>]*>/g)) if (attr(m[0], 'alt') === null) out.push(`image without alt: ${m[0].slice(0, 80)}`);
  // Every form field has a name a screen reader can read.
  const labelled = new Set([...html.matchAll(/<label[^>]*\sfor="([^"]+)"/g)].map((m) => m[1]));
  const labelSpans = [];
  for (const m of html.matchAll(/<label\b[\s\S]*?<\/label>/g)) labelSpans.push([m.index, m.index + m[0].length]);
  for (const m of html.matchAll(/<(input|select|textarea)\b[^>]*>/g)) {
    const tag = m[0];
    const type = attr(tag, 'type') || '';
    if (['hidden', 'submit', 'button'].includes(type)) continue;
    if (attr(tag, 'name') === 'website' || /\shidden[\s>]/.test(tag)) continue; // the anti-spam field, and fields never shown
    const inLabel = labelSpans.some(([a, b]) => m.index > a && m.index < b);
    if (inLabel || labelled.has(attr(tag, 'id')) || attr(tag, 'aria-label') || attr(tag, 'aria-labelledby') || attr(tag, 'title')) continue;
    out.push(`field without a label: ${tag.slice(0, 100)}`);
  }
  // Every button and link says what it does.
  for (const m of html.matchAll(/<(button|a)\b([^>]*)>([\s\S]*?)<\/\1>/g)) {
    const [, kind, attrs, inner] = m;
    if (kind === 'a' && !/\shref=/.test(attrs)) continue;
    if (text(inner) || /aria-label="[^"]+"|aria-labelledby=|title="[^"]+"/.test(attrs)) continue;
    out.push(`${kind} without a name: ${m[0].slice(0, 100)}`);
  }
  // Status is never colour alone: pills always carry words.
  for (const m of html.matchAll(/<span class="pill[^"]*"[^>]*>([\s\S]*?)<\/span>/g)) if (!text(m[1])) out.push('empty status pill');
  return out;
}

const PAGES = ['/', '/jobs', jobPath(JOB), '/categories', '/saved', '/help/job-terms', '/accessibility', '/account/login', '/account/register', '/account/forgot', '/no-such-page'];

for (const lang of ['en', 'hi']) {
  test(`public pages pass the automated checks (${lang})`, async () => {
    const found = {};
    for (const path of PAGES) {
      const html = await (await get(path, `hr_lang=${lang}`)).text();
      assert.match(html, new RegExp(`<html lang="${lang}"`), path);
      const p = problems(html);
      if (p.length) found[path] = p;
    }
    assert.deepEqual(found, {});
  });
}

test('candidate pages pass the automated checks', async () => {
  const found = {};
  for (const path of ['/account', '/account/settings', '/account/applications', '/account/profile']) {
    const r = await get(path, meena);
    if (r.status !== 200) continue;
    const p = problems(await r.text());
    if (p.length) found[path] = p;
  }
  assert.deepEqual(found, {});
});

test('the job page offers the original, read-aloud and a labelled language choice', async () => {
  const html = await (await get(jobPath(JOB), 'hr_lang=hi')).text();
  assert.match(html, /class="lang-switch"[^>]*role="group"[^>]*aria-labelledby="lang-label"/);
  assert.match(html, /<button type="submit" name="lang" value="hi" lang="hi" aria-current="true"/);
  assert.match(html, /data-read-aloud="#job-text"[^>]*hidden/, 'shown only where the browser can read aloud');
  assert.match(html, /data-apply-review[^>]*hidden/);
  assert.match(html, /<button[^>]*class="nav-toggle"[^>]*type="button"|<button[^>]*type="button"[^>]*class="nav-toggle"/);
});
