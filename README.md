# Hireriv – Staffing & Recruitment Website

A complete website for a tech-driven staffing and recruitment company, built with Node.js, Express and EJS.

## Features
- **Home**: hero with job search, animated stats, services, industry tabs, 6-stage process, testimonials, FAQ, blog preview and CTAs
- **Find Work** (`/jobs`): keyword, category, location and work-mode filters (On-site, Hybrid, Remote, Field work, Client site) with job counts, job detail pages, and online applications with resume upload
- **Hire a Team** (`/hire`): employer requirement form, engagement models and the hiring process
- **About**, **Blog** (with articles) and **Contact** pages
- Newsletter signup, a floating WhatsApp button, and a mobile-responsive layout
- **Job alerts** (`/jobs`): candidates pick a category and/or city, confirm by email (double opt-in), then get an email the first time each matching job goes live. Remote jobs match every city. Every alert has a one-click unsubscribe, and subscribers are listed under Admin → Job alerts
- **Saved jobs** (`/saved`): a bookmark button on every job card and job page, with a count in the header. Saved jobs are stored in the visitor's browser, so no account is needed. Closed jobs stay listed and marked Closed, and deleted jobs drop off automatically
- **Spam protection**: every public form has a hidden bot trap and a per-IP limit (5–6 submissions per 10 minutes), and the admin locks out an IP for 15 minutes after 10 wrong passwords. Behind a reverse proxy, set `TRUST_PROXY=1` so limits apply per visitor
- **Share a job**: WhatsApp, LinkedIn, copy-link and the phone's share sheet on every open job, using the public `SITE_URL` address
- **My applications** (`/account`): candidates sign in with a one-time emailed link (no password) using the email they applied with. They see each application's progress in plain language, upcoming interviews with join link and calendar file, update their profile (skills, experience, city, notice, LinkedIn) across all applications, withdraw an application (interviews are cancelled and the team is emailed), and delete all their data (applications, resumes, job alerts, newsletter)
- **Client portal** (`/employer`): clients log in to see their roles with applicant counts by stage, their placements with guarantee end dates and invoices (view, print or save as PDF), send new hiring requirements (they arrive in Admin → Hire requests and by email) and follow their status. Passwords are hashed with scrypt, invite/reset links are single-use and expire, and logins are rate-limited
- **SEO**: Google for Jobs structured data (JobPosting) on every open job, Organization/WebSite/BlogPosting data, `/sitemap.xml`, `/robots.txt`, canonical and Open Graph tags. Closed jobs are removed from the sitemap and marked `noindex`
- **Admin panel** (`/admin`):
  - **Team logins**: everyone signs in at `/admin/login` with their own email and password; sessions last 12 hours and there's a Sign out link. Admins invite people from the **Team** tab (they get a one-time link to choose a password, valid for 3 days), change roles, resend links and deactivate accounts (which signs them out at once). **Admin** can do everything. **Recruiter** works jobs, candidates, interviews, shortlists and clients and records placements, but can't see or touch invoices, payments, billing totals, settings, the team, the activity log or backups, and can't delete records. The team always keeps at least one Admin, and 10 wrong passwords lock out an IP for 15 minutes
  - **Ownership**: each job has a recruiter owner, and its applicants belong to that owner unless you assign one directly on the application. Filter the Jobs and Applications tabs by Mine, Unassigned or any team member. Recruiters get a "My candidates" number on the dashboard
  - **Activity log** (Admins): every change made in the admin panel, with who made it and when (sign-ins, jobs posted, stage changes, invoices, payments, team changes). Filter it by person or export it as CSV. The latest 2,000 entries are kept
  - **Stage history & timeline**: every pipeline move is recorded with when, from, to and who, whether from the stage dropdown, bulk actions, booking an interview or recording a placement. Each application has a **Timeline** showing when they applied (and from where), stage moves, interviews, emails, client sharing and feedback, and withdrawal. The Applications CSV includes the history in readable form. Reports use the history for exact conversion figures and show the median first response (applied to first stage move)
  - **Reports**: choose a period (last 30 or 90 days, this or last financial year, last 12 months, all time) and see applications, placements and median time to hire (application to offer accepted). Charts show placements per month and, for Admins, billed per month, each with a table view. Also shows pipeline conversion (how far applications got), **source of hire**, and results by recruiter, job category and (Admins) top clients, each with a CSV download. Recruiters see the same reports without money. Source of hire comes from utm_source links (the WhatsApp, LinkedIn and copy-link share buttons and job-alert emails add one automatically) or the referring site, and is recorded with each new application
  - **Dashboard** (opens first): key numbers, a 14-day applications chart, the candidate pipeline funnel, most-applied jobs and recent activity
  - **Jobs**: post, edit, close/reopen and delete openings. Closed jobs drop out of listings, keep their page, and stop taking applications
  - **Bulk actions**: tick candidates on the Applications tab (or tick the header box to select every candidate on the page), then in one go move them to a stage (optionally emailing them the stage update), assign an owner, email them with a template, or delete them with their resumes (Admins only). You go back to the same filtered view afterwards
  - **Email templates** (Templates tab): reusable emails with placeholders ({first_name}, {name}, {job}, {company}, {location}, {recruiter}, {site_name}, {site_phone}). Four ready-made ones are included, and anyone on the team can add or edit them (only Admins can delete). Before sending you see a preview for a real candidate and can edit the text. Each candidate gets their own copy, replies go to the recruiter who sent it, withdrawn candidates are skipped, and the application shows when it was last emailed and by whom
  - **Applications pipeline**: move candidates through New → Screening → Interview → Offered → Hired / Rejected, add recruiter notes, filter by stage and download resumes
  - **Interviews**: book a video, phone or in-person interview from any application (India time). The candidate gets an email with a calendar invite (Accept/Decline in Gmail and Outlook) and moves to the Interview stage. The Interviews tab and dashboard show what is coming up; cancelling emails the candidate and removes it from their calendar. Each interview also has a downloadable .ics file for the interviewer
  - **Placements & invoicing**: when a candidate accepts an offer, click **Record placement** on their application to log the client, joining date, annual CTC and fee (a % of CTC or a fixed amount), and the replacement-guarantee period. The application moves to Hired. Track each placement as Awaiting joining → Joined (or Did not join / Left in guarantee). You can see who is still in their guarantee period, then issue a numbered GST invoice (`INV/2026-27/0001`, restarting each April) with CGST + SGST or IGST, the SAC code and the amount in words. Print it or save it as a PDF, and email it to a portal client. On each invoice's **Payments** page, record every payment with the amount received, the TDS the client deducted (pre-filled at your usual rate), the mode and the UTR/cheque reference. Invoices move from Unpaid to Part paid to Paid automatically, and overdue ones are flagged. Issue a numbered GST **credit note** (`CN/2026-27/0001`) when a candidate doesn't join, leaves in the guarantee period or the fee changes. It reverses GST at the invoice's rate, reduces the balance, and shows a refund due if the client has already paid. Issued invoices are never changed or deleted. An invoice with no payments can be cancelled and reissued (the old number stays on record). Once money or a credit note is recorded, corrections go through credit notes. The Placements tab shows the amount received and the TDS to claim for the financial year, and the CSV export adds received, TDS, credited, balance and refund columns. When you send an overpayment back, record it as a **refund** on the Payments page. Send a **payment reminder** email to portal clients from the Payments page or the placements list, or turn on automatic reminders in Settings (once a week, at most 4 per overdue invoice). When a candidate does not join or leaves in the guarantee period, **Record replacement** lets you pick the replacement hire (applicants for the same job are listed first). The client, billing details and guarantee carry over, the replacement is free by default, and both placements link to each other. **Contract staffing** placements can use **Monthly billing**: set the monthly bill rate and an optional contract end date. Then **Bill a month** issues one invoice per month (SAC 998513) with the deployed dates. Partial months are pro-rated by days (half days allowed), and you can add or deduct an adjustment such as overtime or unpaid leave. Each monthly invoice has its own payments, TDS, credit notes, reminders and cancel option. The Placements tab lists months still to bill, the Contracts filter shows active contracts, and the dashboard flags any finished month that has not been billed. **Contractor timesheets**: contractors on monthly-billed contracts sign in to My applications and log each week (full day, half day or off per date). Days outside the contract or in the future are blocked. The client approves the week, or sends it back with a note, in the client portal, and the contractor is emailed either way. For clients not on the portal the team is emailed and an Admin approves on the Bill a month page. Approved weeks are locked. Bill a month shows approved and pending days, pre-fills billable days from approved timesheets, and can bill by working days (rate × days ÷ Mon–Fri days in the month) or calendar days. The **Clients** tab shows each client's placements, amount billed, amount settled and amount outstanding. Your GSTIN, PAN, bank details, default fee %, guarantee days, GST rate and payment terms go under **Settings → Billing & invoices**. The dashboard shows billed this financial year, outstanding amounts and a follow-up list (joinings this week, guarantees ending, invoices to raise, overdue payments). Placements are kept even if a candidate deletes their data, because invoices are tax records
  - **Interview feedback**: a scorecard for each interview with an overall rating (1–5), a recommendation (Strong hire, Hire, No hire, Strong no hire), strengths and concerns. Anyone on the team can add one (one per person, editable). Add the interviewer's email when booking and they get the details plus a private no-login feedback link. It shows the candidate's name and role only (no contact details), works until two weeks after the interview, and stops working if the interview is cancelled. The team is emailed when they submit. The Interviews tab lists **Feedback due** and each interview's average score and majority recommendation (ties go to the latest scorecard). Applications show the latest verdict, feedback appears in the timeline, and the dashboard flags feedback due
  - **Clients**: add a client company and contact; they get an invite link to set a password for the **client portal** (`/employer/login`). Link jobs to a client from the job form. Resend invites or reset links, and deactivate a client to sign them out everywhere
  - **Shortlists**: share any candidate with a client (with a recruiter note). The client sees the profile, skills, match score and resume, but never the candidate's email or phone, and answers Interested / Maybe / Not a fit with a comment, which shows on the application and is emailed to the team
  - **Skill match**: candidates list their key skills when applying; each application shows a % match against the job's required skills (hover for matched/missing) and can be sorted by best match
  - **Talent pool**: one searchable record per candidate across all their applications. Search by name, skill, city, job or notes, filter by experience, notice period and stage, and rank the whole pool against any job to fill new roles from past applicants
  - **Blog**: write, edit and delete articles (title, link, category, date, summary, paragraphs) and keep drafts hidden until they are ready
  - **Settings**: edit phone, WhatsApp, email, address, hours, tagline, social links and the homepage stats. Changes go live instantly
  - Hiring requests, contact messages and newsletter signups, with delete on every entry
  - **Export CSV** on every tab (Excel-ready)
