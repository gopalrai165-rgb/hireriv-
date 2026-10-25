// Security, privacy and data governance (Step 62): encrypted uploads, consent
// records, data-rights requests, retention, the security log and alerts,
// confirming identity before sensitive actions, incidents, and deletions that
// survive a restore from backup.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, resumeForm, decodeEmail } = require('./helpers');
const vault = require('../vault');
const { open: openDb } = require('../db');
const privacyModule = require('../privacy');
const securityModule = require('../security');
const teamModule = require('../team');

let srv;
let admin;
let recruiter;
let ip = 0;
const headers = (extra = {}) => ({ 'x-forwarded-for': `10.62.${Math.floor(++ip / 250)}.${ip % 250}`, ...extra });
const post = (url, form, cookie) => srv.request(url, { method: 'POST', form, cookie, headers: headers() });
const get = (url, cookie) => srv.request(url, { cookie, headers: headers() });
const json = (url, method, body, cookie) => srv.request(url, { method, cookie, body: body === undefined ? undefined : JSON.stringify(body), headers: headers({ 'content-type': 'application/json', accept: 'application/json' }) });
const msgOf = (res) => decodeURIComponent(res.headers.get('location') || '');
const events = (type) => srv.records('security-events').filter((e) => !type || e.type === type);

async function nextEmail(match, seen) {
  for (const end = Date.now() + 5000; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) {
    const found = srv.emails().slice(seen).filter(match);
    if (found.length) return decodeEmail(found[found.length - 1]);
  }
  throw new Error('expected email was not sent');
}
// Registers a job seeker (with a resume) and opens the welcome link; returns their cookie.
async function signUp(email, extra = {}) {
  const seen = srv.emails().length;
  const res = await srv.request('/account/register', { method: 'POST', body: resumeForm({ name: 'Asha Rao', email, phone: '9845012345', location: 'Pune', agree: '1', ...extra }), headers: headers() });
  assert.equal(res.status, 200);
  const mail = await nextEmail((e) => e.includes(`To: ${email}`) && decodeEmail(e).includes('/account/verify/'), seen);
  const verify = await post(mail.match(/\/account\/verify\/[a-f0-9]{64}/)[0], {});
  return srv.cookieFrom(verify);
}

before(async () => {
  srv = await startServer({ TRUST_PROXY: '1' });
  admin = await srv.adminLogin();
  await srv.request('/admin/team', { method: 'POST', cookie: admin, form: { name: 'Rahul Das', email: 'rahul@hireriv.test', role: 'Recruiter' } });
  const link = decodeEmail(await srv.waitForEmail((e) => e.includes('rahul@hireriv.test'))).match(/\/admin\/setup\/[a-f0-9]{64}/)[0];
  recruiter = srv.cookieFrom(await srv.request(link, { method: 'POST', form: { password: 'rahul-long-password', confirm: 'rahul-long-password' } }));
});
after(() => srv && srv.stop());

test('files are sealed with AES-256-GCM, tampering is caught, and keys can be rotated', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hireriv-vault-'));
  const k1 = vault.newKey();
  const k2 = vault.newKey();
  vault.configure([k1]);
  const file = path.join(dir, 'cv.pdf');
  fs.writeFileSync(file, '%PDF-1.4 secret resume');
  assert.equal(vault.seal(file), true);
  const raw = fs.readFileSync(file);
  assert.ok(vault.isSealed(raw));
  assert.ok(!raw.includes(Buffer.from('secret resume')));
  assert.equal(vault.readSync(file).toString(), '%PDF-1.4 secret resume');
  assert.equal(vault.seal(file), false, 'already sealed with the current key');
  // A changed byte fails the authentication tag.
  const bad = Buffer.from(raw);
  bad[bad.length - 1] ^= 1;
  assert.throws(() => vault.open(bad));
  // Rotation: the old key still opens files until the sweep re-seals them.
  fs.writeFileSync(path.join(dir, 'legacy.pdf'), '%PDF-1.4 from before encryption');
  fs.writeFileSync(path.join(dir, 'half.pdf.sealing'), 'left over');
  vault.configure([k2, k1]);
  assert.equal(vault.readSync(file).toString(), '%PDF-1.4 secret resume');
  assert.equal(vault.sweep(dir), 2);
  assert.ok(!fs.existsSync(path.join(dir, 'half.pdf.sealing')));
  vault.configure([k2]);
  assert.equal(vault.readSync(file).toString(), '%PDF-1.4 secret resume');
  assert.equal(vault.readSync(path.join(dir, 'legacy.pdf')).toString(), '%PDF-1.4 from before encryption');
  vault.configure([vault.newKey()]);
  assert.throws(() => vault.readSync(file), /key the server no longer has/);
  assert.throws(() => vault.configure(['too short']), /32 bytes/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Admins must use two-step sign-in on the live site, and identity checks need the password', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hireriv-team-'));
  const db = openDb(path.join(dir, 't.db'));
  const team = teamModule.create({ db, mailer: {}, baseUrl: '', ownerUser: 'admin', ownerPass: 'owner-pass-123', site: {} });
  const was = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    assert.equal(team.mustUse2fa({ role: 'Admin' }), true);
    assert.equal(team.mustUse2fa({ role: 'Recruiter' }), false);
    process.env.NODE_ENV = 'test';
    assert.equal(team.mustUse2fa({ role: 'Admin' }), false);
    assert.equal(team.mustUse2fa({ role: 'Operations Admin' }), true);
  } finally {
    process.env.NODE_ENV = was;
  }
  const owner = team.byId('owner');
  assert.equal(team.confirmIdentity(owner, 'wrong'), 'Your password is not right.');
  assert.equal(team.confirmIdentity(owner, 'owner-pass-123'), '');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  // Sign-in and reset tokens never reach the security log.
  assert.equal(securityModule.cleanPath(`/account/verify/${'a'.repeat(64)}?x=1`), '/account/verify/:token');
});

