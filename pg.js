// PostgreSQL copy of the jobs data (jobs, locations, categories, skills,
// applications and saved jobs). SQLite stays the source of truth: when
// DATABASE_URL is set, every change is copied here shortly after it's saved,
// and the public jobs API searches these tables. Without DATABASE_URL none of
// this runs.
//
// The schema lives in db/postgres/migrations/*.sql. Pending files are applied
// in order, each in its own transaction, and recorded in schema_migrations.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MIGRATIONS_DIR = path.join(__dirname, 'db', 'postgres', 'migrations');
// Any fixed number: makes two servers starting together migrate one at a time.
const MIGRATION_LOCK = 4826310;

// ---------- migrations ----------
async function migrate(pool, { dir = MIGRATIONS_DIR, log = () => {} } = {}) {
  const files = fs.readdirSync(dir).filter((f) => /^\d+_[\w-]+\.sql$/.test(f)).sort();
  const client = await pool.connect();
  const applied = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await client.query('SELECT version FROM schema_migrations')).rows.map((r) => r.version));
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      if (done.has(version)) continue;
      await client.query('BEGIN');
      try {
        await client.query(fs.readFileSync(path.join(dir, file), 'utf8'));
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        err.message = `Migration ${file} failed: ${err.message}`;
        throw err;
      }
      applied.push(version);
      log(`Postgres: applied migration ${version}`);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => {});
    client.release();
  }
  return applied;
}

// ---------- turning app records into rows ----------
const KINDS = ['office', 'skilled', 'field'];
const KIND_NAMES = { office: 'Office & professional', skilled: 'Skilled & technical', field: 'Industrial, field & service' };
const STATUSES = ['draft', 'pending', 'open', 'paused', 'closed', 'rejected'];
const SHIFTS = ['Day', 'Night', 'Rotational', 'Flexible'];
const PERIODS = ['month', 'year', 'day', 'hour'];

const slugify = (s) => String(s).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'category';
const hashOf = (v) => crypto.createHash('sha1').update(JSON.stringify(v)).digest('hex');
const isoOrNull = (v) => (v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
const dateOrNull = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(Date.parse(v)) ? v : null);
const list = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);
// Letters and digits only, so the text and the query split into the same words
// ("Node.js" → node js, "full-stack" → full stack).
const searchText = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
// "hr-115" → "hr-000000000115", so ids sort as numbers do.
const idSort = (id) => String(id).toLowerCase().replace(/\d+/g, (d) => d.padStart(12, '0'));

// A job's pay, kept only when it passes the table's rules.
function payColumns(pay) {
  if (!pay || !PERIODS.includes(pay.period)) return { min: null, max: null, period: null };
  const ok = (n) => (Number.isFinite(n) && n > 0 && n < 1e10 ? Math.round(n * 100) / 100 : null);
  const min = ok(pay.min);
  const max = ok(pay.max);
  if ((min === null && max === null) || (min !== null && max !== null && min > max)) return { min: null, max: null, period: null };
  return { min, max, period: pay.period };
}

