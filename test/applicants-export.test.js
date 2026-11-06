// Step 203: employers download their applicants as a spreadsheet. It follows the
// page's filters, each person only gets what they may see on that job, and every
// download is in the company's activity log, without names.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');
const { hashPassword } = require('../employers');

const iso = (ago = 0) => new Date(Date.now() - ago * 864e5).toISOString();
const today = iso().slice(0, 10);
const person = (id, email, name) => ({ id, email, name, phone: '9800000001', passwordHash: hashPassword(`${name} long password`), emailVerifiedAt: iso(1), phoneVerifiedAt: iso(1), createdAt: iso(1), active: true, link: null });
const company = (id, name) => ({ id, company: name, name, email: `o@${id}.in`, active: true, approvedAt: iso(1), verification: { status: 'verified' }, verificationStatus: 'verified', createdAt: iso(30) });
const member = (id, employerId, userId, role, jobIds = []) => ({ id, employerId, userId, role, jobIds, createdAt: iso(1) });
const job = (id, employerId, title) => ({ id, employerId, title, company: 'A Co', location: 'Pune', mode: 'On-site', type: 'Full-time', category: 'Retail', experience: '', skills: [], description: 'Work', responsibilities: [], posted: today, status: 'open', alertsSentAt: today, resume: 'optional', createdBy: 'employer' });
const app = (id, jobId, name, phone, extra = {}) => ({ id, jobId, jobTitle: jobId, name, email: `${id}@example.in`, phone, status: 'New', createdAt: iso(2), history: [], ...extra });

let srv;
let ann;
let rob;
let vic;
let bob;
let ip = 0;
const h = () => ({ 'x-forwarded-for': `10.203.${Math.floor(++ip / 250)}.${(ip % 250) + 1}` });
const get = (url, cookie) => srv.request(url, { cookie, headers: h() });
const post = (url, form, cookie) => srv.request(url, { method: 'POST', form, cookie, headers: h() });
const decode = (s) => s.replace(/&amp;/g, '&');
// The link on the page, which is signed for those filters.
async function linkOn(url, cookie) {
  const m = (await (await get(url, cookie)).text()).match(/href="(\/employer\/applicants\.csv[^"]*)"/);
  return m && decode(m[1]);
}
async function download(url, cookie) {
  const link = await linkOn(url, cookie);
  assert.ok(link, `a download link on ${url}`);
  const r = await get(link, cookie);
  assert.equal(r.status, 200);
  return { r, csv: await r.text() };
}

before(async () => {
  srv = await startServer({ TRUST_PROXY: '1' }, {
    employers: [company('emp-a', 'A Co'), company('emp-b', 'B Co')],
    'employer-users': [person('u-ann', 'ann@aco.in', 'Ann'), person('u-rob', 'rob@aco.in', 'Rob'), person('u-vic', 'vic@aco.in', 'Vic'), person('u-bob', 'bob@bco.in', 'Bob')],
    'employer-members': [member('m1', 'emp-a', 'u-ann', 'owner'), member('m2', 'emp-a', 'u-rob', 'recruiter', ['j1']), member('m3', 'emp-a', 'u-vic', 'viewer'), member('m4', 'emp-b', 'u-bob', 'owner')],
    jobs: [job('j1', 'emp-a', 'Packer'), job('j2', 'emp-a', 'Driver'), job('j9', 'emp-b', 'Other job')],
    applications: [
      app('a1', 'j1', 'Asha Rao', '9845011001', { skills: 'Packing', location: 'Pune', atsNotes: [{ id: 'n1', at: iso(1), by: 'Ann', text: 'SECRET-NOTE' }], resumeText: 'RESUME-WORDS', messages: [{ id: 'x', at: iso(1), from: 'hiring', by: 'Ann', text: 'PRIVATE-MESSAGE' }], screening: [{ text: 'Do you have a licence?', type: 'yesno', answer: 'yes', mustBe: 'yes' }, { text: 'Which city?', type: 'text', answer: 'TYPED-ANSWER' }] }),
      app('a2', 'j2', 'Bala Iyer', '9845011002', { status: 'Hired' }),
      app('a3', 'j1', '=HYPERLINK("http://evil.example")', '9845011003'),
      app('a4', 'j1', 'Wen Left', '9845011004', { withdrawnAt: iso(1) }),
      app('a9', 'j9', 'Other Person', '9845011009'),
    ],
  });
  const login = async (email, name) => srv.cookieFrom(await post('/employer/login', { email, password: `${name} long password` }));
  ann = await login('ann@aco.in', 'Ann');
  rob = await login('rob@aco.in', 'Rob');
  vic = await login('vic@aco.in', 'Vic');
  bob = await login('bob@bco.in', 'Bob');
}, { timeout: 60000 });
after(() => srv && srv.stop());

