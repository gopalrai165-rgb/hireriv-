// Hire a Team form: the extra details, a job description upload, the
// confirmation email to the employer, the team's email and CRM lead, and the
// follow-up status the team keeps in admin.
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

const send = (fields, file) => {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.append(k, v);
  if (file) body.append('jd', new Blob([file.bytes], { type: 'application/pdf' }), file.name);
  return srv.request('/api/hire', { method: 'POST', body, headers: { accept: 'application/json' } });
};
const base = { company: 'Nova Foods', name: 'Ravi Kumar', email: 'ravi@novafoods.example', phone: '9800000001', roles: '5 packers' };

test('the form asks for the website, IT or non-IT, department, budget, deadline, city, a job description and more', async () => {
  const html = await (await srv.request('/hire?service=it-recruitment')).text();
  assert.match(html, /enctype="multipart\/form-data"/);
  for (const name of ['companySite', 'department', 'budget', 'deadline', 'location', 'jd', 'message', 'hiringType']) assert.match(html, new RegExp(`name="${name}"`), name);
  assert.match(html, /<input type="radio" name="field" value="IT" checked>/, 'the IT service picks IT');
  assert.match(html, /Permanent or contract\?/);
  assert.match(html, /Additional requirements/);
});

test('a full request is saved with its job description, acknowledged by email and sent to the team and the CRM', async () => {
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
  const seen = srv.emails().length;
  const res = await send({ ...base, companySite: 'novafoods.example', field: 'Non-IT', department: 'Warehouse', headcount: '2-5', hiringType: 'Contract', location: 'Pune', budget: '₹18,000 a month', deadline: '2030-01-15', message: 'Night shift' }, { name: 'packer-jd.pdf', bytes: pdf });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.match(out.message, /confirmation to your email/);

  const h = srv.records('hire-requests').find((r) => r.company === 'Nova Foods');
  assert.equal(h.website, 'https://novafoods.example');
  assert.equal(h.field, 'Non-IT');
  assert.equal(h.department, 'Warehouse');
  assert.equal(h.budget, '₹18,000 a month');
  assert.equal(h.deadline, '2030-01-15');
  assert.equal(h.followUp, 'New');
  assert.equal(h.jdName, 'packer-jd.pdf');
  assert.match(h.jd, /^jd-/);

  const ack = await srv.waitForEmail((m) => m.includes('received your hiring requirement'));
  assert.ok(ack, 'the employer gets a confirmation');
  assert.match(ack, /ravi@novafoods\.example/);
  const teamMail = await srv.waitForEmail((m) => m.includes('New hiring request: Nova Foods'));
  assert.ok(teamMail, 'the team is told');
  assert.match(teamMail, /Salary budget/);
  assert.match(teamMail, /packer-jd\.pdf/);
  assert.ok(srv.emails().length >= seen + 2);

  const lead = srv.records('crm-leads').find((l) => l.companyName === 'Nova Foods');
  assert.ok(lead, 'stored as a CRM lead');
  assert.equal(lead.status, 'new');
  assert.match(lead.hiringNeeds, /Salary budget: ₹18,000 a month/);
  assert.match(lead.hiringNeeds, /Hiring deadline: 2030-01-15/);
});

test('the team sees the request, opens the job description and moves the follow-up status', async () => {
  const html = await (await srv.request('/admin?tab=hire-requests', { cookie: admin })).text();
  assert.match(html, /Nova Foods/);
  assert.match(html, /Salary budget:<\/span> ₹18,000 a month/);
  const link = html.match(/href="(\/admin\/hire-requests\/jd\/[^"]+)"/)[1].replace(/&amp;/g, '&');
  const file = await srv.request(link, { cookie: admin });
  assert.equal(file.status, 200);
  assert.match(Buffer.from(await file.arrayBuffer()).toString('latin1'), /^%PDF-/);
  assert.equal((await srv.request(link.split('?')[0], { cookie: admin })).status, 410, 'unsigned links do not work');

  const h = srv.records('hire-requests').find((r) => r.company === 'Nova Foods');
  const res = await srv.request(`/admin/hire-requests/${h.id}/follow-up`, { method: 'POST', cookie: admin, form: { followUp: 'Quote sent' } });
  assert.equal(res.status, 302);
  const after = srv.records('hire-requests').find((r) => r.id === h.id);
  assert.equal(after.followUp, 'Quote sent');
  assert.ok(after.followUpAt);
  assert.equal((await srv.request(`/admin/hire-requests/${h.id}/follow-up`, { method: 'POST', cookie: admin, form: { followUp: 'Whatever' } })).status, 302);
  assert.equal(srv.records('hire-requests').find((r) => r.id === h.id).followUp, 'Quote sent');
});

test('bad websites, dates and files are refused', async () => {
  let res = await send({ ...base, company: 'Bad Site Co', companySite: 'not a site' });
  assert.equal(res.status, 400);
  assert.match(JSON.stringify(await res.json()), /website/);
  res = await send({ ...base, company: 'Bad Date Co', deadline: 'tomorrow' });
  assert.equal(res.status, 400);
  res = await send({ ...base, company: 'Bad File Co' }, { name: 'jd.pdf', bytes: Buffer.from('just text, not a PDF') });
  assert.equal(res.status, 400);
  assert.match(JSON.stringify(await res.json()), /job description/);
  assert.ok(!srv.records('hire-requests').some((r) => /^Bad /.test(r.company)));
});

test('the short forms still work without a file', async () => {
  const res = await srv.request('/api/hire', { method: 'POST', headers: { accept: 'application/json' }, form: { ...base, company: 'Quick Co', email: 'q@quick.example' } });
  assert.equal(res.status, 200);
  assert.equal(srv.records('hire-requests').find((r) => r.company === 'Quick Co').followUp, 'New');
});
