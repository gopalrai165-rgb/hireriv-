# Routes and access

Every route the app serves, and who may use it. **This table is checked by `test/access.test.js`**: adding, removing or changing the protection of a route without updating this file fails the tests.

| Policy | Who | How it is enforced |
| --- | --- | --- |
| public | Anyone | Public forms (`/api/*`) have a bot trap and a per-IP rate limit |
| link | Whoever holds a one-time emailed link | Random 256-bit token, stored hashed, single-use or expiring |
| candidate | A candidate signed in with an emailed link or their password (`hr_cand` session: HttpOnly, SameSite=Lax, Secure on https) | `requireCandidate`; data is limited to applications made with their email |
| employer | A person signed in to the employer portal, working in one of their companies (`hr_emp` session) | `requireEmployer` + their role in that company (owner, hiring manager, recruiter, viewer), checked on the server for every action; other companies' jobs and applicants are "not found" |
| team | Anyone on the recruiting team (Admin or Recruiter) | `adminAuth` (+ two-step sign-in when the team requires it) |
| admin | Team members with the Admin role | `adminAuth` + `requireAdmin` (403 for Recruiters) |

Every state-changing team, candidate and client form also passes `sameOrigin` (cross-site posts are refused).

Total: 256 routes.

## Public website

| Method | Path | Policy | Notes |
| --- | --- | --- | --- |
| GET | `/healthz` | public | Uptime check |
| GET | `/og/site.png` | public |  |
| GET | `/og/jobs/:id.png` | public |  |
| GET | `/robots.txt` | public |  |
| GET | `/sitemap.xml` | public |  |
| GET | `/` | public |  |
| GET | `/categories` | public | Job category groups with open-job counts |
| GET | `/staffing-solutions` | public | 301 to /services |
| GET | `/jobs` | public |  |
| GET | `/jobs/:id` | public |  |
| GET | `/saved` | public |  |
| GET | `/saved/cards` | public |  |
| GET | `/hire` | public |  |
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
| POST | `/api/contact` | public |  |
| GET | `/api/jobs` | public | Open, published jobs only (no samples); validated filters; 120 a minute per IP |
| GET | `/api/jobs/:id` | public | Open, published jobs only |
| POST | `/api/jobs/:id/report` | public | 5 per 10 minutes per IP |
| POST | `/api/job-alerts` | public |  |
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
| GET | `/account/timesheets/:pid` | candidate | Only the contractor's own placement |
| POST | `/account/timesheets/:pid` | candidate | Only the contractor's own placement |

## Employer portal (/employers/* addresses lead here)

| Method | Path | Policy | Notes |
| --- | --- | --- | --- |
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
| GET | `/employer` | employer | Dashboard for the signed-in person’s current company; billing for owners only |
| GET | `/employer/resume/:appId` | employer | Candidates shared with this company; owners, managers and recruiters; signed link, valid 15 minutes |
| POST | `/employer/candidates/:appId/feedback` | employer | Candidates shared with this company; owners, managers and recruiters |
| GET | `/employer/invoices/:id` | employer | Company owners only; this company's invoices |
| GET | `/employer/invoices/:id/credit-notes/:cnId` | employer | Company owners only; this company's invoices |
| POST | `/employer/timesheets/:pid/:tsId/approve` | employer | Owners and hiring managers; this company's placements |
| POST | `/employer/timesheets/:pid/:tsId/reject` | employer | Owners and hiring managers; this company's placements |

## Admin panel: any team member

| Method | Path | Policy | Notes |
| --- | --- | --- | --- |
| POST | `/admin/templates` | team |  |
| POST | `/admin/templates/:id` | team |  |
| POST | `/admin/applications/bulk` | team |  |
| POST | `/admin/applications/bulk-email` | team |  |
| POST | `/admin/jobs/:id/approve` | team | Only for verified companies; tells the job's poster and the company owners |
| POST | `/admin/jobs/:id/reject` | team |  |
| POST | `/admin/clients` | team |  |
| POST | `/admin/clients/:id/invite` | team |  |
| POST | `/admin/clients/:id/toggle` | team |  |
| POST | `/admin/clients/:id/approve` | team |  |
| POST | `/admin/clients/:id/reject` | team |  |
| POST | `/admin/applications/:id/share` | team |  |
| POST | `/admin/applications/:id/unshare` | team |  |
| GET | `/admin/applications/:id/interview` | team |  |
| POST | `/admin/applications/:id/interview` | team |  |
| GET | `/admin/interviews/:appId/:ivId/feedback` | team |  |
| POST | `/admin/interviews/:appId/:ivId/feedback` | team |  |
| POST | `/admin/interviews/:appId/:ivId/cancel` | team |  |
| GET | `/admin/interviews/:appId/:ivId.ics` | team |  |
| GET | `/admin/applications/:id/placement` | team |  |
| POST | `/admin/applications/:id/placement` | team |  |
| GET | `/admin/placements/:id/edit` | team |  |
| POST | `/admin/placements/:id` | team |  |
| POST | `/admin/placements/:id/status` | team |  |
| GET | `/admin/placements/:id/replacement` | team |  |
| GET | `/admin/applications/new` | team | Add someone who applied by WhatsApp, phone, walk-in or referral |
| POST | `/admin/applications/new` | team | Add someone who applied by WhatsApp, phone, walk-in or referral |
| GET | `/admin` | team | Recruiters never get the Settings, Team or Activity tabs, and see Reports without money |
| GET | `/admin/jobs/new` | team |  |
| GET | `/admin/jobs/:id/edit` | team |  |
| POST | `/admin/jobs` | team |  |
| POST | `/admin/jobs/:id` | team |  |
| POST | `/admin/jobs/:id/toggle` | team |  |
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

## Admin panel: Admins only

| Method | Path | Policy | Notes |
| --- | --- | --- | --- |
| POST | `/admin/templates/:id/delete` | admin |  |
| POST | `/admin/placements/:id/delete` | admin |  |
| POST | `/admin/placements/:id/invoice` | admin |  |
| GET | `/admin/placements/:id/bill` | admin |  |
| POST | `/admin/placements/:id/bill` | admin |  |
| POST | `/admin/placements/:id/invoice/cancel` | admin |  |
| GET | `/admin/placements/:id/payments` | admin |  |
| POST | `/admin/placements/:id/payments` | admin |  |
| POST | `/admin/placements/:id/payments/:payId/delete` | admin |  |
| POST | `/admin/placements/:id/refunds` | admin |  |
| POST | `/admin/placements/:id/refunds/:refundId/delete` | admin |  |
| POST | `/admin/placements/:id/remind` | admin |  |
| POST | `/admin/placements/:id/credit-notes` | admin |  |
| GET | `/admin/placements/:id/invoice` | admin |  |
| GET | `/admin/placements/:id/credit-notes/:cnId` | admin |  |
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
