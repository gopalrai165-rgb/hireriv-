// The Grievance Officer named in Settings appears in the privacy policy, the
// terms and the account privacy page; until then the admin to-do asks for one.
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
  tagline: 'Hiring', phone: '+91 98765 43210', whatsapp: '919876543210', email: 'hello@hireriv.com', address: '2nd floor, MG Road, Pune 411001', hours: '9-6',
  jobCategories: 'Technology', jobLocations: 'Pune', billing_feePercent: '8.33', billing_guaranteeDays: '90', billing_gstPercent: '18', billing_paymentDays: '15', billing_tdsPercent: '10', retentionMonths: '0',
  ...extra,
});

test('before a name is set: no placeholder phone or address, and the admin to-do asks for one', async () => {
  const html = await page('/privacy');
  assert.match(html, /<address class="grievance-officer">/);
  assert.doesNotMatch(html, /0000000000|00000 00000|Your office address/i, 'placeholder contact details are left out');
  assert.match(await page('/admin', { cookie: admin }), /Name your Grievance Officer/);
});

test('the Grievance Officer from Settings is shown in the privacy policy, terms and account page', async () => {
  const res = await srv.request('/admin/settings', { method: 'POST', cookie: admin, form: settings({ grievance_name: 'Divya Rai', grievance_designation: 'Director', grievance_email: 'grievance@hireriv.com', grievance_phone: '+91 98765 11111' }) });
  assert.equal(res.status, 302);
  for (const p of ['/privacy', '/terms']) {
    const html = await page(p);
    assert.match(html, /<b>Grievance Officer:<\/b> Divya Rai, Director/, p);
    assert.match(html, /mailto:grievance@hireriv\.com/, p);
    assert.match(html, /tel:\+919876511111/, p);
    assert.match(html, /2nd floor, MG Road, Pune 411001/, p);
    assert.match(html, /within 24 hours/, p);
  }
  assert.doesNotMatch(await page('/admin', { cookie: admin }), /Name your Grievance Officer/);
});

test('settings check the Grievance Officer details', () => {
  const parse = (extra) => content.parseSettings(settings(extra), { name: 'H' });
  assert.ok(parse({ grievance_email: 'g@hireriv.com' }).errors.some((e) => /needs a name/.test(e)));
  assert.ok(parse({ grievance_name: 'A', grievance_email: 'not-an-email' }).errors.some((e) => /email/.test(e)));
  assert.ok(parse({ grievance_name: 'A', grievance_phone: 'call me' }).errors.some((e) => /phone/.test(e)));
  const ok = parse({ grievance_name: 'A' });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.settings.grievance.name, 'A');
});
