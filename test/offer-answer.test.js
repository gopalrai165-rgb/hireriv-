// Job offers answered by the candidate: an approved offer shows in their
// account with Accept and Decline, the company is told, and the stage stays at
// Offer until the company marks them Hired.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, decodeEmail } = require('./helpers');
const { hashPassword } = require('../employers');
const starter = require('./fixtures/jobs.json');

const EMP = { id: 'emp-old', company: 'Old Co', name: 'Olga Rao', email: 'olga@oldco.in', passwordHash: hashPassword('olga long password'), passwordSetAt: '2026-01-01T00:00:00.000Z', active: true, createdAt: '2026-01-01T00:00:00.000Z' };
const JOB = { ...starter[0], id: 'hr-900', title: 'Packer', company: 'Old Co', employerId: 'emp-old', createdBy: 'employer', status: 'open', sample: false };
const JOB2 = { ...starter[1], id: 'hr-901', title: 'Picker', company: 'Old Co', employerId: 'emp-old', createdBy: 'employer', status: 'open', sample: false };
const offer = (id, approval = 'approved') => ({
  id, createdAt: '2026-11-01T05:00:00.000Z', createdBy: 'Olga Rao', createdByUserId: 'u1', title: 'Senior Packer', salary: { amount: 21000, period: 'month', currency: 'INR' },
  joiningDate: '2030-12-01', respondBy: '2030-11-20', notes: 'Internal: can go to 23k',
  approval: { status: approval, by: approval === 'approved' ? 'Olga Rao' : null, userId: null, at: approval === 'approved' ? '2026-11-01T06:00:00.000Z' : null, note: '' },
  response: { status: 'awaiting', at: null, recordedBy: null, note: '' },
});
const app = (id, jobId, title, extra) => ({ id, jobId, jobTitle: title, email: 'asha@example.in', name: 'Asha Rao', phone: '9811100001', createdAt: '2026-10-20T05:00:00.000Z', status: 'Offered', ...extra });
let srv; let seeker; let employer;
before(async () => {
  srv = await startServer({}, {
    employers: [EMP], jobs: [JOB, JOB2],
    applications: [
      app('app-1', 'hr-900', 'Packer', { offers: [offer('of-1')] }),
      app('app-2', 'hr-901', 'Picker', { offers: [offer('of-2')] }),
      app('app-3', 'hr-900', 'Packer', { status: 'Interview', offers: [offer('of-3', 'pending')], createdAt: '2026-10-10T05:00:00.000Z' }),
      { ...app('app-9', 'hr-900', 'Packer', { offers: [offer('of-9')] }), email: 'ravi@example.in', name: 'Ravi Kumar' },
    ],
  });
  const fd = new FormData();
  for (const [k, v] of Object.entries({ agree: '1', name: 'Asha Rao', email: 'asha@example.in', phone: '9811100001' })) fd.append(k, v);
  await srv.request('/account/register', { method: 'POST', body: fd });
  const seen = srv.emails().length;
  await srv.request('/account/login', { method: 'POST', form: { email: 'asha@example.in' } });
  for (let i = 0; i < 100 && !seeker; i++) {
    await new Promise((r) => setTimeout(r, 50));
    const mail = srv.emails().slice(seen).map(decodeEmail).find((e) => e.includes('/account/verify/'));
    if (mail) seeker = srv.cookieFrom(await srv.request(mail.match(/\/account\/verify\/[A-Za-z0-9_-]+/)[0], { method: 'POST', form: {} }));
  }
  employer = srv.cookieFrom(await srv.request('/employer/login', { method: 'POST', form: { email: 'olga@oldco.in', password: 'olga long password' } }));
});
after(() => srv && srv.stop());
const page = async (p, cookie) => (await srv.request(p, { cookie })).text();
const offerOf = (appId) => srv.records('applications').find((x) => x.id === appId).offers[0];
const answer = (appId, offerId, what, form = {}, cookie = seeker) => srv.request(`/account/offers/${appId}/${offerId}/${what}`, { method: 'POST', cookie, form });
const msgOf = (res) => decodeURIComponent(String(res.headers.get('location')));

test('approved offers show in the account with pay, dates and Accept / Decline; the company\'s notes and unapproved offers do not', async () => {
  const html = await page('/account', seeker);
  assert.match(html, /id="offers"/);
  assert.match(html, /You have 2 job offers/);
  assert.match(html, /Senior Packer <span class="muted">at Old Co/);
  assert.match(html, /₹21,000 a month/);
  assert.match(html, /action="\/account\/offers\/app-1\/of-1\/accept"/);
  assert.match(html, /action="\/account\/offers\/app-2\/of-2\/decline"/);
  assert.doesNotMatch(html, /can go to 23k/, 'internal notes stay with the company');
  assert.doesNotMatch(html, /of-3/, 'an offer not yet approved is not shown');
});

test('accepting tells the company; the stage stays at Offer and it cannot be answered twice', async () => {
  const cross = await srv.request('/account/offers/app-1/of-1/accept', { method: 'POST', cookie: seeker, headers: { origin: 'https://evil.example' }, form: {} });
  assert.equal(cross.status, 403);
  const out = await answer('app-1', 'of-1', 'accept', {}, '');
  assert.doesNotMatch(msgOf(out), /^\/account\?msg=/, 'signed out cannot answer');
  assert.equal(offerOf('app-1').response.status, 'awaiting');

  const res = await answer('app-1', 'of-1', 'accept');
  assert.equal(res.status, 303);
  assert.match(msgOf(res), /^\/account\?msg=Congratulations! The company has been told you accept the offer for Packer[^#]*#offers$/);
  const o = offerOf('app-1');
  assert.equal(o.response.status, 'accepted');
  assert.equal(o.response.byCandidate, true);
  assert.equal(srv.records('applications').find((x) => x.id === 'app-1').status, 'Offered', 'the company marks them Hired when they join');
  const mail = decodeEmail(await srv.waitForEmail((m) => m.includes('To: olga@oldco.in') && m.includes('accepted your offer')));
  assert.match(mail, /Your offer was accepted/);
  assert.match(await page('/employer/applicants/app-1', employer), /The candidate accepted in their Hireriv account/);
  assert.match(msgOf(await answer('app-1', 'of-1', 'decline')), /Not saved: you already accepted this offer/);
  const html = await page('/account', seeker);
  assert.match(html, /You have a job offer/, 'only the other one is still open');
  assert.match(html, /<b>Offer accepted<\/b>/);
});

test('declining with a reason tells the company the reason', async () => {
  const res = await answer('app-2', 'of-2', 'decline', { note: 'I accepted another offer' });
  assert.match(msgOf(res), /The company has been told you decline the offer for Picker/);
  assert.equal(offerOf('app-2').response.status, 'declined');
  assert.equal(offerOf('app-2').response.note, 'I accepted another offer');
  const mail = decodeEmail(await srv.waitForEmail((m) => m.includes('To: olga@oldco.in') && m.includes('declined your offer')));
  assert.match(mail, /I accepted another offer/);
  assert.doesNotMatch(await page('/account', seeker), /id="offers"/, 'nothing left to answer');
});

test('someone else\'s offer, an unapproved one or an unknown answer change nothing', async () => {
  assert.match(msgOf(await answer('app-9', 'of-9', 'accept')), /no longer open/);
  assert.equal(offerOf('app-9').response.status, 'awaiting');
  assert.match(msgOf(await answer('app-3', 'of-3', 'accept')), /no longer open/);
  assert.equal((await answer('app-9', 'of-9', 'maybe')).status, 404);
});
