// The job seeker's path: a seven-step checklist on the account page, and
// application and interview updates on WhatsApp for people who agreed to them.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, resumeForm, decodeEmail } = require('./helpers');

let srv;
before(async () => { srv = await startServer(); });
after(() => srv && srv.stop());

const whatsappFiles = () => (fs.existsSync(srv.paths.outbox) ? fs.readdirSync(srv.paths.outbox).filter((f) => f.endsWith('.whatsapp.txt')).map((f) => fs.readFileSync(path.join(srv.paths.outbox, f), 'utf8')) : []);
async function signIn(email) {
  const seen = srv.emails().length;
  await srv.request('/account/login', { method: 'POST', form: { email } });
  for (const end = Date.now() + 5000; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) {
    const mail = srv.emails().slice(seen).filter((e) => e.includes(`To: ${email}`)).map(decodeEmail).find((e) => e.includes('/account/verify/'));
    if (mail) return srv.cookieFrom(await srv.request(mail.match(/\/account\/verify\/[A-Za-z0-9_-]+/)[0], { method: 'POST', form: {} }));
  }
  throw new Error('no sign-in email');
}
const register = (fields) => srv.request('/account/register', { method: 'POST', body: resumeForm({ agree: '1', ...fields }) });

test('a new account sees the seven steps, with the done ones ticked', async () => {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ agree: '1', name: 'Asha Rao', email: 'asha@example.in', phone: '9811100001' })) fd.append(k, v);
  assert.equal((await srv.request('/account/register', { method: 'POST', body: fd })).status, 200);
  const cookie = await signIn('asha@example.in');
  const html = await (await srv.request('/account', { cookie })).text();
  assert.match(html, /Get your first job in 7 steps/);
  const steps = ['Register with your mobile number or email', 'Upload your resume', 'Add your skills and experience', 'Choose where you want to work', 'See jobs that match you', 'Apply with one tap', 'Follow your application status'];
  const at = steps.map((s) => html.indexOf(s));
  assert.ok(at.every((i, n) => i > 0 && (n === 0 || i > at[n - 1])), JSON.stringify(at));
  assert.match(html, /<li class="is-done">[\s\S]*?Register with your mobile number or email/);
  assert.match(html, /<a href="\/account\/profile#resume">Upload your resume<\/a>/);
  assert.match(html, /1 of 7 done/);
});

test('updates go to WhatsApp only for people who agreed, and only about applications and interviews', async () => {
  assert.equal((await register({ name: 'Ravi Patil', email: 'ravi@example.in', phone: '9822200002', whatsapp: '1' })).status, 200);
  assert.equal((await register({ name: 'Meena Shah', email: 'meena@example.in', phone: '9833300003' })).status, 200);
  const ravi = await signIn('ravi@example.in');
  const meena = await signIn('meena@example.in');
  const before = whatsappFiles().length;
  for (const cookie of [ravi, meena]) {
    const res = await srv.request('/account/apply/hr-101', { method: 'POST', cookie, form: {} });
    assert.ok([200, 302].includes(res.status), String(res.status));
  }
  let files = [];
  for (const end = Date.now() + 5000; Date.now() < end && !files.length; await new Promise((r) => setTimeout(r, 50))) files = whatsappFiles().slice(before);
  assert.equal(files.length, 1, 'only the person who agreed');
  assert.match(files[0], /^To: \+919822200002/);
  assert.match(files[0], /Hireriv: Application received/);
  assert.match(files[0], /\/account#applications/);

  const settings = await (await srv.request('/account/settings', { cookie: ravi })).text();
  assert.match(settings, /Application and interview updates on WhatsApp/);
  assert.match(settings, /may send updates about your applications and interviews to 9822200002 on WhatsApp/);
});

test('whatsapp.js: providers, settings still missing, and what a notification becomes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-'));
  const prev = process.env.OUTBOX_DIR;
  process.env.OUTBOX_DIR = dir;
  delete require.cache[require.resolve('../whatsapp')];
  const wa = require('../whatsapp');
  try {
    assert.deepEqual(wa.missing({}), []);
    assert.deepEqual(wa.missing({ WHATSAPP_PROVIDER: 'meta', WHATSAPP_TOKEN: 'x' }), ['WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_TEMPLATE']);
    assert.equal(wa.configured({ WHATSAPP_PROVIDER: 'webhook', WHATSAPP_WEBHOOK_URL: 'https://relay.example' }), true);
    assert.deepEqual(wa.missing({ WHATSAPP_PROVIDER: 'pigeon' }), ['WHATSAPP_PROVIDER (unknown: pigeon)']);

    const people = [{ email: 'a@x.in', comms: { whatsapp: true }, profile: { phone: '98111 22233' } }, { email: 'b@x.in', comms: { whatsapp: false }, profile: { phone: '9811122244' } }];
    const send = wa.notifier({ candidates: () => people, rkOf: (e) => `c:${e}`, siteName: 'Hireriv', baseUrl: 'https://hireriv.example/', env: {} });
    assert.equal(send({ rk: 'c:a@x.in', category: 'jobs', title: 'New jobs' }), null, 'job alerts stay off WhatsApp');
    assert.equal(send({ rk: 'c:b@x.in', category: 'applications', title: 'x' }), null, 'no consent, no message');
    assert.equal(send({ rk: 't:1', category: 'applications', title: 'x' }), null, 'team members are not texted');
    assert.equal(await send({ rk: 'c:a@x.in', category: 'interviews', title: 'Interview invitation', body: 'Mon 10 am', link: '/account/interviews' }), true);
    const [file] = fs.readdirSync(dir);
    assert.equal(fs.readFileSync(path.join(dir, file), 'utf8'), 'To: +919811122233\n\nHireriv: Interview invitation. Mon 10 am https://hireriv.example/account/interviews\n');
  } finally {
    if (prev === undefined) delete process.env.OUTBOX_DIR; else process.env.OUTBOX_DIR = prev;
    delete require.cache[require.resolve('../whatsapp')];
  }
});
