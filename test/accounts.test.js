// Job-seeker accounts: registering, one-click applying with the saved profile,
// replacing the resume, jobs that fit the profile and job alerts.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, resumeForm, decodeEmail } = require('./helpers');

let srv;
before(async () => {
  srv = await startServer();
});
after(() => srv && srv.stop());

const register = (fields, withResume = true) => {
  const all = { agree: '1', ...fields };
  let body = resumeForm(all);
  if (!withResume) {
    body = new FormData();
    for (const [k, v] of Object.entries(all)) body.append(k, v);
  }
  return srv.request('/account/register', { method: 'POST', body });
};
const general = (email) => srv.records('applications').filter((a) => a.email === email && a.jobId === 'general');
const forJob = (email, jobId) => srv.records('applications').filter((a) => a.email === email && a.jobId === jobId);

// The newest email matching `match` that arrives after `seen` emails.
async function nextEmail(match, seen) {
  for (const end = Date.now() + 5000; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) {
    const found = srv.emails().slice(seen).filter(match);
    if (found.length) return decodeEmail(found[found.length - 1]);
  }
  throw new Error('expected email was not sent');
}
const useLink = async (mail) => srv.cookieFrom(await srv.request(mail.match(/\/account\/verify\/[A-Za-z0-9_-]+/)[0], { method: 'POST', form: {} }));
async function signIn(email) {
  const seen = srv.emails().length;
  await srv.request('/account/login', { method: 'POST', form: { email } });
  return useLink(await nextEmail((e) => e.includes(`To: ${email}`) && decodeEmail(e).includes('/account/verify/'), seen));
}

test('the header and sign-in page link to registering', async () => {
  const home = await (await srv.request('/')).text();
  assert.match(home, /<a href="\/account\/register" class="nav-register[^"]*">Register<\/a>/);
  assert.match(await (await srv.request('/account/login')).text(), /href="\/account\/register"/);
  const form = await (await srv.request('/account/register')).text();
  assert.match(form, /Create your free account/);
  assert.match(form, /name="agree"/);
});

test('registering checks the details and needs agreement to the terms', async () => {
  const res = await register({ name: '', email: 'not-an-email', phone: '12', agree: '' }, false);
  assert.equal(res.status, 400);
  const html = await res.text();
  for (const msg of ['Please enter your name.', 'Please enter a valid email.', 'Please enter a valid mobile number.', 'Please agree to the Privacy Policy']) assert.ok(html.includes(msg), msg);
  assert.equal(srv.records('applications').length, 0);
});

test('registering creates a profile the team can see, and the welcome email opens the account', async () => {
  const seen = srv.emails().length;
  const res = await register({ name: 'Neha Gupta', email: 'Neha@Example.in', phone: '9811122233', location: 'Bengaluru', experience: '3-5 years', skills: 'React, Node.js, MongoDB' });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Check your email/);
  const [profile] = general('neha@example.in');
  assert.equal(profile.jobTitle, 'General application');
  assert.equal(profile.source, 'account');
  assert.ok(profile.resume);
  assert.ok(profile.registeredAt);
  await srv.waitForEmail((e) => e.includes('Subject: New candidate account') && e.includes('Neha Gupta'));

  const cookie = await useLink(await nextEmail((e) => e.includes('To: neha@example.in') && e.includes('Welcome to'), seen));
  const html = await (await srv.request('/account', { cookie })).text();
  assert.match(html, /Hi Neha/);
  assert.match(html, /Jobs for you/);
  assert.match(html, /Full-Stack Developer \(MERN\)/); // React, Node.js and MongoDB, in Bengaluru
  assert.match(html, /Your skills: React, Node.js, MongoDB/);
  assert.match(html, /On file since/);
});

test('registering again with the same email updates the profile instead of making a second one', async () => {
  await register({ name: 'Neha Gupta', email: 'neha@example.in', phone: '9811122233', skills: 'React, AWS' }, false);
  assert.equal(general('neha@example.in').length, 1);
  assert.equal(general('neha@example.in')[0].skills, 'React, AWS');
  const mail = await srv.waitForEmail((e) => e.includes('To: neha@example.in') && e.includes('already have an account'));
  assert.ok(mail);
});