let asha;
let ravi;
test('uploaded resumes are encrypted on disk and leave only through signed, logged downloads', async () => {
  asha = await signUp('asha@example.in');
  const c = srv.records('candidates').find((x) => x.email === 'asha@example.in');
  const stored = fs.readFileSync(path.join(srv.paths.uploads, c.resumes[0].file));
  assert.ok(vault.isSealed(stored), 'sealed on disk');
  assert.ok(!stored.includes(Buffer.from('%PDF')));
  for (const a of srv.records('applications').filter((x) => x.email === 'asha@example.in' && x.resume)) assert.ok(vault.isSealed(fs.readFileSync(path.join(srv.paths.uploads, a.resume))));

  const profile = await (await json('/api/candidate/profile', 'GET', undefined, asha)).json();
  const link = profile.resumes[0].download;
  const dl = await get(link, asha);
  assert.equal(dl.status, 200);
  assert.equal(Buffer.from(await dl.arrayBuffer()).toString(), '%PDF-1.4 test');
  assert.match(dl.headers.get('content-disposition'), /^attachment/);
  assert.match(dl.headers.get('content-security-policy'), /sandbox/);
  assert.match(dl.headers.get('cache-control'), /no-store/);
  assert.equal((await get(link.split('?')[0], asha)).status, 410, 'unsigned');
  assert.equal((await get(`/uploads/${c.resumes[0].file}`)).status, 404, 'never served as a public file');
  const opened = events('document-access').find((e) => e.target === 'Own resume');
  assert.equal(opened.actorKind, 'candidate');
  assert.ok(!JSON.stringify(opened).includes('asha@example.in'), 'no email in the log');
});

