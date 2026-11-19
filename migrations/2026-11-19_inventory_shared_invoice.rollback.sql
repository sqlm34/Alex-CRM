begin;
set local lock_timeout='5s';
lock table inventory_batches in share row exclusive mode;
-- Include invoices added since the forward migration; never remove stock lots.
insert into inventory_invoice_numbers(supplier_key,invoice_key,transaction_id)
select distinct regexp_replace(upper(supplier),'[^A-Z0-9]','','g'),
  regexp_replace(upper(invoice_number),'[^A-Z0-9]','','g'),0
from inventory_batches
where regexp_replace(upper(invoice_number),'[^A-Z0-9]','','g')<>''
on conflict do nothing;
drop trigger if exists inventory_invoice_number_guard on inventory_batches;
create trigger inventory_invoice_number_guard before insert on inventory_batches
  for each row execute function inventory_guard_invoice_number();
commit;
