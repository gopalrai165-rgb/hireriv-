# Employer verification, fraud prevention and job quality

Step 64. This builds on the trust & safety desk from Step 59 (`trust.js`). It adds `risk.js` (the risk rules) and `company-trust.js` (company checks, public company pages and labels).

This is how the platform behaves. It is not legal advice. Nothing here says Hireriv is "fully compliant" with any law. The items in section 9 need review by Indian counsel before launch.

## 1. What candidates see

Labels say exactly what was checked, and when. Each one carries the same note: *Verification means our team checked these details at that time. It is not a guarantee about the employer or the job. Never pay to apply, and never share bank details, Aadhaar, an OTP or a UPI PIN.*

| Label | When it shows | What it means |
| --- | --- | --- |
| Verified employer | A company the team set up, or a self-registered company the team verified | The team checked the registration details (GSTIN, CIN, Udyam, website), and any business documents sent, on the date shown |
| Verified employer · new details being checked | A verified company changed its name or registration numbers | The company stays verified. The new details are back in the verification queue |
| Contact details confirmed | The company email and the owner's mobile are confirmed, but the business is not yet checked | The company's jobs cannot go live until the business is verified |
| Not yet verified | Nothing confirmed yet | Explains the review-required process: the company can send only a few jobs, and each is reviewed first |
| Listing checked by Hireriv | An employer's job approved by a moderator | Shows the approval date. Any later change is reviewed again before it shows |
| Recruiter's email and mobile confirmed / work email on the company domain | The person who posted the job confirmed both | No name or contact details are shown |

The job page has a "What we checked" box. Each company with live jobs has a public page at `/companies/:id` with its details, its labels, its open jobs and **Report this company**.

## 2. Company verification

