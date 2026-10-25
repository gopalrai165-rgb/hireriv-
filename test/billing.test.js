// Step 63: plans, subscriptions and payments. A mock of the Razorpay API
// stands in for the sandbox: orders, payments, refunds and signed webhooks.
// Covers configurable plans, limits enforced on the server, checkout that
// only counts after the signature and the provider both confirm it, failed
// payments, repeated callbacks and webhooks that change nothing twice,
// invoices with GST that add up, refunds approved by a second person with a
// credit note, cancellation, renewals with grace periods, paying placement
// invoices online, and no company seeing another's billing.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { startServer, decodeEmail } = require('./helpers');
const { hashPassword } = require('../employers');
const S = require('../subscriptions');

const DAY = 86400000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const ymd = (msAgo) => new Date(Date.now() - msAgo).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const KEY_ID = 'rzp_test_hireriv';
const KEY_SECRET = 'sk-test-never-shown';
const HOOK_SECRET = 'whsec-test-never-shown';
const hmac = (secret, text) => crypto.createHmac('sha256', secret).update(text).digest('hex');

// ---------- a small Razorpay ----------
function mockRazorpay() {
  const orders = new Map();
  const payments = new Map();
  const refunds = [];
  let n = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.headers.authorization !== 'Basic ' + Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64')) return send(401, { error: { description: 'bad key' } });
      const body = raw ? JSON.parse(raw) : {};
      let m;
      if (req.method === 'POST' && req.url === '/v1/orders') {
        const o = { id: `order_${++n}`, entity: 'order', amount: body.amount, currency: body.currency, receipt: body.receipt, status: 'created' };
        orders.set(o.id, o);
        return send(200, o);
      }
      if (req.method === 'GET' && (m = req.url.match(/^\/v1\/payments\/([^/]+)$/))) return payments.has(m[1]) ? send(200, payments.get(m[1])) : send(404, { error: { description: 'no such payment' } });
      if (req.method === 'GET' && (m = req.url.match(/^\/v1\/orders\/([^/]+)\/payments$/))) return send(200, { entity: 'collection', items: [...payments.values()].filter((p) => p.order_id === m[1]) });
      if (req.method === 'POST' && (m = req.url.match(/^\/v1\/payments\/([^/]+)\/refund$/))) {
        const r = { id: `rfnd_${++n}`, entity: 'refund', amount: body.amount, payment_id: m[1], status: 'processed' };
        refunds.push(r);
        return send(200, r);
      }
      send(404, { error: { description: 'not found' } });
    });
  });
  return {
    server, orders, payments, refunds,
    // A payment on an order, with the signature the checkout window would return.
    pay(orderId, { status = 'captured', amount } = {}) {
      const o = orders.get(orderId);
      const p = { id: `pay_${++n}`, entity: 'payment', order_id: orderId, amount: amount ?? o.amount, currency: o.currency, status, method: 'upi', email: 'buyer@example.in', contact: '+919800000000', error_description: status === 'failed' ? 'Payment declined by bank' : null };
      payments.set(p.id, p);
      return { paymentId: p.id, orderId, signature: hmac(KEY_SECRET, `${orderId}|${p.id}`), payment: p };
    },
  };
}

const company = (id, name, extra = {}) => ({ id, company: name, name, email: `owner@${id}.in`, active: true, createdAt: iso(30 * DAY), ...extra });
const person = (id, email, name) => ({ id, email, name, phone: '9800000001', passwordHash: hashPassword(`${name} long password`), emailVerifiedAt: iso(DAY), phoneVerifiedAt: iso(DAY), createdAt: iso(DAY), active: true, link: null });
const membership = (id, employerId, userId, role) => ({ id, employerId, userId, role, jobIds: [], createdAt: iso(DAY) });
const job = (id, employerId, status) => ({ id, title: `Job ${id}`, company: 'Self Co', employerId, location: 'Pune', mode: 'On-site', type: 'Full-time', category: 'Retail', experience: '', posted: ymd(DAY), skills: [], description: 'A good job with clear duties for the right person.', responsibilities: [], status, closesOn: null, sample: false, createdBy: 'employer', createdByUser: 'u-sam' });
const placementInvoice = {
  number: 'INV/2026-27/0900', date: ymd(5 * DAY), dueDate: ymd(-10 * DAY), gstPercent: 18, taxType: 'inter', subtotal: 50000, gst: 9000, taxLines: [{ label: 'IGST @ 18%', amount: 9000 }], total: 59000,
  seller: { name: 'Hireriv', address: 'Pune' }, buyer: { name: 'A Co' }, item: 'Recruitment fee', sac: '998512', status: 'Unpaid', payments: [], creditNotes: [],
};

