// Skip link, plain-text emails, candidate data download and editable testimonials.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, resumeForm, decodeEmail } = require('./helpers');

let srv;
let admin;
before(async () => {
  srv = await startServer();
  admin = await srv.adminLogin();
});
after(() => srv && srv.stop());

const apply = (email, name) => srv.request('/api/apply', { method: 'POST', body: resumeForm({ jobId: 'hr-101', name, email, phone: '9876543210', skills: 'React' }), headers: { accept: 'application/json' } });

async function signIn(email) {
  await srv.request('/account/login', { method: 'POST', form: { email } });
  const mail = decodeEmail(await srv.waitForEmail((e) => decodeEmail(e).includes(`To: ${email}`) && decodeEmail(e).includes('/account/verify/')));
  const link = mail.match(/\/account\/verify\/[A-Za-z0-9_-]+/)[0];
  return srv.cookieFrom(await srv.request(link, { method: 'POST', form: {} }));
}

test('every page starts with a skip-to-content link', async () => {
  const html = await (await srv.request('/jobs')).text();
  assert.match(html, /<a class="skip-link" href="#main">Skip to content<\/a>/);
  assert.match(html, /<main id="main"/);
});

test('emails carry a plain-text part as well as HTML', async () => {
  await apply('priya@example.in', 'Priya Sharma');
  const mail = await srv.waitForEmail((e) => e.includes('priya@example.in') && e.includes("We've received your application"));
  assert.match(mail, /Content-Type: text\/plain/);
  assert.match(mail, /Content-Type: text\/html/);
});

test('candidates can download their data and their own resume, nobody else\'s', async () => {
  await apply('ravi@example.in', 'Ravi Kumar');
  const cookie = await signIn('priya@example.in');
  const res = await srv.request('/account/my-data.json', { cookie });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="?my-data-/);
  const data = await res.json();
  assert.equal(data.email, 'priya@example.in');
  assert.equal(data.applications.length, 1);
  assert.equal(data.applications[0].job, 'Full-Stack Developer (MERN)');
  assert.equal(data.applications[0].details.skills, 'React');
  assert.equal('notes' in data.applications[0], false);

  const [mine, theirs] = ['priya@example.in', 'ravi@example.in'].map((e) => srv.records('applications').find((a) => a.email === e));
  // Downloads go through the signed link on the account page, which expires.
  const link = (await (await srv.request('/account', { cookie })).text()).match(/href="(\/account\/resume\/[^"]+)"/)[1].replace(/&amp;/g, '&');
  assert.equal((await srv.request(link, { cookie })).status, 200);
  assert.equal((await srv.request(`/account/resume/${mine.id}`, { cookie })).status, 410);
  assert.equal((await srv.request(link.replace(/sig=[^&]+/, 'sig=forged'), { cookie })).status, 410);
  assert.equal((await srv.request(`/account/resume/${theirs.id}${link.slice(link.indexOf('?'))}`, { cookie })).status, 404);
  assert.equal((await srv.request('/account/my-data.json')).status, 302); // signed out
});

test('testimonials: samples until replaced, then the real ones', async () => {
  let home = await (await srv.request('/')).text();
  assert.match(home, /Head of Engineering/);
  assert.match(await (await srv.request('/admin', { cookie: admin })).text(), /Replace the sample testimonials/);

  const form = {
    tagline: 'Hiring', phone: '+91 98765 43210', whatsapp: '919876543210', email: 'hello@hireriv.com', address: 'Kolkata', hours: '9-6',
    stat_value_0: '10', stat_label_0: 'Hires', jobCategories: 'Technology', jobLocations: 'Bengaluru',
    billing_feePercent: '8.33', billing_guaranteeDays: '90', billing_gstPercent: '18', billing_paymentDays: '15', billing_tdsPercent: '10',
    testimonial_quote_0: 'Fast, honest and thorough.', testimonial_name_0: 'Meera Iyer', testimonial_detail_0: 'HR Lead, D2C brand', testimonial_rating_0: '4',
  };
  assert.equal((await srv.request('/admin/settings', { method: 'POST', cookie: admin, form })).status, 302);
  home = await (await srv.request('/')).text();
  assert.match(home, /Fast, honest and thorough\./);
  assert.match(home, /aria-label="4 out of 5"/);
  assert.match(home, /<span class="avatar" aria-hidden="true">MI<\/span>/);
  assert.doesNotMatch(home, /Head of Engineering/);
  assert.doesNotMatch(await (await srv.request('/admin', { cookie: admin })).text(), /Replace the sample testimonials/);

  // Hidden on purpose: the section disappears.
  await srv.request('/admin/settings', { method: 'POST', cookie: admin, form: { ...form, testimonials_hide: '1' } });
  assert.doesNotMatch(await (await srv.request('/')).text(), /What clients and candidates say/);
});
