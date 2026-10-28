// The resume builder: a real, readable PDF made from the profile, saved like
// an upload so one-click applying to office jobs works without a file of one's own.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const resumePdf = require('../resume-pdf');
const { hasValidSignature } = require('../uploads');
const { startServer, decodeEmail } = require('./helpers');

const text = async (buf) => {
  const { PDFParse } = require('pdf-parse');
  return (await new PDFParse({ data: buf }).getText()).text;
};
const profile = {
  name: 'Asha Verma', headline: 'Forklift operator – 5 years', phone: '+91 98220 00001', city: 'Pune',
  skills: ['Forklift', 'Safety (ISO)'], languages: [{ name: 'Hindi', level: 'Fluent' }],
  experiences: [{ title: 'Forklift Operator', company: 'Nova Foods', from: '2021-06', current: true, summary: 'Moved pallets in a cold store.' }],
  education: [{ level: '12th', course: '', institution: 'Govt School, Pune', year: '2018' }],
  certifications: [{ name: 'Forklift licence', issuer: 'RTO', year: '2020' }],
};

test('the PDF holds every section, in a form any reader opens', async () => {
  const { pdf, pages, dropped } = resumePdf.build(profile, { summary: 'Safe and on time; “night shifts” fine. ₹ wise.', contact: ['Pune', '+91 98220 00001', 'asha@example.in'] });
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.equal(pages, 1);
  assert.deepEqual(dropped, []);
  const t = await text(pdf);
  for (const s of ['Asha Verma', 'Forklift operator – 5 years', 'asha@example.in', 'ABOUT ME', '“night shifts”', 'Rs.', 'EXPERIENCE', 'Forklift Operator, Nova Foods', 'Jun 2021 to Present', 'Safety (ISO)', 'Govt School, Pune', 'Forklift licence, RTO, 2020', 'Hindi (fluent)']) assert.ok(t.includes(s), s);
});

test('long resumes flow onto more pages; text the fonts lack is reported, not garbled', async () => {
  const many = { ...profile, experiences: Array.from({ length: 20 }, (_, i) => ({ title: `Job ${i + 1}`, company: 'Firm', from: '2010-01', to: '2011-01', summary: 'Did the work well. '.repeat(25) })) };
  const out = resumePdf.build(many, { summary: 'मैं मेहनती हूँ. Hard working.' });
  assert.ok(out.pages >= 3, `${out.pages} pages`);
  assert.ok(out.dropped.includes('म'));
  const t = await text(out.pdf);
  assert.ok(t.includes('Job 20'));
  assert.ok(t.includes('Hard working.'));
  // A word longer than the line is cut, never drawn off the page.
  assert.ok(resumePdf.wrap('x'.repeat(400), 10, false, 495).length > 1);
});

test('what the builder suggests adding', () => {
  assert.deepEqual(resumePdf.gaps(profile), []);
  assert.deepEqual(resumePdf.gaps({ name: 'A' }).map((g) => g.href), ['/account/profile#basics', '/account/profile#experience', '/account/profile#skills', '/account/profile#education']);
});

let srv;
before(async () => {
  srv = await startServer();
});
after(() => srv && srv.stop());

async function signIn(email) {
  const seen = srv.emails().length;
  await srv.request('/account/login', { method: 'POST', form: { email } });
  for (const end = Date.now() + 5000; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) {
    const mail = srv.emails().slice(seen).map(decodeEmail).find((e) => e.includes('/account/verify/'));
    if (mail) return srv.cookieFrom(await srv.request(mail.match(/\/account\/verify\/[A-Za-z0-9_-]+/)[0], { method: 'POST', form: {} }));
  }
  throw new Error('no sign-in email');
}

