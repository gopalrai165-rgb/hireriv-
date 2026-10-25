# Hireriv platform audit

Date: 24 October 2026 · Codebase at Step 39 · Scope: the "all-industry recruitment and staffing platform" plan (Step 1: audit before building)

No production code or database was changed for this audit. It added this file, [ACCESS.md](ACCESS.md) (every route and who may use it) and `test/access.test.js`, which keeps ACCESS.md in step with the code and checks that every protected route turns away people without the right sign-in or role.

## 1. Planned stack vs what exists

| Layer | Plan | Hireriv today |
| --- | --- | --- |
| Frontend | React / Next.js | Server-rendered EJS pages with a small `public/js/main.js`. Every page is SEO-ready already (Google for Jobs data, sitemap, share images) |
| Backend | Node.js, Express or NestJS | Node.js 22 + Express 4 |
| Database | PostgreSQL | SQLite through Node's built-in `node:sqlite` (`db.js`), with JSON documents grouped by collection, transactions, daily verified backups. Since Step 48, the jobs data is also kept in PostgreSQL tables when `DATABASE_URL` is set (`pg.js`, `db/postgres/migrations/`) |
| File storage | Private object storage | `uploads/` on the server's disk, served only through signed-in routes |
| Search | Postgres full-text | In-memory filtering and ranking (`search.js`, `match.js`), including resume text. With `DATABASE_URL`, `/api/jobs` uses Postgres full-text search (Step 48) |
| Auth | Secure sessions/tokens | Server-side sessions (hashed tokens) for team, clients and candidates; scrypt passwords; two-step sign-in for the team |

**Recommendation: keep the current stack, and don't rewrite to Next.js + PostgreSQL now.** The plan's own rule is "reuse completed features instead of rebuilding working dashboards", and 39 tested steps already cover most of it. A rewrite would take months to get back to where the site is today. SQLite on one server comfortably handles a staffing business's volume (hundreds of thousands of applications).

