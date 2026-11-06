// Step 195: government job notices. Nothing is public until a person has checked
// the official source, every page says Hireriv is not part of the government,
// changes take a notice down until checked again, old ones leave the list, and the
// section is not linked or listed while empty. They are not vacancies: no job data.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');
const { hashPassword } = require('../employers');
const { isOfficialHost, sourceHost } = require('../gov-jobs');

const DAY = 864e5;
const day = (d) => new Date(Date.now() + d * DAY + 5.5 * 36e5).toISOString().slice(0, 10);
const iso = (d = 0) => new Date(Date.now() - d * DAY).toISOString();
const FORM = { title: 'Junior Engineer Exam', organisation: 'Staff Selection Board', lastDate: day(20), sourceUrl: 'https://ssb.example.gov.in/notice.pdf', posts: '120', qualification: 'Diploma', location: 'All India', summary: 'Written exam, then documents.' };

let srv;
let admin;
let seq = 0;
const h = () => ({ 'x-forwarded-for': `10.195.0.${(++seq % 250) + 1}` });
const post = (url, form, cookie = admin) => srv.request(url, { method: 'POST', form, cookie, headers: h() });
const page = async (url, cookie) => { const r = await srv.request(url, { cookie, headers: h() }); return { status: r.status, html: await r.text() }; };
const rec = (id) => srv.records('gov-notices').find((n) => n.id === id);
async function draft(form = FORM) {
  const r = await post('/admin/government-jobs', form);
  assert.equal(r.status, 303);
  return r.headers.get('location').match(/government-jobs\/([0-9a-f-]{36})/)[1];
}
const NOTICE = /not part of, or connected with, the government/;

before(async () => {
  srv = await startServer({ TRUST_PROXY: '1' }, {
    team: [{ id: 't-r', name: 'Rita', email: 'rita@hireriv.test', role: 'Recruiter', active: true, passwordHash: hashPassword('Rita long password'), createdAt: iso(50) }],
    'gov-notices': [{ id: 'old-one', title: 'Old exam', organisation: 'Old Board', lastDate: day(-3), sourceUrl: 'https://old.gov.in/n', status: 'published', createdAt: iso(30), checkedAt: iso(30), checkedBy: 'Asha' }],
  });
  admin = await srv.adminLogin();
}, { timeout: 60000 });
after(() => srv && srv.stop());

test('official addresses', () => {
  for (const u of ['https://upsc.gov.in/x', 'https://a.nic.in', 'https://iitb.ac.in', 'https://drdo.res.in']) assert.ok(isOfficialHost(sourceHost(u)), u);
  for (const u of ['https://gov.in.evil.com', 'https://fakegov.in', 'https://sarkari-jobs.com', 'https://evilgov.in/a.gov.in']) assert.ok(!isOfficialHost(sourceHost(u)), u);
  for (const u of ['http://upsc.gov.in', 'javascript:alert(1)', 'ftp://a.gov.in', 'https://user:pw@a.gov.in', 'not a link']) assert.equal(sourceHost(u), '', u);
});

test('with nothing current the section is hidden: no links, no sitemap, out of search', async () => {
  const home = await page('/');
  assert.doesNotMatch(home.html, /href="\/government-jobs"/);
  assert.doesNotMatch((await page('/sitemap.xml')).html, /government-jobs/);
  const list = await page('/government-jobs');
  assert.equal(list.status, 200);
  assert.match(list.html, /No notices are open right now/);
  assert.match(list.html, NOTICE);
  assert.match(list.html, /noindex/);
});

test('only Admins manage notices, from this site only, with the fields checked', async () => {
  const rita = srv.cookieFrom(await srv.request('/admin/login', { method: 'POST', form: { login: 'rita@hireriv.test', password: 'Rita long password' }, headers: h() }));
  assert.equal((await page('/admin/government-jobs', rita)).status, 403);
  assert.equal((await post('/admin/government-jobs', FORM, rita)).status, 403);
  assert.notEqual((await page('/admin/government-jobs')).status, 200);
  assert.equal((await srv.request('/admin/government-jobs', { method: 'POST', form: FORM, cookie: admin, headers: { ...h(), origin: 'https://evil.example' } })).status, 403);
  for (const bad of [{ title: 'x' }, { organisation: '' }, { lastDate: '2026-02-30' }, { lastDate: 'soon' }, { sourceUrl: 'http://a.gov.in' }, { sourceUrl: 'javascript:alert(1)' }]) {
    assert.equal((await post('/admin/government-jobs', { ...FORM, ...bad })).status, 400, JSON.stringify(bad));
  }
});

