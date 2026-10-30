# Explicit offline customer refunds

A void removes an offline payment from CRM totals but does not prove that money
was returned. The Nestwise receiver already understands linked customer refunds;
the CRM producer previously held these source changes for review indefinitely.

The owner can now inspect a captured succeeded-to-voided offline payment under
Settings → Nestwise synchronization → Inspect source evidence. Record a full
customer refund only after checking the original payment, the actual refund date,
and that the refund has not separately been entered in Nestwise. This records an
already completed refund; it never calls a payment processor or sends money.

The server derives the amount and reference from the immutable posted payment.
The browser cannot choose an amount, destination, original event or actor. The
source must still match the captured evidence, the original event must have a
durable `posted` ACK, and the refund date cannot precede payment. The original
income remains unchanged. One immutable refund attestation and one stable
`job.customer_refund_issued` event are created atomically. Repeat the exact same
command after a lost response; changed commands and duplicate full refunds fail.

This path supports full refunds of previously posted offline payments. Partial
refunds, Stripe refunds, refunds of unimported payments and correcting an entry
where no money changed hands remain explicit review cases. Do not use a cost
correction or supplier credit to represent money returned to a customer.

The second job-JSON projection of the same reviewed void is acknowledged without
posting again. Only an exact one-payment status change is eligible; unrelated
amounts, payments and job-status changes stay blocked. Finalization snapshots
include gross payments and customer refunds separately, matching the receiver.

## Migration and release

Apply `2026-10-30_nestwise_customer_refunds.sql` after the existing outbox, source
review, cost correction, lifecycle and inventory guard migrations. Existing
October history-import migration remains unchanged. Before production, take a
fresh snapshot and verify the migration and source evidence on a separate restored
branch. Use the migration owner; retain existing runtime privileges. PUBLIC has no
access to the new table or privileged functions. The new endpoint uses the same
owner-only database identity as the existing source-review endpoints.

Release the Worker endpoint and synchronization UI together after checks. Neither
the migration nor release automatically confirms any void or imports history.
Existing dispatch flags, keys, receiver mapping and delivery window are retained.
Verify the exact payment/event identity before confirming a real source review.
After delivery check both the CRM ACK (`posted`, not just HTTP 202) and the selected
Nestwise account's linked refund, date and resulting totals.

Rollback disables new confirmations and reverts Worker/UI; retain the additive
schema, outbox and financial history. Never delete acknowledged events or replay
the return with a new identity. The prior converter remains available internally
as `process_changes_before_refunds`, with PUBLIC access revoked. Do not restore
the live database over newer orders to undo a refund.

## Verification

Local PostgreSQL 17 integration suite: 39 passed, none skipped. Includes concurrent
refund confirmations, immutable audit, original-source mismatch, unposted original
rejection, unrelated changes remaining held, full refund idempotency, and existing
source/transport scenarios. Populated dump/restore retained every table fingerprint
and the new immutable refund audit. TypeScript and scoped ESLint passed.

The two-database signed receiver test proves a 165.00 payment on October 28 and a
linked 165.00 refund on October 29, with lost-ACK retry, unchanged original income,
one refund posting, and correct finalization totals. A disposable browser fixture
using the real component and admin handler verified date/evidence confirmation,
an artificial 503 after commit, and successful same-command retry with one audit
record. All acceptance data is synthetic; these tests do not claim production
migration, deployment or correction of a real customer's record.
