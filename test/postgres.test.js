// The PostgreSQL copy of the jobs data: migrations, keeping it up to date and
// the jobs API searching it. The database tests run only when
// TEST_DATABASE_URL points at a Postgres you can create schemas in (each run
// uses its own schema and drops it afterwards); the rest always run.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, resumeForm } = require('./helpers');
const pgm = require('../pg');
const search = require('../search');

const DB_URL = process.env.TEST_DATABASE_URL || '';

test('search words become a safe prefix query', () => {
  assert.equal(pgm.tsQuery('Node.js developer', search.words), 'node:* & js:* & developer:*');
  assert.equal(pgm.tsQuery("C++ & dev's | !x", search.words), 'dev:*');
  assert.equal(pgm.tsQuery('C#', search.words), null);
  assert.equal(pgm.tsQuery('3 years', search.words), '3:* & years:*');
  // Nothing a person types can change the query's meaning.
  for (const q of ["a:* | b", "x' OR 1=1 --", '(&|!<->)', 'foo:*A']) {
    const t = pgm.tsQuery(q, search.words);
    assert.ok(t === null || /^([\p{L}\p{N}]+:\* & )*[\p{L}\p{N}]+:\*$/u.test(t), `${q} → ${t}`);
  }
});

test('ids sort the way the site sorts them', () => {
  assert.ok(pgm.idSort('hr-115') > pgm.idSort('hr-99'));
  assert.equal(pgm.idSort('HR-7'), 'hr-000000000007');
});

test('pay that breaks the rules is left out', () => {
  assert.deepEqual(pgm.payColumns({ min: 30000, max: 20000, period: 'month' }), { min: null, max: null, period: null });
  assert.deepEqual(pgm.payColumns({ min: 800, max: null, period: 'day' }), { min: 800, max: null, period: 'day' });
  assert.deepEqual(pgm.payColumns({ min: 5, period: 'week' }), { min: null, max: null, period: null });
});

test('the migration creates the jobs tables with their rules', () => {
  const sql = fs.readFileSync(path.join(pgm.MIGRATIONS_DIR, '001_jobs.sql'), 'utf8');
  for (const t of ['jobs', 'job_locations', 'job_categories', 'job_category_assignments', 'skills', 'job_skills', 'applications', 'saved_jobs']) {
    assert.match(sql, new RegExp(`CREATE TABLE ${t} \\(`), t);
  }
  assert.match(sql, /CHECK \(salary_min IS NULL OR salary_max IS NULL OR salary_min <= salary_max\)/);
  assert.match(sql, /CREATE UNIQUE INDEX applications_one_live ON applications \(job_ref, candidate_hash\)\s+WHERE withdrawn_at IS NULL AND duplicate_of IS NULL/);
  assert.match(sql, /USING GIN \(search_vector\)/);
  // No personal details are copied.
  assert.doesNotMatch(sql, /^\s+(email|phone|candidate_name|candidate_email)\b/m);
});

test('the site keeps working when Postgres is unreachable', async () => {
  const srv = await startServer({ DATABASE_URL: 'postgres://nobody:wrong@127.0.0.1:1/none' });
  try {
    const res = await srv.request('/api/jobs?q=developer');
    assert.equal(res.status, 200);
    assert.ok((await res.json()).total >= 1);
    for (let i = 0; i < 50 && !/Postgres unavailable/.test(srv.output()); i++) await new Promise((r) => setTimeout(r, 100));
    assert.match(srv.output(), /Postgres unavailable \(the site keeps working from SQLite\)/);
    assert.doesNotMatch(srv.output(), /wrong/); // the password is never logged
  } finally {
    await srv.stop();
  }
});

