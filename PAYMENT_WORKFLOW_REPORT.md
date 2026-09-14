# Partial Payments Implementation

Status: implemented and verified locally. Not deployed. No live charges, emails,
production database migrations, or APK installations were performed.

## Release Audit: Do Not Deploy This Branch

The publication preflight fetched origin/source at d9953fe and discovered that
the implementation base (69dbc9a) is 120 commits behind it. The newer source
already includes stripe_payment_attempts, webhook reconciliation, offline_payments,
R2 attachments, and a changed Android payment bridge. The local payment_attempts
implementation is not integrated with those contracts. The tests below verify
only this older-base implementation, not compatibility with current production.
This branch is a preserved implementation draft, not a production release.
Port the requested behavior onto current source using its existing payment ledger
and webhook contracts, then rerun both current and new regression suites before
publishing. Do not deploy this branch's Worker or overwrite hostinger/source.

## 1. Root Causes

The persisted paid flag could remain true after the invoice increased. The old
client replaced entire payment arrays, counted unsuccessful payments, and could
erase history through Mark unpaid. PaymentIntent creation had no persistent
request idempotency or per-job collection guard.

## 2. Files

- shared/finance.ts: integer-cent calculations and item allocation validation.
- worker/payments.ts: durable attempts, Stripe verification, payment recording.
- worker/index.ts: endpoints, history protection, migration, PDF/email totals.
- src/App.tsx: next-payment editor, balance-driven actions, history and email flow.
- src/api.ts and src/supabase.ts: payment APIs and types.
- src/App.css: responsive payment dialog.
- tests/: finance, PostgreSQL integration, mocked browser flows and PDF samples.
- package.json, package-lock.json, playwright.config.ts, .gitignore: test tooling.

## 3. Database

Additive initialization creates jobs.legacy_paid_amount and payment_attempts.
Legacy paid jobs without a payment ledger retain an opening credit; no historical
Stripe transaction is invented. A partial unique index permits one active attempt
per job. Existing payment JSON history is retained. Migration has only been run
against isolated PGlite PostgreSQL in tests, not production Neon.

## 4. Backend

New prepare/record/recover flows check authorization and current balance.
Advisory locks and compare-and-swap writes protect concurrent changes. Financial
edits and deletion are blocked while a card collection is active. Historical
payments cannot be replaced through the general job PATCH endpoint.

## 5. Frontend

The user can collect a custom partial amount, selected items, or the remaining
balance. The pencil edits only the upcoming payment. Adding items after payment
reopens the balance. Amounts are validated in cents and cannot exceed the balance.
Double clicks are guarded synchronously. Existing transactions are not editable.

## 6. Stripe

Each attempt has a durable request ID used as a Stripe idempotency key. The server
retrieves the PaymentIntent and validates job metadata, currency, payment method,
and successful received amount before recording it. Native Android bridge code
was not changed; the existing request reuses the prepared active attempt.
Check pending payment reconciles a successful attempt or cancels an unsettled
intent. This is explicit recovery, not a new automatic webhook system.

## 7. Email

Payment does not require an email. An email can be added later, then the invoice
sent or resent. Debounced email writes are serialized and awaited before send.
The email provider and Cloudflare secrets must already be configured in production.

## 8. Invoices

Preview and send are available before full payment. Totals and payment history
exclude failed/canceled payments. PDFs include paid amount, remaining balance and
status; long tables/history paginate. Date-only due dates avoid timezone shifts.
The logo and existing invoice structure are retained. The two-payment sample was
rendered and visually checked on one page without overlapping content.

## 9. Verified Scenario

Job #23 test fixture: Parts $231.30 + Labor $157.80 = $389.10.
First payment: paid $231.30, remaining $157.80, collection remains available.
Second payment: paid $389.10, remaining $0.00, both transactions remain visible.
These are isolated test fixtures, not changes to the real customer's job.

## 10. Tests

- 16 finance and isolated PostgreSQL/Stripe/email tests passed.
- 2 Playwright desktop/simulated Android bridge scenarios passed.
- Frontend TypeScript and production build passed.
- Worker TypeScript check passed.
- Existing repository lint baseline: 9 errors and 2 warnings; no new errors
  were introduced at the baseline comparison. Lint is not globally clean.
- Existing large JavaScript bundle warning remains.

Tests require Node 24 (or a compatible runtime supporting direct TypeScript).
Run npm test, npm run test:ui, npm run check:worker, and npm run build.
Browser tests intercept API/Stripe operations; real-device NFC was not tested.

## 11. Release Considerations

Back up production data and deploy the Worker before the matching frontend.
Ensure the database role can perform the additive initialization. Smoke-test the
new UI and account access, then perform an explicitly authorized real-device
payment test. Do not run old clients concurrently with the new payment workflow:
their general payment-array PATCH requests are intentionally rejected.
No new signing key or native Android code change is required by this patch, but
delivery of frontend changes depends on the installed app's update mechanism.
Legacy/custom payments without item allocations are included in the overall
balance; the system does not guess which historical line item they paid.
