// The public pricing page: plans shown unless the team hides them,
// recruitment starting prices only once typed in, and the terms.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

let srv; let admin;
before(async () => { srv = await startServer({}, { site: [{ ...require('../data/site.json'), pricing: {} }] }); admin = await srv.adminLogin(); });
after(() => srv && srv.stop());
const page = async (p, cookie) => (await srv.request(p, { cookie })).text();

test('by default the page shows the plans and explains both ways to hire', async () => {
  const html = await page('/pricing');
  assert.match(html, /<h1>Pricing for employers<\/h1>/);
  assert.match(html, /<h3>Growth<\/h3>\s*<p class="plan-price">₹1,999<span/, 'plan prices shown by default, in whole rupees');
  assert.match(html, /<td><a href="\/services\/permanent-staffing">Permanent recruitment<\/a><\/td>/);
  assert.doesNotMatch(html, /Starting from/, 'no recruitment prices until typed in');
  assert.match(html, /we find a replacement at no extra fee/);
  assert.match(html, /Always free for job seekers/);
  assert.match(await page('/sitemap.xml'), /\/pricing<\/loc>/);
  assert.match(await page('/'), /<a href="\/pricing">Pricing<\/a>/, 'in the footer');
  assert.match(await page('/employers'), /<a href="\/pricing">Pricing<\/a>/);
  assert.match(await page('/'), /<a href="\/pricing" class="[^"]*">Pricing<\/a>/, 'in the header');
});

test('the team can hide the plans from the page, and show them again', async () => {
  await srv.request('/admin/billing/public-plans', { method: 'POST', cookie: admin, form: {} });
  const hidden = await page('/pricing');
  assert.doesNotMatch(hidden, /<h3>Growth<\/h3>/);
  assert.match(hidden, /Create a free employer account to see the current plans/);
  assert.match(await page('/admin/billing?view=settings', admin), /name="publicPlans" value="1"/);
  let res = await srv.request('/admin/billing/public-plans', { method: 'POST', cookie: admin, form: { publicPlans: '1' } });
  assert.ok([302, 303].includes(res.status), String(res.status));
  const html = await page('/pricing');
  assert.match(html, /<h3>Growth<\/h3>\s*<p class="plan-price">₹1,999/);
  assert.match(html, /<h3>Starter<\/h3>\s*<p class="plan-price">Free/);
  assert.match(html, /href="\/employer\/register">Start free<\/a>/);
  assert.match(html, /Custom quote/);
  // Saving the renewal settings keeps the choice.
  res = await srv.request('/admin/billing/settings', { method: 'POST', cookie: admin, form: { graceDays: '7', reminderDays: '7, 3, 1' } });
  assert.ok([302, 303].includes(res.status), String(res.status));
  assert.match(await page('/pricing'), /<h3>Growth<\/h3>/);
  await srv.request('/admin/billing/public-plans', { method: 'POST', cookie: admin, form: {} });
  assert.doesNotMatch(await page('/pricing'), /<h3>Growth<\/h3>/);
});