describe('with a Postgres database', { skip: DB_URL ? false : 'set TEST_DATABASE_URL to run these' }, () => {
  const { Pool } = require('pg');
  const schema = `hireriv_test_${process.pid}_${Date.now()}`;
  let db;
  let srv; // with Postgres
  let plain; // without, for comparing results
  let admin;

  const starter = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'jobs.json'), 'utf8')).map((j) => ({ ...j, sample: false }));
  const extra = [
    { id: 'hr-201', title: 'Night Security Guard', company: 'Shield Services', location: 'Thane', mode: 'On-site', type: 'Full-time', category: 'Security Services', experience: 'Freshers welcome', pay: { min: 700, max: 900, period: 'day', currency: 'INR' }, posted: '2026-10-01', skills: ['Patrolling'], description: 'Guard a warehouse at night.' },
    { id: 'hr-202', title: 'Data Analyst', company: 'Insight Co', location: 'Remote', mode: 'Remote', type: 'Contract', category: 'Technology', experience: '10+ years', pay: { min: 1500000, max: 2400000, period: 'year', currency: 'INR' }, posted: '2026-10-01', skills: ['SQL', 'Python'], description: 'Dashboards and models.' },
    { id: 'hr-203', title: 'Hourly Tutor', company: 'Learn Hub', location: 'Pune', mode: 'Hybrid', type: 'Part-time', category: 'Education & Training', experience: '1-2 years', pay: { min: 300, max: null, period: 'hour', currency: 'INR' }, posted: '2026-10-01', skills: [], description: 'Teach maths.' },
    { id: 'hr-204', title: 'Expired Driver Role', company: 'Go Fleet', location: 'Pune', mode: 'Field work', type: 'Full-time', category: 'Delivery & Driving', experience: '', posted: '2026-09-01', closesOn: '2026-09-15', description: 'Too late.' },
    { id: 'hr-205', title: 'Draft Welder', company: 'Steelworks', location: 'Pune', mode: 'On-site', type: 'Full-time', category: 'Skilled Trades', status: 'draft', createdBy: 'employer', employerId: 'e1', posted: '2026-10-02', description: 'Not yet live.' },
    { id: 'hr-206', title: 'Sample Cashier', company: 'Demo', location: 'Pune', mode: 'On-site', type: 'Full-time', category: 'Store & Counter Staff', sample: true, posted: '2026-10-03', description: 'Example only.' },
    { id: 'hr-207', title: 'Bad Pay Clerk', company: 'Oddly', location: 'Delhi', mode: 'On-site', type: 'Full-time', category: 'Administration', pay: { min: 50000, max: 100, period: 'month', currency: 'INR' }, posted: '2026-10-04', description: 'Pay entered backwards.' },
  ];
  const seedJobs = [...starter, ...extra].map((j) => ({ status: 'open', ...j }));
  const applications = [
    { id: 'a1', jobId: 'hr-101', email: 'ravi@example.in', name: 'Ravi', phone: '9800000001', status: 'New', createdAt: '2026-10-05T10:00:00Z' },
    { id: 'a2', jobId: 'hr-101', email: 'ravi@example.in', name: 'Ravi', status: 'New', duplicateOf: 'a1', createdAt: '2026-10-06T10:00:00Z' },
    { id: 'a3', jobId: 'hr-102', phone: '98000 00002', name: 'Sunil', status: 'Screening', withdrawnAt: '2026-10-07T10:00:00Z' },
    { id: 'a4', jobId: 'general', email: 'asha@example.in', name: 'Asha', status: 'New', source: 'account' },
  ];
  const savedJobs = [{ id: 's1', email: 'asha@example.in', jobId: 'hr-101' }, { id: 's2', email: 'asha@example.in', jobId: 'gone-job' }];
  const seed = { jobs: seedJobs, applications, 'saved-jobs': savedJobs };

  const q = async (text, params) => (await db.query(text, params)).rows;
  const api = async (server, query) => {
    const res = await server.request(`/api/jobs${query}`);
    assert.equal(res.status, 200, query);
    return res.json();
  };
  // Postgres catches up a moment after each save.
  async function until(check, ms = 5000) {
    for (const end = Date.now() + ms; ; await new Promise((r) => setTimeout(r, 50))) {
      const v = await check();
      if (v) return v;
      if (Date.now() > end) throw new Error('Postgres did not catch up');
    }
  }

  before(async () => {
    db = new Pool({ connectionString: DB_URL, max: 2 });
    db.on('connect', (c) => c.query(`SET search_path TO "${schema}"`));
    [srv, plain] = await Promise.all([startServer({ DATABASE_URL: DB_URL, PG_SCHEMA: schema }, seed), startServer({}, seed)]);
    admin = await srv.adminLogin();
    await until(async () => (await db.query("SELECT to_regclass('jobs') AS t")).rows[0].t && (await q('SELECT count(*)::int AS n FROM jobs'))[0].n === seedJobs.length);
  });
  after(async () => {
    await Promise.all([srv && srv.stop(), plain && plain.stop()]);
    if (db) {
      await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
      await db.end();
    }
  });

  test('the migrations are recorded once and the tables are filled', async () => {
    assert.deepEqual((await q('SELECT version FROM schema_migrations ORDER BY version')).map((r) => r.version), ['001_jobs', '002_employer_jobs', '003_ats']);
    const [j] = await q("SELECT * FROM jobs WHERE id = 'hr-201'");
    assert.equal(j.slug, 'night-security-guard-thane-hr-201');
    assert.equal(j.pay_period, 'day');
    assert.equal(Number(j.monthly_pay_max), 900 * 26);
    assert.equal(j.salary_currency, 'INR');
    assert.equal(Number(j.experience_min), 0);
    assert.equal(j.work_kind, 'field');
    assert.deepEqual([j.openings, j.shift, j.walk_in, j.eligibility], [null, '', false, []]);
    const [loc] = await q("SELECT city, state FROM job_locations WHERE job_id = 'hr-201'");
    assert.deepEqual(loc, { city: 'Thane', state: 'Maharashtra' });
    const cats = await q("SELECT c.name, p.name AS parent FROM job_category_assignments a JOIN job_categories c ON c.id = a.category_id JOIN job_categories p ON p.id = c.parent_id WHERE a.job_id = 'hr-101'");
    assert.deepEqual(cats, [{ name: 'Technology', parent: 'Office & professional' }]);
    const skills = await q("SELECT s.name FROM job_skills js JOIN skills s ON s.id = js.skill_id WHERE js.job_id = 'hr-101' ORDER BY js.position");
    assert.deepEqual(skills.map((s) => s.name), ['React', 'Node.js', 'MongoDB', 'AWS']);
    // Backwards pay is dropped rather than breaking the copy.
    const [bad] = await q("SELECT salary_min, pay_period FROM jobs WHERE id = 'hr-207'");
    assert.deepEqual(bad, { salary_min: null, pay_period: null });
  });

  test('applications and saved jobs carry no personal details', async () => {
    const apps = await q('SELECT * FROM applications ORDER BY id');
    assert.deepEqual(apps.map((a) => a.id), ['a1', 'a2', 'a3', 'a4']);
    const text = JSON.stringify(apps) + JSON.stringify(await q('SELECT * FROM saved_jobs'));
    for (const s of ['ravi', 'Ravi', 'example.in', '9800000001', '0000002', 'Asha', 'asha']) assert.ok(!text.includes(s), s);
    const by = Object.fromEntries(apps.map((a) => [a.id, a]));
    assert.equal(by.a1.candidate_hash, by.a2.candidate_hash);
    assert.equal(by.a2.duplicate_of, 'a1');
    assert.ok(by.a3.withdrawn_at);
    assert.equal(by.a4.job_ref, 'general');
    assert.equal(by.a4.job_id, null);
    // Saved jobs for jobs that no longer exist aren't copied.
    assert.deepEqual((await q('SELECT job_id FROM saved_jobs')).map((r) => r.job_id), ['hr-101']);
  });

  test('the database itself refuses a second live application and bad pay', async () => {
    const [a1] = await q("SELECT candidate_hash FROM applications WHERE id = 'a1'");
    await assert.rejects(
      db.query("INSERT INTO applications (id, job_ref, job_id, candidate_hash, status, source_hash) VALUES ('x1', 'hr-101', 'hr-101', $1, 'New', '-')", [a1.candidate_hash]),
      /applications_one_live/);
    await db.query("INSERT INTO applications (id, job_ref, candidate_hash, status, withdrawn_at, source_hash) VALUES ('x2', 'hr-101', $1, 'New', now(), '-')", [a1.candidate_hash]);
    await db.query("DELETE FROM applications WHERE id = 'x2'");
    await assert.rejects(db.query("UPDATE jobs SET salary_min = 90000 WHERE id = 'hr-201'"), /check constraint/);
  });

  test('the jobs API gives the same results from Postgres as the built-in search', async () => {
    const queries = [
      '', '?page=2&limit=5', '?location=Maharashtra', '?location=Pune', '?location=Remote', '?category=Technology&category=Delivery%20%26%20Driving',
      '?employmentType=full_time', '?workArrangement=hybrid', '?work=field', '?work=office&sort=salary', '?group=freshers', '?group=it-engineering',
      '?experience=fresher', '?experience=senior', '?experience=mid&location=Bengaluru', '?minPay=30000', '?minPay=20000&sort=salary', '?sort=salary',
      '?sort=newest', '?q=react', '?q=developer', '?q=warehouse%20supervisor', '?q=driver&location=Pune', '?q=sql%20python', '?q=nothingmatchesthis',
      '?page=99',
    ];
    for (const query of queries) {
      const [a, b] = await Promise.all([api(srv, query), api(plain, query)]);
      assert.deepEqual({ total: a.total, pages: a.pages, sort: a.sort, ids: a.jobs.map((j) => j.id) }, { total: b.total, pages: b.pages, sort: b.sort, ids: b.jobs.map((j) => j.id) }, query);
      // Each server has its own address; everything else matches.
      const local = (list) => list.map((j) => ({ ...j, url: new URL(j.url).pathname }));
      assert.deepEqual(local(a.jobs), local(b.jobs), query);
    }
    // Drafts, samples and closed jobs never come back.
    const all = await api(srv, '?limit=50');
    for (const id of ['hr-204', 'hr-205', 'hr-206']) assert.ok(!all.jobs.some((j) => j.id === id), id);
  });

  test('Postgres answers the keyword search (whole-word prefixes)', async () => {
    // The built-in search also matches inside words; Postgres matches word starts.
    assert.equal((await api(plain, '?q=eloper')).total, (await api(plain, '?q=developer')).total);
    assert.equal((await api(srv, '?q=eloper')).total, 0);
    assert.ok((await api(srv, '?q=dev')).total >= 1);
    // A search Postgres can't express still works.
    assert.deepEqual((await api(srv, '?q=C%23')).jobs.map((j) => j.id), (await api(plain, '?q=C%23')).jobs.map((j) => j.id));
  });

  test('changes on the site reach Postgres', async () => {
    // Closing a job.
    await srv.request('/admin/jobs/hr-201/toggle', { method: 'POST', cookie: admin });
    await until(async () => (await q("SELECT status FROM jobs WHERE id = 'hr-201'"))[0].status === 'closed');
    assert.ok(!(await api(srv, '?q=security')).jobs.some((j) => j.id === 'hr-201'));

    // Deleting one.
    await srv.request('/admin/jobs/hr-207/delete', { method: 'POST', cookie: admin });
    await until(async () => !(await q("SELECT 1 FROM jobs WHERE id = 'hr-207'")).length);

    // A new application, then the same person again (updates, not a second row).
    const apply = (fields) => srv.request('/api/apply', { method: 'POST', body: resumeForm(fields), headers: { accept: 'application/json' } });
    await apply({ jobId: 'hr-102', name: 'Neha Rao', email: 'neha@example.in', phone: '9811111111', skills: 'Excel' });
    await apply({ jobId: 'hr-102', name: 'Neha Rao', email: 'NEHA@example.in', phone: '9811111111', skills: 'Excel, SQL' });
    const id = srv.records('applications').find((a) => a.email.toLowerCase() === 'neha@example.in').id;
    const [row] = await until(async () => q('SELECT * FROM applications WHERE id = $1', [id]).then((r) => r.length && r));
    assert.equal(row.job_id, 'hr-102');
    assert.equal((await q("SELECT count(*)::int AS n FROM applications WHERE job_ref = 'hr-102' AND candidate_hash = $1", [row.candidate_hash]))[0].n, 1);

    // The status moving along.
    await srv.request(`/admin/applications/${id}/status`, { method: 'POST', cookie: admin, form: { status: 'Interview' } });
    await until(async () => (await q('SELECT status FROM applications WHERE id = $1', [id]))[0].status === 'Interview');
    // The stage history is copied without names.
    const [h] = await until(async () => q('SELECT * FROM application_stage_history WHERE application_id = $1', [id]).then((r) => r.length && r));
    assert.deepEqual([h.seq, h.from_stage, h.to_stage, h.actor_kind, h.is_correction], [0, 'New', 'Interview', 'team', false]);
    assert.equal(Object.keys(h).some((k) => /name|by|email/.test(k)), false);
  });
});