test('a draft is not public; publishing needs the tick; then every page carries the notice', async () => {
  const id = await draft();
  assert.equal((await page(`/government-jobs/${id}`)).status, 404, 'a draft is not public');
  assert.doesNotMatch((await page('/government-jobs')).html, /Junior Engineer/);

  const noTick = await post(`/admin/government-jobs/${id}/publish`, {});
  assert.equal(noTick.status, 400);
  assert.match(await noTick.text(), /Tick that you read the official notice/);
  assert.equal(rec(id).status, 'draft');

  assert.equal((await post(`/admin/government-jobs/${id}/publish`, { checked: '1' })).status, 303);
  assert.equal(rec(id).status, 'published');
  assert.ok(rec(id).checkedAt);
  assert.equal(rec(id).checkedBy, 'Owner');
  assert.ok(srv.records('activity').some((e) => e.action === 'Published a government job notice' && e.detail.includes('ssb.example.gov.in')));

  const list = await page('/government-jobs');
  assert.match(list.html, /Junior Engineer Exam/);
  assert.match(list.html, NOTICE);
  assert.doesNotMatch(list.html, /noindex/);
  const one = await page(`/government-jobs/${id}`);
  assert.equal(one.status, 200);
  assert.match(one.html, NOTICE);
  assert.match(one.html, /Nobody can get you a government job for a payment/);
  assert.match(one.html, /href="https:\/\/ssb\.example\.gov\.in\/notice\.pdf" target="_blank" rel="noopener noreferrer nofollow"/);
  assert.doesNotMatch(one.html, /JobPosting/, 'not a vacancy for search engines');
  assert.doesNotMatch(one.html, /\/apply\b|name="resume"/, 'no applying here');

  assert.match((await page('/')).html, /href="\/government-jobs"/);
  assert.match((await page('/sitemap.xml')).html, new RegExp(`/government-jobs/${id}`));
  await post(`/admin/government-jobs/${id}/withdraw`, {});
});

test('an address outside the usual government ones needs a second tick', async () => {
  const id = await draft({ ...FORM, title: 'Bank clerk exam', sourceUrl: 'https://bank-board.example.com/n' });
  assert.match((await page(`/admin/government-jobs/${id}`, admin)).html, /not a usual government one/);
  const one = await post(`/admin/government-jobs/${id}/publish`, { checked: '1' });
  assert.equal(one.status, 400);
  assert.match(await one.text(), /bank-board\.example\.com is not a usual government address/);
  assert.equal((await post(`/admin/government-jobs/${id}/publish`, { checked: '1', otherSource: '1' })).status, 303);
  assert.equal(rec(id).status, 'published');
  await post(`/admin/government-jobs/${id}/withdraw`, {});
});

test('a change takes it down until checked again; taken down says so and leaves search', async () => {
  const id = await draft({ ...FORM, title: 'Clerk exam' });
  await post(`/admin/government-jobs/${id}/publish`, { checked: '1' });
  const same = await post(`/admin/government-jobs/${id}`, { ...FORM, title: 'Clerk exam' });
  assert.match(decodeURIComponent(same.headers.get('location')), /No changes/);
  assert.equal(rec(id).status, 'published');

  const changed = await post(`/admin/government-jobs/${id}`, { ...FORM, title: 'Clerk exam', lastDate: day(40) });
  assert.match(decodeURIComponent(changed.headers.get('location')), /taken off the site until it is checked again/);
  assert.equal(rec(id).status, 'draft');
  assert.equal(rec(id).checkedAt, null);
  assert.equal((await page(`/government-jobs/${id}`)).status, 404);

  await post(`/admin/government-jobs/${id}/publish`, { checked: '1' });
  assert.match(decodeURIComponent((await post(`/admin/government-jobs/${id}/delete`, {})).headers.get('location')), /Take it off the site/);
  await post(`/admin/government-jobs/${id}/withdraw`, {});
  const gone = await page(`/government-jobs/${id}`);
  assert.equal(gone.status, 410);
  assert.match(gone.html, /no longer open/);
  assert.match(gone.html, /noindex/);
  await post(`/admin/government-jobs/${id}/delete`, {});
  assert.equal(rec(id), undefined);
});

test('past its last day a notice leaves the list and can not be published', async () => {
  assert.doesNotMatch((await page('/government-jobs')).html, /Old exam/);
  assert.doesNotMatch((await page('/sitemap.xml')).html, /old-one/);
  const old = await page('/government-jobs/old-one');
  assert.equal(old.status, 410);
  assert.match(old.html, /no longer open/);
  assert.match((await page('/admin/government-jobs', admin)).html, /Last date passed/);
  const id = await draft({ ...FORM, title: 'Too late', lastDate: day(-1) });
  const r = await post(`/admin/government-jobs/${id}/publish`, { checked: '1' });
  assert.equal(r.status, 400);
  assert.match(await r.text(), /last date has passed/);
  await post(`/admin/government-jobs/${id}/delete`, {});
});

test('words are escaped on the public and team pages', async () => {
  const id = await draft({ ...FORM, title: 'Exam <script>alert(1)</script>', organisation: 'Board <img src=x>', summary: 'Hi <b>there</b>' });
  await post(`/admin/government-jobs/${id}/publish`, { checked: '1' });
  for (const url of ['/government-jobs', `/government-jobs/${id}`, `/admin/government-jobs/${id}`]) {
    const { html } = await page(url, url.startsWith('/admin') ? admin : undefined);
    assert.doesNotMatch(html, /<script>alert\(1\)|<img src=x>|<b>there/, url);
  }
  await post(`/admin/government-jobs/${id}/withdraw`, {});
});
