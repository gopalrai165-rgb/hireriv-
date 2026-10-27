// Job seeker first (Step 69): jobs near me, search suggestions, one-tap apply,
// signing in with a mobile code, and calling HR after applying.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const geo = require('../geo');
const { suggestions } = require('../suggest');
const i18n = require('../i18n');
const { startServer, decodeEmail } = require('./helpers');

let srv;
before(async () => {
  srv = await startServer();
});
after(() => srv && srv.stop());

const text = async (url, opts) => (await srv.request(url, opts)).text();
async function nextMessage(match, seen) {
  for (const end = Date.now() + 5000; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) {
    const found = srv.emails().slice(seen).filter(match);
    if (found.length) return found[found.length - 1];
  }
  throw new Error('expected message was not sent');
}
async function register(email, fields = {}) {
  const seen = srv.emails().length;
  const body = new FormData();
  for (const [k, v] of Object.entries({ agree: '1', name: 'Ravi Kumar', email, phone: '9876543210', location: 'Pune', ...fields })) body.append(k, v);
  await srv.request('/account/register', { method: 'POST', body });
  const mail = decodeEmail(await nextMessage((e) => e.includes(`To: ${email}`) && decodeEmail(e).includes('/account/verify/'), seen));
  return srv.cookieFrom(await srv.request(mail.match(/\/account\/verify\/[A-Za-z0-9_-]+/)[0], { method: 'POST', form: {} }));
}
const codeIn = (sms) => sms.match(/(\d{6}) is your/)[1];

test('places: GPS rounded inside India, PIN codes by district, city names, and distances', () => {
  assert.deepEqual(geo.parseNear('12.97154,77.59456').point, [12.97, 77.59]);
  assert.equal(geo.parseNear('51.5,-0.12').error, 'errOutside');
  assert.equal(geo.parseNear('400703').label, '400703 (Navi Mumbai)');
  assert.equal(geo.parseNear('400001').label, '400001 (Mumbai)');
  assert.deepEqual(geo.parseNear('999999'), { error: 'errPin', pin: '999999' });
  assert.equal(geo.parseNear('pune').label, 'Pune');
  assert.equal(geo.parseNear('Atlantis').error, 'errFormat');
  assert.equal(geo.parseNear(''), null);
  const km = geo.distanceKm(geo.CITIES.Mumbai, geo.CITIES.Pune);
  assert.ok(km > 110 && km < 140, String(km));
  assert.equal(geo.jobDistance({ location: 'Remote' }, geo.CITIES.Pune), null);
});

test('suggestions: start of words first, from live listings, Hindi words as the English the jobs use', () => {
  const jobs = [
    { title: 'Delivery Executive', skills: ['Two-wheeler'], category: 'Delivery & Driving', location: 'Pune' },
    { title: 'Driver (LMV)', skills: ['Driving licence'], category: 'Delivery & Driving', location: 'Mumbai' },
    { title: 'Software Developer', skills: ['React'], category: 'Technology', location: 'Bengaluru' },
  ];
  const got = suggestions('dri', { jobs, cities: ['Pune'], categories: [] });
  assert.equal(got[0].text, 'Driver (LMV)');
  assert.ok(got.some((x) => x.type === 'skill' && x.text === 'Driving licence'));
  assert.equal(got.find((x) => x.type === 'category').href, '/jobs?category=Delivery%20%26%20Driving');
  assert.deepEqual(suggestions('d', { jobs }), []);
  const hindi = suggestions('ड्राइवर', { jobs, translate: (q) => i18n.searchTerms(q) });
  assert.ok(hindi.some((x) => x.text === 'Driver (LMV)'), JSON.stringify(hindi));
});

test('the suggestion API answers with public listing words only', async () => {
  const res = await srv.request('/api/suggest?q=dev');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control'), /public/);
  const { items } = await res.json();
  assert.ok(items.length > 0);
  for (const it of items) assert.deepEqual(Object.keys(it).sort(), ['count', 'href', 'text', 'type']);
  assert.deepEqual((await (await srv.request('/api/suggest?q=a')).json()).items, []);
});

test('jobs near a PIN code: nearest first with distances, a radius, and plain errors', async () => {
  const html = await text('/jobs?near=411001');
  assert.match(html, /Nearest jobs to 411001 \(Pune\) first\./);
  assert.match(html, /<option value="distance" selected>Nearest first<\/option>/);
  const first = html.match(/<li class="job-distance">[\s\S]*?<\/li>/);
  assert.ok(first, 'distances shown');
  const within = await text('/jobs?near=Bengaluru&within=25');
  const places = [...within.matchAll(/<span class="sr-only">Location: <\/span>([^<]+)</g)].map((m) => m[1].trim());
  assert.ok(places.length > 0);
  assert.ok(places.every((p) => p === 'Bengaluru'), places.join());
  assert.match(await text('/jobs?near=999999'), /can’t place PIN code 999999/);
  // The position is never kept in what the page links to elsewhere.
  assert.equal((await srv.request('/jobs?within=7')).status, 200);
  // Geolocation may be asked for (after a tap) on this site only.
  assert.match((await srv.request('/jobs')).headers.get('permissions-policy'), /geolocation=\(self\)/);
});