let rz;
let srv;
const p = {};
let ip = 0;
const headers = (extra = {}) => ({ 'x-forwarded-for': `10.9.${Math.floor(++ip / 250)}.${ip % 250}`, ...extra });
const call = async (url, method, body, cookie) => {
  const r = await srv.request(url, { method, cookie, body: body === undefined ? undefined : JSON.stringify(body), headers: headers({ 'content-type': 'application/json', accept: 'application/json' }) });
  // `status` is the HTTP status; a payment's own status is under `transaction`.
  return { ...(await r.json().catch(() => ({}))), status: r.status };
};
const get = (url, cookie) => srv.request(url, { cookie, headers: headers() });
const post = (url, form, cookie) => srv.request(url, { method: 'POST', form, cookie, headers: headers() });
const rec = (collection, fn) => srv.records(collection).find(fn);
const webhook = (event, payload, { secret = HOOK_SECRET, id = crypto.randomUUID() } = {}) => {
  const raw = JSON.stringify({ entity: 'event', event, payload, created_at: Math.floor(Date.now() / 1000) });
  return srv.request('/api/webhooks/payments/razorpay', { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'x-razorpay-signature': hmac(secret, raw), 'x-razorpay-event-id': id } });
};
const planId = (code) => rec('subscription-plans', (x) => x.code === code).id;

async function member(name, email, role) {
  await post('/admin/team', { name, email, role }, p.admin);
  const link = decodeEmail(await srv.waitForEmail((e) => e.includes(`To: ${email}`))).match(/\/admin\/setup\/[a-f0-9]{64}/)[0];
  return srv.cookieFrom(await post(link, { password: `${name} long password`, confirm: `${name} long password` }));
}
const employer = async (email, name) => srv.cookieFrom(await post('/employer/login', { email, password: `${name} long password` }));

before(async () => {
  rz = mockRazorpay();
  await new Promise((r) => rz.server.listen(0, '127.0.0.1', r));
  srv = await startServer({
    TRUST_PROXY: '1', RAZORPAY_KEY_ID: KEY_ID, RAZORPAY_KEY_SECRET: KEY_SECRET, RAZORPAY_WEBHOOK_SECRET: HOOK_SECRET,
    RAZORPAY_API_BASE: `http://127.0.0.1:${rz.server.address().port}/v1`, PAYMENTS_PROVIDER: '', BILLING_DELAY_MS: '3600000',
  }, {
    employers: [
      company('emp-s', 'Self Co', { selfSignup: true, approvedAt: iso(DAY), emailVerifiedAt: iso(DAY), state: 'Maharashtra' }),
      company('emp-a', 'A Co'),
      company('emp-b', 'B Co', { selfSignup: true, approvedAt: iso(DAY) }),
    ],
    'employer-users': [person('u-sam', 'sam@self.in', 'Sam Shah'), person('u-vee', 'vee@self.in', 'Vee'), person('u-bill', 'bill@self.in', 'Billy'), person('u-olga', 'olga@aco.in', 'Olga Rao'), person('u-bob', 'bob@bco.in', 'Bob')],
    'employer-members': [
      membership('m1', 'emp-s', 'u-sam', 'owner'), membership('m2', 'emp-s', 'u-vee', 'viewer'), membership('m3', 'emp-s', 'u-bill', 'billing'),
      membership('m4', 'emp-a', 'u-olga', 'owner'), membership('m5', 'emp-b', 'u-bob', 'owner'),
    ],
    jobs: [job('js1', 'emp-s', 'open'), job('js2', 'emp-s', 'open'), job('js3', 'emp-s', 'pending'), job('js4', 'emp-s', 'draft')],
    placements: [{
      id: 'pl1', appId: 'a-x', employerId: 'emp-a', company: 'A Co', candidateName: 'Ravi Patil', jobTitle: 'Store Manager', type: 'Permanent', feeMode: 'flat', fee: 50000,
      joiningDate: ymd(20 * DAY), status: 'Joined', guaranteeDays: 90, ctc: 600000, invoice: placementInvoice, createdAt: iso(20 * DAY),
    }],
  });
  p.admin = await srv.adminLogin();
  p.fin = await member('Fiona', 'fiona@hireriv.test', 'Finance Manager');
  p.rec = await member('Rita', 'rita@hireriv.test', 'Recruiter');
  p.sam = await employer('sam@self.in', 'Sam Shah');
  p.vee = await employer('vee@self.in', 'Vee');
  p.bill = await employer('bill@self.in', 'Billy');
  p.olga = await employer('olga@aco.in', 'Olga Rao');
  p.bob = await employer('bob@bco.in', 'Bob');
});
after(async () => {
  await srv.stop();
  await new Promise((r) => rz.server.close(r));
});

