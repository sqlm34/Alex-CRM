# Stripe attempts API contract: 2026-07-29.dahlia

Reviewed and captured 2026-09-08. Base: 73dd423b20f5ad6133fdaca35cd8a01b694b4e8b.

## Result

Sandbox-access blocker resolved. Used the existing Stripe Test mode, not Live
mode. API preflight confirmed account acct_1U8SiKDN6dBh0lWZ, livemode=false and
Stripe-Version=2026-07-29.dahlia before test writes. Only the existing sk_test
credential was used, stored encrypted outside Git. No live key was copied.

Version pinned only on new attempt create/retrieve/cancel, including retrieval
used by verify/reconciliation/webhook. Legacy create, connection tokens and
owner diagnostics unchanged. Both gates and fees remain OFF. No migration,
deployment, production endpoint creation or APK change.

## Real Stripe test-mode evidence

`scripts/fixtures/stripe-dahlia-test-contract.json` contains 15 allowlisted
PaymentIntent captures and five event snapshots from Stripe, not invented data.
Every API request explicitly selected 2026-07-29.dahlia and checked the response
header; returned payment/reader objects were checked for livemode=false.

- Official simulated Terminal reader (simulated-wpe), synthetic test location.
- Three USD 10.00 card_present, capture_method=automatic successes: credit,
  debit and prepaid, with matching expanded Charge funding values.
- One declined payment: requires_payment_method with card_declined.
- One canceled unconfirmed payment: canceled.
- Captured initial latest_charge=null, ID-only and expanded Charge/BalanceTransaction.
  Declined charge balance transaction is null. Successful fee/net were 32/968
  cents in this test environment: NOT a production pricing assumption or fee rule.
- Same idempotency key returned the same PaymentIntent on repeated create.
- Retrieved events include payment_intent.succeeded, payment_intent.payment_failed
  and payment_intent.canceled. Observed event api_version=2026-07-29.dahlia is
  retained, not rewritten during sanitization.
- Actual Worker adapters also ran against test Stripe: create/reuse, expanded
  retrieve, cancel, and retrieve of successful Terminal payment. Five requests
  sent the pinned version; the extra test intent was canceled. Legacy adapters
  were not invoked against Stripe.

Only consumed fields retained. pi/ch/txn IDs consistently replaced; no
client_secret, card identifiers, billing/contact details or credentials.
Metadata is synthetic. Test resources remain for audit; no test data purge.

## Official documentation

