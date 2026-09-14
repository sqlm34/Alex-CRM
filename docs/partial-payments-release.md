# Partial Payments Release

Implemented on current source d9953fe, not the obsolete draft cd91e1a.
The existing stripe_payment_attempts ledger, webhook reconciliation, offline
payments, Android protocol 2 and R2 attachments are preserved. No new database
table or migration is required by this change.

## Behavior

- Tap to Pay opens an amount dialog; the pencil edits the upcoming charge only.
- Select one or multiple items, the remaining balance, or enter a custom amount.
- Stripe's existing minimum of $0.50 applies; overpayments are rejected.
- Outstanding balance, not a stale paid flag, controls card collection.
- Existing server attempts continue to enforce idempotency and verification.
- Failed, canceled, pending, refunded and voided payments do not reduce net debt.
- Invoice preview/send is available before full payment and can be used again.
- Pending email saves are serialized and awaited before invoice sending.
- The destructive Mark unpaid history-clearing action has been removed.
- Item selection determines the charge amount; it does not invent allocation of
  historical payments to individual items. The total remaining balance is enforced.

## Verification

260 tests passed, including real isolated PostgreSQL booking/concurrency and
Stripe webhook regressions; no skips. Two Playwright cases passed at 360px and
1280px. TypeScript and production build passed. Worker dry-run passed.
The Job 23 scenario is synthetic: $389.10 total, $231.30 then $157.80, zero debt,
two retained payments. Adding another $50 item reopens a $50 balance.

No real card charge or customer email was used during testing. Real NFC reader
interaction still requires an authorized device test. Existing unrelated lint
findings remain in the application/backend and generated Android output; this
release does not claim a globally clean lint run.

## Local Environment

Use Node 24 and npm ci. The public Maps browser key was recovered from the current
deployed frontend into ignored .env.local; no private key was added to Git.
Database integration tests require a disposable loopback PostgreSQL database
named webhook_test with the test-only credentials specified in the scripts.
Set STRIPE_WEBHOOK_TEST_PORT and GOOGLE_ACTIONS_TEST_PORT to that server's port.
Never point these tests at customer data. npm test runs the unit/integration suite;
npx playwright test runs UI tests; npm run build builds production assets.

## Publishing

Deploy the updated Worker, then publish the generated dist assets to the existing
main frontend branch. Keep existing Worker bindings and secrets. Installed apps
that load the hosted frontend receive the web update; no native bridge change is
included. The draft branch remains archived work and must not be deployed.
