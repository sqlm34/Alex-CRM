-- Run as the existing database owner. Every test mutation is rolled back.
begin;
set local lock_timeout='3s';
set local statement_timeout='20s';
do $$
declare part uuid:=gen_random_uuid(); purchase uuid:=gen_random_uuid(); usage uuid:=gen_random_uuid();
  job text; actor text; command jsonb; result jsonb;
begin
  select id into job from jobs where status<>'canceled' order by id limit 1;
  select id::text into actor from users where role='owner' limit 1;
  if job is null or actor is null then raise exception 'Smoke-test prerequisites missing'; end if;
  perform inventory_create_part(jsonb_build_object('id',part,'name','TEST rollback only','part_number',part::text,
    'brand','TEST','location','','notes','','models','','low_stock',1),actor);
  command:=jsonb_build_object('requestId',purchase,'partId',part,'action','stock_in','quantity',4,
    'totalCents',4060,'date',current_date::text,'supplier','TEST rollback only');
  perform inventory_move(command,actor);
  perform inventory_move(command,actor);
  if (select sum(remaining) from inventory_batches where part_id=part)<>4 then raise exception 'Purchase replay duplicated stock'; end if;
  result:=inventory_move(jsonb_build_object('requestId',usage,'partId',part,'action','stock_out','quantity',2,'jobId',job),actor);
  if (result->>'costCents')::bigint<>2030 then raise exception 'Incorrect FIFO cost'; end if;
  if not exists(select 1 from parts_receipts where inventory_usage_id=usage and status='confirmed' and (data->>'expenseCents')::bigint=2030) then raise exception 'Missing job expense'; end if;
  if (select sum(remaining) from inventory_batches where part_id=part)<>2 then raise exception 'Incorrect remaining stock'; end if;
  perform inventory_move(jsonb_build_object('requestId',gen_random_uuid(),'partId',part,'action','return','quantity',2,'usageId',usage),actor);
  if (select sum(remaining_cents) from inventory_batches where part_id=part)<>4060 then raise exception 'Return lost purchase cost'; end if;
  if not exists(select 1 from parts_receipts where inventory_usage_id=usage and status='voided') then raise exception 'Return did not void expense'; end if;
end $$;
rollback;
select 'FIFO, replay, job expense and return passed; all test changes rolled back' as result;
