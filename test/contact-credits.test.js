// Step 85: verified employers unlock the mobile number of job seekers who
// agreed to show it, using the plan's free contacts each month and then
// contact credits bought as a pack. Unlocking again is free, the job seeker
// is told, and switching the choice off hides the number at once.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { startServer, decodeEmail } = require('./helpers');
const { hashPassword } = require('../employers');
const contactCredits = require('../contact-credits');

const DAY = 86400000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const KEY_ID = 'rzp_test_hireriv';
const KEY_SECRET = 'sk-test-contacts';
const hmac = (secret, text) => crypto.createHmac('sha256', secret).update(text).digest('hex');

test('the ledger: free unlocks first, then credits, once per candidate; refunds take back unused credits', () => {
  const rows = {};
  const db = {
    where: (c, k, v) => (rows[c] || []).filter((r) => r[k] === v),
    all: (c) => rows[c] || [],
    prepend: (c, d) => { (rows[c] = rows[c] || []).unshift(d); },
    transaction: (fn) => fn(),
  };
  let free = 1;
  const cc = contactCredits.create({ db, store: { limitsOf: () => ({ contactUnlocks: free }) } });
  const emp = { id: 'e1', company: 'E Co' };
  assert.equal(cc.unlock(emp, null, 'c1').source, 'plan');
  assert.equal(cc.unlock(emp, null, 'c1').existed, true);
  assert.equal(cc.unlock(emp, null, 'c2').status, 402);
  assert.ok(cc.grant('e1', 3, { reason: 'pack', transactionId: 't1' }));
  assert.equal(cc.grant('e1', 3, { reason: 'pack', transactionId: 't1' }), null, 'once per payment');
  assert.equal(cc.unlock(emp, null, 'c2').source, 'credit');
  assert.deepEqual(cc.status(emp), { month: contactCredits.monthIst(), free: 1, used: 1, freeLeft: 0, credits: 2 });
  assert.equal(cc.revoke('e1', 't1'), 2, 'the two credits not used');
  assert.equal(cc.balance('e1'), 0);
  free = 0;
  assert.match(cc.unlock(emp, null, 'c3').error, /no free unlocks/);
});

// ---------- a small Razorpay ----------
function mockRazorpay() {
  const orders = new Map();
  const payments = new Map();
  let n = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      const body = raw ? JSON.parse(raw) : {};
      let m;
      if (req.method === 'POST' && req.url === '/v1/orders') {
        const o = { id: `order_${++n}`, entity: 'order', amount: body.amount, currency: body.currency, receipt: body.receipt, status: 'created' };
        orders.set(o.id, o);
        return send(200, o);
      }
      if (req.method === 'GET' && (m = req.url.match(/^\/v1\/payments\/([^/]+)$/))) return payments.has(m[1]) ? send(200, payments.get(m[1])) : send(404, { error: { description: 'no such payment' } });
      if (req.method === 'GET' && (m = req.url.match(/^\/v1\/orders\/([^/]+)\/payments$/))) return send(200, { entity: 'collection', items: [...payments.values()].filter((p) => p.order_id === m[1]) });
      send(404, { error: { description: 'not found' } });
    });
  });
  return {
    server,
    pay(orderId) {
      const o = orders.get(orderId);
      const p = { id: `pay_${++n}`, entity: 'payment', order_id: orderId, amount: o.amount, currency: o.currency, status: 'captured', method: 'upi' };
      payments.set(p.id, p);
      return { orderId, paymentId: p.id, signature: hmac(KEY_SECRET, `${orderId}|${p.id}`) };
    },
  };
}

const plan = (p) => ({ id: p.code, currency: 'INR', gstPercent: 18, sac: '998365', features: [], summary: '', active: true, custom: false, createdAt: iso(DAY), ...p });
const owner = (id, company, email, extra = {}) => ({ id, company, name: email.split('@')[0], email, passwordHash: hashPassword('owner long password'), passwordSetAt: iso(DAY), active: true, createdAt: iso(30 * DAY), ...extra });

let rz;
let srv;
const people = {};
let ip = 0;
const headers = (extra = {}) => ({ 'x-forwarded-for': `10.7.${Math.floor(++ip / 250)}.${ip % 250}`, ...extra });
const get = (url, cookie) => srv.request(url, { cookie, headers: headers() });
const post = (url, form, cookie) => srv.request(url, { method: 'POST', form, cookie, headers: headers() });
const json = async (url, method, body, cookie) => {
  const r = await srv.request(url, { method, cookie, body: body === undefined ? undefined : JSON.stringify(body), headers: headers({ 'content-type': 'application/json', accept: 'application/json' }) });
  return { ...(await r.json().catch(() => ({}))), status: r.status };
};
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

