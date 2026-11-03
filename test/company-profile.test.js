// The company profile: the web page and the PDF download, from Settings and
// the service catalogue, with nothing made up.
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
// The text drawn on the PDF pages, from its (uncompressed) content streams.
const pdfText = (buf) => [...buf.toString('latin1').matchAll(/\((.*?)\) Tj/g)].map((m) => m[1].replace(/\\([()\\])/g, '$1')).join(' ');

test('the page lists who we are, services, how we work, terms and contact details, and links to the PDF', async () => {
  const html = await page('/company-profile');
  for (const h of ['About us', 'Our services', 'Industries we hire for', 'How we work', 'Commercial terms', 'Company details']) assert.match(html, new RegExp(`<h2 class="h3">${h}</h2>`), h);
  assert.match(html, /recruitment and staffing brand operated by Raigozen Private Limited, India/);
  assert.match(html, /IT Recruitment/);
  assert.match(html, /Also on request:/);
  assert.match(html, /href="\/company-profile\.pdf" download/);
  assert.doesNotMatch(html, /Mission and vision|Our team|0000000000|Your office address/, 'nothing empty or placeholder');
  assert.match(await page('/employers'), /href="\/company-profile"/);
  assert.match(await page('/about'), /href="\/company-profile"/);
  assert.match(await page('/sitemap.xml'), /\/company-profile<\/loc>/);
});

test('the PDF downloads with the same content', async () => {
  const res = await srv.request('/company-profile.pdf');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.match(res.headers.get('content-disposition'), /attachment; filename="Hireriv-company-profile\.pdf"/);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.match(buf.toString('latin1', 0, 8), /^%PDF-1\.4/);
  assert.match(buf.toString('latin1').slice(-6), /%%EOF/);
  const text = pdfText(buf);
  for (const s of ['Hireriv company profile', 'ABOUT US', 'OUR SERVICES', 'HOW WE WORK', 'COMMERCIAL TERMS', 'COMPANY DETAILS', 'Raigozen Private Limited']) assert.ok(text.includes(s), s);
});

test('Settings feed the profile: mission, team, prices, replacement, CIN and real contact details', async () => {
  const res = await srv.request('/admin/settings', { method: 'POST', cookie: admin, form: settings({
    company_cin: 'U74999KA2024PTC123456', company_mission: 'Help growing businesses hire reliable people.', team_name_0: 'Divya Rai', team_role_0: 'Founder',
    'price_permanent-staffing': '8.33% of annual CTC', billing_guaranteeDays: '60',
  }) });
  assert.equal(res.status, 302);
  const html = await page('/company-profile');
  assert.match(html, /Help growing businesses hire reliable people\./);
  assert.match(html, /Divya Rai/);
  assert.match(html, /Permanent recruitment: from 8\.33% of annual CTC/);
  assert.match(html, /leave within 60 days of joining/);
  assert.match(html, /<dt>CIN<\/dt><dd>U74999KA2024PTC123456<\/dd>/);
  assert.match(html, /<dt>Phone<\/dt><dd>\+91 98765 43210<\/dd>/);
  const text = pdfText(Buffer.from(await (await srv.request('/company-profile.pdf')).arrayBuffer()));
  assert.ok(text.includes('U74999KA2024PTC123456'));
  assert.ok(text.includes('Divya Rai'));
});