- [Dahlia changelog](https://docs.stripe.com/changelog/dahlia): July 29 GA release.
- [Versioning](https://docs.stripe.com/api/versioning): request Stripe-Version
  and webhook endpoint api_version are selected independently.
- [PaymentIntent](https://docs.stripe.com/api/payment_intents/object): amount,
  currency, status, metadata and nullable/expandable latest_charge.
- [Charge](https://docs.stripe.com/api/charges/object): nullable/expandable
  balance_transaction and nullable payment_method_details.
- [BalanceTransaction](https://docs.stripe.com/api/balance_transactions/object):
  fee/net are integer minor units in balance transaction currency.
- [Delayed fees](https://docs.stripe.com/expand/use-cases): expansion may return
  no balance transaction initially; IC+ fee visibility can differ.
- [Terminal testing](https://docs.stripe.com/terminal/references/testing) and
  [presentment helper](https://docs.stripe.com/api/terminal/readers/present_payment_method).

Exact-version object documentation URLs were unavailable through the docs tool.
Generic references and July changelog support the review; version-specific
evidence comes from real response headers/captures.

## Regression boundary

- Actual adapters: new calls pinned, stable idempotency, card_present/automatic,
  expanded retrieval, no version override on legacy calls.
- Actual parser: real captures, identity/amount/currency/metadata validation,
  missing fields and unsafe numeric rejection.
- Original 17 local PostgreSQL scenarios retained plus five real-capture replays
  through actual handler/SQL. Only IDs/metadata adapted to isolated seed data.
  Duplicate verify preserves payment ID/date/amount; audit captures fee/net;
  declined/canceled states create no CRM payment.
- Generated negative/delayed-fee cases explicitly synthetic, separate from real
  fixtures. Replays require no Stripe credentials or network.

## Future snapshot webhook

Use api_version=2026-07-29.dahlia when separately authorized, with events:
payment_intent.succeeded, payment_intent.payment_failed, payment_intent.canceled.
Do not create a production endpoint/secret or enable production gates in this PR.

## External test delivery (review head 73af546)

A temporary HTTPS tunnel exposed only the isolated local handler path. The
actual Worker handler and SQL used local PostgreSQL and the existing Stripe
Test mode key, with explicit API version. No production database or endpoint.

- Stripe test endpoint we_1UDVH6DN6dBh0lWZwluZEXyT delivered a real simulated
  Terminal success with its actual Stripe-Signature and signing secret.
- Invalid signature returned 400 before any Stripe retrieval.
- Stripe CLI resent the same event to that endpoint: both deliveries returned
  200, with exactly one USD 10.00 CRM payment. Payment ID/date and the complete
  job row (including amount and Balance inputs) remained unchanged on redelivery.
- Controlled delay: the first real retrieval deliberately masked
  balance_transaction to null. Redelivery used the actual expanded response,
  enriching audit fee/net to 32/968 cents without changing the job/payment.
  This is NOT an observation of a natural Stripe delay or production pricing.
- The test endpoint was disabled afterwards; tunnel and local database stopped.
  Test audit resources retained. Signing secret stayed in process memory only.

## Combined release and rollback plan (requires authorization)

1. Record current production branch SHAs, active Worker version, bindings and
   gate states. Merge this PR normally into source; use exact reviewed build.
2. Release Worker only through the established fast-forward/automatic build,
   with both gates OFF. Check health, auth, disabled responses and CRM reads.
   Do not release frontend/APK or change schema; the client integration exists.
3. Prepare the live snapshot endpoint at /api/stripe/webhook with the version
   and three events above. If creation enables it, disable immediately and
   inspect deliveries in that interval. Disabled processing returns 503, not
   a false acknowledgement; track those events for later redelivery.
4. Store its signing secret using a candidate/versioned secrets workflow, never
   an immediate secret-put deployment. Preserve bindings and other secrets.
   Deploy the verified candidate with webhook ON and attempts OFF, then enable
   the endpoint. Review/replay pending deliveries; unrelated legacy intents
   must not generate CRM payments. An HTTP 200 alone is not payment evidence.
5. Separately authorize the phone NFC test and any live amount/job before
   enabling attempts. Verify create/confirm/server verification, fresh job,
   duplicate delivery and audit once. Keep automatic fees/gross-up OFF.
6. On regression, stop NEW attempts first. Preserve webhook/reconciliation for
   in-flight intents; inspect their Stripe state before retrying any payment.
   Restore the recorded compatible Worker version if necessary, keeping failed
   deliveries retryable and explicitly replaying after recovery. Do not delete
   audit rows, reset payments, issue refunds, or roll back schema automatically.

No release or activation in this PR review. Android NFC remains a separate
phone validation, not claimed by the simulated Terminal results.

## Remaining limits

- Simulator is not Android NFC/hardware end-to-end verification.
- Natural late-fee timing not observed: successful automatic captures had fee/net
  on retrieval. Null-to-enriched stability is a local SQL regression, not a
  captured real delay.
- Live pricing, IC+, FX/multicurrency, refunds/disputes and real-money webhook
  delivery untested. Fee/net currency must be considered before any future
  desired-net/fee feature. No fee feature enabled here.
- Three selected events do not schedule late-fee retrieval; a reconciliation
  trigger remains necessary before promising automatic enrichment.
- External success/redelivery and actual signature verified as described above.
  Other ordering/atomic rollback cases remain controlled local PostgreSQL tests,
  not claims of naturally observed Stripe delivery ordering.
