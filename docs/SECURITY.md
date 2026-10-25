# Security, privacy and data governance

Step 62 · 25 October 2026. This document describes how Hireriv protects personal data, what to do in a security incident, how long data is kept, and the legal reviews still needed before launch. **It describes technical and operational controls. It is not a statement that Hireriv complies with any law.** Compliance depends on the business model, the hosting, how the team works, and provisions that come into force in phases. An Indian lawyer must review it before launch (section 6).

## 1. Controls by area

| Area | Control | Where |
| --- | --- | --- |
| Passwords | scrypt with a random salt per password; at least 10 characters; changing it signs out the other devices; same reply and same work for unknown accounts | `employers.js` (`hashPassword`), `candidates.js`, `team.js` |
| Sessions | Random 256-bit tokens, stored hashed, HttpOnly, SameSite=Lax, Secure on https. Team sessions last 12 hours, others 7 days. "Sign out everywhere" for job seekers; sign-out clears the browser cache (`Clear-Site-Data`) | `db.js` sessions, `pwa.js` |
| Verified contact details | Job seekers confirm their email before signing in with a password. Employers confirm email and mobile (OTP) before publishing | `candidates.js`, `employers.js` |
| Two-step sign-in | Authenticator codes (RFC 6238) with single-use recovery codes. Required for trust & safety and operations roles, **for Admins on the live site (`NODE_ENV=production`)**, and for everyone when the team setting is on | `twofactor.js`, `team.js` `mustUse2fa` |
| Confirming it's you | Bulk exports with personal data, database backups, erasing an account for a request, changing the retention policy and incident containment need the password (and authenticator code) again within 10 minutes, on that sign-in only | `security.js` `requireConfirmed` |
| Abuse limits | Sign-in, reset and verification endpoints are rate-limited per IP; lock-outs after repeated wrong passwords; bot traps on public forms; 20 exports an hour | `server.js` `limit`, each module |
| Access control | Roles and permissions checked on the server for every page and API, never from the browser. Company boundaries come from the session; another company's records are "not found". The full route matrix is in [ACCESS.md](ACCESS.md) and checked by tests | `agency-roles.js`, `employer-team.js`, `test/access.test.js` |
| Uploads | Real file type checked from the first bytes (PDF, DOC, DOCX, JPG, PNG only), 5 MB limit, ClamAV scan when `CLAMAV_HOST` is set (fails closed), random storage names, never served as static files | `uploads.js` |
| Encryption at rest | Every uploaded file is sealed with AES-256-GCM as soon as it passes the checks. `FILE_ENCRYPTION_KEY` holds the key outside the database. A daily sweep seals older files and re-seals after a key rotation (`FILE_ENCRYPTION_KEYS_OLD`) | `vault.js` |
| Downloads | Only through signed links that expire after 15 minutes, for people allowed to see that file. Always sent as attachments, with `nosniff` and a sandboxing CSP, never previewed inline. Every opening is in the security log | `uploads.js` `links`, `vault.send` |
| In transit | HTTPS with HSTS when `SITE_URL` is https; strict CSP, `X-Frame-Options: DENY`, `nosniff` on every page | `server.js` |
| Logs | Team activity, employer activity, workforce, CRM and trust & safety logs; a hash-chained audit trail for privileged decisions; a security log (section 4). No passwords, tokens or file contents. The security log masks email addresses and keeps sign-in attempts as a short hash | `trust.js`, `security.js` |
| Consent | Recorded per purpose with the policy version, source and time (section 3) | `privacy.js` |
| Data requests | Tracked from request to answer within 30 days (section 3) | `privacy.js` |
| Retention | One period per category, enforced daily; deletions are re-applied after a restore (section 5) | `privacy.js`, `retention.js`, `backups.js` |

## 2. Roles for security and privacy

| Permission | Roles |
| --- | --- |
| Security alerts and the security log (`security.view`) | Admin, Trust & Safety Manager, Operations Admin, Auditor |
| Incidents: read (`incidents.view`) / manage (`incidents.manage`) | read: the above; manage: Admin, Trust & Safety Manager, Operations Admin |
| Data requests (`privacy.requests`) | Admin, Trust & Safety Manager, Support Agent |
| Erasing an account for a request (`privacy.erase`) | Admin, Trust & Safety Manager |
| Retention: read (`retention.view`) / change (`retention.manage`) | read: Admin, Trust & Safety Manager, Auditor; change: Admin |

## 3. Consent and data rights

**Purposes, kept separate:**
- account and applications
- being considered for other jobs by Hireriv recruiters (off unless ticked)
- being findable by verified employers (off by default)
- job alerts (each alert confirmed by email)
- news and career tips
- WhatsApp
- SMS

