# Public API, integrations and webhooks

Step 65. Code: `integrations.js` (credentials, tokens, the v1 API, webhooks, the sandbox, the Integrations pages), `safe-fetch.js` (outbound requests to addresses companies give us) and `openapi.js` (the OpenAPI 3.1 description and the `/developers` page).

The public reference for developers is `/developers`. The machine-readable description is `/api/v1/openapi.json`. This file explains how it works inside and what is still to do.

## 1. Who can use it

- **A company's own systems**, set up by that company's **owners** in the employer portal under **Integrations** (`/employer/integrations`). The employer action `integrations.manage` is owners-only, like `team.manage`. There is no second sign-in system: integrations hang off the existing company and its owners.
- **No third-party integrations are certified.** The portal says so. We will list partners only after testing them.
- **Hireriv's team** sees integrations and webhooks at `/admin/integrations`:
  - `integrations.view`: Admin, Operations Admin, Trust & Safety Manager;
  - `integrations.manage`: Admin, Trust & Safety Manager. They can revoke an integration with a reason the company sees. The revocation goes into the hash-chained audit history (`trust-audit`) and the owners are emailed.

## 2. Credentials and tokens

| What | How it works |
| --- | --- |
| Client secret | `hrv_live_<key id>_<43 random characters>` (or `hrv_test_` for the sandbox). Shown once, on the page that answers the form (`Cache-Control: no-store`), never in a link or redirect. Only an HMAC-SHA256 of it is stored, keyed with a server secret (`secret:integrations` in the database meta). Lists show `hrv_live_<key id>…<last 4>`. |
| Access token | `POST /api/v1/oauth/token` with `grant_type=client_credentials`, the secret in HTTP Basic or the body. Lasts 15 minutes. Stored as a SHA-256 hash and sent only in `Authorization: Bearer`. Tokens or secrets in the address are refused. Cookies are never accepted on `/api/v1`, so there is no CSRF exposure. |
| Scopes | `jobs:read`, `jobs:write`, `applications:read`, `applications:contact` (email and phone), `applications:status:update`, `webhooks:manage`. A token can ask for fewer than the integration has, never more. |
| Rotation | A new secret. The old one keeps working for 24 hours, or stops at once ("stop the old one now", which also ends its tokens). |
| Revocation | The integration, its secrets and its tokens stop immediately. Its sandbox endpoints, and the live endpoints it added through the API, are turned off. |
| Notice | Owners are emailed when an integration is created. Every create, rotate, revoke and webhook change is in the company's activity log (`employer-audit`). |

A call acts as the company: the integration is treated as an owner whose permissions are limited by its scopes. Jobs and status changes go through the same code as the portal (`employer-hiring.js`): the same review by Hireriv, the same quality checks and plan limits, and the same posting holds. The activity log names it "<integration name> (API)".

**Tenant isolation.** Every lookup starts from the token's company. An id belonging to another company answers `404`, exactly like an id that doesn't exist. Only jobs the company posted itself (`createdBy: employer`) are reachable. Jobs Hireriv recruits for stay in the client portal.

## 3. Requests

- **Errors**: `{ "error": { "code", "message", "details"? } }`. The token endpoint uses the OAuth form `{ "error", "error_description" }`.
- **Pages**: `?limit=1..100` (25 by default) and an opaque `cursor`. Answers are `{ data, has_more, next_cursor }`.
- **Rate limits** per integration: 600 a minute live and 120 in the sandbox (`API_RATE_LIVE`, `API_RATE_SANDBOX`). Every answer has `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`; over the limit gives `429` with `Retry-After`. The counters are in memory per process (as with the other limits). With several processes the effective limit is per process. The token endpoint is also limited per address.
- **Idempotency**: `Idempotency-Key` on POST. The first answer under 500 is kept for 24 hours under (integration, method, path, key). The same body replays it with `Idempotent-Replayed: true`; a different body gives `422 idempotency_key_reused`.
- **Headers**: `Cache-Control: no-store` and `Hireriv-Api-Version: 2026-10-25` on every authenticated answer.
- **Contact details** of applicants need `applications:contact`. Resumes are not offered through the API.

## 4. Webhooks

