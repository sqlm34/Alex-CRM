begin;
-- Inventory usage is job costing, not evidence of a new cash purchase.
-- Preserve existing projections and add only this provenance flag.
create or replace function nestwise_integration.source_projection(p_kind text,p_row jsonb) returns jsonb
language sql immutable as $$
 select case p_kind when 'stripe_attempt' then jsonb_build_object(
  'id',p_row->>'id','status',p_row->>'internal_status','stripe_status',p_row->>'stripe_status',
  'intent_id',p_row->>'stripe_payment_intent_id','charge_id',p_row->>'charge_id',
  'balance_transaction_id',p_row->>'balance_transaction_id','currency',p_row->>'currency',
  'charge_cents',p_row->>'charge_amount_cents','fee_cents',p_row->>'actual_fee_cents',
  'net_cents',p_row->>'actual_net_cents','recorded_at',p_row->>'completed_at')
 when 'parts_receipt' then jsonb_build_object(
  'id',p_row->>'id','status',p_row->>'status','deleted_at',p_row->>'deleted_at',
  'hash',p_row->>'content_hash','confirmed_at',p_row->>'confirmed_at',
  'currency',p_row->'data'->>'currency','expense_cents',p_row->'data'->>'expenseCents',
  'total_cents',p_row->'data'->>'totalCents','inventory_usage_id',p_row->>'inventory_usage_id')
 else '{}'::jsonb end;
$$;

create function nestwise_integration.guard_inventory_cash_review() returns trigger
language plpgsql security definer set search_path=nestwise_integration,pg_temp as $$
declare c changes;
begin
 select * into c from changes where id=new.change_id;
 if c.source_kind='parts_receipt' and (
   nullif(c.before_data->>'inventory_usage_id','') is not null
   or nullif(c.after_data->>'inventory_usage_id','') is not null
   or exists(select 1 from public.parts_receipts r where r.id=c.source_id
     and nullif(to_jsonb(r)->>'inventory_usage_id','') is not null)
 ) then raise exception 'inventory_usage_is_not_cash_purchase';end if;
 return new;
end $$;
-- These inserts occur in the same transaction as event creation. A rejected
-- review rolls back every attempted event/cursor change, including old captures.
create trigger reject_inventory_cash_review before insert on nestwise_integration.source_reviews
 for each row execute function nestwise_integration.guard_inventory_cash_review();
create trigger reject_inventory_cash_correction before insert on nestwise_integration.cost_corrections
 for each row execute function nestwise_integration.guard_inventory_cash_review();
revoke all on function nestwise_integration.guard_inventory_cash_review() from public;
commit;
