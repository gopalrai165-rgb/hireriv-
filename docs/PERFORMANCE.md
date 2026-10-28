# Performance and capacity

How Hireriv was load tested, what was slow, what changed and what is left.
Re-run the test after any change to search, the job list, the homepage or the
admin pages, and on the real host before launch (docs/LAUNCH.md, area 11).

## 1. How to run it

```bash
npm run load:test                                   # 5,000 jobs, 50,000 applications, 20 at a time
JOBS=10000 APPS=100000 CONCURRENCY=50 SECONDS=15 npm run load:test
ONLY=jobs,search npm run load:test                  # some pages only
PROFILE=1 ONLY=home CONCURRENCY=2 npm run load:test # plus the functions using the most CPU
LOAD_TEST_OUT=results.json npm run load:test        # also save the numbers
```

`scripts/load-test.js` builds a throwaway database (your `data/` is never
touched), starts the real server on it with compiled templates cached as in
production (`VIEW_CACHE=1`), waits for the start-up checks to finish, then
sends each page from many connections at once for a few seconds and reports
requests per second and response times (p50, p95, p99). With `PROFILE=1` the
server runs with the Node inspector and each page lists the app functions
using the most CPU, with SQLite and other built-ins counted against the code
that called them.

All requests come from one address, so per-visitor rate limits answer some
of them with 429 (search suggestions allow 240 a minute): those are the
limits working, not errors.

## 2. Results

Measured on 2026-10-27 on a laptop (AMD Ryzen 7 4700U, 8 cores, Node 24, one
server process), 5,000 live jobs, 50,000 applications, 20,000 job seekers,
20,000 saved jobs, 20 requests at a time. Times are what a visitor waits
while 19 other requests are being served.

| Page | Before: req/s | Before: p50 | After: req/s | After: p50 | After: p95 |
|---|---:|---:|---:|---:|---:|
| Homepage `/` | 10 | 28.8 s | 161 | 117 ms | 158 ms |
| Job list `/jobs` | 15 | 1.96 s | 54 | 374 ms | 433 ms |
| Keyword search `/jobs?q=` | 14 | 2.17 s | 34 | 580 ms | 647 ms |
| City filter `/jobs?location=` | 38 | 597 ms | 101 | 191 ms | 256 ms |
| Jobs near a PIN code | 15 | 2.04 s | 59 | 329 ms | 404 ms |
| One job `/jobs/:id` | 129 | 156 ms | 325 | 57 ms | 92 ms |
| City page `/jobs/in/:city` | 69 | 268 ms | 227 | 76 ms | 119 ms |
| Search suggestions `/api/suggest` | 51 | 430 ms | 1,014 | 19 ms | 26 ms |
| Sitemap | 82 | 252 ms | 81 | 241 ms | 303 ms |
| Admin dashboard | 5 | 71.8 s | 26 | 700 ms | 882 ms |
| Admin applications list | failed | — | 39 | 501 ms | 568 ms |

"Before" is the code at Step 73, "after" Step 74 and, for the admin rows,
Step 75 (at Step 74 they were 5.5 s and 3.8 s). The admin rows are 20 staff
loading the heaviest page at the same moment; one person opening it waits
65 ms (dashboard) or 34 ms (applications).

## 3. What was slow, and what changed

Each fix gives exactly the old answer (`test/performance.test.js` checks the
less obvious ones against the slow version).

1. **The trust scan froze the server.** Every 10 minutes, and two seconds
   after start, each live listing was compared with every other one (exact
   copies and near-copies), and its risk assessment was looked up by
   scanning every assessment: tens of seconds at 5,000 jobs, with every
   request waiting. Now exact copies are grouped by fingerprint once per
   scan, near-copies are found by prefix filtering (`risk.nearIndex`: two
   listings that are 80% the same must share one of the rarest word triples
   at the start of each, so only those are compared), and a scan whose
   inputs have not changed since the last one skips the listings entirely.