// `d` gives what only the app knows: workOf, groupKeys, stateOf, slugOf,
// monthlyMax, experienceRange, quickApply.
function jobRow(job, d) {
  const pay = payColumns(job.pay);
  let exp = d.experienceRange(job.experience);
  if (exp && !(exp[0] >= 0 && exp[1] >= exp[0] && exp[1] <= 99)) exp = null;
  const status = STATUSES.includes(job.status) ? job.status : 'closed';
  const posted = dateOrNull(job.posted);
  const work = d.workOf(job);
  const monthly = pay.period ? d.monthlyMax({ ...job, pay: { ...pay } }) : null;
  const row = {
    id: String(job.id),
    slug: d.slugOf(job),
    title: String(job.title || '').trim() || 'Untitled job',
    company_name: String(job.company || ''),
    employer_id: job.employerId || null,
    created_by: job.createdBy === 'employer' ? 'employer' : 'team',
    description: String(job.description || ''),
    responsibilities: list(job.responsibilities),
    qualifications: list(job.qualifications),
    benefits: list(job.benefits),
    employment_type: String(job.type || ''),
    work_arrangement: String(job.mode || ''),
    work_kind: KINDS.includes(work) ? work : 'office',
    group_keys: d.groupKeys(job),
    experience_text: String(job.experience || ''),
    experience_min: exp ? exp[0] : null,
    experience_max: exp ? exp[1] : null,
    education: String(job.education || ''),
    schedule: String(job.schedule || ''),
    openings: Number.isInteger(job.openings) && job.openings >= 1 && job.openings <= 9999 ? job.openings : null,
    shift: SHIFTS.includes(job.shift) ? job.shift : '',
    work_hours: String(job.hours || ''),
    workplace_address: String(job.address || ''),
    walk_in: Boolean(job.walkIn),
    eligibility: list(job.eligibility),
    salary_min: pay.min,
    salary_max: pay.max,
    pay_period: pay.period,
    pay_note: String(job.payNote || ''),
    monthly_pay_max: monthly !== null && Number.isFinite(monthly) ? Math.round(monthly * 100) / 100 : null,
    quick_apply: Boolean(d.quickApply(job)),
    status,
    is_sample: job.sample === true,
    posted_on: posted,
    published_at: ['open', 'paused', 'closed'].includes(status) ? isoOrNull(job.approvedAt) || (posted ? `${posted}T00:00:00+05:30` : null) : null,
    closes_on: dateOrNull(job.closesOn),
    created_at: isoOrNull(job.createdAt) || (posted ? `${posted}T00:00:00+05:30` : null),
    id_sort: idSort(job.id),
    // Weighted text: A title, B skills, C company and category, D the rest.
    text_a: searchText(job.title),
    text_b: searchText(list(job.skills).join(' ')),
    text_c: searchText(`${job.company || ''} ${job.category || ''}`),
    text_d: searchText([job.description, ...list(job.responsibilities), ...list(job.qualifications)].join(' ')),
    // Linked rows.
    city: String(job.location || '').trim(),
    state: d.stateOf(job.location) || '',
    category: String(job.category || '').trim(),
    skills: [...new Map(list(job.skills).map((s) => [s.toLowerCase(), s.slice(0, 80)])).values()],
  };
  return { ...row, source_hash: hashOf(row) };
}

// Only a keyed hash of the candidate's email or phone leaves the app.
function applicationRow(a, { candidateHash }) {
  const row = {
    id: String(a.id),
    job_ref: String(a.jobId || 'general'),
    job_id: a.jobId && a.jobId !== 'general' ? String(a.jobId) : null,
    candidate_hash: candidateHash(a),
    status: String(a.status || 'New'),
    source: String(a.source || ''),
    duplicate_of: a.duplicateOf ? String(a.duplicateOf) : null,
    // Withdrawn applications stay out of the one-live-application rule.
    withdrawn_at: isoOrNull(a.withdrawnAt) || (a.withdrawnAt ? new Date(0).toISOString() : null),
    created_at: isoOrNull(a.createdAt),
  };
  return { ...row, source_hash: hashOf(row) };
}

// ---------- the search ----------
// Same filters as the site's search. Keywords use Postgres full-text search:
// every word must start a word in the job (so "dev" finds "developer"),
// ranked title first, then skills, company and category, then the text.
const RANK_WEIGHTS = '{0.1667,0.3333,0.6667,1.0}'; // D, C, B, A, in the 1:2:4:6 ratio of the site's search

// "C++ dev" → "c:* & dev:*"; null when nothing searchable is left (e.g. "C#").
function tsQuery(q, words) {
  const tokens = [...new Set(words(q).flatMap((w) => searchText(w).split(' ')).filter((t) => t.length > 1 || /\d/.test(t)))].slice(0, 12);
  return tokens.length ? tokens.map((t) => `${t}:*`).join(' & ') : null;
}