Revisit PostgreSQL only when one of these becomes true: the site needs **more than one app server** (the rate-limit and lock-out counters live in memory today and aren't shared), a separate mobile app or partner API needs heavy concurrent writes, or reporting needs SQL across very large tables. All storage goes through `db.js`, so the change is contained, but it's a real redesign, because records are stored as JSON documents rather than relational tables.

## 2. Planned entities vs current storage

| Plan entity | Where it lives now | Notes |
| --- | --- | --- |
| users | `team` (staff), `employers` (client logins). Candidates have no account record | Candidates are identified by the email they applied with; sign-in is by emailed link |
| candidate_profiles | Fields on each `applications` record; the Talent pool merges them by email | Profile edits in My applications update every application |
| employer_profiles | `employers` (company, industry, size, website, hiring locations, address, GSTIN/CIN/Udyam, status) | ✅ Step 50: verification status (verified / being checked / declined); each check is a record in `employer-verifications` |
| employer_memberships | `employer-users` (one login per person: name, email, mobile and when it was verified, password hash) and `employer-members` (person × company, role, assigned jobs) | ✅ Step 50: a person can be in several companies, a company has up to 50 members. Roles: owner, hiring manager, recruiter, viewer |
| employer_verifications | `employer-verifications` | ✅ Step 50: what was checked, by whom, the outcome |
| recruiter_profiles | `team` (name, email, role Admin/Recruiter, two-step) | |
| jobs | `jobs` (mirrored to PostgreSQL) | Category, kind of work, city, workplace address and walk-ins, work mode, type, openings, shift, hours, experience, pay range, skills, who can apply, closing date, owner, client, who posted it. Statuses: draft, pending, open, paused, closed, rejected. job_locations is a PostgreSQL table |
| applications | `applications` with `history`, `interviews`, `shared`, `feedback`, `atsNotes`, `offers`, `assignedTo` | application_events: each status change in `history` (from, to, who, when, and since Step 51 the kind of actor, corrections and their reason; in PostgreSQL also `application_stage_history`). Employers see applicants to their own jobs only |
| resumes | Files in `uploads/`; extracted text on the application | |
| interviews | Inside each application (`interviews[]`) with scorecards | ✅ Step 51: interview rounds with the candidate's confirmation; scorecards are the interview feedback |
| staffing_requests | `hire-requests` (public /hire form and client-portal requirements both land here) | Not duplicated |
| notifications | `notifications`, `notification-deliveries`, `notification-preferences` | ✅ Step 52: in-app notifications, email delivery tasks with retries, preferences |
| audit_logs | `activity` (team, newest 2,000 kept) and `employer-audit` (per company, 2 years) | Team: every admin change, sign-ins, two-step events, retention clean-ups. Employers (Step 50): job created/sent/published/paused/closed, applicant opened, resume downloaded, status changed, interview booked, team and profile changes, sign-ins |
| Not in the plan | `placements` (invoices, payments, credit notes, refunds, timesheets), `email-templates`, `posts`, `site`, `job-alerts`, `newsletter`, `contacts` | |

## 3. Planned sections vs current routes

| Plan section | Planned route | Exists as | Status |
| --- | --- | --- | --- |
| Home | `/` | `/` | Done |
| Find Jobs | `/jobs` | `/jobs`, `/jobs/:id`, `/saved` | Partly: keyword, category, location and work-mode filters; **no salary, experience or job-type filters** |
| Staffing & Recruitment | `/staffing-solutions` | `/services`, `/services/:slug`, `/industries` | Done under a different path; **no payroll service page** |
| Employer Portal | `/employers` | `/employer` (the `/employers/*` addresses redirect there) + `/hire` (public form) | ✅ Since Step 50: sign-up with company verification, team members with roles, jobs (draft → review → live, pause, close), applicants, status history, interviews, company profile, settings with mobile verification, activity log |
| Candidate Portal | `/candidate/dashboard` | `/account` (the `/candidate/*` addresses redirect there) | ✅ Since Step 49: registration, email link or password sign-in with reset, structured profile with completion, several resumes, applications, saved jobs, alerts, interviews, settings, activity log, data download/delete |
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
| Post and run own jobs, see own applicants, book interviews, manage the company team (by role: owner, hiring manager, recruiter, viewer) | | | ✓ | | |
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
| 7 | ✅ **Done in Steps 47 and 50** (hiring analytics still to come). **Client self-signup** with verification (work email + GSTIN), direct job posting held for Admin approval, and hiring analytics in the client portal | The planned employer portal | L |
| 8 | **Phone sign-in by OTP** (SMS or WhatsApp) for candidates | Candidates without email; needs a paid provider and DLT registration for SMS in India | M |
| 9 | **Employer packages** (job-post credits or subscriptions) with online payment, e.g. Razorpay | The plan's subscription revenue | L |
| 10 | **Government jobs information** with source links, a verification step and a non-affiliation notice | Optional traffic driver | M |
| 11 | **International recruitment**, only after the Emigration Act registration | Legal requirement | L |
| 12 | ✅ **Started in Step 48**: the jobs data (jobs, places, categories, skills, applications, saved jobs) is kept in PostgreSQL and searched there. Moving the rest only if a trigger in section 1 happens | Not needed yet | L |

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

## Step 50: employer workspaces

- **Audit first.** Before: one login per client company (the email and password lived on the company), self-signup with team approval (Step 47), and employer jobs with review. Applicants were only visible to clients through shortlists the team shared. Kept: all of that, the client invoices, timesheets and shortlist feedback, and the `/api/jobs` addresses.
- **Moved, not rebuilt.** On first start each company login becomes a person (`employer-users`) who owns the company (`employer-members`); passwords, confirmations and pending links move with them, and old sessions keep working. The employer portal uses the same session cookie and password code; there is no second sign-in system.
- **Server-side checks.** Every employer route and API checks the person's membership and role in the company of their session (`employer-team.js` `can()`), never a company id from the browser. Switching company checks membership. Other companies' jobs and applicants answer 404; a role that doesn't allow an action answers 403.
- **Applicants.** Employers see applicants only on jobs they posted themselves; jobs the team runs for a client stay with the team. Viewers see progress without contact details; contact details, resumes (signed 15-minute links), status changes and interviews need an owner, or a hiring manager or recruiter working on the job. Opening an applicant and downloading a resume are logged.
- **Abuse limits.** Self-signup companies need the poster's mobile verified (6-digit code by text, 10 minutes, 5 sends an hour, 5 tries) before sending jobs for review; up to 5 jobs waiting while the company is unverified and 50 live, paused or waiting per company; per-IP limits on every form and API. Job posting rules are public at `/job-posting-policy` and agreed at sign-up.
- **PostgreSQL:** migration `002_employer_jobs.sql` allows the `paused` status and adds openings, shift, working hours, workplace address, walk-ins and who can apply. Rolling back: drop those columns and restore the old status check after closing or reopening paused jobs.
- **Tests:** `test/employer-workspace.test.js` covers the login move, invitations and roles, the permission matrix, applicant visibility and contact details, status history, interviews, the JSON API, company switching, aliases and job decisions.

## Step 51: applicant tracking

- **Audit first.** Before: applications already had a stage history (`history.moveStage`), interviews with scorecards, team notes, withdrawal, and the employer applicant pages from Step 50. Stages were New, Screening, Interview, Offered, Hired and Rejected, and any stage could follow any other. Kept: all of it. The admin panel's pipeline, reports and timeline keep working with the new stages.
- **Entities, mapped onto what exists** (no second store):

  | ATS entity | Where it lives |
  | --- | --- |
  | application_stage_history | `history[]` on each application (from, to, when, who, actor kind, user id, correction, reason); PostgreSQL `application_stage_history` |
  | recruiter_assignments | `assignedTo` on the application, limited to members working on the job (`employer-members.jobIds`) |
  | interview_rounds | `interviews[]` (with `confirmation`: awaiting / confirmed / reschedule) |
  | interview_feedback | Scorecards on each interview |
  | candidate_notes | `atsNotes[]`, separate from anything the candidate sees |
  | job_offers | `offers[]` (pay, joining date, location, approval, candidate response); PostgreSQL `job_offers` (status only) |
  | notifications | `notifications` (one row per event key: queued, sent or failed; no addresses or message text; kept a year) |
  | audit_logs | `employer-audit` |

- **Workflow.** `ats.js` holds the rules: the stages, which moves are allowed, offers needing approval before Offer and acceptance before Hired, and no moves after withdrawal. Moves outside the workflow answer 409. Only company owners can make a correction, which needs a reason and is kept in the history next to the original move.
- **Permissions** (`employer-team.js` `can()`, checked on the server for the session's company): notes, offers, recording the candidate's answer, reading and writing scorecards need an owner, or a manager or recruiter on the job; assigning and approving offers need an owner or a manager on the job; workload needs a manager or owner; corrections need an owner. Other companies' applications answer 404.
- **Interviews.** At least 2 hours ahead, 7 am–9 pm India time, no clash for the candidate or the interviewer across the company. Candidates confirm or ask for another time from their account; the people on the job are emailed.
- **Metrics** (`ats.metrics`, `GET /api/ats/analytics` returns the definitions): counts over applications created in the period, duplicates left out; funnel = how many reached each stage (from the history), conversion = share of the previous stage, drop-off = the rest; time to hire = median days from application to Hired; time to fill = median days from the job going live to its first hire; workload = open applications and upcoming interviews per person.
- **Notifications** go through a ledger keyed by the event (`interview-invite:<id>`, `offer-made:<id>`, `new-application:<app>:<user>`, …), so retries and double clicks never send twice.
- **Decision support only.** Match scores and recommendations are shown, never used to reject anyone.
- **PostgreSQL:** migration `003_ats.sql` adds `application_stage_history`, `job_offers` and `applications.assigned`, and resets the sync hash so everything is rewritten once. Rolling back: drop the two tables and the column.
- **Tests:** `test/ats.test.js` covers visibility by assignment, the board, valid and invalid moves, corrections, assignments, notes kept from candidates, interview rules and confirmation, scorecards, offers (approval separate from acceptance), metrics against the seeded records, company isolation and one notification per event.

## Step 52: notifications and communication

- **Audit first.** Before: about 45 email templates in `mailer.js`, one shared layout with a plain-text copy, sent straight away with no retry (a failure was only logged); the Step 51 send-once ledger in `notifications`; interview reminders every 5 minutes; double opt-in job alerts (`job-alerts`) sent once per job when it first goes live; employer verification codes by SMS (`sms.js`); candidate WhatsApp/SMS consent in account settings. There were no in-app notifications, no preferences, no delivery tracking and no webhooks.
- **Reused, not duplicated.** One service (`notify.js`) replaces the Step 51 ledger (its rows moved once into `notification-deliveries`) and every queued email goes through the existing `mailer.js` templates. Job alerts keep their collection, opt-in and unsubscribe links. There is one sign-in per kind of account; the center reads the existing candidate, employer and team sessions.
- **Entities, mapped onto what exists:**

  | Planned entity | Where it lives |
  | --- | --- |
  | notifications | `notifications`: recipient key, type, category, title, short text, internal link, read time. No addresses or contact details |
  | notification_preferences | `notification-preferences`: email on/off for applications, interviews and jobs, per recipient |
  | notification_deliveries | `notification-deliveries`: event key, template and its version, recipient key, record ids, status (queued, sending, sent, delivered, bounced, complained, failed, skipped), attempts, next try, last error, provider message id |
  | notification_templates | `mailer.js` (code, reviewed like code); each delivery records the template name and version |
  | notification_events / outbox | The queued delivery tasks are the outbox: written in the same SQLite transaction as the business change (`db.transaction`, which now nests) |
  | (delivery reports) | `notification-webhooks` (processed event ids, 30 days) and `email-suppressions` (hash of bounced/complaining addresses) |

- **Workflow.** Business event → `notify-events.js` decides recipients from the records (the application's email; employer members whose role allows the action on that job, `employer-team.js can()`; the team owner of team-run jobs) → `notify.emit` saves notifications and delivery tasks under a stable key (a unique index makes duplicates impossible) → the worker sends due tasks, re-checking at send time that the record still exists and the person may still receive it → the outcome is recorded; provider webhooks add delivered, bounced and complaints.
- **Retries.** Up to 5 tries, after 1, 5, 30 and 120 minutes; then "failed", shown to Admins with a retry button. Tasks left "sending" by a restart go back in the queue. Retries never add notifications or repeat the business change.
- **Privacy.** Recipients are stored as keys (candidates as a hash of their email), so the notification tables hold no addresses; the address is read from the current record when sending. Subject lines and in-app titles carry the job title, not candidate contact details (names left out of subjects of emails to others). Sign-in, password-reset and interviewer feedback links contain tokens that are never stored, so those emails are not queued. Deleting a candidate account deletes their notifications, deliveries and preferences and sends a confirmation email; a person removed from a company loses its notifications. Retention: notifications 1 year, finished deliveries 90 days, webhook events 30 days (`notify.prune`, daily).
- **Security.** The recipient always comes from the session (`?as=` only chooses between accounts the browser is already signed in to); someone else's notification answers 404. Employer notifications carry the job and permission they need and are filtered by the person's current role and company. In-app links must be paths on this site. The webhook is server-to-server only: HMAC-SHA256 over the raw body with `EMAIL_WEBHOOK_SECRET`, a 5-minute window against replays, constant-time comparison, and each event id processed once; without a secret it doesn't exist (404). Nothing in the browser can mark an email delivered or send email to someone else.
- **Channels.** In-app and email now. Text messages and WhatsApp stay for verification codes and the consent candidates give recruiters; browser push is not built. They can be added as more delivery channels on the same tasks.
- **Monitoring.** `/admin/notifications` (Admins): waiting, retrying, failed, sent, delivered, bounced and complaint counts, bounce rate, oldest waiting email; the dashboard warns about failures in the last day, a queue older than 30 minutes, or 5%+ bounces.
- **PostgreSQL.** Not mirrored: notifications are operational records with short retention, not part of the jobs data the mirror serves.
- **Tests.** `test/notifications.test.js` covers deduplication, retries with backoff, the transactional outbox, preferences, suppression, webhook signatures and idempotency, isolation between people and companies, the scheduled checks, every email template's layout, applications and interviews notifying the right people end to end, job-alert filters and limits, account deletion, and saving applications while the email provider is down.

## Step 53: search, matching and recommendations

- **Audit first.** Before: keyword search with city/state/remote, several categories, job type, work arrangement, kind of work, experience level, minimum pay and sort, in `search.js` and in PostgreSQL full-text search when the mirror is on; a skill-overlap score (`match.js`) for recruiters; resume text reading on the apply form (`resume-parse.js`); the structured candidate profile (Step 49) with preferences, availability, work history and education; job alerts by category and city; saved jobs; "Jobs for you" by skills and city. Missing: skill, company and shift filters, typo help, an explained match, recommendations, saved searches with frequencies, filling the profile from a resume, and any way for employers to find candidates.
- **Reused, not duplicated.** Saved searches are job alerts with more fields, so opt-in, unsubscribe, the alert limit and the notification service (Step 52) all apply. The Find Jobs filter parser checks saved searches and the employer-candidate filters too. Resume reading extends the existing parser, and uploads go through the existing type, size and virus checks. Employer access uses the existing workspace roles (`employer-team.js can()`, new action `candidates.search`), company verification and activity log.
- **Entities, mapped onto what exists:**

  | Planned entity | Where it lives |
  | --- | --- |
  | saved_searches | `job-alerts`: name, filters (the same keys as `/api/jobs`), alertEnabled, frequency (instant, daily, weekly), pending job ids, last summary time. Older alerts (category and city) keep working |
  | job_matches | Not stored: worked out when asked from the current profile and job (`job-match.js`, `MATCH_VERSION` 1), so a score can never be stale |
  | match weights | Settings (`matchWeights`), Admins only, changes logged |
  | candidate discovery consent | `candidates.privacy.discoverable` (off by default), in the data export |
  | candidate_invites | `candidate-invites`: company, job, candidate, time; deleted with the candidate's account |
  | job requirements | `jobs.mustHave`, `immediate`, `physical` |
  | PostgreSQL | migration 004 adds indexes for company and shift; skills use `job_skills`. Every migration now has a rollback file (`npm run pg:migrate -- --rollback` undoes the newest) |

- **Fairness.** The match uses only skills, experience, location, pay, job type and shift. Name, age, gender, photo, religion, caste, marital status, disability and the like are not inputs, and a test checks they change nothing. Unknown means unknown: a factor neither side stated is left out of the score instead of counting as a mismatch, and below 30% of the weight known there is no score. Must-haves (licences, starting straight away, physical work) are shown, not scored. Nothing rejects an applicant automatically; a score only sorts.
- **Privacy and security.** Candidates see only their own recommendations, saved searches and resumes (someone else's answers 404). Employers see only candidates who opted in, and only an anonymised card: first name and initial, never email, phone, resume or former employers. Searching needs a verified company and a role allowing it; inviting needs one of the company's own open jobs. Search, matching, parsing and invites are rate limited. Resume text is never logged; a file sent only for reading is deleted after reading.
- **Not done.** No pg_trgm: spelling help works from the live job vocabulary in the app, so results are the same with or without PostgreSQL. Location is by city and state (no coordinates, so no distance radius). No physical-ability profile of candidates.
- **Tests.** `test/matching.test.js`: the match factors, weights and fairness checks, unknowns, filters and spelling help, resume reading, recommendations, the match API, saved-search CRUD with validation and ownership, instant, daily and weekly alerts, unsubscribing, resume files (valid, malformed, oversized, disguised programs), the review flow, employer discovery (consent, anonymity, permissions, verification, invites) and the weight settings. `test/postgres.test.js` adds the new filters to the Postgres-versus-built-in comparison and migrates, rolls back every migration and migrates again.

## Step 54: recruitment agency and staffing

- **Audit first.** Before: clients were employer accounts (`employers.js`) with their portal, hiring requests and shortlists; `placements.js` had permanent, contract and contract-to-hire placements, guarantees, numbered GST invoices (one-time and monthly), payments, credit notes, refunds, reminders and timesheets; `team.js` had two roles, Admin and Recruiter; reports covered applications, placements and billing. Missing: more roles, contracts, account managers, requisitions, recruiter assignment and workload, temporary placements, staffing assignments, an approval step before invoicing, and an agency audit log.
- **Reused, not duplicated.** One team sign-in with more roles (no second login). Clients stay the employer accounts. Placements stay their own records, separate from applications. Invoices are still created only by `placements.js` (the same numbering, GST, invoice page, payments and credit notes); drafts call it, and payment confirmation stays a separate step. Notifications go through the Step 52 service. Clients use the existing employer portal and roles.
- **Entities, mapped onto what exists:**

  | Planned entity | Where it lives |
  | --- | --- |
  | clients | `employers` (+ `accountManagerId`) |
  | contracts | `client-contracts`: reference, kind, dates, status, fee (basis points or paise), guarantee, payment days, markup |
  | requisitions | `requisitions`: number, client, contract, job, openings, budget and rates in paise, priority, status, recruiters, history |
  | recruiter assignment and workload | `requisitions.recruiterIds`; workload worked out from open requisitions and placements |
  | placements | `placements` (+ `requisitionId`, `contractId`, `recruiterId`, type Temporary, billing per assignment, `staffingInvoices`) |
  | staffing assignments | `staffing-assignments`: placement, site, dates, shift, rates in paise, status, history |
  | invoices | `placements` invoices as before; `invoice-drafts` holds requests waiting for Finance, with their idempotency keys |
  | audit logs | `agency-audit` (who, role, action, record, client) plus a line in the team activity log |

- **Roles.** Super Admin: everything. Recruitment Manager: requisitions, recruiter assignment, workload, staffing, invoice drafts, reports (no money). Recruiter: as before, plus requisitions assigned to them and staffing on those. Account Manager: their clients' contracts, requisitions and staffing, with money. Finance Manager: billing pages, invoice drafts and money reports only. Client Employer: the employer portal roles. Candidate: their account. Permissions are in one table (`agency-roles.js`) and checked on every request; a page outside a Finance Manager's role is refused even when typed in.
- **Money.** New amounts are stored as whole paise and percentages as basis points, and multiplied with integer arithmetic (half a paisa rounds up). There is no hard-coded commission rate: the contract states it, and without a contract the rate in Settings is suggested on the placement form.
- **Idempotency.** A draft has a natural key (the placement's fee, or one assignment period) and optionally the caller's `Idempotency-Key`; repeating either returns the same draft, overlapping periods are refused, and issuing an issued draft returns its invoice. Two simultaneous requests with the same key made one draft in the tests.
- **Isolation.** Clients see only their own requisitions (from the session's company), never rates or internal history; another company's requisition is "not found". Recruiters get 404 for requisitions not assigned to them.
- **PostgreSQL.** Not mirrored: these are operational records in SQLite like placements and invoices.
- **Tests.** `test/agency.test.js`: exact money, contract and requisition validation, the role table, Finance's limits, account managers and contracts, requisition creation, linking, assignment, notification and status rules, placements taking contract fees and filling requisitions, invoice drafts (idempotency including simultaneous requests, Finance-only issuing, issuing twice), staffing assignments (overlaps, rates, exact period billing, Finance issuing), client isolation, reports and the audit log. `test/access.test.js` now checks that Recruiters get 403 on every billing route.

## Step 55: worker onboarding, attendance and workforce operations

- **Audit first.** Before: placements (temporary, contract) and staffing assignments with site, dates, shift and rates (Step 54); monthly contractor timesheets of full/half days for monthly-billed placements (`timesheets.js`); invoice drafts issued by Finance; notifications with preferences, a queued outbox, retries and stable keys (Step 52); upload checks for resumes. Missing: workers and their onboarding, documents, client sites and supervisors, planned shifts, clock-in and clock-out, breaks, corrections, overtime approval, attendance-based timesheets, payroll, and a client supervisor role.
- **Reused, not duplicated.** The worker is the candidate's own account (linked by placement and email), not a copy. Assignments stay in `agency.js` with new fields (site from the client's approved list, supervisor, shift times, break, grace, time zone) and stronger overlap checks across all placements of the same person. Approved timesheets call the Step 54 invoice drafts, so Finance issues invoices through the same billing. Reminders go through the Step 52 notification service with one template that rebuilds each email from the records (someone who lost access gets nothing). Uploads use the same content checks and scanner as resumes, and the same signed links. Team roles gain a Staffing Manager; the client portal gains a Site supervisor; no new sign-in. The month-based contractor timesheets (`timesheets.js`) stay for monthly-billed placements.
- **Entities:**

  | Planned entity | Where it lives |
  | --- | --- |
  | workers | `workers`: placement, candidate email, status, joining steps, emergency contact, history |
  | onboarding requirements | `onboarding-requirements`: per client and role, per client, or the default |
  | documents | `worker-documents`: metadata, SHA-256, expiry, status, history; files in `uploads/worker-documents/` |
  | client locations | `sites` on the employer record (name, address, time zone) |
  | assignments, extensions | `staffing-assignments` (+ supervisor, shift, break, grace, time zone; extensions in its history) |
  | replacement requests | `replacement-requests` |
  | shifts | `work-shifts` (site wall-clock times and their UTC instants) |
  | attendance | `attendance-records`: UTC check-in and check-out, breaks, source, who entered it, late, worked and overtime minutes, status, original times, history |
  | corrections | `attendance-corrections`: proposed and previous values, reason, decision (never edited) |
  | timesheets | `workforce-timesheets`: period, records, totals, submitter, approver, invoice draft |
  | audit | `workforce-audit` |

- **Safeguards.** UTC storage with site time zones (tested across daylight saving); configurable grace, breaks and overtime; overtime and corrections approved by someone else; nobody approves their own timesheet; manual entry for sites without a connection, limited and logged; no location fields accepted at all; missing check-outs become exceptions, never hours; approved timesheets lock their attendance; documents private, signed and logged; identity numbers and bank details never required.
- **PostgreSQL.** Not mirrored: like placements and invoices these are operational records in SQLite, and nothing in the job search reads them.
- **Tests.** `test/workforce.test.js` (10): time zones; joining requirements; onboarding, private documents and signed links; sites, supervisors and shift rules on assignments; shift planning; check-in and out, breaks, manual entry, location refused, missing check-outs, notifications and the email; corrections and overtime by someone else; timesheets (blockers, idempotency, approval, locking, invoice draft with exact amounts, payroll CSV, Finance's view); client and supervisor isolation, replacements, short links; requirements and page access by role. `test/notifications.test.js` now expects the Work & attendance preference. The full suite passes.
