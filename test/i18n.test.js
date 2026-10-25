// Step 67: languages and accessibility. Locale files that match English key
// for key, the language selector (cookie, profile, safe redirects), Hindi
// pages end to end, search typed in Hindi and Telugu, application errors in
// the page's language, and job translations the employer approves, shown next
// to the original and hidden again once the listing changes.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');
const { hashPassword } = require('../employers');
const cp = require('../candidate-profile');
const i18n = require('../i18n');
const jt = require('../job-translations');
const { jobPath } = require('../content');

const DAY = 86400000;
const iso = (ago = 0) => new Date(Date.now() - ago).toISOString();
const company = (id, name) => ({ id, company: name, name, email: `owner@${id}.in`, active: true, approvedAt: iso(DAY), createdAt: iso(30 * DAY) });
const person = (id, email, name) => ({ id, email, name, phone: '9800000001', passwordHash: hashPassword(`${name} long password`), emailVerifiedAt: iso(DAY), phoneVerifiedAt: iso(DAY), createdAt: iso(DAY), active: true, link: null });
const membership = (id, employerId, userId, role) => ({ id, employerId, userId, role, jobIds: [], createdAt: iso(DAY) });
const job = (id, employerId, extra = {}) => ({ id, title: 'Delivery Driver', company: 'A Co', employerId, location: 'Delhi', mode: 'On-site', type: 'Full-time', category: 'Driving & Delivery', experience: '1-3 years', posted: '2026-10-20', skills: ['Driving'], description: 'Deliver parcels across Delhi. Two-wheeler needed, loads up to 20 kg.', responsibilities: ['Deliver 40 parcels a day', 'Collect cash on delivery'], pay: { min: 18000, max: 22000, period: 'month' }, salary: '₹18,000 – ₹22,000 a month', status: 'open', closesOn: null, sample: false, createdBy: 'employer', createdByUser: 'u-ann', ...extra });

let srv;
const p = {};
let ip = 0;
const headers = (extra = {}) => ({ 'x-forwarded-for': `10.7.${Math.floor(++ip / 250)}.${ip % 250}`, ...extra });
const post = (url, form, cookie, extra) => srv.request(url, { method: 'POST', form, cookie, headers: headers(extra) });
const get = (url, cookie) => srv.request(url, { cookie, headers: headers() });
const rec = (collection, fn) => srv.records(collection).find(fn);
const employer = async (email, name) => srv.cookieFrom(await post('/employer/login', { email, password: `${name} long password` }));
const HI = 'hr_lang=hi';
const withLang = (cookie, lang = 'hi') => [cookie, `hr_lang=${lang}`].filter(Boolean).join('; ');

before(async () => {
  srv = await startServer({ TRUST_PROXY: '1', AI_PROVIDER: 'mock', LANGUAGES: 'en,hi,te' }, {
    employers: [company('emp-a', 'A Co'), company('emp-b', 'B Co')],
    'employer-users': [person('u-ann', 'ann@aco.in', 'Ann Rao'), person('u-bob', 'bob@bco.in', 'Bob')],
    'employer-members': [membership('m1', 'emp-a', 'u-ann', 'owner'), membership('m2', 'emp-b', 'u-bob', 'owner')],
    jobs: [
      job('ja1', 'emp-a'),
      job('ja2', 'emp-a', { title: 'Data Entry Operator', category: 'Office & Admin', type: 'Part-time', location: 'Hyderabad', description: 'Type records into spreadsheets.', responsibilities: ['Enter data'], pay: null, salary: '' }),
      job('ja3', 'emp-a', { title: 'Night Guard', description: 'MOCK_DROP_NUMBERS Guard the gate for 12 hours.', responsibilities: ['Check 3 gates'] }),
    ],
    candidates: [{ id: 'c-1', email: 'meena@example.in', createdAt: iso(DAY), emailVerifiedAt: iso(DAY), passwordHash: hashPassword('meena long password'), profile: { ...cp.emptyProfile(), name: 'Meena', city: 'Delhi' }, privacy: cp.defaultPrivacy(), comms: cp.defaultComms(), resumes: [], defaultResumeId: null }],
  });
  p.ann = await employer('ann@aco.in', 'Ann Rao');
  p.bob = await employer('bob@bco.in', 'Bob');
  p.meena = srv.cookieFrom(await post('/account/login', { email: 'meena@example.in', password: 'meena long password' }));
  p.admin = await srv.adminLogin();
});
after(async () => { await srv.stop(); });

