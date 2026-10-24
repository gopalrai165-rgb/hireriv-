// Service and industry pages: content integrity, rendering, links and SEO data.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const catalog = require('../catalog');
const { DEFAULT_JOB_CATEGORIES } = require('../content');
const { startServer } = require('./helpers');

test('catalog: unique slugs, real job categories and valid cross-links', () => {
  const slugs = catalog.SERVICES.map((s) => s.slug);
  assert.equal(new Set(slugs).size, slugs.length);
  assert.equal(new Set(catalog.INDUSTRIES.map((i) => i.slug)).size, catalog.INDUSTRIES.length);
  for (const s of catalog.SERVICES) {
    assert.ok(catalog.HIRE_OPTIONS.includes(s.hiringType), `${s.slug} hire option`);
    for (const k of ['name', 'card', 'headline', 'intro', 'billing', 'need', 'pay']) assert.ok(s[k], `${s.slug}.${k}`);
    assert.ok(s.includes.length && s.idealFor.length && s.steps.length && s.faqs.length, s.slug);
  }
  for (const ind of catalog.INDUSTRIES) {
    // Industry pages list live jobs by category name, so the names must match.
    assert.ok(DEFAULT_JOB_CATEGORIES.includes(ind.name), `${ind.name} is a job category`);
    for (const s of ind.services) assert.ok(catalog.serviceBySlug(s), `${ind.slug} → ${s}`);
    assert.ok(ind.roles.length && ind.screen.length && ind.intro);
  }
});

let srv;
before(async () => { srv = await startServer(); });
after(() => srv && srv.stop());
const get = async (p) => {
  const res = await srv.request(p);
  return { status: res.status, html: await res.text() };
};

test('every service and industry page renders, unknown ones are 404', async () => {
  const paths = ['/services', '/industries', ...catalog.SERVICES.map((s) => `/services/${s.slug}`), ...catalog.INDUSTRIES.map((i) => `/industries/${i.slug}`)];
  for (const p of paths) {
    const { status, html } = await get(p);
    assert.equal(status, 200, p);
    assert.doesNotMatch(html.replace(/<script[\s\S]*?<\/script>/g, ''), /\bundefined\b|NaN|\[object Object\]/, p);
  }
  assert.equal((await get('/services/nope')).status, 404);
  assert.equal((await get('/industries/nope')).status, 404);
});

test('service pages carry Service, FAQ and breadcrumb data for Google', async () => {
  const { html } = await get('/services/permanent-staffing');
  const ld = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  assert.deepEqual(ld['@graph'].map((n) => n['@type']), ['Service', 'FAQPage', 'BreadcrumbList']);
  assert.equal(ld['@graph'][1].mainEntity.length, catalog.serviceBySlug('permanent-staffing').faqs.length);
  assert.match(html, /standard replacement guarantee is 90 days/);
});

test('a service page pre-selects that service on the hire form', async () => {
  const { html } = await get('/hire?service=background-verification');
  assert.match(html, /<option selected>Background verification<\/option>/);
  assert.doesNotMatch((await get('/hire?service=nope')).html, /<option selected>/);
});

test('industry pages list only that desk\'s open jobs', async () => {
  const { html } = await get('/industries/finance-accounting');
  assert.match(html, /Senior Accountant/);
  assert.doesNotMatch(html, /Full-Stack Developer \(MERN\)<\/a><\/h3>/);
  const empty = await get('/industries/healthcare-pharma');
  assert.match(empty.html, /No open healthcare &amp; pharma roles right now/);
});

test('services are linked from the header, footer, homepage and sitemap', async () => {
  const home = (await get('/')).html;
  assert.match(home, /<a href="\/services" class="">Staffing Solutions<\/a>/);
  for (const s of catalog.SERVICES) assert.ok(home.includes(`href="/services/${s.slug}"`), s.slug);
  for (const i of catalog.INDUSTRIES) assert.ok(home.includes(`href="/industries/${i.slug}"`), i.slug);
  const xml = (await get('/sitemap.xml')).html;
  for (const p of ['/services', '/industries', '/services/executive-search', '/industries/retail-ecommerce']) assert.ok(xml.includes(`${p}</loc>`), p);
});
