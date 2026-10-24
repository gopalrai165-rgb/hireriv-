// Resume safety (real file types, virus scanning, expiring download links),
// the database's one-application-per-person rule, and job addresses with titles.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { startServer, resumeForm } = require('./helpers');
const { open } = require('../db');
const { links } = require('../uploads');

// A stand-in for ClamAV's clamd: reads an INSTREAM upload and reports a virus
// when the file contains the word EICAR.
function fakeClamd() {
  const server = net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    socket.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      const start = buf.indexOf('\0') + 1;
      if (!start) return;
      let at = start;
      const parts = [];
      while (at + 4 <= buf.length) {
        const n = buf.readUInt32BE(at);
        if (n === 0) {
          const file = Buffer.concat(parts).toString('latin1');
          socket.end(file.includes('EICAR') ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0');
          return;
        }
        if (at + 4 + n > buf.length) return;
        parts.push(buf.subarray(at + 4, at + 4 + n));
        at += 4 + n;
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

let clamd;
let srv;
let admin;
before(async () => {
  clamd = await fakeClamd();
  srv = await startServer({ CLAMAV_HOST: '127.0.0.1', CLAMAV_PORT: String(clamd.address().port), TRUST_PROXY: '1' });
  admin = await srv.adminLogin();
});
after(() => {
  if (srv) srv.stop();
  if (clamd) clamd.close();
});

let ip = 0;
const applyWith = async (content, filename = 'cv.pdf', email = `p${ip}@example.in`) => {
  ip++;
  const fd = new FormData();
  for (const [k, v] of Object.entries({ jobId: 'hr-101', name: 'Test Person', email, phone: '9876500000' })) fd.append(k, v);
  fd.append('resume', new Blob([content]), filename);
  const res = await srv.request('/api/apply', { method: 'POST', body: fd, headers: { accept: 'application/json', 'x-forwarded-for': `10.7.0.${ip}` } });
  return { status: res.status, body: await res.json() };
};
const uploadsNow = () => fs.readdirSync(srv.paths.uploads).length;

test('a resume must really be a PDF or Word file, not just named like one', async () => {
  const before = uploadsNow();
  const fake = await applyWith('MZ this is a program', 'cv.pdf');
  assert.equal(fake.status, 400);
  assert.match(fake.body.errors[0], /doesn't look like a real PDF or Word document/);
  assert.equal(uploadsNow(), before, 'the rejected file is deleted');
  const docx = await applyWith(Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]), 'cv.docx');
  assert.equal(docx.status, 200);
  const doc = await applyWith(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0]), 'cv.doc');
  assert.equal(doc.status, 200);
});

test('resumes are scanned for viruses, and infected files are refused and deleted', async () => {
  const before = uploadsNow();
  const bad = await applyWith('%PDF-1.4 EICAR test file', 'cv.pdf', 'virus@example.in');
  assert.equal(bad.status, 400);
  assert.match(bad.body.errors[0], /blocked by our virus scanner/);
  assert.equal(uploadsNow(), before);
  assert.equal(srv.records('applications').filter((a) => a.email === 'virus@example.in').length, 0);
  assert.equal((await applyWith('%PDF-1.4 clean', 'cv.pdf', 'clean@example.in')).status, 200);
});

test('when the virus scanner is down, uploads are refused rather than let through', async () => {
  const down = await startServer({ CLAMAV_HOST: '127.0.0.1', CLAMAV_PORT: '1' });
  try {
    const res = await down.request('/api/apply', { method: 'POST', body: resumeForm({ jobId: 'hr-101', name: 'A', email: 'a@example.in', phone: '9876500001' }), headers: { accept: 'application/json' } });
    assert.equal(res.status, 400);
    assert.match((await res.json()).errors[0], /couldn't check your file for viruses/);
    assert.equal(down.records('applications').length, 0);
  } finally {
    down.stop();
  }
});

test('resume downloads need a fresh signed link as well as a sign-in', async () => {
  const html = await (await srv.request('/admin?tab=applications', { cookie: admin })).text();
  const link = html.match(/href="(\/admin\/resume\/[^"]+)"/)[1].replace(/&amp;/g, '&');
  assert.match(link, /\?exp=\d+&sig=/);
  const ok = await srv.request(link, { cookie: admin });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-disposition'), /attachment/);
  assert.equal((await srv.request(link)).status, 401, 'still needs the team sign-in');
  assert.equal((await srv.request(link.split('?')[0], { cookie: admin })).status, 410);
  const other = link.replace(/\/admin\/resume\/[^?]+/, '/admin/resume/someone-else.pdf');
  assert.equal((await srv.request(other, { cookie: admin })).status, 410, 'a signature only fits its own file');

  // Expired links fail even with the right signature.
  const l = links('secret');
  const signed = l.signed('/x', -1);
  const [p, qs] = signed.split('?');
  assert.equal(l.valid({ path: p, query: Object.fromEntries(new URLSearchParams(qs)) }), false);
  const fresh = l.signed('/x');
  assert.equal(l.valid({ path: '/x', query: Object.fromEntries(new URLSearchParams(fresh.split('?')[1])) }), true);
});

