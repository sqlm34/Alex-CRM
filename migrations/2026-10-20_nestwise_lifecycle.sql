begin;
create table nestwise_integration.lifecycle_reviews(
 id uuid primary key,change_id uuid not null unique references nestwise_integration.changes,
 actor text not null,action text not null check(action in ('finalize','reopen','void')),
 evidence text not null check(length(evidence) between 10 and 1000),
 event_id uuid not null unique references nestwise_integration.outbox,
 created_at timestamptz not null default clock_timestamp()
);
create trigger immutable_lifecycle_reviews before update or delete on nestwise_integration.lifecycle_reviews
 for each row execute function nestwise_integration.immutable();
create function nestwise_integration.confirm_lifecycle(p_command uuid,p_change uuid,p_actor text,p_action text,p_evidence text)
returns uuid language plpgsql security definer set search_path=nestwise_integration,pg_temp as $$
declare c changes;s order_streams;prior lifecycle_reviews;kind text;last_kind text;
 totals jsonb;payments numeric;parts numeric;fees numeric;event_id uuid;body text;
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
  ('job.payment_recorded','job.part_cost_recorded','job.processor_fee_recorded','job.cost_corrected','job.financials_finalized','job.reopened'))
  then raise exception 'unsupported_source_review';end if;
 select coalesce(sum((o.body::jsonb->>'amount_cents')::numeric) filter(where o.body::jsonb->>'type'='job.payment_recorded'),0),
  coalesce(sum(case when o.body::jsonb->>'type'='job.part_cost_recorded' then (o.body::jsonb->>'amount_cents')::numeric
   when o.body::jsonb->>'type'='job.cost_corrected' then (o.body::jsonb->>'amount_cents')::numeric-(r.body::jsonb->>'amount_cents')::numeric else 0 end),0),
  coalesce(sum((o.body::jsonb->>'amount_cents')::numeric) filter(where o.body::jsonb->>'type'='job.processor_fee_recorded'),0)
 into payments,parts,fees from outbox o left join outbox r on r.id=(o.body::jsonb->>'reference_event_id')::uuid where o.job_id=c.job_id;
 if least(payments,parts,fees)<0 or greatest(payments,parts,fees)>9007199254740991
  or (p_action='void' and (payments<>0 or parts<>0 or fees<>0)) then raise exception 'unsupported_source_review';end if;
 totals:=jsonb_build_object('payments_cents',payments,'refunds_cents',0,'parts_net_cents',parts,'fees_net_cents',fees);
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
alter function nestwise_integration.review_source(text) rename to review_source_with_costs;
create function nestwise_integration.review_source(p_job text) returns jsonb
language sql security definer set search_path=nestwise_integration,pg_temp as $$
 select review_source_with_costs(p_job)||jsonb_build_object('lifecycle_reviews',coalesce((select jsonb_agg(to_jsonb(q)) from (
  select r.id,r.actor,r.action,r.evidence,r.created_at from lifecycle_reviews r join changes c on c.id=r.change_id
  where c.job_id=p_job order by r.created_at desc,r.id desc limit 50) q),'[]'::jsonb));
$$;
revoke all on nestwise_integration.lifecycle_reviews from public;
revoke all on function nestwise_integration.confirm_lifecycle(uuid,uuid,text,text,text),nestwise_integration.review_source(text) from public;
commit;
