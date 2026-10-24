# Hireriv platform audit

Date: 24 October 2026 · Codebase at Step 39 · Scope: the "all-industry recruitment and staffing platform" plan (Step 1: audit before building)

No production code or database was changed for this audit. It added this file, [ACCESS.md](ACCESS.md) (every route and who may use it) and `test/access.test.js`, which keeps ACCESS.md in step with the code and checks that every protected route turns away people without the right sign-in or role.

## 1. Planned stack vs what exists

| Layer | Plan | Hireriv today |
| --- | --- | --- |
| Frontend | React / Next.js | Server-rendered EJS pages with a small `public/js/main.js`. Every page is SEO-ready already (Google for Jobs data, sitemap, share images) |
| Backend | Node.js, Express or NestJS | Node.js 22 + Express 4 |
| Database | PostgreSQL | SQLite through Node's built-in `node:sqlite` (`db.js`), with JSON documents grouped by collection, transactions, daily verified backups |
| File storage | Private object storage | `uploads/` on the server's disk, served only through signed-in routes |
| Search | Postgres full-text | In-memory filtering and ranking (`match.js`), including resume text |
| Auth | Secure sessions/tokens | Server-side sessions (hashed tokens) for team, clients and candidates; scrypt passwords; two-step sign-in for the team |

**Recommendation: keep the current stack, and don't rewrite to Next.js + PostgreSQL now.** The plan's own rule is "reuse completed features instead of rebuilding working dashboards", and 39 tested steps already cover most of it. A rewrite would take months to get back to where the site is today. SQLite on one server comfortably handles a staffing business's volume (hundreds of thousands of applications).

