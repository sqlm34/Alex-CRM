# Confirmed income and prompt CRM delivery

Recorded payments become eligible on Done, or earlier when a confirmed paid parts receipt exists. Invoice totals are never fabricated as payments. A previously acknowledged cash payment remains recorded if the job is reopened or canceled; an explicit refund is required to reverse money.

Confirmed non-stock receipts are paid purchases on their original receipt date. Stock consumption remains job costing and cannot create another cash withdrawal. Ambiguous corrections and unknown dates remain held. Source resolution is recorded in immutable policy_resolutions.

Every existing financial write schedules durable outbox dispatch. The dispatcher continues when source conversion progresses even if the current revision has no deliverable event. Retries retain identity and ordering. Nestwise's foreground journal and overview already refresh every five seconds.

Jobs shows missing/partial payment reminders only for Done orders with a positive invoice and loaded payment evidence. It never asks the customer to pay again.

## Release and recovery

1. Pass PR checks, financial-contract PostgreSQL tests and restore verification.
2. Take a Neon production snapshot. Record current Worker version and frontend main commit privately.
3. Apply 2026-11-04_nestwise_income_policy.sql with the policy disabled. Apply 2026-11-04_statistics_cash.sql atomically; it changes derived reports, not source payments/receipts.
4. Publish Worker code with all live bindings preserved and matching frontend through its own main PR.
5. Enable done_or_parts_enabled in the existing configuration. Verify source counts and cents, drain through the authenticated CRM integration action, then compare November journal totals in Nestwise. Repeat delivery and verify no new monetary rows.
6. Keep no invented transactions or customer data in release evidence.

To stop automatic source acceptance, set done_or_parts_enabled=false. Roll back Worker to the recorded version and frontend to the recorded main commit. Apply statistics_cash.rollback.sql if restoring the old report policy. Retain all financial events and policy audit: neither rollback nor job status edits erase acknowledged money. Do not restore a full snapshot over newer customer writes; use it for isolated recovery and evidence.
