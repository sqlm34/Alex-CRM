begin;
create schema if not exists nestwise_integration;
revoke all on schema nestwise_integration from public;
create table nestwise_integration.configuration(
  singleton boolean primary key default true check(singleton),capture_enabled boolean not null default false
);
insert into nestwise_integration.configuration values(true,false);
create table nestwise_integration.order_streams(
  job_id text primary key references public.jobs(id),captured_revision integer not null default 0,
  emitted_revision integer not null default 0,processed_capture_revision integer not null default 0,review_reason text,
  baseline_approved boolean not null default false
);
create table nestwise_integration.changes(
  id uuid primary key default gen_random_uuid(),job_id text not null references nestwise_integration.order_streams,
  capture_revision integer not null,source_kind text not null,source_id text not null,
  before_data jsonb not null,after_data jsonb not null,
  created_at timestamptz not null default clock_timestamp(),processed_at timestamptz,
  unique(job_id,capture_revision)
);
create table nestwise_integration.outbox(
  id uuid primary key,job_id text not null references nestwise_integration.order_streams,
  order_revision integer not null,change_id uuid not null references nestwise_integration.changes,
  body text not null,body_hash text not null,
  status text not null default 'pending' check(status in('pending','leased','acked','dlq')),
  attempts integer not null default 0,next_attempt_at timestamptz not null default clock_timestamp(),
  lease_id uuid,lease_until timestamptz,acked_at timestamptz,receiver_status text,
  created_at timestamptz not null default clock_timestamp(),unique(job_id,order_revision),
  check(body_hash=encode(sha256(convert_to(body,'UTF8')),'hex'))
);
create table nestwise_integration.delivery_attempts(
  id bigint generated always as identity primary key,event_id uuid not null references nestwise_integration.outbox,
  attempt integer not null,lease_id uuid not null,http_status integer,outcome text not null,
  recorded_at timestamptz not null default clock_timestamp()
);
create table nestwise_integration.operator_actions(
 id uuid primary key,event_id uuid not null references nestwise_integration.outbox,
 actor text not null,action text not null check(action='retry'),recorded_at timestamptz not null default clock_timestamp()
);
create function nestwise_integration.immutable() returns trigger language plpgsql as $$
begin raise exception 'immutable_nestwise_history';end $$;
create trigger immutable_attempts before update or delete on nestwise_integration.delivery_attempts for each row execute function nestwise_integration.immutable();
create trigger immutable_operator_actions before update or delete on nestwise_integration.operator_actions for each row execute function nestwise_integration.immutable();
create function nestwise_integration.protect_change() returns trigger language plpgsql as $$
begin
 if tg_op='DELETE' then raise exception 'immutable_nestwise_history';end if;
 if (to_jsonb(new)-'processed_at') is distinct from (to_jsonb(old)-'processed_at') or old.processed_at is not null then raise exception 'immutable_nestwise_history';end if;
 return new;
end $$;
create trigger immutable_changes before update or delete on nestwise_integration.changes for each row execute function nestwise_integration.protect_change();
create function nestwise_integration.protect_event() returns trigger language plpgsql as $$
begin
 if tg_op='DELETE' then raise exception 'immutable_nestwise_history';end if;
 if (new.id,new.job_id,new.order_revision,new.change_id,new.body,new.body_hash,new.created_at) is distinct from
    (old.id,old.job_id,old.order_revision,old.change_id,old.body,old.body_hash,old.created_at) then raise exception 'immutable_nestwise_history';end if;
 return new;
end $$;
create trigger immutable_outbox before update or delete on nestwise_integration.outbox for each row execute function nestwise_integration.protect_event();

-- Only financial primitives are captured. Names, addresses, card details,
-- receipt images and free-form notes never enter the delivery outbox.
create function nestwise_integration.payment_snapshot(p_payments jsonb) returns jsonb language sql stable as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',p->>'id','amount',p->>'amount',
   'status',coalesce(p->>'status',''),'source',coalesce(p->>'source',''),
   'created_at',p->>'createdAt','payment_intent_id',p->>'paymentIntentId',
   'fee_cents',p->>'processingFeeCents','voided_at',p->>'voidedAt') order by p->>'id'),'[]'::jsonb)
 from jsonb_array_elements(case when jsonb_typeof(p_payments)='array' then p_payments else '[]'::jsonb end) p;
