# Hireriv – Staffing & Recruitment Website

A complete website for a tech-driven staffing and recruitment company, built with Node.js, Express and EJS.

## Features
- **Home**: hero with job search, animated stats, services, industry tabs, 6-stage process, testimonials, FAQ, blog preview and CTAs
- **Find Work** (`/jobs`): keyword, category, location and work-mode filters, job detail pages, and online applications with resume upload
- **Hire a Team** (`/hire`): employer requirement form, engagement models and the hiring process
- **About**, **Blog** (with articles) and **Contact** pages
- Newsletter signup, a floating WhatsApp button, and a mobile-responsive layout
- **Admin panel** (`/admin`):
  - **Jobs**: post, edit, close/reopen and delete openings. Closed jobs drop out of listings, keep their page, and stop taking applications
  - **Applications pipeline**: move candidates through New → Screening → Interview → Offered → Hired / Rejected, add recruiter notes, filter by stage and download resumes
  - Hiring requests, contact messages and newsletter signups, with delete on every entry
  - **Export CSV** on every tab (Excel-ready)

## Run it
```bash
npm install
npm start            # http://localhost:3000
```
To enable the admin panel, set a password first:
```powershell
$env:ADMIN_PASS="choose-a-strong-password"; npm start   # PowerShell
```
Then open http://localhost:3000/admin and log in as `admin` (change the username with `ADMIN_USER`).

## Customise
| What | Where |
|---|---|
| Phone, email, address, WhatsApp, social links, stats | `data/site.json` |
| Job listings | `/admin` → Jobs (saved to `data/jobs.json`) |
| Blog posts | `data/posts.json` |
| Colours & fonts | CSS variables at the top of `public/css/style.css` |
| Page content | `views/*.ejs` |
| Logo | `public/img/logo.svg` |

Form submissions are saved to `data/submissions/*.json`, and resumes to `uploads/`.

> The testimonials, stats and sample jobs are placeholders. Replace them with real ones before going live.
