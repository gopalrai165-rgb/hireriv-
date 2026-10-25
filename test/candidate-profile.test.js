// Candidate accounts (Step 49): passwords and reset, safe redirects after
// signing in, the structured profile and its completion, several resumes,
// saved jobs, interviews, settings, the activity log, the /candidate/*
// addresses and the JSON API.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, resumeForm, decodeEmail } = require('./helpers');
const { safeNext } = require('../candidates');
const cp = require('../candidate-profile');

let srv;
before(async () => { srv = await startServer({ TRUST_PROXY: '1' }); });
after(() => srv && srv.stop());

let ip = 0;
const headers = () => ({ 'x-forwarded-for': `10.9.0.${++ip}` });
const post = (url, form, cookie) => srv.request(url, { method: 'POST', form, cookie, headers: headers() });
const json = (url, method, body, cookie) => srv.request(url, { method, cookie, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json', accept: 'application/json', ...headers() } });
const candidate = (email) => srv.records('candidates').find((c) => c.email === email);
const activity = (email) => srv.records('candidate-activity').filter((e) => e.email === email).map((e) => e.event);

async function nextEmail(match, seen) {
  for (const end = Date.now() + 5000; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) {
    const found = srv.emails().slice(seen).filter(match);
    if (found.length) return decodeEmail(found[found.length - 1]);
  }
  throw new Error('expected email was not sent');
}
async function register(email, extra = {}) {
  const seen = srv.emails().length;
  const fd = new FormData();
  for (const [k, v] of Object.entries({ name: 'Kavya Iyer', email, phone: '9845012345', location: 'Chennai', agree: '1', ...extra })) fd.append(k, v);
  const res = await srv.request('/account/register', { method: 'POST', body: fd, headers: headers() });
  assert.equal(res.status, 200);
  return nextEmail((e) => e.includes(`To: ${email}`) && decodeEmail(e).includes('/account/verify/'), seen);
}
const linkIn = (mail, re) => mail.match(re)[0];

test('only internal candidate pages are allowed after signing in', () => {
  for (const ok of ['/account', '/account/profile#resume', '/jobs/driver-pune-hr-113?msg=x', '/saved', '/candidate/settings']) assert.equal(safeNext(ok), ok, ok);
  for (const bad of ['https://evil.example/', '//evil.example/x', '/\\evil.example', '/admin', '/employer', '/jobsx', '/account/logout', '/account/verify/abc', 'javascript:alert(1)', '/account\n/x', '']) assert.equal(safeNext(bad), '', bad);
});

test('profile changes are checked, and identity details have no place to go', () => {
  const ctx = { categories: ['Technology'], cities: ['Pune', 'Remote'], types: ['Full-time'], modes: ['Remote'] };
  assert.deepEqual(cp.parsePatch({ aadhaar: '1234 5678 9012', bankAccount: 'x' }, ctx).errors, ['aadhaar is not a profile field', 'bankAccount is not a profile field']);
  const bad = cp.parsePatch({ phone: '12', state: 'Atlantis', preferences: { categories: ['Spying'] }, salary: { expected: -5 }, experiences: [{ title: 'Clerk', from: '2024-05', to: '2023-01' }], education: [{ level: 'Wizard' }] }, ctx).errors;
  for (const m of ['valid mobile', 'State', 'Job categories', 'Expected pay', 'ends before it starts', 'Education level']) assert.ok(bad.some((e) => e.includes(m)), m);
  const { patch, errors } = cp.parsePatch({ skills: 'Tally, GST, tally, Excel', languages: [{ name: 'Tamil', level: 'Native' }] }, ctx);
  assert.deepEqual(errors, []);
  assert.deepEqual(patch.skills, ['Tally', 'GST', 'Excel']);
  assert.equal(cp.completion(cp.emptyProfile()).percent, 0);
  assert.equal(cp.completion({ ...cp.emptyProfile(), name: 'A', phone: '9', city: 'Pune' }, { hasResume: true }).percent, 30);
});

let kavya;
test('the welcome link confirms the email, signs in and offers a password', async () => {
  const mail = await register('kavya@example.in');
  const res = await post(linkIn(mail, /\/account\/verify\/[a-f0-9]{64}/), {});
  assert.equal(res.headers.get('location'), '/account?welcome=1');
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith('hr_cand='));
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  kavya = srv.cookieFrom(res);
  const c = candidate('kavya@example.in');
  assert.ok(c.emailVerifiedAt && c.consentAt);
  assert.equal(c.passwordHash, null);
  assert.equal(c.profile.city, 'Chennai');
  assert.equal(c.profile.state, 'Tamil Nadu');
  const page = await (await srv.request('/account?welcome=1', { cookie: kavya })).text();
  assert.match(page, /Set a password/);
  assert.match(page, /Your profile is \d+% complete/);
  assert.deepEqual(activity('kavya@example.in').sort(), ['registered', 'signed-in']);
});

test('signed out, pages send you to sign in and then back where you were going', async () => {
  const res = await srv.request('/account/profile');
  assert.equal(res.headers.get('location'), '/account/login?next=%2Faccount%2Fprofile');
  const page = await (await srv.request(res.headers.get('location'))).text();
  assert.match(page, /name="next" value="\/account\/profile"/);
  // The emailed link carries it.
  const seen = srv.emails().length;
  await post('/account/login', { email: 'kavya@example.in', next: '/account/profile' });
  const mail = await nextEmail((e) => e.includes('To: kavya@example.in'), seen);
  assert.equal((await post(linkIn(mail, /\/account\/verify\/[a-f0-9]{64}/), {})).headers.get('location'), '/account/profile');
  // Somewhere else is ignored.
  const seen2 = srv.emails().length;
  await post('/account/login', { email: 'kavya@example.in', next: 'https://evil.example/' });
  const mail2 = await nextEmail((e) => e.includes('To: kavya@example.in'), seen2);
  assert.equal((await post(linkIn(mail2, /\/account\/verify\/[a-f0-9]{64}/), {})).headers.get('location'), '/account');
});

test('setting a password, signing in with it, and the lock-out', async () => {
  const short = await post('/account/password', { password: 'short', confirm: 'short' }, kavya);
  assert.match(decodeURIComponent(short.headers.get('location')), /at least 10 characters/);
  const seen = srv.emails().length;
  const set = await post('/account/password', { password: 'mango season rain', confirm: 'mango season rain' }, kavya);
  assert.match(decodeURIComponent(set.headers.get('location')), /Password saved/);
  kavya = srv.cookieFrom(set);
  assert.match(candidate('kavya@example.in').passwordHash, /^scrypt\$/);
  await nextEmail((e) => e.includes('To: kavya@example.in') && e.includes('password was set'), seen);

  // Changing it needs the current one.
  const wrong = await post('/account/password', { current: 'nope', password: 'another long one', confirm: 'another long one' }, kavya);
  assert.match(decodeURIComponent(wrong.headers.get('location')), /current password is not right/);

  const ok = await post('/account/login', { email: 'KAVYA@example.in', password: 'mango season rain', next: '/account/settings' });
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.get('location'), '/account/settings');

  // Same reply for a wrong password and for an email with no account.
  const bad = await post('/account/login', { email: 'kavya@example.in', password: 'wrong guess' });
  const none = await post('/account/login', { email: 'nobody@example.in', password: 'wrong guess' });
  assert.equal(bad.status, 401);
  assert.equal(none.status, 401);
  const text = (h) => h.replace(/value="[^"]*"/g, '');
  assert.equal(text(await bad.text()), text(await none.text()));
  for (let i = 0; i < 8; i++) await post('/account/login', { email: 'nobody@example.in', password: 'wrong guess' });
  assert.equal((await post('/account/login', { email: 'nobody@example.in', password: 'wrong guess' })).status, 429);
  assert.ok(activity('kavya@example.in').includes('sign-in-failed'));
});

