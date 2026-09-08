# Stripe webhook activation prerequisites

Both gates default OFF and accept only the exact string `true`.
`STRIPE_PAYMENT_ATTEMPTS_ENABLED` controls new attempt creation.
`STRIPE_WEBHOOK_ENABLED` independently controls webhook processing.
Existing attempt status/verify/cancel remain authenticated and job-authorized even
when creation is disabled. Offline payments must respect existing reservations.
Disabled webhook returns 503 before DB/Stripe work; missing signing secret also
returns 503. Unknown/legacy PaymentIntents are ignored, not imported as payments.

## Unfinished API version pinning

No version is selected or pinned by this PR. Legacy Stripe requests are unchanged.
Owner-only GET `/api/stripe/diagnostics` uses the deployed secret internally for
GET account and balance, returning only accountId, livemode and apiVersion.
API version is reported only when both response headers agree; otherwise unknown.
It does not return financial data or establish a versioned API-contract guarantee.
Before activation confirm expected account, live/test mode and effective API
version. If unknown, inspect correlated Stripe request logs read-only. Validate
snapshot/PaymentIntent/Charge/Balance Transaction fixtures for that version and
pin it in a separate reviewed change scoped ONLY to attempts/webhook requests.
The local PostgreSQL scenarios use synthetic Stripe fixtures, not a real Stripe
contract validation. Do not accept the Dashboard version default automatically.

## Separate authorized activation stages

1. Review/merge and separately release this fix with both gates OFF.
2. Confirm account/mode/version and repeat endpoint duplicate check.
3. With separate permission, record the start time, create the three snapshot
   subscriptions (payment_intent.succeeded, payment_intent.payment_failed,
   payment_intent.canceled), immediately disable, verify disabled via readback.
4. Store the signing secret outside Git/logs, then use versioned secrets workflow
   against the verified production code/bindings to create a candidate without
   traffic changes. Do not use `wrangler secret put` or deploy implicitly.
5. Inventory all deliveries/events spanning creation and disable, including 2xx
   responses from any older Worker. Disabling can stop automatic retries; retain
   event IDs and reconcile the complete interval, not just failed deliveries.
6. Separately approve webhook-only activation with creation still OFF, enable
   destination and explicitly replay missed events within Stripe retention limits.
   Verify audit/payment idempotency; unknown legacy intents remain ignored.
7. Only after reconciliation and contract validation approve new attempts.

No endpoint creation, secret/config mutation, migration, deployment, real Stripe
request, connection token or payment is performed by this PR or its local tests.
