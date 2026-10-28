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
  | contact sharing consent | `candidates.privacy.shareContact` (off by default, works only with discovery on), consent purpose `employer-contact` |
  | contact_unlocks | `contact-unlocks`: company, candidate, member, free or credit, month; in the candidate's data export; the candidate is replaced by `erased` when their account is deleted |
  | contact credits | `contact-credit-ledger`: +N per pack paid (once per payment) or -1 per unlock beyond the free ones, -N for a refunded pack's unused credits |
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

## Step 56: employer self-service portal and client contracts

- **Audit first.** Already there: company registration with email and mobile confirmation, company verification, one sign-in per person with several companies and roles (owner, hiring manager, recruiter, viewer, and the site supervisor from Step 55), jobs and the applicant pipeline, interviews and scorecards, staffing requests and requisitions (Step 54) with Hireriv's review before they open, shared shortlists with Interested / Maybe / Not a fit, invoices and credit notes, team management with an audit log, workforce (Step 55). Missing: contracts visible to the client with versions and signatures, bulk orders, reasons kept with shortlist answers, client reports, a guard against changing your own role, and the `/client/*` and `/api/client/*` addresses.
- **Reused, not duplicated.** The portal is the employer portal: the same sign-in, session, membership and `can()` checks (the company always comes from the membership). Contract terms stay the Step 54 contracts; documents are versions of them (`contract-versions`), and an active version makes its contract Active. Hiring requests are requisitions created through `agency.js`. Invoices come from `placements.js`. Reports read requisitions, the shortlist, interviews, staffing assignments, approved timesheets (Step 55) and invoices. Emails use the existing notice template.
- **Contract statuses.** draft, pending_review, sent, signed, active, expired, terminated. Review by a second person is required before sending. Versions are immutable after draft. Signing needs an owner, their typed name matching their account, their designation, an explicit agreement and the SHA-256 of the text they were shown; the evidence keeps the user, time, a keyed hash of the IP address (not the address), the browser string and the document hash.
- **Permissions.** New employer actions: `contracts.view` (owners and hiring managers), `contracts.sign` (owners), `reports.view` (owners, hiring managers, viewers). Billing stays with owners. Team side: `clients.manage` (Admins, and Account Managers for their own clients) writes and moves versions; `contracts.view` reads them.
- **Rate limits and audit.** Client API 120 a minute; signing and change requests 10 per 10 minutes; bulk orders 10 per 10 minutes. Client actions go to the employer audit log; team actions and signatures to the agency audit log.
- **Tests.** `test/client-portal.test.js` (5): the contract lifecycle with review by someone else, immutability, who reads and signs, signature evidence and activation, change requests and termination; bulk orders checked whole, isolation between companies and Hireriv's review; shortlist reasons and history, interviews, invoices, reports, team emails and company profile by role, short links; no self-escalation.

## Step 57: sales CRM, pipeline and business growth

- **Audit first.** Already there: the website's "Hire with us" form (`hire-requests`, a bot trap and a rate limit), employer self-sign-up, client accounts with owners invited by email (`employers.js`), client contracts and their signed versions (Steps 54 and 56), invoices, payments, TDS, refunds and credit notes (`placements.js`), team roles (`agency-roles.js`), the notification queue with retries, and email with unsubscribe headers for job alerts. Missing: leads, a pipeline, sales activities and reminders, proposals, a hand-over from sales to recruitment, and sales reports.
- **Reused, not duplicated.** Leads link to client accounts instead of copying them; converting a won opportunity links an existing employer or creates one with the same function the team's "Add client" uses (`clients.createClient`), so its owner gets the usual invitation. Accepted terms become a Draft contract through `agency.js` (`handoverContract`), signed and activated only through the Step 56 flow. Revenue reads payments recorded in billing. Reminders use `notify.js`; proposal emails use the mailer.
- **Adapted from the brief.** The brief names React, Node and PostgreSQL; the app is Express with server-rendered pages and SQLite, so the CRM is built the same way (`/admin/crm/*`, with `/crm/*` short links). The CRM's records (`crm-leads`, `crm-opportunities`, `crm-activities`, `crm-proposals` with their versions, `crm-audit`) live in SQLite like the rest of the back office; the optional PostgreSQL mirror stays for jobs only.
- **Controls.** Every page and call checks the team member's role on the server (`crm.view`, `crm.manage`, `crm.import`, `crm.approve`, `crm.convert`, `crm.reports`, `crm.revenue`). Representatives see only what they own or added, and duplicate checks show them only that another lead exists and who has it. The sales roles were also taken out of the permissions every recruitment role shares, and can open only the CRM. Strict field lists on every body; dates, money (exact paise and basis points) and terms validated. One proposal in progress per opportunity, approval by someone other than the version's author, proposal links random and stored hashed, a new version kills the old link. Conversion only for won opportunities, by a Sales Manager or an Admin, once per opportunity (a lock plus the stored result; the Idempotency-Key is recorded); several matching clients make it ask; nothing is created if the contract details are wrong; no invoice is ever created.
- **Contacts and consent.** A lead keeps why we may hold the contact (asked us, existing relationship, referral, event, published business contact) and whether they agreed to sales emails. Proposal emails go only to a contact who hasn't unsubscribed, carry a signed unsubscribe link and a one-click `List-Unsubscribe` header, and nothing else is sent to leads in bulk. Lost and unqualified leads lose their contact details after 24 months without activity (`CRM_RETENTION_MONTHS`). Acceptance evidence keeps a keyed hash of the connection, not the IP address.
- **Rate limits and audit.** CRM API 240 a minute; imports 10 per 10 minutes; conversions 20 per 10 minutes; public proposal and unsubscribe pages 30 per 10 minutes per IP. Ownership changes, status and stage moves, value changes, proposal approval, sending, answers and withdrawal, imports, conversions, unsubscribes and retention go to `crm-audit` and the team activity log.
- **Tests.** `test/crm.test.js` (9): website and sign-up capture without exposing anything, spam and repeats; roles, visibility, assignment and validation; stage rules and the lead following them; follow-ups and reminders sent once; proposal versions, approval by someone else, sending with unsubscribe, the client's answer with evidence; controlled conversion (requests, a single client account under parallel calls, linking existing clients, Draft contracts, no invoices); reports and revenue from recorded payments; imports; pages, forms and short links.