test('consent is recorded per purpose with the policy version, and registering implies nothing more', async () => {
  const reg = await (await get('/account/register')).text();
  assert.match(reg, /name="considered" value="1">/, 'unticked by default');
  assert.match(await (await get('/privacy')).text(), new RegExp(`version ${privacyModule.POLICY_VERSION}`));
  const mine = (email) => srv.records('consent-records').filter((r) => r.subject === email);

  assert.equal(srv.records('candidates').find((x) => x.email === 'asha@example.in').privacy.visibleToRecruiters, false);
  const acc = mine('asha@example.in').find((r) => r.purpose === 'account');
  assert.equal(acc.status, 'granted');
  assert.equal(acc.policyVersion, privacyModule.POLICY_VERSION);
  assert.equal(acc.source, 'registration form');
  assert.ok(!mine('asha@example.in').some((r) => r.purpose === 'recruiter-visibility' || r.purpose === 'marketing-email'));

  ravi = await signUp('ravi@example.in', { considered: '1', whatsapp: '1' });
  assert.deepEqual(mine('ravi@example.in').map((r) => `${r.purpose}:${r.status}`).sort(), ['account:granted', 'recruiter-visibility:granted', 'whatsapp:granted']);

  // Changing settings records each change, and marketing moves the newsletter list with it.
  await post('/account/settings', { discoverable: '1', offers: '1' }, asha);
  assert.equal(mine('asha@example.in').find((r) => r.purpose === 'employer-discovery').status, 'granted');
  assert.equal(mine('asha@example.in').find((r) => r.purpose === 'marketing-email').source, 'account settings');
  assert.ok(srv.records('newsletter').some((s) => s.email === 'asha@example.in'));
  await post('/account/settings', { discoverable: '1' }, asha);
  assert.equal(mine('asha@example.in').find((r) => r.purpose === 'marketing-email').status, 'withdrawn');
  assert.ok(!srv.records('newsletter').some((s) => s.email === 'asha@example.in'));
  await post('/account/settings', { discoverable: '1' }, asha);
  assert.equal(mine('asha@example.in').filter((r) => r.purpose === 'marketing-email').length, 2, 'saving the same choice adds nothing');

  const api = await (await json('/api/me/consents', 'GET', undefined, asha)).json();
  assert.equal(api.current['employer-discovery'].granted, true);
  assert.equal(api.current['marketing-email'].granted, false);
  assert.ok(api.history.every((r) => !('subject' in r)));
  assert.ok(!JSON.stringify(api).includes('ravi'), 'only her own');
  assert.equal((await json('/api/me/consents', 'GET')).status, 401);
  const data = await (await get('/account/my-data.json', asha)).json();
  assert.ok(data.consents.history.length >= 4);
  const page = await (await get('/account/privacy', asha)).text();
  assert.match(page, /Findable by verified employers/);
});

test('data requests: confirmed by email, numbered, answered within 30 days, and handled by the right people', async () => {
  const send = (form) => post('/privacy/requests', form);
  const a = await (await send({ email: 'nobody@example.in', type: 'access', name: 'Nobody' })).text();
  const b = await (await send({ email: 'asha@example.in', type: 'access' })).text();
  const same = (h) => h.match(/<p class="lead">([^<]*)/)[1];
  assert.equal(same(a), same(b), 'the reply never reveals who has an account');
  assert.equal((await send({ email: 'x@example.in', type: 'grievance', details: 'short' })).status, 400);
  const before = srv.records('data-requests').length;
  await send({ email: 'bot@example.in', type: 'access', website: 'http://spam' });
  assert.equal(srv.records('data-requests').length, before, 'bot trap');

  const mail = await nextEmail((e) => e.includes('To: nobody@example.in'), 0);
  const link = mail.match(/\/privacy\/requests\/verify\/[A-Za-z0-9_-]+/)[0];
  assert.match(await (await get(link)).text(), /Yes, I sent it/);
  const pending = srv.records('data-requests').find((r) => r.email === 'nobody@example.in');
  assert.equal(pending.status, 'awaiting-verification');
  assert.doesNotMatch(await (await get('/admin/data-requests', admin)).text(), new RegExp(pending.number), 'unconfirmed requests stay out of the queue');
  assert.match(await (await post(link, {})).text(), /Request confirmed/);
  assert.equal((await post(link, {})).status, 410, 'single use');
  const r = srv.records('data-requests').find((x) => x.id === pending.id);
  assert.equal(r.status, 'received');
  assert.equal(r.verifiedHow, 'email link');
  assert.ok(Math.abs(Date.parse(r.dueAt) - Date.now() - 30 * 86400000) < 60000);

  assert.equal((await get('/admin/data-requests', recruiter)).status, 403);
  assert.match(await (await get('/admin/data-requests', admin)).text(), new RegExp(r.number));
  const detail = await (await get(`/admin/data-requests/${r.id}`, admin)).text();
  assert.match(detail, /Job-seeker account: <b>no<\/b>/);
  assert.match(msgOf(await post(`/admin/data-requests/${r.id}`, { action: 'complete', note: '', version: String(r.version) }, admin)), /Not saved: say what was done/);
  assert.match(msgOf(await post(`/admin/data-requests/${r.id}`, { action: 'note', note: 'x', version: '999' }, admin)), /someone else changed this request/);
  const seen = srv.emails().length;
  await post(`/admin/data-requests/${r.id}`, { action: 'complete', note: 'We hold no data under this email.', version: String(r.version) }, admin);
  assert.equal(srv.records('data-requests').find((x) => x.id === r.id).status, 'completed');
  assert.match(await nextEmail((e) => e.includes('To: nobody@example.in') && e.includes('completed'), seen), /We hold no data under this email/);
  assert.ok(srv.records('trust-audit').some((e) => e.action === 'data-request-complete' && e.entityId === r.number));

  // Signed-in job seekers send them from their account, already confirmed.
  const own = await post('/account/privacy/requests', { type: 'deletion', details: 'Please delete everything.' }, asha);
  assert.match(msgOf(own), /Request DR-\d{4} sent/);
  const del = srv.records('data-requests').find((x) => x.email === 'asha@example.in' && x.type === 'deletion');
  assert.equal(del.verifiedHow, 'signed in');
  assert.equal((await (await json('/api/me/data-requests', 'GET', undefined, asha)).json()).requests.length, 1);
  assert.equal((await (await json('/api/me/data-requests', 'GET', undefined, ravi)).json()).requests.length, 0, 'nobody else’s');
  assert.equal((await json('/api/me/data-requests', 'POST', { type: 'nonsense' }, ravi)).status, 400);
});