2. **Lookups by field read whole collections.** SQLite chose the
   `(collection, pos)` index to avoid sorting, so even the indexed `rk` and
   `status` lookups read every document. `db.where` now orders by `+pos` for
   indexed fields, uses the primary key for `id`, and `employerId`,
   `entityId` and `jobId` have indexes too (72 times faster on 3,000
   assessments).
3. **India dates built a formatter every time.** `toLocaleDateString` with a
   time zone was called once per application on the dashboard and reports.
   India is UTC+05:30 all year, so `ics.istDay` is arithmetic now.
4. **Sorting built a collator per comparison** (`localeCompare` with
   options). One shared `Intl.Collator`, and dates compared as text.
5. **Search normalised every job on every search.** Each job's lower-cased
   text is kept until its words change.
6. **The homepage ran 12 searches per view** for the popular-role counts.
   Those counts, the city and group counts and the suggestion word list are
   kept until the jobs are saved again or a minute passes.
7. **Filter counts copied an object per job** (`{ ...n }` inside a reduce).
8. **Admin pages matched skills and found the job for all 50,000
   applications** on every view. The skill match is worked out for the 50
   rows on screen (or all, only when sorting by it), jobs are found by id
   from an index, and the 14-day chart reads only the last 15 days.
9. **Admin pages parsed every application per view.** They share one
   parsed, frozen copy (`db.snapshot`) until the applications change.
10. **Admin pages counted every application several times per view** (Step
    75), and the tab counts read every submission list in full just to count
    it. The counts by stage, job, day and person, the résumés not read yet
    and the applications with interviews are now worked out in one pass
    (`app-totals.js`) the first time a page asks after the applications
    change, and shared until the next change; the tab counts come from
    SQLite (`db.count`).

## 4. What is left

- **The first admin view after an application changes** reads the
  applications again and recounts them: about 0.3 s at 50,000 (0.2 s to
  read, 0.1 s to count), once per change, not per view. Past a few hundred
  thousand applications, or with applications changing every second, the
  counts should be updated with each write or moved to the PostgreSQL copy.
  The talent search and CSV exports still go through every application, as
  they must.
- **One process.** Everything runs in one Node process with SQLite, so the
  numbers above are the whole site's capacity on that machine: roughly 50 to
  300 page views a second depending on the page, which is far above what a
  new job site sees (a busy day of 50,000 visitors is under 5 a second on
  average). Rate limits and security counters are per process.
- **Job search scans every live job** (about 15 ms of CPU at 5,000). The
  optional PostgreSQL search (`DATABASE_URL`) is the next step past tens of
  thousands of live jobs.
- **The first scan after a restart** checks every listing once (a few
  seconds at 5,000 jobs) before the server settles.
- **The real host** has not been measured. Run `npm run load:test` there
  (or against a copy of the live database size) before going wide, and
  write the numbers here.

## 4. Smaller downloads (Step 94)

Pages, API answers and other text are sent compressed (`compress.js`, no
library: zstd, Brotli and gzip are built into Node 24). Each answer uses the
best encoding the browser offers: zstd at a fast level for pages made on each
request, Brotli at its best level for the CSS and JS, which are compressed
once and kept in memory. Answers under 1 KB, files, downloads and anything
marked `no-transform` are sent as they are. `COMPRESSION=off` turns it off
when a proxy or CDN in front already compresses.

| What | Plain | Compressed |
|---|---:|---:|
| Homepage HTML | 64.6 KB | 14.8 KB (zstd) |
| `style.css` | 149.6 KB | 25.0 KB (Brotli) |
| `main.js` | 42.8 KB | 11.2 KB (Brotli) |

CSS and JS asked for with their fingerprint (`?v=`, which changes with every
change to them) are cached by browsers for a year (`immutable`), so a return
visit downloads neither. Pages also send `103 Early Hints` naming the
stylesheet, so the browser fetches it while the server is still making the
page (`EARLY_HINTS=off` turns it off).