- **Email notifications**: your team is alerted on every application, hiring request and contact message (Reply-To is the sender), candidates get an "application received" email, and recruiters can email a candidate when they move to Interview, Offered, Hired or Rejected

## Run it
```bash
npm install
npm start            # http://localhost:3004
```
To enable the admin panel, set a password first:
```powershell
$env:ADMIN_PASS="choose-a-strong-password"; npm start   # PowerShell
```
Then open http://localhost:3004/admin/login and sign in as `admin` with that password. This is the built-in **owner** account (an Admin), and you can change the username with `ADMIN_USER`. From the **Team** tab, invite your recruiters so each person has their own login.

## Email setup
Without SMTP settings, every email is saved to `data/outbox/*.eml` (open these in Outlook or any mail app to preview them). To send real email, set these before `npm start`:

| Variable | Example | Notes |
|---|---|---|
| `SMTP_HOST` | `smtp.gmail.com` | Turns on real sending |
| `SMTP_PORT` | `587` | `465` uses SSL |
| `SMTP_USER` / `SMTP_PASS` | `you@gmail.com` / app password | Gmail needs an App Password |
| `MAIL_FROM` | `"Hireriv" <jobs@hireriv.com>` | Defaults to the site email in Admin → Settings |
| `NOTIFY_EMAIL` | `recruiters@hireriv.com` | Where team alerts go; defaults to the site email |
| `SITE_URL` | `https://hireriv.com` | Your live domain: used in emails, canonical URLs, the sitemap and job structured data. **Set it in production.** |