test('a deletion request erases the account only after the team member confirms it is them', async () => {
  const del = srv.records('data-requests').find((x) => x.email === 'asha@example.in' && x.type === 'deletion');
  const fresh = await srv.adminLogin();
  const ask = await post(`/admin/data-requests/${del.id}/erase`, {}, fresh);
  assert.equal(ask.status, 303);
  assert.match(ask.headers.get('location'), /^\/admin\/confirm\?next=/);
  assert.ok(srv.records('candidates').some((c) => c.email === 'asha@example.in'), 'nothing deleted yet');
  assert.equal((await post('/admin/confirm', { password: 'wrong', next: '/admin' }, fresh)).status, 401);
  await srv.confirm(fresh);
  const done = await post(`/admin/data-requests/${del.id}/erase`, { note: 'As asked.' }, fresh);
  assert.match(msgOf(done), /Account deleted/);
  assert.ok(!srv.records('candidates').some((c) => c.email === 'asha@example.in'));
  assert.ok(!srv.records('applications').some((a) => a.email === 'asha@example.in'));
  const r = srv.records('data-requests').find((x) => x.id === del.id);
  assert.equal(r.status, 'completed');
  assert.match(r.resolution, /Deleted the job-seeker account/);
  // Consent evidence stays, without the email; the journal survives a restore.
  const consents = srv.records('consent-records').filter((c) => c.subject.startsWith('erased:'));
  assert.ok(consents.length >= 4);
  assert.ok(!JSON.stringify(srv.records('consent-records')).includes('asha@example.in'));
  assert.equal(fs.readFileSync(path.join(srv.paths.dir, 'erasures.log'), 'utf8').trim().split('\n').length, 1);
  assert.equal((await get('/account', asha)).headers.get('location'), '/account/login');
  assert.ok(events('identity-confirmed').length >= 1);
});

test('retention: a period per category, validated, needing confirmation and recorded', async () => {
  const page = await (await get('/admin/retention', admin)).text();
  assert.match(page, /Security log and team activity log/);
  assert.match(page, /Placements, invoices, payments and credit notes/);
  assert.equal((await get('/admin/retention', recruiter)).status, 403);
  const fresh = await srv.adminLogin();
  const form = { candidateMonths: '0', securityLogDays: '400', consentYears: '3', requestYears: '3', incidentYears: '5', backupDays: '10', reason: 'Annual review' };
  assert.match((await post('/admin/retention', form, fresh)).headers.get('location'), /^\/admin\/confirm/);
  assert.match(await (await get('/admin/confirm?next=%2Fadmin%2Fretention&again=1', fresh)).text(), /Your password/);
  assert.match(await (await get('/admin/confirm?next=https%3A%2F%2Fevil.example', fresh)).text(), /name="next" value="\/admin"/, 'only admin pages after confirming');
  await srv.confirm(fresh);
  assert.match(msgOf(await post('/admin/retention', { ...form, securityLogDays: '30' }, fresh)), /Not saved: Security log and team activity log: a whole number of days from 180/);
  assert.match(msgOf(await post('/admin/retention', { ...form, reason: '' }, fresh)), /give the reason/);
  assert.match(msgOf(await post('/admin/retention', form, fresh)), /Retention policy saved/);
  assert.ok(srv.records('trust-audit').some((e) => e.action === 'retention-policy-changed' && /securityLogDays 365 → 400/.test(e.detail) && e.reason === 'Annual review'));
  assert.ok(events('privileged-change').some((e) => e.target === 'Retention policy changed'));
  assert.match(await (await get('/admin?tab=settings', admin)).text(), /newest 10 copies/);
});

