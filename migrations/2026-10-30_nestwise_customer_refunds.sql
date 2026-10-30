begin;
-- A void is NOT evidence of returned money. Only an explicit owner attestation
-- can release a full offline refund against an already posted source payment.
create table nestwise_integration.customer_refunds(
 id uuid primary key, change_id uuid not null unique references nestwise_integration.changes,
 payment_event uuid not null unique references nestwise_integration.outbox,
 refund_event uuid not null unique references nestwise_integration.outbox,
 actor text not null, paid_on date not null, evidence text not null,
 created_at timestamptz not null default clock_timestamp()
);
create trigger immutable_customer_refunds before update or delete on nestwise_integration.customer_refunds
 for each row execute function nestwise_integration.immutable();

create function nestwise_integration.confirm_customer_refund(p_command uuid,p_change uuid,p_actor text,p_paid date,p_evidence text)
returns uuid language plpgsql security definer set search_path=nestwise_integration,pg_temp as $$
declare c changes; s order_streams; prior customer_refunds; original outbox;
 source public.offline_payments; event_id uuid; body text;
begin
 if p_command is null or p_change is null or p_actor is null or length(trim(p_actor)) not between 1 and 128
  or p_paid is null or p_paid not between '1900-01-01' and '2199-12-31'
  or p_evidence is null or length(trim(p_evidence)) not between 10 and 1000
  then raise exception 'invalid_customer_refund';end if;
 select * into c from changes where id=p_change;
 if not found or c.source_kind<>'offline_payment' then raise exception 'unsupported_customer_refund';end if;
 -- Same lock order as source writes: job, payment, stream. Never rewrite them.
 perform 1 from public.jobs where id=c.job_id for update;
 select * into source from public.offline_payments where id::text=c.source_id and job_id=c.job_id for update;
 if not found then raise exception 'unsupported_customer_refund';end if;
 select * into s from order_streams where job_id=c.job_id for update;
 select * into prior from customer_refunds where id=p_command;
 if found then
  if (prior.change_id,prior.actor,prior.paid_on,prior.evidence) is distinct from
   (p_change,p_actor,p_paid,trim(p_evidence)) then raise exception 'refund_command_conflict';end if;
  return prior.id;
 end if;
 if not (select capture_enabled from configuration where singleton)
  or c.processed_at is not null or c.capture_revision<>s.processed_capture_revision+1
  or s.review_reason is distinct from 'offline_correction_requires_review'
  or c.before_data->>'status' is distinct from 'succeeded' or c.after_data->>'status' is distinct from 'voided'
  or c.after_data->>'voided_at' is null
  or (c.before_data-'status'-'voided_at') is distinct from (c.after_data-'status'-'voided_at')
  or offline_snapshot(source) is distinct from c.after_data
  then raise exception 'unsupported_customer_refund';end if;
 select * into original from outbox o where o.job_id=c.job_id
  and o.body::jsonb->>'source_fact_id'='offline:'||c.source_id
  and o.body::jsonb->>'type'='job.payment_recorded';
 if not found or original.status<>'acked' or original.receiver_status is distinct from 'posted'
  or original.body::jsonb->>'currency' is distinct from 'USD'
  or (original.body::jsonb->>'amount_cents')::bigint is distinct from source.amount_cents
  or original.body::jsonb->>'paid_at' is distinct from source.payment_date::text||'T00:00:00.000Z'
  or (select count(*) from outbox o where o.job_id=c.job_id and o.body::jsonb->>'source_fact_id'='offline:'||c.source_id)<>1
  or p_paid<source.payment_date
  or exists(select 1 from outbox o where o.body::jsonb->>'reference_event_id'=original.id::text
    and o.body::jsonb->>'type'='job.customer_refund_issued')
  then raise exception 'unsupported_customer_refund';end if;
 event_id:=gen_random_uuid();
 body:=jsonb_build_object('schema_version',1,'source_event_id',event_id,'source_order_id',c.job_id,
  'source_fact_id','refund:offline:'||c.source_id,'order_revision',s.emitted_revision+1,
  'type','job.customer_refund_issued','currency','USD','amount_cents',source.amount_cents,
  'reference_event_id',original.id,
  'occurred_at',to_char(c.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'paid_at',p_paid::text||'T00:00:00.000Z')::text;
 insert into outbox(id,job_id,order_revision,change_id,body,body_hash)
  values(event_id,c.job_id,s.emitted_revision+1,c.id,body,encode(sha256(convert_to(body,'UTF8')),'hex'));
 insert into customer_refunds(id,change_id,payment_event,refund_event,actor,paid_on,evidence)
  values(p_command,c.id,original.id,event_id,p_actor,p_paid,trim(p_evidence));
 update changes set processed_at=clock_timestamp() where id=c.id;
 update order_streams set processed_capture_revision=c.capture_revision,
  emitted_revision=s.emitted_revision+1,review_reason=null where job_id=c.job_id;
 return p_command;
exception when unique_violation then raise exception 'refund_command_conflict';
end $$;

-- The job JSON is a second projection of the same void. Acknowledge only that
-- exact projection after the owner confirmed the source refund. Unrelated
-- payment/status/amount changes must still stop for review.
alter function nestwise_integration.process_changes(integer) rename to process_changes_before_refunds;
create function nestwise_integration.process_changes(p_limit integer default 20) returns integer
language plpgsql security definer set search_path=nestwise_integration,pg_temp as $$
declare c changes; old_payment jsonb; new_payment jsonb; changed integer; processed integer:=0;
begin
 if p_limit is null or p_limit not between 1 and 100 then raise exception 'invalid_limit';end if;
 if not (select capture_enabled from configuration where singleton) then return 0;end if;
 for c in select x.* from changes x join order_streams s on s.job_id=x.job_id
  where x.capture_revision=s.processed_capture_revision+1 and x.source_kind='job'
   and (s.review_reason is null or s.review_reason in('payment_correction_requires_review','order_lifecycle_requires_review'))
  order by x.created_at,x.id limit p_limit for update of s skip locked
 loop
  if c.before_data->>'status' is distinct from c.after_data->>'status'
   or (c.before_data-'payments'-'paid') is distinct from (c.after_data-'payments'-'paid')
   or jsonb_array_length(c.before_data->'payments')<>jsonb_array_length(c.after_data->'payments') then continue;end if;
  select count(*) into changed from (
   (select value from jsonb_array_elements(c.before_data->'payments') except all
    select value from jsonb_array_elements(c.after_data->'payments'))
  ) differences;
  if changed<>1 then continue;end if;
  select value into old_payment from jsonb_array_elements(c.before_data->'payments')
   where value not in(select value from jsonb_array_elements(c.after_data->'payments'));
  select value into new_payment from jsonb_array_elements(c.after_data->'payments')
   where value not in(select value from jsonb_array_elements(c.before_data->'payments'));
  if old_payment->>'source' is distinct from 'offline' or new_payment->>'status' is distinct from 'voided'
   or old_payment->>'status' is distinct from 'succeeded' or new_payment->>'voided_at' is null
   or (old_payment-'status'-'voided_at') is distinct from (new_payment-'status'-'voided_at')
   or not exists(select 1 from customer_refunds r join changes source on source.id=r.change_id
    where source.job_id=c.job_id and source.source_id=old_payment->>'id'
     and source.capture_revision<c.capture_revision
     and (source.after_data->>'voided_at')::timestamptz=(new_payment->>'voided_at')::timestamptz
     and (source.after_data->>'amount_cents')::numeric=(new_payment->>'amount')::numeric*100)
   then continue;end if;
  update changes set processed_at=clock_timestamp() where id=c.id;
  update order_streams set processed_capture_revision=c.capture_revision,review_reason=null where job_id=c.job_id;
  processed:=processed+1;
 end loop;
 return processed+process_changes_before_refunds(p_limit);
end $$;
-- Finalizing a refunded order asserts gross payments AND refunds separately.
create or replace function nestwise_integration.confirm_lifecycle(p_command uuid,p_change uuid,p_actor text,p_action text,p_evidence text)
returns uuid language plpgsql security definer set search_path=nestwise_integration,pg_temp as $$
declare c changes;s order_streams;prior lifecycle_reviews;kind text;last_kind text;
 totals jsonb;payments numeric;parts numeric;fees numeric;refunds numeric;event_id uuid;body text;
begin
 if p_command is null or p_change is null or p_actor is null or length(p_actor) not between 1 and 128
  or p_action is null or p_action not in ('finalize','reopen','void')
  or p_evidence is null or length(trim(p_evidence)) not between 10 and 1000 then raise exception 'invalid_source_review';end if;
 select * into c from changes where id=p_change;
 if not found then raise exception 'review_conflict';end if;
 select * into s from order_streams where job_id=c.job_id for update;
 select * into prior from lifecycle_reviews where id=p_command;
 if found then
  if (prior.change_id,prior.actor,prior.action,prior.evidence) is distinct from (p_change,p_actor,p_action,trim(p_evidence)) then raise exception 'review_conflict';end if;
  return prior.id;
 end if;
 if not (select capture_enabled from configuration where singleton) or c.processed_at is not null
  or c.capture_revision<>s.processed_capture_revision+1 or s.review_reason is distinct from 'order_lifecycle_requires_review'
  or c.source_kind<>'job' or c.before_data->>'status' is not distinct from c.after_data->>'status'
  or c.before_data->'payments' is distinct from c.after_data->'payments'
  or c.job_id!~'^[A-Za-z0-9_.:-]{1,128}$' then raise exception 'review_conflict';end if;
 select o.body::jsonb->>'type' into last_kind from outbox o where o.job_id=c.job_id
  and o.body::jsonb->>'type' in ('job.financials_finalized','job.reopened','job.voided') order by order_revision desc limit 1;
 if last_kind='job.voided' then raise exception 'unsupported_source_review';end if;
 if p_action='finalize' and c.after_data->>'status'='complete' then kind:='job.financials_finalized';
 elsif p_action='void' and c.after_data->>'status'='canceled' then kind:='job.voided';
 elsif p_action='reopen' and c.before_data->>'status'='complete'
  and c.after_data->>'status' not in ('complete','canceled') and last_kind='job.financials_finalized' then kind:='job.reopened';
 else raise exception 'unsupported_source_review';end if;
 if exists(select 1 from outbox o where o.job_id=c.job_id and o.body::jsonb->>'type' not in
  ('job.payment_recorded','job.customer_refund_issued','job.part_cost_recorded','job.processor_fee_recorded','job.cost_corrected','job.financials_finalized','job.reopened'))
  then raise exception 'unsupported_source_review';end if;
 select coalesce(sum((o.body::jsonb->>'amount_cents')::numeric) filter(where o.body::jsonb->>'type'='job.payment_recorded'),0),
  coalesce(sum(case when o.body::jsonb->>'type'='job.part_cost_recorded' then (o.body::jsonb->>'amount_cents')::numeric
   when o.body::jsonb->>'type'='job.cost_corrected' then (o.body::jsonb->>'amount_cents')::numeric-(r.body::jsonb->>'amount_cents')::numeric else 0 end),0),
  coalesce(sum((o.body::jsonb->>'amount_cents')::numeric) filter(where o.body::jsonb->>'type'='job.processor_fee_recorded'),0),
  coalesce(sum((o.body::jsonb->>'amount_cents')::numeric) filter(where o.body::jsonb->>'type'='job.customer_refund_issued'),0)
 into payments,parts,fees,refunds from outbox o left join outbox r on r.id=(o.body::jsonb->>'reference_event_id')::uuid where o.job_id=c.job_id;
 if least(payments,parts,fees,refunds)<0 or greatest(payments,parts,fees,refunds)>9007199254740991
  or (p_action='void' and (payments<>0 or parts<>0 or fees<>0)) then raise exception 'unsupported_source_review';end if;
 totals:=jsonb_build_object('payments_cents',payments,'refunds_cents',refunds,'parts_net_cents',parts,'fees_net_cents',fees);
 event_id:=gen_random_uuid();
 body:=(jsonb_build_object('schema_version',1,'source_event_id',event_id,'source_order_id',c.job_id,
  'source_fact_id','lifecycle:'||c.id,'order_revision',s.emitted_revision+1,'type',kind,'currency','USD',
  'occurred_at',to_char(c.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'paid_at',null)
  ||case when p_action='finalize' then jsonb_build_object('totals',totals) else '{}'::jsonb end)::text;
 insert into outbox(id,job_id,order_revision,change_id,body,body_hash)
  values(event_id,c.job_id,s.emitted_revision+1,c.id,body,encode(sha256(convert_to(body,'UTF8')),'hex'));
 insert into lifecycle_reviews(id,change_id,actor,action,evidence,event_id) values(p_command,p_change,p_actor,p_action,trim(p_evidence),event_id);
 update changes set processed_at=clock_timestamp() where id=c.id;
 update order_streams set processed_capture_revision=c.capture_revision,emitted_revision=s.emitted_revision+1,review_reason=null where job_id=c.job_id;
 return p_command;
exception when unique_violation then raise exception 'review_conflict';
end $$;
revoke all on nestwise_integration.customer_refunds from public;
revoke all on function nestwise_integration.confirm_customer_refund(uuid,uuid,text,date,text),
 nestwise_integration.process_changes_before_refunds(integer),nestwise_integration.process_changes(integer) from public;
commit;