- **What the company sends** (`POST /employer/company/verify`, or `POST /api/companies/:id/verification`, where the id must be the signed-in company's own):
  - business details: legal name, GSTIN, CIN, Udyam number, website and address;
  - optionally, an authorised representative (name, designation, work email and mobile);
  - up to 3 business documents per request, and 5 per check: GST, incorporation or Udyam certificates, a shop & establishment licence, or an authorisation letter.
- **Kept to a minimum.** We never ask for Aadhaar, PAN cards, bank statements or personal identity documents. The form says so next to the upload boxes.
- **Documents are protected.** Each one must be a real PDF or image and passes the virus scan. It is then encrypted (AES-256-GCM, `vault.js`) under `uploads/verification-documents/`, and its SHA-256 fingerprint is kept with the check. Only `verify.review` roles can open it, through a signed link valid for 15 minutes. Every opening is written to the hash-chained audit history (and to the security log through `vault.onAccess`).
- **Reviewer decisions** (`/admin/verifications`, `POST /api/admin/verification/:id/decision`): verify, ask for more information, decline (with an appeal), or **escalate** to a Trust & Safety Manager. Escalating opens or escalates a case about the company.
  - Each decision is added to the check's review history. Nothing is overwritten.
  - The reviewer sees whether the representative's email is on the company's website domain, the risk signals, open cases and the review history.
- **Re-checking.** When a verified company changes its name, GSTIN, CIN or Udyam number:
  - the change is recorded in its identity history, and a re-check goes into the queue;
  - its label says the new details are being checked;
  - a reviewer confirms the new details, or escalates. A verified company is suspended only from a case, never by declining the re-check.

## 3. Job quality

Before an employer's job goes for review, it must have its main responsibilities, the pay or how pay is decided, and (for industrial, field and service work) the working hours or shift. New optional fields **Overtime** and **Costs the worker pays** show on the job page.

After a listing has gone live, these changes are recorded with the edit, and the edited job goes back for review as before:

- pay changing by 30% or more, or being removed;
- the workplace changing;
- the company name changing while its new name is being re-checked.

## 4. Risk assessment (`risk.js`)

**A risk level is a review aid for a person, never proof of fraud.** No machine learning: only rules a reviewer can read. Each assessment lists the rules that fired, the evidence each one saw, the level (low, medium, high or critical), the actions taken and a reviewer's verdict. A new assessment is stored only when something changes, and the earlier ones stay in the history.

- **Listings:** fee or deposit requests, requests for Aadhaar, bank details or an OTP, too-good-to-be-true promises, chat-group, shortener and bare-IP links, the same or nearly the same text as another company's listing (word triples, 80% overlap, for texts long enough to judge), duplicates within a company, asking people to apply to a personal mailbox or phone outside the site, and the changes after publication listed above.
- **Companies:** a burst of postings, reports from several different people, listing restrictions or removals that stood (not overturned on appeal) in 180 days, identity changes after verification, and listings with high or critical signals.
- **Context, not counted:** a personal mailbox, no registration number, no website. Company size and IP addresses are never used.

The specific rule wording is kept to the admin pages and this document; candidates and employers see only plain reasons.

### What happens automatically, and what never does

| Automatic (reversible, logged) | Only by a person, with a reason and an appeal |
| --- | --- |
| Opening a case, or adding the signals to an open one | Unpublishing or removing a listing |
| Raising its priority, and escalating to managers when several different people report the same company | Holding the company's new postings (case action, two-step sign-in) |
| Pausing a **live** listing that copies another company's text, until a moderator checks it. The company is told it is a routine check | Suspending a company (closing one needs a second person) |
| Making new postings wait when a company sends more than the policy's limit (10 by default) for review in 24 hours | Declining a company's sign-up |

An account is never suspended, closed or banned automatically, and never on an unverified report, an IP address or company size alone.

When a moderator clears or approves a flagged listing, that is recorded as a **false positive**. Restricting, removing or sending it back counts as **confirmed**. Reviewers can also record a verdict on any assessment. The overview shows the false-positive rate for the last 90 days, so rules that misfire can be tuned.

## 5. Reports and tracking

- **Where people report:** `POST /api/jobs/:id/reports`, `POST /api/companies/:id/reports`, the job page's form and `POST /api/reports`. Each accepts a category (now including *suspicious links, apps or chat groups*), details, an optional email and optional evidence.
- **What comes back:** every report with a valid shape gets the same 202 reply, with a reference (`R-…`) and a private tracking link. This happens whether or not the listing or company exists, so the reply never reveals anything.
- **The tracking page** (`/reports/track/:token`; only a hash of the token is stored) shows:
  - **New**, **Under review**, **Action required** (we emailed a question) or **Resolved**, with dates;
  - never the reviewer, the escalation or the action taken against an account.
  - Reports that matched nothing show as closed after a week.
- **Cybercrime help.** Every report form and reply says: *If you have lost money or shared bank details, an OTP or a UPI PIN, report it at once on the National Cyber Crime Reporting Portal (cybercrime.gov.in) or call the helpline 1930, and tell your bank.*

## 6. The team's desk

- `/admin/overview` adds risk signals: suspicious listings and companies in 30 days, listings paused for a check, companies whose new postings are held, repeat violators and the false-positive rate. The existing figures stay: high-priority cases, turnaround times, and appeals with their overturn rate.
- `GET /api/admin/trust/queue` is one queue of cases, listings and company checks, limited to what the person's role handles, most urgent first. `PATCH /api/admin/trust/cases/:id` updates a case under its version.
- Case pages and listing reviews show the risk assessment, with the rules, evidence, actions, history and a verdict form. `GET /api/admin/risk/:type/:id` returns the same as JSON.
- New case actions **Hold new job postings** and **Lift the hold**:
  - for Job Moderators, Trust & Safety Managers and Admins, with two-step sign-in;
  - the company can still sign in, reply to candidates and keep its live jobs;
  - the owners are emailed an appeal link, and someone other than the person who decided reviews the appeal.

## 7. Retention

| Record | Kept |
| --- | --- |
| Verification documents | Deleted a year after the check is decided (or the sign-up closed). The decision, the document type and its fingerprint stay. The representative's email and phone are removed at the same time |
| Report receipts (references and tracking links) | 24 months, then removed |
| Complaint text, reporter emails and evidence | As Step 59: cleared 24 months after the case closes, keeping the outline |
| Risk assessments | Superseded assessments are removed after 24 months. The current one stays while the listing or company exists |
| Audit history | Not deleted (hash-chained) |

## 8. Abuse and evasion

- **Report limits:** reports are limited per address. Link-stuffed reports are dropped with the same reply. Repeat reports from the same person do not raise the count.
- **Assessments:** only the later of two near-copies is flagged. Short texts are not compared for impersonation.
- **Postings:** a burst of new jobs waits for review instead of going through. Thresholds (urgent reports, posting burst, the flag level that opens a case) are set under Access control → Policy, and each change needs a reason and is audited.
- **Bulk access:** opening many documents shows up in the security log's unusual-download alerts (Step 62).

## 9. To review before launch (with Indian counsel)

- **Identity documents.** Which business documents may be requested and kept, for how long, and under which purpose and notice (Digital Personal Data Protection Act, 2023, and its Rules). Whether the representative's contact details need a separate notice.
- **Report handling.** Whether report handling and tracking meet the grievance-redressal duties for intermediaries (IT Rules, 2021): acknowledgement time, resolution time and a named grievance officer.
- **Cyber incidents.** When fraud seen on the platform must be reported to CERT-In (Directions of 28 April 2022, 6-hour reporting). Who decides, and how logs are kept for 180 days.
- **The labels.** Whether the wording ("Verified employer", "Listing checked by Hireriv") could be read as a guarantee under consumer protection law.
- **Holds and appeals.** Whether automated listing holds and posting holds need more notice or appeal steps.
- **Preserving evidence.** How long evidence is kept for law enforcement requests, and how it is handed over.

The incident response plan and the contacts to fill in are in [docs/SECURITY.md](SECURITY.md).
