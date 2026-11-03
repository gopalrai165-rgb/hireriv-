// "Hire <role>" pages for employers: real pay and open-job figures, what to put
// in the post, the two ways to hire, and enquiries labelled with the role.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');
const starter = require('./fixtures/jobs.json');

const seeker = (i, roles, discoverable = true) => ({ id: `c${i}`, email: `s${i}@example.in`, createdAt: '2026-10-25T00:00:00.000Z', emailVerifiedAt: '2026-10-25T00:00:00.000Z', resumes: [], defaultResumeId: null, privacy: { visibleToRecruiters: true, discoverable, shareContact: false }, profile: { name: `S${i}`, skills: [], preferences: { roles } } });
let srv;
before(async () => {
  srv = await startServer({}, {
    jobs: starter.map((j) => ({ ...j, sample: false })),
    candidates: [...Array.from({ length: 10 }, (_, i) => seeker(i, 'Telecaller, customer support')), seeker(50, 'telecaller', false), seeker(51, 'driver')],
  });
});
after(() => srv && srv.stop());
const page = async (p) => (await srv.request(p)).text();

test('each role has a hire page with what to post, the two ways to hire and the enquiry form', async () => {
  const html = await page('/hire/telecaller');
  assert.match(html, /<title>Hire Telecallers in India: Post a Job or Get a Shortlist/);
  assert.match(html, /<h1>Hire <span class="grad">telecallers<\/span><\/h1>/);
  assert.match(html, /The languages callers must speak/);
  assert.match(html, /href="\/employer\/jobs\/new">Post a job yourself<\/a>/);
  assert.match(html, /name="from" value="role:telecaller"/);
  assert.match(html, /placeholder="Roles, skills, experience, salary range and when you need them">Telecallers: <\/textarea>/);
  assert.match(html, /"@type":"Service","serviceType":"Recruitment","name":"Hire telecallers"/);
  assert.equal((await srv.request('/hire/astronaut')).status, 404);
  assert.match(await page('/sitemap.xml'), /\/hire\/security-guard<\/loc>/);
  assert.match(await page('/employers'), /<a class="chip chip-link" href="\/hire\/driver">Hire drivers<\/a>/);
  assert.match(await page('/jobs/role/driver'), /Employer\? <a href="\/hire\/driver">Hire drivers<\/a>/);
});

test('figures are real: job seekers only when ten or more asked to be found, pay only from jobs of that role', async () => {
  const tele = await page('/hire/telecaller');
  assert.match(tele, /<li><b>10<\/b><span>job seekers who want this work and asked employers to find them<\/span><\/li>/, 'the one not discoverable is not counted');
  assert.doesNotMatch(await page('/hire/driver'), /asked employers to find them/, 'one seeker is too few to show');
  const delivery = await page('/hire/delivery');
  const pay = delivery.match(/<b>₹([\d,]+) – ₹([\d,]+)<\/b><span>typical monthly pay/);
  if (pay) assert.ok(Number(pay[2].replace(/,/g, '')) < 60000, `delivery pay should not include IT jobs: ${pay[0]}`);
});

test('an enquiry from a hire page is labelled with the role', async () => {
  const res = await srv.request('/api/hire', { method: 'POST', headers: { accept: 'application/json' }, form: { from: 'role:telecaller', consentAsked: '1', consent: '1', company: 'Call Co', name: 'Ravi', email: 'ravi@callco.example', phone: '9845044444', location: 'Pune', roles: 'Telecallers: 10 for Hindi outbound' } });
  assert.equal(res.status, 200);
  assert.equal(srv.records('hire-requests').find((h) => h.company === 'Call Co').fromPage, 'Hire page: telecallers');
});