```powershell
$env:SMTP_HOST="smtp.gmail.com"; $env:SMTP_USER="you@gmail.com"; $env:SMTP_PASS="app-password"; $env:ADMIN_PASS="secret"; npm start
```

## Customise
| What | Where |
|---|---|
| Phone, email, address, WhatsApp, social links, stats | `/admin` → Settings |
| Job listings | `/admin` → Jobs |
| Job categories (16 built in, one per line) | `/admin` → Settings → Job categories |
| Job locations (32 built in, one per line) | `/admin` → Settings → Job locations |
| Blog posts | `/admin` → Blog |
| Colours & fonts | CSS variables at the top of `public/css/style.css` |
| Page content | `views/*.ejs` |
| Logo | `public/img/logo.svg` |

## Data & backups
Everything the site stores (jobs, blog posts, settings, applications, requests, messages, subscribers, client accounts and sign-in sessions) lives in one SQLite database, `data/hireriv.db`, using the SQLite built into Node.js (22.13 or newer), so there is nothing extra to install. Resumes are saved in `uploads/`.

- **First start:** the database is created and filled from `data/jobs.json`, `data/posts.json` and `data/site.json`. Any older `data/submissions/*.json` files are imported once, and the originals are left untouched.
- **Backups:** Admin → Settings → **Download database backup** gives a consistent copy you can take while the site is running. Back up `uploads/` too.
- **Location:** set `DB_FILE` to keep the database somewhere else (e.g. a mounted disk).
- Client and candidate sign-ins are stored in the database, so restarting the server keeps everyone signed in.