## Step 58: marketing website, SEO and employer lead generation

- **Audit first.** Already there: server-rendered pages with a title, description, canonical address and share image on every page; a sitemap of public pages, open jobs and articles; robots rules for the admin, accounts, employer portal and API; JobPosting data on open jobs (none on closed or sample jobs, which are also `noindex`), Organization and WebSite data on the homepage, Service, FAQ and breadcrumbs on service pages; old job addresses redirect to the current one; ten recruitment desks and six service pages; Find Jobs with filters and pages; candidate accounts, saved jobs, alerts and application tracking; the "Hire with us" form feeding the sales CRM (Step 57). Missing: landing pages for job seekers by kind of work and industry, construction, facility and hospitality desks, descriptions on several pages, robots rules for newer private areas, a `noindex` for filtered searches, the `/api/public/*` addresses, and any conversion counts.
- **Adapted from the brief.** The site is Express with server-rendered EJS, so pages are rendered on the server as before (no new framework). The brief's names for the kinds of work are replaced by the site's own: Office & professional, Skilled & technical, and Industrial, field & service. Existing addresses are unchanged; the suggested ones that differ (`/services/recruitment`, `/services/staffing`, `/services/bulk-hiring`, `/employers/contact`) redirect permanently. Landing pages exist only for kinds of work and broad industries, each with its own text, not for every city or filter.
- **Structured data.** JobPosting only for open, real jobs; a verified employer's own job names that employer as the hiring organisation, an agency job names Hireriv (clients stay confidential); salary only when disclosed; `validThrough` from the closing date. Closed jobs keep their page (old links work) without JobPosting, marked `noindex`; the public API answers 410 for them. Before release, check a live job page and a landing page in Google's Rich Results Test (not possible from here).
- **Leads.** One function handles the form and the JSON API: validated fields, a known hiring type, the bot trap, 5 per 10 minutes per IP, a link-stuffing check in the CRM; the reply never includes internal data. The lead keeps the service or industry page it came from. No second lead store.
- **Analytics.** Counts per day, event and a short label (kind of work, service, industry, lead source) in `site-analytics`, kept 400 days. No cookies, IPs, user agents, ids or form contents; bots and browsers with Global Privacy Control or Do Not Track are skipped, so no consent banner is needed. Browsers may report only "application started"; everything else is counted on the server. "Qualified" is counted once per website lead when the sales team qualifies it.
- **Performance.** Jobs are already held in memory and expired on each request, so listings, landing pages and the sitemap always reflect closing dates without a separate cache to invalidate. Landing pages and search are paginated (20 a page). No database index was added: public pages read the in-memory jobs, not SQL queries.
- **Tests.** `test/website.test.js` (8): every sitemap page answers 200 with a unique title, description and canonical address, no `noindex` and valid JSON-LD; landing pages list the right live jobs; JobPosting accuracy and absence on closed and sample jobs; robots and `noindex` on search variants, 404s and redirects; the public API without private data; inquiries validated, rate-limited and into the CRM; candidate registration; counts without personal data, bots and opt-outs skipped, qualified once.

## Step 59: platform administration, trust, safety and quality control

- **Audit first.** Already there:
  - team roles, checked on the server for every page and API (`agency-roles.js`)
  - two-step sign-in for team accounts, which an Admin could require for everyone
  - employer self-sign-up with a company check (approve or decline under Clients, recorded in `employer-verifications`)
  - employers' jobs reviewed before going live (approve, or send back with a reason)
  - "Report this job", with an email to the team and an inbox tab
  - separate audit logs for the agency, the CRM, the workforce, employer accounts and team activity
  - `/healthz`, plus email delivery stats and retries for Admins
  - private uploads with real file-type checks, virus scanning and signed links

  Missing:
  - roles for verification, moderation, support, trust & safety, operations and audit
  - asking a company for more information
  - any check on listing content
  - restricting or removing a live listing
  - complaint cases and appeals
  - a combined, tamper-evident audit view
  - the health of background jobs and errors
  - any limit on who could approve companies and jobs (every team role could)
- **Reused, not duplicated.**
  - Verification decisions use the existing checks and emails: `employers.js` now exposes them as functions, and the Clients tab buttons call the same code.
  - Job approvals use the existing review: `employer-hiring.js` has `approveJob` and `sendBackJob`, and the Jobs tab buttons call them too.
  - "Report this job" keeps its inbox and email, and also opens a case.
  - Permissions live in `agency-roles.js`; sign-in and two-step sign-in in `team.js`; notifications in `notify.js` (type `trust-case`); evidence files go through the `uploads.js` checks.
  - The audit page reads every existing log rather than copying it.
