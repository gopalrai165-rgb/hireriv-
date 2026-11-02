// About page and trust: operated by Raigozen Private Limited, company details,
// background, real team and capabilities from Settings, and no claims the
// team has not entered.
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

test('a new site says who runs it and makes no claims about history or experience', async () => {
  const html = await page('/about');
  assert.match(html, /operated by Raigozen Private Limited/);
  assert.match(html, /<dt>Operated by<\/dt><dd>Raigozen Private Limited<\/dd>/);
  assert.match(html, /<dt>Email<\/dt>/);
  for (const claim of ['years of experience hiring for global firms', 'tired of CV-forwarding', 'We started as a technology staffing specialist', 'Our team', 'Client feedback']) assert.ok(!html.includes(claim), claim);
  assert.doesNotMatch(html, /<dt>Office<\/dt>|<dt>Phone<\/dt>/, 'placeholder office and phone are left out');
  assert.match(await page('/'), /Operated by Raigozen Private Limited/, 'the footer names the company');
  assert.match(await page('/'), /"legalName":"Raigozen Private Limited"/);
});

test('company details, background, capabilities and team come from Settings', async () => {
  const res = await srv.request('/admin/settings', { method: 'POST', cookie: admin, form: settings({
    company_operator: 'Raigozen Private Limited', company_cin: 'u74999ka2024ptc123456', company_founded: '2024',
    company_story: 'Started in Pune in 2024 by two recruiters.\n\nWe now hire for start-ups and warehouses.',
    company_capabilities: 'IT recruitment for start-ups in Pune\nWarehouse staff in Pune and Mumbai',
    team_name_0: 'Divya Rai', team_role_0: 'Founder', team_bio_0: 'Runs recruitment.',
  }) });
  assert.equal(res.status, 302);
  const html = await page('/about');
  assert.match(html, /<p>Started in Pune in 2024 by two recruiters\.<\/p>\s*<p>We now hire for start-ups and warehouses\.<\/p>/);
  assert.match(html, /<dt>CIN<\/dt><dd>U74999KA2024PTC123456<\/dd>/);
  assert.match(html, /<dt>Founded<\/dt><dd>2024<\/dd>/);
  assert.match(html, /<dt>Office<\/dt><dd>2nd floor, MG Road, Pune 411001/);
  assert.match(html, /<dt>Phone<\/dt>/);
  assert.match(html, /IT recruitment for start-ups in Pune/);
  assert.match(html, /The people you will work with[\s\S]*Divya Rai[\s\S]*Founder/);
  assert.match(await page('/'), /Operated by Raigozen Private Limited · CIN U74999KA2024PTC123456/);
});

test('settings check the CIN, the year and team rows', () => {
  const base = settings({});
  const bad = content.parseSettings({ ...base, company_cin: 'ABC', company_founded: '1800', team_name_0: 'Only a name' }, { name: 'H' }).errors;
  assert.ok(bad.includes('CIN should be 21 characters (e.g. U74999KA2024PTC123456)'));
  assert.ok(bad.includes('the year founded must be a year'));
  assert.ok(bad.includes('team member 1 needs a name and a role'));
  assert.equal(content.parseSettings(base, { name: 'H' }).settings.company.operator, 'Raigozen Private Limited');
});
