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
  assert.match(pune, /<title>Jobs in Pune \|/);
  assert.match(pune, /href="\/jobs\/role\/delivery\/in\/pune">Delivery<\/a>/);
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

test('role pages: the role\'s jobs across India and in a city, in the sitemap only with real jobs', async () => {
  const all = await text('/jobs/role/delivery');
  assert.match(all, /<h1>Delivery jobs in India<\/h1>/);
  assert.match(all, /<title>Delivery jobs in India \|/);
  assert.match(all, /<link rel="canonical" href="[^"]+\/jobs\/role\/delivery">/);
  assert.doesNotMatch(all, /name="robots"/);
  assert.match(all, /href="\/jobs\/role\/delivery\/in\/mumbai">Delivery jobs in Mumbai<\/a>/);
  assert.match(all, /href="\/jobs\/role\/driver">Driver<\/a>/, 'other roles');
  assert.match(all, /"@type":"CollectionPage"/);
  const city = await text('/jobs/role/delivery/in/bengaluru');
  assert.match(city, /<h1>Delivery jobs in Bengaluru<\/h1>/);
  assert.match(city, /› <a href="\/jobs\/role\/delivery">Delivery jobs<\/a> › <span aria-current="page">Delivery jobs in Bengaluru/);
  const places = [...city.matchAll(/<span class="sr-only">Location: <\/span>([^<]+)</g)].map((x) => x[1].trim());
  assert.ok(places.length && places.every((p) => p === 'Bengaluru'), places.join());
  assert.ok(Number(all.match(/(\d+) open jobs?/)[1]) >= places.length);
  assert.match(city, /href="\/jobs\?q=delivery&amp;location=Bengaluru"/);
  // No real jobs: kept for visitors, out of search engines and the sitemap.
  const empty = await text('/jobs/role/driver/in/patna');
  assert.match(empty, /noindex, follow/);
  assert.match(empty, /driver jobs within 100 km of Patna/);
  const sitemap = await text('/sitemap.xml');
  assert.match(sitemap, /\/jobs\/role\/delivery</);
  assert.match(sitemap, /\/jobs\/role\/delivery\/in\/bengaluru</);
  assert.doesNotMatch(sitemap, /\/jobs\/role\/driver\/in\/patna</);
  assert.equal((await srv.request('/jobs/role/pilot')).status, 404);
  assert.equal((await srv.request('/jobs/role/driver/in/atlantis')).status, 404);
  // The homepage's popular roles lead to them.
  assert.match(await text('/'), /href="\/jobs\/role\/security-guard"/);
});

test('sign up with only a mobile number: no email, never emailed, signed in by code', async () => {
  const page = await text('/account/register?with=phone');
  assert.match(page, /action="\/account\/register\/phone"/);
  assert.match(page, /No email needed/);
  // Missing details stay on the form.
  let res = await srv.request('/account/register/phone', { method: 'POST', form: { name: 'Sunil', phone: '123' } });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /10-digit mobile number/);

  let seen = srv.emails().length;
  res = await srv.request('/account/register/phone', { method: 'POST', form: { name: 'Sunil Yadav', phone: '+91 97000 12345', location: 'Pune', agree: '1', whatsapp: '1' } });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /action="\/account\/register\/phone\/verify"/);
  const code = codeIn(await nextMessage((m) => m.includes('+919700012345'), seen));
  const wrong = code === '000000' ? '111111' : '000000';
  res = await srv.request('/account/register/phone/verify', { method: 'POST', form: { phone: '9700012345', code: wrong } });
  assert.equal(res.status, 401);
  assert.ok(!srv.records('candidates').some((c) => c.mobileOnly && c.profile.phone === '9700012345'), 'no account before the right code');
  res = await srv.request('/account/register/phone/verify', { method: 'POST', form: { phone: '9700012345', code } });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/account?welcome=1');
  const cookie = srv.cookieFrom(res);

  const c = srv.records('candidates').find((x) => x.email === '9700012345@mobile.hireriv.invalid');
  assert.ok(c && c.mobileOnly);
  assert.equal(c.phoneVerified.phone, '9700012345');
  assert.equal(c.comms.whatsapp, true);
  assert.ok(srv.records('consent-records').some((x) => x.subject === c.email && x.purpose === 'account' && x.status === 'granted'));

  // Pages show the number, never the placeholder address.
  const settings = await text('/account/settings', { cookie });
  assert.match(settings, /\+91 97000 12345/);
  assert.match(settings, /You signed up with your mobile number/);
  assert.doesNotMatch(settings, /mobile\.hireriv\.invalid/);
  assert.doesNotMatch(await text('/account', { cookie }), /mobile\.hireriv\.invalid/);

  // Editing the profile keeps the sign-in number.
  res = await srv.request('/account/profile', { method: 'POST', cookie, form: { section: 'basics', name: 'Sunil Y', city: 'Pune' } });
  assert.ok(res.status < 400, String(res.status));
  assert.equal(srv.records('candidates').find((x) => x.email === c.email).profile.phone, '9700012345');

  // Nothing is ever emailed to the placeholder.
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!srv.emails().some((m) => /To:[^\n]*mobile\.hireriv\.invalid/.test(m)));

  // Signing up again with the same number signs in to the same account
  // (the same lookup the mobile sign-in uses).
  seen = srv.emails().length;
  await srv.request('/account/register/phone', { method: 'POST', form: { name: 'Someone Else', phone: '9700012345', agree: '1' } });
  const again = codeIn(await nextMessage((m) => m.includes('+919700012345'), seen));
  res = await srv.request('/account/register/phone/verify', { method: 'POST', form: { phone: '9700012345', code: again } });
  assert.equal(res.status, 302);
  assert.equal(srv.records('candidates').filter((x) => x.phoneVerified && x.phoneVerified.phone === '9700012345').length, 1);

  // Another account can't confirm the same number.
  const other = await register('sunil.other@example.in', { phone: '9700012345' });
  seen = srv.emails().length;
  await srv.request('/account/phone/send', { method: 'POST', cookie: other, form: {} });
  const confirm = codeIn(await nextMessage((m) => m.includes('+919700012345'), seen));
  res = await srv.request('/account/phone/verify', { method: 'POST', cookie: other, form: { code: confirm } });
  assert.match(decodeURIComponent(res.headers.get('location') || ''), /already confirmed on another account/);
});