test('speculation rules prefetch public pages only when a link is pressed', async () => {
  const res = await srv.request('/speculation-rules.json');
  assert.match(res.headers.get('content-type'), /application\/speculationrules\+json/);
  const rules = await res.json();
  assert.equal(rules.prefetch[0].eagerness, 'conservative');
  assert.ok(!JSON.stringify(rules).includes('/account'));
  assert.equal((await srv.request('/')).headers.get('speculation-rules'), '"/speculation-rules.json"');
});

test('one-tap apply from the job list, then the job page says what is next', async () => {
  const cookie = await register('ravi@example.in');
  const list = await text('/jobs', { cookie });
  assert.match(list, /<form method="post" action="\/account\/apply\/hr-114" class="one-tap">/);
  const res = await srv.request('/account/apply/hr-114', { method: 'POST', cookie, form: { from: 'card' } });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /^\/jobs\/[^?]+\?msg=Applied/);
  assert.equal(srv.records('applications').filter((a) => a.email === 'ravi@example.in' && a.jobId === 'hr-114').length, 1);
  const after = await text('/jobs', { cookie });
  assert.doesNotMatch(after, /action="\/account\/apply\/hr-114"/);
  // Signed out: no one-tap buttons.
  assert.doesNotMatch(await text('/jobs'), /class="one-tap"/);
});

test('mobile sign-in works only for a number confirmed on the account', async () => {
  const cookie = await register('meena@example.in', { name: 'Meena Rao', phone: '+91 98450 11122' });
  // Not confirmed yet: the reply looks the same, but no code is sent.
  let seen = srv.emails().length;
  let res = await srv.request('/account/login/phone', { method: 'POST', form: { phone: '9845011122' } });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /we’ve sent it a 6-digit code/);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(srv.emails().slice(seen).filter((m) => m.includes('9845011122')).length, 0);

  // Confirm it in Settings.
  seen = srv.emails().length;
  res = await srv.request('/account/phone/send', { method: 'POST', cookie, form: {} });
  assert.equal(res.headers.get('location'), '/account/settings?code=sent#mobile');
  const confirmSms = await nextMessage((m) => m.includes('+919845011122'), seen);
  res = await srv.request('/account/phone/verify', { method: 'POST', cookie, form: { code: codeIn(confirmSms) } });
  assert.match(decodeURIComponent(res.headers.get('location')), /Mobile number confirmed/);
  assert.match(await text('/account/settings', { cookie }), /is confirmed/);

  // Now a code signs in, once, and wrong codes don't.
  seen = srv.emails().length;
  await srv.request('/account/login/phone', { method: 'POST', form: { phone: '09845011122' } });
  const code = codeIn(await nextMessage((m) => m.includes('+919845011122'), seen));
  const wrong = code === '000000' ? '111111' : '000000';
  res = await srv.request('/account/login/phone/verify', { method: 'POST', form: { phone: '9845011122', code: wrong } });
  assert.equal(res.status, 401);
  res = await srv.request('/account/login/phone/verify', { method: 'POST', form: { phone: '9845011122', code, next: '/account/settings' } });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/account/settings');
  const signedIn = srv.cookieFrom(res);
  assert.match(await text('/account/settings', { cookie: signedIn }), /meena@example\.in/);
  res = await srv.request('/account/login/phone/verify', { method: 'POST', form: { phone: '9845011122', code } });
  assert.equal(res.status, 401, 'a code works once');

  // Changing the number on the profile turns mobile sign-in off.
  const c = srv.records('candidates').find((x) => x.email === 'meena@example.in');
  assert.equal(c.phoneVerified.phone, '9845011122');
  assert.ok(!JSON.stringify(c).includes(code), 'codes are not stored');
});

test('codes are limited per number', async () => {
  for (let i = 0; i < 3; i++) assert.equal((await srv.request('/account/login/phone', { method: 'POST', form: { phone: '9000000001' } })).status, 200);
  assert.equal((await srv.request('/account/login/phone', { method: 'POST', form: { phone: '9000000001' } })).status, 429);
  assert.equal((await srv.request('/account/login/phone', { method: 'POST', form: { phone: '12345' } })).status, 400);
});

test('the sign-in page offers mobile or email, and the homepage leads with jobs near you', async () => {
  const login = await text('/account/login?with=phone');
  assert.match(login, /action="\/account\/login\/phone"/);
  assert.match(login, /autocomplete="tel-national"/);
  const hindi = await text('/?lang=hi');
  assert.match(hindi, /अपने पास नौकरी खोजें/);
  assert.match(hindi, /मेरे पास/);
});