> The testimonials, stats and sample jobs are placeholders. Replace them with real ones before going live.

## Deploy
Hireriv is one Node.js process with a SQLite file, so any host that runs **Node 22.13+** with a **persistent disk** works. Keep the database and `uploads/` on that disk, and put the site behind HTTPS.

**Settings** – copy `.env.example` to `.env` and fill it in (`SITE_URL` with https, `ADMIN_PASS`, the `SMTP_*` values, `TRUST_PROXY=1` behind a proxy). Run with `npm run start:env`, or set the same variables in your host's dashboard. With `NODE_ENV=production` the server prints a warning at startup for anything important that is missing.

**Docker** (on a VPS):
```bash
docker build -t hireriv .
docker run -d --name hireriv -p 3004:3004 --env-file .env -v hireriv-data:/var/lib/hireriv --restart unless-stopped hireriv
```
The image keeps the database and resumes in the `hireriv-data` volume and checks `/healthz` every 30 seconds. Put Nginx or Caddy in front for HTTPS.

**Render / Railway** – create a Node web service from this repo (build: `npm ci`, start: `node server.js`), attach a persistent disk mounted at e.g. `/var/data`, and set `DB_FILE=/var/data/hireriv.db`, `UPLOADS_DIR=/var/data/uploads`, `TRUST_PROXY=1` plus the settings above. Use `/healthz` as the health check path.

**Built in:** security headers (Content-Security-Policy with no inline scripts, anti-framing, nosniff, referrer and permissions policies, HSTS on https), `/healthz` (checks the database), private areas hidden from search engines, and cache-busted CSS/JS.
