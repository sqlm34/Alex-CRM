# Shared supplier invoice numbers

Manual stock creation and restocking may use the same supplier invoice number
across multiple parts and requests. Each purchase amount is the cost allocated
to that part/batch, not the full invoice amount repeated on every line.

Apply `migrations/2026-11-19_inventory_shared_invoice.sql` after the existing
inventory migrations. It removes only the cross-request invoice-number trigger.
Operation UUID replay protection, scanned-file recognition reuse, and confirmed
invoice import fingerprint checks remain unchanged. No purchase data is rewritten.

Before production, retain a database snapshot/branch and compare row fingerprints
for inventory parts, batches, movements, operations, invoice imports and usages.
Run the inventory tests and rehearse on an isolated production branch.

To restore the previous restriction, apply the matching `.rollback.sql`. It
re-registers invoice numbers added since release and restores the trigger,
without deleting purchases or changing quantities or costs.
