// Step 172: the footer shows "A Raigozen company" with the Raigozen logo while
// Settings names Raigozen as the operator, and drops it for any other operator.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
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
const LOGO = /<p class="footer-parent"><span class="small">A Raigozen company<\/span><img src="\/img\/raigozen-logo\.png" alt="Raigozen" width="180" height="42" loading="lazy" decoding="async"><\/p>/;

test('every page footer shows the Raigozen logo, and the image is small', async () => {
  for (const p of ['/', '/jobs', '/about', '/contact', '/account/login']) assert.match(await page(p), LOGO, p);
  const img = await srv.request('/img/raigozen-logo.png');
  assert.equal(img.status, 200);
  assert.match(img.headers.get('content-type'), /image\/png/);
  const bytes = Buffer.from(await img.arrayBuffer());
  assert.ok(bytes.length < 60 * 1024, `logo is ${bytes.length} bytes`);
  assert.equal(bytes.readUInt32BE(16), 600, 'drawn at 600px wide for sharp phone screens');
});

test('another operator in Settings hides the Raigozen logo', async () => {
  await srv.confirm(admin);
  const res = await srv.request('/admin/settings', { method: 'POST', cookie: admin, form: settings({ company_operator: 'Other Staffing LLP' }) });
  assert.equal(res.status, 302);
  const html = await page('/');
  assert.match(html, /operated by Other Staffing LLP, India/);
  assert.doesNotMatch(html, /raigozen-logo|A Raigozen company/);
});
