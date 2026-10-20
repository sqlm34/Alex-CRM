begin;
create schema if not exists nestwise_integration;
revoke all on schema nestwise_integration from public;
create table nestwise_integration.configuration(
  singleton boolean primary key default true check(singleton),capture_enabled boolean not null default false
);
insert into nestwise_integration.configuration values(true,false);
create table nestwise_integration.order_streams(
  job_id text primary key references public.jobs(id),captured_revision integer not null default 0,
  emitted_revision integer not null default 0,review_reason text,
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
create function nestwise_integration.immutable() returns trigger language plpgsql as $$
begin raise exception 'immutable_nestwise_history';end $$;
create trigger immutable_attempts before update or delete on nestwise_integration.delivery_attempts for each row execute function nestwise_integration.immutable();
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
revoke all on all tables in schema nestwise_integration from public;
revoke all on all functions in schema nestwise_integration from public;
commit;