async function mobileSignup(phone, name) {
  const seen = srv.emails().length;
  await srv.request('/account/register/phone', { method: 'POST', form: { name, phone, agree: '1' } });
  const code = codeIn(await nextMessage((m) => m.includes(`+91${phone}`), seen));
  return srv.cookieFrom(await srv.request('/account/register/phone/verify', { method: 'POST', form: { phone, code } }));
}

test('a mobile-only account adds an email: everything moves onto it, except the audit trail', async () => {
  const cookie = await mobileSignup('9811122233', 'Sunita Devi');
  const placeholder = '9811122233@mobile.hireriv.invalid';
  assert.match(await text('/account/settings', { cookie }), /action="\/account\/email\/add"/);

  let seen = srv.emails().length;
  let res = await srv.request('/account/email/add', { method: 'POST', cookie, form: { email: 'Sunita.Devi@Example.in' } });
  assert.match(decodeURIComponent(res.headers.get('location')), /sent a link to sunita\.devi@example\.in/);
  const mail = decodeEmail(await nextMessage((m) => m.includes('To: sunita.devi@example.in'), seen));
  const link = mail.match(/\/account\/email\/confirm\/[a-f0-9]+/)[0];
  assert.ok(srv.records('candidates').some((c) => c.email === placeholder), 'nothing moves before the link is opened');

  assert.match(await text(link), /Add this email/);
  res = await srv.request(link, { method: 'POST', form: {} });
  assert.equal(res.status, 302);
  assert.match(decodeURIComponent(res.headers.get('location')), /sunita\.devi@example\.in is added/);
  assert.equal((await srv.request(link, { method: 'POST', form: {} })).status, 410, 'the link works once');

  // Every record moved; the account is a normal confirmed one with its number.
  const c = srv.records('candidates').find((x) => x.email === 'sunita.devi@example.in');
  assert.ok(c && !c.mobileOnly && c.emailVerifiedAt);
  assert.equal(c.phoneVerified.phone, '9811122233');
  for (const coll of ['candidates', 'applications', 'candidate-activity', 'consent-records']) {
    assert.ok(!JSON.stringify(srv.records(coll)).includes(placeholder), `${coll} still holds the placeholder`);
  }
  assert.ok(srv.records('applications').some((a) => a.email === 'sunita.devi@example.in'));
  // The session that asked keeps working, now on the email.
  const settings = await text('/account/settings', { cookie });
  assert.match(settings, /sunita\.devi@example\.in/);
  assert.doesNotMatch(settings, /action="\/account\/email\/add"/);
  // The audit trail records the move by account id, without the address.
  const entry = srv.records('trust-audit').find((e) => e.action === 'candidate-email-added');
  assert.ok(entry && entry.entityId === c.id);
  assert.ok(!JSON.stringify(entry).includes('sunita'));

  // Mobile sign-in still opens it.
  seen = srv.emails().length;
  await srv.request('/account/login/phone', { method: 'POST', form: { phone: '9811122233' } });
  const code = codeIn(await nextMessage((m) => m.includes('+919811122233'), seen));
  res = await srv.request('/account/login/phone/verify', { method: 'POST', form: { phone: '9811122233', code } });
  assert.match(await text('/account/settings', { cookie: srv.cookieFrom(res) }), /sunita\.devi@example\.in/);
});

test('adding an email that already has an account changes nothing', async () => {
  const cookie = await mobileSignup('9811122244', 'Arjun Das');
  const seen = srv.emails().length;
  const res = await srv.request('/account/email/add', { method: 'POST', cookie, form: { email: 'meena@example.in' } });
  assert.match(decodeURIComponent(res.headers.get('location')), /sent a link to meena@example\.in/, 'the same reply');
  const mail = decodeEmail(await nextMessage((m) => m.includes('To: meena@example.in'), seen));
  assert.match(mail, /already has its own account/);
  assert.doesNotMatch(mail, /\/account\/email\/confirm\//);
  assert.ok(srv.records('candidates').some((c) => c.email === '9811122244@mobile.hireriv.invalid' && c.mobileOnly));
  // Accounts with an email can't use it.
  assert.match(decodeURIComponent((await srv.request('/account/email/add', { method: 'POST', cookie: await register('ravi.add@example.in'), form: { email: 'x@example.in' } })).headers.get('location')), /already has an email/);
});