- **Least privilege.** Six new roles, each opening only its own pages (`TRUST_PAGES`), with every action behind a permission.
  - Approving companies now needs `verify.review`: Admins, Recruitment and Account Managers, Verification Reviewers and Trust & Safety Managers. Recruiters and Staffing Managers can no longer approve them.
  - Approving jobs needs `jobs.review`: the recruitment roles as before, minus Staffing and Finance Managers.
  - Restricting or removing listings needs `jobs.moderate`.
  - Suspending or closing accounts needs `accounts.restrict` plus two-step sign-in. Closing also needs a second person to approve, never the one who asked.
  - Support Agents see only cases assigned to them. Moderators also see job cases, and verification reviewers employer cases.
  - Auditors read the audit history and the access matrix, and can change nothing.
  - Operations Admins see health and email delivery (what failed and why, never to whom), but no complaints or candidates.
- **Stronger authentication.** Every trust & safety and operations role must turn on two-step sign-in before any page opens, and can't turn it off. Admins need it for strong actions and for appeal decisions.
- **Automated flags are prompts, not verdicts.** The scan runs every 10 minutes (`TRUST_SCAN_MS`). It looks for:
  - fees or deposits
  - requests for Aadhaar, PAN, bank details or OTPs
  - scam promises
  - WhatsApp, Telegram and shortened links, and bare IP or non-HTTPS links
  - text copied from an earlier listing by another company

  Flags at or above the policy level open a case, or add to one. Nothing is unpublished, closed or banned automatically. A moderator can mark flags as checked, so the same content isn't flagged again.
- **Reports.** These rules apply to `POST /api/reports` and to the job page form:
  - Input is validated: a known category, details up to 1000 characters, an optional email and one evidence file (PDF, JPG or PNG; signature check and virus scan).
  - Abuse controls: a bot trap, link-stuffed text treated as spam, and 5 reports per 10 minutes per IP.
  - The reporter comes from the session, never from the request.
  - The reply is the same whether or not the job, company or candidate exists, so it can't be used to discover accounts.
  - Candidates can be reported only by an employer who can already see that application.
  - Repeat reports from the same person don't raise the count.
- **Decisions, history and appeals.**
  - Every decision records a reason, the person and the time: in the case history, on the listing (`moderationHistory`) or the check, and in the audit trail.
  - Two people can't decide the same thing at once: listings and checks use `expectedStatus`, appeals are claimed in a transaction, and cases carry a `version`. The second person gets a 409.
  - Adverse decisions about a company (listing unpublished or removed, account suspended or closed, sign-up declined) email the owners a 30-day appeal link: a random token, stored hashed.
  - Someone other than the original decider upholds or overturns the appeal. Overturning restores the listing's previous state, reactivates the company or reopens its check.
  - Suspensions and moderation locks can't be undone from the ordinary Jobs and Clients buttons.
- **Audit trail.** `trust-audit` entries are append-only and hash-chained: each stores the previous hash, and the newest is kept separately. Editing, deleting or reordering entries therefore shows as a broken chain on the audit page and in system health. No route edits or deletes them (the generic delete covers only inbox forms). Viewing evidence is recorded.
- **Privacy and retention.**
  - Complaint details, reporter emails and evidence are visible only to the people allowed to handle that case. Reporters hear only that their report was handled.
  - Evidence is stored outside the public folder under random names, and downloaded through 15-minute signed links.
  - Two years after a case closes, details, emails and evidence files are deleted and appeal statements cleared. The case outline and the audit trail stay.
  - Operational monitoring keeps request counts, background-job runs and the last 50 errors in memory. Emails, links, paths, tokens and numbers are stripped from the messages.
- **Metrics.** The overview never counts adverse decisions per reviewer. It shows:
  - the verification backlog and the time to decide
  - listings waiting for review or flagged
  - open cases by status and priority, and open cases per person
  - first-response and resolution times
  - appeal outcomes and the overturn rate
- **Adapted from the brief.**
  - The app stays on Express, EJS and the existing SQLite record store instead of React and new PostgreSQL tables. Cases, appeals and the audit trail are collections like the rest of the app (`trust-cases`, `trust-appeals`, `trust-audit`), so no separate migration is needed.
  - The brief's "message" reports are not offered: the platform has no messaging between users yet.
  - Exceptional data exports were not added, so nothing exists yet to put behind dual approval. Account closure is behind it.
- **Not done here.**
  - No staging run, external penetration test or load test.
  - Incident escalation outside the app (who to call about credible threats or exposed data) still needs a written procedure.
  - The in-memory request and error counts reset when the server restarts.
- **Tests.** `test/trust.test.js` has 12 tests, covering:
  - flag rules and copy detection, and cleaned monitoring data
  - roles that need two-step sign-in and see only their own pages
  - reports: validation, identical replies, the rate limit, repeat reporters, urgency, the job page form, the bot trap and evidence file checks
  - automated cases that leave listings live, then removal and the 410 page
  - verification: a question, the company's answer, a race between two reviewers, decline, appeal and overturn by someone else
  - an employer job: approval, a race between two moderators, restriction with history, blocked resubmission, appeal and restore
  - cases: versions, assignment, Support Agent visibility, escalation, and resolving with a reason plus a reporter email without details
  - suspension and reinstatement, closure needing a second person, and two-step sign-in for strong actions
  - a policy change with a reason, and health data without secrets
  - a read-only audit trail and tamper detection

## Step 60: mobile-friendly website, installable app and the phone experience