// ---------- locale files ----------
const flat = (o, pre = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) && !('one' in v && 'other' in v) ? flat(v, `${pre}${k}.`) : [[`${pre}${k}`, v]]));
const holes = (v) => [...JSON.stringify(v).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

test('Hindi has every English key with the same placeholders; Telugu falls back to English', () => {
  const en = Object.fromEntries(flat(require('../locales/en.json')).filter(([k]) => !/^(values|phrases|search|messages)\./.test(k)));
  const hi = Object.fromEntries(flat(require('../locales/hi.json')));
  const missing = Object.keys(en).filter((k) => !(k in hi));
  assert.deepEqual(missing, [], 'keys missing from hi.json');
  for (const [k, v] of Object.entries(en)) {
    assert.equal(holes(hi[k]), holes(v), `placeholders differ for ${k}`);
    if (Array.isArray(v)) assert.equal(hi[k].length, v.length, `list length differs for ${k}`);
  }
  const te = i18n.translator('te');
  assert.equal(te.t('apply.submit'), i18n.translator('en').t('apply.submit'), 'untranslated Telugu text shows in English');
  assert.notEqual(te.t('nav.findJobs'), i18n.translator('en').t('nav.findJobs'));
  assert.equal(i18n.translator('xx').code, 'en');
  // Plurals, numbers and dates in the language's own form; company names untouched.
  const hiT = i18n.translator('hi');
  assert.match(hiT.t('home.jobCount', { count: 1 }), /1/);
  assert.equal(hiT.number(125000), '1,25,000');
  assert.match(hiT.date('2026-10-25'), /2026/);
  assert.equal(hiT.tm('A Co'), 'A Co');
});

test('search typed in Hindi or Telugu finds the same jobs as English', async () => {
  const s = i18n.searchTerms('ड्राइवर दिल्ली');
  assert.equal(s.q, 'driver');
  assert.equal(s.location, 'Delhi');
  assert.equal(i18n.searchTerms('पार्ट टाइम डेटा एंट्री').type, 'Part-time');
  assert.equal(i18n.searchTerms('delivery driver').changed, false, 'English is left as it is');
  assert.equal(i18n.normalise('२००००‍').trim(), '20000', 'Devanagari digits and joiners');
  const te = i18n.searchTerms('డ్రైవర్');
  assert.equal(te.q, 'driver', JSON.stringify(te));
  for (const q of ['ड्राइवर दिल्ली', 'డ్రైవర్', 'driver']) {
    const html = await (await get(`/jobs?q=${encodeURIComponent(q)}`)).text();
    assert.match(html, /Delivery Driver/, q);
    assert.doesNotMatch(html, /Data Entry Operator/, q);
  }
  const html = await (await get(`/jobs?q=${encodeURIComponent('पार्ट टाइम डेटा एंट्री')}`, HI)).text();
  assert.match(html, /Data Entry Operator/);
  assert.match(html, /<html lang="hi"/);
});

test('the language selector: a cookie, the profile, and only internal redirects', async () => {
  let r = await post('/language', { lang: 'hi', back: '/jobs?q=x' });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/jobs?q=x');
  assert.match(r.headers.get('set-cookie'), /hr_lang=hi;.*HttpOnly/i);
  for (const back of ['https://evil.example/x', '//evil.example', '/\\evil.example', 'javascript:alert(1)']) {
    r = await post('/language', { lang: 'hi', back });
    assert.equal(r.status, 303);
    assert.ok(r.headers.get('location').startsWith('/') && !r.headers.get('location').startsWith('//') && !r.headers.get('location').includes('evil'), back);
  }
  r = await post('/language', { lang: 'ta', back: '/' });
  assert.ok(!/hr_lang=ta/.test(r.headers.get('set-cookie') || ''), 'languages not offered are refused');
  r = await srv.request('/language', { method: 'POST', form: { lang: 'hi' }, headers: headers({ origin: 'https://evil.example' }) });
  assert.equal(r.status, 403);
  // Signed in: saved on the profile, and used on the next visit without the cookie.
  await post('/language', { lang: 'hi', back: '/account/settings' }, p.meena);
  assert.equal(rec('candidates', (c) => c.id === 'c-1').language, 'hi');
  assert.match(await (await get('/account/settings', p.meena)).text(), /<html lang="hi"/);
  await post('/language', { lang: 'en', back: '/' }, p.meena);
  assert.equal(rec('candidates', (c) => c.id === 'c-1').language, 'en');
  // Accept-Language never picks the language on its own.
  const plain = await srv.request('/', { headers: headers({ 'accept-language': 'hi-IN,hi;q=0.9' }) });
  assert.match(await plain.text(), /<html lang="en"/);
});

test('Hindi pages end to end: words, labels, links to every language, and fallbacks', async () => {
  const r = await get('/?lang=hi');
  const html = await r.text();
  assert.match(html, /<html lang="hi"/);
  assert.match(html, /hreflang="hi"/);
  assert.match(html, /hreflang="en"/);
  assert.match(html, /hreflang="x-default"/);
  assert.match(html, /Noto\+Sans\+Devanagari/);
  assert.match(html, /नौकरी/);
  assert.match(r.headers.get('set-cookie') || '', /hr_lang=hi/);
  const jobs = await (await get('/jobs', HI)).text();
  assert.match(jobs, /value="Full-time"[^>]*>[^<]*फ़ुल/, 'filter values stay English, labels are Hindi');
  const page = await (await get(jobPath({ id: 'ja1', title: 'Delivery Driver', location: 'Delhi' }), HI)).text();
  assert.match(page, /1,8000|18,000/);
  assert.match(page, /A Co/, 'company names are never translated');
  for (const path of ['/help/job-terms', '/accessibility', '/saved', '/account/login', '/account/register', '/no-such-page']) {
    const h = await (await get(path, HI)).text();
    assert.match(h, /<html lang="hi"/, path);
  }
  // Workspace pages not yet translated say they are in English.
  const emp = await (await get('/employer/jobs', withLang(p.ann))).text();
  assert.match(emp, /<main[^>]*lang="en"/);
  // Offline page: every offered language at once.
  const off = await (await get('/offline')).text();
  assert.match(off, /You are offline/);
  assert.match(off, /lang="hi"[\s\S]*आप ऑफ़लाइन हैं/);
});

test('application errors come back in the page\'s language and name the fields', async () => {
  const r = await srv.request('/api/apply', { method: 'POST', form: { jobId: 'ja1' }, cookie: HI, headers: headers({ accept: 'application/json' }) });
  const body = await r.json();
  assert.equal(body.ok, false);
  assert.ok(body.errors.length >= 1);
  assert.ok(body.errors.every((e) => /[ऀ-ॿ]/.test(e)), JSON.stringify(body.errors));
  assert.ok(body.fields.includes('name'), JSON.stringify(body.fields));
  const en = await (await srv.request('/api/apply', { method: 'POST', form: { jobId: 'ja1' }, headers: headers({ accept: 'application/json' }) })).json();
  assert.ok(en.errors.some((e) => /required/.test(e)), 'English is unchanged');
  // A Hindi name and message are kept exactly as typed.
  const ok = await (await srv.request('/api/apply', { method: 'POST', form: { jobId: 'ja1', name: 'मीना कुमारी', phone: '9811122233', message: 'मैं दिल्ली में रहती हूँ', consent: '1', agree: '1' }, cookie: HI, headers: headers({ accept: 'application/json' }) })).json();
  if (ok.ok) {
    const a = rec('applications', (x) => x.name === 'मीना कुमारी');
    assert.ok(a);
    assert.equal(a.message, 'मैं दिल्ली में रहती हूँ');
  } else {
    assert.ok(ok.errors.every((e) => /[ऀ-ॿ]/.test(e)), JSON.stringify(ok.errors));
  }
});

test('job translations: a draft, checks that keep every number, the employer approves, candidates see both', async () => {
  const base = '/employer/jobs/ja1/translations/hi';
  assert.equal((await get(base)).status, 302, 'signed out goes to sign-in');
  assert.equal((await get(base, p.bob)).status, 404, 'another company sees nothing');
  assert.equal((await post(`${base}/draft`, {}, p.bob)).status, 404);
  assert.equal((await get('/employer/jobs/ja1/translations/xx', p.ann)).status, 404);
  assert.equal((await get(base, p.ann)).status, 200);

  let r = await post(`${base}/draft`, {}, p.ann);
  assert.equal(r.status, 303);
  let t = rec(jt.COLLECTION, (x) => x.jobId === 'ja1' && x.lang === 'hi');
  assert.equal(t.status, 'draft');
  assert.equal(t.method, 'ai');
  assert.match(t.draft.title, /^हिन्दी: Delivery Driver/);
  assert.ok(t.unclear.length, 'unclear words are flagged for the employer');
  assert.equal(t.published, null, 'nothing is shown before approval');
  let page = await (await get(jobPath({ id: 'ja1', title: 'Delivery Driver', location: 'Delhi' }), HI)).text();
  assert.doesNotMatch(page, /हिन्दी: Delivery Driver/);

  // Approval needs the confirmation.
  r = await post(`${base}/approve`, {}, p.ann);
  assert.equal(r.status, 400);
  // A number taken out blocks approval.
  await post(base, { title: 'डिलीवरी ड्राइवर', description: 'दिल्ली में पार्सल पहुँचाएँ। दोपहिया चाहिए।', responsibilities: 'रोज़ 40 पार्सल पहुँचाएँ\nकैश ऑन डिलीवरी लें' }, p.ann);
  r = await post(`${base}/approve`, { confirm: '1' }, p.ann);
  assert.equal(r.status, 400);
  assert.match(await r.text(), /20/);
  await post(base, { title: 'डिलीवरी ड्राइवर', description: 'दिल्ली में पार्सल पहुँचाएँ। दोपहिया चाहिए, 20 kg तक का सामान।', responsibilities: 'रोज़ 40 पार्सल पहुँचाएँ\nकैश ऑन डिलीवरी लें' }, p.ann);
  r = await post(`${base}/approve`, { confirm: '1' }, p.ann);
  assert.equal(r.status, 303, await r.text());
  t = rec(jt.COLLECTION, (x) => x.jobId === 'ja1' && x.lang === 'hi');
  assert.equal(t.status, 'approved');
  assert.equal(t.published.version, 1);
  assert.match(t.published.approvedBy, /Ann Rao/);
  assert.ok(t.published.approvedAt);
  assert.ok(srv.records('employer-audit').some((x) => x.event === 'job-translation-approved'), 'recorded in the company activity log');

  // Candidates see the translation, the original one click away, and the facts from the original.
  const url = jobPath({ id: 'ja1', title: 'Delivery Driver', location: 'Delhi' });
  page = await (await get(url, HI)).text();
  assert.match(page, /<h1 lang="hi">डिलीवरी ड्राइवर<\/h1>/);
  assert.match(page, /<details class="original-text" lang="en">[\s\S]*Deliver parcels across Delhi/);
  assert.match(page, /18,000|१८,०००|18000/);
  const en = await (await get(url)).text();
  assert.match(en, /<h1>Delivery Driver<\/h1>/);
  assert.doesNotMatch(en, /डिलीवरी ड्राइवर/);
  // Approved text is searchable.
  assert.match(await (await get(`/jobs?q=${encodeURIComponent('पार्सल')}`)).text(), /Delivery Driver/);

  // The listing changes: the translation stops showing until approved again.
  const patched = await srv.request('/api/employers/jobs/ja1', { method: 'PATCH', cookie: p.ann, body: JSON.stringify({ description: 'Deliver parcels across Delhi and Noida. Two-wheeler needed, loads up to 20 kg.' }), headers: headers({ 'content-type': 'application/json', accept: 'application/json' }) });
  assert.equal(patched.status, 200, await patched.text());
  assert.match(await (await get(base, p.ann)).text(), /Needs approval again/);
  const j = srv.records('jobs').find((x) => x.id === 'ja1');
  if (j.status === 'open') assert.doesNotMatch(await (await get(url, HI)).text(), /<h1 lang="hi">/);
});

test('numbers dropped by a machine draft block approval, and the team can only withdraw an employer\'s translation with a reason', async () => {
  await post('/employer/jobs/ja3/translations/hi/draft', {}, p.ann);
  const t = rec(jt.COLLECTION, (x) => x.jobId === 'ja3' && x.lang === 'hi');
  assert.ok(t.flags.some((f) => f.blocking && /number/.test(f.kind)), JSON.stringify(t.flags));
  const r = await post('/employer/jobs/ja3/translations/hi/approve', { confirm: '1' }, p.ann);
  assert.equal(r.status, 400);
  // Unit checks: added numbers and links are blocking too.
  const src = jt.sourceOf({ title: 'Guard', description: 'Pay 15000 a month', responsibilities: [], qualifications: [], benefits: [] });
  const flags = jt.check(src, { ...src, description: 'Pay 15000 a month, bonus 5000, see https://x.example' }, []);
  assert.ok(flags.filter((f) => f.blocking).length >= 2, JSON.stringify(flags));

  // Make and approve one for ja2 so there is something to withdraw.
  await post('/employer/jobs/ja2/translations/hi', { title: 'डेटा एंट्री ऑपरेटर', description: 'स्प्रेडशीट में रिकॉर्ड टाइप करें।', responsibilities: 'डेटा भरें' }, p.ann);
  assert.equal((await post('/employer/jobs/ja2/translations/hi/approve', { confirm: '1' }, p.ann)).status, 303);
  const teamBase = '/admin/jobs/ja2/translations/hi';
  assert.equal((await get(teamBase, p.admin)).status, 200);
  assert.equal((await post(`${teamBase}/draft`, {}, p.admin)).status, 403, 'the team does not rewrite an employer\'s translation');
  assert.equal((await post(`${teamBase}/withdraw`, { reason: 'no' }, p.admin)).status, 400);
  assert.equal((await post(`${teamBase}/withdraw`, { reason: 'Wrong shift times in Hindi' }, p.admin)).status, 303);
  assert.equal(rec(jt.COLLECTION, (x) => x.jobId === 'ja2' && x.lang === 'hi').published, null);
  assert.ok(srv.records('trust-audit').some((x) => x.action === 'job-translation-withdrawn' && x.reason === 'Wrong shift times in Hindi'));
});
