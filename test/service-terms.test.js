// Service terms: engagement steps, timelines, replacement policy, payment terms,
// refunds and cancellation, with the numbers from Settings.
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
const page = async (p) => (await srv.request(p)).text();
const settings = (extra) => ({
  tagline: 'Hiring', phone: '+91 98765 43210', whatsapp: '919876543210', email: 'hello@hireriv.com', address: '2nd floor, MG Road, Pune 411001', hours: '9-6',
  jobCategories: 'Technology', jobLocations: 'Pune', billing_feePercent: '8.33', billing_guaranteeDays: '90', billing_gstPercent: '18', billing_paymentDays: '15', billing_tdsPercent: '10', retentionMonths: '0',
  ...extra,
});

test('the page explains the engagement, replacement, payment and refunds, and is linked and listed', async () => {
  const html = await page('/service-terms');
  for (const id of ['engagement', 'timelines', 'replacement', 'payment', 'refunds']) assert.match(html, new RegExp(`<h2 id="${id}">`), id);
  assert.match(html, /agreed in your quote, depending on the role/, 'no shortlist promise until one is set');
  assert.match(html, /paid plan periods are not refunded in part/);
  assert.match(html, /recruitment and staffing brand operated by Raigozen Private Limited/);
  for (const [from, to] of [['/refund-policy', '/service-terms#refunds'], ['/cancellation-policy', '/service-terms#refunds'], ['/replacement-policy', '/service-terms#replacement']]) assert.equal((await srv.request(from)).headers.get('location'), to, from);
  assert.match(await page('/'), /href="\/service-terms"/, 'footer link');
  assert.match(await page('/employers'), /href="\/service-terms"/);
  assert.match(await page('/services/permanent-staffing'), /href="\/service-terms"/);
  assert.match(await page('/sitemap.xml'), /\/service-terms<\/loc>/);
});

test('the replacement period, payment days and shortlist time come from Settings', async () => {
  const res = await srv.request('/admin/settings', { method: 'POST', cookie: admin, form: settings({ billing_guaranteeDays: '60', billing_paymentDays: '30', terms_shortlistDays: '5' }) });
  assert.equal(res.status, 302);
  const html = await page('/service-terms');
  assert.match(html, /within <b>60 days<\/b> of joining/);
  assert.match(html, /Invoices are due within <b>30 days<\/b>/);
  assert.match(html, /GST at 18%/);
  assert.match(html, /usually within 5 working days of the agreement/);

  await srv.request('/admin/settings', { method: 'POST', cookie: admin, form: settings({ billing_guaranteeDays: '0' }) });
  assert.match(await page('/service-terms'), /Any replacement period is agreed in your quote/, 'no replacement promise when the period is 0');
});

test('settings check the shortlist time', () => {
  const parse = (v) => content.parseSettings(settings({ terms_shortlistDays: v }), { name: 'H' });
  assert.ok(parse('0').errors.some((e) => /shortlist/.test(e)));
  assert.ok(parse('abc').errors.some((e) => /shortlist/.test(e)));
  assert.deepEqual(parse('7').errors, []);
  assert.equal(parse('').settings.serviceTerms.shortlistDays, null);
});
