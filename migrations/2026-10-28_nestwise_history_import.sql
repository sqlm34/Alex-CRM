begin;
-- Administrative, explicitly approved cash history. No customer data or source
-- records are changed. Delivery uses the same durable outbox as live events.
create table nestwise_integration.history_imports(
 id uuid primary key, starts_on date not null, ends_before date not null,
 actor text not null, evidence text not null, snapshot_hash text not null,
 inserted_count integer not null, skipped_count integer not null,
 created_at timestamptz not null default clock_timestamp()
);
create trigger immutable_history_imports before update or delete on nestwise_integration.history_imports
 for each row execute function nestwise_integration.immutable();

create function nestwise_integration.cash_history_rows(p_start date,p_end date) returns jsonb
language sql stable security definer set search_path=nestwise_integration,pg_temp as $$
 select coalesce(jsonb_agg(row_data order by row_data->>'job_id',row_data->>'fact'),'[]'::jsonb) from (
 select jsonb_build_object('job_id',o.job_id,'fact','offline:'||o.id::text,
  'kind','job.payment_recorded','paid_on',o.payment_date,'amount',o.amount_cents,
  'source',offline_snapshot(o),'valid',
  o.amount_cents>0 and exists(select 1 from public.jobs j,
   lateral jsonb_array_elements(j.payments) p where j.id=o.job_id
   and p->>'source'='offline' and p->>'id'=o.id::text and p->>'status'='succeeded'
   and case when p->>'amount' ~ '^[0-9]+(\.[0-9]{1,2})?$'
     then (p->>'amount')::numeric*100 end=o.amount_cents)) row_data
 from public.offline_payments o where o.status='succeeded' and o.payment_date>=p_start and o.payment_date<p_end
 union all
 select jsonb_build_object('job_id',r.job_id,'fact','receipt:'||r.id,
  'kind','job.part_cost_recorded','paid_on',r.data->>'date',
  'amount',coalesce(r.data->>'expenseCents',r.data->>'totalCents'),
  'source',source_projection('parts_receipt',to_jsonb(r)),
  'valid',r.data->>'currency'='USD' and coalesce(r.data->>'expenseCents',r.data->>'totalCents','') ~ '^[1-9][0-9]{0,14}$')
 from public.parts_receipts r where r.status='confirmed' and r.deleted_at is null
 and nullif(to_jsonb(r)->>'inventory_usage_id','') is null
 and r.data->>'date'>=p_start::text and r.data->>'date'<p_end::text
 ) rows;
$$;

create function nestwise_integration.import_cash_history(p_id uuid,p_start date,p_end date,p_hash text,p_actor text,p_evidence text)
returns jsonb language plpgsql security definer set search_path=nestwise_integration,pg_temp as $$
declare rows jsonb; r jsonb; prior history_imports; s order_streams; existing outbox;
 event_id uuid; change_id uuid; body text; inserted integer:=0; skipped integer:=0; actual_hash text;