// Builds the parameterised query. `levels` are the experience levels, from search.js.
function searchSql(f, { page, size, levels, words }) {
  const where = ["j.status = 'open'", 'NOT j.is_sample', "(j.closes_on IS NULL OR j.closes_on >= (now() AT TIME ZONE 'Asia/Kolkata')::date)"];
  const params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  let rank = '1';
  const hasTerms = words(f.q).length > 0;
  if (hasTerms) {
    const tsq = tsQuery(f.q, words);
    if (!tsq) return null;
    const qp = p(tsq);
    where.push(`j.search_vector @@ to_tsquery('simple', ${qp})`);
    rank = `ts_rank('${RANK_WEIGHTS}', j.search_vector, to_tsquery('simple', ${qp}))`;
  }
  if (f.categories && f.categories.length) where.push(`EXISTS (SELECT 1 FROM job_category_assignments a JOIN job_categories c ON c.id = a.category_id WHERE a.job_id = j.id AND c.parent_id IS NOT NULL AND c.name = ANY(${p(f.categories)}::text[]))`);
  if (f.type) where.push(`j.employment_type = ${p(f.type)}`);
  if (f.mode) where.push(`j.work_arrangement = ${p(f.mode)}`);
  if (f.work) where.push(`j.work_kind = ${p(f.work)}`);
  if (f.group) where.push(`${p(f.group)} = ANY(j.group_keys)`);
  if (f.location === 'Remote') where.push("(j.work_arrangement = 'Remote' OR EXISTS (SELECT 1 FROM job_locations l WHERE l.job_id = j.id AND l.city = 'Remote'))");
  else if (f.location) {
    const lp = p(f.location);
    where.push(`EXISTS (SELECT 1 FROM job_locations l WHERE l.job_id = j.id AND (l.city = ${lp} OR l.state = ${lp}))`);
  }
  const level = f.experience && levels.find((l) => l.key === f.experience);
  if (level) where.push(`(j.experience_min IS NULL OR (j.experience_min <= ${p(level.max)} AND j.experience_max >= ${p(level.min)}))`);
  if (f.minPay) where.push(`j.monthly_pay_max >= ${p(f.minPay)}`);
  const sort = ['relevance', 'newest', 'salary'].includes(f.sort) ? f.sort : hasTerms ? 'relevance' : 'newest';
  const newest = 'j.posted_on DESC NULLS LAST, j.id_sort DESC';
  const order = sort === 'relevance' ? `rank DESC, ${newest}` : sort === 'salary' ? `j.monthly_pay_max DESC NULLS LAST, ${newest}` : newest;
  const text = `SELECT j.id, ${rank} AS rank, count(*) OVER () AS total FROM jobs j WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ${p(size)} OFFSET ${p((page - 1) * size)}`;
  return { text, params, sort };
}

