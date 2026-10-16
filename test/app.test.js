// End-to-end tests: the real server with a throwaway database, driven over HTTP
// the way a browser would. Run with `npm test`.
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, resumeForm, decodeEmail } = require('./helpers');

const JOB = 'hr-101'; // seed job: Full-Stack Developer (MERN), Bengaluru
const CANDIDATE = { jobId: JOB, name: 'Priya Sharma', email: 'priya@example.in', phone: '9876543210', skills: 'React, Node.js', experience: '3-5 years' };

let app;
let admin;
before(async () => {
  app = await startServer();
  admin = await app.adminLogin();
});
after(() => app && app.stop());

const apply = (fields, filename) =>
  app.request('/api/apply', { method: 'POST', body: resumeForm(fields, filename), headers: { accept: 'application/json' } });

describe('public site', () => {
  test('main pages load', async () => {
    for (const p of ['/', '/jobs', `/jobs/${JOB}`, '/hire', '/about', '/contact', '/blog', '/blog/resume-tips-2026', '/saved', '/privacy', '/terms', '/account/login', '/employer/login']) {
      const res = await app.request(p);
      assert.equal(res.status, 200, p);
      const html = await res.text();
      assert.doesNotMatch(html, /\bundefined\b|NaN|\[object Object\]/, p);
    }
  });

  test('unknown pages and jobs are 404', async () => {
    assert.equal((await app.request('/no-such-page')).status, 404);
    assert.equal((await app.request('/jobs/nope')).status, 404);
  });

  test('stats are in the HTML, not zeros waiting for JavaScript', async () => {
    const html = await (await app.request('/')).text();
    assert.match(html, /data-target="1200">1,200</);
  });

  test('sitemap lists open jobs, articles and legal pages; robots hides private areas', async () => {
    const xml = await (await app.request('/sitemap.xml')).text();
    for (const p of [`/jobs/${JOB}`, '/blog/resume-tips-2026', '/privacy', '/terms']) assert.ok(xml.includes(`${p}</loc>`), p);
    const robots = await (await app.request('/robots.txt')).text();
    assert.match(robots, /Disallow: \/admin/);
  });

  test('share previews: every page has an image, job pages get their own', async () => {
    const home = await (await app.request('/')).text();
    assert.match(home, /<meta property="og:image" content="[^"]+\/og\/site\.png\?v=[0-9a-f]+">/);
    const jobPage = await (await app.request(`/jobs/${JOB}`)).text();
    const url = jobPage.match(/<meta property="og:image" content="([^"]+)">/)[1];
    assert.ok(url.includes(`/og/jobs/${JOB}.png?v=`), url);

    for (const p of ['/og/site.png', new URL(url).pathname]) {
      const res = await app.request(p);
      assert.equal(res.status, 200, p);
      assert.equal(res.headers.get('content-type'), 'image/png');
      const png = Buffer.from(await res.arrayBuffer());
      assert.equal(png.subarray(1, 4).toString(), 'PNG');
      assert.equal(png.readUInt32BE(16), 1200); // width
      assert.equal(png.readUInt32BE(20), 630); // height
    }
    assert.equal((await app.request('/og/jobs/nope.png')).status, 404);
  });

  test('open jobs carry Google for Jobs data', async () => {
    const html = await (await app.request(`/jobs/${JOB}`)).text();
    assert.match(html, /"@type":"JobPosting"/);
  });
});

describe('applying for a job', () => {
  test('a resume is required', async () => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(CANDIDATE)) fd.append(k, v);
    const res = await app.request('/api/apply', { method: 'POST', body: fd, headers: { accept: 'application/json' } });
    assert.equal(res.status, 400);
    assert.deepEqual((await res.json()).errors, ['resume is required']);
  });

  test('only PDF and Word resumes are accepted', async () => {
    const res = await apply(CANDIDATE, 'resume.exe');
    assert.equal(res.status, 400);
  });

  test('bots filling the hidden field get a success reply but nothing is stored', async () => {
    const res = await apply({ ...CANDIDATE, email: 'bot@spam.test', website: 'http://spam.test' });
    assert.equal(res.status, 200);
    assert.equal(app.records('applications').some((a) => a.email === 'bot@spam.test'), false);
  });

  test('a valid application is stored and both sides are emailed', async () => {
    const res = await apply(CANDIDATE);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
    const [a] = app.records('applications');
    assert.equal(a.email, CANDIDATE.email);
    assert.equal(a.jobTitle, 'Full-Stack Developer (MERN)');
    assert.equal(a.status, 'New');
    assert.ok(a.resume);
    await app.waitForEmail((e) => e.includes(CANDIDATE.email));
  });
});

