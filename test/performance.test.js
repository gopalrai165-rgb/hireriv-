// Performance work (Step 74): each faster path gives exactly the answer of
// the slow one it replaced. scripts/load-test.js measures the speed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const risk = require('../risk');
const { istDay } = require('../ics');

// A small seeded random generator, so failures can be replayed.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

test('the near-copy index finds exactly the pairs comparing every pair finds', () => {
  const rand = rng(42);
  const vocab = Array.from({ length: 60 }, (_, i) => `w${i}`);
  const base = Array.from({ length: 25 }, () => Array.from({ length: 40 }, () => vocab[Math.floor(rand() * vocab.length)]));
  const listings = [];
  for (let i = 0; i < 300; i++) {
    // Variants of a few base texts with some words changed: many near pairs, many not.
    const words = base[Math.floor(rand() * base.length)].map((w) => (rand() < 0.04 + (i % 5) * 0.03 ? vocab[Math.floor(rand() * vocab.length)] : w));
    const job = { id: `j${i}`, title: '', description: words.join(' ') };
    listings.push({ id: job.id, shingles: risk.shingles(job) });
  }
  const pool = risk.nearIndex(listings);
  let pairs = 0;
  for (const a of listings) {
    const brute = listings.filter((o) => o !== a && risk.similarity(a.shingles, o.shingles) >= risk.NEAR_DUPLICATE).map((o) => o.id).sort();
    const fast = pool(a.shingles).filter((o) => o !== a && risk.similarity(a.shingles, o.shingles) >= risk.NEAR_DUPLICATE).map((o) => o.id).sort();
    assert.deepEqual(fast, brute, a.id);
    pairs += brute.length;
  }
  assert.ok(pairs > 50, `the data should have near copies (${pairs})`);
});

test('India dates by arithmetic match the time-zone formatter', () => {
  const rand = rng(7);
  const slow = (t) => new Date(t).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const edges = ['2026-10-27T18:29:59.999Z', '2026-10-27T18:30:00.000Z', '2024-02-28T18:30:00Z', '2025-12-31T18:29:59Z', '2025-12-31T18:30:00Z'];
  for (const t of edges) assert.equal(istDay(t), slow(t), t);
  for (let i = 0; i < 2000; i++) { const t = Math.floor(1.6e12 + rand() * 3e11); assert.equal(istDay(t), slow(t)); }
  assert.equal(istDay('not a date'), slow('not a date'));
});

test('lookups by id and by indexed fields: same documents, and the index is used', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hireriv-perf-'));
  const file = path.join(dir, 't.db');
  const store = require('../db').open(file);
  const docs = Array.from({ length: 500 }, (_, i) => ({ id: i % 7 === 0 ? i : `d${i}`, entityId: `e${i % 50}`, jobId: `job${i % 9}`, employerId: i % 3 ? 'emp1' : 'emp2', title: `t${i % 4}` }));
  store.replaceAll('things', docs);
  store.replaceAll('site', [{ name: 'no id' }]);
  const scan = (field, value) => docs.filter((d) => d[field] === value);
  assert.deepEqual(store.where('things', 'id', 'd5'), scan('id', 'd5'));
  assert.deepEqual(store.where('things', 'id', 14), scan('id', 14), 'numeric ids');
  assert.deepEqual(store.where('things', 'id', 'missing'), []);
  assert.deepEqual(store.where('site', 'id', '#0'), [], 'a positional key is not an id');
  for (const [f, v] of [['entityId', 'e3'], ['jobId', 'job2'], ['employerId', 'emp2'], ['title', 't1']]) assert.deepEqual(store.where('things', f, v), scan(f, v), f);
  assert.deepEqual(store.where('things', 'entityId', 'e3', { limit: 2, offset: 1 }), scan('entityId', 'e3').slice(1, 3), 'list order, limit and offset');
  store.close();
  const raw = new DatabaseSync(file);
  for (const f of ['entityId', 'jobId', 'employerId', 'rk', 'status']) {
    const plan = raw.prepare(`EXPLAIN QUERY PLAN SELECT data FROM records WHERE collection = ? AND json_extract(data, '$.${f}') = ? ORDER BY +pos LIMIT ? OFFSET ?`).all('things', 'x', -1, 0).map((r) => r.detail).join(' ');
    assert.match(plan, new RegExp(`USING INDEX records_${f}`), plan);
  }
  raw.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('application totals match counting every application, and are kept until the list changes', () => {
  const { totals } = require('../app-totals');
  const interviews = require('../interviews');
  const rand = rng(7);
  const stages = ['New', 'Screening', 'Shortlisted', 'Interview', 'Offered', 'Hired', 'On hold', 'Rejected', undefined];
  const now = Date.now();
  const apps = Array.from({ length: 2000 }, (_, i) => ({
    id: `a${i}`,
    jobId: `job${Math.floor(rand() * 40)}`,
    email: `p${Math.floor(rand() * 900)}@x.in`.replace(/^p1/, 'P1'),
    status: stages[Math.floor(rand() * stages.length)],
    createdAt: i % 97 === 0 ? 'not a date' : new Date(now - rand() * 30 * 86400000).toISOString(),
    resume: rand() < 0.3 ? 'cv.pdf' : '',
    ...(rand() < 0.5 ? { resumeText: 'text' } : {}),
    interviews: rand() < 0.1 ? [{ id: `iv${i}`, status: 'scheduled', at: new Date(now + (rand() - 0.5) * 20 * 86400000).toISOString(), duration: 30, feedback: [] }] : [],
  }));
  Object.freeze(apps);
  const t = totals(apps);
  const statusOf = (a) => a.status || 'New';
  for (const s of stages.filter(Boolean)) assert.equal(t.count(s), apps.filter((a) => statusOf(a) === s).length, s);
  assert.equal(t.count('Withdrawn'), 0);
  assert.equal(t.total, apps.length);
  assert.equal(t.people, new Set(apps.map((a) => String(a.email).toLowerCase())).size);
  assert.equal(t.unreadResumes, apps.filter((a) => a.resume && a.resumeText === undefined).length);
  const perJob = {};
  for (const a of apps) perJob[a.jobId] = (perJob[a.jobId] || 0) + 1;
  assert.deepEqual({ ...t.perJob }, perJob);
  const byDay = {};
  for (const a of apps) if (!Number.isNaN(Date.parse(a.createdAt))) byDay[istDay(a.createdAt)] = (byDay[istDay(a.createdAt)] || 0) + 1;
  assert.deepEqual({ ...t.byDay }, byDay);
  for (const days of [0, 1, 7, 14, 40]) {
    const since = now - days * 86400000;
    assert.equal(t.since(since), apps.filter((a) => new Date(a.createdAt) >= since).length, `${days} days`);
  }
  assert.deepEqual(interviews.upcoming(t.withInterviews), interviews.upcoming(apps));
  assert.deepEqual(interviews.feedbackDue(t.withInterviews), interviews.feedbackDue(apps));
  assert.deepEqual(interviews.allInterviews(t.withInterviews), interviews.allInterviews(apps));
  assert.equal(totals(apps), t, 'the same list is not counted twice');
  assert.notEqual(totals(Object.freeze(apps.slice(1))), t, 'a new list after a change is counted again');
});