test('money and dates: paise, GST split and month ends', () => {
  assert.equal(S.paiseIn('1,999'), 199900);
  assert.equal(S.paiseIn('₹1,999.5'), 199950);
  assert.ok(Number.isNaN(S.paiseIn('12.345')));
  assert.ok(Number.isNaN(S.paiseIn('-5')));
  assert.deepEqual(S.taxOf(199900, 18, 'inter'), { taxPaise: 35982, taxLines: [{ label: 'IGST @ 18%', amountPaise: 35982 }] });
  const intra = S.taxOf(199900, 18, 'intra');
  assert.equal(intra.taxLines[0].amountPaise + intra.taxLines[1].amountPaise, intra.taxPaise);
  assert.deepEqual(S.taxOf(100000, 0, 'inter'), { taxPaise: 0, taxLines: [] });
  assert.equal(S.addInterval('2027-01-31', 'month'), '2027-02-28');
  assert.equal(S.addInterval('2028-01-31', 'month'), '2028-02-29');
  assert.equal(S.addInterval('2026-12-15', 'month'), '2027-01-15');
  assert.equal(S.addInterval('2026-10-25', 'year'), '2027-10-25');
});

test('plans are configurable, public without secrets, and only Admins change them', async () => {
  const r = await call('/api/billing/plans', 'GET');
  assert.equal(r.status, 200);
  const by = Object.fromEntries(r.plans.map((x) => [x.code, x]));
  assert.equal(by.starter.price.amountPaise, 0);
  assert.equal(by.growth.price.amountPaise, 199900);
  assert.equal(by.business.price.amountPaise, 499900);
  assert.equal(by.enterprise.price, null);
  assert.ok(by.enterprise.custom);
  assert.ok(!by['assisted-hiring'], 'packages start switched off');
  assert.equal(by.growth.price.currency, 'INR');
  const text = JSON.stringify(r);
  assert.ok(!text.includes(KEY_SECRET) && !text.includes(HOOK_SECRET));

  // A Finance Manager can't change prices; an Admin can, and it is audited.
  const growth = planId('growth');
  const form = { name: 'Growth', price: '2,499', interval: 'month', jobLimit: '12', seatLimit: '5', features: '12 jobs live\n5 team members', gstPercent: '18', sac: '998365', active: '1', sort: '2', reason: 'new prices' };
  assert.equal((await post(`/admin/billing/plans/${growth}`, form, p.fin)).status, 403);
  assert.equal((await post(`/admin/billing/plans/${growth}`, form, p.rec)).status, 403);
  assert.equal((await post(`/admin/billing/plans/${growth}`, { ...form, gstPercent: '40' }, p.admin)).status, 400);
  assert.equal((await post(`/admin/billing/plans/${growth}`, form, p.admin)).status, 303);
  const saved = rec('subscription-plans', (x) => x.id === growth);
  assert.equal(saved.pricePaise, 249900);
  assert.equal(saved.jobLimit, 12);
  assert.equal(saved.version, 2);
  const audit = rec('trust-audit', (e) => e.action === 'billing-plan-changed' && e.entityId === growth);
  assert.match(audit.detail, /pricePaise: 199900 → 249900/);
  // Back to the brief's price for the rest of the tests.
  assert.equal((await post(`/admin/billing/plans/${growth}`, { ...form, price: '1999', jobLimit: '10' }, p.admin)).status, 303);
  // A new plan with a yearly price, configured without code.
  assert.equal((await post('/admin/billing/plans', { kind: 'subscription', code: 'growth-yearly', name: 'Growth yearly', price: '19990', interval: 'year', jobLimit: '10', seatLimit: '5', gstPercent: '18', sac: '998365', features: 'Two months free', active: '1' }, p.admin)).status, 303);
  assert.equal(rec('subscription-plans', (x) => x.code === 'growth-yearly').pricePaise, 1999000);
  assert.equal((await post('/admin/billing/plans', { kind: 'subscription', code: 'growth-yearly', name: 'Copy', price: '1', interval: 'year', gstPercent: '18' }, p.admin)).status, 400);
});