- **Audit first.** Already there:
  - responsive pages with a phone menu, the saved-jobs icon in the header, and tables that scroll inside their box (all but the invoice)
  - Find Jobs: search by title, skill, company or keyword and location; filters for categories, experience, pay, job type, work arrangement, shift, company and skills; kind-of-work tabs (Office & professional, Skilled & technical, Industrial, field & service) with counts
  - job pages with pay, workplace, employment type, work arrangement, experience and shift
  - one-click apply with the saved profile, resume upload from the phone, saved jobs, job alerts and saved searches
  - application status and interview times in My account, with confirm and reschedule
  - one application per person and job, enforced in the database; the submit button is disabled while sending
  - the employer applicant tracking (pipeline, shortlist and reject with reasons, interviews, offers), already usable on a phone
  - the notification center, email preferences per area, unsubscribe and suppression

  Missing:
  - a manifest, icons, a service worker, an offline page and update handling
  - phone (push) notifications and their devices
  - phone-notification and marketing choices in the preferences
  - the `/api/me/...` and `/api/devices/...` addresses from the brief
  - a compact filter layout and larger tap targets on phones
  - anything for slow connections
- **Reused, not duplicated.**
  - Pushes come from the existing in-app notifications: `notify.js` calls a listener for each new one, and `push.js` sends it if the person allowed that area.
  - Preferences extend the existing record (`notification-preferences`), and `/api/me/notification-preferences` is the same handler as `/api/notification-preferences`.
  - Devices are tied to the existing sessions; no new sign-in.
  - Employers keep the existing applicant tracking; there is no second mobile system.
  - App counts use the existing cookie-free website analytics.
- **Private data never in the offline cache.**
  - The service worker stores only paths under `/css/`, `/js/` and `/img/` plus the offline page, all fetched without cookies.
  - Pages are always fetched from the network and never stored; API calls, uploads and other requests are not touched.
  - Responses marked `private` or `no-store`, or setting a cookie, are not stored either.
  - The offline page never shows who is signed in.
  - The test runs the worker against stand-in browser caches.
- **Sign-out.**
  - `Clear-Site-Data: "cache"` on all three sign-outs.
  - The tab's session storage is cleared and the browser's push subscription cancelled.
  - The server removes the devices registered with that sign-in, and checks before every push that the sign-in still exists.
- **Push security.**
  - Devices are registered only by the person's own action.
  - Endpoints must be HTTPS addresses of known push services (Google, Mozilla, Microsoft, Apple), with no other port and no credentials; a local stand-in is accepted only when `NODE_ENV=test`.
  - Device keys are checked as P-256 points, and the auth secret is 16 bytes.
  - The endpoint and keys are never returned or logged; other people's devices are "not found".
  - Pushes carry no names, job titles, email addresses or phone numbers. They are encrypted per device and signed with the site's VAPID key.
  - At most 10 devices per account, and registering is rate-limited.
- **Consent.**
  - Phone notifications follow the per-area choices.
  - Marketing emails for job seekers are off by default, and each change records when and where it was made. Withdrawing also removes the person from the newsletter list.
  - Employers and the team have no marketing choice here.
- **Slow connections.**
  - Public files are kept on the device after the first visit.
  - `Save-Data` skips the web font.
  - The `Vary: Save-Data` header keeps caches apart.
  - Images under icons get a week's cache.
- **Also fixed.** Unreadable or oversized request bodies now get a 400 or 413 (JSON for the API) instead of a server error.
- **Adapted from the brief.**
  - The app stays on Express and EJS with the existing record store instead of React and PostgreSQL tables.
  - Devices live in `push-subscriptions` like the rest of the app's records, so no separate migration is needed.
- **Not done here.**
  - Regional languages: the brief says "if required". Pages are English only, and translating them is a separate piece of work.
  - Sending marketing emails: consent is recorded, but there are still no campaigns (Step 15).
  - Real-device testing on Android, iPhone and low-end phones, and Lighthouse runs, are still to do on the live site. iPhones need the app added to the Home Screen before notifications can be turned on, and the settings page says so.
- **Tests.** `test/mobile.test.js` has 9 tests, covering:
  - the manifest, icons and page tags
  - the service worker run against stand-in caches: public files only, pages never stored, the offline fallback, removing old versions, and an update waiting for "Reload"
  - an offline page that is the same for everyone
  - device validation, ownership, hidden endpoints, moving to a new owner, and removal on sign-out
  - encrypted and signed pushes without personal details, none without permission, per-area choices and revocation by the push service
  - preferences validation and marketing consent
  - one application per job
  - Find Jobs on a phone, every table in a scrolling box, and `Save-Data`
  - app counts, and permission never requested on page load

## Step 61: recruitment analytics, business intelligence and performance dashboards

- **Audit first.** Already there:
  - the admin Reports tab (`reports.js`): applications, placements, time to hire, first response, conversion, source of hire, recruiters, categories and clients for a period; billed and collected for Admins; CSV per section
  - agency recruitment reports (`agency.js`): requisitions, fill rate, staffing, workload and billing by client
  - employer hiring metrics (`ats.js` `metrics`, `/api/ats/analytics`): funnel, time to hire and fill, per-job numbers and workload
  - the client portal reports, the CRM sales reports, and the cookie-free website counts
  - the trust & safety overview and system health

  Missing:
  - one set of definitions: the same name meant slightly different things in different places
  - role-specific dashboards for recruiters and Admins
  - filters by kind of work, recruitment type, location, industry, employer, recruiter and status
  - custom date ranges with India-date boundaries
  - a validated analytics API with the brief's endpoints
  - an employer view by category, location and type
  - recorded financial views and exports
