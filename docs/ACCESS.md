# Routes and access

Every route the app serves, and who may use it. **This table is checked by `test/access.test.js`**: adding, removing or changing the protection of a route without updating this file fails the tests.

| Policy | Who | How it is enforced |
| --- | --- | --- |
| public | Anyone | Public forms (`/api/*`) have a bot trap and a per-IP rate limit |
| link | Whoever holds a one-time emailed link | Random 256-bit token, stored hashed, single-use or expiring |
| candidate | A candidate signed in with an emailed link (`hr_cand` session) | `requireCandidate`; data is limited to applications made with their email |
| employer | A client signed in to the client portal | `requireEmployer`; data is limited to their own company |
| team | Anyone on the recruiting team (Admin or Recruiter) | `adminAuth` (+ two-step sign-in when the team requires it) |
| admin | Team members with the Admin role | `adminAuth` + `requireAdmin` (403 for Recruiters) |

Every state-changing team, candidate and client form also passes `sameOrigin` (cross-site posts are refused).

Total: 159 routes.

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
| GET | `/post-a-job` | public | Signed-in client: /employer#new-requirement; anyone else: /hire#requirement |

## One-time links

| Method | Path | Policy | Notes |
| --- | --- | --- | --- |
| GET | `/account/verify/:token` | link | One-time emailed sign-in link |
| POST | `/account/verify/:token` | link | One-time emailed sign-in link |
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

## Candidate portal (My applications)

| Method | Path | Policy | Notes |
| --- | --- | --- | --- |
| GET | `/account/register` | public |  |
| POST | `/account/register` | public | Same reply whether or not the email has an account; opened only by the emailed link |
| GET | `/account/login` | public |  |
| POST | `/account/login` | public |  |
| POST | `/account/logout` | public |  |
| GET | `/account` | candidate |  |
| POST | `/account/apply/:jobId` | candidate | Applies with the signed-in candidate's own profile and resume |
| POST | `/account/resume` | candidate | Replaces the signed-in candidate's own resume |
| POST | `/account/alerts` | candidate |  |
| POST | `/account/alerts/:id/delete` | candidate | Only the candidate's own job alerts |
| GET | `/api/candidate/saved-jobs` | candidate | 401 when signed out; only the candidate's own saved jobs |
| PUT | `/api/candidate/saved-jobs/:jobId` | candidate | 401 when signed out; only the candidate's own saved jobs |
| DELETE | `/api/candidate/saved-jobs/:jobId` | candidate | 401 when signed out; only the candidate's own saved jobs |
| GET | `/api/candidate/applications` | candidate | 401 when signed out; only the candidate's own applications, without contact details |
| GET | `/account/my-data.json` | candidate | Only the signed-in email's own data |
| GET | `/account/resume/:appId` | candidate | Only the candidate's own applications |
| GET | `/account/interviews/:appId/:ivId.ics` | candidate | Only the candidate's own interviews |
| POST | `/account/profile` | candidate |  |
| POST | `/account/applications/:id/withdraw` | candidate | Only the candidate's own applications |
| POST | `/account/delete` | candidate |  |
| GET | `/account/timesheets/:pid` | candidate | Only the contractor's own placement |
| POST | `/account/timesheets/:pid` | candidate | Only the contractor's own placement |

## Client portal

| Method | Path | Policy | Notes |
| --- | --- | --- | --- |
| GET | `/employer/login` | public |  |
| POST | `/employer/login` | public |  |
| POST | `/employer/logout` | public |  |
| GET | `/employer/forgot` | public |  |
| POST | `/employer/forgot` | public |  |
| GET | `/employer` | employer |  |
| POST | `/employer/requirements` | employer |  |
| GET | `/employer/resume/:appId` | employer | Only candidates shared with this client |
| POST | `/employer/candidates/:appId/feedback` | employer | Only candidates shared with this client |
| GET | `/employer/invoices/:id` | employer | Only this client's invoices |
| GET | `/employer/invoices/:id/credit-notes/:cnId` | employer | Only this client's invoices |
| POST | `/employer/timesheets/:pid/:tsId/approve` | employer | Only this client's placements |
| POST | `/employer/timesheets/:pid/:tsId/reject` | employer | Only this client's placements |

## Admin panel: any team member

| Method | Path | Policy | Notes |
| --- | --- | --- | --- |
| POST | `/admin/templates` | team |  |
| POST | `/admin/templates/:id` | team |  |
| POST | `/admin/applications/bulk` | team |  |
| POST | `/admin/applications/bulk-email` | team |  |
| POST | `/admin/clients` | team |  |
| POST | `/admin/clients/:id/invite` | team |  |
| POST | `/admin/clients/:id/toggle` | team |  |
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
| GET | `/admin/resume/:file` | team | Any team member can download any resume |
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