async function register(name, email, phone) {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ name, email, phone, location: 'Pune', agree: '1' })) fd.append(k, v);
  await srv.request('/account/register', { method: 'POST', body: fd, headers: headers() });
  const has = (m) => m.includes(`To: ${email}`) && decodeEmail(m).includes('/account/verify/');
  await srv.waitForEmail(has);
  const link = decodeEmail(srv.emails().filter(has).pop()).match(/\/account\/verify\/[a-f0-9]{64}/)[0];
  const cookie = srv.cookieFrom(await post(link, {}));
  await json('/api/candidate/profile', 'PATCH', { headline: 'Warehouse helper', skills: ['Packing'] }, cookie);
  return cookie;
}

before(async () => {
  rz = mockRazorpay();
  await new Promise((r) => rz.server.listen(0, '127.0.0.1', r));
  srv = await startServer({
    TRUST_PROXY: '1', RAZORPAY_KEY_ID: KEY_ID, RAZORPAY_KEY_SECRET: KEY_SECRET, RAZORPAY_WEBHOOK_SECRET: 'whsec-contacts',
    RAZORPAY_API_BASE: `http://127.0.0.1:${rz.server.address().port}/v1`, PAYMENTS_PROVIDER: '', BILLING_DELAY_MS: '3600000',
  }, {
    employers: [
      owner('emp-s', 'Swift Logistics', 'sam@swift.in', { selfSignup: true, approvedAt: iso(DAY), emailVerifiedAt: iso(DAY), state: 'Maharashtra' }),
      owner('emp-u', 'Unchecked Co', 'uma@uco.in', { selfSignup: true, emailVerifiedAt: iso(DAY) }),
    ],
    // The free plan with one free contact a month, and an active pack of five credits.
    'subscription-plans': [
      plan({ code: 'starter', kind: 'subscription', name: 'Starter', pricePaise: 0, interval: 'month', jobLimit: 3, seatLimit: 3, contactUnlocks: 1, sort: 1 }),
      plan({ code: 'pack-5', kind: 'package', name: '5 contact credits', pricePaise: 10000, interval: null, jobLimit: null, seatLimit: null, credits: 5, sort: 20 }),
    ],
  });
  people.sam = srv.cookieFrom(await post('/employer/login', { email: 'sam@swift.in', password: 'owner long password' }));
  people.uma = srv.cookieFrom(await post('/employer/login', { email: 'uma@uco.in', password: 'owner long password' }));
  people.admin = await srv.adminLogin();
  people.asha = await register('Asha Kumar', 'asha@example.in', '9845012345');
  people.dev = await register('Dev Rao', 'dev@example.in', '9845098765');
}, { timeout: 30000 });
after(async () => {
  if (srv) await srv.stop();
  if (rz) await new Promise((r) => rz.server.close(r));
});

const findAll = async (q = '', cookie = people.sam) => json(`/api/employers/candidates${q}`, 'GET', undefined, cookie);
const idOf = async (name) => (await findAll()).candidates.find((c) => c.displayName === name).id;
const unlock = (id, cookie = people.sam) => json(`/api/employers/candidates/${id}/unlock`, 'POST', {}, cookie);

test('only people who chose to show their number can be unlocked, once, and they are told', async () => {
  await json('/api/candidate/profile', 'PATCH', { privacy: { discoverable: true } }, people.asha);
  await json('/api/candidate/profile', 'PATCH', { privacy: { discoverable: true, shareContact: true } }, people.dev);
  const list = await findAll();
  assert.deepEqual(list.contacts, { month: contactCredits.monthIst(), free: 1, used: 0, freeLeft: 1, credits: 0 });
  const asha = list.candidates.find((c) => c.displayName === 'Asha K.');
  assert.equal(asha.sharesContact, false);
  assert.ok(!JSON.stringify(list).includes('98450'), 'no numbers before unlocking');
  assert.equal((await unlock(asha.id)).status, 409);
  assert.equal((await findAll('?contact=shared')).total, 1);

  // Dev: the month's free contact.
  const devId = await idOf('Dev R.');
  assert.equal((await unlock(devId, people.uma)).status, 403, 'an unverified company');
  const r = await unlock(devId);
  assert.equal(r.status, 201);
  assert.equal(r.used, 'plan');
  assert.deepEqual([r.contact.name, r.contact.phone, r.contact.whatsapp], ['Dev Rao', '+91 98450 98765', 'https://wa.me/919845098765']);
  const again = await unlock(devId);
  assert.deepEqual([again.status, again.existed, again.contacts.used], [200, true, 1]);
  const card = (await findAll('?contact=unlocked')).candidates;
  assert.deepEqual(card.map((c) => [c.displayName, c.contact.tel]), [['Dev R.', '+919845098765']]);
  const page = await (await get('/employer/candidates', people.sam)).text();
  assert.match(page, /href="tel:\+919845098765"/);
  assert.match(page, /Contacts: <b>0<\/b> of 1 free this month left · <b>0<\/b> contact credits/);
  assert.match(page, /Get more contacts/);
  assert.doesNotMatch(page, /98450 12345/);

  // Recorded for the company, told to Dev, in Dev's data export, and his consent is on record.
  assert.ok(srv.records('employer-audit').some((e) => e.employerId === 'emp-s' && e.event === 'contact-unlocked' && e.detail.includes('free this month')));
  await settle();
  const notes = (await json('/api/notifications', 'GET', undefined, people.dev)).notifications.filter((n) => n.title === 'Swift Logistics can now see your mobile number');
  assert.equal(notes.length, 1);
  const mine = JSON.parse(await (await get('/account/my-data.json', people.dev)).text());
  assert.deepEqual(mine.employersWhoSawYourNumber.map((u) => u.company), ['Swift Logistics']);
  assert.ok(srv.records('consents').some((x) => x.purpose === 'employer-contact' && x.granted === true) || mine.consents.current['employer-contact'], 'consent recorded');
});