- **Reused, not duplicated.**
  - `analytics.js` reads the same records as everything else: applications and their stage history, interviews and offers; placements and invoices from `placements.js` (with its `accountOf` balance rule); requisitions from `agency.js`; job-page views from `site-analytics.js`; the backlog from `trust.js`; background jobs from `ops-monitor.js`.
  - Roles and permissions come from `agency-roles.js`, with the new `analytics.view` and `analytics.platform`, and employer roles from `employer-team.js`, which already had `analytics.view`.
  - The CSV writer and its formula-injection guard are the existing `sendCsv`, and the charts use the existing column chart.
  - The older reports stay where they are, with links to the new dashboards.
- **Definitions.** Every KPI is returned with its definition, period rule and timezone, and shown under "How it's counted":
  - Dates are India dates (Asia/Kolkata), and ranges include both ends.
  - Ratios use the same applications on both sides, applications received in the range, so they never mix different groups.
  - Time to hire is from applying to the first move to Hired, or to the placement record if that is earlier. Time to fill is from a job going live to its first hire.
  - Offers count once per application; an offer counts as accepted if the candidate accepted it or the application ended in a hire.
  - Application conversion is shown only where job-page views are counted: the whole site, or one kind of work.
- **No duplicate counting.** Stages are counted per application from its furthest stage, never per history entry. Re-entering a stage counts once. A correction that moves an application back cancels the stages it skipped back over.
- **Deleted, withdrawn, refunded and corrected records.**
  - Deleted records are gone from the sources, so from every number.
  - Withdrawn applications count as received, never as active.
  - Refunds reduce what was collected on their own date, and credit notes reduce what was invoiced on theirs.
  - Cancelled invoices count nowhere.
  - Duplicates, profiles without a job and sample jobs are left out.
  - Replacements under a guarantee are shown apart from placements.
- **Isolation.**
  - The scope comes from the session only.
  - Employers see only their company. Below owner and viewer they see only the jobs they work on, and an id of another company or person gets a 404.
  - Team recruiters see their own work. Other recruiters' ids get a 403 unless the role has `workload.view`.
  - Money needs `money.view`, or company ownership for the company's own invoices.
  - Sales and trust & safety roles have no access, and Finance Managers can open the dashboard among their limited pages.
- **Validation and limits.**
  - Unknown filter names, repeated values, impossible dates, ranges over 3 years, future end dates and page sizes over 100 get a 400.
  - Queries are computed in memory from records read by the app, with no SQL built from input.
  - Rate limits: 120 API calls a minute, and 30 exports per 10 minutes.
- **Audit.** Viewing revenue (API or dashboard) and every export are recorded, with the filters, in the team activity log or the company's audit log.
- **Performance.** A three-year range over more than 3,000 applications is answered well within the test's 3-second limit. Each answer reports how long it took (`tookMs`).
- **Adapted from the brief.**
  - Express and EJS with the existing record store instead of React and PostgreSQL views.
  - Industry is the job's category.
  - "Hiring requests" for employers are their requisitions to Hireriv.
- **Not done here.**
  - Scheduled email reports.
  - Comparison with the previous period.
  - Caching for much larger data sets; the numbers are recalculated on each request.
- **Tests.** `test/analytics.test.js` has 8 tests, covering:
  - filter validation
  - totals that reconcile with seeded records: the funnel with a duplicate stage entry and a corrected offer, offers, time to hire, placements and replacements, and revenue with refunds, credit notes and cancelled invoices
  - India midnight boundaries
  - what each role sees and the pages
  - employer isolation, including ids from another company
  - filters by kind of work, recruitment type, status, employer and location
  - CSV exports that follow the filters and are recorded
  - large and empty data

## Step 62: security, privacy, compliance and data governance

- **Audit first.** Already there:
  - scrypt password hashes
  - hashed session tokens with expiry, sign-out and "sign out everywhere"
  - email verification for job seekers, and email and mobile verification for employers
  - two-step sign-in for the team (required for trust & safety roles, optional for Admins)
  - role and company checks on every route (ACCESS.md, tested)
  - rate limits and lock-outs on sign-in, reset and verification
  - the current password needed to change a password
  - uploads checked by their first bytes and virus-scanned when ClamAV is set, with random names, kept outside the public folder, and downloaded through 15-minute signed links
  - employer resume downloads and worker document openings logged
  - visibility switches for recruiters and employers
  - a marketing consent with a time
  - data download and account deletion
  - retention for job-seeker data, messages, cases and notifications
  - a hash-chained audit trail for trust & safety decisions
  - verified daily backups

  Gaps found:
  - uploads stored unencrypted
  - Admins not required to use two-step sign-in
  - no fresh confirmation before bulk exports or backup downloads
  - the sign-up consent bundled agreeing to the terms with being contacted by recruiters, and new profiles were visible to recruiters by default
  - no consent records per purpose, nor the policy version
  - two separate "career tips" switches that didn't agree
  - no tracked data requests for people without an account, nor for corrections and grievances
  - the team activity log kept by count (newest 2,000), not by age, so less than 180 days on a busy site
  - no retention for backups, consent or requests beyond fixed defaults
  - deleted accounts coming back with a restored backup
  - no security log for failed sign-ins, refusals and team resume downloads
  - no alerts
  - no incident records or response plan
  - the privacy policy said it was "written to meet" the DPDP Act
- **Reused, not duplicated.**
  - Sign-in, roles and two-step codes stay in `team.js` and `agency-roles.js`. The team module adds `mustUse2fa`, `confirmIdentity`, an activity listener and age-based pruning.
  - Upload checks stay in `uploads.js`, which now seals files through `vault.js`. Every existing download route calls `vault.send` instead of `res.download`.
  - Account deletion is the existing `deleteEverything`, used by data requests too.
  - The marketing choice keeps using the notification preferences and the newsletter list, now through `privacy.setMarketing`, so the account settings and notification settings switches agree.
  - Retention adds to `retention.js`, and the backup count comes from the policy.
  - Privileged decisions go to the existing hash-chained trail (`trust.record`), and alerts go out through `notify.js` and the team security emails.
  - The new pages reuse the trust & safety layout and navigation.
