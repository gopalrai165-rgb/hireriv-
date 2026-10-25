# Routes and access

Every route the app serves, and who may use it. **This table is checked by `test/access.test.js`**: adding, removing or changing the protection of a route without updating this file fails the tests.

| Policy | Who | How it is enforced |
| --- | --- | --- |
| public | Anyone | Public forms (`/api/*`) have a bot trap and a per-IP rate limit |
| link | Whoever holds a one-time emailed link | Random 256-bit token, stored hashed, single-use or expiring |
| candidate | A candidate signed in with an emailed link or their password (`hr_cand` session: HttpOnly, SameSite=Lax, Secure on https) | `requireCandidate`; data is limited to applications made with their email |
| employer | A person signed in to the employer portal, working in one of their companies (`hr_emp` session) | `requireEmployer` + their role in that company (owner, hiring manager, recruiter, viewer), checked on the server for every action; other companies' jobs and applicants are "not found" |
| account | Anyone signed in: a candidate, an employer person or the team | `anyAccount` / `anyAccountApi`: the recipient comes from the session, never from the request, and each person sees only their own notifications. On `/api/staffing/*` (workforce) the handler then checks the record: the worker's own, the client's assignments (site supervisors: only those they supervise), or the team role |
| team | Anyone on the team (Admin, Recruitment Manager, Recruiter, Account Manager, Staffing Manager, Finance Manager, Sales Manager, Business Development Representative, Verification Reviewer, Job Moderator, Support Agent, Trust & Safety Manager, Operations Admin, Auditor) | `adminAuth` or `teamApi` (+ two-step sign-in when the team requires it, and always for the trust & safety and operations roles), then the role's permission in `agency-roles.js` (403 otherwise). A Finance Manager can open only billing pages (and the sales reports); the sales roles only the CRM; the trust & safety and operations roles only their own pages |
| admin | Team members with the Admin (Super Admin) role | `adminAuth` + `requireAdmin` (403 for everyone else) |
| billing | Admins and Finance Managers | `adminAuth` + `requireBilling` (403 for everyone else) |

Every state-changing team, candidate and client form also passes `sameOrigin` (cross-site posts are refused).

Total: 569 routes.

## Trust & safety and platform operations: verification, moderation, complaint cases, appeals, audit history, system health; public reports and appeal links

| Method | Path | Policy | Notes |
| --- | --- | --- | --- |
| GET | `/admin/overview` | team | trust.overview (Admins and trust & safety roles): backlogs, response times, appeal outcomes; never decisions per person |
| GET | `/admin/verifications` | team | verify.review (Admins, recruitment and account managers, Verification Reviewers, Trust & Safety Managers): companies waiting to be checked |
| POST | `/admin/verifications/:id/decision` | team | verify.review; verify, decline (reason, appeal offered) or ask for information (reason); only an open check; recorded with reviewer and time |
| GET | `/admin/job-moderation` | team | jobs.review: jobs sent in, flagged and reported listings |
| GET | `/admin/job-moderation/:id` | team | jobs.review: one listing with its flags, cases and decision history |
| POST | `/admin/job-moderation/:id/decision` | team | Approve or send back a job sent in: jobs.review; restrict, remove, lift, clear flags or correct a live job: jobs.moderate; reason required; 409 if the listing changed |
| GET | `/admin/reports` | team | cases.view: complaint cases; Support Agents see those assigned to them, moderators job cases, verification reviewers employer cases |
| GET | `/admin/cases/:id` | team | cases.view and that case visible to the role; 404 otherwise |
| POST | `/admin/cases/:id` | team | Status (reason to close), assignment and priority (cases.manage); under the case version, 409 if someone else changed it |
| POST | `/admin/cases/:id/actions` | team | Each action has its own permission; suspending or closing accounts needs two-step sign-in, and closing needs a second person to approve |
| POST | `/admin/cases/:id/evidence` | team | cases.view on that case; PDF, JPG or PNG up to 5 MB, real file type and virus scan; kept privately |
| GET | `/admin/cases/:id/evidence/:eid` | team | cases.view on that case and a signed link that expires; each download is recorded in the audit trail |
| GET | `/admin/appeals` | team | cases.view; all appeals for appeals.decide, otherwise only those on cases the role sees |
| POST | `/admin/appeals/:id/decision` | team | appeals.decide (Admins, Trust & Safety Managers) with two-step sign-in, never the person who made the decision; overturning reverses it |
| GET | `/admin/audit-logs` | team | audit.platform (Admins, Trust & Safety Managers, Auditors): read-only history from every audit log, with the hash-chain check |
| GET | `/admin/system-health` | team | ops.health (Admins, Operations Admins): status, background jobs, cleaned errors, email delivery; no customer content |
| POST | `/admin/system-health/deliveries/:id/retry` | team | ops.health: queues a failed email again |
| GET | `/admin/access-control` | team | access.view (Admins, Auditors): roles, permissions and who has two-step sign-in |
| POST | `/admin/access-control/policy` | team | trust.policy (Admins); reason required, recorded in the audit trail |
| GET | `/api/admin/verifications` | team | verify.review; pages of checks with details and signals |
| POST | `/api/admin/verifications/:id/decision` | team | Same rules as the form |
| GET | `/api/admin/moderation/jobs` | team | jobs.review; pages of listings to look at |
| POST | `/api/admin/moderation/jobs/:id/decision` | team | Same rules as the form; expectedStatus guards against two decisions at once |
| GET | `/api/admin/cases` | team | cases.view; only cases the role sees; filters and pages |
| GET | `/api/admin/cases/:id` | team | cases.view on that case; reporter emails only to those who handle it |
| PATCH | `/api/admin/cases/:id` | team | Same rules as the form; version required |
| POST | `/api/admin/cases/:id/actions` | team | Same rules as the form |
| GET | `/api/admin/appeals` | team | cases.view; as the appeals page |
| POST | `/api/admin/appeals/:id/decision` | team | Same rules as the form |
| GET | `/api/admin/audit-logs` | team | audit.platform; read-only, pages of 100 |
| GET | `/api/admin/system-health` | team | ops.health; counts and cleaned messages only |
| POST | `/api/reports` | public | Bot trap, 5 per 10 minutes per IP, validated; the same reply whether or not the thing reported exists; candidates can be reported only by an employer who can see them; optional evidence file checked like uploads |
| GET | `/appeal/:token` | link | Random link emailed with an adverse decision; expires after 30 days |
| POST | `/appeal/:token` | link | One appeal per decision, 20 to 2000 characters, bot trap and 10 per 10 minutes |

## Sales CRM: the sales team (Sales Managers, Business Development Representatives, Admins), and the client's proposal and unsubscribe links

