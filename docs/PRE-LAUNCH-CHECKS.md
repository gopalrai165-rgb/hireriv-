# Pre-launch checks

The technical and legal checks to finish before Hireriv goes live. Each row says
what the software already does, which automated tests prove it (run `npm test`),
and what still has to be done by hand or by the owner. The wider launch plan is
in [LAUNCH.md](LAUNCH.md).

## Content and trust (do these first)

| Check | Where | Owner action |
|---|---|---|
| No sample jobs | A new site starts with no jobs; older sites lost their unchanged "Sample listing" jobs (Step 115) | Post real, employer-approved vacancies |
| No made-up figures or testimonials | Figures and testimonials appear only when entered in Admin → Settings | Add figures only from your own records, and testimonials only with the person's permission |
| Real company details | Admin → Settings → Contact details and About the company; placeholder phone, WhatsApp and address are never shown | Enter the real phone, WhatsApp number, office address, CIN, company background and team |

## Technical and legal

| Feature | Required check | What the site does | Tests | Still to do by hand |
|---|---|---|---|---|
| Job applications | Application reaches recruiter | Every application is saved, emailed to the team inbox, shown in Admin → Applications and, for employer jobs, in the employer's Applicants list; the job seeker gets a confirmation | `seeker`, `accounts`, `quick-apply`, `employer-jobs`, `notifications` | Send one real application from a phone and check it arrives in the team inbox |
| Employer enquiries | Request reaches the team | Saved in Admin → Hire requests with a follow-up status, emailed to the team, stored as a CRM lead; the employer gets an acknowledgement email | `hire-form`, `homepage`, `crm` | Send one enquiry and check both emails arrive |
| Resume upload | Secure storage and access permissions | PDF/Word only, checked by file signature, optional virus scan (ClamAV), encrypted on disk, downloaded only by the team or the job's employer through links that expire after 15 minutes | `safety`, `security-privacy`, `access` | Set `FILE_ENCRYPTION_KEY` and keep a copy of it outside the server |
| Employer dashboard | Job posting and candidate management | Post jobs (reviewed by the team before going live), preview, applicants with stages, interviews, messages, team members | `employer-jobs`, `employer-workspace`, `ats` | One real employer posts a job and moves an applicant through the stages |
| Candidate dashboard | Applications and profile updates | Seven-step start list, profile with resume, saved jobs, applied jobs with status, interviews, job alerts | `accounts`, `candidate-profile`, `candidate-journey` | |
| Login | OTP, password reset and logout | Email links and passwords; mobile codes for job seekers and employers once an SMS provider is set; password reset by email; sign out and "sign out on all devices"; two-step sign-in for the team | `accounts`, `seeker`, `sms`, `two-step` | Choose an SMS provider and finish DLT registration (README → Text messages), then sign in with a code on a real phone |
| WhatsApp | Correct contact and consent | The WhatsApp button uses the number in Settings and is hidden while it is the placeholder; job seekers' WhatsApp updates only with their recorded consent | `services`, `candidate-journey` | Enter the real business WhatsApp number; optionally set `WHATSAPP_PROVIDER` (README → WhatsApp updates) |
| Mobile | All pages work on Android and iPhone | Pages checked at a 390px phone size in Chrome's device mode during development; large tap targets; no sideways scrolling | `mobile`, `easy-to-use` | Open the home, Find Jobs, a job, apply, sign-up, Hire a Team and employer pages on one real Android phone (Chrome) and one iPhone (Safari) |
| Security | SSL, spam protection and backups | HTTPS through Caddy (`scripts/server-setup.sh`) with HSTS; security headers and CSP; rate limits and a hidden spam field on every form; daily database and upload backups with a weekly restore drill | `security-privacy`, `backups`, `launch` | Confirm the certificate after DNS points to the server; copy backups off the server (`BACKUP_DIR` on another disk or synced) |
| Privacy | Candidate consent and data deletion | Consent recorded for each purpose (visibility, employer contact, WhatsApp, SMS, marketing); "Download my data" and "Delete my account" in Settings; privacy requests for people without accounts; optional data retention | `security-privacy`, `retention` | Name the Grievance Officer in Admin → Settings (shown in the privacy policy and terms) and read both with a lawyer |
| Payments | Correct invoices and payment records, if applicable | GST invoices with numbering, credit notes, payment records and Razorpay checkout and webhooks | `billing` | Before charging anyone: enter the GSTIN and legal business name in Admin → Settings, set Razorpay live keys, and have an accountant check one invoice (including the SAC codes 998512 and 998513 the site uses) |
| SEO | Titles, descriptions, sitemap, robots, canonical, job schema | Checked for every page in the sitemap | `seo-pages`, `website` | Verify in Google Search Console and submit the sitemap (README → Google) |

## Before switching on

1. `npm test` passes.
2. `npm run check:config` on the server shows no errors.
3. The owner rows above are done, and one person has gone through the job seeker and employer paths on a real phone.