test('only owners and billing administrators see billing; others are refused', async () => {
  for (const c of [p.sam, p.bill]) assert.equal((await call('/api/billing/subscription', 'GET', undefined, c)).status, 200);
  assert.equal((await call('/api/billing/subscription', 'GET', undefined, p.vee)).status, 403);
  assert.equal((await call('/api/billing/checkout', 'POST', { planId: planId('growth') }, p.vee)).status, 403);
  assert.equal((await call('/api/billing/invoices', 'GET', undefined, p.vee)).status, 403);
  assert.equal((await call('/api/billing/subscription', 'GET')).status, 401);
  assert.equal((await get('/employer/billing', p.vee)).status, 403);
  // The billing administrator lands on Billing and sees no jobs or applicants.
  const home = await get('/employer', p.bill);
  assert.equal(home.headers.get('location'), '/employer/billing');
  const page = await (await get('/employer/billing', p.bill)).text();
  assert.match(page, /Starter/);
  assert.doesNotMatch(page, /href="\/employer\/jobs"/);
  assert.ok(!page.includes(KEY_SECRET) && !page.includes(HOOK_SECRET));
  assert.match(page, /checkout\.razorpay\.com/);
  // The refund API is for the team only.
  const asEmployer = await call('/api/admin/billing/refunds', 'POST', { transactionId: 'x', amount: '1', reason: 'Goodwill' }, p.sam);
  assert.notEqual(asEmployer.status, 200);
  assert.ok(!srv.records('refund-records').length);
});

test('plan limits are enforced on the server: jobs and team seats', async () => {
  // Starter allows 3 jobs live, paused or in review; Self Co has 3.
  const sub = await call('/api/billing/subscription', 'GET', undefined, p.sam);
  assert.equal(sub.subscription.plan.code, 'starter');
  assert.deepEqual([sub.subscription.limits.jobs, sub.subscription.usage.jobs], [3, 3]);
  const blocked = await call('/api/jobs/js4/publish', 'POST', {}, p.sam);
  assert.equal(blocked.status, 400);
  assert.match(blocked.errors.join(' '), /your plan allows 3 jobs/);
  // Starter has 3 seats and Self Co uses them all.
  const invite = await post('/employer/team', { name: 'New Person', email: 'new@self.in', role: 'recruiter' }, p.sam);
  assert.equal(invite.status, 400);
  assert.match(await invite.text(), /Your plan includes 3 team members/);
  // A company the team set up has no plan limits beyond the platform's.
  const managed = await call('/api/billing/subscription', 'GET', undefined, p.olga);
  assert.equal(managed.subscription.managed, true);
  assert.equal(managed.subscription.limits.jobs, 50);
});