| Method | Path | Policy | Notes |
| --- | --- | --- | --- |
| GET | `/api/crm/leads` | team | JSON; crm.view; representatives get the leads they own or added, managers all; search by q, status, source, owner |
| POST | `/api/crm/leads` | team | JSON; crm.view; validated, a lawful basis required, likely duplicates (email, phone, company domain or name, existing clients) answered 409 until confirmed |
| POST | `/api/crm/leads/import` | team | JSON; crm.import (Sales Managers, Admins); up to 500 rows or CSV, a lawful basis, normalised, duplicates skipped; 10 per 10 minutes |
| GET | `/api/crm/leads/:id` | team | JSON; 404 for leads the person may not see; another representative's duplicates show without contact details |
| PATCH | `/api/crm/leads/:id` | team | JSON; status changes need reasons; converted only through a conversion |
| POST | `/api/crm/leads/:id/assign` | team | JSON; crm.manage; to active sales team members only; open opportunities and follow-ups move too; audited |
| POST | `/api/crm/leads/:id/activities` | team | JSON; a follow-up still to do needs a due time; reps give them only to themselves |
| GET | `/api/crm/activities` | team | JSON; view=open, mine, overdue or all, within what the person may see |
| POST | `/api/crm/activities` | team | JSON; same as POST /api/crm/leads/:id/activities with leadId |
| PATCH | `/api/crm/activities/:id` | team | JSON; its owner, its author or a manager; done, cancelled, outcome, due time |
| GET | `/api/crm/opportunities` | team | JSON; within what the person may see; filter by stage |
| POST | `/api/crm/opportunities` | team | JSON; on a lead the person may see; starts at New Lead |
| PATCH | `/api/crm/opportunities/:id` | team | JSON; value, expected close, next action; value changes audited |
| PATCH | `/api/crm/opportunities/:id/stage` | team | JSON; only allowed moves; Lost needs a reason; Won needs a sent or accepted proposal; reopening Lost needs a manager; audited |
| POST | `/api/crm/opportunities/:id/convert` | team | JSON; won only; representatives ask (202), crm.convert links an existing client or creates one, once (Idempotency-Key); accepted terms become a Draft contract; never invoices |
| GET | `/api/crm/proposals` | team | JSON; never the link token |
| POST | `/api/crm/proposals` | team | JSON; one in progress per opportunity; terms validated like contracts |
| GET | `/api/crm/proposals/:id` | team | JSON; 404 for proposals the person may not see |
| PATCH | `/api/crm/proposals/:id` | team | JSON; every change is a new version; back to draft, approval and link cleared |
| POST | `/api/crm/proposals/:id/:action` | team | JSON; approve (crm.approve, not the author of the version), send (approved, contact not unsubscribed), withdraw, response (acceptances by crm.approve) |
| GET | `/api/crm/companies` | team | JSON; client accounts (company only); representatives see those from their leads |
| GET | `/api/crm/reports` | team | JSON; crm.reports; representatives get their own numbers; revenue from recorded payments only with crm.revenue |
| GET | `/admin/crm` | team | Sales team (crm.view); sales roles land here from /admin |
| GET | `/admin/crm/leads` | team | crm.view |
| POST | `/admin/crm/leads` | team | crm.view; shows likely duplicates to confirm |
| GET | `/admin/crm/leads/:id` | team | 404 for leads the person may not see |
| POST | `/admin/crm/leads/:id` | team | Same rules as PATCH /api/crm/leads/:id |
| POST | `/admin/crm/leads/:id/assign` | team | crm.manage |
| POST | `/admin/crm/leads/:id/activities` | team | Same rules as the JSON API |
| GET | `/admin/crm/activities` | team | crm.view |
| POST | `/admin/crm/activities/:id` | team | Same rules as the JSON API |
| GET | `/admin/crm/pipeline` | team | crm.view; drag-and-drop with a form on every card |
| POST | `/admin/crm/opportunities` | team | Same rules as the JSON API |
| POST | `/admin/crm/opportunities/:id` | team | Same rules as the JSON API |
| POST | `/admin/crm/opportunities/:id/stage` | team | Same rules as the JSON API; returns only to CRM pages |
| POST | `/admin/crm/opportunities/:id/convert` | team | Same rules as the JSON API |
| GET | `/admin/crm/proposals` | team | crm.view |
| GET | `/admin/crm/proposals/:id` | team | 404 for proposals the person may not see |
| POST | `/admin/crm/proposals` | team | Same rules as the JSON API |
| POST | `/admin/crm/proposals/:id` | team | A new version |
| POST | `/admin/crm/proposals/:id/:action` | team | Same rules as the JSON API |
| GET | `/admin/crm/companies` | team | crm.view |
| GET | `/admin/crm/reports` | team | crm.reports (also Finance Managers) |
| GET | `/admin/crm/import` | team | crm.import |
| POST | `/admin/crm/import` | team | crm.import; 10 per 10 minutes |
| GET | `/crm` | public | Short link to /admin/crm |
| GET | `/crm/dashboard` | public | Short link to /admin/crm |
| GET | `/crm/leads` | public | Short link to /admin/crm/leads |
| GET | `/crm/leads/:id` | public | Short link to the lead (signed-in sales team only) |
| GET | `/crm/pipeline` | public | Short link to /admin/crm/pipeline |
| GET | `/crm/activities` | public | Short link to /admin/crm/activities |
| GET | `/crm/proposals` | public | Short link to /admin/crm/proposals |
| GET | `/crm/companies` | public | Short link to /admin/crm/companies |
| GET | `/crm/reports` | public | Short link to /admin/crm/reports |
| GET | `/crm/proposal/:token` | link | The emailed proposal link (random, stored hashed); dead once answered, withdrawn, expired or replaced by a new version; no internal notes |
| POST | `/crm/proposal/:token/accept` | link | Typed name, designation, agreement and the SHA-256 of the version shown; evidence keeps a keyed hash of the connection, not the address |
| POST | `/crm/proposal/:token/decline` | link | Name and an optional comment |
| GET | `/crm/unsubscribe/:token` | link | Signed (HMAC) per contact; shows a button |
| POST | `/crm/unsubscribe/:token` | link | Stops sales emails to the contact; also the one-click List-Unsubscribe target |

## Workforce: workers, client supervisors and the staffing team