Revisit PostgreSQL only when one of these becomes true: the site needs **more than one app server** (the rate-limit and lock-out counters live in memory today and aren't shared), a separate mobile app or partner API needs heavy concurrent writes, or reporting needs SQL across very large tables. All storage goes through `db.js`, so the change is contained, but it's a real redesign, because records are stored as JSON documents rather than relational tables.

## 2. Planned entities vs current storage

| Plan entity | Where it lives now | Notes |
| --- | --- | --- |
| users | `team` (staff), `employers` (client logins). Candidates have no account record | Candidates are identified by the email they applied with; sign-in is by emailed link |
| candidate_profiles | Fields on each `applications` record; the Talent pool merges them by email | Profile edits in My applications update every application |
| employer_profiles | `employers` (company, contact, status) | No verification status (clients are added by the team) |
| recruiter_profiles | `team` (name, email, role Admin/Recruiter, two-step) | |
| jobs | `jobs` | Category, location, work mode, type, experience and salary (free text), skills, closing date, owner, client |
| applications | `applications` with `stageHistory`, `interviews`, `shared`, `feedback` | |
| resumes | Files in `uploads/`; extracted text on the application | |
| interviews | Inside each application (`interviews[]`) with scorecards | |
| staffing_requests | `hire-requests` (public /hire form and client-portal requirements both land here) | Not duplicated |
| audit_logs | `activity` (newest 2,000 kept) | Every admin change, sign-ins, two-step events, retention clean-ups |
| Not in the plan | `placements` (invoices, payments, credit notes, refunds, timesheets), `email-templates`, `posts`, `site`, `job-alerts`, `newsletter`, `contacts` | |

## 3. Planned sections vs current routes

| Plan section | Planned route | Exists as | Status |
| --- | --- | --- | --- |
| Home | `/` | `/` | Done |
| Find Jobs | `/jobs` | `/jobs`, `/jobs/:id`, `/saved` | Partly: keyword, category, location and work-mode filters; **no salary, experience or job-type filters** |
| Staffing & Recruitment | `/staffing-solutions` | `/services`, `/services/:slug`, `/industries` | Done under a different path; **no payroll service page** |
| Employer Portal | `/employers` | `/employer` (client portal) + `/hire` (public form) | Partly: invite-only, so **clients can't sign up or post jobs directly**; they send requirements |
| Candidate Portal | `/candidate/dashboard` | `/account` | Partly: applications, interviews, profile, timesheets, data download/delete; **no account before applying; saved jobs stay on one device** |
| Recruiter Portal | `/recruiter/dashboard` | `/admin` with the Recruiter role | Done (ownership, "Mine" filters, no billing) |
| Admin Panel | `/admin` | `/admin` | Done; job approval isn't needed while only the team posts jobs |

Changing these paths isn't recommended, since links are indexed and shared. If the planned names are wanted for marketing, add redirects (e.g. `/staffing-solutions` → `/services`).

## 4. Roles and permissions

Full matrix: [ACCESS.md](ACCESS.md) (141 routes, each with its access policy, checked by tests).

| Can… | Visitor | Candidate | Client | Recruiter | Admin |
| --- | :-: | :-: | :-: | :-: | :-: |
| Search and apply for jobs, send hiring requests | ✓ | ✓ | ✓ | ✓ | ✓ |
| See own applications, interviews, timesheets; download/delete own data | | ✓ | | | |
| See own roles, shared candidates, placements, invoices; approve timesheets | | | ✓ | | |
| Jobs, candidates, interviews, shortlists, clients, templates, blog, record placements | | | | ✓ | ✓ |
| Invoices, payments, billing totals, settings, team, activity log, backups, deletions | | | | | ✓ |

Checks found nothing wrong: every team route requires a team sign-in, every Admin-only route answers 403 to Recruiters, and candidate and client data is limited to their own records (by email or company id, never by guessable ids). Three rules sit inside handlers rather than on routes (the Settings, Team and Activity tabs, money in report CSVs, and the placements/activity exports); the tests cover those directly.

## 5. Coverage of the all-industry plan

**Office & professional jobs:** well covered. There are 16 job categories (Technology, Finance, BFSI, Sales, Marketing, HR, Legal, Education, Healthcare, Engineering, Admin…), Remote/Hybrid modes, and executive search.

**Skilled, industrial, field and service jobs: mostly missing.** Job categories have no separate home for factory and production, warehouse, delivery and driving, skilled trades, security, housekeeping and facilities, food and hospitality staff, domestic staff or agriculture. These are lumped into Logistics, Engineering & Manufacturing or Hospitality. The bigger blocker is the apply form: **an uploaded resume and an email address are both required**, and candidates sign in only by email. Many applicants for these jobs have neither and apply by phone or WhatsApp. The site is English-only.

**Employment types:** Full-time, Contract, Part-time and Internship. Missing: Temporary, Gig or daily wage, Apprenticeship, Walk-in. Salary is free text, so it can't be filtered or shown per day or per hour.

**Other categories in the plan:** domestic staffing, gig work, international recruitment and government-jobs information don't exist. International recruitment from India needs a recruiting-agent registration under the Emigration Act, 1983 before any overseas job is advertised. A government-jobs section needs a source-verification process and a clear "not affiliated with the government" notice.

**Duplicates:** none found that need fixing. Public hiring requests and client-portal requirements already share one inbox, and candidates are merged by email in the Talent pool.

**Other risks:**
- Rate limits and the sign-in lock-out are counted in memory. That's fine on one server, but the counts reset on restart and aren't shared if the site ever runs on several.
- Two-step sign-in keys are stored unencrypted in the database, so backups need to be kept as private as the database.
- Saved jobs live in the visitor's browser only.

## 6. Prioritised backlog

Each item keeps what exists working and adds to it. Size: S ≈ one step, M ≈ two, L ≈ three or more.

| # | Item | Why | Size |
| --- | --- | --- | --- |
| 1 | ✅ **Done in Step 42.** **Easy applying for skilled and field jobs**: per-job "resume not needed" (default for skilled and field categories), email optional when a phone number is given, a 4-field quick apply, and a WhatsApp "apply by message" link | Without this, hiring for skilled and field jobs can't work | M |
| 2 | ✅ **Done in Step 41.** **Job taxonomy**: skilled and field categories (Factory & Production, Warehouse, Delivery & Driving, Skilled Trades, Construction, Security, Facility & Housekeeping, Food & Hospitality, Domestic Staff, Agriculture); job types Temporary, Gig/Daily wage, Apprenticeship, Walk-in; a "kind of work" tag (Office & professional, Skilled & technical, Industrial, field & service) | Lets jobs be posted and found properly | S |
| 3 | ✅ **Done in Step 45.** **Structured pay + better search**: salary min/max per month, day or hour (existing text converted automatically), and filters for pay, experience, job type and kind of work | The plan's "search by salary and experience" | M |
| 4 | **Services and industries**: Payroll & compliance service page, industry desks for skilled and field work (the `/staffing-solutions` redirect was done in Step 43) | Matches the planned offer | S |
| 5 | **Hindi** for the public site, the apply form and candidate emails | Reaches field-work and non-metro candidates | L |
| 6 | ✅ **Done in Steps 44 and 45** (saved jobs follow the account from Step 45). **Candidate accounts before applying**: profile + resume once, one-click apply, saved jobs and job alerts in the dashboard | The planned candidate dashboard | M |
| 7 | ✅ **Done in Step 47** (hiring analytics still to come). **Client self-signup** with verification (work email + GSTIN), direct job posting held for Admin approval, and hiring analytics in the client portal | The planned employer portal | L |
| 8 | **Phone sign-in by OTP** (SMS or WhatsApp) for candidates | Candidates without email; needs a paid provider and DLT registration for SMS in India | M |
| 9 | **Employer packages** (job-post credits or subscriptions) with online payment, e.g. Razorpay | The plan's subscription revenue | L |
| 10 | **Government jobs information** with source links, a verification step and a non-affiliation notice | Optional traffic driver | M |
| 11 | **International recruitment**, only after the Emigration Act registration | Legal requirement | L |
| 12 | **PostgreSQL**, only if a trigger in section 1 happens | Not needed yet | L |

Step 41 also made Google for Jobs read per-month, per-day and per-hour pay, and added a job-type filter to Find Work (part of item 3). Walk-in was left out of job types: it describes how candidates are interviewed rather than the job, so it fits better as a job detail later.

Step 43 redesigned the homepage and header (blue-and-white design system, Inter, job category groups, `/categories`, Post a Job, Career Resources) and labelled the starter jobs as samples so they are never shown as real vacancies.

Suggested order: 2 → 1 → 3 → 4, which makes Hireriv usable for skilled and field hiring within about four steps; then 6, 7 and 5.

## 7. Tests

- Before the audit: 86 tests pass.
- After: 92 pass, including the new `test/access.test.js`, which checks that:
  - every route in the code is in ACCESS.md with the same policy, and vice versa;
  - signed-out requests to all 88 team, Admin, candidate and client routes are refused;
  - Recruiters get 403 on all 31 Admin-only routes, can't see the Settings, Team or Activity tabs, and can't download billing or activity exports;
  - team, candidate and client sessions can't stand in for each other;
  - cross-site posts are refused.
- No database migrations were made, so there is nothing to roll back.