test('forgot password: a one-time link sets a new password and signs out everywhere', async () => {
  const seen = srv.emails().length;
  const res = await post('/account/forgot', { email: 'kavya@example.in' });
  assert.match(await res.text(), /If there's an account for that address/);
  const strangerReply = await (await post('/account/forgot', { email: 'stranger@example.in' })).text();
  assert.match(strangerReply, /If there's an account for that address/);
  const mail = await nextEmail((e) => e.includes('To: kavya@example.in') && e.includes('Reset your'), seen);
  const link = linkIn(mail, /\/account\/reset\/[a-f0-9]{64}/);
  assert.match(await (await srv.request(link)).text(), /Choose a new password/);
  assert.equal((await post(link, { password: 'too short', confirm: 'too short' })).status, 400);
  const done = await post(link, { password: 'new long passphrase', confirm: 'new long passphrase' });
  assert.equal(done.status, 302);
  // The old session is gone; the link works once.
  assert.equal((await srv.request('/account', { cookie: kavya })).status, 302);
  kavya = srv.cookieFrom(done);
  assert.equal((await srv.request('/account', { cookie: kavya })).status, 200);
  assert.equal((await srv.request(link)).status, 410);
  assert.equal((await post('/account/login', { email: 'kavya@example.in', password: 'new long passphrase' })).status, 302);
});

test('the profile page saves each section and copies details onto applications', async () => {
  const page = await (await srv.request('/account/profile', { cookie: kavya })).text();
  for (const id of ['basics', 'preferences', 'skills', 'resume', 'experience', 'education']) assert.match(page, new RegExp(`id="${id}"`), id);
  assert.match(page, /never ask for Aadhaar, PAN, bank details/);
  assert.doesNotMatch(page, /name="(aadhaar|pan|bank|dob)/i);

  const save = async (section, form) => decodeURIComponent((await post(`/account/profile/${section}`, form, kavya)).headers.get('location'));
  assert.match(await save('basics', { name: 'Kavya Iyer', phone: '98450 12345', city: 'Chennai', state: 'Tamil Nadu', experienceLevel: '1-3 years' }), /Saved/);
  // Repeated fields (several checkboxes) go as repeated parameters.
  const prefs = new URLSearchParams([['roles', 'Accounts executive'], ['categories', 'Finance & Accounting'], ['locations', 'Chennai'], ['locations', 'Remote'], ['types', 'Full-time'], ['salaryExpected', '28,000'], ['salaryPeriod', 'month'], ['noticePeriod', '30 days']]);
  assert.match(await save('preferences', prefs), /Saved/);
  assert.match(await save('skills', { skills: 'Tally, GST, Excel', certifications: 'Tally Prime certificate', language0: 'Tamil', languageLevel0: 'Native', language1: 'English', languageLevel1: 'Fluent' }), /Saved/);
  assert.match(await save('experience', { title: 'Accounts assistant', company: 'Sri Traders', from: '2023-06', current: '1' }), /Job added/);
  assert.match(await save('education', { level: 'Graduate', course: 'B.Com', year: '2023' }), /Education added/);
  assert.match(await save('education', { level: 'Astronaut' }), /Education level/);

  const p = candidate('kavya@example.in').profile;
  assert.deepEqual(p.preferences.locations, ['Chennai', 'Remote']);
  assert.equal(p.salary.expected, 28000);
  assert.equal(p.experiences[0].current, true);
  assert.equal(p.languages.length, 2);
  const app = srv.records('applications').find((a) => a.email === 'kavya@example.in');
  assert.equal(app.skills, 'Tally, GST, Excel');
  assert.equal(app.location, 'Chennai, Tamil Nadu');
  assert.equal(app.noticePeriod, '30 days');

  // Removing an entry.
  const id = p.experiences[0].id;
  await post(`/account/profile/experience/${id}/delete`, {}, kavya);
  assert.equal(candidate('kavya@example.in').profile.experiences.length, 0);
  // Without a resume yet, the profile isn't complete.
  assert.match(await (await srv.request('/account', { cookie: kavya })).text(), /A resume/);
});

test('up to three resumes: choose which to send, delete one, download by signed link', async () => {
  const upload = (name) => srv.request('/account/resumes', { method: 'POST', body: resumeForm({}, name), cookie: kavya, headers: headers() });
  for (const n of ['one.pdf', 'two.pdf', 'three.pdf']) assert.match(decodeURIComponent((await upload(n)).headers.get('location')), /Resume updated/);
  assert.match(decodeURIComponent((await upload('four.pdf')).headers.get('location')), /up to 3 resumes/);
  const c = candidate('kavya@example.in');
  assert.deepEqual(c.resumes.map((r) => r.name), ['three.pdf', 'two.pdf', 'one.pdf']);
  assert.equal(c.defaultResumeId, c.resumes[0].id);

  await post(`/account/resumes/${c.resumes[2].id}/default`, {}, kavya);
  assert.equal(candidate('kavya@example.in').defaultResumeId, c.resumes[2].id);

  // Downloads need the signed link from the page.
  assert.equal((await srv.request(`/account/resumes/${c.resumes[0].id}`, { cookie: kavya })).status, 410);
  const page = await (await srv.request('/account/profile', { cookie: kavya })).text();
  const href = page.match(new RegExp(`/account/resumes/${c.resumes[0].id}\\?exp=\\d+&amp;sig=[\\w-]+`))[0].replace(/&amp;/g, '&');
  assert.equal((await srv.request(href, { cookie: kavya })).status, 200);

  // Deleting the newest also removes the copy on the general application.
  const general = () => srv.records('applications').find((a) => a.email === 'kavya@example.in' && a.jobId === 'general');
  assert.equal(general().resume, c.resumes[0].appFile);
  await post(`/account/resumes/${c.resumes[0].id}/delete`, {}, kavya);
  assert.equal(candidate('kavya@example.in').resumes.length, 2);
  assert.equal(general().resume, '');
  assert.ok(activity('kavya@example.in').includes('resume-removed'));
});

test('saved jobs, interviews and settings pages', async () => {
  await srv.request('/api/candidate/saved-jobs/hr-101', { method: 'PUT', cookie: kavya });
  const saved = await (await srv.request('/account/saved', { cookie: kavya })).text();
  assert.match(saved, /Full-Stack Developer/);
  await post('/account/saved/hr-101/delete', {}, kavya);
  assert.match(await (await srv.request('/account/saved', { cookie: kavya })).text(), /Nothing saved yet/);

  assert.match(await (await srv.request('/account/interviews', { cookie: kavya })).text(), /No interviews scheduled/);

  const settings = await (await srv.request('/account/settings', { cookie: kavya })).text();
  assert.match(settings, /Recent activity/);
  assert.match(settings, /Password reset by email link/);

  // Hidden from the Talent pool once they switch it off.
  const admin = await srv.adminLogin();
  assert.match(await (await srv.request('/admin?tab=talent', { cookie: admin })).text(), /kavya@example\.in/);
  await post('/account/settings', { whatsapp: '1' }, kavya);
  assert.deepEqual(candidate('kavya@example.in').privacy, { visibleToRecruiters: false, discoverable: false });
  assert.equal(candidate('kavya@example.in').comms.whatsapp, true);
  assert.doesNotMatch(await (await srv.request('/admin?tab=talent', { cookie: admin })).text(), /kavya@example\.in/);
  await post('/account/settings', { visibleToRecruiters: '1' }, kavya);
});

test('/candidate/* addresses lead to the account pages', async () => {
  for (const [from, to] of [['/candidate', '/account'], ['/candidate/dashboard', '/account'], ['/candidate/profile', '/account/profile'], ['/candidate/resumes', '/account/profile#resume'], ['/candidate/saved-jobs', '/account/saved'], ['/candidate/settings', '/account/settings'], ['/candidate/login?next=%2Faccount%2Fsaved', '/account/login?next=%2Faccount%2Fsaved']]) {
    const res = await srv.request(from);
    assert.equal(res.status, 301, from);
    assert.equal(res.headers.get('location'), to, from);
  }
});

test('the JSON API: sign in, profile, resumes, sign out', async () => {
  assert.equal((await json('/api/candidate/profile', 'GET')).status, 401);
  const wrong = await json('/api/auth/login', 'POST', { email: 'kavya@example.in', password: 'nope nope nope' });
  assert.equal(wrong.status, 401);
  const res = await json('/api/auth/login', 'POST', { email: 'kavya@example.in', password: 'new long passphrase', next: '/account/profile' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, redirect: '/account/profile' });
  const cookie = srv.cookieFrom(res);

  const prof = await (await json('/api/candidate/profile', 'GET', undefined, cookie)).json();
  assert.equal(prof.email, 'kavya@example.in');
  assert.equal(prof.hasPassword, true);
  assert.ok(prof.completion.percent > 50);
  const raw = JSON.stringify(prof);
  for (const secret of ['scrypt', 'passwordHash', candidate('kavya@example.in').resumes[0].file]) assert.ok(!raw.includes(secret), secret);
  assert.match(prof.resumes[0].download, /^\/account\/resumes\/[a-f0-9]+\?exp=\d+&sig=/);

  const refused = await json('/api/candidate/profile', 'PATCH', { aadhaar: '123412341234', headline: 'x' }, cookie);
  assert.equal(refused.status, 400);
  assert.deepEqual((await refused.json()).errors, ['aadhaar is not a profile field']);
  const patched = await (await json('/api/candidate/profile', 'PATCH', { headline: 'Accounts executive, Tally and GST', privacy: { visibleToRecruiters: true }, comms: { sms: true } }, cookie)).json();
  assert.equal(patched.profile.headline, 'Accounts executive, Tally and GST');
  assert.equal(patched.comms.sms, true);

  const up = await srv.request('/api/candidate/resumes', { method: 'POST', body: resumeForm({}, 'api.pdf'), cookie, headers: { accept: 'application/json', ...headers() } });
  assert.equal(up.status, 201, await up.clone().text());
  const { resume } = await up.json();
  assert.equal(resume.name, 'api.pdf');
  assert.equal((await json(`/api/candidate/resumes/${resume.id}`, 'DELETE', undefined, cookie)).status, 200);
  assert.equal((await json('/api/candidate/resumes/nope', 'DELETE', undefined, cookie)).status, 404);

  assert.equal((await json('/api/auth/logout', 'POST', {}, cookie)).status, 200);
  assert.equal((await json('/api/candidate/profile', 'GET', undefined, cookie)).status, 401);
});

test('API registration and email verification, then deleting the account', async () => {
  const seen = srv.emails().length;
  const bad = await json('/api/auth/register', 'POST', { name: 'Ravi', email: 'bad', phone: '1' });
  assert.equal(bad.status, 400);
  const res = await json('/api/auth/register', 'POST', { name: 'Ravi Kumar', email: 'ravi.k@example.in', phone: '9900112233', agree: true });
  assert.equal(res.status, 202);
  // An existing account gets the same reply.
  assert.equal((await json('/api/auth/register', 'POST', { name: 'Kavya', email: 'kavya@example.in', phone: '9845012345', agree: true })).status, 202);
  const mail = await nextEmail((e) => e.includes('To: ravi.k@example.in'), seen);
  const token = linkIn(mail, /\/account\/verify\/([a-f0-9]{64})/).split('/').pop();
  const verified = await json('/api/auth/verify-email', 'POST', { token });
  assert.equal(verified.status, 200);
  const cookie = srv.cookieFrom(verified);
  assert.ok(candidate('ravi.k@example.in').emailVerifiedAt);
  assert.equal((await json('/api/auth/verify-email', 'POST', { token })).status, 410);

  assert.equal((await json('/api/candidate/account', 'DELETE', {}, cookie)).status, 400);
  assert.equal((await json('/api/candidate/account', 'DELETE', { confirm: 'DELETE' }, cookie)).status, 200);
  assert.equal(candidate('ravi.k@example.in'), undefined);
  assert.equal(srv.records('applications').filter((a) => a.email === 'ravi.k@example.in').length, 0);
  assert.deepEqual(activity('ravi.k@example.in'), []);
  assert.equal((await json('/api/candidate/profile', 'GET', undefined, cookie)).status, 401);
});