| Method | Path | Policy | Notes |
| --- | --- | --- | --- |
| GET | `/staffing/assignments` | public | Short link to /admin/staffing |
| GET | `/staffing-solutions` | public | 301 to /services |
| GET | `/api/staffing/workers` | account | JSON; the team by role (Recruiters: status only), a client its own workers (status only), a worker themselves |
| POST | `/api/staffing/workers` | account | JSON; Staffing Managers, Admins, Account Managers (own clients); one worker per temporary or contract placement; nothing copied from the profile |
| GET | `/api/staffing/workers/:id` | account | JSON; 404 when not visible; documents and contact only for the worker and the staffing team |
| GET | `/api/staffing/workers/:id/onboarding` | account | JSON; the joining steps and their status |
| POST | `/api/staffing/workers/:id/onboarding` | account | JSON; the worker completes their steps; the team reviews (documents: Admins and Staffing Managers), marks joined or left |
| POST | `/api/staffing/workers/:id/documents` | account | Multipart; the worker only; PDF, JPG or PNG checked by content (and scanned when ClamAV is set), stored privately |
| GET | `/api/staffing/assignments/:id/workforce` | account | JSON; shift times, grace, break, time zone and supervisor of a visible assignment |
| POST | `/api/staffing/assignments/:id/replacement` | account | JSON; the client's supervisors and managers or the staffing team |
| POST | `/api/staffing/replacements/:id` | account | JSON; the staffing team only |
| PUT | `/api/staffing/clients/:id/sites` | account | JSON; the staffing team or the client's Account Manager |
| GET | `/api/staffing/requirements` | account | JSON; the team (workforce permission) |
| PUT | `/api/staffing/requirements` | account | JSON; the staffing team; identity numbers and bank details are never required |
| GET | `/api/staffing/shifts` | account | JSON; shifts of visible assignments only |
| POST | `/api/staffing/shifts` | account | JSON; supervisors of the assignment and the staffing team; inside the assignment, no double shifts |
| POST | `/api/staffing/shifts/:id/cancel` | account | JSON; not once someone checked in |
| POST | `/api/staffing/attendance/check-in` | account | JSON; the worker (server time, no location), their supervisor or the team (times up to 7 days back); Idempotency-Key supported |
| POST | `/api/staffing/attendance/check-out` | account | JSON; same people; after check-in, at most 20 hours later |
| POST | `/api/staffing/attendance/:id/breaks` | account | JSON; start or end a break on an open check-in |
| POST | `/api/staffing/attendance/absences` | account | JSON; supervisors and the team |
| GET | `/api/staffing/attendance` | account | JSON; visible assignments only; not for Recruiters or Finance |
| POST | `/api/staffing/attendance/:id/overtime` | account | JSON; supervisors and the team, never the worker or whoever entered the times |
| POST | `/api/staffing/attendance/:id/corrections` | account | JSON; the worker, supervisor or team; refused once in a submitted or approved timesheet |
| GET | `/api/staffing/attendance/corrections` | account | JSON; visible assignments only |
| POST | `/api/staffing/attendance/corrections/:id/approve` | account | JSON; someone other than the requester who supervises the assignment |
| POST | `/api/staffing/attendance/corrections/:id/reject` | account | JSON; same, with a reason |
| GET | `/api/staffing/timesheets` | account | JSON; visible assignments; Finance sees approved ones only |
| POST | `/api/staffing/timesheets` | account | JSON; refused while check-ins, exceptions, corrections or overtime are open; the same period gives the same timesheet |
| POST | `/api/staffing/timesheets/:id/approve` | account | JSON; a supervisor or the team, never the submitter; locks the attendance and asks Finance for an invoice draft |
| POST | `/api/staffing/timesheets/:id/reject` | account | JSON; sends it back with a reason |
| GET | `/staffing/workers` | public | Short link to /admin/workforce |
| GET | `/staffing/onboarding` | public | Short link to /admin/workforce/onboarding |
| GET | `/staffing/shifts` | public | Short link to /admin/workforce/shifts |
| GET | `/staffing/attendance` | public | Short link to /admin/workforce/attendance |
| GET | `/staffing/timesheets` | public | Short link to /admin/workforce/timesheets |
| GET | `/worker/dashboard` | public | Short link to /account/work |
| GET | `/client/workforce` | public | Short link to /employer/workforce |

## Public website

| Method | Path | Policy | Notes |
| --- | --- | --- | --- |
| GET | `/recruiter/workspace` | public | Short link to /admin/workspace (sign-in needed there) |
| GET | `/recruiter/placements` | public | Short link to /admin/workspace |
| GET | `/client/requisitions` | public | Short link to /employer/requisitions |
| GET | `/client/candidates` | public | Short link to the shortlist on the client's dashboard |
| POST | `/api/public/candidate-registrations` | public | Same as POST /api/auth/register |
| GET | `/client/dashboard` | public | Short link to /employer |
| GET | `/client/company-profile` | public | Short link to /employer/company |
| GET | `/client/hiring-requests` | public | Short link to /employer/requisitions |
| GET | `/client/interviews` | public | Short link to /employer/interviews |
| GET | `/client/contracts` | public | Short link to /employer/contracts |
| GET | `/client/invoices` | public | Short link to /employer/invoices |
| GET | `/client/reports` | public | Short link to /employer/reports |
| GET | `/client/team` | public | Short link to /employer/team |
| POST | `/webhooks/email` | public | Email provider to server only: HMAC-SHA256 signature with EMAIL_WEBHOOK_SECRET over the exact body, 5-minute replay window, each event processed once; 404 when no secret is set |
| GET | `/healthz` | public | Uptime check |
| GET | `/og/site.png` | public |  |
| GET | `/og/jobs/:id.png` | public |  |
| GET | `/robots.txt` | public |  |
| GET | `/sitemap.xml` | public |  |
| GET | `/` | public |  |
| GET | `/categories` | public | Job category groups with open-job counts |
| GET | `/jobs` | public |  |
| GET | `/jobs/office-professional` | public | Landing page for job seekers: live office and professional jobs, 20 a page, with advice |
| GET | `/jobs/skilled-technical` | public | Landing page for job seekers: live skilled and technical jobs |
| GET | `/jobs/industrial-field-service` | public | Landing page for job seekers: live industrial, field and service jobs |
| GET | `/jobs/industry/:slug` | public | Landing page for job seekers by industry (catalog.js); 404 for unknown industries |
| GET | `/jobs/:id` | public |  |
| GET | `/saved` | public |  |
| GET | `/saved/cards` | public |  |
| GET | `/hire` | public |  |
| GET | `/services/recruitment` | public | Moved (301) to /services/permanent-staffing |
| GET | `/services/staffing` | public | Moved (301) to /services/contract-staffing |
| GET | `/services/bulk-hiring` | public | Moved (301) to /services/bulk-rpo-hiring |
| GET | `/services` | public |  |
| GET | `/services/:slug` | public |  |
| GET | `/industries` | public |  |
| GET | `/industries/:slug` | public |  |
| GET | `/about` | public |  |
| GET | `/contact` | public |  |
| GET | `/privacy` | public |  |
| GET | `/job-posting-policy` | public | Rules for employers posting jobs |
| GET | `/terms` | public |  |
| GET | `/blog` | public |  |
| GET | `/blog/:slug` | public |  |
| POST | `/api/apply` | public |  |
| POST | `/api/resume-parse` | public |  |
| POST | `/api/hire` | public |  |
| POST | `/api/public/employer-inquiries` | public | Bot trap, 5 per 10 minutes per IP, validated; kept as a hire request and added to the sales CRM (a repeat goes to the existing lead) |
| POST | `/api/contact` | public |  |
| GET | `/api/jobs` | public | Open, published jobs only (no samples); validated filters; 120 a minute per IP |
| GET | `/api/public/jobs` | public | Same as GET /api/jobs: live, real jobs only |
| GET | `/api/public/jobs/:slug` | public | One live job by its address or id; 410 once it has closed; never applications or employer details |
| GET | `/api/public/industries` | public | Kinds of work, industries and recruitment desks with open-job counts |
| GET | `/api/public/site-config` | public | Public settings only: name, contact numbers, social links, services, filters; never billing or settings behind sign-in |
| POST | `/api/public/events` | public | Counts an application form being opened; only events a browser may report; no personal data; 60 per 10 minutes |
| GET | `/api/jobs/:id` | public | Open, published jobs only |
| POST | `/api/jobs/:id/report` | public | 5 per 10 minutes per IP; also opens or adds to a trust & safety case |
| POST | `/api/job-alerts` | public | Bot trap, per-IP limit. Signed out: confirmed by an emailed link, same reply either way. Signed in as a candidate (own email): on at once |
| POST | `/api/newsletter` | public |  |
| GET | `/post-a-job` | public | Signed-in employer: the job form; anyone else: employer sign-up |