test('checkout: an order from the server, unverified or failed payments change nothing, one invoice when paid', async () => {
  const growth = planId('growth');
  const order = await call('/api/billing/checkout', 'POST', { planId: growth }, p.sam);
  assert.equal(order.status, 200);
  assert.equal(order.key, KEY_ID);
  // ₹1,999 + 18% IGST (we have no state on record, so it is an inter-state supply).
  assert.equal(order.amountPaise, 199900 + 35982);
  assert.equal(order.quote.subtotalPaise + order.quote.taxLines.reduce((n, t) => n + t.amountPaise, 0), order.amountPaise);
  assert.ok(!JSON.stringify(order).includes(KEY_SECRET));
  // A second click reuses the order: no second charge can be started.
  const again = await call('/api/billing/checkout', 'POST', { planId: growth }, p.sam);
  assert.equal(again.orderId, order.orderId);
  assert.equal(srv.records('payment-transactions').length, 1);

  // A forged "success" from the browser is refused.
  const forged = rz.pay(order.orderId);
  const bad = await call('/api/billing/checkout/verify', 'POST', { orderId: order.orderId, paymentId: forged.paymentId, signature: 'deadbeef' }, p.sam);
  assert.equal(bad.status, 400);
  // A valid signature for a payment that failed at the bank doesn't activate anything.
  rz.payments.delete(forged.paymentId);
  const failed = rz.pay(order.orderId, { status: 'failed' });
  const f = await call('/api/billing/checkout/verify', 'POST', failed, p.sam);
  assert.equal(f.status, 200);
  assert.equal(f.ok, false);
  assert.equal(f.transaction.status, 'failed');
  assert.equal((await call('/api/billing/subscription', 'GET', undefined, p.sam)).subscription.plan.code, 'starter');
  assert.equal(srv.records('billing-invoices').length, 0);
  // Someone else's company can't confirm this order.
  const ok = rz.pay(order.orderId);
  assert.equal((await call('/api/billing/checkout/verify', 'POST', ok, p.bob)).status, 404);

  // The real payment: signature checked and the provider asked.
  const paid = await call('/api/billing/checkout/verify', 'POST', ok, p.sam);
  assert.equal(paid.status, 200);
  assert.equal(paid.transaction.status, 'paid');
  const now = await call('/api/billing/subscription', 'GET', undefined, p.sam);
  assert.equal(now.subscription.plan.code, 'growth');
  assert.equal(now.subscription.limits.jobs, 10);
  assert.ok(now.subscription.renewsOn > ymd(0));
  const invs = srv.records('billing-invoices');
  assert.equal(invs.length, 1);
  const inv = invs[0];
  assert.match(inv.number, /^INV\/\d{4}-\d{2}\/\d{4}$/);
  assert.equal(inv.subtotalPaise + inv.taxPaise, inv.totalPaise);
  assert.equal(inv.totalPaise, order.amountPaise);
  assert.equal(inv.status, 'Paid');
  assert.equal(inv.buyer.name, 'Self Co');
  // The buyer's email and phone from the provider are not kept.
  assert.ok(!JSON.stringify(srv.records('payment-transactions')).includes('buyer@example.in'));

  // Repeated callbacks and webhooks: nothing twice.
  const twice = await call('/api/billing/checkout/verify', 'POST', ok, p.sam);
  assert.equal(twice.already, true);
  const hook = await webhook('payment.captured', { payment: { entity: ok.payment } }, { id: 'evt_dup_1' });
  assert.equal(hook.status, 200);
  assert.equal((await webhook('payment.captured', { payment: { entity: ok.payment } }, { id: 'evt_dup_1' })).status, 200);
  assert.equal(srv.records('payment-webhook-events').filter((e) => e.eventId === 'evt_dup_1').length, 1);
  assert.equal(srv.records('billing-invoices').length, 1);
  assert.equal(srv.records('payment-transactions').filter((t) => t.status === 'paid').length, 1);
  // The job that was blocked can now go for review.
  assert.equal((await call('/api/jobs/js4/publish', 'POST', {}, p.sam)).status, 200);

  // Invoices: the company's own, never another's.
  const list = await call('/api/billing/invoices', 'GET', undefined, p.sam);
  assert.equal(list.invoices[0].number, inv.number);
  assert.equal((await call(`/api/billing/invoices/${inv.id}`, 'GET', undefined, p.sam)).invoice.totalPaise, inv.totalPaise);
  assert.equal((await call(`/api/billing/invoices/${inv.id}`, 'GET', undefined, p.bob)).status, 404);
  assert.equal((await get(`/employer/billing/invoices/${inv.id}`, p.bob)).status, 404);
  const printable = await (await get(`/employer/billing/invoices/${inv.id}`, p.sam)).text();
  assert.match(printable, new RegExp(inv.number.replace(/\//g, '\\/')));
  assert.match(printable, /IGST @ 18%/);
  const t = rec('payment-transactions', (x) => x.status === 'paid');
  assert.equal((await get(`/employer/billing/receipts/${t.id}`, p.sam)).status, 200);
  assert.equal((await get(`/employer/billing/receipts/${t.id}`, p.bob)).status, 404);
  // The owner and the billing administrator were told.
  await srv.waitForEmail((e) => e.includes('To: bill@self.in') && e.includes('Payment received'));
});

test('webhooks: wrong signatures are refused; a signed one settles a payment the browser never confirmed', async () => {
  // The team issues an invoice to a managed client.
  assert.equal((await post('/admin/billing/company-invoices', { company: 'emp-a', description: 'Enterprise plan, October', amount: '10,000', gstPercent: '18', sac: '998365', dueDays: '15' }, p.fin)).status, 303);
  const inv = rec('billing-invoices', (i) => i.employerId === 'emp-a');
  assert.equal(inv.totalPaise, 1180000);
  assert.equal(inv.status, 'Unpaid');
  const order = await call('/api/billing/checkout', 'POST', { invoiceId: inv.id }, p.olga);
  assert.equal(order.amountPaise, 1180000);
  assert.equal((await call('/api/billing/checkout', 'POST', { invoiceId: inv.id }, p.bob)).status, 404);
  const pay = rz.pay(order.orderId);
  // Unsigned or wrongly signed: refused, nothing recorded.
  assert.equal((await webhook('payment.captured', { payment: { entity: pay.payment } }, { secret: 'wrong' })).status, 400);
  const unsigned = await srv.request('/api/webhooks/payments/razorpay', { method: 'POST', body: JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: pay.payment } } }), headers: { 'content-type': 'application/json' } });
  assert.equal(unsigned.status, 400);
  assert.equal(rec('billing-invoices', (i) => i.id === inv.id).status, 'Unpaid');
  // A payment that doesn't match the order is held for checking, not counted.
  const odd = rz.pay(order.orderId, { amount: 100 });
  assert.equal((await webhook('payment.captured', { payment: { entity: odd.payment } })).status, 200);
  assert.equal(rec('payment-transactions', (t) => t.orderId === order.orderId).status, 'review');
  assert.equal(rec('billing-invoices', (i) => i.id === inv.id).status, 'Unpaid');
  // Settled by finance later through the desk; meanwhile reconciliation shows it.
  const desk = await (await get('/admin/billing', p.fin)).text();
  assert.match(desk, /Payment did not match its order/);
  // A fresh order for the right amount, confirmed only by the signed webhook.
  const second = await call('/api/billing/checkout', 'POST', { invoiceId: inv.id }, p.olga);
  assert.notEqual(second.orderId, order.orderId);
  const good = rz.pay(second.orderId);
  assert.equal((await webhook('payment.captured', { payment: { entity: good.payment } }, { id: 'evt_inv_1' })).status, 200);
  const after = rec('billing-invoices', (i) => i.id === inv.id);
  assert.equal(after.status, 'Paid');
  assert.equal(after.payments.length, 1);
  assert.equal(after.payments[0].reference, good.paymentId);
  // The same event again, and an order.paid for the same payment: still one payment.
  await webhook('payment.captured', { payment: { entity: good.payment } }, { id: 'evt_inv_1' });
  await webhook('order.paid', { payment: { entity: good.payment }, order: { entity: { id: second.orderId } } }, { id: 'evt_inv_2' });
  assert.equal(rec('billing-invoices', (i) => i.id === inv.id).payments.length, 1);
});