begin
 if p_id is null or p_start is null or p_end is null or p_end<=p_start or p_end-p_start>31
  or p_start<'1900-01-01'::date or p_end>'2200-01-01'::date
  or p_hash is null or p_hash!~'^[a-f0-9]{64}$'
  or p_actor is null or length(trim(p_actor)) not between 1 and 128
  or p_evidence is null or length(trim(p_evidence)) not between 10 and 1000
  then raise exception 'invalid_history_import';end if;
 -- Serialize import commands and block source changes for this short transaction.
 perform pg_advisory_xact_lock(hashtextextended('nestwise_cash_history_import',0));
 select * into prior from history_imports where id=p_id;
 if found then
  if (prior.starts_on,prior.ends_before,prior.snapshot_hash,prior.actor,prior.evidence)
   is distinct from (p_start,p_end,p_hash,p_actor,trim(p_evidence)) then raise exception 'history_command_conflict';end if;
  return jsonb_build_object('inserted',prior.inserted_count,'skipped',prior.skipped_count,'replayed',true);
 end if;
 lock table public.jobs,public.offline_payments,public.parts_receipts in share row exclusive mode;
 if not (select capture_enabled from configuration where singleton) then raise exception 'capture_disabled';end if;
 rows:=cash_history_rows(p_start,p_end);
 actual_hash:=encode(sha256(convert_to(rows::text,'UTF8')),'hex');
 if actual_hash<>p_hash then raise exception 'history_snapshot_changed';end if;
 for r in select value from jsonb_array_elements(rows) loop
  if r->>'valid' is distinct from 'true' or r->>'job_id'!~'^[A-Za-z0-9_.:-]{1,128}$'
   or r->>'fact'!~'^[A-Za-z0-9_.:-]{1,128}$' or (r->>'amount')::numeric>9007199254740991
   or (r->>'paid_on')::date<p_start or (r->>'paid_on')::date>=p_end then raise exception 'invalid_historical_source';end if;
  insert into order_streams(job_id) values(r->>'job_id') on conflict do nothing;
  select * into s from order_streams where job_id=r->>'job_id' for update;
  perform pg_advisory_xact_lock(hashtextextended(r->>'fact',0));
  if (select count(*) from outbox o where o.body::jsonb->>'source_fact_id'=r->>'fact')>1
   then raise exception 'historical_fact_conflict';end if;
  select o.* into existing from outbox o where o.body::jsonb->>'source_fact_id'=r->>'fact';
  if found then
   if existing.job_id<>r->>'job_id' or existing.body::jsonb->>'type'<>r->>'kind'
    or (existing.body::jsonb->>'amount_cents')::bigint<>(r->>'amount')::bigint
    or existing.body::jsonb->>'paid_at'<>(r->>'paid_on')||'T00:00:00.000Z'
    then raise exception 'historical_fact_conflict';end if;
   skipped:=skipped+1;continue;
  end if;
  -- Never consume or discard an unreviewed live capture to force a backfill.
  if s.captured_revision<>s.processed_capture_revision or s.review_reason is not null
   then raise exception 'historical_order_has_pending_review';end if;
  event_id:=gen_random_uuid();change_id:=gen_random_uuid();
  body:=(jsonb_build_object('schema_version',1,'source_event_id',event_id,
   'source_order_id',r->>'job_id','source_fact_id',r->>'fact','order_revision',s.emitted_revision+1,
   'type',r->>'kind','currency','USD','amount_cents',(r->>'amount')::bigint,
   'paid_at',(r->>'paid_on')||'T00:00:00.000Z',
   'occurred_at',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
   ||case when r->>'kind'='job.part_cost_recorded' then '{"settlement":"paid"}'::jsonb else '{}'::jsonb end)::text;
  insert into changes(id,job_id,capture_revision,source_kind,source_id,before_data,after_data,processed_at)
   values(change_id,r->>'job_id',s.captured_revision+1,'historical_cash',r->>'fact','{}',r,clock_timestamp());
  insert into outbox(id,job_id,order_revision,change_id,body,body_hash)
   values(event_id,r->>'job_id',s.emitted_revision+1,change_id,body,encode(sha256(convert_to(body,'UTF8')),'hex'));
  update order_streams set captured_revision=s.captured_revision+1,processed_capture_revision=s.processed_capture_revision+1,
   emitted_revision=s.emitted_revision+1 where job_id=s.job_id;
  inserted:=inserted+1;
 end loop;
 insert into history_imports(id,starts_on,ends_before,actor,evidence,snapshot_hash,inserted_count,skipped_count)
 values(p_id,p_start,p_end,p_actor,trim(p_evidence),p_hash,inserted,skipped);
 return jsonb_build_object('inserted',inserted,'skipped',skipped,'replayed',false);
end $$;
revoke all on nestwise_integration.history_imports from public;
revoke all on function nestwise_integration.cash_history_rows(date,date),
 nestwise_integration.import_cash_history(uuid,date,date,text,text,text) from public;
commit;