test('one-click apply sends the saved profile and a copy of the resume', async () => {
  const cookie = await signIn('neha@example.in');
  const page = await (await srv.request('/jobs/hr-101', { cookie })).text();
  assert.match(page, /Apply in one click/);
  assert.match(page, /resume on file/);

  const res = await srv.request('/account/apply/hr-101', { method: 'POST', cookie, form: {} });
  assert.equal(res.status, 302);
  assert.match(decodeURIComponent(res.headers.get('location')), /Applied for Full-Stack Developer/);
  const [a] = forJob('neha@example.in', 'hr-101');
  assert.equal(a.name, 'Neha Gupta');
  assert.equal(a.phone, '9811122233');
  assert.equal(a.source, 'account');
  assert.ok(a.resume);
  assert.notEqual(a.resume, general('neha@example.in')[0].resume);
  await srv.waitForEmail((e) => e.includes('New application for Full-Stack Developer') && e.includes('Neha Gupta'));

  // Applying twice is refused, and the job page says they've applied.
  const again = await srv.request('/account/apply/hr-101', { method: 'POST', cookie, form: {} });
  assert.match(decodeURIComponent(again.headers.get('location')), /already applied/);
  assert.equal(forJob('neha@example.in', 'hr-101').length, 1);
  assert.match(await (await srv.request('/jobs/hr-101', { cookie })).text(), /You applied for this job on/);
  // Jobs they've applied to drop out of their matches.
  assert.doesNotMatch((await (await srv.request('/account', { cookie })).text()).split('Your applications')[0], /Full-Stack Developer/);
});

test('office jobs need a resume on file before one-click applying; field jobs do not', async () => {
  await register({ name: 'Ravi Kumar', email: 'ravi@example.in', phone: '9822233344', location: 'Bengaluru', skills: 'Two-Wheeler Driving' }, false);
  const cookie = await signIn('ravi@example.in');
  const office = await (await srv.request('/jobs/hr-105', { cookie })).text();
  assert.match(office, /Add a resume to/);
  assert.doesNotMatch(office, /Apply in one click/);
  const refused = await srv.request('/account/apply/hr-105', { method: 'POST', cookie, form: {} });
  assert.match(decodeURIComponent(refused.headers.get('location')), /Add a resume to your profile first/);
  assert.equal(forJob('ravi@example.in', 'hr-105').length, 0);

  const ok = await srv.request('/account/apply/hr-114', { method: 'POST', cookie, form: {} });
  assert.match(decodeURIComponent(ok.headers.get('location')), /Applied for Delivery Executive/);
  assert.equal(forJob('ravi@example.in', 'hr-114')[0].resume, '');

  // Uploading a resume makes office jobs one-click too.
  const up = await srv.request('/account/resume', { method: 'POST', cookie, body: resumeForm({}) });
  assert.match(decodeURIComponent(up.headers.get('location')), /Resume updated/);
  assert.ok(general('ravi@example.in')[0].resume);
  assert.match(await (await srv.request('/jobs/hr-105', { cookie })).text(), /Apply in one click/);
});

test('visitors who are not signed in see the normal form and an invitation to sign in', async () => {
  const html = await (await srv.request('/jobs/hr-101')).text();
  assert.doesNotMatch(html, /Apply in one click/);
  assert.match(html, /to apply in one click/);
  assert.equal((await srv.request('/account/apply/hr-101', { method: 'POST', form: {} })).headers.get('location'), '/account/login');
});

test('job alerts from the account are on at once and can be removed', async () => {
  const cookie = await signIn('ravi@example.in');
  const res = await srv.request('/account/alerts', { method: 'POST', cookie, form: { category: 'Delivery & Driving', location: 'Bengaluru' } });
  assert.match(decodeURIComponent(res.headers.get('location')), /Job alert on/);
  const sub = srv.records('job-alerts').find((s) => s.email === 'ravi@example.in');
  assert.equal(sub.confirmed, true);
  assert.match(await (await srv.request('/account', { cookie })).text(), /<b>Delivery &amp; Driving<\/b> · Bengaluru/);

  const bad = await srv.request('/account/alerts', { method: 'POST', cookie, form: { category: 'Nonsense' } });
  assert.match(decodeURIComponent(bad.headers.get('location')), /Choose a category/);

  await srv.request(`/account/alerts/${sub.id}/delete`, { method: 'POST', cookie, form: {} });
  assert.equal(srv.records('job-alerts').filter((s) => s.email === 'ravi@example.in').length, 0);
});

test('deleting the account removes the profile and every application', async () => {
  const cookie = await signIn('neha@example.in');
  await srv.request('/account/delete', { method: 'POST', cookie, form: { confirm: 'DELETE' } });
  assert.equal(srv.records('applications').filter((a) => a.email === 'neha@example.in').length, 0);
});