$$;
create function nestwise_integration.capture_job() returns trigger language plpgsql security definer set search_path=nestwise_integration,pg_temp as $$
declare previous jsonb; current_data jsonb; rev integer;
begin
 if not (select capture_enabled from configuration where singleton) then return new;end if;
 previous:=case when tg_op='INSERT' then jsonb_build_object('payments','[]'::jsonb,'status','new','paid',false)
   else jsonb_build_object('payments',payment_snapshot(old.payments),'status',old.status,'paid',old.paid) end;
 current_data:=jsonb_build_object('payments',payment_snapshot(new.payments),'status',new.status,'paid',new.paid);
 if previous=current_data then return new;end if;
 insert into order_streams(job_id,review_reason) values(new.id,
   case when jsonb_array_length(previous->'payments')>0 then 'historical_baseline_required' else null end) on conflict do nothing;
 update order_streams set captured_revision=captured_revision+1 where job_id=new.id returning captured_revision into rev;
 insert into changes(job_id,capture_revision,source_kind,source_id,before_data,after_data) values(new.id,rev,'job',new.id,previous,current_data);
 return new;
end $$;
create trigger nestwise_capture_job after insert or update of payments,status,paid on public.jobs for each row execute function nestwise_integration.capture_job();

-- Keep the source payment date, which differs from the jobs JSON recording time.
-- This source-table trigger also covers direct changes before materialization.
create function nestwise_integration.offline_snapshot(p_row public.offline_payments) returns jsonb language sql immutable as $$
 select jsonb_build_object('id',p_row.id,'amount_cents',p_row.amount_cents::text,
   'payment_date',p_row.payment_date,'status',p_row.status,'method',p_row.method,
   'created_at',p_row.created_at,'voided_at',p_row.voided_at);
$$;
create function nestwise_integration.capture_offline() returns trigger language plpgsql security definer set search_path=nestwise_integration,pg_temp as $$
declare previous jsonb; current_data jsonb; rev integer;
begin
 if not (select capture_enabled from configuration where singleton) then return new;end if;
 previous:=case when tg_op='INSERT' then '{}'::jsonb else offline_snapshot(old) end;
 current_data:=offline_snapshot(new);
 if previous=current_data then return new;end if;
 insert into order_streams(job_id,review_reason) values(new.job_id,
   case when tg_op<>'INSERT' then 'historical_baseline_required' else null end) on conflict do nothing;
 update order_streams set captured_revision=captured_revision+1 where job_id=new.job_id returning captured_revision into rev;
 insert into changes(job_id,capture_revision,source_kind,source_id,before_data,after_data)
   values(new.job_id,rev,'offline_payment',new.id::text,previous,current_data);
 return new;
end $$;
create trigger nestwise_capture_offline after insert or update on public.offline_payments for each row execute function nestwise_integration.capture_offline();

-- Capture evidence from optional CRM modules without copying card/customer data.
-- completed_at is recording time, not proof of actual Stripe settlement time.
create function nestwise_integration.source_projection(p_kind text,p_row jsonb) returns jsonb
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
  'total_cents',p_row->'data'->>'totalCents') else '{}'::jsonb end;
$$;
create function nestwise_integration.capture_evidence() returns trigger
language plpgsql security definer set search_path=nestwise_integration,pg_temp as $$
declare previous jsonb; current_data jsonb; source_row jsonb; rev integer; kind text:=tg_argv[0];
begin
 if not (select capture_enabled from configuration where singleton) then return new;end if;
 source_row:=to_jsonb(new);
 previous:=case when tg_op='INSERT' then '{}'::jsonb else source_projection(kind,to_jsonb(old)) end;
 current_data:=source_projection(kind,source_row);
 if tg_op='UPDATE' and to_jsonb(old)->>'job_id' is distinct from source_row->>'job_id' then
  raise exception 'nestwise_financial_source_job_immutable';
 end if;
 if previous=current_data then return new;end if;
 if kind='stripe_attempt' and coalesce(previous->>'status','') not in('recorded','succeeded','reconciliation_required')
   and coalesce(current_data->>'status','') not in('recorded','succeeded','reconciliation_required') then return new;end if;
 if kind='parts_receipt' and coalesce(previous->>'status','')<>'confirmed'
   and coalesce(current_data->>'status','')<>'confirmed' then return new;end if;
 insert into order_streams(job_id,review_reason) values(source_row->>'job_id',
  case when previous->>'status' in('confirmed','recorded','succeeded','reconciliation_required') then 'historical_baseline_required' else null end) on conflict do nothing;
 update order_streams set captured_revision=captured_revision+1 where job_id=source_row->>'job_id' returning captured_revision into rev;
 insert into changes(job_id,capture_revision,source_kind,source_id,before_data,after_data)
  values(source_row->>'job_id',rev,kind,source_row->>'id',previous,current_data);
 return new;