test('refunds: the team only, asked by one person and approved by another, with a credit note', async () => {
  const t = rec('payment-transactions', (x) => x.employerId === 'emp-s' && x.status === 'paid');
  // Needs the password again first.
  const unconfirmed = await call('/api/admin/billing/refunds', 'POST', { transactionId: t.id, amount: '1000', reason: 'Goodwill' }, p.fin);
  assert.equal(unconfirmed.status, 403);
  assert.ok(unconfirmed.confirm);
  // A recruiter has no refund rights at all.
  assert.equal((await call('/api/admin/billing/refunds', 'POST', { transactionId: t.id, amount: '1000', reason: 'Goodwill' }, p.rec)).status, 403);
  await srv.confirm(p.fin, 'Fiona long password');
  assert.equal((await call('/api/admin/billing/refunds', 'POST', { transactionId: t.id, amount: '999999', reason: 'Goodwill' }, p.fin)).status, 400);
  const asked = await call('/api/admin/billing/refunds', 'POST', { transactionId: t.id, amount: '1,180', reason: 'Charged in error', note: 'Two seats unused' }, p.fin);
  assert.equal(asked.status, 201);
  assert.equal(asked.refund.status, 'requested');
  // The same person can't approve it.
  const self = await call(`/api/admin/billing/refunds/${asked.refund.id}/approve`, 'POST', {}, p.fin);
  assert.equal(self.status, 403);
  assert.equal(rz.refunds.length, 0);
  await srv.confirm(p.admin);
  const ok = await call(`/api/admin/billing/refunds/${asked.refund.id}/approve`, 'POST', {}, p.admin);
  assert.equal(ok.status, 200);
  assert.equal(ok.refund.status, 'processed');
  assert.match(ok.refund.creditNote, /^CN\/\d{4}-\d{2}\/\d{4}$/);
  assert.equal(rz.refunds.length, 1);
  assert.equal(rz.refunds[0].amount, 118000);
  // Approving twice sends nothing more.
  assert.equal((await call(`/api/admin/billing/refunds/${asked.refund.id}/approve`, 'POST', {}, p.admin)).status, 409);
  assert.equal(rz.refunds.length, 1);
  const txn = rec('payment-transactions', (x) => x.id === t.id);
  assert.equal(txn.status, 'partially_refunded');
  assert.equal(txn.refundedPaise, 118000);
  const inv = rec('billing-invoices', (i) => i.transactionId === t.id);
  const cn = inv.creditNotes[0];
  assert.equal(cn.totalPaise, 118000);
  assert.equal(cn.subtotalPaise + cn.taxPaise, cn.totalPaise);
  assert.equal(cn.taxLines.reduce((n, l) => n + l.amountPaise, 0), cn.taxPaise);
  // The provider's webhook for it changes nothing more.
  assert.equal((await webhook('refund.processed', { refund: { entity: { ...rz.refunds[0] } }, payment: { entity: rz.payments.get(txn.paymentId) } })).status, 200);
  assert.equal(srv.records('refund-records').length, 1);
  // Audited in the hash-chained history, and the company sees the credit note.
  for (const action of ['billing-refund-requested', 'billing-refund-approved']) assert.ok(rec('trust-audit', (e) => e.action === action && e.entityId === t.id), action);
  assert.equal((await get(`/employer/billing/invoices/${inv.id}/credit-notes/${cn.id}`, p.sam)).status, 200);
  assert.equal((await get(`/employer/billing/invoices/${inv.id}/credit-notes/${cn.id}`, p.bob)).status, 404);
  // Totals still reconcile.
  const desk = await (await get('/admin/billing', p.admin)).text();
  assert.doesNotMatch(desk, /Refunds differ|Paid without an invoice|Invoice total differs/);
});