Agreeing to the terms at sign-up grants only the first. Each change is recorded in `consent-records` with the purpose, granted or withdrawn, the policy version (`privacy.POLICY_VERSION`, shown on `/privacy`), the source (form, settings, API, link) and the time. Job seekers see their current choices and every change under **My account → Privacy & data**, in `GET /api/me/consents` and in their data download.

**Requests** (`data-requests`):
- **Types:** access, correction, deletion, withdrawing consent, and grievances.
- **Who can send one:** signed-in job seekers (already verified), or anyone through `/privacy/requests`, which emails a confirmation link (7 days). The form answers the same whether or not the email is known.
- **Tracking:** each request gets a number, an answer-by date (30 days), an owner and a history. A completion or refusal goes to the requester, and a refusal always gives reasons and mentions the Data Protection Board.
- **Deletion:** runs the same code as "Delete my account", after the team member confirms it's them. Placements and invoices stay for tax, and the request says so.

## 4. Security monitoring

**What is logged** (`security-events`):
- failed and locked sign-ins (team, employer, job seeker, identity confirmation)
- refused requests (403)
- every resume, onboarding document and evidence file opened
- bulk exports and backup downloads
- identity confirmations
- privileged team changes: roles, invitations, deactivation, resets of two-step sign-in or no longer requiring it, the retention policy, backups

**Alerts** go in-app and by email to the people with `security.view`, at most once an hour per rule and subject:

| Rule | Threshold |
| --- | --- |
| Failed sign-ins from one address | 10 in 15 minutes |
| Failed sign-ins on one account | 5 in 15 minutes |
| Refused requests by one person or address | 10 in 10 minutes |
| Document downloads by one person | 40 an hour (`SECURITY_DOWNLOAD_ALERT`) |
| Bulk exports by one person | 5 an hour (`SECURITY_EXPORT_ALERT`) |
| Privileged change | every time; high severity between 22:00 and 06:00 India time |

Alerts never block anyone. A person decides, and can open an incident from the alert. The counters live in memory, so they restart with the server; the log itself is kept.

## 5. Incident response plan

Use **Admin → Security alerts → Incidents** (`/admin/incidents`) for every suspected incident, even if it turns out to be nothing. Every change is recorded in the hash-chained audit trail.

1. **Detect and classify.** Record the incident (from an alert, a report, a provider notice or anything else).
   - **Severity:** Low (no data at risk), Medium (limited or contained), High (personal data or privileged access possibly affected), Critical (confirmed exposure, or the service down).
   - **Category:** account takeover, unauthorised access, data exposure, malware, availability, insider misuse, or other.
   - Note the time it was **noticed**: CERT-In's 6 hours run from then.
2. **Contain.** From the incident page (password required):
   - sign a team member, job seeker or employer user out everywhere
   - cancel every download link issued so far

   Outside the app, as needed:
   - deactivate the team member (Team tab)
   - suspend the company (trust & safety case)
   - block addresses at the proxy or firewall
   - take the site offline
3. **Preserve evidence.** **Preserve evidence** copies the security log around the incident into the incident with its SHA-256, so retention can't remove it. Also keep:
   - the server and proxy logs
   - a database backup (Settings → Backups)
   - provider notices
4. **Investigate.** Work out what was reached, whose data, since when and how. Use the security log, the audit history (`/admin/audit-logs`) and the employer and team activity logs.
5. **Notify where required.** Record a decision with a reason for each of:
   - **CERT-In:** reportable incidents within **6 hours** of noticing them (Directions of 28 April 2022), to incident@cert-in.org.in, using CERT-In's form.
   - **The Data Protection Board of India:** personal data breaches, as the DPDP Rules require (an intimation without delay and a fuller report, within 72 hours under the Rules as notified).
   - **Affected people:** without delay, in plain language: what happened, what it means for them, what we did and what they can do.
   - **Affected client companies:** as their contracts require.

   Record each notification with its time and reference. The incident can't move past this step until every decision is made and every required notification is recorded.
6. **Restore and rotate.** Bring services back safely. Rotate what may be exposed:
   - `ADMIN_PASS` and team passwords
   - `SMTP_PASS` and the SMS and webhook tokens
   - the VAPID keys
   - `FILE_ENCRYPTION_KEY`: move the old one to `FILE_ENCRYPTION_KEYS_OLD` and let the daily sweep re-seal; remove it once the log shows the sweep finished
   - the download-link secret (the containment action)

   Restore from a backup if needed. Deletions are re-applied automatically (section 6).
7. **Document and prevent.** Close with the root cause and preventive measures, then follow them up.

