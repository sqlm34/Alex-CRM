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
deployment, endpoint creation or APK change.

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
Do not create endpoint/secret or enable gates in this PR.

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
- Events captured via Events API. Signature/duplicate/order/rollback checks use
  actual local handler with synthetic signing secret, not external delivery.