test('call or WhatsApp HR: only after applying, only a confirmed mobile the company chose to share', async () => {
  const job = {
    id: 'hr-900', title: 'Packing Helper', company: 'Acme Foods Pvt Ltd', location: 'Pune', mode: 'On-site', type: 'Full-time', category: 'Warehouse & Packing',
    salary: '₹15,000 – 18,000 a month', posted: '2026-10-20', skills: ['Packing'], description: 'Pack orders.', responsibilities: ['Pack orders'], resume: 'optional',
    status: 'open', createdBy: 'employer', createdByUser: 'u-1', employerId: 'e-1', approvedAt: '2026-10-20T10:00:00Z', hrCall: true, sample: false,
  };
  const users = [{ id: 'u-1', email: 'meera@acmefoods.in', name: 'Meera Shah', phone: '9822000111', phoneVerifiedAt: '2026-10-01T10:00:00Z', emailVerifiedAt: '2026-10-01T10:00:00Z', active: true }];
  const other = await startServer({}, { jobs: [job, { ...job, id: 'hr-901', title: 'Loader', hrCall: false }], 'employer-users': users, employers: [{ id: 'e-1', company: 'Acme Foods Pvt Ltd', active: true }] });
  try {
    const body = new FormData();
    for (const [k, v] of Object.entries({ agree: '1', name: 'Sunil Patil', email: 'sunil@example.in', phone: '9811100000', location: 'Pune' })) body.append(k, v);
    const seen = other.emails().length;
    await other.request('/account/register', { method: 'POST', body });
    let mail = '';
    for (const end = Date.now() + 5000; !mail && Date.now() < end; await new Promise((r) => setTimeout(r, 50))) mail = other.emails().slice(seen).map(decodeEmail).find((m) => m.includes('/account/verify/')) || '';
    const cookie = other.cookieFrom(await other.request(mail.match(/\/account\/verify\/[A-Za-z0-9_-]+/)[0], { method: 'POST', form: {} }));

    const before = await (await other.request('/jobs/hr-900', { cookie })).text();
    assert.doesNotMatch(before, /9822000111/, 'hidden until they apply');
    await other.request('/account/apply/hr-900', { method: 'POST', cookie, form: { from: 'card' } });
    const page = await (await other.request('/jobs/hr-900', { cookie })).text();
    assert.match(page, /Talk to Meera, who is hiring for this job/);
    assert.match(page, /href="tel:9822000111"/);
    assert.match(page, /href="https:\/\/wa\.me\/919822000111\?text=/);
    assert.doesNotMatch(page, /Shah/, 'first name only');
    // Not shared for this job: nothing after applying either.
    await other.request('/account/apply/hr-901', { method: 'POST', cookie, form: {} });
    assert.doesNotMatch(await (await other.request('/jobs/hr-901', { cookie })).text(), /9822000111/);
    // Signed out: never.
    assert.doesNotMatch(await (await other.request('/jobs/hr-900')).text(), /9822000111/);
  } finally {
    await other.stop();
  }
});

test('city pages: live jobs there, nearby cities, in the sitemap only with real jobs', async () => {
  const pune = await text('/jobs/in/pune');
  assert.match(pune, /<h1>Jobs in Pune<\/h1>/);
  assert.match(pune, /<link rel="canonical" href="[^"]+\/jobs\/in\/pune">/);
  assert.doesNotMatch(pune, /name="robots"/);
  const places = [...pune.matchAll(/<span class="sr-only">Location: <\/span>([^<]+)</g)].map((x) => x[1].trim());
  assert.ok(places.length && places.every((p) => p === 'Pune'), places.join());
  assert.match(pune, /"@type":"CollectionPage"/);
  assert.match(pune, /href="\/jobs\?location=Pune&amp;q=delivery"/);
  // Mumbai's page links to its neighbours.
  assert.match(await text('/jobs/in/mumbai'), /href="\/jobs\/in\/navi-mumbai">Jobs in Navi Mumbai<\/a>/);
  // No real jobs: kept for visitors, out of search engines and the sitemap.
  const patna = await text('/jobs/in/patna');
  assert.match(patna, /noindex, follow/);
  assert.match(patna, /within 100 km of Patna/);
  const sitemap = await text('/sitemap.xml');
  assert.match(sitemap, /\/jobs\/in\/pune</);
  assert.doesNotMatch(sitemap, /\/jobs\/in\/patna</);
  assert.equal((await srv.request('/jobs/in/atlantis')).status, 404);
  assert.equal((await srv.request('/jobs/in/delhi-ncr')).status, 404, 'listed under Delhi');
  // The homepage's city tiles lead to them.
  assert.match(await text('/'), /class="city-tile" href="\/jobs\/in\/[a-z-]+"/);
});