## One-time links

| Method | Path | Policy | Notes |
| --- | --- | --- | --- |
| GET | `/account/verify/:token` | link | One-time emailed sign-in link |
| POST | `/account/verify/:token` | link | One-time emailed sign-in link |
| GET | `/account/reset/:token` | link | One-time emailed reset link (30 minutes) |
| POST | `/account/reset/:token` | link | One-time emailed reset link (30 minutes); signs out every other session |
| GET | `/employer/verify/:token` | link | One-time emailed confirmation link (24 hours) |
| POST | `/employer/verify/:token` | link | One-time emailed confirmation link (24 hours) |
| GET | `/employer/setup/:token` | link | One-time client invite link |
| GET | `/employer/reset/:token` | link | One-time client reset link |
| POST | `/employer/setup/:token` | link | One-time client invite link |
| POST | `/employer/reset/:token` | link | One-time client reset link |
| GET | `/feedback/:token` | link | Interviewer's private link; no contact details; ends 2 weeks after the interview |
| POST | `/feedback/:token` | link | Interviewer's private link |
| GET | `/job-alerts/confirm/:token` | link | Link from the double opt-in email |
| GET | `/job-alerts/unsubscribe/:token` | link | One-click unsubscribe link |
| POST | `/job-alerts/unsubscribe/:token` | link | One-click unsubscribe (RFC 8058) |
| GET | `/admin/setup/:token` | link | One-time invite or reset link, 3 days |
| POST | `/admin/setup/:token` | link | One-time invite or reset link, 3 days |

## Team sign-in

| Method | Path | Policy | Notes |
| --- | --- | --- | --- |
| GET | `/admin/login` | public |  |
| POST | `/admin/login` | public | Rate-limited: 10 failures lock the IP for 15 minutes |
| GET | `/admin/login/code` | public | Only after a correct password (5-minute cookie) |
| POST | `/admin/login/code` | public | Only after a correct password; 5 wrong codes restart sign-in |
| POST | `/admin/logout` | public |  |

## Candidate portal (My account; /candidate/* addresses lead here)

| Method | Path | Policy | Notes |
| --- | --- | --- | --- |
| GET | `/account/register` | public |  |
| POST | `/account/register` | public | Same reply whether or not the email has an account; opened only by the emailed link |
| GET | `/account/login` | public |  |
| POST | `/account/login` | public | Password (8 wrong tries per email pause it for 15 minutes) or an emailed link; same reply whether or not the email has an account |
| POST | `/account/logout` | public |  |
| GET | `/account/forgot` | public | Same reply whether or not the email has an account |
| POST | `/account/forgot` | public | Same reply whether or not the email has an account |
| GET | `/account` | candidate |  |
| GET | `/account/profile` | candidate |  |
| POST | `/account/profile/:section` | candidate | Only the signed-in candidate's own profile |
| POST | `/account/profile/:section/:id/delete` | candidate | Only the signed-in candidate's own profile |
| POST | `/account/profile` | candidate |  |
| POST | `/account/resume` | candidate | Replaces the signed-in candidate's own resume |
| POST | `/account/resumes` | candidate | Adds to the signed-in candidate's own resumes (up to 3) |
| POST | `/account/resumes/:id/default` | candidate | Only the candidate's own resumes |
| POST | `/account/resumes/:id/delete` | candidate | Only the candidate's own resumes |
| GET | `/account/resumes/:id` | candidate | Only the candidate's own resumes; signed link, valid 15 minutes |
| POST | `/account/apply/:jobId` | candidate | Applies with the signed-in candidate's own profile and resume |
| POST | `/account/alerts` | candidate |  |
| POST | `/account/alerts/:id/delete` | candidate | Only the candidate's own job alerts |
| GET | `/account/saved` | candidate |  |
| POST | `/account/saved/:jobId/delete` | candidate | Only the candidate's own saved jobs |
| GET | `/account/interviews` | candidate |  |
| POST | `/account/interviews/:appId/:ivId/confirm` | candidate | Only the candidate's own upcoming interviews |
| POST | `/account/interviews/:appId/:ivId/reschedule` | candidate | Only the candidate's own upcoming interviews; tells whoever runs the hiring |
| GET | `/account/settings` | candidate |  |
| POST | `/account/password` | candidate | Needs the current password when one is set; signs out other sessions |
| POST | `/account/settings` | candidate |  |
| POST | `/account/sessions/revoke` | candidate | Signs out every session of the candidate's own account |
| POST | `/account/applications/:id/withdraw` | candidate | Only the candidate's own applications |
| GET | `/account/my-data.json` | candidate | Only the signed-in email's own data |
| GET | `/account/resume/:appId` | candidate | Only the candidate's own applications; signed link, valid 15 minutes |
| GET | `/account/interviews/:appId/:ivId.ics` | candidate | Only the candidate's own interviews |
| POST | `/account/delete` | candidate |  |
| GET | `/candidate` | public |  |
| GET | `/candidate/dashboard` | public |  |
| GET | `/candidate/register` | public |  |
| GET | `/candidate/login` | public |  |
| GET | `/candidate/forgot-password` | public |  |
| GET | `/candidate/profile` | public |  |
| GET | `/candidate/resumes` | public |  |
| GET | `/candidate/applications` | public |  |
| GET | `/candidate/saved-jobs` | public |  |
| GET | `/candidate/alerts` | public |  |
| GET | `/candidate/interviews` | public |  |
| GET | `/candidate/settings` | public |  |
| GET | `/candidate/recommendations` | public |  |
| GET | `/candidate/saved-searches` | public |  |
| POST | `/api/auth/register` | public | Bot trap, per-IP limit; same reply whether or not the email has an account |
| POST | `/api/auth/login` | public | Per-IP limit and per-email lock-out; unconfirmed emails get a new link instead |
| POST | `/api/auth/logout` | public |  |
| POST | `/api/auth/verify-email` | public | Takes the one-time token from the emailed link |
| GET | `/api/candidate/profile` | candidate | 401 when signed out; resume downloads are signed links valid 15 minutes |
| PATCH | `/api/candidate/profile` | candidate | 401 when signed out; only the candidate's own profile; unknown fields refused |
| POST | `/api/candidate/resumes` | candidate | 401 when signed out; files checked before saving |
| DELETE | `/api/candidate/resumes/:id` | candidate | 401 when signed out; only the candidate's own resumes |
| GET | `/api/candidate/saved-jobs` | candidate | 401 when signed out; only the candidate's own saved jobs |
| PUT | `/api/candidate/saved-jobs/:jobId` | candidate | 401 when signed out; only the candidate's own saved jobs |
| DELETE | `/api/candidate/saved-jobs/:jobId` | candidate | 401 when signed out; only the candidate's own saved jobs |
| GET | `/api/candidate/applications` | candidate | 401 when signed out; only the candidate's own applications, without contact details |
| DELETE | `/api/candidate/account` | candidate | 401 when signed out; needs {"confirm": "DELETE"} |
| GET | `/account/recommendations` | candidate | The candidate's own recommended jobs, each with its match explanation |
| GET | `/account/saved-searches` | candidate | The candidate's own saved searches and their alert settings |
| POST | `/account/saved-searches` | candidate | Saves the current Find Jobs filters for the signed-in candidate (checked like a search; up to 20) |
| POST | `/account/saved-searches/:id` | candidate | Only the candidate's own saved search; name, alert on or off, frequency |
| POST | `/account/saved-searches/:id/delete` | candidate | Only the candidate's own saved search |
| GET | `/api/candidate/recommendations` | candidate | 401 when signed out; the candidate's own recommendations |
| GET | `/api/jobs/:id/match` | candidate | 401 when signed out; how the signed-in candidate matches one open job (never anyone else) |
| GET | `/api/candidate/saved-searches` | candidate | 401 when signed out; the candidate's own saved searches |
| POST | `/api/candidate/saved-searches` | candidate | 401 when signed out; filters are checked like /api/jobs; unknown fields refused |
| PATCH | `/api/candidate/saved-searches/:id` | candidate | 401 when signed out; 404 for anyone else's saved search |
| DELETE | `/api/candidate/saved-searches/:id` | candidate | 401 when signed out; 404 for anyone else's saved search |
| GET | `/account/resumes/:id/review` | candidate | One of the candidate's own resumes, read for profile details; nothing is saved |
| POST | `/account/resumes/:id/review` | candidate | Adds only the details the candidate kept and corrected, checked like any profile change; the resume file is unchanged |
| POST | `/api/candidate/resumes/parse` | candidate | 401 when signed out; one of their own resumes, or an uploaded file checked by type, size and virus scan and deleted after reading; nothing is saved |
| GET | `/api/job-alerts` | candidate | JSON; the signed-in candidate's own job alerts |
| DELETE | `/api/job-alerts/:id` | candidate | JSON; only an alert of the signed-in candidate |
| GET | `/account/timesheets/:pid` | candidate | Only the contractor's own placement |
| POST | `/account/timesheets/:pid` | candidate | Only the contractor's own placement |
| GET | `/account/work` | candidate | The worker's own joining steps, assignments, attendance and timesheets |
| GET | `/account/work/documents/:id/file` | candidate | The worker's own documents, through a signed link |

