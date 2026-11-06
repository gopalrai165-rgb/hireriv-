// Step 189 (tests for Step 188): plans, renewals and contact credit packs in the
// team's analytics, who may see them, the CSV, and the analytics cache: a reload
// reuses the answer until something is written, and one person's answer is never
// handed to another.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');
const { hashPassword } = require('../employers');

const DAY = 86400000;
const iso = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString();
const ymd = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

const billing = (id, employerId, kind, daysAgo, totalPaise, extra = {}) => ({
  id, number: `INV-${id}`, employerId, kind, date: ymd(daysAgo), dueDate: ymd(daysAgo - 10), totalPaise,
  lines: [], payments: [], creditNotes: [], refunds: [], status: 'Unpaid', createdAt: iso(daysAgo), ...extra,
});
const paid = (daysAgo, amountPaise) => ({ id: `pay-${daysAgo}-${amountPaise}`, date: ymd(daysAgo), amountPaise, mode: 'Bank transfer', reference: 'UTR1' });

let srv;
const p = {};
let ip = 0;
const headers = (extra = {}) => ({ 'x-forwarded-for': `10.189.${Math.floor(++ip / 250)}.${ip % 250}`, 'user-agent': 'TestBrowser/1.0', ...extra });
const api = async (url, cookie) => {
  const r = await srv.request(url, { cookie, headers: headers({ accept: 'application/json' }) });
  return { ...(await r.json().catch(() => ({}))), status: r.status };
};
const signIn = async (url, form) => srv.cookieFrom(await srv.request(url, { method: 'POST', form, headers: headers() }));
const person = (name, email) => ({ id: `u-${name}`, email, name, phone: '', passwordHash: hashPassword(`${name} long password`), emailVerifiedAt: iso(1), createdAt: iso(1), active: true, link: null });
const teamUser = (id, name, role) => ({ id, name, email: `${name.toLowerCase()}@hireriv.test`, role, active: true, passwordHash: hashPassword(`${name} long password`), createdAt: iso(50) });

before(async () => {
  srv = await startServer({ TRUST_PROXY: '1' }, {
    employers: [
      { id: 'emp-a', company: 'A Co', name: 'Olga', email: 'olga@aco.in', active: true, createdAt: iso(40) },
      { id: 'emp-b', company: 'B Co', name: 'Bob', email: 'bob@bco.in', active: true, createdAt: iso(40) },
    ],
    'employer-users': [person('Olga', 'olga@aco.in')],
    'employer-members': [{ id: 'm1', employerId: 'emp-a', userId: 'u-Olga', role: 'owner', jobIds: [], createdAt: iso(1) }],
    team: [teamUser('t-fin', 'Fina', 'Finance Manager'), teamUser('t-rita', 'Rita', 'Recruiter'), teamUser('t-acc', 'Asha', 'Account Manager')],
    // A placement recorded by a recruiter: Finance did not make it but must count its money.
    placements: [{ id: 'p1', type: 'Permanent', status: 'Joined', fee: 50000, joiningDate: ymd(3), candidateName: 'Placed', jobTitle: 'Job', employerId: 'emp-a', company: 'A Co', recruiterId: 't-rita', createdAt: iso(4), invoice: { number: 'INV-placed', date: ymd(4), dueDate: ymd(-10), subtotal: 50000, total: 59000, status: 'Paid', payments: [{ date: ymd(2), amount: 59000, tds: 0 }], creditNotes: [], refunds: [] } }],
    'billing-invoices': [
      billing('plan1', 'emp-a', 'subscription', 5, 100000, { status: 'Paid', payments: [paid(4, 100000)] }),
      billing('pack1', 'emp-a', 'package', 3, 49900, { status: 'Part paid', payments: [paid(2, 40000)], refunds: [{ id: 'r1', date: ymd(1), amountPaise: 10000 }] }),
      billing('plan2', 'emp-b', 'subscription', 2, 200000),
      billing('old', 'emp-a', 'subscription', 200, 700000, { status: 'Paid', payments: [paid(199, 700000)] }),
      billing('void', 'emp-a', 'subscription', 4, 900000, { status: 'Cancelled', payments: [paid(3, 900000)] }),
    ],
  });
  p.admin = await srv.adminLogin();
  p.fin = await signIn('/admin/login', { login: 'fina@hireriv.test', password: 'Fina long password' });
  p.acc = await signIn('/admin/login', { login: 'asha@hireriv.test', password: 'Asha long password' });
  p.rita = await signIn('/admin/login', { login: 'rita@hireriv.test', password: 'Rita long password' });
  p.olga = await signIn('/employer/login', { email: 'olga@aco.in', password: 'Olga long password' });
}, { timeout: 60000 });
after(() => srv && srv.stop());