test('a job seeker with no resume makes one, saves it and applies to an office job in one click', async () => {
  const body = new FormData();
  for (const [k, v] of Object.entries({ agree: '1', name: 'Ravi Kumar', email: 'ravi.builder@example.in', phone: '9822233355', location: 'Bengaluru', skills: 'Tally, GST' })) body.append(k, v);
  await srv.request('/account/register', { method: 'POST', body });
  const cookie = await signIn('ravi.builder@example.in');
  const patch = await srv.request('/api/candidate/profile', {
    method: 'PATCH', cookie, headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ headline: 'Accounts assistant', experiences: [{ title: 'Accounts Assistant', company: 'Shree Traders', from: '2022-04', current: true, summary: 'Daily entries in Tally.' }] }),
  });
  assert.equal(patch.status, 200);

  // The job page points to the builder while a resume is missing.
  assert.match(await (await srv.request('/jobs/hr-105', { cookie })).text(), /href="\/account\/resume-builder">No resume\? Make one from your profile\./);
  const pageHtml = await (await srv.request('/account/resume-builder', { cookie })).text();
  assert.match(pageHtml, /class="resume-sheet"/);
  assert.match(pageHtml, /Accounts Assistant, Shree Traders/);
  assert.match(pageHtml, /href="\/account\/profile#education"/, 'suggests adding education');
  assert.equal((await srv.request('/account/resume-builder')).status, 302, 'signed in only');

  // "About me" is kept for the preview.
  assert.equal((await srv.request('/account/resume-builder', { method: 'POST', cookie, form: { summary: 'Careful with numbers.' } })).status, 303);
  assert.match(await (await srv.request('/account/resume-builder', { cookie })).text(), /Careful with numbers\./);

  const dl = await srv.request('/account/resume-builder/download', { method: 'POST', cookie, form: { summary: 'Careful with numbers.' } });
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get('content-type'), 'application/pdf');
  assert.match(dl.headers.get('content-disposition'), /attachment/);
  const pdf = Buffer.from(await dl.arrayBuffer());
  assert.ok((await text(pdf)).includes('Careful with numbers.'));
  assert.ok((await text(pdf)).includes('ravi.builder@example.in'));
  // Downloading saves nothing.
  assert.equal(srv.records('candidates').find((c) => c.email === 'ravi.builder@example.in').resumes.length, 0);

  // Cross-site posts are refused like every other account form.
  assert.equal((await srv.request('/account/resume-builder/save', { method: 'POST', cookie, form: {}, headers: { origin: 'https://evil.example' } })).status, 403);

  const saved = await srv.request('/account/resume-builder/save', { method: 'POST', cookie, form: { summary: 'Careful with numbers.' } });
  assert.match(decodeURIComponent(saved.headers.get('location')), /Resume saved/);
  const c = srv.records('candidates').find((x) => x.email === 'ravi.builder@example.in');
  assert.equal(c.resumes.length, 1);
  assert.equal(c.resumes[0].name, 'Resume made on Hireriv.pdf');
  assert.equal(c.builder.summary, 'Careful with numbers.');
  const fs = require('node:fs');
  const path = require('node:path');
  const stored = path.join(srv.paths.uploads, c.resumes[0].file);
  assert.ok(fs.existsSync(stored));
  // The general application carries it and its text, for recruiters' search.
  const general = srv.records('applications').find((a) => a.email === 'ravi.builder@example.in' && a.jobId === 'general');
  assert.ok(general.resume);

  const applied = await srv.request('/account/apply/hr-105', { method: 'POST', cookie, form: {} });
  assert.doesNotMatch(decodeURIComponent(applied.headers.get('location')), /Add a resume/);
  assert.ok(srv.records('applications').find((a) => a.email === 'ravi.builder@example.in' && a.jobId === 'hr-105'));
});

test('the made PDF passes the same file checks as an upload', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hireriv-rb-')), 'r.pdf');
  fs.writeFileSync(file, resumePdf.build(profile).pdf);
  assert.equal(hasValidSignature(file, 'Resume made on Hireriv.pdf'), true);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