test('cancelling keeps the paid period, can be undone, and is audited', async () => {
  const c = await call('/api/billing/subscription/cancel', 'POST', { reason: 'Hiring paused' }, p.bill);
  assert.equal(c.status, 200);
  assert.equal(c.subscription.cancelAtPeriodEnd, true);
  assert.equal(c.subscription.plan.code, 'growth');
  assert.ok(rec('employer-audit', (e) => e.employerId === 'emp-s' && e.event === 'plan-cancelled'));
  assert.equal((await call('/api/billing/subscription/cancel', 'POST', {}, p.vee)).status, 403);
  const r = await call('/api/billing/subscription/resume', 'POST', {}, p.sam);
  assert.equal(r.subscription.cancelAtPeriodEnd, false);
  // Moving down is scheduled for the end of the period, not charged or refunded.
  const down = await call('/api/billing/subscription/change', 'POST', { planId: planId('starter') }, p.sam);
  assert.equal(down.status, 200);
  assert.equal(down.subscription.nextPlan.name, 'Starter');
  assert.equal(down.subscription.plan.code, 'growth');
  // Moving up needs a payment.
  assert.equal((await call('/api/billing/subscription/change', 'POST', { planId: planId('business') }, p.sam)).status, 409);
  // Enterprise is a quote, never an online checkout.
  assert.equal((await call('/api/billing/checkout', 'POST', { planId: planId('enterprise') }, p.sam)).status, 409);
});

test('staffing and placement invoices still work and can be paid online', async () => {
  assert.equal((await get('/employer/invoices/pl1', p.olga)).status, 200);
  assert.equal((await get('/employer/invoices/pl1', p.bob)).status, 404);
  const list = await call('/api/billing/invoices', 'GET', undefined, p.olga);
  assert.equal(list.staffing[0].number, 'INV/2026-27/0900');
  assert.equal(list.staffing[0].balancePaise, 5900000);
  assert.equal((await call('/api/billing/checkout', 'POST', { placementId: 'pl1', invoice: 'main' }, p.bob)).status, 404);
  const order = await call('/api/billing/checkout', 'POST', { placementId: 'pl1', invoice: 'main' }, p.olga);
  assert.equal(order.amountPaise, 5900000);
  const pay = rz.pay(order.orderId);
  assert.equal((await call('/api/billing/checkout/verify', 'POST', pay, p.olga)).transaction.status, 'paid');
  await webhook('payment.captured', { payment: { entity: pay.payment } });
  const pl = rec('placements', (x) => x.id === 'pl1');
  assert.equal(pl.invoice.status, 'Paid');
  assert.equal(pl.invoice.payments.length, 1);
  assert.equal(pl.invoice.payments[0].reference, pay.paymentId);
  // No new tax invoice for paying an existing one.
  assert.ok(!rec('billing-invoices', (i) => i.transactionId === rec('payment-transactions', (t) => t.orderId === order.orderId).id));
  assert.equal((await get('/admin/placements/pl1/invoice', p.fin)).status, 200);
});

test('the billing desk and billing pages render for the people allowed to see them', async () => {
  for (const view of ['overview', 'plans', 'subscriptions', 'payments', 'invoices', 'refunds', 'events', 'settings']) {
    const r = await get(`/admin/billing?view=${view}`, p.fin);
    assert.equal(r.status, 200, view);
    const html = await r.text();
    assert.ok(!html.includes(KEY_SECRET) && !html.includes(HOOK_SECRET), view);
  }
  assert.equal((await get('/admin/billing', p.rec)).status, 403);
  assert.equal((await get(`/admin/billing/plans/${planId('growth')}`, p.admin)).status, 200);
  assert.equal((await get('/admin/billing/plans/new?kind=package', p.admin)).status, 200);
  const csv = await (await get('/admin/billing/payments.csv', p.fin)).text();
  assert.match(csv, /Self Co/);
  assert.ok(!csv.includes('buyer@example.in'));
  // A managed client sees its invoices and what is due, without plan prices pushed at it.
  const managed = await (await get('/employer/billing', p.olga)).text();
  assert.match(managed, /looked after by the/);
  assert.match(managed, /INV\/2026-27\/0900|Nothing is due/);
  // The team sets an agreed Enterprise plan with its own limits.
  assert.equal((await post('/admin/billing/company-plan', { company: 'emp-a', planId: planId('enterprise'), jobLimit: '40', seatLimit: '20', reason: 'Signed quote Q-12' }, p.fin)).status, 303);
  const s = await call('/api/billing/subscription', 'GET', undefined, p.olga);
  assert.equal(s.subscription.plan.code, 'enterprise');
  assert.deepEqual([s.subscription.limits.jobs, s.subscription.limits.seats], [40, 20]);
  assert.ok(rec('trust-audit', (e) => e.action === 'billing-plan-assigned' && e.entityId === 'emp-a'));
  assert.equal((await post('/admin/billing/company-plan', { company: 'emp-a', planId: planId('growth') }, p.fin)).status, 303);
  assert.equal((await call('/api/billing/subscription', 'GET', undefined, p.olga)).subscription.plan.code, 'enterprise');
});