- **Changed behaviour:**
  - Admins need two-step sign-in when `NODE_ENV=production`.
  - Personal-data CSV exports and backup downloads ask for the password again.
  - New job-seeker accounts are not shown to recruiters for other jobs unless they tick the box. Their applications still reach the jobs they apply to.
  - The activity log is kept for the security-log period instead of the newest 2,000 entries.
- **Not done here.**
  - No external penetration test or load test.
  - No real ClamAV, key store or provider in testing.
  - The alert counters are in memory.
  - Employer accounts have no two-step sign-in yet: password plus verified mobile only.
  - Bulk exports have no second-person approval; they need a fresh confirmation, a limit and logging.
  - Legal review of the notice and consent texts, the Rules' commencement dates and CERT-In applicability is still to be done (docs/SECURITY.md section 7).
  - The incident contacts still need filling in.
- **Adapted from the brief.**
  - Express, EJS and SQLite collections (`consent-records`, `data-requests`, `security-events`, `security-incidents`, `security-evidence`) instead of React and PostgreSQL tables.
  - "Private object storage" is the private uploads folder plus application-level encryption and signed delivery. Moving to S3-compatible storage later only changes `vault.js` and the upload storage.
- **Tests.** `test/security-privacy.test.js` has 10 tests, covering:
  - sealing, tamper detection, key rotation and the sweep
  - two-step sign-in for Admins in production, and identity confirmation
  - encrypted resumes on disk and signed, logged downloads in a sandbox
  - consent per purpose with versions, no implied consent at sign-up, and marketing with the newsletter
  - data requests: identical replies, email confirmation, the 30-day due date, team handling, version conflicts and own requests only
  - deletion for a request after confirmation, with anonymised consent evidence and the journal
  - retention validation, confirmation and audit
  - the security log: one alert per rule, refusals, exports, and no emails, tokens or passwords
  - an incident through all seven steps, with evidence, notification decisions, confirmed containment, cancelled links and sessions, and an intact audit chain
  - deletions applied again after a restore

  Existing tests were updated where exports and backups now ask for the password, and where sign-up no longer makes a profile visible to recruiters.

## Step 67: multilingual experience and accessibility

- **Audit first.** Already there:
  - a skip link, focus outlines, labelled forms, `aria-hidden` icons and reduced-motion rules
  - a resume that is optional for field jobs, and the short quick-apply
  - Unicode-safe storage, and spelling fixes and synonyms in search (`search.js`)
  - the AI provider layer (Step 66)
  - candidate profiles (`candidates.js`)

  Gaps: every word was written into the templates in English, with no language choice, no Hindi, no search in other scripts, no translated listings, and no accessibility statement or tests.
- **Reused, not duplicated.**
  - Search terms in other languages are mapped onto the existing filters and keywords, and approved translations go in as extra text for `search.js`.
  - Job translations are drafted by `ai-assistant.js` with a new feature and task, under the same limits, fallbacks and usage records.
  - Permissions are the existing `job.edit` and `jobs.moderate`, and records go to the company activity log and `trust.record`.
  - The language preference is saved through the candidate helpers, and the analytics events are added to `site-analytics.js`.
- **Design choices.**
  - Stored values stay English: job type, category and similar fields are translated only for display, so filters, the API, exports and matching are unchanged.
  - The browser's `Accept-Language` is not used on its own.
  - Facts on a translated listing always come from the original, and a translation stops showing when the listing changes (source hash).
  - Blocking checks cover numbers, links and empty fields.
  - Hindi pages get Devanagari fonts, and script strings are inline JSON with no extra request.
  - Untranslated workspace pages are marked `lang="en"`.
- **Not done here.**
  - Native-speaker review of the Hindi.
  - Telugu is complete only for the navigation, search and job words. Tamil, Bengali and Marathi have no locale files.
  - The employer workspace, Admin and emails are not translated.
  - Manual screen-reader and keyboard checks are listed as not done in docs/ACCESSIBILITY.md.
- **Adapted from the brief.**
  - JSON locale files and EJS helpers instead of a React i18n library.
  - The collection `job-translations` instead of a table.
  - Browser speech APIs instead of a speech service, so no audio reaches Hireriv.
- **Tests.**
  - `test/i18n.test.js` has 7 tests, covering:
    - locale key and placeholder parity
    - Telugu fallback, numbers and dates
    - Hindi and Telugu search
    - the selector (cookie, profile, safe redirects, same-site, no Accept-Language)
    - Hindi pages end to end and the offline page
    - localised apply errors with field names
    - the translation workflow: an AI draft, blocking numbers, approval, display with the original, search, hiding after an edit, other companies refused, and team withdrawal with a reason
  - `test/accessibility.test.js` has 4 tests: automated checks on public pages in English and Hindi and on candidate pages.
  - Existing tests: two assertions in `test/candidate-profile.test.js` needed only to accept `&#39;`, because the text now comes through EJS escaping. Two pages that passed a variable named `t` now use `txn` and `track`.

## Step 66: AI recruitment assistant and hiring copilot

- **Audit first.** Already there:
  - explainable matching (`job-match.js`) with weights, factors and a note that it is not a prediction
  - recommendations with reasons (`job-recommendations.js`)
  - the resume parser (`resume-parse.js`) and resume text kept with applications
  - the skill overlap used on applicant lists (`match.js`)
  - consent per purpose (`privacy.js`), the employer roles and the audit history

  Gaps: no AI provider, no drafts, summaries, explanations in words, interview questions or assistant, and no usage limits or records for any of them.