## Employer portal (/employers/* addresses lead here)

| Method | Path | Policy | Notes |
| --- | --- | --- | --- |
| GET | `/employer/requisitions` | employer | The company's own requisitions only (from the session's membership); budgets for owners |
| GET | `/employer/requisitions/:id` | employer | 404 for another company's requisition; shortlisted candidates without contact details |
| POST | `/employer/requisitions` | employer | Owners and hiring managers; starts as Requested until Hireriv confirms it |
| POST | `/employer/requisitions/:id/cancel` | employer | Only while still Requested |
| GET | `/api/employers/requisitions` | employer | JSON; own company only |
| GET | `/api/employers/requisitions/:id` | employer | JSON; 404 for other companies |
| POST | `/api/employers/requisitions` | employer | JSON; owners and hiring managers; unknown fields refused |
| GET | `/api/client/dashboard` | employer | JSON; the company from the session's membership; supervisors get workforce numbers only |
| GET | `/api/client/hiring-requests` | employer | JSON; the company's own requests only; budgets for owners |
| GET | `/api/client/hiring-requests/:id` | employer | JSON; 404 for other companies |
| POST | `/api/client/hiring-requests` | employer | JSON; owners and hiring managers; one request or a bulk order of up to 20 lines, all checked before any is saved; each starts as Requested until Hireriv reviews it |
| GET | `/api/client/candidates` | employer | JSON; candidates shared with the company, without contact details |
| POST | `/api/client/candidates/:id/feedback` | employer | JSON; owners, hiring managers and recruiters; a reason is required for "Not a fit"; earlier answers kept |
| GET | `/api/client/interviews` | employer | JSON; interviews on the company's jobs the person may see, and on shared candidates |
| GET | `/api/client/contracts` | employer | JSON; owners and hiring managers; versions sent to the company (never drafts or internal review) |
| GET | `/api/client/contracts/:id` | employer | JSON; 404 for other companies |
| POST | `/api/client/contracts/:id/sign` | employer | JSON; owners only; typed name, designation, agreement and the document's SHA-256; evidence recorded |
| POST | `/api/client/contracts/:id/request-changes` | employer | JSON; owners only; ends that version with the comment |
| GET | `/api/client/invoices` | employer | JSON; owners (billing permission); the company's invoices only |
| GET | `/api/client/reports` | employer | JSON; owners, hiring managers and viewers; money for owners only |
| GET | `/api/client/team` | employer | JSON; the company's members; emails for owners only |
| GET | `/employer/contracts` | employer | Owners and hiring managers |
| GET | `/employer/contracts/:id` | employer | 404 for other companies' contracts; drafts never shown |
| POST | `/employer/contracts/:id/sign` | employer | Owners only; the page sends the SHA-256 of the text shown |
| POST | `/employer/contracts/:id/request-changes` | employer | Owners only |
| GET | `/employer/invoices` | employer | Owners (billing permission) |
| GET | `/employer/reports` | employer | Owners, hiring managers and viewers |
| POST | `/employer/requisitions/bulk` | employer | Owners and hiring managers; one role per line, checked whole |
| GET | `/employer/ats` | employer | Pipeline board and table for the company's own jobs this member may see |
| GET | `/employer/ats/reports` | employer | Metrics for the jobs this member may see; team workload for owners and hiring managers |
| POST | `/employer/applicants/:id/notes` | employer | Internal notes: owners, or managers and recruiters on the job; never shown to candidates |
| POST | `/employer/applicants/:id/assign` | employer | Owners, or hiring managers on the job; only to people who work on the job |
| POST | `/employer/applicants/:id/interviews/:ivId/reschedule` | employer | People working on the job (interviews.manage); same timing and clash rules as booking; the candidate is asked to confirm the new time |
| POST | `/employer/applicants/:id/interviews/:ivId/cancel` | employer | Owners, or managers and recruiters on the job; the candidate gets a calendar cancellation |
| POST | `/employer/applicants/:id/interviews/:ivId/feedback` | employer | Owners, or managers and recruiters on the job; after the interview starts |
| POST | `/employer/applicants/:id/offers` | employer | Owners, or managers and recruiters on the job; waits for approval |
| POST | `/employer/applicants/:id/offers/:offerId/:action` | employer | approve/reject: owners or hiring managers (not their own offer unless owner); accepted/declined/withdraw: people working on the job |
| GET | `/api/ats/jobs/:id/applications` | employer | 401 when signed out; 404 unless this member may see the job; filters: stage, skills, experience, location |
| GET | `/api/ats/applications/:id` | employer | 401 when signed out; contact details, notes, offers and scorecards only for people allowed to see them |
| PATCH | `/api/ats/applications/:id/stage` | employer | Workflow moves only (409 otherwise); corrections need an owner and a reason |
| POST | `/api/ats/applications/:id/assign` | employer | Owners, or hiring managers on the job |
| POST | `/api/ats/applications/:id/notes` | employer | Owners, or managers and recruiters on the job |
| POST | `/api/ats/applications/:id/interviews` | employer | Owners, or managers and recruiters on the job; scheduling rules checked |
| POST | `/api/ats/interviews/:ivId/feedback` | employer | Owners, or managers and recruiters on the job |
| POST | `/api/ats/interviews/:ivId/reschedule` | employer | JSON; the interview must belong to an applicant the member may see, and their role must allow interviews.manage |
| POST | `/api/ats/applications/:id/offers` | employer | Owners, or managers and recruiters on the job |
| POST | `/api/ats/offers/:offerId/approve` | employer | Owners, or hiring managers on the job (not their own offer unless owner) |
| POST | `/api/ats/offers/:offerId/response` | employer | Owners, or managers and recruiters on the job; only approved offers |
| GET | `/api/ats/analytics` | employer | 401 when signed out; metrics for the jobs this member may see |
| GET | `/employer/candidates` | employer | Owners, hiring managers and recruiters of a verified company; only candidates who chose to be found, without contact details, resumes or past employers |
| POST | `/employer/candidates/:id/invite` | employer | Invites a findable candidate to one of the company's own open jobs; once per candidate and job, 30 a day per company; recorded in the activity log |
| GET | `/api/employers/candidates` | employer | JSON; same rules as the page; a job to match must be one of the company's own |
| POST | `/api/employers/candidates/:id/invites` | employer | JSON; same rules as the page |
| GET | `/employer/jobs` | employer | Jobs this member may see: all for owners and viewers, assigned or own jobs for others |
| GET | `/employer/jobs/new` | employer | Owners and hiring managers |
| POST | `/employer/jobs` | employer | Owners and hiring managers |
| GET | `/employer/jobs/:id/edit` | employer | Own company's jobs only; owners, or hiring managers on jobs assigned to them |
| POST | `/employer/jobs/:id` | employer | Owners, or hiring managers on assigned jobs; a live job goes back for review |
| POST | `/employer/jobs/:id/publish` | employer | Owners, or hiring managers on assigned jobs; needs a verified mobile (self-signup companies) and is within job limits |
| POST | `/employer/jobs/:id/pause` | employer | Owners, or hiring managers on assigned jobs; recorded in the activity log |
| POST | `/employer/jobs/:id/resume` | employer | Owners, or hiring managers on assigned jobs |
| POST | `/employer/jobs/:id/close` | employer | Owners, or hiring managers on assigned jobs |
| GET | `/employer/applicants` | employer | Applicants to the company's own jobs this member may see; contact details only for people working on the job |
| GET | `/employer/applicants/:id` | employer | Same; opening it is recorded in the activity log |
| GET | `/employer/applicants/:id/resume` | employer | Owners, or managers and recruiters on the job; signed link, valid 15 minutes; recorded |
| POST | `/employer/applicants/:id/status` | employer | Owners, or managers and recruiters on the job; kept in the application history |
| GET | `/employer/applicants/:id/interview` | employer | Owners, or managers and recruiters on the job |
| POST | `/employer/applicants/:id/interview` | employer | Owners, or managers and recruiters on the job; emails the candidate |
| GET | `/employer/interviews` | employer | Interviews for jobs this member may see |
| GET | `/api/employers/jobs` | employer | 401 when signed out; jobs this member may see |
| POST | `/api/employers/jobs/:id/close` | employer | Same |
| GET | `/api/employers/jobs/:id/applications` | employer | 401 when signed out; 404 unless this member may see the job's applicants |
| PATCH | `/api/employers/applications/:id/status` | employer | 401 when signed out; owners, or managers and recruiters on the job |
| POST | `/api/employers/interviews` | employer | 401 when signed out; owners, or managers and recruiters on the job |
| GET | `/employer/register` | public |  |
| POST | `/employer/register` | public | Bot trap, per-IP limit; same reply whether or not the email has an account |
| POST | `/api/employers/register` | public | Bot trap, per-IP limit; same reply whether or not the email has an account |
| GET | `/employer/login` | public |  |
| POST | `/employer/login` | public | Per-IP limit; same reply for unknown emails and wrong passwords |
| POST | `/employer/logout` | public |  |
| GET | `/employer/forgot` | public |  |
| POST | `/employer/forgot` | public |  |
| POST | `/employer/switch` | employer | Only companies the person is a member of |
| GET | `/employers` | public | Moved (301) to the matching /employer page |
| GET | `/employers/register` | public | Moved (301) to the matching /employer page |
| GET | `/employers/login` | public | Moved (301) to the matching /employer page |
| GET | `/employers/dashboard` | public | Moved (301) to the matching /employer page |
| GET | `/employers/company-profile` | public | Moved (301) to the matching /employer page |
| GET | `/employers/jobs` | public | Moved (301) to the matching /employer page |
| GET | `/employers/jobs/create` | public | Moved (301) to the matching /employer page |
| GET | `/employers/applicants` | public | Moved (301) to the matching /employer page |
| GET | `/employers/ats` | public | Moved (301) to the matching /employer page |
| GET | `/employers/interviews` | public | Moved (301) to the matching /employer page |
| GET | `/employers/team` | public | Moved (301) to the matching /employer page |
| GET | `/employers/settings` | public | Moved (301) to the matching /employer page |
| GET | `/employers/jobs/:id/edit` | public | Moved (301) to the matching /employer page |
| POST | `/employer/requirements` | employer | Owners and hiring managers |
| GET | `/employer/company` | employer | Every member can see it |
| POST | `/employer/company` | employer | Company owners only |
| POST | `/employer/company/verify` | employer | Company owners only |
| GET | `/employer/team` | employer | Every member; the activity log for owners only |
| POST | `/employer/team` | employer | Company owners only; up to 50 members |
| POST | `/employer/team/:id` | employer | Company owners only; the last owner stays an owner |
| POST | `/employer/team/:id/remove` | employer | Company owners only; the last owner can't be removed |
| GET | `/employer/settings` | employer | The signed-in person's own details |
| POST | `/employer/settings` | employer | A new mobile number needs verifying again |
| POST | `/employer/settings/phone/send` | employer | 6-digit code by text message, valid 10 minutes; 5 per hour |
| POST | `/employer/settings/phone/verify` | employer | 5 tries per code |
| POST | `/employer/settings/password` | employer | Needs the current password; signs out other sessions |
| GET | `/api/employers/me` | employer | 401 when signed out |
| PATCH | `/api/employers/me` | employer | 401 when signed out; company owners only; unknown fields refused |
| GET | `/api/client/company-profile` | employer | JSON; same as /api/employers/me |
| PATCH | `/api/client/company-profile` | employer | JSON; owners only; same as PATCH /api/employers/me |
| GET | `/employer` | employer | Dashboard for the signed-in person’s current company; billing for owners only |
| GET | `/employer/resume/:appId` | employer | Candidates shared with this company; owners, managers and recruiters; signed link, valid 15 minutes |
| POST | `/employer/candidates/:appId/feedback` | employer | Candidates shared with this company; owners, managers and recruiters |
| GET | `/employer/invoices/:id` | employer | Company owners only; this company's invoices |
| GET | `/employer/invoices/:id/credit-notes/:cnId` | employer | Company owners only; this company's invoices |
| GET | `/employers/contact` | public | Moved (301) to /hire |
| POST | `/employer/timesheets/:pid/:tsId/approve` | employer | Owners and hiring managers; this company's placements |
| POST | `/employer/timesheets/:pid/:tsId/reject` | employer | Owners and hiring managers; this company's placements |
| GET | `/employer/workforce` | employer | The company's workers on assignment; site supervisors only those they supervise; no pay rates, emails or documents |

