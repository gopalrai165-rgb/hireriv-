// Step 167: attributes added by a template condition are written as markup, not
// escaped text. The job seeker's application steps marked the current step as
// aria-current=&#34;step&#34; and the admin tabs did the same with
// aria-current="page", so screen readers never heard which one was current.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, decodeEmail } = require('./helpers');

const DAY = 86400000;
const iso = (ago = 0) => new Date(Date.now() - ago).toISOString();
const ESCAPED = /\s[a-z-]+=&(?:#34|quot);/;

let srv;
before(async () => {
  srv = await startServer({}, {
    applications: [{ id: 'a-1', jobId: 'general', jobTitle: 'General application', name: 'Asha Kumar', email: 'asha@example.com', phone: '9811111111', status: 'Shortlisted', createdAt: iso(DAY), history: [] }],
  });
});
after(() => srv && srv.stop());

// Someone who applied gets a sign-in link, which opens their account.
async function seekerCookie(email) {
  await srv.request('/account/login', { method: 'POST', form: { email } });
  const mail = decodeEmail(await srv.waitForEmail((e) => e.includes(`To: ${email}`) && decodeEmail(e).includes('/account/verify/')));
  return srv.cookieFrom(await srv.request(mail.match(/\/account\/verify\/[A-Za-z0-9_-]+/)[0], { method: 'POST', form: {} }));
}

test('the job seeker dashboard marks the current application step for screen readers', async () => {
  const html = await (await srv.request('/account', { cookie: await seekerCookie('asha@example.com') })).text();
  assert.match(html, /<li class="current" aria-current="step"><span>Under review<\/span><\/li>/);
  assert.doesNotMatch(html, ESCAPED);
});

test('the admin tabs mark the open tab as the current page', async () => {
  const admin = await srv.adminLogin();
  for (const tab of ['dashboard', 'applications', 'jobs']) {
    const html = await (await srv.request(`/admin?tab=${tab}`, { cookie: admin })).text();
    assert.match(html, new RegExp(`href="/admin\\?tab=${tab}" aria-current="page"`), tab);
    assert.doesNotMatch(html, ESCAPED, tab);
  }
});