test('the database itself refuses a second live application for the same person and job', () => {
  const db = open(path.join(os.tmpdir(), `hireriv-unique-${process.pid}-${Date.now()}.db`));
  db.uniqueKey('applications', (a) => (a.withdrawnAt ? null : `${a.jobId}|${a.email}`));
  db.prepend('applications', { id: '1', jobId: 'hr-101', email: 'a@x.in' });
  assert.throws(() => db.prepend('applications', { id: '2', jobId: 'hr-101', email: 'a@x.in' }), { code: 'ERR_UNIQUE' });
  assert.throws(() => db.replaceAll('applications', [{ id: '1', jobId: 'hr-101', email: 'a@x.in' }, { id: '3', jobId: 'hr-101', email: 'a@x.in' }]), { code: 'ERR_UNIQUE' });
  assert.equal(db.all('applications').length, 1, 'nothing changed');
  db.prepend('applications', { id: '4', jobId: 'hr-102', email: 'a@x.in' });
  db.replaceAll('applications', [{ id: '1', jobId: 'hr-101', email: 'a@x.in', withdrawnAt: '2026-10-01' }, { id: '5', jobId: 'hr-101', email: 'a@x.in' }]);
  assert.equal(db.all('applications').length, 2);
  db.close();
});

test('existing duplicate applications are marked once, keeping the one furthest along', async () => {
  const app = (id, status, createdAt, extra = {}) => ({ id, jobId: 'hr-101', jobTitle: 'Dev', name: 'Asha', email: 'asha@example.in', phone: '9811111111', status, createdAt, notes: '', resume: '', ...extra });
  const dup = await startServer({}, {
    applications: [app('a1', 'New', '2026-09-01'), app('a2', 'Interview', '2026-09-05'), app('a3', 'Screening', '2026-09-07'), app('a4', 'New', '2026-09-08', { withdrawnAt: '2026-09-09' })],
  });
  try {
    const byId = Object.fromEntries(dup.records('applications').map((a) => [a.id, a]));
    assert.equal(byId.a2.duplicateOf, undefined);
    assert.equal(byId.a1.duplicateOf, 'a2');
    assert.equal(byId.a3.duplicateOf, 'a2');
    assert.equal(byId.a4.duplicateOf, undefined, 'withdrawn ones are not counted');
    // Applying again updates the kept application instead of adding one.
    const res = await dup.request('/api/apply', { method: 'POST', body: resumeForm({ jobId: 'hr-101', name: 'Asha', email: 'asha@example.in', phone: '9811111111' }), headers: { accept: 'application/json' } });
    assert.equal(res.status, 200);
    assert.equal(dup.records('applications').length, 4);
    assert.ok(dup.records('applications').find((a) => a.id === 'a2').reapplied);
  } finally {
    dup.stop();
  }
});

test('job addresses carry the title and city, and old ones still work', async () => {
  const jobs = await (await srv.request('/jobs')).text();
  assert.match(jobs, /href="\/jobs\/full-stack-developer-mern-bengaluru-hr-101"/);
  const page = await srv.request('/jobs/full-stack-developer-mern-bengaluru-hr-101');
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<link rel="canonical" href="http:\/\/localhost:\d+\/jobs\/full-stack-developer-mern-bengaluru-hr-101">/);
  assert.match(html, /"url":"http:\/\/localhost:\d+\/jobs\/full-stack-developer-mern-bengaluru-hr-101"/);
  // The bare id still works and points search engines at the full address.
  const bare = await (await srv.request('/jobs/hr-101')).text();
  assert.match(bare, /<link rel="canonical" href="http:\/\/localhost:\d+\/jobs\/full-stack-developer-mern-bengaluru-hr-101">/);
  // An old title moves to the current one, keeping the query.
  const old = await srv.request('/jobs/react-developer-pune-hr-101?utm_source=whatsapp');
  assert.equal(old.status, 301);
  assert.equal(old.headers.get('location'), '/jobs/full-stack-developer-mern-bengaluru-hr-101?utm_source=whatsapp');
  assert.equal((await srv.request('/jobs/something-hr-999')).status, 404);
  assert.match(await (await srv.request('/sitemap.xml')).text(), /\/jobs\/full-stack-developer-mern-bengaluru-hr-101<\/loc>/);
});