end $$;
do $$ begin
 if to_regclass('public.stripe_payment_attempts') is not null then
  execute 'create trigger nestwise_capture_stripe after insert or update on public.stripe_payment_attempts for each row execute function nestwise_integration.capture_evidence(''stripe_attempt'')';
 end if;
 if to_regclass('public.parts_receipts') is not null then
  execute 'create trigger nestwise_capture_parts after insert or update on public.parts_receipts for each row execute function nestwise_integration.capture_evidence(''parts_receipt'')';
 end if;
end $$;

-- Conversion and the durable event identity commit together. A replay never
-- allocates a replacement identity. Unknown financial semantics stop the stream.
create function nestwise_integration.process_changes(p_limit integer default 20) returns integer
language plpgsql security definer set search_path=nestwise_integration,pg_temp as $$
declare item record; event_id uuid; event_body text; revision integer; reason text; converted integer:=0; payment jsonb;
begin
 if p_limit is null or p_limit not between 1 and 100 then raise exception 'invalid_limit';end if;
 if not (select capture_enabled from configuration where singleton) then return 0;end if;
 for item in select c.*,s.emitted_revision from changes c join order_streams s on s.job_id=c.job_id
   where s.review_reason is null and c.capture_revision=s.processed_capture_revision+1
   order by c.created_at,c.id for update of s skip locked limit p_limit
 loop
  reason:=null;event_body:=null;
  if item.job_id!~'^[A-Za-z0-9_.:-]{1,128}$' then reason:='unsupported_order_identity';
  elsif item.source_kind='offline_payment' then
   if item.before_data<>'{}'::jsonb then reason:='offline_correction_requires_review';
   elsif item.after_data->>'status' is distinct from 'succeeded' then reason:='offline_status_requires_review';
   elsif item.after_data->>'id' is distinct from item.source_id
      or coalesce(item.after_data->>'amount_cents','')!~'^[1-9][0-9]{0,15}$'
      or coalesce(item.after_data->>'payment_date','')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      then reason:='invalid_offline_fact';
   else
    begin
     if (item.after_data->>'amount_cents')::numeric>9007199254740991
       or (item.after_data->>'payment_date')::date not between '1900-01-01'::date and '2199-12-31'::date
       then raise exception 'invalid_offline_fact';end if;
     event_id:=gen_random_uuid();revision:=item.emitted_revision+1;
     event_body:=jsonb_build_object('schema_version',1,'source_event_id',event_id,
       'source_order_id',item.job_id,'source_fact_id','offline:'||item.source_id,
       'order_revision',revision,'type','job.payment_recorded','currency','USD',
       'occurred_at',to_char(item.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
       'paid_at',(item.after_data->>'payment_date')||'T00:00:00.000Z',
       'amount_cents',(item.after_data->>'amount_cents')::bigint)::text;
    exception when others then reason:='invalid_offline_fact';event_body:=null;
    end;
   end if;
  elsif item.source_kind='job' then
   if item.before_data->>'status' in ('complete','canceled') or item.after_data->>'status' in ('complete','canceled') then
    reason:='order_lifecycle_requires_review';
   elsif exists(select 1 from jsonb_array_elements(item.before_data->'payments') old_payment
       where not exists(select 1 from jsonb_array_elements(item.after_data->'payments') new_payment where new_payment=old_payment)) then
    reason:='payment_correction_requires_review';
   else
    for payment in select value from jsonb_array_elements(item.after_data->'payments') loop
     if payment->>'source' is distinct from 'offline' or not exists(
       select 1 from outbox o where o.job_id=item.job_id and o.body::jsonb->>'source_fact_id'='offline:'||(payment->>'id')
         and payment->>'status'='succeeded' and (o.body::jsonb->>'amount_cents')::numeric=
           case when payment->>'amount' ~ '^[0-9]+(\.[0-9]{1,2})?$' then (payment->>'amount')::numeric*100 else null end)
       then reason:='payment_source_requires_review';exit;end if;
    end loop;
   end if;
  else reason:='source_requires_review';end if;
  if reason is not null then
   update order_streams set review_reason=reason where job_id=item.job_id;
  else
   if event_body is not null then
    insert into outbox(id,job_id,order_revision,change_id,body,body_hash)
      values(event_id,item.job_id,revision,item.id,event_body,encode(sha256(convert_to(event_body,'UTF8')),'hex'));
    update order_streams set emitted_revision=revision where job_id=item.job_id;
   end if;
   update changes set processed_at=clock_timestamp() where id=item.id;
   update order_streams set processed_capture_revision=item.capture_revision where job_id=item.job_id;
   converted:=converted+1;
  end if;
 end loop;
 return converted;
end $$;

create function nestwise_integration.claim_delivery(p_limit integer default 10) returns setof nestwise_integration.outbox
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
    (o.status='pending' and o.next_attempt_at<=clock_timestamp() or o.status='leased' and o.lease_until<clock_timestamp())
    and not exists(select 1 from outbox earlier where earlier.job_id=o.job_id and earlier.order_revision<o.order_revision and earlier.status<>'acked')
  order by o.created_at,o.id for update of o skip locked limit p_limit
 ) update outbox o set status='leased',attempts=o.attempts+1,lease_id=gen_random_uuid(),lease_until=clock_timestamp()+interval '2 minutes'
   from selected where o.id=selected.id returning o.*;
