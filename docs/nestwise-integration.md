# Nestwise integration — development, disabled by default

Companion to the first large Nestwise delivery. This checkout starts at
`b407ee3`; unrelated changes in the original CRM checkout are preserved.

## Migration and rollback plan

Apply additive integration tables/functions/triggers only to an isolated CRM
copy first. Capture and dispatch both default OFF. Job/payment/receipt schemas,
Stripe charging and customer integrations retain their current behavior.
Capture runs in the same PostgreSQL transaction as a source mutation, so a
committed financial change cannot lose its integration record.

The producer must distinguish invoice sale prices from purchase costs. Confirmed
parts receipts provide cost evidence, but do not by themselves establish a cash
payment date or settlement type. Offline payments use `offline_payments.payment_date`,
not the JSON materialization timestamp. Voiding a payment is not automatically a
customer refund. Unsupported corrections stop for review rather than inventing
facts. Historical baselines require a dry-run and owner approval before delivery.

Before enabling a canary: verify receiver connection, scoped signing secrets,
financial scenarios, duplicate/retry/concurrency tests, database restore and CRM
regression. Never activate a producer against the live CRM as part of development.

Rollback disables capture/dispatch and reverts application code. Preserve captured
changes, event identities, delivery attempts and ACKs; do not delete financial
history or rewrite payments. No production deployment has been performed.

## Current implementation checkpoint

The migration captures projected job changes and source offline-payment facts
atomically, with the actual `payment_date`. Personal notes and customer fields
are excluded. Capture defaults off. Conversion from captured changes to canonical
Nestwise payment events is implemented for new successful offline payments;
capture does not invent refunds from voids. Materialized job-payment updates do
not emit a second payment. Unknown/changed/deleted facts stop their stream for
review without blocking other orders. Stripe, parts and corrective events remain
pending and must not be silently approximated.

Outbox delivery preserves event bytes and IDs, uses fresh HMAC nonces on retry,
leases ordered events, verifies durable ACK identity and records bounded retries
and dead letters. The existing scheduler invokes it only when explicitly enabled
with `NESTWISE_ENVIRONMENT=staging`. No configuration has been enabled.

Thirteen targeted tests pass; preview Worker dry-run builds. A separate two-database
integration test signs real CRM output and sends it through the Nestwise receiver:
two partial payments retain their dates, and a lost ACK/retry does not double the
journal. Owner-only sync/retry endpoints, an opt-in UI, immutable operator audit
and paginated read-only historical dry-run are implemented. The broad CRM suite
has six unavailable-PostgreSQL failures plus three job-text/startup source
assertion failures. The same three assertions fail against the unmodified b407ee3
sources and tests, verified using a separate extracted baseline. Full acceptance
remains open; these existing failures are not being hidden or weakened.

Still required: parts/Stripe/correction/finalization provenance and approved
resolution workflow, scoped deployment permissions, isolated real-PostgreSQL
concurrency and restore, browser acceptance and receiver staging verification.
Historical dry-run never imports data; refunds remain unknown where source
evidence is absent. No flags, live migrations or deployment have been enabled.

Optional Stripe/parts source tables now have projected evidence triggers when
present at migration time. Pending attempts and draft receipts do not produce
financial facts; confirmed changes roll back with their source transaction.
No card metadata, supplier text or user identities enter these captures. Missing
actual payment dates remain missing; recorded_at is never relabeled as paid_at.
These sources remain held for review until their canonical conversion is complete.
Seven outbox tests (14 targeted tests in total) pass after this addition. Before
activation verify both optional triggers exist; installing source modules later
requires a versioned follow-up migration, not silent loss of source coverage.
