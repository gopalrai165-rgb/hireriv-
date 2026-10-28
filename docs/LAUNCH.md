# Launch readiness (Step 68)

This is the launch-gap report for Hireriv as of 27 October 2026 (commit after `07928fd`). It audits the repository against 15 launch areas and marks each one:

- **Ready**: built, tested and documented. Only the settings in section 2 are needed.
- **Needs work**: built, but something outside the code (a review, a provider, a test on the real host) is still missing, or part of it is not built.
- **Not implemented**: nothing in the repository covers it yet.

Nothing here says Hireriv is "compliant" or "secure". It lists what exists, what was checked and what is still open.

## 1. Launch-gap report

| # | Area | Status | What is in place | What is still missing |
|---|---|---|---|---|
| 1 | Production configuration and secrets | **Ready** | `config-check.js`: with `NODE_ENV=production` the server **refuses to start** with a missing or http `SITE_URL`, a placeholder or short `ADMIN_PASS`, no or a bad `FILE_ENCRYPTION_KEY`, no `SMTP_HOST`, half-set Razorpay keys, `AI_PROVIDER=mock` or a short `EMAIL_WEBHOOK_SECRET`; everything else is a printed warning. `npm run check:config` prints the same report. Secrets stay on the server (`.env`, never committed). | Choose the secret store on the host (section 7). |
| 2 | Authentication and access control | **Ready** | Team roles and permissions, two-step sign-in (enforced for Admins live), employer and candidate sign-in, the route table in `docs/ACCESS.md` checked by `test/access.test.js`, other companies' ids answering 404 in the API. | External penetration test (item 4). |
| 3 | Application security | **Needs work** | CSP with no inline scripts, HSTS, anti-framing, same-origin checks on every form, rate limits, upload type checks and ClamAV scanning, encryption at rest (`vault.js`), SSRF-safe outbound requests (`safe-fetch.js`), dependency audit in CI. | `CLAMAV_HOST` on the live host. Rate limits and security counters are per process (fine for one process). |
| 4 | Independent security testing | **Not implemented** | — | An external penetration test of sign-in, authorisation (other companies' ids), uploads, payments and the API, with fixes, before public launch (`docs/SECURITY.md` §8). |
| 5 | Privacy and data protection | **Needs work** | Consent records, data-rights requests, grievance handling, retention by purpose, erasure with a journal, redaction for AI (`docs/SECURITY.md`). | Review by Indian counsel of the DPDP Act and Rules, CERT-In directions (logs in India for 180 days: depends on the host), processor contracts with hosting, email, SMS, payment and AI providers, and the `/privacy` and `/terms` text. |
| 6 | Data storage, backups and restore | **Needs work** | Daily SQLite backups with an integrity check and retention; **a weekly restore drill** that restores the newest copy into a scratch folder with the app's own `db.open`, checks and counts it and records the time and the copy's age (Admin → Settings → Backups, and the dashboard warns if it fails or stops); `npm run backup:restore-test` for a drill by hand. Uploaded files (resumes, documents, evidence) are copied with every backup into `BACKUP_DIR/uploads`, each content stored once and kept as long as a backup that holds it; the drill restores them too, checks every file against its SHA-256 and counts files the records name that were already missing; `npm run backup:restore-uploads` puts them back for a real restore. | The backup folder must be on a second disk or synced off the server (`BACKUP_DIR`). A full restore on the real host has not been rehearsed (section 4). |
| 7 | Disaster recovery (RTO / RPO) | **Needs work** | Targets and the restore runbook in section 3. | The first rehearsal on the live host, with the measured time written into section 3. |
| 8 | Monitoring, logging and alerting | **Needs work** | `/healthz` (checks the database), `/admin/system-health` (request and error counts per hour, background jobs, cleaned errors, email delivery; kept across restarts), security alerts by email, backup and restore-test warnings on the dashboard; a heartbeat to an outside monitor (`HEARTBEAT_URL`) and JSON log lines on stdout (`LOG_FORMAT=json`) with route patterns and cleaned messages only. | Choosing the outside monitor and setting `HEARTBEAT_URL` and a `/healthz` check there, and pointing the host's log drain at a log store (kept 180 days in India for CERT-In: section 7). Targets in section 5. |
| 9 | Testing and CI | **Ready** | `npm test` (unit and end-to-end against a throwaway server, accessibility checks in English and Hindi, Postgres tests with `TEST_DATABASE_URL`); `.github/workflows/ci.yml` runs them on Node 22.13 and 22 with a Postgres service, `npm audit` for high and critical issues, builds the Docker image, checks it refuses unsafe settings and answers `/healthz`. | Turn on branch protection requiring **CI** on `main` in GitHub. |
| 10 | Deployment and rollback | **Needs work** | Dockerfile with a health check and a non-root user, Render / Railway instructions, Postgres migrations with matching rollback files. Staging mode (`SITE_ENV=staging`, `staging.js`): a password in front of every page, no indexing, a banner on every page, emails and texts only to `STAGING_EMAIL_ALLOW` / `STAGING_SMS_ALLOW` (the rest go to the outbox folder), and live payment keys refused. | The staging copy itself: its own host, domain, database and test keys. Rollback is "redeploy the previous image"; database changes are additive so far, but a rollback that needs older data means a restore (section 3). |
| 11 | Performance and capacity | **Needs work** | A repeatable load test (`npm run load:test`, `docs/PERFORMANCE.md`) at 5,000 jobs and 50,000 applications, with the slow paths it found fixed: public pages now answer in 60–600 ms with 20 requests at a time, up from 0.2–29 s. Pagination, cache-busted static files, Save-Data pages, optional Postgres search. | A run on the real host. The first admin view after the applications change recounts them (about 0.3 s at 50,000). One Node process with SQLite (`docs/PERFORMANCE.md` §4). |
| 12 | Email, SMS and notifications | **Needs work** | SMTP with plain-text parts, delivery webhooks, a retry queue, push notifications, text messages through MSG91, Twilio or a webhook (`SMS_PROVIDER`, checked at start-up, `npm run sms:test`). | A real sending domain with SPF, DKIM and DMARC (needs DNS: section 7), choosing an SMS provider and TRAI DLT registration of the sender ID and the one code template (README → Text messages), a test of every email on Gmail and Outlook. |
| 13 | Payments and billing | **Needs work** | Razorpay with server-side orders, signature checks, once-only webhooks, GST invoices (`docs/BILLING.md`). | The accountant's confirmation (`docs/BILLING.md` §8), live keys, and one real end-to-end payment and refund. |
| 14 | Accessibility, languages and content | **Needs work** | WCAG 2.2 AA work and automated checks, English and Hindi. | The native-speaker Hindi review (`docs/I18N.md` §5), the manual screen-reader checks (`docs/ACCESSIBILITY.md` §3), and replacing the sample jobs, stats and testimonials (dashboard "Needs your attention"). |
| 15 | Operations, support and incident response | **Needs work** | Incident steps with CERT-In and Data Protection Board decisions (`docs/SECURITY.md` §5), trust and safety desk, grievance handling. | Named incident contacts, the CERT-In point of contact, a support inbox and hours, and a first tabletop exercise. |

**Summary:** 3 Ready, 11 Needs work, 1 Not implemented. Item 4, the load test on the real host in 11, and the reviews in 5, 13 and 14 are the ones that block a **public** launch (section 6).

## 2. Settings the server checks

Run `npm run check:config` before every deploy. With `NODE_ENV=production` the server runs the same checks first and exits with code 1, before opening the database, if any error is found.

| Blocks the start | Warning only |
|---|---|
| `SITE_URL` missing, not https, or localhost | `ADMIN_PASS` unset (only invited members can sign in) |
| `ADMIN_PASS` a placeholder or under 12 characters | `RESET_OWNER_2FA` still set |
| `FILE_ENCRYPTION_KEY` missing or not 32 bytes; a bad key in `FILE_ENCRYPTION_KEYS_OLD` | `SMTP_USER` / `SMTP_PASS` or `MAIL_FROM` missing |
| `SMTP_HOST` missing | Razorpay not set up, or test keys live |
| Some but not all of the three Razorpay values | `DB_FILE`, `UPLOADS_DIR` or `BACKUP_DIR` unset; backups inside the database folder |
| `AI_PROVIDER=mock` | `CLAMAV_HOST` or `TRUST_PROXY` unset |
| `EMAIL_WEBHOOK_SECRET` set but under 16 characters | `NOTIFY_WORKER=off` |
| `HEARTBEAT_URL` not https; `HEARTBEAT_MINUTES` outside 1–60; `LOG_FORMAT` other than `json` or `text` | `HEARTBEAT_URL` unset; `LOG_FORMAT` not `json` |

There is deliberately no switch to skip the checks. Fix the setting instead.

## 3. Recovery targets and restore runbook

| | Target at launch | Based on |
|---|---|---|
| **RPO** (data that may be lost) | **24 hours** for the database and uploads | Daily backups (`backups.js`). Tighten to 1 hour later with hourly backups or continuous replication if the volume justifies it. |
| **RTO** (time to be back) | **4 hours** | Restore drill time (seconds for today's database: see Admin → Settings → Backups) plus redeploying the image, restoring uploads and checking. Replace with the measured time after the first rehearsal. |

**Restore runbook** (rehearse once on the live host before launch, then every quarter; record each one as a Low incident marked as an exercise):

1. Open an incident (`/admin/incidents`) and note the time.
2. Stop the app (or put the proxy in maintenance mode).
3. Pick the backup: the newest that passed its check (Admin → Settings → Backups, or the files in `BACKUP_DIR`). Run `npm run backup:restore-test -- <file>` against it.
4. Move the current database aside (keep it as evidence), copy the backup to `DB_FILE`, and delete any `-wal` / `-shm` files next to it.
5. Restore the uploaded files of the **same** backup into an empty `UPLOADS_DIR`: `npm run backup:restore-uploads -- <UPLOADS_DIR> <the backup's .db name>` (files already there are kept, a damaged copy stops it). A host snapshot of the volume, if there is one, is a second source.
6. Start the app with the **same** `FILE_ENCRYPTION_KEY` (and any old keys): without it uploaded documents can't be opened.
7. Erasures done after the backup are re-applied automatically from the erasure journal (`docs/SECURITY.md` §6). Check the start-up log.
8. Check `/healthz`, sign in, open a job, a resume and an invoice, and write the times into the incident.

## 4. Before the first real restore (one-time)

- Put `BACKUP_DIR` on a second disk or a folder synced off the server, and confirm a copy exists outside the host.
- Optional: daily snapshots of the volume holding `UPLOADS_DIR` as a second copy of the uploads.
- Keep `FILE_ENCRYPTION_KEY` in a password manager or secret store, **not** with the backups.
- Rehearse section 3 end to end and record RTO and RPO as measured.

## 5. Monitoring targets

| What | Target | Where it is seen | Alert |
|---|---|---|---|
| Availability | 99.5% a month | External uptime monitor on `GET /healthz` every minute from India | 2 failures in a row: email + phone to the on-call person |
| Server errors | under 1% of requests in any hour | `/admin/system-health` (5xx per hour) | Weekly review; any hour over 5% opens an incident |
| Response time | p95 under 1.5 s for job search and apply | Proxy or host metrics (not measured in the app) | Review weekly; measure in the load test (item 11) |
| Backups | one good backup every 24 hours | Dashboard and Settings → Backups | Dashboard warning after 2 days; check it daily during the first month |
| Restore test | one good drill a week | Settings → Backups | Dashboard warning on failure or after 8 days |
| Background jobs | none failing or overdue | `/admin/system-health` | Shown on the platform report; check daily |
| Email delivery | under 2% bounced | `/admin/notifications` and the provider | Dashboard "Email delivery" warning |
| Security | as `docs/SECURITY.md` §4 | Security alerts | Email to people with `security.view` |
| Heartbeat | a ping every 5 minutes (`HEARTBEAT_URL`) | The outside monitor | No ping for 15 minutes: email + phone to the on-call person |
| Logs | every request and error as a JSON line (`LOG_FORMAT=json`) | The log store fed by the host's log drain | Alert on more than 20 `"level":"error"` lines in 5 minutes |
| TLS certificate | more than 14 days left | Uptime monitor | Email |
| Disk | under 80% full on the data volume | Host metrics | Email |

## 6. Launch gates and staged rollout

Each stage starts only when its gate is met, and is rolled back if a stop condition happens.

| Stage | Who | Gate to enter | Stop and roll back if |
|---|---|---|---|
| **0. Staging** | The team only, on a copy of the live setup (own domain, own database, Razorpay test keys) run with `SITE_ENV=staging` and a `STAGING_PASSWORD` (README → Staging) | CI green; `npm run check:config` clean apart from known warnings; restore rehearsed (section 4) | — |
| **1. Internal** | The team on the live site, real jobs entered, search engines blocked | Staging walk-through of apply, employer sign-up, job review, payment (sandbox) and erasure; uptime monitor and alerts live | Any data shown to the wrong person; backups failing |
| **2. Private beta** | 5–10 invited employers and their candidates, one city | Hindi reviewed before turning it on (`LANGUAGES=en,hi`; off by default); incident contacts filled in; email domain authenticated; payments still off or live after the accountant's sign-off | Any security incident above Low; error rate over 5% in an hour; a failed restore test |
| **3. Public, limited** | Open sign-up, search engines allowed, one region and its categories promoted | Penetration test done and its high findings fixed; legal review of privacy, terms and DPDP done; load test at 3× the expected traffic passed; two weeks of stage 2 without a stop | Availability under 99% in a week; any confirmed data exposure |
| **4. General** | All regions | Four weeks of stage 3 within the monitoring targets | As stage 3 |

Rollback is redeploying the previous image; if data has to go back too, follow section 3. Every move between stages, and every rollback, is recorded as a note in the team activity log with the date and who decided.

## 7. Domain, DNS and hosting: to confirm with the owner

Nothing here has been changed. **No DNS record will be changed without the owner's confirmation.** Still to decide and confirm:

- The live domain (`.env.example` assumes `hireriv.com`) and who holds the registrar account.
- The host and its region. For the CERT-In log rule (180 days within India) and DPDP storage questions, an Indian region is the safe choice; confirm with counsel.
- Records that will be needed: `A`/`AAAA` or `CNAME` for the site; `MX`, SPF, DKIM and DMARC for the sending domain; any verification records for Razorpay, the email provider or search consoles. CAA if certificates are restricted.
- Lower the TTL a day before the switch, and keep the old records written down for a rollback.

## 8. Not done in this step

- No penetration test or load test on the real host, and the staging copy is not set up yet: the code supports it (`SITE_ENV=staging`), but it needs its own host, domain and database.
- The restore drill restores into the server's temp folder, so it needs free space there about the size of the uploads.
- The monitoring targets above are targets: the app sends the heartbeat and writes the JSON logs, but the outside monitor, the log store and paging have to be chosen and set up for the chosen host.
- The CI workflow has not run on GitHub yet; check its first run and then require it on `main`.
