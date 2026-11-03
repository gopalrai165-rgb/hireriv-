// "Recruitment agency in <city>" pages: only for cities chosen in Settings,
// with the city's real jobs, localities and the enquiry form; /jobs/remote.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const content = require('../content');
const { startServer } = require('./helpers');

let srv;
let admin;
before(async () => {
  srv = await startServer();
  admin = await srv.adminLogin();
});
after(() => srv && srv.stop());
const page = async (p, opts) => (await srv.request(p, opts)).text();
const settings = (extra) => ({
  tagline: 'Hiring', phone: '+91 98765 43210', whatsapp: '919876543210', email: 'hello@hireriv.com', address: 'Plot 12, Madhapur, Hyderabad 500081', hours: '9-6',
  jobCategories: 'Technology', jobLocations: 'Pune', billing_feePercent: '8.33', billing_guaranteeDays: '90', billing_gstPercent: '18', billing_paymentDays: '15', billing_tdsPercent: '10', retentionMonths: '0',
  ...extra,
});

test('no city pages until the owner chooses cities', async () => {
  assert.equal((await srv.request('/recruitment-agency/hyderabad')).status, 404);
  assert.doesNotMatch(await page('/sitemap.xml'), /recruitment-agency/);
  assert.doesNotMatch(await page('/employers'), /Where we recruit/);
  assert.match(await page('/admin?tab=settings', { cookie: admin }), /name="recruitCities" value="hyderabad"/);
  assert.equal((await srv.request('/jobs/remote')).headers.get('location'), '/jobs/work-from-home');
});

test('a chosen city gets a page with local jobs, localities, office, form and structured data', async () => {
  const res = await srv.request('/admin/settings', { method: 'POST', cookie: admin, form: [...Object.entries(settings()), ['recruitCities', 'hyderabad'], ['recruitCities', 'pune']] });
  assert.equal(res.status, 302);
  const html = await page('/recruitment-agency/hyderabad');
  assert.match(html, /<title>Recruitment Agency in Hyderabad: Staffing &amp; Hiring Services/);
  assert.match(html, /Recruitment agency in <span class="grad">Hyderabad<\/span>/);
  assert.match(html, /Hiring in Hyderabad right now/);
  assert.match(html, /open jobs? in Hyderabad on Hireriv|No vacancies are listed in Hyderabad yet/);
  assert.match(html, /HITEC City/, 'real localities');
  assert.match(html, /<b>Our office:<\/b> Plot 12, Madhapur, Hyderabad 500081/);
  assert.match(html, /name="from" value="city:hyderabad"/);
  assert.match(html, /name="location" maxlength="120" placeholder="City, or Remote" value="Hyderabad"/);
  assert.match(html, /"areaServed":\{"@type":"City","name":"Hyderabad"\}/);
  assert.match(html, /We also recruit in <a href="\/recruitment-agency\/pune">Pune<\/a>/);
  assert.doesNotMatch(await page('/recruitment-agency/pune'), /Our office:/, 'the office shows only in its own city');
  assert.equal((await srv.request('/recruitment-agency/chennai')).status, 404, 'cities not chosen stay off');
  const map = await page('/sitemap.xml');
  assert.match(map, /\/recruitment-agency\/hyderabad<\/loc>/);
  assert.doesNotMatch(map, /\/recruitment-agency\/chennai/);
  assert.match(await page('/employers'), /href="\/recruitment-agency\/hyderabad">Recruitment in Hyderabad/);
});

test('an enquiry from a city page is labelled with the city', async () => {
  const res = await srv.request('/api/hire', { method: 'POST', headers: { accept: 'application/json' }, form: {
    from: 'city:hyderabad', consentAsked: '1', consent: '1', company: 'Deccan Foods', name: 'Ravi', email: 'ravi@deccan.example', phone: '9845033333', location: 'Hyderabad', roles: '8 packers',
  } });
  assert.equal(res.status, 200);
  assert.equal(srv.records('hire-requests').find((h) => h.company === 'Deccan Foods').fromPage, 'City page: Hyderabad');
});

test('settings keep only known cities and at most twelve', () => {
  const parse = (v) => content.parseSettings(settings({ recruitCities: v }), { name: 'H' });
  assert.deepEqual(parse(['hyderabad', 'atlantis', 'hyderabad']).settings.recruitCities, ['hyderabad']);
  assert.deepEqual(parse('pune').settings.recruitCities, ['pune']);
  const many = require('../geo').CITY_PAGES.slice(0, 13).map((c) => c.slug);
  assert.ok(parse(many).errors.some((e) => /up to 12/.test(e)));
});