- **Events**: `job.submitted`, `job.published`, `job.rejected` (with the moderator's note), `job.closed`, `application.created`, `application.status_changed`, `interview.scheduled`, plus `webhook.test`. They are raised from the existing notification events (`notify-events.js`), the stage history (`history.onMove`) and the job close (`hooks.stateChanged`).
- **Payload**: ids, states and times only (`{ id, type, created_at, api_version, environment, data }`), never names, emails, phones or resumes. Receivers read details through the API with the right scopes.
- **Outbox**: each event is stored once (`integration-events`) and one delivery is queued per matching endpoint (`webhook-deliveries`), in the same transaction. A worker (every 5 seconds, `WEBHOOK_TICK_MS`) sends what is due.
- **Signature**: `Hireriv-Signature: t=<unix>,v1=<HMAC-SHA256(secret, t + "." + body)>`, plus `Hireriv-Event-Id`, `Hireriv-Event-Type`, `Hireriv-Delivery-Id` and `Hireriv-Delivery-Attempt`.
  - The signing secret is never stored. It is derived as `whsec_` + HMAC(server secret, endpoint id and version) and shown once.
  - After a rotation the previous version also signs for 24 hours, so a delivery carries two `v1` values.
- **Retries**: any non-2xx answer, a timeout (10 seconds) or a redirect other than 307/308 is a failure.
  - It is retried after about 30 seconds, doubling each time up to 6 hours, with ±20% jitter, for 8 attempts in all. Then the delivery is `failed`.
  - After 20 failed deliveries in a row the endpoint is turned off and the owners are emailed.
- **Replays**: from the API or the Integrations page. A replay is a new delivery of the **same event id**. Delivery is **at least once**: receivers dedupe on the event id, and order is not guaranteed.
- **Catching up**: `GET /api/v1/events` lists the last 30 days.
- **Kept**: deliveries and events for 30 days, and idempotency answers for 24 hours (daily sweep).

## 5. Outbound requests (SSRF)

`safe-fetch.js` sends every webhook.

- **Addresses**: only `https://` on port 443 or 8443, with no user name or password. Names like `localhost`, `*.local`, `*.internal` or single labels are refused.
- **Name resolution**: the host is resolved by us, and **every** answer must be public. Refused ranges: loopback, private, link-local (including cloud metadata 169.254.169.254), shared, reserved, documentation, multicast, unique-local IPv6, and IPv4 addresses inside IPv6 (mapped, compatible and NAT64).
- **Connection**: the request is pinned to the address we checked (no second DNS lookup can redirect it), and TLS is checked against the host name.
- **Redirects**: only 307 and 308 are followed, at most 3, and each target is checked again from the start.
- **Limits**: 10 second timeout, 4 KB of the response kept.
- **Tests only**: `WEBHOOKS_ALLOW_PRIVATE=1` allows http and local addresses for tests. It is ignored when `NODE_ENV=production`.

## 6. Sandbox

An integration created as **Sandbox** gets an `hrv_test_` secret. It sees only sample jobs and applications seeded for it (`integration-sandbox`): never live jobs, real candidates or the review queue. Its changes and events stay in the sandbox, and its events go only to that integration's sandbox endpoints. Its rate limit is lower.

## 7. Versions

The version is in the path (`/api/v1`). Within v1 we only add things. A breaking change means `/api/v2`, announced to every integration's owners at least 6 months before v1 stops, with `Deprecation` and `Sunset` headers during that time. `/api/v1/public/jobs` and `/api/v1/public/jobs/:slug` give the same public listings as `/api/public/jobs`, without a token.

## 8. Not done yet

- **No certified partner integrations** (job boards, HRMS, background checks). The API is ready for them, but none has been built or tested with a real partner.
- **No signed request bodies from integrations to us**, and no mutual TLS. Bearer tokens over HTTPS only.
- **No per-key IP allow-lists** or usage dashboards beyond the delivery counts on the admin page.
- **Single-process limits.** Rate-limit counters are kept per process, and with several processes two workers could send the same delivery. Receivers dedupe on the event id anyway, but a shared lock would avoid the waste.
- **No penetration test.** It should be part of the external test listed in docs/SECURITY.md.
