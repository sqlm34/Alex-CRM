# Payment-date statistics and caller greeting

The income panel uses actual recorded payments, not invoice totals or visit dates.
Offline payments use the ledger's payment_date (the owner's received date), with
created_at only as a fallback. Other payments use their explicit timestamp,
converted to America/Indiana/Indianapolis. Invalid dates are excluded and flagged.
Pending, failed and voided payments are excluded. Moving or canceling a job does
not move its retained payments to another month. Legacy invoice report fields
remain compatible with the previous UI.

Parts expenses retain the existing service-date basis, explicitly labeled in the
UI. This is not a tax-profit or complete refund-ledger report. No source payment,
invoice, receipt or job is rewritten by the reporting migration.

Schema version 3 atomically backfills payment months and refreshes old/new months
on financial edits. Five-second lock timeout and thirty-second statement timeout
bound installation. Existing missing-receipt drilldown remains available.

Monthly acquisition counts distinguish ended Phone Emily and Website voice calls,
booked versus unbooked, including hangups and declined callback requests. Active
calls are excluded. Deleted conversations cannot be counted. New orders are
separate, grouped by creation month/source, excluding canceled orders.

Inbound Retell webhook personalizes only begin_message when a caller's normalized
phone matches exactly one normalized full customer name in CRM. Only the first
name is sent. Ambiguity, hidden/unknown numbers, invalid names and lookup failures
use the existing greeting. Blocked calls still reject before name lookup. Caller
ID does not authorize disclosure of customer records.

Validation: 606 regression tests passed, two pre-existing Nestwise concurrency
tests skipped without their dedicated database. Seven focused tests passed after
the final payment_date change. Four browser checks passed at 320/390/768/1280 px.
TypeScript, production frontend build/bundle checks and Worker dry run passed.

Production Worker: 4546fb57-e736-4dde-b173-671a7caac10d.
Rollback Worker: b5c13f44-f7ca-44bc-8802-3d01d5679f7a.
The code-only release verified all 66 bindings, runtime and handlers unchanged.
Base source: c01e36d, preserving Nestwise and missing-receipt improvements.
The existing Retell number already points to the signed inbound webhook; no voice,
agent prompt, phone routing, authentication or payment processor settings changed.

Frontend rollback: restore index.html from main cf0ca7b in a new commit; previous
hashed assets remain. Reporting tables may stay during rollback since original
fields remain unchanged. Avoid deploying stale wrangler.json variable defaults.