test('plans and credit packs add up: payments less refunds in the range, cancelled invoices out', async () => {
  const r = await api('/api/analytics/revenue', p.fin);
  assert.equal(r.status, 200);
  const pl = r.data.plans;
  assert.equal(pl.available, true);
  assert.equal(pl.plansPaise, 100000);
  assert.equal(pl.packsPaise, 30000, '40,000 paid less the 10,000 refund');
  assert.equal(pl.collectedPaise, 130000);
  assert.equal(pl.refundedPaise, 10000);
  assert.equal(pl.invoicedPaise, 349900);
  assert.equal(pl.invoicesIssued, 3);
  const numbers = pl.invoices.rows.map((x) => x.number).sort();
  assert.deepEqual(numbers, ['INV-pack1', 'INV-plan1', 'INV-plan2']);
  assert.equal(pl.invoices.rows.find((x) => x.number === 'INV-pack1').kind, 'Credit pack');

  const overview = await api('/api/analytics/overview', p.fin);
  const kpi = overview.data.kpis.find((k) => k.id === 'planRevenue');
  assert.equal(kpi.value, 130000);
  assert.equal(kpi.label, 'Plans and credit packs collected');
});

test('Finance and Account Managers see the business, not only placements they recorded', async () => {
  for (const cookie of [p.fin, p.acc]) {
    const r = await api('/api/analytics/revenue', cookie);
    assert.equal(r.status, 200);
    assert.equal(r.data.plans.available, true);
    assert.equal(r.data.collectedPaise, 5900000);
    assert.ok(r.data.invoices.rows.some((x) => x.number === 'INV-placed'));
  }
  // Their recruitment numbers stay their own: the placement is Rita's.
  assert.equal((await api('/api/analytics/placements', p.fin)).data.list.rows.length, 0);
  assert.equal((await api('/api/analytics/placements', p.rita)).data.list.rows.length, 1);
  // Another person's numbers are still refused, money role or not.
  assert.equal((await api('/api/analytics/revenue?recruiter=t-rita', p.fin)).status, 403);
});

test('one employer can be picked; job and recruiter filters say why it is not shown', async () => {
  const one = await api('/api/analytics/revenue?employer=emp-b', p.fin);
  assert.equal(one.data.plans.collectedPaise, 0);
  assert.equal(one.data.plans.invoicedPaise, 200000);
  const filtered = await api('/api/analytics/revenue?location=Pune', p.fin);
  assert.equal(filtered.data.plans.available, false);
  assert.match(filtered.data.plans.note, /Clear the job, recruiter and placement filters/);
  const overview = await api('/api/analytics/overview?location=Pune', p.fin);
  assert.ok(!overview.data.kpis.some((k) => k.id === 'planRevenue'));
});

test('only the team\'s money roles see it: not recruiters, not employers', async () => {
  assert.ok(!(await api('/api/analytics/overview', p.rita)).data.kpis.some((k) => k.id === 'planRevenue'));
  assert.equal((await api('/api/analytics/revenue', p.rita)).status, 403);
  const olga = await api('/api/analytics/revenue', p.olga);
  assert.equal(olga.status, 200);
  assert.equal(olga.data.plans, undefined);
  assert.ok(!(await api('/api/analytics/overview', p.olga)).data.kpis.some((k) => k.id === 'planRevenue'));
});

test('the CSV has plans and packs with a source column; employers get only their placements', async () => {
  const csv = async (cookie) => (await srv.request('/api/analytics/reports/revenue/export', { cookie, headers: headers() })).text();
  const team = (await csv(p.fin)).replace(/^﻿/, '').trim().split('\r\n');
  assert.match(team[0], /,source$/);
  assert.ok(team.some((l) => /^INV-plan1,.*,Plan$/.test(l)));
  assert.ok(team.some((l) => /^INV-pack1,.*,Credit pack$/.test(l)));
  assert.ok(!team.some((l) => /INV-void|INV-old/.test(l)));
  assert.doesNotMatch(await csv(p.olga), /INV-plan|INV-pack/);
});

test('the team page shows the section and the employer page does not', async () => {
  const page = async (url, cookie) => (await srv.request(url, { cookie, headers: headers({ accept: 'text/html' }) })).text();
  const html = await page('/admin/analytics', p.fin);
  assert.match(html, /id="plan-revenue"/);
  assert.match(html, /INV-pack1/);
  assert.doesNotMatch(await page('/employer/analytics', p.olga), /id="plan-revenue"|INV-plan/);
});

test('the cache: a write shows at once, and answers are not shared between people', async () => {
  const collected = async (cookie) => (await api('/api/analytics/revenue', cookie)).data.plans.collectedPaise;
  const before = await collected(p.fin);
  assert.equal(await collected(p.fin), before);
  // A payment recorded through the desk must show on the very next read.
  const res = await srv.request('/admin/billing/invoices/plan2/payments', { method: 'POST', cookie: p.admin, headers: headers(), form: { amount: '500', date: ymd(0), mode: 'Bank transfer', reference: 'UTR-cache-test' } });
  assert.equal(res.status, 303);
  assert.doesNotMatch(decodeURIComponent(res.headers.get('location') || ''), /Not recorded/);
  assert.equal(await collected(p.fin), before + 50000);
  // Right after a team member's read, the employer still gets no team money,
  // and the recruiter is still refused.
  assert.equal((await api('/api/analytics/revenue', p.olga)).data.plans, undefined);
  assert.equal((await api('/api/analytics/revenue', p.rita)).status, 403);
});