## Notifications (any signed-in account)

| Method | Path | Policy | Notes |
| --- | --- | --- | --- |
| GET | `/notifications` | account | The signed-in person's own notifications only (candidate, employer or team, chosen with ?as= when signed in as more than one); employer people see their current company's, filtered by their current role |
| GET | `/notifications/:id/open` | account | Marks one of your own notifications read and goes to its link (links are checked to stay on this site) |
| POST | `/notifications/read-all` | account | Your own notifications only |
| POST | `/notifications/:id/read` | account | Your own notifications only; anyone else's is not found |
| GET | `/notifications/settings` | account | Your own email preferences |
| POST | `/notifications/settings` | account | Your own email preferences; only optional categories can be switched off |
| GET | `/api/notifications` | account | JSON; your own notifications, filters unread and category |
| GET | `/api/notifications/unread-count` | account | JSON; your own unread count |
| PATCH | `/api/notifications/:id/read` | account | JSON; 404 for anyone else's notification |
| POST | `/api/notifications/read-all` | account | JSON; your own notifications only |
| GET | `/api/notification-preferences` | account | JSON; your own preferences |
| PATCH | `/api/notification-preferences` | account | JSON; only applications, interviews and jobs email can be changed, as true or false |

## Admin panel: any team member

| Method | Path | Policy | Notes |
| --- | --- | --- | --- |
| GET | `/admin/clients` | team | Short link to the Clients tab |
| GET | `/admin/clients/:id` | team | One client: account manager, contracts (terms for roles that see them), requisitions and portal requests |
| POST | `/admin/clients/:id/account-manager` | team | Admins only (checked in the handler); must be an Admin or Account Manager on the team |
| POST | `/admin/clients/:id/contracts` | team | Admins, or the client's own Account Manager; fees written exactly, nothing assumed |
| POST | `/admin/contracts/:id` | team | Admins, or the client's own Account Manager: make active or end |
| GET | `/admin/requisitions` | team | Requisition permission; Recruiters see only those assigned to them |
| POST | `/admin/requisitions` | team | Admins, Recruitment Managers and Account Managers (their own clients); contract and job must be the client's |
| GET | `/admin/requisitions/:id` | team | Recruiters only if assigned (otherwise 404) |
| POST | `/admin/requisitions/:id` | team | Change details or status; only allowed moves; managers of that requisition |
| POST | `/admin/requisitions/:id/recruiters` | team | Admins and Recruitment Managers; active team members except Finance |
| POST | `/admin/hire-requests/:id/requisition` | team | Turns a client's portal request into a requisition |
| GET | `/admin/workspace` | team | The signed-in person's requisitions, placements and workers; workload for managers |
| GET | `/admin/staffing` | team | Staffing permission; rates only for roles that see money |
| POST | `/admin/staffing` | team | Temporary or contract placements billed per assignment; no overlapping dates for one worker |
| POST | `/admin/staffing/:id` | team | Only allowed status moves; billed rates and periods stay as billed |
| POST | `/admin/staffing/:id/invoice-draft` | team | Past days only, inside the assignment, no period billed twice |
| GET | `/admin/invoice-drafts` | team | Roles that may ask for invoices; issuing needs Admin or Finance Manager |
| POST | `/admin/placements/:id/invoice-draft` | team | Joined placements with a one-time fee; the same fee gives the same draft |
| POST | `/admin/invoice-drafts/:id/issue` | team | Admins and Finance Managers; issuing twice returns the first invoice |
| POST | `/admin/invoice-drafts/:id/discard` | team | Only drafts not yet issued |
| GET | `/admin/recruitment-reports` | team | Report permission; money only for Admins, Account Managers and Finance Managers |
| GET | `/admin/agency-audit` | team | Admins, Recruitment Managers and Finance Managers; read only |
| GET | `/api/clients` | team | JSON; any team member; no contact details |
| GET | `/api/clients/:id` | team | JSON; contract terms only for roles that see them |
| PUT | `/api/clients/:id/account-manager` | team | JSON; Admins only |
| POST | `/api/clients/:id/contracts` | team | JSON; Admins or the client's Account Manager; unknown fields refused |
| PATCH | `/api/contracts/:id` | team | JSON; Admins or the client's Account Manager |
| GET | `/api/requisitions` | team | JSON; Recruiters see only their own |
| POST | `/api/requisitions` | team | JSON; same rules as the page; unknown fields refused |
| GET | `/api/requisitions/:id` | team | JSON; 404 when not visible to the person |
| PATCH | `/api/requisitions/:id` | team | JSON; same rules as the page |
| PUT | `/api/requisitions/:id/recruiters` | team | JSON; Admins and Recruitment Managers |
| GET | `/api/placements` | team | JSON; fees and invoices only for roles that see money |
| GET | `/api/placements/:id/invoices` | team | JSON; issued invoices and drafts |
| POST | `/api/placements/:id/invoices` | team | JSON; creates a draft only (never an invoice); Idempotency-Key header supported |
| POST | `/api/placements/:id/invoices/:draftId/issue` | team | JSON; Admins and Finance Managers; idempotent |
| DELETE | `/api/placements/:id/invoices/:draftId` | team | JSON; discards a draft not yet issued |
| GET | `/api/staffing/assignments` | team | JSON; rates only for roles that see money |
| POST | `/api/staffing/assignments` | team | JSON; same rules as the page |
| PATCH | `/api/staffing/assignments/:id` | team | JSON; same rules as the page |
| GET | `/api/recruitment/reports` | team | JSON; report permission; money only for roles that see it |
| GET | `/api/recruitment/audit` | team | JSON; Admins, Recruitment Managers and Finance Managers |
| POST | `/admin/templates` | team |  |
| POST | `/admin/templates/:id` | team |  |
| POST | `/admin/applications/bulk` | team |  |
| POST | `/admin/applications/bulk-email` | team |  |
| GET | `/api/contracts/:id/versions` | team | JSON; roles that see contracts |
| POST | `/api/contracts/:id/versions` | team | JSON; Admins or the client's Account Manager; one version in progress at a time |
| PATCH | `/api/contract-versions/:id` | team | JSON; drafts only |
| POST | `/api/contract-versions/:id/:action` | team | JSON; submit, send (by someone other than the author, after review), back or terminate (with a reason) |
| GET | `/admin/clients/:id/contract-documents` | team | Roles that see contracts (checked in the handler) |
| POST | `/admin/contracts/:id/versions` | team | Admins or the client's Account Manager (checked in the handler) |
| POST | `/admin/contract-versions/:id/:action` | team | Same rules as the JSON API |
| POST | `/admin/jobs/:id/approve` | team | jobs.review; only for verified companies; tells the job's poster and the company owners; recorded in the trust audit trail |
| POST | `/admin/jobs/:id/reject` | team | jobs.review; reason sent to the employer; recorded in the trust audit trail |
| POST | `/admin/clients` | team |  |
| POST | `/admin/clients/:id/invite` | team |  |
| POST | `/admin/clients/:id/toggle` | team | Not for companies suspended or closed by trust & safety |
| POST | `/admin/clients/:id/approve` | team | verify.review; recorded in the trust audit trail |
| POST | `/admin/clients/:id/reject` | team | verify.review; the company is emailed the reason and an appeal link |
| POST | `/admin/applications/:id/share` | team |  |
| POST | `/admin/applications/:id/unshare` | team |  |
| GET | `/admin/applications/:id/interview` | team |  |
| POST | `/admin/applications/:id/interview` | team |  |
| GET | `/admin/interviews/:appId/:ivId/feedback` | team |  |
| POST | `/admin/interviews/:appId/:ivId/feedback` | team |  |
| POST | `/admin/interviews/:appId/:ivId/cancel` | team |  |
| POST | `/admin/interviews/:appId/:ivId/reschedule` | team | Moves a scheduled interview; the candidate gets the updated calendar invite |
| GET | `/admin/interviews/:appId/:ivId.ics` | team |  |
| GET | `/admin/applications/:id/placement` | team |  |
| POST | `/admin/applications/:id/placement` | team |  |
| GET | `/admin/placements/:id/edit` | team |  |
| POST | `/admin/placements/:id` | team |  |
| POST | `/admin/placements/:id/status` | team |  |
| GET | `/admin/placements/:id/replacement` | team |  |
| GET | `/admin/site-analytics` | team | site.analytics (Admins, recruitment, account and sales managers, business development); daily counts only |
| GET | `/admin/applications/new` | team | Add someone who applied by WhatsApp, phone, walk-in or referral |
| POST | `/admin/applications/new` | team | Add someone who applied by WhatsApp, phone, walk-in or referral |
| GET | `/admin` | team | Recruiters never get the Settings, Team or Activity tabs, and see Reports without money |
| GET | `/admin/jobs/new` | team |  |
| GET | `/admin/jobs/:id/edit` | team |  |
| POST | `/admin/jobs` | team |  |
| POST | `/admin/jobs/:id` | team |  |
| POST | `/admin/jobs/:id/toggle` | team | Not for listings restricted or removed by trust & safety |
| GET | `/admin/blog/new` | team |  |
| GET | `/admin/blog/:slug/edit` | team |  |
| POST | `/admin/blog` | team |  |
| POST | `/admin/blog/:slug` | team |  |
| POST | `/admin/applications/:id/status` | team |  |
| GET | `/admin/reports/:section.csv` | team | Money figures only for Admins (checked in the handler) |
| GET | `/admin/export/:type.csv` | team | Placements and Activity exports are Admin only (checked in the handler) |
| GET | `/admin/resume/:file` | team | Any team member can download any resume; signed link, valid 15 minutes |
| GET | `/admin/security` | team | Your own account only. Still reachable when the team rule blocks everything else |
| POST | `/admin/security/start` | team | Your own account only |
| POST | `/admin/security/confirm` | team | Your own account only |
| POST | `/admin/security/recovery` | team | Your own account only; needs a current code |
| POST | `/admin/security/off` | team | Your own account only; needs a current code; refused while the team requires it |
| GET | `/admin/workforce` | team | Workforce permission; Recruiters see onboarding status only |
| GET | `/admin/workforce/payroll` | team | Admins and Finance Managers; approved timesheets at the pay rate |
| GET | `/admin/workforce/payroll.csv` | team | Admins and Finance Managers; logged |
| GET | `/admin/workforce/:section` | team | Onboarding for the workforce permission; shifts, attendance, timesheets and rules for workforce managers; activity for audit roles |
| GET | `/admin/workforce/workers/:id` | team | Documents only for Admins and Staffing Managers; Account Managers only for their clients' workers |
| GET | `/admin/workforce/documents/:id/file` | team | Admins and Staffing Managers, through a signed link that lasts 15 minutes; every opening logged |
| POST | `/admin/workforce/requirements` | team | Workforce managers (checked in the handler); same rules as PUT /api/staffing/requirements |
| POST | `/admin/workforce/sites` | team | Workforce managers or the client's Account Manager (checked in the handler) |
| POST | `/admin/workforce/rules` | team | Admins only (checked in the handler) |
| POST | `/admin/workforce/scan` | team | Workforce managers: runs the hourly checks now |

