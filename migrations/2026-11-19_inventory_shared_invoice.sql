begin;
set local lock_timeout='5s';
lock table inventory_batches in share row exclusive mode;
-- An invoice identifies the supplier's whole purchase, not a single stock lot.
-- Manual create/restock requests may add its lines in separate transactions.
-- Keep operation UUID replay protection and scanned-invoice deduplication intact.
-- Preserve the historical guard table/function for audit and rollback.
drop trigger if exists inventory_invoice_number_guard on inventory_batches;
commit;
