// The Employers / Hire Talent page and its enquiries: saved, confirmed by
// email, sent to the team and the CRM, with a lead owner and the status
// New → Contacted → Requirement received → Candidates shared → Closed.
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
const page = async (p, opts) => (await srv.request(p, opts)).text();
const enquiry = { from: 'employers', consentAsked: '1', consent: '1', company: 'Kaveri Logistics', name: 'Sunita Rao', email: 'sunita@kaveri.example', phone: '9845012345', industry: 'Logistics & Operations', hiringType: 'Bulk / RPO', headcount: '21-50', location: 'Bengaluru', roles: '30 warehouse pickers, day shift' };
const send = (form) => srv.request('/api/hire', { method: 'POST', headers: { accept: 'application/json' }, form });

test('the page has the agreed content, services, steps and the enquiry form', async () => {
  const html = await page('/employers');
  for (const text of ['Hire the Right Talent. <span class="grad">Faster.</span>', 'Your recruitment partner for skilled professionals, bulk hiring and staffing solutions across India.',
    'Need employees for your business?', 'Tell us your hiring requirements. Our team will contact you.', 'Request a Callback', 'Our recruitment services',
    'Find suitable long-term employees.', 'Flexible workforce for business needs.', 'Recruit multiple employees efficiently.', 'Find experienced professionals.',
    'Share your hiring requirements.', 'We shortlist suitable candidates.', 'You interview and select candidates.', 'We support the recruitment process.',
    'Let&#39;s discuss your hiring needs', 'Request a Quote']) assert.ok(html.includes(text) || html.includes(text.replace('&#39;', "'")), text);
  for (const name of ['company', 'name', 'email', 'phone', 'industry', 'hiringType', 'headcount', 'location', 'roles', 'consent']) assert.match(html, new RegExp(`name="${name}"`), name);
  assert.match(html, /<option>Logistics &amp; Operations<\/option>/);
  assert.match(html, /<option value="Executive search">Executive Search<\/option>/);
  assert.match(html, /name="consent" value="1" required/);
  assert.doesNotMatch(html, /wa\.me\/910000000000/, 'no WhatsApp button for the placeholder number');
  assert.equal((await srv.request('/hire-talent')).headers.get('location'), '/employers');
  assert.match(await page('/'), /<a href="\/employers"[^>]*>Employers<\/a>/);
  assert.match(await page('/sitemap.xml'), /\/employers<\/loc>/);
});

test('an enquiry needs consent, then is saved, confirmed and sent to the team and the CRM', async () => {
  let res = await send({ ...enquiry, consent: '' });
  assert.equal(res.status, 400);
  assert.match(JSON.stringify(await res.json()), /consent/);
  res = await send({ ...enquiry, industry: 'Space travel' });
  assert.equal(res.status, 400);

  res = await send(enquiry);
  assert.equal(res.status, 200);
  const h = srv.records('hire-requests').find((r) => r.company === 'Kaveri Logistics');
  assert.equal(h.fromPage, 'Employers page');
  assert.equal(h.industry, 'Logistics & Operations');
  assert.equal(h.followUp, 'New');
  assert.ok(h.consentAt);
  assert.ok(await srv.waitForEmail((m) => m.includes('received your hiring requirement') && m.includes('sunita@kaveri.example')));
  assert.ok(await srv.waitForEmail((m) => m.includes('New hiring request: Kaveri Logistics')));
  assert.ok(srv.records('crm-leads').some((l) => l.companyName === 'Kaveri Logistics'));
});

test('the team assigns a lead owner and moves the status; the owner is told', async () => {
  const h = srv.records('hire-requests').find((r) => r.company === 'Kaveri Logistics');
  const html = await page('/admin?tab=hire-requests', { cookie: admin });
  for (const s of ['New', 'Contacted', 'Requirement received', 'Candidates shared', 'Closed']) assert.match(html, new RegExp(`<option( selected)?>${s}</option>`), s);
  const owner = html.match(new RegExp(`<select id="ow-${h.id}" name="ownerId"><option value="">No owner yet</option><option value="([^"]+)"`));
  assert.ok(owner, 'team members are listed as owners');
  const res = await srv.request(`/admin/hire-requests/${h.id}/follow-up`, { method: 'POST', cookie: admin, form: { followUp: 'Requirement received', ownerId: owner[1] } });
  assert.equal(res.status, 302);
  const after = srv.records('hire-requests').find((r) => r.id === h.id);
  assert.equal(after.followUp, 'Requirement received');
  assert.equal(after.ownerId, owner[1]);
  const bad = await srv.request(`/admin/hire-requests/${h.id}/follow-up`, { method: 'POST', cookie: admin, form: { followUp: 'Closed', ownerId: 'nobody' } });
  assert.match(bad.headers.get('location'), /lead%20owner|lead\+owner/i);
  assert.equal(srv.records('hire-requests').find((r) => r.id === h.id).followUp, 'Requirement received');
});

test('enquiries not contacted within one working day are flagged and listed in the admin to-do', async () => {
  const old = await startServer({}, { 'hire-requests': [
    { id: 'h-old', createdAt: '2026-01-05T04:00:00.000Z', company: 'Old Co', name: 'A', email: 'a@old.example', phone: '9800000009', roles: 'Driver', followUp: 'New' },
    { id: 'h-moved', createdAt: '2026-01-05T04:00:00.000Z', company: 'Moved Co', name: 'B', email: 'b@moved.example', phone: '9800000008', roles: 'Driver', followUp: 'Quote sent' },
  ] });
  try {
    const cookie = await old.adminLogin();
    const html = await (await old.request('/admin?tab=hire-requests', { cookie })).text();
    assert.match(html, /Not contacted for over a working day/);
    assert.match(await (await old.request('/admin', { cookie })).text(), /1 employer enquiry has not been contacted within one working day/);
    assert.equal(old.records('hire-requests').find((r) => r.id === 'h-moved').followUp, 'Requirement received', 'old statuses are mapped once');
  } finally { old.stop(); }
});
