begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
select pg_advisory_xact_lock(810052026);
-- Cash receipt is independent of order completion. Preserve source validation,
-- corrections review, immutable event IDs, leasing and per-order sequencing.
create or replace function nestwise_integration.process_changes(p_limit integer default 20) returns integer
language plpgsql security definer set search_path=nestwise_integration,pg_temp as $$
declare c changes; s order_streams; receipt jsonb; paid date; total integer; decision text;
begin
 total:=process_changes_before_income_policy(p_limit);
 if not (select capture_enabled and done_or_parts_enabled from configuration where singleton) then return total;end if;
 for c in select x.* from changes x join order_streams os on os.job_id=x.job_id
  where x.capture_revision=os.processed_capture_revision+1 and os.review_reason in ('source_requires_review','order_lifecycle_requires_review')
   and (income_eligible(x.job_id) or x.source_kind='parts_receipt')
  order by x.created_at,x.id limit p_limit for update of os skip locked
 loop
  decision:=null;
  if c.source_kind='parts_receipt' then
   select to_jsonb(r) into receipt from public.parts_receipts r where r.id::text=c.source_id and r.job_id=c.job_id;
   if receipt is null or source_projection('parts_receipt',receipt) is distinct from c.after_data then continue;end if;
   if nullif(receipt->>'inventory_usage_id','') is not null then
    -- Immutable job-cost evidence retained; do not invent another cash purchase.
    update changes set processed_at=clock_timestamp() where id=c.id;
    update order_streams set processed_capture_revision=c.capture_revision,review_reason=null where job_id=c.job_id;
    decision:='inventory_non_cash';
   elsif coalesce(c.before_data->>'status','')<>'confirmed' and c.after_data->>'status'='confirmed'
    and coalesce(receipt->'data'->>'date','') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    begin
     paid:=(receipt->'data'->>'date')::date;
     if to_char(paid,'YYYY-MM-DD') is distinct from receipt->'data'->>'date' then continue;end if;
     perform confirm_source(gen_random_uuid(),c.id,'policy:done-or-parts-v1',paid,
      'Owner policy: confirmed purchase is paid on receipt date.');
     decision:='paid_receipt';
    exception when invalid_datetime_format or datetime_field_overflow then continue;
     when raise_exception then if SQLERRM not in ('unsupported_source_review','review_conflict') then raise;end if;
    end;
   end if;
  elsif c.source_kind='job' and c.before_data->>'status'=c.after_data->>'status'
   and (c.before_data-'payments'-'paid') is not distinct from (c.after_data-'payments'-'paid')
   and not exists(select 1 from jsonb_array_elements(c.before_data->'payments') p
    where not exists(select 1 from jsonb_array_elements(c.after_data->'payments') q where q=p))
   and not exists(select 1 from jsonb_array_elements(c.after_data->'payments') p where
    p->>'status' is distinct from 'succeeded' or not exists(select 1 from outbox o where o.job_id=c.job_id
     and o.body::jsonb->>'type'='job.payment_recorded'
     and o.body::jsonb->>'source_fact_id'=case when p->>'source'='offline' then 'offline:'||(p->>'id')
      when p->>'source'='stripe_terminal' then 'stripe:'||(p->>'payment_intent_id') end
     and (o.body::jsonb->>'amount_cents')::numeric=case when p->>'amount' ~ '^[0-9]+([.][0-9]{1,2})?$' then (p->>'amount')::numeric*100 end)) then
   update changes set processed_at=clock_timestamp() where id=c.id;
   update order_streams set processed_capture_revision=c.capture_revision,review_reason=null where job_id=c.job_id;
   decision:='materialized_payment';
  elsif c.source_kind='job' and c.after_data->>'status'='complete'
   and c.before_data->>'status' is distinct from c.after_data->>'status'
   and c.before_data->'payments' is not distinct from c.after_data->'payments'
   and exists(select 1 from public.jobs j where j.id=c.job_id and j.status='complete') then
   begin
    perform confirm_lifecycle(gen_random_uuid(),c.id,'policy:done-or-parts-v1','finalize','Owner policy: Done confirms completed order financials.');
    decision:='done';
   exception when raise_exception then if SQLERRM not in ('unsupported_source_review','review_conflict') then raise;end if;
   end;
  end if;
  if decision is not null then
   insert into policy_resolutions(change_id,policy,resolution) values(c.id,'done-or-parts-v1',decision);
   total:=total+1;
  end if;
 end loop;
 return total;
end $$;
create or replace function nestwise_integration.claim_delivery(p_limit integer default 10) returns setof nestwise_integration.outbox
language plpgsql security definer set search_path=nestwise_integration,pg_temp as $$
begin
 if p_limit is null or p_limit not between 1 and 20 then raise exception 'invalid_limit';end if;
 with expired as (
   update outbox set status='dlq',lease_until=null where status='leased' and attempts>=12 and lease_until<clock_timestamp()
   returning id,attempts,lease_id
 ) insert into delivery_attempts(event_id,attempt,lease_id,http_status,outcome) select id,attempts,lease_id,null,'lease_exhausted' from expired;
 return query with selected as (
  select o.id from outbox o join order_streams s on s.job_id=o.job_id
  where s.review_reason is null and o.attempts<12 and
    (not (select done_or_parts_enabled from configuration where singleton)
     or income_eligible(o.job_id)
     or o.body::jsonb->>'type' in ('job.part_cost_recorded','job.customer_refund_issued','job.cost_corrected','job.reopened','job.voided')) and
    (o.status='pending' and o.next_attempt_at<=clock_timestamp() or o.status='leased' and o.lease_until<clock_timestamp())
    and not exists(select 1 from outbox earlier where earlier.job_id=o.job_id and earlier.order_revision<o.order_revision and earlier.status<>'acked')
  order by o.created_at,o.id for update of o skip locked limit p_limit
 ) update outbox o set status='leased',attempts=o.attempts+1,lease_id=gen_random_uuid(),lease_until=clock_timestamp()+interval '2 minutes'
   from selected where o.id=selected.id returning o.*;
end $$;

commit;
