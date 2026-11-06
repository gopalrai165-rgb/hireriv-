// Step 194: email campaigns. Only people who asked get them, consent and bounces
// are checked again before each email, a test and the password come first, the
// wording is escaped, the unsubscribe link holds no address and works in one
// click, nobody gets it twice, and addresses don't stay behind.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, decodeEmail } = require('./helpers');
const { hashPassword } = require('../employers');

const iso = (d = 0) => new Date(Date.now() - d * 864e5).toISOString();
const sub = (id, email) => ({ id, email, createdAt: iso(5) });
const LIST = ['ana', 'ben', 'chi', 'dev', 'eka'].map((n, i) => sub(`sub-000${i}`, `${n}@list.in`));

let srv;
let admin;
let seq = 0;
const h = () => ({ 'x-forwarded-for': `10.194.0.${(++seq % 250) + 1}` });
const post = (url, form, cookie = admin) => srv.request(url, { method: 'POST', form, cookie, headers: h() });
const html = async (url, cookie = admin) => (await srv.request(url, { cookie, headers: h() })).text();
const rec = (id) => srv.records('email-campaigns').find((c) => c.id === id);
const mailsTo = (addr, subject) => srv.emails().filter((m) => m.includes(`To: ${addr}`) && decodeEmail(m).includes(subject));
const wait = async (fn, ms = 6000) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 40))) { const v = fn(); if (v) return v; } return fn(); };
const FORM = { subject: 'New jobs this week', text: 'Hello.\n\nHere are the new jobs at https://hireriv.example/jobs, have a look.' };
async function draft(form = FORM) {
  const r = await post('/admin/campaigns', form);
  assert.equal(r.status, 303);
  return r.headers.get('location').match(/campaigns\/([0-9a-f-]{36})/)[1];
}
const tested = async (form) => { const id = await draft(form); assert.equal((await post(`/admin/campaigns/${id}/test`, {})).status, 303); return id; };

before(async () => {
  srv = await startServer({ TRUST_PROXY: '1', CAMPAIGN_TICK_MS: '60', CAMPAIGN_BATCH: '2' }, {
    newsletter: LIST,
    'email-suppressions': [],
    team: [{ id: 't-rita', name: 'Rita', email: 'rita@hireriv.test', role: 'Recruiter', active: true, passwordHash: hashPassword('Rita long password'), createdAt: iso(50) }],
    candidates: [{ id: 'c1', email: 'notonlist@ex.in', createdAt: iso(3), emailVerifiedAt: iso(3), profile: {}, resumes: [] }],
  });
  admin = await srv.adminLogin();
}, { timeout: 60000 });
after(() => srv && srv.stop());

test('only Admins, and the sidebar links to it for them', async () => {
  const rita = srv.cookieFrom(await srv.request('/admin/login', { method: 'POST', form: { login: 'rita@hireriv.test', password: 'Rita long password' }, headers: h() }));
  for (const url of ['/admin/campaigns', '/admin/campaigns/new']) assert.equal((await srv.request(url, { cookie: rita, headers: h() })).status, 403, url);
  assert.equal((await post('/admin/campaigns', FORM, rita)).status, 403);
  assert.notEqual((await srv.request('/admin/campaigns', { headers: h() })).status, 200);
  const page = await html('/admin/campaigns');
  assert.match(page, /href="\/admin\/campaigns"/);
  assert.match(page, /<span class="kpi-value">5<\/span>/);
  assert.doesNotMatch(page, /@list\.in/, 'no addresses on the page');
  const cross = await srv.request('/admin/campaigns', { method: 'POST', form: FORM, cookie: admin, headers: { ...h(), origin: 'https://evil.example' } });
  assert.equal(cross.status, 403);
});