test('after the free contacts, a pack of credits bought online pays for more', async () => {
  await json('/api/candidate/profile', 'PATCH', { privacy: { discoverable: true, shareContact: true } }, people.asha);
  const ashaId = await idOf('Asha K.');
  const none = await unlock(ashaId);
  assert.equal(none.status, 402);
  assert.match(none.errors[0], /used this month's 1 free unlocks/);

  // The billing page offers the pack; buying it adds five credits once.
  const billing = await (await get('/employer/billing', people.sam)).text();
  assert.match(billing, /id="credits">Contact credits/);
  assert.match(billing, /Candidate contacts this month<\/dt><dd><b>1<\/b> of 1 free/);
  const order = await json('/api/billing/checkout', 'POST', { planId: 'pack-5' }, people.sam);
  assert.equal(order.status, 200, JSON.stringify(order));
  const paid = rz.pay(order.orderId);
  assert.equal((await json('/api/billing/checkout/verify', 'POST', paid, people.sam)).status, 200);
  assert.equal((await json('/api/billing/checkout/verify', 'POST', paid, people.sam)).status, 200);
  assert.equal(srv.records('contact-credit-ledger').filter((e) => e.employerId === 'emp-s' && e.delta > 0).length, 1);
  assert.ok(srv.records('billing-invoices').some((i) => i.employerId === 'emp-s' && i.kind === 'package'), 'an invoice with GST');

  const r = await unlock(ashaId);
  assert.deepEqual([r.status, r.used, r.contacts.credits], [201, 'credit', 4]);
  assert.equal(r.contact.phone, '+91 98450 12345');

  // Asha stops showing her number: hidden again at once, and can't be unlocked.
  await json('/api/candidate/profile', 'PATCH', { privacy: { shareContact: false } }, people.asha);
  const after = (await findAll()).candidates.find((c) => c.id === ashaId);
  assert.deepEqual([after.unlocked, after.contact], [false, null]);
  assert.equal((await unlock(ashaId)).status, 409);
  assert.equal((await findAll('?contact=unlocked')).total, 1);
  assert.equal((await findAll('?contact=everyone')).status, 400);

  // The form on the page works the same way.
  const devId = await idOf('Dev R.');
  const res = await post(`/employer/candidates/${devId}/unlock`, {}, people.sam);
  assert.equal(res.status, 302);
  assert.match(decodeURIComponent(res.headers.get('location')).replace(/\+/g, ' '), /free to see again/);
});

test('Admins set free contacts per plan and the credits in a pack', async () => {
  const res = await post('/admin/billing/plans', { kind: 'package', code: 'pack-50', name: '50 contact credits', price: '799', gstPercent: '18', sac: '998365', credits: '50', active: '1', sort: '21' }, people.admin);
  assert.equal(res.status, 303);
  assert.equal(srv.records('subscription-plans').find((p) => p.code === 'pack-50').credits, 50);
  const bad = await post('/admin/billing/plans/starter', { name: 'Starter', price: '0', interval: 'month', gstPercent: '18', contactUnlocks: '9999', active: '1', reason: 'test' }, people.admin);
  assert.equal(bad.status, 400);
  assert.equal((await post('/admin/billing/plans/starter', { name: 'Starter', price: '0', interval: 'month', gstPercent: '18', jobLimit: '3', seatLimit: '3', contactUnlocks: '10', active: '1', reason: 'more contacts' }, people.admin)).status, 303);
  assert.equal((await findAll()).contacts.free, 10);
  const plans = await json('/api/billing/plans', 'GET');
  assert.equal(plans.plans.find((p) => p.code === 'starter').contactUnlocks, 10);
  assert.equal(plans.plans.find((p) => p.code === 'pack-50').credits, 50);
});