- **Reused, not duplicated.**
  - The match explanation runs `job-match.js` and only words its factors. Its fallback is those factors.
  - The resume summary falls back to `resume-parse.js`, and the assistant suggests jobs from `recommend()`.
  - Permissions are the employer actions that already exist (`jobs.create`, `applicants.view`, `applicants.contact`, `interviews.manage`).
  - Consent is a new purpose in `privacy.js`, and settings changes go through `trust.record`.
  - Candidate erasure also deletes AI conversations.
- **Design choices.**
  - The provider layer has `anthropic`, `off` and `mock` (tests only, refused in production).
  - The model gets no tools and structured outputs where a shape is needed.
  - Untrusted text is fenced and redacted.
  - Answers are checked after generation for invented pay and perks, and for personal topics.
  - Every feature has a rules-based answer, plus a circuit breaker.
  - Limits per person a day, per company a month and for the site a day.
  - Usage events carry no text.
- **Not done here.** No evaluation set, no Hindi (Step 67), no streaming or voice. Legal review in docs/AI.md section 7.
- **Adapted from the brief.** SQLite collections `ai-assistant-sessions`, `ai-assistant-messages`, `ai-generation-records`, `ai-feedback`, `ai-review-records` and `ai-usage-events` instead of tables. Panels on the existing pages instead of React screens.
- **Tests.** `test/ai-assistant.test.js` has 8 tests, covering:
  - the guards (redaction, fences, injection signs, invented pay, personal topics), prices, and the mock refused in production
  - drafts: who may make them, nothing invented, other companies refused, review and feedback, and usage without text
  - match explanations that move nothing, resume summaries by permission
  - fair interview questions
  - rules-based answers and the circuit breaker during an outage, with job search unaffected
  - the career assistant's consent and deletion
  - settings with a reason, features off and limits
  - no collar words in the new files

## Step 65: public API, integrations and developer platform

- **Audit first.** Already there:
  - session-based employer JSON APIs (`/api/employers/jobs`, applications and status, interviews) for the portal's own pages
  - the public job API (`/api/public/jobs`)
  - the notification events (`notify-events.js`) and the stage history listeners
  - the employer roles, the company activity log and the trust audit history

  Gaps: no API keys or tokens for other systems, no scopes, no outbound webhooks, no idempotency, no per-client limits, no protection for requests to addresses customers give us, no sandbox and no developer documentation.
- **Reused, not duplicated.**
  - Jobs and status changes go through the existing functions in `employer-hiring.js` (now exported): `createEmployerJob`, `updateEmployerJob`, `submitJob`, `setJobState` and `changeStatus`. Review, quality checks, plan limits and posting holds apply exactly as in the portal.
  - The public listings reuse `jobsApi`.
  - Events come from wrapping the existing `events` methods, `history.onMove` and a new `hooks.stateChanged` in `setJobState`.
  - Integrations belong to the existing company and are managed by its owners: there is no second sign-in system. Revocation by the team is recorded with `trust.record`.
- **Security choices.**
  - Secrets: HMAC-hashed, shown once, masked after that.
  - Tokens: hashed, 15 minutes, header only, cookies ignored.
  - Isolation: every lookup is scoped to the token's company (404 otherwise).
  - Payloads carry no personal data.
  - Outbound requests: SSRF-checked, pinned to the checked address, with each redirect checked again.
  - Signing secrets: derived, never stored.
- **Not done here.**
  - No partner integrations (none are claimed).
  - No IP allow-lists or mutual TLS.
  - Rate counters are kept per process.
  - Not part of an external penetration test yet.
- **Adapted from the brief.** Express and SQLite collections instead of PostgreSQL tables: `integration-clients`, `integration-credentials`, `integration-tokens`, `webhook-endpoints`, `webhook-deliveries`, `integration-events`, `integration-idempotency` and `integration-sandbox`. There is a server-rendered Integrations page in place of React screens.
- **Tests.** `test/integrations.test.js` has 9 tests, covering:
  - owners only, the secret shown once and stored hashed, and the owners' email
  - tokens, scopes and refusing tokens in the address or from cookies
  - jobs scoped to the company, idempotent creation and review as usual
  - applications with and without contact details, and status moves
  - signed webhooks without personal data, retries, replays with the same event id, and dual signatures after rotation
  - SSRF checks on addresses, DNS answers and redirects
  - rotation and revocation by the company and by the team
  - the sandbox's own data and rate limit
  - no collar words in the new files

## Step 64: employer verification, fraud prevention and job quality intelligence

- **Audit first.** Already there from Step 59:
  - the verification queue (verify, decline, ask for more) and the appeal of a declined sign-up
  - job moderation with automated flags (fee requests, personal data, scam promises, chat and shortener links, exact copies)
  - complaint cases with evidence and versions, appeals decided by someone else, the hash-chained audit history, the policy and the overview
  - "Report this job" and `POST /api/reports` with the same reply for every valid shape

  Gaps found:
  - no representative or documents for verification, no verification levels, and no re-check after identity changes
  - automated flags without a stored, explainable assessment, and no near-duplicate detection
  - no checks on what a job must say before review, and no record of big changes after publication
  - no posting-rate limit, and no restriction short of suspension
  - no report reference or tracking, no company reports or public company page
  - no false-positive measure, and no single queue