test('the owner downloads every applicant in the company, as a file, and no others', async () => {
  const { r, csv } = await download('/employer/applicants', ann);
  assert.match(r.headers.get('content-type'), /text\/csv/);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="?hireriv-applicants-/);
  assert.match(r.headers.get('cache-control'), /no-store/);
  assert.match(csv, /Asha Rao/);
  assert.match(csv, /Bala Iyer/);
  assert.match(csv, /a1@example\.in/);
  assert.match(csv, /9845011001/);
  assert.doesNotMatch(csv, /Other Person|Other job/);
});

test('it leaves out notes, messages and resume text, and makes formulas harmless', async () => {
  const { csv } = await download('/employer/applicants', ann);
  assert.doesNotMatch(csv, /SECRET-NOTE|PRIVATE-MESSAGE|RESUME-WORDS/);
  assert.match(csv, /"'=HYPERLINK\(/);
  assert.doesNotMatch(csv, /(^|,)"?=HYPERLINK/m);
  assert.match(csv, /Do you have a licence\?: Yes/);
  assert.match(csv, /TYPED-ANSWER/);
});

test('it follows the filters on the page', async () => {
  const { csv } = await download('/employer/applicants?job=j2', ann);
  assert.match(csv, /Bala Iyer/);
  assert.doesNotMatch(csv, /Asha Rao/);
  const hired = await download('/employer/applicants?status=Hired', ann);
  assert.match(hired.csv, /Bala Iyer/);
  assert.doesNotMatch(hired.csv, /Asha Rao/);
  assert.equal(await linkOn('/employer/applicants?job=j1&status=Hired', ann), null, 'no link when nobody matches');
});

test('someone who withdrew stays listed without their contact details', async () => {
  const { csv } = await download('/employer/applicants', ann);
  const line = csv.split('\r\n').find((l) => l.startsWith('Wen Left'));
  assert.ok(line);
  assert.match(line, /Withdrawn/);
  assert.doesNotMatch(line, /a4@example\.in|9845011004/);
});

test('a recruiter gets only their jobs; a viewer gets no contact details or typed answers', async () => {
  const robs = await download('/employer/applicants', rob);
  assert.match(robs.csv, /a1@example\.in/);
  assert.doesNotMatch(robs.csv, /Bala Iyer/);

  const vics = await download('/employer/applicants', vic);
  assert.match(vics.csv, /Asha Rao/);
  assert.doesNotMatch(vics.csv, /@example\.in|98450110|TYPED-ANSWER/);
  assert.doesNotMatch(vics.csv.split('\r\n')[0], /Email|Phone|LinkedIn/, 'no empty contact columns');
  assert.match(vics.csv, /Do you have a licence\?: Yes/, 'yes or no answers are on the page for viewers too');
});

test('a link only works signed and for the person signed in', async () => {
  assert.equal((await get('/employer/applicants.csv', ann)).status, 410, 'unsigned');
  const link = await linkOn('/employer/applicants?job=j1', ann);
  assert.notEqual((await get(link)).status, 200, 'signed out');
  const bobs = await get(link, bob);
  assert.doesNotMatch(await bobs.text(), /Asha Rao/, 'another company gets none of them');
});

test('each download is in the activity log, without names', async () => {
  const before_ = srv.records('employer-audit').filter((e) => e.event === 'applicants-exported').length;
  await download('/employer/applicants?job=j2', ann);
  const log = srv.records('employer-audit').filter((e) => e.event === 'applicants-exported');
  assert.equal(log.length, before_ + 1);
  const e = log.find((x) => /Driver/.test(x.detail));
  assert.equal(e.employerId, 'emp-a');
  assert.match(e.detail, /1 applicant/);
  assert.match(e.detail, /with contact details/);
  assert.doesNotMatch(JSON.stringify(log), /Bala|Asha|@example/);
  const vicLog = srv.records('employer-audit').find((x) => x.event === 'applicants-exported' && x.userId === 'u-vic');
  assert.match(vicLog.detail, /without contact details/);
});

test('the page warns about personal data', async () => {
  assert.match(await (await get('/employer/applicants', ann)).text(), /Download as a spreadsheet/);
  assert.match(await (await get('/employer/applicants', ann)).text(), /personal details/);
});
