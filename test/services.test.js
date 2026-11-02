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
    // Industry pages list live jobs by category, so the categories must exist.
    for (const c of catalog.deskCategories(ind)) assert.ok(DEFAULT_JOB_CATEGORIES.includes(c), `${c} is a job category`);
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

test('the four main services lead, each with who needs it, the process, benefits, Request a Quote and WhatsApp', async () => {
  assert.deepEqual(catalog.PRIORITY_SERVICES.map((s) => s.slug), ['it-recruitment', 'non-it-recruitment', 'bulk-rpo-hiring', 'contract-staffing']);
  for (const s of catalog.PRIORITY_SERVICES) assert.ok(s.benefits && s.benefits.length, `${s.slug} benefits`);
  const list = (await get('/services')).html;
  const main = list.slice(list.indexOf('Our main services'), list.indexOf('More services'));
  for (const s of catalog.PRIORITY_SERVICES) assert.ok(main.includes(`href="/services/${s.slug}"`), s.slug);
  assert.ok(!main.includes('href="/services/executive-search"'));
  for (const s of catalog.PRIORITY_SERVICES) {
    const html = (await get(`/services/${s.slug}`)).html;
    assert.match(html, /Who needs it/);
    assert.match(html, /What&#39;s included|What's included/);
    assert.match(html, /How it works/);
    assert.match(html, /Benefits for employers/);
    assert.match(html, new RegExp(`href="/hire[?]service=${s.slug}#requirement"[^>]*>Request a Quote`));
    assert.doesNotMatch(html, /wa\.me\/910000000000/, 'no WhatsApp button for the placeholder number');
  }
  const contract = (await get('/services/contract-staffing')).html;
  assert.match(contract, /Payroll and compliance/);
  assert.match(contract, /Who employs the worker/);
  assert.match((await get('/services/it-recruitment')).html, /Roles we hire for[\s\S]*Testers and QA engineers/);
  assert.match((await get('/hire?service=it-recruitment')).html, /name="from" value="service:it-recruitment"/);
});

test('with a real WhatsApp number, service pages offer WhatsApp with the service in the message', async () => {
  const other = await startServer({}, { site: [{ ...require('../data/site.json'), whatsapp: '919812345678', phone: '+91 98123 45678' }] });
  try {
    const html = await (await other.request('/services/bulk-rpo-hiring')).text();
    assert.match(html, /href="https:\/\/wa\.me\/919812345678\?text=[^"]*Bulk%20%26%20RPO%20Hiring/);
    assert.match(html, /href="tel:\+919812345678"/);
  } finally { other.stop(); }
});

test('placeholder contact details are never shown or linked', async () => {
  for (const p of ['/', '/contact', '/services/it-recruitment', '/terms']) {
    const html = (await get(p)).html;
    assert.ok(!html.includes('910000000000') && !html.includes('+91 00000 00000') && !html.includes('Your office address'), p);
  }
  assert.match((await get('/contact')).html, /mailto:/);
});