- **Reused, not duplicated.**
  - Cases, priorities, escalation, appeals, the audit chain, the policy, the queues, evidence handling and roles all stay in `trust.js`. The risk engine feeds them, and the new case actions use the same appeal flow.
  - Company decisions stay in `employers.js`: re-checks reuse `verifyCompany` and `requestCompanyInfo`, and the posting hold sits next to `restrictCompany`.
  - The job review and limits stay in `employer-hiring.js`. Quality gaps and posting holds are part of the existing submit check.
  - Documents use the Step 62 vault, the upload checks and the signed download links.
- **Changed behaviour:**
  - An employer job needs responsibilities, the pay or a pay policy, and (for industrial, field and service work) hours or a shift before it can be sent for review.
  - A live listing that copies another company's text is paused for a moderator, and the company is told it is a routine check.
  - More than 10 jobs sent for review in 24 hours (policy) makes new ones wait.
  - The company verification form moved to `company-trust.js` and accepts documents.
  - Job reports now come back with a reference.
- **Not done here.**
  - No automatic lookup of GSTIN, CIN or Udyam numbers with government services (reviewers check them by hand).
  - No check that the representative's mobile is theirs (reviewers may call).
  - Rules are not tuned on real data yet.
  - Legal review in docs/TRUST.md section 9.
- **Adapted from the brief.**
  - Express, EJS and SQLite collections instead of React and PostgreSQL tables: `risk-assessments`, `report-receipts`, and checks in `employer-verifications`.
  - Reviews are an append-only list on each check rather than a separate table.
  - The brief's restriction of an employer's capabilities is the posting hold. Suspension and closure already existed.
- **Tests.** `test/fraud.test.js` has 10 tests, covering:
  - the rules (no automatic suspension, weak signals not counted, short texts, off-site applying, changes after publication)
  - a near-copy paused and approved, with the verdict counted as a false positive
  - quality checks and the new fields
  - verification with a representative and documents, other companies refused, logged document links, escalation and the review history
  - re-checks after a rename
  - change signals and posting bursts
  - job and company reports with references and tracking, giving the same reply either way
  - the posting hold, appealed and lifted by someone else
  - the queue limited by role and versioned case updates
  - no collar words in the new files

## Step 63: payments, subscriptions and billing

- **Audit first.** Already there:
  - placement invoices with GST (CGST + SGST or IGST), numbered per financial year, with snapshots, payments, TDS, credit notes, refunds and reminders (`placements.js`)
  - staffing invoices from approved timesheets, with drafts approved by Finance (`agency.js`, `timesheets.js`)
  - the client portal's invoice list and printable invoices for owners only (`billing.view`)
  - billing settings: legal name, GSTIN, PAN, state, bank, fee, GST rate, payment days, TDS
  - fixed limits: 50 jobs live, paused or in review, and 50 team members per company
  - CRM proposals and contracts (no billing is created from a won lead)

  Gaps found:
  - no plans or subscriptions, and no way for employers to pay online
  - no payment gateway, signatures, webhooks or idempotent payment records
  - limits were fixed in code, not per plan
  - no role for someone who only handles billing at the employer
  - no refunds through a provider, and no reconciliation of online payments
- **Reused, not duplicated.**
  - The invoice and credit-note number series, the billing settings (seller details, default GST rate), the invoice and credit-note page, amounts in words and the financial year all come from `placements.js`.
  - Placement invoices stay where they are. Paying one online adds a payment through `placements.onlinePayment`.
  - Employer roles and sessions stay in `employer-team.js` and `employers.js`; the Billing administrator is one more role there.
  - Limits plug into the existing checks for sending a job for review and inviting a member.
  - The password confirmation before sensitive actions is the one from Step 62. Audit entries go to the hash-chained history, the company's audit log and the team activity log.
  - In-app notifications and emails go through `notify.js` and `mailer.notice`. The scheduled job is tracked in Operations health.
- **Changed behaviour:**
  - Companies that registered themselves are on the free Starter plan: 3 jobs live, paused or in review, and 3 team members, until they upgrade. Companies the team set up are not limited by a plan.
  - The employer portal's Invoices tab is now **Billing**, with placement invoices under **Staffing invoices**.
- **Not done here.**
  - No test against Razorpay's own sandbox yet (the tests use an imitation of its API with real signatures).
  - No automatic charging (mandates). No Cashfree.
  - No e-invoicing (IRN). GST rates and SAC codes still need an accountant's confirmation (docs/BILLING.md section 8).
  - Subscription revenue is not yet in the analytics dashboards (it is on the billing desk).
- **Adapted from the brief.**
  - Express, EJS and SQLite collections instead of React and PostgreSQL tables. Invoice items are the `lines` of each invoice.
  - "Reuse existing invoices": plan invoices share the number series, settings and printable page, but are stored in paise in their own collection, because placement invoices are kept in rupees inside each placement.
- **Tests.** `test/billing.test.js` has 11 tests, covering:
  - paise parsing, GST splits and month ends
  - public plans without secrets, and plan changes by Admins only, audited
  - billing access for owners and billing administrators only
  - job and seat limits from the plan, on the server
  - checkout: server-made orders, forged signatures refused, failed payments changing nothing, the provider asked, one invoice, repeated callbacks and webhooks, other companies refused
  - webhook signatures, mismatched payments held for review, and payments settled by the webhook alone
  - refunds by two different people after the password again, with a credit note, and reconciled totals
  - cancelling, undoing, downgrades at renewal and Enterprise as a quote
  - paying placement invoices online
  - every billing desk tab and the billing pages rendering without secrets, and an agreed Enterprise plan with its own limits
  - renewals: reminders, the grace period, cancelled plans ending, and overdue renewals