test('renewals: reminders, grace period, plans ending, and orders the browser never confirmed', async () => {
  const today = ymd(0);
  const s2 = await startServer({
    RAZORPAY_KEY_ID: KEY_ID, RAZORPAY_KEY_SECRET: KEY_SECRET, RAZORPAY_WEBHOOK_SECRET: HOOK_SECRET, RAZORPAY_API_BASE: `http://127.0.0.1:${rz.server.address().port}/v1`,
    PAYMENTS_PROVIDER: '', BILLING_DELAY_MS: '1500',
  }, {
    employers: ['r1', 'r2', 'r3', 'r4', 'r5'].map((id) => company(id, `Co ${id}`, { selfSignup: true, approvedAt: iso(DAY) })),
    'employer-users': [person('u-r1', 'r1@co.in', 'Rone')],
    'employer-members': [membership('mr1', 'r1', 'u-r1', 'owner')],
    'subscription-plans': [
      { id: 'pl-starter', code: 'starter', kind: 'subscription', name: 'Starter', pricePaise: 0, currency: 'INR', interval: 'month', jobLimit: 3, seatLimit: 3, features: [], active: true, sort: 1, gstPercent: 18, sac: '' },
      { id: 'pl-growth', code: 'growth', kind: 'subscription', name: 'Growth', pricePaise: 199900, currency: 'INR', interval: 'month', jobLimit: 10, seatLimit: 5, features: [], active: true, sort: 2, gstPercent: 18, sac: '998365' },
    ],
    'employer-subscriptions': [
      { id: 's1', employerId: 'r1', planId: 'pl-growth', plan: { name: 'Growth', pricePaise: 199900, interval: 'month' }, status: 'active', periodStart: ymd(30 * DAY), periodEnd: today, reminders: [], history: [] },
      { id: 's2', employerId: 'r2', planId: 'pl-growth', plan: { name: 'Growth', pricePaise: 199900, interval: 'month' }, status: 'past_due', periodStart: ymd(37 * DAY), periodEnd: ymd(7 * DAY), graceEnds: today, reminders: [], history: [] },
      { id: 's3', employerId: 'r3', planId: 'pl-growth', plan: { name: 'Growth', pricePaise: 199900, interval: 'month' }, status: 'active', periodStart: ymd(30 * DAY), periodEnd: today, cancelAtPeriodEnd: true, reminders: [], history: [] },
      { id: 's4', employerId: 'r4', planId: 'pl-growth', plan: { name: 'Growth', pricePaise: 199900, interval: 'month' }, status: 'active', periodStart: ymd(27 * DAY), periodEnd: ymd(-3 * DAY), reminders: [], history: [] },
    ],
  });
  try {
    // An order paid at the bank whose confirmation never came back.
    const lost = await (async () => {
      const r = await s2.request('/employer/login', { method: 'POST', form: { email: 'r1@co.in', password: 'Rone long password' } });
      const cookie = s2.cookieFrom(r);
      const res = await s2.request('/api/billing/checkout', { method: 'POST', cookie, body: JSON.stringify({ purpose: 'renewal' }), headers: { 'content-type': 'application/json', accept: 'application/json' } });
      return res.json();
    })();
    assert.equal(lost.ok, true);
    assert.equal(lost.amountPaise, 199900 + 35982);
    rz.pay(lost.orderId);
    // Wait for the scheduled run (started 1.5 s after boot).
    const sub = (id) => s2.records('employer-subscriptions').find((x) => x.employerId === id);
    for (const end = Date.now() + 15000; Date.now() < end && !(sub('r2').planId === 'pl-starter' && sub('r3').planId === 'pl-starter'); ) await new Promise((r) => setTimeout(r, 100));
    // Grace period over: back to the free plan.
    assert.equal(sub('r2').planId, 'pl-starter');
    assert.equal(sub('r2').history[0].event, 'expired-unpaid');
    // Cancelled at the end of the period: back to the free plan.
    assert.equal(sub('r3').planId, 'pl-starter');
    // Three days left: a reminder, once.
    assert.ok(sub('r4').reminders.some((k) => k.startsWith('before:')));
    // r1's renewal was paid at the bank but the order was only just created, so the
    // check waits 10 minutes; it went past due (with a reminder) meanwhile.
    assert.equal(sub('r1').status, 'past_due');
    assert.ok(sub('r1').reminders.some((k) => k.startsWith('due:')));
  } finally {
    await s2.stop();
  }
});
