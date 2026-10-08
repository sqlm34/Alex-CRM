# Persisted monthly statistics

`GET /api/statistics` is authenticated and owner-only. It reads saved monthly
reports from `crm_monthly_statistics`, including daily source counts, invoice
gross, confirmed parts costs, recorded fees, net, and missing-receipt counts.
The phone fetches reports once per page opening; switching months is local.

The first authorized call installs `worker/statisticsStorage.ts` atomically
and backfills every existing service month. No original orders, payments,
attachments or receipts are modified. Installation locks the two source tables
briefly to avoid gaps between backfill and trigger activation. A version marker
prevents repeated installation on Worker cold starts.

PostgreSQL AFTER triggers refresh affected months in the same transaction as
job or receipt changes, including invoice items, fees, cancellation, deletion,
date/source changes and receipt confirmation/void/discard. An advisory
transaction lock serializes report updates. Rollback rolls back the report too.
Unrelated job edits do not refresh reports. Reads never rescan orders or receipts.

Accounting basis is unchanged: non-canceled orders by service month, including
unpaid invoices and invoice tax. Net subtracts recorded confirmed parts expenses
and payment fees, not unrecorded costs or tax remittances. Old months without
receipts remain provisional; a missing receipt is not evidence of zero real cost.

Validation: `scripts/statistics-storage.test.mjs` uses isolated PostgreSQL schemas;
`e2e/statistics.spec.ts` verifies a single report request and zero detail reads.
Before deployment, compare backfilled reports against the prior monthly totals.

Rollback: deploy the previous frontend and Worker. The additive report tables
and triggers can remain; they do not change source financial data. If disabling
triggers is necessary, have an operator disable only `crm_jobs_statistics` and
`crm_receipts_statistics`; re-enable and backfill before serving reports again.
