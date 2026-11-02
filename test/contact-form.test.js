// The contact form: a subject must be chosen; employers who write in become
// hire requests (owner, status, reminders, CRM) instead of a plain message.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

let srv;
before(async () => { srv = await startServer(); });
after(() => srv && srv.stop());
const send = (form) => srv.request('/api/contact', { method: 'POST', headers: { accept: 'application/json' }, form });

test('the subject must be chosen, and the form asks hiring visitors for company and phone', async () => {
  const html = await (await srv.request('/contact')).text();
  assert.match(html, /<select name="subject" required><option value="">Choose one<\/option>/);
  assert.match(html, /name="company"/);
  assert.match(html, /name="source" value="" data-source/);
  assert.equal((await send({ name: 'A', email: 'a@x.example', subject: 'Free money', message: 'hi' })).status, 400);
});

test('a job seeker message stays a contact message', async () => {
  const res = await send({ name: 'Asha', email: 'asha@x.example', subject: "I'm looking for a job", message: 'Any driver jobs?' });
  assert.equal(res.status, 200);
  assert.ok(srv.records('contacts').some((c) => c.email === 'asha@x.example'));
  assert.ok(!srv.records('hire-requests').some((h) => h.email === 'asha@x.example'));
});

test('an employer message becomes a hire request with the Contact page as its origin', async () => {
  let res = await send({ name: 'Ravi', email: 'ravi@crest.example', subject: 'I want to hire', message: 'Need 10 guards' });
  assert.equal(res.status, 400);
  assert.match(JSON.stringify(await res.json()), /company name and a phone number/);

  res = await send({ name: 'Ravi', email: 'ravi@crest.example', phone: '9811122233', company: 'Crest Security', subject: 'I want to hire', message: 'Need 10 guards in Pune', source: 'google' });
  assert.equal(res.status, 200);
  const h = srv.records('hire-requests').find((r) => r.company === 'Crest Security');
  assert.ok(h);
  assert.equal(h.fromPage, 'Contact page');
  assert.equal(h.roles, 'Need 10 guards in Pune');
  assert.equal(h.source, 'google');
  assert.equal(h.followUp, 'New');
  assert.ok(!srv.records('contacts').some((c) => c.email === 'ravi@crest.example'), 'not saved twice');
  assert.ok(await srv.waitForEmail((m) => m.includes('received your hiring requirement') && m.includes('ravi@crest.example')));
  assert.ok(srv.records('crm-leads').some((l) => l.companyName === 'Crest Security'));
});
