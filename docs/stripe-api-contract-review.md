# Stripe attempts API contract review

Date: 2026-09-08. Base source: 73dd423b20f5ad6133fdaca35cd8a01b694b4e8b.

## Verdict: BLOCKED pending real sandbox evidence

This is a documentation-only draft, not an API-version pin or activation PR.
Production owner diagnostics previously observed account acct_1U8SiKDN6dBh0lWZ,
livemode true and response version 2026-07-29.dahlia on account/balance requests.
Those observations do not prove the PaymentIntent/Charge/webhook contract.

No test/sandbox credentials are configured in the current process, no Stripe
connector is available, and Stripe CLI is not installed. Only production env
files were identified in the working checkout; their contents were not read.
No live secret was extracted or copied. No Stripe API request was made in this
review. Local PostgreSQL is available, but cannot substitute for Stripe.

## Documentary evidence

Official references checked on the date above:

- [Dahlia changelog](https://docs.stripe.com/changelog/dahlia): July 29 GA release exists. The July addition of allowed_payment_method_types does not by itself prove compatibility of our Terminal create parameters. August preview changes must not be treated as July GA changes.
- [Versioning](https://docs.stripe.com/api/versioning): request version uses Stripe-Version; snapshot webhook version is selected separately when its endpoint is created.
- [PaymentIntent](https://docs.stripe.com/api/payment_intents/object): id, amount, currency, metadata and status; latest_charge is nullable and expandable. Status includes requires_payment_method, requires_confirmation, requires_action, processing, requires_capture, canceled and succeeded.
- [Charge](https://docs.stripe.com/api/charges/object): balance_transaction is nullable/expandable; payment_method_details is nullable. Expanded versus ID-only responses must both be handled.
- [BalanceTransaction](https://docs.stripe.com/api/balance_transactions/object): fee/net are integer minor units; net is balance impact, not necessarily the original presentment currency. Currency conversion must not be silently treated as USD net.
- [Expansion and delayed fees](https://docs.stripe.com/expand/use-cases): expand latest_charge.balance_transaction; balance transaction can appear later, notably with automatic_async. charge.updated can signal availability. IC+ pricing may require a separate fee report. This does not establish account pricing or guarantee fee visibility.
- [Snapshot endpoint creation](https://docs.stripe.com/api/webhook_endpoints/create): explicitly select api_version separately from event selection.

The three exact-version API object URLs with api-version=2026-07-29.dahlia
could not be retrieved by the documentation tool. Unversioned reference pages
and the release changelog are supporting evidence, not an exact-version schema
capture. No synthetic fixture is presented as a real Stripe response.

## Code mapping and outstanding checks

| Contract | Current implementation | Required real sandbox evidence |
| --- | --- | --- |
| PI id/amount/currency/metadata | validateStripeIntentMatchesAttempt checks linked ID, amount, currency and present metadata values | Explicit-version create/retrieve, valid and mismatched identity fixtures; missing metadata policy remains to review |
| status | verify/webhook retrieve current Stripe state; event payload alone is not payment success | Capture all available Terminal states, failure/cancel/retry and stale event behavior |
| latest_charge | stripePaymentDetailsFromIntent accepts expanded object, ID string, null/missing | Capture before confirmation, unexpanded and expanded retrieval |
| balance_transaction | Handles object, ID string, null/missing; unknown fee/net stay null | Expanded retrieval plus delayed fee/net re-read |
| fee/net | Safe integers copied from balance transaction; reconciliation preserves known values | Check actual currency, type and amount relation before considering fee/net suitable for net accounting; fee visibility depends on pricing |
| funding/brand/type | Reads payment_method_details.card_present; credit/debit/prepaid else unknown | Real Terminal test charge, supported funding values, missing details; synthetic card-not-present charges are not Terminal evidence |
| repeated success | Stable CRM payment identity/date, audit enrichment | Existing 17 local SQL cases verify our handler, not Stripe's response schema |

Current create explicitly uses capture_method=automatic and card_present.
Do not infer automatic_async behavior is the exact Terminal behavior here.
The current three webhook event types do not themselves schedule a re-read
when a late balance transaction appears; verify/reconciliation must be invoked.
Do not promise automatic late-fee capture without a tested reconciliation trigger.

## Version pin boundary after approval

Only after explicit-version test responses confirm the contract:

1. Pin 2026-07-29.dahlia for createStripePaymentIntentForAttempt,
   retrieveStripePaymentIntent (verify/reconciliation/webhook) and
   cancelStripePaymentIntent. Preserve idempotency keys.
2. Use optional request-scoped version headers in stripePost/stripeGet, not a
   global header that changes legacy callers.
3. Leave createStripePaymentIntent, Terminal connection tokens and account
   diagnostics unchanged. Test absence of version overrides on legacy calls.
4. Future snapshot webhook: api_version=2026-07-29.dahlia;
   payment_intent.succeeded, payment_intent.payment_failed,
   payment_intent.canceled. Do not create/configure endpoint in this PR.
5. Both gates remain exact-string true opt-ins, currently OFF. No fees/gross-up.

## Isolated capture plan (not executed)

- Obtain access to an explicitly designated Stripe sandbox/test account using
  a secure local test-only credential source, never chat/Git/production env.
- First validate account and livemode=false read-only. Fail closed for live
  credentials or mode mismatch. Do not print request headers/client secrets.
- All Stripe requests must specify Stripe-Version: 2026-07-29.dahlia. Record
  observed response version, capture time and test-mode provenance separately.
- Use only a disposable loopback PostgreSQL database and synthetic job/user
  IDs; no production database URL. Use Stripe Terminal's supported test flow,
  not ordinary card fixtures as a substitute for card_present.
- Cover create/retrieve/cancel and successful/failed Terminal test confirmation;
  unexpanded and expanded Charge/BalanceTransaction, nullable/missing details,
  funding values and late fee/net. Mark any state that cannot be observed as
  unverified rather than manufacture a capture.
- Sanitize before committing: allowlist consumed fields, consistently remap
  object/job/attempt IDs, remove client_secret, billing/contact/card identifiers,
  response headers and any other secrets/PII. Keep livemode=false and record
  which fields were redacted. Do not publish raw responses.
- Feed sanitized real captures through the actual parser/verification handler;
  retain all 17 PostgreSQL scenarios for stable payment ID/date, duplicate and
  stale events, late enrichment and atomic rollback. Label additional generated
  negative cases synthetic and keep them separate from real contract fixtures.

## Evidence separation

- Confirmed by documentation: general v1 object shape, expansion/nullability,
  minor-unit fee/net semantics, request/endpoint version separation, July GA.
- Confirmed by real test-mode responses in this review: NONE.
- Not confirmed: exact July object schema, Terminal create/confirm responses,
  funding variants, actual late-fee timing/visibility/currency, snapshot event
  payloads and version pin compatibility.
- Pin, real captured fixtures and activation remain blocked. No runtime code,
  migration, frontend, Android, Stripe/Cloudflare settings or secrets changed.