test('the security log: failed sign-ins raise one alert, refusals and exports are logged, tokens and emails never are', async () => {
  for (let i = 0; i < 12; i++) await srv.request('/admin/login', { method: 'POST', form: { login: 'someone@hireriv.test', password: `guess-${i}` }, headers: { 'x-forwarded-for': '10.99.0.1' } });
  const alerts = events('alert').filter((e) => e.target === 'sign-ins-ip');
  assert.equal(alerts.length, 1, 'one alert an hour per address');
  assert.match(alerts[0].detail, /failed sign-ins from 10\.99\.0\.1/);
  assert.ok(events('alert').some((e) => e.target === 'sign-ins-account'));
  assert.ok(srv.records('notifications').some((n) => n.type === 'security-alert' && /Repeated failed sign-ins/.test(n.title)));
  const failed = events('sign-in-failed').find((e) => e.ip === '10.99.0.1');
  assert.equal(failed.target.length, 12, 'the account is a short hash');

  await get('/admin/incidents', recruiter);
  assert.ok(events('access-denied').some((e) => e.actorLabel === 'Rahul Das' && e.path === '/admin/incidents'));
  await srv.confirm(admin);
  assert.equal((await get('/admin/export/applications.csv', admin)).status, 200);
  assert.ok(events('bulk-export').some((e) => e.target === 'applications.csv' && e.outcome === 'ok'));

  const all = JSON.stringify(srv.records('security-events'));
  assert.doesNotMatch(all, /[a-z0-9._-]+@[a-z0-9-]+\.[a-z]{2,}/i, 'no email addresses');
  assert.doesNotMatch(all, /[a-f0-9]{64}/, 'no tokens');
  assert.doesNotMatch(all, /guess-/, 'no passwords');

  const api = await json('/api/admin/security-events?type=alert', 'GET', undefined, admin);
  assert.equal(api.status, 200);
  assert.ok((await api.json()).events.length >= 2);
  assert.equal((await json('/api/admin/security-events', 'GET', undefined, recruiter)).status, 403);
  assert.match(await (await get('/admin/security-events?type=alert', admin)).text(), /Open an incident/);
});