test('the form is checked and words are escaped everywhere', async () => {
  for (const bad of [{ subject: 'Hi', text: FORM.text }, { subject: FORM.subject, text: 'short' }, { ...FORM, buttonLabel: 'Go' }, { ...FORM, buttonLabel: 'Go', buttonLink: 'javascript:alert(1)' }, { ...FORM, buttonLabel: 'Go', buttonLink: 'http://x.example' }, { ...FORM, buttonLabel: 'Go', buttonLink: '//evil.example' }]) {
    assert.equal((await post('/admin/campaigns', bad)).status, 400, JSON.stringify(bad));
  }
  const id = await draft({ subject: 'Safe <img src=x> subject', text: 'Line <script>alert(1)</script> here and "quotes" https://a.example/?q=<b>.', buttonLabel: 'Go <b>', buttonLink: '/jobs' });
  const page = await html(`/admin/campaigns/${id}`);
  assert.doesNotMatch(page, /<script>alert\(1\)|<img src=x>|<b>\./);
  assert.match(page, /Line &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(page, /<a href="https:\/\/a\.example\/\?q=">https:\/\/a\.example\/\?q=<\/a>&lt;b&gt;\./, 'a link stops at markup, and the rest is escaped');
  assert.match(page, /&quot;quotes&quot;/);
  await post(`/admin/campaigns/${id}/delete`, {});
  assert.equal(rec(id), undefined);
});

test('a test of that wording and the password come first', async () => {
  const id = await draft();
  await srv.confirm(admin);
  const noTest = await post(`/admin/campaigns/${id}/send`, {});
  assert.match(decodeURIComponent(noTest.headers.get('location')), /Send yourself a test/);
  assert.equal(rec(id).status, 'draft');
  assert.doesNotMatch(await html(`/admin/campaigns/${id}`), /action="[^"]*\/send"/, 'no send button yet');

  await post(`/admin/campaigns/${id}/test`, {});
  assert.ok(rec(id).testedAt);
  const m = await srv.waitForEmail((e) => decodeEmail(e).includes('New jobs this week'));
  assert.doesNotMatch(m, /To: [a-z]+@list\.in/, 'the test goes only to the person sending it');
  assert.equal(mailsTo('ana@list.in', 'New jobs this week').length, 0);

  // Changing the wording needs a new test; saving the same words does not.
  await post(`/admin/campaigns/${id}`, FORM);
  assert.ok(rec(id).testedAt);
  await post(`/admin/campaigns/${id}`, { ...FORM, text: `${FORM.text} One more line.` });
  assert.equal(rec(id).testedAt, null);
  await post(`/admin/campaigns/${id}/delete`, {});

  // Without a fresh password the send is sent to the confirm page.
  const other = await srv.adminLogin();
  const t = await tested({ ...FORM, subject: 'Needs a password' });
  const r = await post(`/admin/campaigns/${t}/send`, {}, other);
  assert.match(r.headers.get('location') || '', /\/admin\/confirm/);
  assert.equal(rec(t).status, 'draft');
  await post(`/admin/campaigns/${t}/delete`, {});
});

test('it reaches the list once each, in batches, skips who left or bounced, and keeps no addresses', async () => {
  const subject = 'Round-up to the list';
  await srv.confirm(admin);
  const id = await tested({ ...FORM, subject, buttonLabel: 'See jobs', buttonLink: '/jobs' });
  const before = srv.records('newsletter').length;
  const sent = await post(`/admin/campaigns/${id}/send`, {});
  assert.match(decodeURIComponent(sent.headers.get('location')), /Sending to 5 people/);
  const done = await wait(() => { const c = rec(id); return c.status === 'sent' ? c : null; });
  assert.ok(done, 'finished');
  assert.equal(done.total, 5);
  assert.equal(done.sent, 5);
  assert.equal(done.failed, 0);
  for (const s of LIST) assert.equal(mailsTo(s.email, subject).length, 1, s.email);
  assert.equal(mailsTo('notonlist@ex.in', subject).length, 0, 'an account that did not ask gets nothing');
  assert.equal(srv.records('email-campaign-queue').length, 0, 'no addresses stay behind');
  assert.ok(!JSON.stringify(rec(id)).includes('@list.in'));
  assert.equal(srv.records('newsletter').length, before);
  // It can't be sent twice or changed afterwards.
  assert.match(decodeURIComponent((await post(`/admin/campaigns/${id}/send`, {})).headers.get('location')), /already been sent/);
  assert.match(decodeURIComponent((await post(`/admin/campaigns/${id}`, FORM)).headers.get('location')), /can no longer be changed/);
  assert.match(decodeURIComponent((await post(`/admin/campaigns/${id}/delete`, {})).headers.get('location')), /Only a draft/);

  const raw = mailsTo('ana@list.in', subject)[0];
  const text = decodeEmail(raw);
  assert.match(raw, /List-Unsubscribe-Post: List-Unsubscribe=One-Click/i);
  assert.match(text, /Stop these emails/);
  assert.match(text, /\/jobs/);
});

test('leaving: the link holds no address, opening only asks, the button or one-click removes', async () => {
  const subject = 'Round-up to the list';
  const text = decodeEmail(mailsTo('ben@list.in', subject)[0]);
  const url = text.match(/\/newsletter\/unsubscribe\/[A-Za-z0-9_.-]+/)[0];
  assert.doesNotMatch(url, /ben|list\.in/);
  assert.equal((await srv.request(url.slice(0, -2) + 'xx', { headers: h() })).status, 404, 'a changed link is refused');
  assert.equal((await srv.request(url.slice(0, -2) + 'xx', { method: 'POST', form: {}, headers: h() })).status, 404);

  const asked = await (await srv.request(url, { headers: h() })).text();
  assert.match(asked, /Stop the emails/);
  assert.ok(srv.records('newsletter').some((s) => s.email === 'ben@list.in'), 'opening alone changes nothing');

  // As a mail program sends it: another origin, no cookie.
  const r = await fetch(srv.base + url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '10.194.1.1' }, body: 'List-Unsubscribe=One-Click' });
  assert.equal(r.status, 200);
  assert.match(await r.text(), /You won.t get these emails again/);
  assert.ok(!srv.records('newsletter').some((s) => s.email === 'ben@list.in'));
  const id = srv.records('email-campaigns').find((c) => c.subject === subject).id;
  assert.equal(rec(id).unsubscribed, 1);
  // Twice is harmless and is not counted twice.
  await srv.request(url, { method: 'POST', form: {}, headers: h() });
  assert.equal(rec(id).unsubscribed, 1);
  assert.match(await (await srv.request(url, { headers: h() })).text(), /You won.t get these emails again/);
  assert.equal((await html('/admin/campaigns')).match(/<span class="kpi-value">(\d+)<\/span>/)[1], '4', 'and they are gone from the audience');
});

