# Google Actions release and onboarding

## Verified 2026-09-09

- PR #79 merged into source at 4a529eb2af72eb3c10e5e902bd2bf21f15756a47; verify and Cloudflare preview successful.
- PR #80 is being hardened with durable booking idempotency and atomic outbox.
- Partner Portal returns 403 for the current owner Google session; no partner access or ID is available.
- The official interest form has been prepared with Aksenov LLC, Alex Appliance Repair,
  one merchant, US/Home Services and the two correct URLs. It is not submitted yet.
  Owner contact details, signed-agreement answer, terms acceptance and CAPTCHA remain owner actions.
- No Google feed or conversion has been sent. No approval, match or native button is claimed.

## Release sequence

1. Green exact PR #80 plus local PostgreSQL and mocked browser tests; normal merge into source.
2. Outside-Git full/schema Neon backup, pg_restore lists and SHA-256. Record safe baseline hashes/counts.
3. Apply exact additive booking_source, google_actions_center and booking_requests SQL in one transaction,
   with lock_timeout 5s and statement_timeout 60s. Compare pre/post existing data hashes; new tables empty.
4. Fast-forward worker-production through the normal Cloudflare auto build, preserving Stripe attempts/webhook ON,
   R2 and secret names. Record previous active version before update. Google flags remain OFF.
5. Back up current main/live frontend, release exact static build through the existing main release PR flow.
6. Health/auth/public configuration/booking render and read-only CRM smoke. No real customer booking for testing.

## Rollback

Keep old main assets and the exact prior Worker version. Revert active Worker traffic if booking/auth/CRM regresses;
restore frontend through a normal assets PR. Keep additive tables/columns; do not drop receipts or business rows.
Until Google approval, Google flags stay OFF. On a later integration incident disable Google flags without
disabling ordinary booking or Stripe. Never blindly replay ambiguous conversion deliveries.

## Google launch prerequisites

Owner completes the interest form; after confirmed submission record date/reference. Do not duplicate submissions.
Google must grant Partner Portal access and accept the single-business use case. For a service-area business,
verify the registered office data and exact Maps listing, then use manual matching if required by Google.
Use real partner IDs only. Upload approved sandbox feeds, resolve validation and landing-page issues,
verify official sandbox conversions and obtain production approval before sending production feeds/conversions.
The official form requests five merchant examples; truthfully provide the one real merchant and disclose current scale.
Do not invent four others. Existing Booking Now and GBP Website remain unchanged.

Google documentation currently specifies action v2 appointment_info, rather than the older action-link enum.
Conversion content type remains text/plain, the window is 30 days and merchant_changed is 2 for this single merchant.
HTTP 429 can be retried within the bounded schedule; ambiguous transport/5xx outcomes require investigation because
Google documents no request idempotency key. Local stub success is not proof of Google sandbox acceptance.
