begin;
create table nestwise_integration.cost_corrections(
 id uuid primary key, change_id uuid not null unique references nestwise_integration.changes,
 actor text not null, paid_on date not null, evidence text not null check(length(evidence) between 10 and 1000),
 reference_event_id uuid not null references nestwise_integration.outbox,
 event_id uuid not null unique references nestwise_integration.outbox,
 created_at timestamptz not null default clock_timestamp()
);
create trigger immutable_cost_corrections before update or delete on nestwise_integration.cost_corrections
 for each row execute function nestwise_integration.immutable();

create function nestwise_integration.confirm_cost_correction(p_command uuid,p_change uuid,p_actor text,p_paid date,p_evidence text)
returns uuid language plpgsql security definer set search_path=nestwise_integration,pg_temp as $$
declare c changes;s order_streams;prior cost_corrections;ref outbox;original outbox;
 amount bigint;event_id uuid;body text;revision integer;
begin
 if p_command is null or p_change is null or p_actor is null or length(p_actor) not between 1 and 128
  or p_paid is null or p_paid not between '1900-01-01' and '2199-12-31'
  or p_evidence is null or length(trim(p_evidence)) not between 10 and 1000 then raise exception 'invalid_source_review';end if;
 select * into c from changes where id=p_change;
 if not found then raise exception 'review_conflict';end if;
 select * into s from order_streams where job_id=c.job_id for update;
 select * into prior from cost_corrections where id=p_command;
 if found then
  if (prior.change_id,prior.actor,prior.paid_on,prior.evidence) is distinct from (p_change,p_actor,p_paid,trim(p_evidence)) then raise exception 'review_conflict';end if;
  return prior.id;
 end if;
 if not (select capture_enabled from configuration where singleton) or c.processed_at is not null
  or c.capture_revision<>s.processed_capture_revision+1 or s.review_reason is distinct from 'source_requires_review'
  or c.source_kind<>'parts_receipt' then raise exception 'review_conflict';end if;
 if c.before_data->>'status' is distinct from 'confirmed' or c.after_data->>'status' is distinct from 'confirmed'
  or c.before_data->>'deleted_at' is not null or c.after_data->>'deleted_at' is not null
  or c.before_data->>'currency' is distinct from 'USD' or c.after_data->>'currency' is distinct from 'USD'
  or coalesce(c.after_data->>'hash','')!~'^[a-f0-9]{64}$'
  or c.before_data->>'hash' is distinct from c.after_data->>'hash'
  or coalesce(c.before_data->>'expense_cents','')!~'^(0|[1-9][0-9]{0,15})$'
  or coalesce(c.after_data->>'expense_cents','')!~'^(0|[1-9][0-9]{0,15})$'
  then raise exception 'unsupported_source_review';end if;
 amount:=(c.after_data->>'expense_cents')::bigint;
 if amount>9007199254740991 then raise exception 'unsupported_source_review';end if;
 perform pg_advisory_xact_lock(hashtextextended('receipt:'||c.source_id,0));
 select o.* into original from outbox o join changes oc on oc.id=o.change_id
  where o.job_id=c.job_id and oc.source_kind='parts_receipt' and oc.source_id=c.source_id
  and o.body::jsonb->>'type'='job.part_cost_recorded' order by o.order_revision limit 1;
 if not found or original.body::jsonb->>'settlement' is distinct from 'paid'
  or (original.body::jsonb->>'paid_at')::timestamptz is distinct from (p_paid::timestamp at time zone 'UTC')
  then raise exception 'unsupported_source_review';end if;
 select o.* into ref from outbox o join changes oc on oc.id=o.change_id
  where o.job_id=c.job_id and oc.source_kind='parts_receipt' and oc.source_id=c.source_id
  and o.body::jsonb->>'type' in ('job.part_cost_recorded','job.cost_corrected') order by o.order_revision desc limit 1;
 if (ref.body::jsonb->>'amount_cents')::bigint is distinct from (c.before_data->>'expense_cents')::bigint
  or amount=(ref.body::jsonb->>'amount_cents')::bigint
  or exists(select 1 from outbox o where o.body::jsonb->>'reference_event_id'=ref.id::text)
  then raise exception 'unsupported_source_review';end if;
 revision:=s.emitted_revision+1;event_id:=gen_random_uuid();
 body:=jsonb_build_object('schema_version',1,'source_event_id',event_id,'source_order_id',c.job_id,
  'source_fact_id','cost-correction:'||c.id,'order_revision',revision,'type','job.cost_corrected','currency','USD',
  'occurred_at',to_char(c.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'paid_at',original.body::jsonb->>'paid_at','amount_cents',amount,'reference_event_id',ref.id)::text;
 insert into outbox(id,job_id,order_revision,change_id,body,body_hash)
  values(event_id,c.job_id,revision,c.id,body,encode(sha256(convert_to(body,'UTF8')),'hex'));
 insert into cost_corrections(id,change_id,actor,paid_on,evidence,reference_event_id,event_id)
  values(p_command,p_change,p_actor,p_paid,trim(p_evidence),ref.id,event_id);
 update changes set processed_at=clock_timestamp() where id=c.id;
 update order_streams set processed_capture_revision=c.capture_revision,emitted_revision=revision,review_reason=null where job_id=c.job_id;
 return p_command;
exception when unique_violation then raise exception 'review_conflict';
end $$;
revoke all on nestwise_integration.cost_corrections from public;
revoke all on function nestwise_integration.confirm_cost_correction(uuid,uuid,text,date,text) from public;
alter function nestwise_integration.review_source(text) rename to review_source_initial;
create function nestwise_integration.review_source(p_job text) returns jsonb
language sql security definer set search_path=nestwise_integration,pg_temp as $$
 select review_source_initial(p_job)||jsonb_build_object('corrections',coalesce((select jsonb_agg(to_jsonb(q)) from (
  select r.id,r.change_id,r.actor,r.paid_on,r.evidence,r.reference_event_id,r.event_id,r.created_at
  from cost_corrections r join changes c on c.id=r.change_id where c.job_id=p_job
  order by r.created_at desc,r.id desc limit 50) q),'[]'::jsonb));
$$;
revoke all on function nestwise_integration.review_source(text) from public;
commit;
