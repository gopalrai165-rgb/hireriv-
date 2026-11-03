# Improvement roadmap: answer to the November 2026 website review

The review (3 November 2026) looked at the **live** site, which still runs the
code from before Step 115. Everything marked "Done" below is in this
repository and goes live with the next deploy (`git push`, then the usual
deploy). The stack is Node.js + Express with server-rendered EJS pages and
SQLite (PostgreSQL optional), not Next.js; nothing needs rebuilding.

Status: **Done** (in the code), **Step N** (built in that step of this plan),
**Owner** (a decision or task only the business can do; the site is ready for it).

## 1. Review findings

| Review item | Status | Where |
|---|---|---|
| Placeholder phone, address shown | Done | Placeholders are hidden everywhere until real ones are typed in Admin → Settings (Step 117) |
| Real phone, @hireriv.in email, office address | Owner | Admin → Settings; the admin to-do list asks until done |
| WhatsApp enquiry button | Done | Floating button, Employers page, service pages; appear once a real number is set |
| Working contact form, email delivery tested | Done / Owner | Forms, confirmation and team emails are tested; set SMTP and send one real test (PRE-LAUNCH-CHECKS.md) |
| "Brand operated by Raigozen Private Limited" | Done (Step 133) | Footer, About, Contact, Privacy, Terms |
| Made-up figures (1,200+, 98% …) and sample testimonials | Done | Removed (Step 115); figures and testimonials only from Settings, only real ones |
| About page story | Done | From Settings → About the company (Step 120); mission and vision added in Step 133 |
| Pricing / commercial explanation | Done | Employers page and service pages; prices from Settings (Step 124) |
| SLA, replacement policy, payment terms | Done (Step 134) | New Service terms page, numbers from Settings |
| Refund and cancellation policy | Done (Step 134) | Same page; needed because employer plans can be paid online |
| Downloadable company profile | Done (Step 135) | /company-profile and /company-profile.pdf |
| Employer onboarding guide | Done (Step 134) | "How an engagement starts" on the Service terms page |
| Example recruitment assignment | Owner | Only once a real assignment can be described with the client's permission |
| 72-hour shortlist, 1:3 ratio claims | Done | Removed (Step 115); the replacement period comes from Settings |
| Privacy policy, consent, deletion, retention | Done | Privacy policy, consent records, download and delete, optional retention |
| Named grievance officer | Done | Settings → Grievance Officer (Step 125) |
| Job posting rules, candidate safety, fraud reporting | Done | /job-posting-policy, safety advice on job seekers page and job pages, "Report this job" |
| Background verification consent | Owner | Only when the service starts; the service page already says checks need the candidate's consent |
| Legal review by an Indian lawyer | Owner | PRE-LAUNCH-CHECKS.md |
| Sample jobs on the job board | Done | Removed (Step 115) |
| Posted date, deadline, auto-expiry, report job, employer verification | Done | Job pages and cards; hourly expiry; Verified badge |
| Search Console, GA4, sitemap, robots, JobPosting data, Open Graph | Done | Step 121 and earlier; README → Google |
| City job pages | Done | /jobs/in/<city> and /jobs/in/<city>/<area>, listed only when they have jobs |
| Fresher jobs page | Done | /jobs/freshers |
| Remote jobs page | Done | /jobs/work-from-home; /jobs/remote leads there (Step 136) |
| "Recruitment agency in <city>" pages for employers | Done (Step 136) | /recruitment-agency/<city>, only for cities ticked in Settings → City recruitment pages, with the city's open jobs, localities and the enquiry form |
| Separate employer and job seeker journeys | Done | /employers (Step 123) and /job-seekers (Step 128) |
| Prominent WhatsApp, mobile navigation, empty and error states | Done | Floating WhatsApp, bottom navigation on phones, empty states on lists |
| Professional photography | Owner | Replace the stock images in public/img when real photos exist |
| Social media pages | Owner | Create them, then add the links in Settings (icons stay hidden until then) |

## 2. Roadmap phases

| Phase | Status |
|---|---|
| 0. Audit | Done: this document, docs/AUDIT.md, docs/PRE-LAUNCH-CHECKS.md |
| 1. Brand and business foundation | Done (Steps 133–135); logo files and business documents are Owner |
| 2. UI/UX | Done (Steps 116–128, 137–139: header, cards and photos, phone checks on every page type); keep checking each new page on a phone |
| 3. Recruitment platform | Done: candidate and employer accounts, jobs with draft, pending, open, paused, closed; applications with status history; admin, CRM, notifications |
| 4. Security and compliance | Done in code (docs/SECURITY.md); lawyer review is Owner |
| 5. SEO and marketing | Done in code; Search Console, GA4 IDs and social pages are Owner |
| 6. Testing and launch | Automated tests on every step; the hand checks are in PRE-LAUNCH-CHECKS.md |
| 7. Launch and growth | Owner; Admin → Reports and Hire requests show the numbers to watch |

## 3. Owner checklist before marketing

1. Push and deploy the latest code.
2. Admin → Settings: tick the cities you recruit in; real phone, WhatsApp, office address, @hireriv.in email, CIN, Grievance Officer, starting prices (optional), replacement and payment terms.
3. Set SMTP and send one test enquiry and one test application.
4. Have a lawyer read the Privacy Policy, Terms and Service terms.
5. Post the first genuine vacancies.
6. Verify the site in Google Search Console and submit the sitemap.
