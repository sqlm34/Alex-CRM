# Diagnostic receipts and paused item markup

- New item prices use `base-only-v1`: $200 entered means $200 before any explicitly configured sales tax or discount. No automatic percentage or fixed markup.
- `src/itemPricing.ts` keeps the historical 5% + $0.30 formula. `itemMarkupEnabled` is false. Re-enabling requires a coordinated frontend/Worker release and pricing tests; no historical migration is needed.
- Existing stored prices, payments, Stripe processor costs and receipts are not rewritten. An explicit change to an old item's base price adopts the current policy.
- Statistics schema 4 excludes invoices containing only normalized `Service call` labels from both missing-receipt counts and the order list. It does not infer diagnostics from the $89 amount. Empty, unknown and mixed invoices remain subject to receipt checks.
- Schema installation atomically backfills report aggregates only. Adding a part to a diagnostic invoice makes it eligible for the missing-receipt list again.

## Verification and rollback

Run isolated statistics, item-base-price-markup and finance-item-flow tests, TypeScript build, production bundle verification and regression tests. No real payment is necessary.

Deploy Worker code while preserving live bindings, then publish the matching frontend build. Roll back to Worker `4546fb57-e736-4dde-b173-671a7caac10d` and frontend `d8ffdfa` if needed. Keep compatibility for `base-only-v1` when investigating pricing rollback; do not bulk recalculate existing invoices. Restoring the old receipt report behavior additionally requires reinstalling the preceding statistics functions and refreshing report aggregates. Existing jobs and payments are not rollback targets.
