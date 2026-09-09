# Google Actions Center: dormant Appointments Redirect foundation

## Scope and domains

Google Search/Maps -> native action (subject to Google approval) ->
`https://aleksappliancerepair.com/booking?rwg_token=...` -> existing anonymous
booking -> Worker -> Neon job -> server-side conversion outbox.

The merchant website stays `https://www.alex-repair.com`. Its existing Booking Now
link points directly at the separate CRM domain; no website code or profile fields
are changed here. Cookies cannot be shared across these two registrable domains.
Capture occurs on the booking origin without a prerequisite main-site visit.

PR #79 was merged on 2026-09-09 (source 4a529eb2). Apply booking_source, then
google_actions_center, then booking_requests additive migrations before this Worker.
Current release and external onboarding evidence is recorded in the production runbook.

## Official contract reviewed 2026-09-09

- [Appointments Redirect](https://developers.google.com/actions-center/verticals/appointments/redirect/overview)
  redirects to the provider's own page; it does not require end-to-end Google booking.
- [Eligibility](https://developers.google.com/actions-center/verticals/appointments/redirect/policies/platform-policies)
  includes Appliance Repair. Single-merchant admission is not guaranteed.
- [Conversion Tracking](https://developers.google.com/actions-center/verticals/appointments/redirect/integration-steps/conversion-tracking)
  defines decoded `rwg_token`, 30 days, `conversion_partner_id`, and
  `merchant_changed`: original merchant `"2"`, different merchant `"1"`.
- Current action v2 uses `appointment_info`, not the old enum assumed by the request.
  See [feeds and approval-gated upload runbook](google-actions-feeds.md).
- Business Link is not substituted for Appointments Redirect. Google must confirm
  the schemas enabled for the eventual partner account.

## Browser attribution and privacy

`src/googleActionsAttribution.ts` captures immediately before React render. It
decodes once using URLSearchParams, preserves special characters and rejects empty,
duplicate, malformed/control-character or oversized (>16,384 characters) input
whole, never truncating it. This is a safety cap, not a claimed Google token maximum;
confirm against sandbox values and increase safely if necessary.

First-party localStorage plus memory stores the referral and expiry for 30 elapsed
days. A new token replaces the old; direct navigation and the same token do not
renew its expiry. Expired disk entries are removed on next access. Storage is not
shared with alex-repair.com. Browser data clearing/private browsing/device changes
can lose attribution. If durable storage fails, memory remains usable on the page
and URL cleanup is skipped. No background expiry runs in a closed browser.

Only after successful durable capture, replaceState removes `rwg_token`, retaining
other parameters/hash. Existing booking-session referrer is explicitly sanitized.
The token stays locally until expiry even after server capture, to recognize replay
of the same referral; it is not logged or placed in UI, SMS, emails or invoices.

The existing public config exposes `googleActionsCenterEnabled`. On an explicit
booking Continue/Submit, and only with exact boolean true, the frontend exchanges
the raw token at `/api/public/booking/google-actions/attribution` for an opaque UUID.
Only that UUID is sent with the booking body (`google_actions_attribution_id`).
No Google conversion POST runs in the browser. Capture failures/timeouts are ignored
for booking purposes. Raw token provenance cannot be cryptographically authenticated
locally; this is attribution, not authorization or evidence of a genuine Google click.

The API requires an exact allowed Origin (wildcard `ALLOWED_ORIGIN=*` intentionally
does not allow capture). It bounds request body/time and has a bounded per-isolate
20-per-minute/IP limiter, not a replacement for distributed WAF/rate limiting.

## Protected storage and reporting

Migration `migrations/2026-09-09_add_google_actions_center.sql` adds only:

- nullable `jobs.booking_source_detail`, constrained to actions_center;
- protected `google_actions_attributions` with deduplicated capture key, environment,
  deployment, partner/merchant, raw token and original timestamps;
- `google_actions_conversions`: unique job and session, status/attempts/backoff,
  leases and sanitized errors; lookup/expiry indexes and PUBLIC privilege revocation.

All new SQL bind parameters have explicit casts. Tables are not joined into normal
jobs responses. Verify actual DB role/default grants before release; PUBLIC revoke
does not remove explicit grants held by other preexisting roles.

The capture hash omits captured time, so reusing the original token cannot renew
server expiry. Expired raw tokens are nulled during enabled drains. Deployment,
environment, partner and merchant must match; arbitrary merchant IDs are rejected.
The schema supports multiple merchants, but this first runtime deliberately accepts
only its configured merchant. Different-merchant mapping requires a reviewed extension;
the enum is present, not a claim that cross-merchant booking is currently enabled.

Successful booking enqueues once per session/job and atomically updates the safe
source label to `Google / actions_center`. UI displays `Google · Book Online` and
polling carries only the small detail. Existing Maps/Google/Website labels remain;
missing signals cannot reliably distinguish direct, organic, Ads and untagged visits.

Outbox sends fixed trusted URLs only, disallows redirects and bounds HTTP time to
8 seconds. SKIP LOCKED claims one row with a lease; a drain has at most three sends.
2xx -> sent; explicit 429 -> exponential retry (60 seconds initially, at most five
attempts); permanent 4xx -> failed_terminal. Network failure, timeout/408, 5xx or
expired sending lease -> ambiguous, not automatic resend. No response payload is
stored or logged. Missing/disabled config causes no Google requests.

### Booking atomicity and delivery limits

Google's documented conversion request provides no remote idempotency key. The
outbox prevents local concurrent/duplicate successful sends, but cannot guarantee
remote exactly-once after a lost response. Ambiguous rows need Google-supported
investigation before any explicit replay; no public/admin replay endpoint is added.

Public booking now uses a durable booking_requests receipt with unique request and
session IDs. The browser reuses its booking session as booking_request_id; older
clients safely fall back to that session ID. The canonical SHA-256 includes business
fields and photo contents, not device clocks. Identical retries return the existing
job; different payload/session or a deleted job returns controlled 409.
The request reservation, job, accepted-session link, accepted event, valid attribution
label and conversion outbox are one Serializable transaction with up to three
40001/40P01 retries. No partial job survives an outbox SQL failure. Slot availability
is checked inside the transaction. Only the winning insert schedules notifications.
Risk scoring before the transaction can leave diagnostic risk events after a failed
booking, but not a job or conversion. Email/push remain best-effort after commit;
they are not a durable notification queue. Client-side receipt capture failure can
still lose attribution before submission, without preventing ordinary bookings.

## Configuration (no credentials committed)

| Variable | Default / purpose |
|---|---|
| GOOGLE_ACTIONS_CENTER_ENABLED | exact `true` only; default false |
| GOOGLE_ACTIONS_CENTER_ENV | sandbox or production; configured sandbox |
| GOOGLE_ACTIONS_CENTER_DEPLOYMENT_ENV | explicit local/test/preview/sandbox/production identity |
| GOOGLE_ACTIONS_CENTER_PRODUCTION_ENABLED | additional exact true production opt-in; default false |
| GOOGLE_ACTIONS_CENTER_PARTNER_ID | real numeric ID supplied by Google; absent |
| GOOGLE_ACTIONS_CENTER_MERCHANT_ID | stable feed entity ID agreed in onboarding; absent |
| ALLOWED_ORIGIN | explicit booking origin(s) required for capture; existing wildcard unchanged |

Production reporting requires all production gates and production identity. A
sandbox configuration on production identity is rejected, and nonproduction
identity cannot send production conversions. Local/CI must never load production
credentials or override identity to production. Tests inject fetch stubs only.
Fixed endpoints: `https://www.google.com/maps/conversion/debug/collect` (sandbox),
`https://www.google.com/maps/conversion/collect` (production).

Production config includes a five-minute Cron Trigger. Its guarded handler returns
without DB/HTTP activity when Google is disabled; preview has no trigger. Immediate
post-booking waitUntil drains only run after committed outbox persistence. No uploader,
SFTP credential handling or scheduled feed upload is installed; the manual sandbox
runbook is intentional preparation, not a running upload integration.

## Crawler and security

A read-only production HEAD on 2026-09-09 with User-Agent Google-Appointments returned
200 text/html; X-Robots-Tag remains noindex/nofollow. This is not genuine Google
crawler, WAF configuration or Search Console render certification. Mocked local
browser checks verify direct page rendering and query cleanup without external calls.

The PR permits Google-Appointments and Googlebot to read only booking URLs and
static assets/favicon in robots.txt; all other paths remain disallowed, and CRM
noindex headers/meta remain unchanged. User-Agent never bypasses auth, OTP, risk
checks, rate limits or WAF. Robots is a crawl instruction, not access control.
Google must verify real rendering (including public config/maps dependencies) and
confirm noindex handling. Search Console removals/CDN/WAF are not changed here.

Security review: trusted fixed outbound endpoints prevent SSRF; parameterized SQL;
no URL supplied by clients used for outbound fetch; opaque IDs never authorize jobs;
public capture origin/body/time/rate bounds; no new unauthenticated admin route;
no token joined into API/jobs or passed into notices. LocalStorage remains accessible
to same-origin scripts, so existing XSS protection and script governance still matter.

## Validation and activation checklist

Local verification: full suite 246/246 passed with both PostgreSQL suites enabled;
one subsequent feed guard regression test passed with the 25-test feed suite.
Typecheck/build/bundle verification and both Wrangler dry-runs passed. Normalized
lint remains the same 16 baseline findings (no additions). Mocked browser smoke
passed at 360/393/1280, with no runtime errors, overflow or business writes and
41-second polling at 360. External Maps rendering is deliberately blocked in mocks.

Local/CI: `npm test` with both GOOGLE_ACTIONS_TEST_PORT and STRIPE_WEBHOOK_TEST_PORT
pointing at an isolated loopback PostgreSQL service. Google tests use a fresh random
schema. Never pass production DATABASE_URL. Run typecheck, build, bundle verification,
normalized baseline lint, diff check, production/preview Wrangler **dry-run**.
`scripts/google-actions.smoke.mjs` intercepts every API/external request before
navigation and uses synthetic data, 360/393/1280 widths and >40-second polling.

Before sandbox: owner/Google approval -> actual partner/feed entity identities ->
matching review -> dedicated test database + additive migrations -> explicit local
origins + sandbox identity/gates -> offline feed validation -> separately authorized
sandbox upload -> actual Google debug endpoint and ingestion/render evidence.

Before production: Google sandbox acceptance and launch approval -> close documented
delivery/operations gaps -> backup DB -> separately approved additive migrations ->
Worker with flags OFF -> frontend -> explicit production identities/allowed origin ->
approved daily feed upload/schedule and conversion retention/retry schedule ->
separately authorized activation -> monitor safe status metrics and Google UI.
On failure disable Google integration only; bookings/Stripe stay on their existing
flow. Do not destructively roll back schema or replay ambiguous conversions blindly.

**NOT DEPLOYED. NOT MERGED. NO PRODUCTION GOOGLE REQUESTS SENT.
NO PRODUCTION FEEDS UPLOADED. GOOGLE BUSINESS PROFILE NOT MODIFIED in this task.**
