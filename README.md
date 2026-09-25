# Hireriv – Staffing & Recruitment Website

A complete website for a tech-driven staffing and recruitment company, built with Node.js, Express and EJS.

## Features
- **Home**: hero with job search, animated stats, services, industry tabs, 6-stage process, testimonials, FAQ, blog preview and CTAs
- **Find Work** (`/jobs`): keyword, category, location and work-mode filters, job detail pages, and online applications with resume upload
- **Hire a Team** (`/hire`): employer requirement form, engagement models and the hiring process
- **About**, **Blog** (with articles) and **Contact** pages
- Newsletter signup, a floating WhatsApp button, and a mobile-responsive layout
- **Job alerts** (`/jobs`): candidates pick a category and/or city, confirm by email (double opt-in), then get an email the first time each matching job goes live. Remote jobs match every city. Every alert has a one-click unsubscribe, and subscribers are listed under Admin → Job alerts
- **Saved jobs** (`/saved`): a bookmark button on every job card and job page, with a count in the header. Saved jobs are stored in the visitor's browser, so no account is needed. Closed jobs stay listed and marked Closed, and deleted jobs drop off automatically
- **Spam protection**: every public form has a hidden bot trap and a per-IP limit (5–6 submissions per 10 minutes), and the admin locks out an IP for 15 minutes after 10 wrong passwords. Behind a reverse proxy, set `TRUST_PROXY=1` so limits apply per visitor
- **Share a job**: WhatsApp, LinkedIn, copy-link and the phone's share sheet on every open job, using the public `SITE_URL` address
- **My applications** (`/account`): candidates sign in with a one-time emailed link (no password) using the email they applied with. They see each application's progress in plain language, upcoming interviews with join link and calendar file, update their profile (skills, experience, city, notice, LinkedIn) across all applications, withdraw an application (interviews are cancelled and the team is emailed), and delete all their data (applications, resumes, job alerts, newsletter)
- **Client portal** (`/employer`): clients log in to see their roles with applicant counts by stage, send new hiring requirements (they arrive in Admin → Hire requests and by email) and follow their status. Passwords are hashed with scrypt, invite/reset links are single-use and expire, and logins are rate-limited
- **SEO**: Google for Jobs structured data (JobPosting) on every open job, Organization/WebSite/BlogPosting data, `/sitemap.xml`, `/robots.txt`, canonical and Open Graph tags. Closed jobs are removed from the sitemap and marked `noindex`
- **Admin panel** (`/admin`):
  - **Dashboard** (opens first): key numbers, a 14-day applications chart, the candidate pipeline funnel, most-applied jobs and recent activity
  - **Jobs**: post, edit, close/reopen and delete openings. Closed jobs drop out of listings, keep their page, and stop taking applications
  - **Applications pipeline**: move candidates through New → Screening → Interview → Offered → Hired / Rejected, add recruiter notes, filter by stage and download resumes
  - **Interviews**: book a video, phone or in-person interview from any application (India time). The candidate gets an email with a calendar invite (Accept/Decline in Gmail and Outlook) and moves to the Interview stage. The Interviews tab and dashboard show what is coming up; cancelling emails the candidate and removes it from their calendar. Each interview also has a downloadable .ics file for the interviewer
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
Then open http://localhost:3004/admin and log in as `admin` (change the username with `ADMIN_USER`).

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