## Admin panel: Admins only

| Method | Path | Policy | Notes |
| --- | --- | --- | --- |
| POST | `/admin/templates/:id/delete` | admin |  |
| GET | `/admin/notifications` | admin | Email delivery monitor: queue, retries, failures, bounces (no addresses shown) |
| POST | `/admin/notifications/:id/retry` | admin | Queues a failed email again |
| POST | `/admin/notifications/suppressions/:id/delete` | admin | Lets a bounced address receive emails again |
| POST | `/admin/placements/:id/delete` | admin |  |
| POST | `/admin/jobs/:id/delete` | admin |  |
| POST | `/admin/settings` | admin |  |
| POST | `/admin/blog/:slug/delete` | admin |  |
| POST | `/admin/:type/:id/delete` | admin | Inbox entries: applications, hire requests, contacts, newsletter, job alerts |
| GET | `/admin/backup` | admin |  |
| GET | `/admin/backups/:name` | admin |  |
| POST | `/admin/backups/run` | admin |  |
| POST | `/admin/resumes/reindex` | admin |  |
| POST | `/admin/team` | admin |  |
| POST | `/admin/team/:id/role` | admin |  |
| POST | `/admin/team/:id/toggle` | admin |  |
| POST | `/admin/team/:id/reset-2fa` | admin |  |
| POST | `/admin/team/require-2fa` | admin |  |
| POST | `/admin/team/:id/invite` | admin |  |
| POST | `/admin/placements/:id/timesheets/:tsId/approve` | admin |  |
| POST | `/admin/placements/:id/timesheets/:tsId/reject` | admin |  |

## Billing: Admins and Finance Managers

| Method | Path | Policy | Notes |
| --- | --- | --- | --- |
| POST | `/admin/placements/:id/invoice` | billing |  |
| GET | `/admin/placements/:id/bill` | billing |  |
| POST | `/admin/placements/:id/bill` | billing |  |
| POST | `/admin/placements/:id/invoice/cancel` | billing |  |
| GET | `/admin/placements/:id/payments` | billing |  |
| POST | `/admin/placements/:id/payments` | billing |  |
| POST | `/admin/placements/:id/payments/:payId/delete` | billing |  |
| POST | `/admin/placements/:id/refunds` | billing |  |
| POST | `/admin/placements/:id/refunds/:refundId/delete` | billing |  |
| POST | `/admin/placements/:id/remind` | billing |  |
| POST | `/admin/placements/:id/credit-notes` | billing |  |
| GET | `/admin/placements/:id/invoice` | billing |  |
| GET | `/admin/placements/:id/credit-notes/:cnId` | billing |  |