describe('admin panel', () => {
  test('requires sign-in, and rejects a wrong password', async () => {
    const res = await app.request('/admin', { headers: { accept: 'text/html' } });
    assert.equal(res.status, 302);
    assert.match(res.headers.get('location'), /^\/admin\/login/);
    const bad = await app.request('/admin/login', { method: 'POST', form: { login: 'admin', password: 'wrong' } });
    assert.equal(bad.status, 401);
  });

  test('blocks form posts from other sites', async () => {
    const [a] = app.records('applications');
    const res = await app.request(`/admin/applications/${a.id}/delete`, { method: 'POST', cookie: admin, form: {}, headers: { origin: 'https://evil.example' } });
    assert.equal(res.status, 403);
    assert.ok(app.records('applications').find((x) => x.id === a.id));
  });

  test('every tab loads for the owner', async () => {
    for (const tab of ['dashboard', 'reports', 'jobs', 'applications', 'talent', 'interviews', 'placements', 'clients', 'templates', 'blog', 'settings', 'team', 'activity']) {
      const res = await app.request(`/admin?tab=${tab}`, { cookie: admin });
      assert.equal(res.status, 200, tab);
    }
  });

  test('dashboard lists the setup still to do', async () => {
    const html = await (await app.request('/admin', { cookie: admin })).text();
    assert.match(html, /Needs your attention/);
    assert.match(html, /Add your real phone and WhatsApp numbers/);
  });

  test('a closed job stops taking applications and leaves the sitemap', async () => {
    const res = await app.request(`/admin/jobs/${JOB}/toggle`, { method: 'POST', cookie: admin, form: {} });
    assert.equal(res.status, 302);
    const r = await apply({ ...CANDIDATE, email: 'late@example.in' });
    assert.equal(r.status, 400);
    assert.match((await r.json()).errors.join(), /no longer accepting/);
    assert.ok(!(await (await app.request('/sitemap.xml')).text()).includes(`/jobs/${JOB}<`));
    await app.request(`/admin/jobs/${JOB}/toggle`, { method: 'POST', cookie: admin, form: {} });
  });
});

describe('candidate account', () => {
  test('passwordless sign-in shows the candidate their applications', async () => {
    const res = await app.request('/account/login', { method: 'POST', form: { email: CANDIDATE.email } });
    assert.equal(res.status, 200);
    const mail = decodeEmail(await app.waitForEmail((e) => decodeEmail(e).includes('/account/verify/')));
    const link = mail.match(/\/account\/verify\/[A-Za-z0-9_-]+/)[0];

    assert.equal((await app.request(link)).status, 200); // shows a button; mail scanners can't use up the link
    const verify = await app.request(link, { method: 'POST', form: {} });
    assert.equal(verify.status, 302);
    const cookie = app.cookieFrom(verify);
    const page = await (await app.request('/account', { cookie })).text();
    assert.match(page, /Full-Stack Developer \(MERN\)/);

    // Links are single-use.
    assert.equal((await app.request(link, { method: 'POST', form: {} })).status, 410);
  });

  test('unknown emails get the same reply and no email', async () => {
    const before = app.emails().length;
    const res = await app.request('/account/login', { method: 'POST', form: { email: 'stranger@example.in' } });
    assert.equal(res.status, 200);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(app.emails().length, before);
  });
});

describe('placements and invoicing', () => {
  let placementId;

  test('recording a placement moves the candidate to Hired', async () => {
    const [a] = app.records('applications');
    const res = await app.request(`/admin/applications/${a.id}/placement`, {
      method: 'POST', cookie: admin,
      form: { type: 'Permanent', company: 'Fintech Co', joiningDate: '2026-10-01', status: 'Joined', feeMode: 'percent', ctc: '1500000', feePercent: '10', guaranteeDays: '90', taxType: 'intra' },
    });
    assert.equal(res.status, 302);
    const [p] = app.records('placements');
    placementId = p.id;
    assert.equal(p.fee, 150000);
    assert.equal(app.records('applications').find((x) => x.id === a.id).status, 'Hired');
  });

  test('an invoice gets the next GST number and correct totals', async () => {
    const res = await app.request(`/admin/placements/${placementId}/invoice`, { method: 'POST', cookie: admin, form: {} });
    assert.equal(res.status, 302);
    const inv = app.records('placements')[0].invoice;
    assert.match(inv.number, /^INV\/\d{4}-\d{2}\/0001$/);
    assert.equal(inv.total, 177000);
    assert.deepEqual(inv.taxLines.map((l) => l.amount), [13500, 13500]);
    assert.equal(inv.sac, '998512');

    const html = await (await app.request(`/admin/placements/${placementId}/invoice`, { cookie: admin })).text();
    assert.match(html, /One Lakh Seventy Seven Thousand/);
  });

  test('payments with TDS settle the invoice; overpayment is refused', async () => {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const over = await app.request(`/admin/placements/${placementId}/payments`, { method: 'POST', cookie: admin, form: { date: today, amount: '200000', tds: '0', mode: 'UPI' } });
    assert.equal(over.status, 400);

    const ok = await app.request(`/admin/placements/${placementId}/payments`, { method: 'POST', cookie: admin, form: { date: today, amount: '162000', tds: '15000', mode: 'Bank transfer', reference: 'UTR123' } });
    assert.equal(ok.status, 302);
    assert.equal(app.records('placements')[0].invoice.status, 'Paid');
  });
});