**Contacts to fill in before launch:**
- incident lead
- deputy
- CERT-In point of contact (as the directions require)
- Grievance Officer
- hosting, email and SMS providers' security contacts
- legal counsel

**Testing:**
- `test/security-privacy.test.js` runs an incident through every step, including the blocks that stop steps being skipped.
- Run a tabletop exercise with the team at least once a year and after any big change, and record it as a Low incident marked as an exercise.

## 6. Retention and deletion

The periods are set under **Admin → Retention** (`/admin/retention`). Changing one needs Admin, a reason and the password, and is recorded in the audit trail.

| Data | Kept for |
| --- | --- |
| Job-seeker profiles, applications, resumes | Until the person deletes them, or 12/24/36 months after the last activity (Settings). Never while a placement is active or an interview upcoming |
| Worker onboarding and identity documents | While the worker is engaged; replaced files are deleted |
| Contact messages, hiring requests | The candidate period |
| Unconfirmed job alerts / data requests | 30 days / 7 days |
| Placements, invoices, payments, credit notes | Kept: tax law (GST records at least 72 months) |
| Consent records | 3 years (1–10) after the account is deleted, under a keyed hash of the email |
| Data requests | 3 years (1–10) after closing |
| Security log and team activity log | 365 days (180–1095). At least 180 days, as the CERT-In directions ask |
| Employer account activity | 2 years |
| Trust & safety case details and evidence | 2 years after closing; the outline and the audit trail stay |
| Hash-chained audit trail | Kept; never edited |
| Security incidents and preserved evidence | 5 years (1–10) after closing |
| Notifications / delivery records | 365 / 90 days |
| Database backups | 14 daily copies (7–35) |

**Deleting an account:**
- **What goes:** the profile, applications, resumes (files too), job alerts, saved searches and saved jobs, the newsletter, invitations, notifications, push devices, sessions, account activity and sign-in links.
- **Search and copies:** the in-memory search reads live records. The PostgreSQL copy follows within moments, and holds no names or emails in any case.
- **Consent records** stay as evidence under a keyed hash.

**Backups and the erasure journal:**
- Deleted data stays in backups until the last copy holding it is replaced (at most the backup period).
- Each deletion is also written to `erasures.log` next to the database, outside it and its backups: a keyed hash and the time, no email.
- If an older backup is restored, the app deletes those accounts again at start-up, unless the person signed up again after the deletion.
- Keep `erasures.log` with the database when moving servers, and never restore it from a backup.

## 7. Legal and regulatory readiness: still to review

These need a qualified Indian lawyer, and the dates must be checked against the official notifications on the actual launch date:

- **Digital Personal Data Protection Act, 2023 and DPDP Rules, 2025.** The Rules were notified in November 2025 with phased commencement; most obligations of Data Fiduciaries (notice, security safeguards, breach intimation, retention, rights and grievances) apply about 18 months after notification. Confirm which provisions apply on the launch date and whether Hireriv could be a Significant Data Fiduciary.

  Built so far:
  - purpose-specific consent with records
  - a privacy notice listing the purposes
  - requests for access, correction, erasure and consent withdrawal
  - grievance handling with a 30-day answer
  - security safeguards and breach steps
  - retention by purpose

  Still to confirm:
  - the wording of the notice and the consent text
  - verifiable consent for children (Hireriv should not accept applicants under 18 unless it is decided otherwise)
  - nominations
  - the notice's language options
  - processor contracts with the hosting, email and SMS providers
  - where data is stored
- **CERT-In Directions (28 April 2022).** Check whether they apply to Hireriv and to its providers:
  - reporting within 6 hours
  - logs kept for 180 days **within Indian jurisdiction** (the host's location matters)
  - clocks synchronised with NIC or NPL time servers
  - a designated point of contact
- **Other areas:**
  - employment and staffing law (contract labour licensing for staffing, wage and social-security obligations for deployed workers)
  - the Information Technology Act, 2000 and its intermediary rules
  - consumer protection for paid employer services
  - GST and invoicing
  - electronic communications (TRAI DLT registration for SMS, WhatsApp policies)
  - contracts with clients and workers
- **Never advertise Hireriv as "fully compliant"** because these controls exist.

## 8. Before launch

- Set `FILE_ENCRYPTION_KEY` (and keep a copy in a password manager or secret store, not with the backups).
- Set `NODE_ENV=production`, `SITE_URL` (https), `TRUST_PROXY=1` and `CLAMAV_HOST`.
- Have every Admin turn on two-step sign-in. It is enforced on the live site.
- Fill in the contacts in section 5, and register the CERT-In point of contact.
- Run an external penetration test covering authentication, authorisation (including other companies' ids), uploads and the APIs, and fix what it finds.
- Complete the legal review in section 7.
