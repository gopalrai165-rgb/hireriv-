# Plans, payments and billing

How Hireriv charges employers: plans, service packages, online payment through
Razorpay, invoices with GST, refunds, renewals and reconciliation (Step 63).

Job seekers are never charged to apply. Nothing in this module bills a
candidate, and no plan or setting can make applying paid.

> **Before charging real money:** an Indian chartered accountant must confirm
> the GST rates, SAC codes, invoice contents and credit-note handling listed in
> [section 8](#8-for-the-accountant-to-confirm). The code makes the rates and
> codes configurable and keeps exact records; it does not decide what the law
> requires for your business.

## 1. What is charged

| What | How it is billed | Where |
| --- | --- | --- |
| **Employer plans**: Starter ₹0, Growth ₹1,999/month, Business ₹4,999/month, Enterprise by quote | Paid online for each period, from Billing | `subscriptions.js`, `billing-routes.js` |
| **Recruitment service packages** (e.g. assisted hiring for one role) | One-time online purchase | same |
| **Enterprise and other agreed fees** | An invoice the team issues; paid online or by transfer | Admin → Plans & payments → Invoices |
| **Placements and staffing** (permanent fees, monthly contracts, assignments) | Unchanged: placement invoices from `placements.js`. Employers can now also pay their balance online | Placements tab; employer **Staffing invoices** |

All prices exclude GST. Admins change prices, billing intervals (monthly or
yearly), job limits, team seats, features, GST rate and SAC for every plan and
package under **Admin → Plans & payments → Plans**, without code changes. Each
change is versioned and recorded in the hash-chained audit history with its
reason.

The first plans are written once at start-up (`seedPlans`, data version 1 in
`meta` key `billing:plans-seeded`). `unseedPlans()` removes the seeded plans
that no company or payment has used and resets the version, so the change can
be undone. The collections need no schema migration (they are documents in the
existing `records` table); the PostgreSQL mirror still covers jobs only.

## 2. Limits

- **Jobs**: jobs live, paused or waiting for review at the same time. Drafts
  are free. Checked on the server when a job is sent for review, from the web
  form or any API (`employer-hiring.js`).
- **Team seats**: members of the company, including invited people who haven't
  joined yet. Checked on the server when someone is invited (`employers.js`).
- Limits come from the plan **as it is now**, so a change by an Admin applies
  straight away. Limits agreed with one company (Enterprise) override the plan.
  Nothing goes above the platform cap of 50 jobs and 50 members.
- Companies that registered themselves start on the free plan. Companies the
  team set up (managed clients billed for placements) have no plan limits
  beyond the cap, unless the team gives them a plan.
- Moving to a smaller plan never closes jobs or removes people. New jobs and
  invitations wait until there is room.

## 3. Who can see and do what

| Who | What |
| --- | --- |
| Company owner, **Billing administrator** (new employer role) | The Billing page, plans, checkout, cancel and change, invoices, receipts, billing details. A billing administrator sees nothing else (no jobs or applicants) |
| Other employer roles | Nothing about billing (403) |
| Admin | Everything, including plan prices and renewal settings |
| Finance Manager | Payments, invoices, refunds (asking and approving, never both for the same refund), setting a company's plan |
| Account Manager | Reads the billing desk |
| Everyone else, candidates, the public | Only the public list of plans (`GET /api/billing/plans`) |

Every billing record is looked up through the signed-in person's company on
the server. An invoice, receipt or order of another company answers "not
found", the same as one that doesn't exist.

## 4. Online payment (Razorpay)

`payment-gateway.js` hides the provider behind one interface (create an order,
fetch a payment, list an order's payments, refund, check signatures). Another
gateway such as Cashfree is a new entry in `PROVIDERS`.

1. The browser asks `POST /api/billing/checkout` for a plan, renewal, package
   or invoice. **The server** works out the amount (price, unused-time credit,
   GST) and creates the Razorpay order. A second click within 30 minutes gets
   the same order.
2. The Razorpay window takes the card, UPI or netbanking details. Hireriv never
   receives or stores card numbers, UPI PINs or bank passwords.
3. The browser sends Razorpay's answer to `POST /api/billing/checkout/verify`.
   The server checks the signature (HMAC-SHA256 of `order_id|payment_id` with
   the key secret, compared in constant time), then **fetches the payment from
   Razorpay's API** and checks its order, amount, currency and status. Only a
   captured payment counts. A redirect or a "success" from the browser alone
   changes nothing.
4. Razorpay's webhook (`POST /api/webhooks/payments/razorpay`) is checked
   against the exact bytes received with the webhook secret before anything
   else. It settles payments whose page was closed, and records failures,
   refunds and disputes.
5. A daily check (every 6 hours) asks Razorpay about orders older than 10
   minutes that were never confirmed, so a lost webhook can't leave a paid
   order unpaid. Orders unpaid after 3 days are closed.

**Exactly once.** Settling runs in one database transaction that first reloads
the payment record: whichever of the checkout, the webhook or the daily check
arrives first settles it, and every later one finds it settled. The database
also refuses a second invoice for one payment (unique key per transaction), a
second record of one webhook event (unique per provider event id; a failed
event is processed again when Razorpay retries it), a second order record and
a second refund record.

| Payment state | Meaning |
| --- | --- |
| created | Order made; nothing paid yet |
| pending | Authorized at the bank, not yet captured |
| paid | Captured and confirmed by the server: invoice issued, plan active |
| failed | The bank declined it; nothing changes and the company is told. The same order can be paid again |
| review | The payment didn't match its order (amount, currency or order): not counted, finance is told |
| refunded / partially_refunded | After an approved refund |
| expired | Never paid within 3 days |

Disputes (chargebacks) are recorded on the payment with their status and
finance is told; they are answered in the Razorpay dashboard.

Only references and amounts are kept from Razorpay: no buyer email, phone, card
or bank details. Secrets come only from the environment (`RAZORPAY_KEY_SECRET`,
`RAZORPAY_WEBHOOK_SECRET`), are never sent to a browser, and are not in source
control. The Billing page loads Razorpay's script under a page-specific
Content Security Policy; every other page keeps the strict one.

### Sandbox, then live

1. Create Razorpay **test mode** keys and put them in `.env` (see
   `.env.example`). The billing pages say "test mode" while test keys are used.
2. In the Razorpay dashboard add the webhook URL
   `https://<your site>/api/webhooks/payments/razorpay`, the webhook secret, and
   the events `payment.captured`, `payment.failed`, `order.paid`,
   `refund.processed`, `refund.failed` and `payment.dispute.*`.
3. Try a payment, a failed payment (Razorpay's test failure card/UPI), a closed
   window, a refund and a webhook retry, and check Admin → Plans & payments →
   Overview shows "Everything matches".
4. Only then switch to live keys. The server warns in its log if test keys are
   used with `NODE_ENV=production`.

The automated tests (`test/billing.test.js`) run against a local imitation of
the Razorpay API with real signatures. They are not a substitute for step 3
against Razorpay's own sandbox, which has not been done yet.

## 5. Lifecycle

```
choose plan → order (server) → pay in Razorpay window → verify signature + confirm with Razorpay
  → plan active for the period + tax invoice + receipt + email to owners and billing people
  → reminders 7, 3 and 1 days before the end (configurable)
  → renewal paid: next period starts where the last one ended
  → not paid: "renewal overdue", plan kept for the grace period (7 days, configurable)
  → grace period over: back to the free plan (nothing deleted)
```

- **Upgrade**: starts the day it is paid. Unused days of a paid plan come off
  the price as a credit line on the invoice.
- **Downgrade** (to a smaller paid plan or the free plan): takes effect when
  the paid period ends. No charge and no refund.
- **Cancel**: the plan runs to the end of the paid period, then the company
  moves to the free plan. It can be undone until then. If a renewal is already
  overdue, cancelling moves to the free plan at once.
- **Enterprise**: a quote. The team sets the company's plan and agreed limits
  (with a reason, recorded in the audit history) and issues invoices for it.
- **Automatic charging** (Razorpay Subscriptions or e-mandates) is **not
  switched on**: each period is paid from a reminder. It can be added later
  through the gateway interface where Razorpay supports mandates for the
  payment method, with the RBI's e-mandate rules (pre-debit notice, limits).

Plan changes, cancellations, payments and refunds are written to the company's
own audit log (Team page) and the subscription's history. Team decisions
(price changes, plans set by hand, invoices issued, payments recorded, refunds
asked for, approved, rejected or failed) go in the hash-chained audit history.

## 6. Invoices, credit notes and receipts

- Every paid plan or package gets a tax invoice, in the **same series as
  placement invoices** (`INV/2026-27/0001`, per financial year, numbers never
  reused). Credit notes share the `CN/…` series.
- An invoice keeps a snapshot of everything it shows: both parties' names,
  addresses, GSTINs and states, each line with its SAC, the taxable value, the
  GST rate and split (CGST + SGST within the seller's state, IGST otherwise),
  and the total. Later edits to a plan, the company or the settings never change
  an issued invoice.
- The GST rate and SAC come from the **plan or package** (or the invoice the
  team issues), never from one fixed rate for every service.
- Place of supply: the buyer's GSTIN state, or the state chosen in the billing
  details; if either side's state is unknown the invoice uses IGST.
- Money is stored in **paise** (whole numbers) with the currency (`INR`) next
  to it. Placement invoices keep their existing rupee amounts.
- A receipt (`/employer/billing/receipts/:id`) proves money was received; it
  points to the tax invoice and is not one.
- Paying a placement or staffing invoice online adds a payment to that invoice
  (mode "Online payment", with the Razorpay reference). It does not create a
  second invoice.

## 7. Refunds and reconciliation

- `POST /api/admin/billing/refunds` (or the Payments tab) **asks** for a refund:
  amount, reason, an optional note, and whether to end the plan. It needs the
  password again (10 minutes) and the `billing.refund` permission (Admin,
  Finance Manager). Candidates and employers can't reach it.
- A **different** person with the same permission approves or rejects it
  (`…/refunds/:id/approve|reject`), also after confirming their password.
  Approving sends the refund to Razorpay first. Only if Razorpay accepts it is a
  credit note issued for the same amount, with GST in the invoice's proportion,
  and the payment marked refunded or part refunded. If Razorpay refuses, nothing
  changes and the refund is marked failed.
- Refunds made directly in the Razorpay dashboard arrive by webhook. They are
  recorded and flagged for reconciliation because they have no credit note yet.
- Placement invoices are refunded as before, from the placement (credit note,
  then refund).
- **Reconciliation** (Overview tab) lists what doesn't add up: a paid payment
  without its invoice, an invoice total that differs from its payment, refunds
  that don't match their payment or credit notes, payments held for review,
  open disputes, refunds stuck or failed, and failed webhooks. Monthly collected,
  refunded and net totals are there to compare with Razorpay's settlement
  report, and the payments CSV is under the same tab.

## 8. For the accountant to confirm

These need a chartered accountant's sign-off before live payments:

1. **SAC and GST rate for each plan and package.** Plans start with GST 18%
   (from Admin → Settings → Billing) and **no SAC** (the plans list shows "SAC
   missing"). Online job posting and employer subscriptions, recruitment
   services, and contract staffing can fall under different SAC codes.
2. **Place of supply** for buyers without a GSTIN, and for buyers whose billing
   state differs from their GSTIN state.
3. **Invoice contents** under Rule 46 of the CGST Rules (e.g. HSN/SAC digits
   for your turnover, signature or digital signature, "whether tax is payable on
   reverse charge"), and whether **e-invoicing (IRN/QR)** applies to your
   turnover. E-invoicing is not built.
4. **Credit notes** for refunds and downgrades: timing limits under section 34
   and how they are reported in GSTR-1.
5. **TDS** that business customers may deduct from plan and placement fees, and
   how it is recorded (placement invoices record TDS; online plan payments are
   always the full amount).
6. **Receipts and advances**: whether a renewal paid before the period starts
   needs a receipt voucher.
7. Whether the business is registered for GST at all (an unregistered seller
   must not charge GST; set the rates to 0 until registration).

## 9. API

| Method | Path | Who |
| --- | --- | --- |
| GET | `/api/billing/plans` | Anyone |
| GET | `/api/billing/subscription` | Owner, billing administrator |
| POST | `/api/billing/checkout` | Owner, billing administrator: `{ planId }`, `{ purpose: "renewal" }`, `{ invoiceId }` or `{ placementId, invoice }` |
| POST | `/api/billing/checkout/verify` | Owner, billing administrator: `{ orderId, paymentId, signature }` |
| POST | `/api/billing/subscription/change` | Owner, billing administrator: `{ planId }` (smaller or free plans) |
| POST | `/api/billing/subscription/cancel` | Owner, billing administrator: `{ reason }` |
| POST | `/api/billing/subscription/resume` | Owner, billing administrator |
| GET | `/api/billing/invoices`, `/api/billing/invoices/:id` | Owner, billing administrator |
| GET | `/api/billing/payments` | Owner, billing administrator |
| GET, PUT | `/api/billing/profile` | Owner, billing administrator (PUT) |
| POST | `/api/webhooks/payments/:provider` | The payment provider (signed) |
| POST | `/api/admin/billing/refunds`, `/api/admin/billing/refunds/:id/approve` and `…/reject` | Admin, Finance Manager, after confirming the password |
| GET | `/api/admin/billing/refunds` | Admin, Finance Manager, Account Manager |

Amounts in the API are in paise with a `currency` field.

## 10. Records

| Brief's entity | Collection | Notes |
| --- | --- | --- |
| subscription_plans | `subscription-plans` | Unique `code`; `version` goes up with each change |
| employer_subscriptions | `employer-subscriptions` | One per company (unique), with its history |
| payment_transactions | `payment-transactions` | Unique per provider order; the quote it was created with |
| invoices, invoice_items | `billing-invoices` with its `lines` | Plan, package and team-issued invoices. Placement invoices stay in `placements` |
| refund_records | `refund-records` | Unique per provider refund id |
| payment_webhook_events | `payment-webhook-events` | Unique per provider event id |
| (billing contact and tax info) | `billing-profiles` | One per company |

Invoices, credit notes and payment records are tax records: there is no route
that deletes them, and retention never removes them. Keep them for at least the
period the GST law requires (section 36: 72 months from the annual return's due
date).
