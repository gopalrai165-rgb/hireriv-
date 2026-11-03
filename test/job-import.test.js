// Bulk job upload: a CSV checked row by row (nothing saved), then the ready
// rows become drafts, or are sent for review; the template works as it is.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');
const { hashPassword } = require('../employers');
const jobImport = require('../job-import');

const EMP = { id: 'emp-old', company: 'Old Co', name: 'Olga Rao', email: 'olga@oldco.in', passwordHash: hashPassword('olga long password'), passwordSetAt: '2026-01-01T00:00:00.000Z', active: true, createdAt: '2026-01-01T00:00:00.000Z' };
let srv; let employer;
before(async () => {
  srv = await startServer({}, { employers: [EMP] });
  employer = srv.cookieFrom(await srv.request('/employer/login', { method: 'POST', form: { email: 'olga@oldco.in', password: 'olga long password' } }));
});
after(() => srv && srv.stop());
const page = async (p, cookie) => (await srv.request(p, { cookie })).text();
const post = (fields, cookie = employer) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return srv.request('/employer/jobs/import', { method: 'POST', cookie, body: fd });
};
const CSV = [
  'Job Title,city,CATEGORY,Description,Responsibilities,Pay from,Pay to,Pay per,Openings,Shift,Favourite colour',
  'Delivery Executive,pune,logistics & operations,Deliver parcels in your area.,"Pick up parcels | Deliver on time, every day",15000,"₹20,000",Monthly,10,day,blue',
  'Telecaller,Mumbai,Customer Support & BPO,"Call customers about offers, in Hindi and English.",Make 80 calls a day',
  'Night Guard,Atlantis,Logistics & Operations,Guard the warehouse.,Patrol,,,,,Night,',
].join('\r\n');

test('the CSV reader: quoted cells, any header case, values matched to the lists', () => {
  assert.deepEqual(jobImport.parseCsv('a,"b, c","d ""e"""\n1,"x\ny",3'), [['a', 'b, c', 'd "e"'], ['1', 'x\ny', '3']]);
  const lists = { categories: ['Logistics & Operations'], locations: ['Pune'], modes: ['On-site'], types: ['Full-time'], shifts: ['Day', 'Night'] };
  const { rows, errors } = jobImport.read(CSV, lists);
  assert.match(errors.join(), /not recognised and will be ignored: Favourite colour/);
  assert.equal(rows.length, 3);
  const r = rows[0].input;
  assert.equal(r.location, 'Pune');
  assert.equal(r.category, 'Logistics & Operations');
  assert.equal(r.shift, 'Day');
  assert.equal(r.salaryMax, '20000');
  assert.equal(r.salaryPeriod, 'month');
  assert.equal(r.responsibilities, 'Pick up parcels\nDeliver on time, every day');
  assert.equal(rows[2].line, 4, 'spreadsheet row numbers');
  assert.match(jobImport.read('Job title,City\nA,Pune', lists).errors.join(), /needs these columns: Category, Description, Responsibilities/);
  const many = ['Job title,City,Category,Description,Responsibilities', ...Array.from({ length: 51 }, () => 'A,Pune,X,D,R')].join('\n');
  assert.match(jobImport.read(many, lists).errors.join(), /up to 50 jobs per file/);
});

test('only members who may create jobs can upload, and the page explains the columns', async () => {
  assert.notEqual((await srv.request('/employer/jobs/import')).status, 200);
  const html = await page('/employer/jobs/import', employer);
  assert.match(html, /Download the template/);
  assert.match(html, /<b>Job title<\/b> \*/);
  assert.match(await page('/employer/jobs', employer), /href="\/employer\/jobs\/import">Upload many \(CSV\)<\/a>/);
  const t = await srv.request('/employer/jobs/import/template.csv', { cookie: employer });
  assert.match(t.headers.get('content-type'), /text\/csv/);
  assert.match(t.headers.get('content-disposition'), /attachment/);
  const cross = await srv.request('/employer/jobs/import', { method: 'POST', cookie: employer, headers: { origin: 'https://evil.example' }, form: { csv: CSV, action: 'create' } });
  assert.equal(cross.status, 403);
});

test('checking a file saves nothing and shows each row\'s problems', async () => {
  const before = srv.records('jobs').length;
  const res = await post({ csv: CSV, action: 'check' });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Checked: 2 of 3 jobs ready/);
  assert.match(html, /Fix in the file/);
  assert.match(html, /pick a location from the list/);
  assert.match(html, /Create 2 jobs/);
  assert.equal(srv.records('jobs').length, before);
});

test('creating makes drafts of the ready rows; "send now" sends them for review', async () => {
  const res = await post({ csv: CSV, action: 'create' });
  const html = await res.text();
  assert.match(html, /2 jobs created as drafts/);
  assert.match(html, /Row 4: Night Guard/);
  const mine = srv.records('jobs').filter((j) => j.employerId === 'emp-old');
  const d = mine.find((j) => j.title === 'Delivery Executive');
  assert.equal(d.status, 'draft');
  assert.equal(d.location, 'Pune');
  assert.deepEqual(d.pay && [d.pay.min, d.pay.max, d.pay.period], [15000, 20000, 'month']);
  assert.equal(Number(d.openings), 10);
  assert.deepEqual(d.responsibilities, ['Pick up parcels', 'Deliver on time, every day']);
  assert.equal(mine.find((j) => j.title === 'Telecaller').status, 'draft');

  const fd = new FormData();
  fd.append('file', new Blob([CSV.split('\r\n').slice(0, 2).join('\r\n')], { type: 'text/csv' }), 'jobs.csv');
  fd.append('action', 'create'); fd.append('sendNow', '1');
  const sent = await (await srv.request('/employer/jobs/import', { method: 'POST', cookie: employer, body: fd })).text();
  assert.match(sent, /1 job created, 1 sent for review/);
  const latest = srv.records('jobs').filter((j) => j.employerId === 'emp-old' && j.title === 'Delivery Executive');
  assert.equal(latest.length, 2);
  assert.ok(latest.some((j) => j.status === 'pending'));
});

test('the template\'s example row is accepted as it is', async () => {
  const t = await (await srv.request('/employer/jobs/import/template.csv', { cookie: employer })).text();
  assert.match(await (await post({ csv: t, action: 'check' })).text(), /Checked: 1 of 1 job ready/);
});