end $$;
create function nestwise_integration.finish_delivery(p_id uuid,p_lease uuid,p_http integer,p_outcome text,p_receiver text default null) returns boolean
language plpgsql security definer set search_path=nestwise_integration,pg_temp as $$
declare item outbox; permanent boolean;
begin
 select * into item from outbox where id=p_id and lease_id=p_lease and status='leased' for update;
 if not found then return false;end if;
 if p_outcome is null or p_outcome not in ('acked','retry','rejected') then raise exception 'invalid_outcome';end if;
 if p_outcome='acked' and (p_http is distinct from 202 or p_receiver is null or p_receiver not in('waiting','posted','asserted','needs_review')) then raise exception 'invalid_ack';end if;
 permanent:=p_outcome='rejected' or item.attempts>=12;
 insert into delivery_attempts(event_id,attempt,lease_id,http_status,outcome) values(p_id,item.attempts,p_lease,p_http,p_outcome);
 update outbox set status=case when p_outcome='acked' then 'acked' when permanent then 'dlq' else 'pending' end,
   acked_at=case when p_outcome='acked' then clock_timestamp() else null end,receiver_status=p_receiver,
   next_attempt_at=clock_timestamp()+make_interval(secs=>least(3600,30*power(2,least(item.attempts-1,7)))::integer+(random()*15)::integer),
   lease_id=null,lease_until=null where id=p_id;
 return true;
end $$;
create function nestwise_integration.retry_delivery(p_event uuid,p_command uuid,p_actor text) returns boolean
language plpgsql security definer set search_path=nestwise_integration,pg_temp as $$
declare prior operator_actions; item outbox;
begin
 if p_actor is null or length(p_actor) not between 1 and 128 or p_command is null then raise exception 'invalid_retry';end if;
 select * into item from outbox where id=p_event for update;
 if not found then raise exception 'unknown_event';end if;
 select * into prior from operator_actions where id=p_command;
 if found then
  if prior.event_id<>p_event or prior.actor<>p_actor then raise exception 'retry_conflict';end if;
  return true;
 end if;
 if item.status<>'dlq' then raise exception 'retry_conflict';end if;
 if exists(select 1 from order_streams where job_id=item.job_id and review_reason is not null) then raise exception 'review_required';end if;
 insert into operator_actions(id,event_id,actor,action) values(p_command,p_event,p_actor,'retry');
 update outbox set status='pending',attempts=0,next_attempt_at=clock_timestamp(),lease_id=null,lease_until=null where id=p_event;
 return true;
exception when unique_violation then raise exception 'retry_conflict';
end $$;
create function nestwise_integration.sync_status(p_before text default null) returns jsonb
language sql security definer set search_path=nestwise_integration,pg_temp as $$
 select jsonb_build_object('capture_enabled',(select capture_enabled from configuration where singleton),
  'pending',(select count(*) from outbox where status in('pending','leased')),
  'failed',(select count(*) from outbox where status='dlq'),
  'review',(select count(*) from order_streams where review_reason is not null),
  'orders',coalesce((select jsonb_agg(to_jsonb(q) order by q.job_id) from (
   select s.job_id,s.captured_revision,s.processed_capture_revision,s.emitted_revision,s.review_reason,
    coalesce((select jsonb_agg(jsonb_build_object('id',o.id,'revision',o.order_revision,'status',o.status,
      'attempts',o.attempts,'receiver_status',o.receiver_status,'acked_at',o.acked_at) order by o.order_revision desc)
      from (select * from outbox where job_id=s.job_id order by order_revision desc limit 10) o),'[]'::jsonb) events
   from order_streams s where p_before is null or s.job_id>p_before order by s.job_id limit 50
  ) q),'[]'::jsonb));
$$;
revoke all on all tables in schema nestwise_integration from public;
revoke all on all functions in schema nestwise_integration from public;
commit;