test('incidents follow the response plan: evidence, notification decisions, confirmed containment, and closing', async () => {
  const alert = events('alert').find((e) => e.target === 'sign-ins-ip');
  assert.equal((await post('/admin/incidents', { title: 'Password guessing', severity: 'high', category: 'account-takeover' }, recruiter)).status, 403);
  assert.match(msgOf(await post('/admin/incidents', { title: 'x', severity: 'nope' }, admin)), /Not saved/);
  const made = await post('/admin/incidents', { title: 'Password guessing on team sign-in', severity: 'high', category: 'account-takeover', alertId: alert.id, personalData: '1' }, admin);
  const id = made.headers.get('location').match(/\/admin\/incidents\/([^?]+)/)[1];
  let i = srv.records('security-incidents').find((x) => x.id === id);
  assert.equal(i.number, 'INC-0001');
  assert.deepEqual(i.alertIds, [alert.id]);
  const up = (form) => post(`/admin/incidents/${id}/update`, form, admin).then(msgOf);
  assert.match(await up({ action: 'step', step: 'evidence', note: 'Logs kept' }), /preserve the logs first/);
  assert.match(await up({ action: 'close', rootCause: 'x', lessons: 'y' }), /finish every step first/);
  assert.match(await up({ action: 'step', step: 'notified', note: 'Done' }), /decide for each authority/);

  assert.match(msgOf(await post(`/admin/incidents/${id}/preserve`, { hours: '24' }, admin)), /Evidence preserved/);
  const ev = srv.records('security-evidence').find((e) => e.incidentId === id);
  assert.ok(ev.count > 10);
  assert.equal(ev.sha256, crypto.createHash('sha256').update(JSON.stringify(ev.events)).digest('hex'));

  assert.match(await up({ action: 'decide', target: 'cert-in', decision: 'required' }), /give the reason/);
  await up({ action: 'decide', target: 'cert-in', decision: 'required', note: 'Unauthorised access attempt on a privileged account' });
  assert.match(await up({ action: 'step', step: 'notified', note: 'Done' }), /decide for each authority/);
  for (const t of ['board', 'people', 'clients']) await up({ action: 'decide', target: t, decision: 'not-required', note: 'No personal data was reached' });
  assert.match(await up({ action: 'step', step: 'notified', note: 'Done' }), /record the notifications that are required/);
  await up({ action: 'notification', target: 'cert-in', note: 'Emailed incident@cert-in.org.in, ref 12345' });
  for (const [step, note] of [['contained', 'Address blocked at the firewall'], ['evidence', 'Snapshot taken'], ['investigated', 'No sign-in succeeded'], ['notified', 'CERT-In told'], ['restored', 'Passwords rotated']]) {
    assert.match(await up({ action: 'step', step, note }), /\?msg=Saved$/, step);
  }
  i = srv.records('security-incidents').find((x) => x.id === id);
  assert.equal(i.status, 'recovering');

  // Containment asks for the password again on a new sign-in.
  const fresh = await srv.adminLogin();
  const profile = await (await json('/api/candidate/profile', 'GET', undefined, ravi)).json();
  const link = profile.resumes[0].download;
  assert.match((await post(`/admin/incidents/${id}/contain`, { action: 'rotate-download-links', note: 'Precaution' }, fresh)).headers.get('location'), /^\/admin\/confirm/);
  await srv.confirm(fresh);
  assert.match(msgOf(await post(`/admin/incidents/${id}/contain`, { action: 'rotate-download-links', note: 'Precaution' }, fresh)), /Cancelled every download link/);
  assert.equal((await get(link, ravi)).status, 410, 'links issued before the rotation stop working');
  assert.match(msgOf(await post(`/admin/incidents/${id}/contain`, { action: 'end-candidate-sessions', target: 'ravi@example.in', note: 'Precaution' }, fresh)), /Signed job seeker [a-f0-9]{8} out everywhere/);
  assert.equal((await get('/account', ravi)).headers.get('location'), '/account/login');
  assert.match(msgOf(await post(`/admin/incidents/${id}/contain`, { action: 'end-team-sessions', target: 'nobody@hireriv.test', note: 'x' }, fresh)), /Not done: no team member/);

  assert.match(await up({ action: 'step', step: 'reviewed', note: 'Lessons written up' }), /\?msg=Saved$/);
  assert.match(await up({ action: 'close', rootCause: 'Automated guessing from one address', lessons: 'Two-step sign-in required for all Admins' }), /\?msg=Saved$/);
  i = srv.records('security-incidents').find((x) => x.id === id);
  assert.equal(i.status, 'closed');
  assert.ok(i.actions.some((a) => a.kind === 'containment' && /Signed job seeker/.test(a.text)));
  const audit = await (await json('/api/admin/audit-logs?source=trust', 'GET', undefined, admin)).json();
  assert.equal(audit.chain.ok, true);
  for (const action of ['incident-opened', 'incident-containment', 'incident-evidence', 'incident-close']) assert.ok(srv.records('trust-audit').some((e) => e.action === action), action);
  assert.match(await (await get(`/admin/incidents/${id}`, admin)).text(), /Closed/);
});

test('deletions are applied again after an older backup is restored, unless the person signed up again', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hireriv-erase-'));
  const db = openDb(path.join(dir, 't.db'));
  const p = privacyModule.create({
    db, notify: { candidateRk: (e) => `c:${e}`, setPrefs() {} }, readSubmissions: (t) => db.all(t), writeSubmissions: (t, l) => db.replaceAll(t, l), saveSubmission: (t, r) => db.prepend(t, r), journalFile: path.join(dir, 'erasures.log'),
  });
  db.replaceAll('candidates', [{ email: 'old@example.in', createdAt: '2026-01-01T00:00:00.000Z' }]);
  p.consent('old@example.in', 'account', true, 'test');
  p.erased('old@example.in');
  const [rec] = db.all('consent-records');
  assert.equal(rec.subject, `erased:${p.keyed('old@example.in')}`);
  // The backup brings the account back: it is deleted again.
  const deleted = [];
  assert.equal(p.replayErasures((e) => deleted.push(e)), 1);
  assert.deepEqual(deleted, ['old@example.in']);
  // Someone who signed up again afterwards keeps their new account.
  db.replaceAll('candidates', [{ email: 'old@example.in', createdAt: new Date(Date.now() + 60000).toISOString() }]);
  assert.equal(p.replayErasures(() => assert.fail('must not delete')), 0);
  // Consent evidence goes after the retention period.
  db.replaceAll('consent-records', [{ ...rec, erasedAt: new Date(Date.now() - 4 * 365 * 86400000).toISOString() }]);
  assert.equal(p.prune({ ...p.policy(), consentYears: 3 }).consents, 1);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
