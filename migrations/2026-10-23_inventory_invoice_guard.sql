begin;
set local lock_timeout='5s';
lock table inventory_batches in share row exclusive mode;
-- A single transaction may import multiple lines of one invoice, but later
-- purchases cannot claim that invoice again. Unique keys serialize races.
create table if not exists inventory_invoice_numbers (
  supplier_key text not null,
  invoice_key text not null,
  transaction_id bigint not null,
  primary key (supplier_key, invoice_key)
);
insert into inventory_invoice_numbers(supplier_key,invoice_key,transaction_id)
select distinct regexp_replace(upper(supplier),'[^A-Z0-9]','','g'),
  regexp_replace(upper(invoice_number),'[^A-Z0-9]','','g'),0
from inventory_batches
where regexp_replace(upper(invoice_number),'[^A-Z0-9]','','g')<>''
on conflict do nothing;

create or replace function inventory_guard_invoice_number() returns trigger language plpgsql as $$
declare supplier_key_value text := regexp_replace(upper(new.supplier),'[^A-Z0-9]','','g');
  invoice_key_value text := regexp_replace(upper(new.invoice_number),'[^A-Z0-9]','','g');
  original_transaction bigint;
begin
  if invoice_key_value='' then return new; end if;
  insert into inventory_invoice_numbers(supplier_key,invoice_key,transaction_id)
    values(supplier_key_value,invoice_key_value,txid_current()) on conflict do nothing;
  select transaction_id into original_transaction from inventory_invoice_numbers
    where supplier_key=supplier_key_value and invoice_key=invoice_key_value;
  if original_transaction<>txid_current() then
    raise exception 'This invoice number has already been added for this supplier. Stock was not changed.';
  end if;
  return new;
end $$;
drop trigger if exists inventory_invoice_number_guard on inventory_batches;
create trigger inventory_invoice_number_guard before insert on inventory_batches
  for each row execute function inventory_guard_invoice_number();
revoke all on inventory_invoice_numbers from public;
alter table inventory_invoice_numbers enable row level security;
revoke all on function inventory_guard_invoice_number() from public;
commit;