// ---------- the mirror ----------
// opts: url (or pool), schema (tests use their own), source() → { jobs,
// applications, savedJobs, categories }, describe (see jobRow, plus
// workOfCategory), candidateHash, levels, words, log.
function create(opts) {
  const { Pool } = require('pg');
  const log = opts.log || (() => {});
  const pool = opts.pool || new Pool({ connectionString: opts.url, max: Number(process.env.PG_POOL_MAX) || 5, connectionTimeoutMillis: 5000 });
  if (opts.schema) {
    const ident = `"${String(opts.schema).replace(/"/g, '""')}"`;
    pool.on('connect', (client) => client.query(`CREATE SCHEMA IF NOT EXISTS ${ident}; SET search_path TO ${ident}`).catch(() => {}));
  }
  // Errors on idle clients (e.g. the database restarting) must not crash the app.
  pool.on('error', (err) => log(`Postgres connection error: ${err.message}`));

  let ready = false;
  let known = null; // what Postgres holds: { jobs: Map(id → hash), applications: Map, saved: Set }
  let running = null;
  let again = false;
  let timer = null;
  let lastError = null;

  async function loadKnown(c) {
    const jobs = new Map((await c.query('SELECT id, source_hash FROM jobs')).rows.map((r) => [r.id, r.source_hash]));
    const applications = new Map((await c.query('SELECT id, source_hash FROM applications')).rows.map((r) => [r.id, r.source_hash]));
    const saved = new Set((await c.query('SELECT candidate_hash, job_id FROM saved_jobs')).rows.map((r) => `${r.candidate_hash}|${r.job_id}`));
    return { jobs, applications, saved };
  }

  // Ids for these names, adding any that are new.
  async function categoryIds(c, names, describe) {
    const ids = new Map();
    for (const kind of KINDS) {
      const r = await c.query(
        `INSERT INTO job_categories (name, slug, work_kind) VALUES ($1, $2, $3)
         ON CONFLICT (slug) DO UPDATE SET name = excluded.name RETURNING id`, [KIND_NAMES[kind], `work-${kind}`, kind]);
      ids.set(`kind:${kind}`, r.rows[0].id);
    }
    for (const name of names) {
      const kind = describe.workOfCategory(name);
      const r = await c.query(
        `INSERT INTO job_categories (name, slug, parent_id, work_kind) VALUES ($1, $2, $3, $4)
         ON CONFLICT (slug) DO UPDATE SET name = excluded.name, parent_id = excluded.parent_id, work_kind = excluded.work_kind RETURNING id`,
        [name, slugify(name), ids.get(`kind:${KINDS.includes(kind) ? kind : 'office'}`), KINDS.includes(kind) ? kind : 'office']);
      ids.set(name, r.rows[0].id);
    }
    return ids;
  }

  async function skillIds(c, names) {
    const ids = new Map();
    if (!names.length) return ids;
    await c.query('INSERT INTO skills (name) SELECT unnest($1::text[]) ON CONFLICT ((lower(name))) DO NOTHING', [names]);
    for (const r of (await c.query('SELECT id, lower(name) AS k FROM skills WHERE lower(name) = ANY($1::text[])', [names.map((n) => n.toLowerCase())])).rows) ids.set(r.k, r.id);
    return ids;
  }

  async function writeJob(c, r, cats, skills) {
    await c.query(
      `INSERT INTO jobs (id, slug, title, company_name, employer_id, created_by, description, responsibilities, qualifications, benefits,
         employment_type, work_arrangement, work_kind, group_keys, experience_text, experience_min, experience_max, education, schedule,
         salary_min, salary_max, pay_period, pay_note, monthly_pay_max, quick_apply, status, is_sample, posted_on, published_at, closes_on,
         created_at, updated_at, id_sort, search_vector, source_hash, openings, shift, work_hours, workplace_address, walk_in, eligibility)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31, now(), $32,
         setweight(to_tsvector('simple', $33), 'A') || setweight(to_tsvector('simple', $34), 'B') || setweight(to_tsvector('simple', $35), 'C') || setweight(to_tsvector('simple', $36), 'D'),
         $37, $38, $39, $40, $41, $42, $43)
       ON CONFLICT (id) DO UPDATE SET slug = excluded.slug, title = excluded.title, company_name = excluded.company_name, employer_id = excluded.employer_id,
         created_by = excluded.created_by, description = excluded.description, responsibilities = excluded.responsibilities, qualifications = excluded.qualifications,
         benefits = excluded.benefits, employment_type = excluded.employment_type, work_arrangement = excluded.work_arrangement, work_kind = excluded.work_kind,
         group_keys = excluded.group_keys, experience_text = excluded.experience_text, experience_min = excluded.experience_min, experience_max = excluded.experience_max,
         education = excluded.education, schedule = excluded.schedule, salary_min = excluded.salary_min, salary_max = excluded.salary_max, pay_period = excluded.pay_period,
         pay_note = excluded.pay_note, monthly_pay_max = excluded.monthly_pay_max, quick_apply = excluded.quick_apply, status = excluded.status, is_sample = excluded.is_sample,
         posted_on = excluded.posted_on, published_at = excluded.published_at, closes_on = excluded.closes_on, created_at = excluded.created_at, updated_at = now(),
         id_sort = excluded.id_sort, search_vector = excluded.search_vector, source_hash = excluded.source_hash, openings = excluded.openings, shift = excluded.shift,
         work_hours = excluded.work_hours, workplace_address = excluded.workplace_address, walk_in = excluded.walk_in, eligibility = excluded.eligibility`,
      [r.id, r.slug, r.title, r.company_name, r.employer_id, r.created_by, r.description, r.responsibilities, r.qualifications, r.benefits,
        r.employment_type, r.work_arrangement, r.work_kind, r.group_keys, r.experience_text, r.experience_min, r.experience_max, r.education, r.schedule,
        r.salary_min, r.salary_max, r.pay_period, r.pay_note, r.monthly_pay_max, r.quick_apply, r.status, r.is_sample, r.posted_on, r.published_at, r.closes_on,
        r.created_at, r.id_sort, r.text_a, r.text_b, r.text_c, r.text_d, r.source_hash, r.openings, r.shift, r.work_hours, r.workplace_address, r.walk_in, r.eligibility]);
    await c.query('DELETE FROM job_locations WHERE job_id = $1', [r.id]);
    if (r.city) await c.query('INSERT INTO job_locations (job_id, city, state, is_remote) VALUES ($1, $2, $3, $4)', [r.id, r.city, r.state, r.city === 'Remote' || r.work_arrangement === 'Remote']);
    await c.query('DELETE FROM job_category_assignments WHERE job_id = $1', [r.id]);
    if (r.category && cats.has(r.category)) await c.query('INSERT INTO job_category_assignments (job_id, category_id) VALUES ($1, $2)', [r.id, cats.get(r.category)]);
    await c.query('DELETE FROM job_skills WHERE job_id = $1', [r.id]);
    const ids = r.skills.map((s) => skills.get(s.toLowerCase())).filter(Boolean);
    if (ids.length) await c.query('INSERT INTO job_skills (job_id, skill_id, position) SELECT $1, s, ord - 1 FROM unnest($2::int[]) WITH ORDINALITY AS t(s, ord)', [r.id, ids]);
  }

  async function writeApplication(c, r) {
    await c.query(
      `INSERT INTO applications (id, job_ref, job_id, candidate_hash, status, source, duplicate_of, withdrawn_at, created_at, updated_at, source_hash)
       VALUES ($1,$2,(SELECT id FROM jobs WHERE id = $3),$4,$5,$6,$7,$8,$9, now(), $10)
       ON CONFLICT (id) DO UPDATE SET job_ref = excluded.job_ref, job_id = excluded.job_id, candidate_hash = excluded.candidate_hash, status = excluded.status,
         source = excluded.source, duplicate_of = excluded.duplicate_of, withdrawn_at = excluded.withdrawn_at, created_at = excluded.created_at,
         updated_at = now(), source_hash = excluded.source_hash`,
      [r.id, r.job_ref, r.job_id, r.candidate_hash, r.status, r.source, r.duplicate_of, r.withdrawn_at, r.created_at, r.source_hash]);
  }

  // Copies whatever changed since the last run, in one transaction.
  async function syncOnce() {
    const data = opts.source();
    const d = opts.describe;
    const c = await pool.connect();
    const stats = { jobs: 0, applications: 0, saved: 0, removed: 0 };
    try {
      await c.query('BEGIN');
      // Serialise writers across servers sharing one database.
      await c.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK + 1]);
      if (!known) known = await loadKnown(c);
      const next = { jobs: new Map(), applications: new Map(), saved: new Set() };

      const jobRows = data.jobs.filter((j) => j && j.id != null).map((j) => jobRow(j, d));
      const changedJobs = jobRows.filter((r) => known.jobs.get(r.id) !== r.source_hash);
      jobRows.forEach((r) => next.jobs.set(r.id, r.source_hash));
      const goneJobs = [...known.jobs.keys()].filter((id) => !next.jobs.has(id));
      if (goneJobs.length) await c.query('DELETE FROM jobs WHERE id = ANY($1::text[])', [goneJobs]);
      if (changedJobs.length) {
        const cats = await categoryIds(c, [...new Set([...data.categories, ...changedJobs.map((r) => r.category)].filter(Boolean))], d);
        const skills = await skillIds(c, [...new Map(changedJobs.flatMap((r) => r.skills).map((s) => [s.toLowerCase(), s])).values()]);
        for (const r of changedJobs) await writeJob(c, r, cats, skills);
      } else if (!ready) {
        await categoryIds(c, data.categories, d);
      }

      const appRows = data.applications.filter((a) => a && a.id).map((a) => applicationRow(a, opts));
      appRows.forEach((r) => next.applications.set(r.id, r.source_hash));
      const goneApps = [...known.applications.keys()].filter((id) => !next.applications.has(id));
      if (goneApps.length) await c.query('DELETE FROM applications WHERE id = ANY($1::text[])', [goneApps]);
      // Rows leaving the "live" set go first, so the one-live-application rule
      // never sees two live rows mid-way.
      const changedApps = appRows.filter((r) => known.applications.get(r.id) !== r.source_hash)
        .sort((x, y) => Number(!(x.withdrawn_at || x.duplicate_of)) - Number(!(y.withdrawn_at || y.duplicate_of)));
      for (const r of changedApps) await writeApplication(c, r);

      for (const s of data.savedJobs) {
        if (!s || !s.jobId || !next.jobs.has(String(s.jobId))) continue;
        next.saved.add(`${opts.candidateHash(s)}|${s.jobId}`);
      }
      const addSaved = [...next.saved].filter((k) => !known.saved.has(k));
      const dropSaved = [...known.saved].filter((k) => !next.saved.has(k));
      const split = (keys) => [keys.map((k) => k.split('|')[0]), keys.map((k) => k.slice(65))];
      if (dropSaved.length) {
        const [h, j] = split(dropSaved);
        await c.query('DELETE FROM saved_jobs s USING unnest($1::text[], $2::text[]) AS t(h, j) WHERE s.candidate_hash = t.h AND s.job_id = t.j', [h, j]);
      }
      if (addSaved.length) {
        const [h, j] = split(addSaved);
        const when = new Map(data.savedJobs.map((s) => [`${opts.candidateHash(s)}|${s.jobId}`, isoOrNull(s.createdAt)]));
        await c.query('INSERT INTO saved_jobs (candidate_hash, job_id, saved_at) SELECT * FROM unnest($1::text[], $2::text[], $3::timestamptz[]) ON CONFLICT DO NOTHING', [h, j, addSaved.map((k) => when.get(k) || null)]);
      }

      await c.query('COMMIT');
      known = next;
      Object.assign(stats, { jobs: changedJobs.length, applications: changedApps.length, saved: addSaved.length + dropSaved.length, removed: goneJobs.length + goneApps.length });
      return stats;
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      known = null; // re-read what Postgres holds next time
      throw err;
    } finally {
      c.release();
    }
  }

  // Runs a sync, or queues one more if a sync is already running.
  function sync() {
    if (running) { again = true; return running; }
    running = (async () => {
      try {
        do {
          again = false;
          const stats = await syncOnce();
          lastError = null;
          if (!ready) log(`Postgres: copied ${stats.jobs} jobs and ${stats.applications} applications`);
          ready = true;
        } while (again);
      } catch (err) {
        if (!lastError || lastError !== err.message) log(`Postgres sync failed (the site keeps working from SQLite): ${err.message}`);
        lastError = err.message;
        again = false;
      } finally {
        running = null;
      }
    })();
    return running;
  }

  return {
    pool,
    async start() {
      await migrate(pool, { log });
      await sync();
      return ready;
    },
    // Called after each save; changes are copied together a moment later.
    changed() {
      clearTimeout(timer);
      timer = setTimeout(sync, 200);
      timer.unref?.();
    },
    // Waits until every change saved so far is in Postgres.
    async flush() {
      if (timer) { clearTimeout(timer); timer = null; await sync(); }
      while (running) await running;
      return !lastError;
    },
    // Up to date and usable for searching.
    usable: () => ready && !lastError,
    // { ids, total, sort }, or null when Postgres can't run this search.
    async search(f, { page, size }) {
      const q = searchSql(f, { page, size, levels: opts.levels, words: opts.words });
      if (!q) return null;
      const { rows } = await pool.query(q.text, q.params);
      return { ids: rows.map((r) => r.id), total: rows.length ? Number(rows[0].total) : await this.count(q, page), sort: q.sort };
    },
    // A page past the end has no rows to carry the total, so count separately.
    async count(q, page) {
      if (page === 1) return 0;
      const text = q.text.replace(/ ORDER BY [\s\S]*$/, '').replace(/^SELECT [\s\S]*? FROM jobs j/, 'SELECT count(*) AS n FROM jobs j');
      const { rows } = await pool.query(text, q.params.slice(0, -2));
      return Number(rows[0].n);
    },
    close: async () => { clearTimeout(timer); while (running) await running; await pool.end(); },
  };
}

module.exports = { create, migrate, jobRow, applicationRow, searchSql, tsQuery, searchText, idSort, payColumns, MIGRATIONS_DIR, KIND_NAMES };