test('someone who leaves after sending started is skipped; stopping empties the queue', async () => {
  // A slow queue, so the steps below happen before the first batch.
  const slow = await startServer({ TRUST_PROXY: '1', CAMPAIGN_TICK_MS: '1500', CAMPAIGN_BATCH: '50' }, {
    newsletter: [sub('sub-a', 'leaver@list.in'), sub('sub-b', 'stayer@list.in')],
    candidates: [{ id: 'c-l', email: 'leaver@list.in', createdAt: iso(3), emailVerifiedAt: iso(3), passwordHash: hashPassword('leaver long password'), profile: {}, resumes: [] }],
  });
  try {
    const cookie = await slow.adminLogin();
    await slow.confirm(cookie);
    const leaver = slow.cookieFrom(await slow.request('/account/login', { method: 'POST', form: { email: 'leaver@list.in', password: 'leaver long password' } }));
    const start = async (subject) => {
      const made = await slow.request('/admin/campaigns', { method: 'POST', cookie, form: { ...FORM, subject } });
      const id = made.headers.get('location').match(/campaigns\/([0-9a-f-]{36})/)[1];
      await slow.request(`/admin/campaigns/${id}/test`, { method: 'POST', cookie, form: {} });
      await slow.request(`/admin/campaigns/${id}/send`, { method: 'POST', cookie, form: {} });
      return id;
    };
    const one = (id) => slow.records('email-campaigns').find((c) => c.id === id);

    const stopped = await start('Stopped before the first batch');
    assert.equal(one(stopped).status, 'sending');
    assert.equal(slow.records('email-campaign-queue').length, 2);
    await slow.request(`/admin/campaigns/${stopped}/stop`, { method: 'POST', cookie, form: {} });
    assert.equal(one(stopped).status, 'stopped');
    assert.equal(slow.records('email-campaign-queue').length, 0);
    assert.equal(one(stopped).sent, 0);

    const left = await start('Goes to the one who stayed');
    assert.equal(one(left).total, 2);
    const off = await slow.request('/notifications/settings', { method: 'POST', cookie: leaver, form: {} });
    assert.ok(off.status < 400, `settings answered ${off.status}`);
    assert.ok(!slow.records('newsletter').some((s) => s.email === 'leaver@list.in'), 'left the list');
    const done = await wait(() => (one(left).status === 'sent' ? one(left) : null), 8000);
    assert.ok(done, 'finished');
    assert.equal(done.sent, 1);
    assert.equal(done.skipped, 1);
    const got = (addr) => slow.emails().filter((m) => m.includes(`To: ${addr}`) && decodeEmail(m).includes('Goes to the one who stayed')).length;
    assert.equal(got('stayer@list.in'), 1);
    assert.equal(got('leaver@list.in'), 0);
  } finally { await slow.stop(); }
});

test('with nobody on the list there is nothing to send', async () => {
  const empty = await startServer({}, { newsletter: [] });
  try {
    const cookie = await empty.adminLogin();
    await empty.confirm(cookie);
    const r = await empty.request('/admin/campaigns', { method: 'POST', cookie, form: FORM });
    const id = r.headers.get('location').match(/campaigns\/([0-9a-f-]{36})/)[1];
    await empty.request(`/admin/campaigns/${id}/test`, { method: 'POST', cookie, form: {} });
    const page = await (await empty.request(`/admin/campaigns/${id}`, { cookie })).text();
    assert.match(page, /Nobody has asked for these emails yet/);
    assert.doesNotMatch(page, /action="[^"]*\/send"/);
    const s = await empty.request(`/admin/campaigns/${id}/send`, { method: 'POST', cookie, form: {} });
    assert.match(decodeURIComponent(s.headers.get('location')), /Nobody has asked/);
  } finally { await empty.stop(); }
});
