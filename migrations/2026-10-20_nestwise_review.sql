begin;
-- Human attestation supplements captured evidence; it never rewrites it.
create table nestwise_integration.source_reviews(
 id uuid primary key,change_id uuid not null unique references nestwise_integration.changes,
 actor text not null,paid_on date not null check(paid_on between '1900-01-01' and '2199-12-31'),
 evidence text not null check(length(evidence) between 10 and 1000),
 created_at timestamptz not null default clock_timestamp()
);
create trigger immutable_source_reviews before update or delete on nestwise_integration.source_reviews
 for each row execute function nestwise_integration.immutable();

create function nestwise_integration.review_source(p_job text) returns jsonb
language sql security definer set search_path=nestwise_integration,pg_temp as $$
 select jsonb_build_object('job_id',s.job_id,'reason',s.review_reason,'change',
  (select jsonb_build_object('id',c.id,'kind',c.source_kind,'source_id',c.source_id,
    'before',c.before_data,'after',c.after_data,'captured_at',c.created_at)
   from changes c where c.job_id=s.job_id and c.capture_revision=s.processed_capture_revision+1),
  'reviews',coalesce((select jsonb_agg(to_jsonb(q)) from (
    select r.id,r.change_id,r.actor,r.paid_on,r.evidence,r.created_at
    from source_reviews r join changes c on c.id=r.change_id where c.job_id=s.job_id
    order by r.created_at desc,r.id desc limit 50) q),'[]'::jsonb))
 from order_streams s where s.job_id=p_job;
$$;

create function nestwise_integration.confirm_source(p_command uuid,p_change uuid,p_actor text,p_paid date,p_evidence text)
returns uuid language plpgsql security definer set search_path=nestwise_integration,pg_temp as $$
declare c changes;s order_streams;prior source_reviews;amount bigint;fee bigint;event_id uuid;body text;event_kind text;fact text;revision integer;
begin
 if p_command is null or p_change is null or p_actor is null or length(p_actor) not between 1 and 128
  or p_paid is null or p_paid not between '1900-01-01' and '2199-12-31'
  or p_evidence is null or length(trim(p_evidence)) not between 10 and 1000 then raise exception 'invalid_source_review';end if;
 select * into c from changes where id=p_change;
 if not found then raise exception 'review_conflict';end if;
 select * into s from order_streams where job_id=c.job_id for update;
 select * into prior from source_reviews where id=p_command;
 if found then
  if (prior.change_id,prior.actor,prior.paid_on,prior.evidence) is distinct from (p_change,p_actor,p_paid,trim(p_evidence)) then raise exception 'review_conflict';end if;
  return prior.id;
 end if;
 if not (select capture_enabled from configuration where singleton) or c.processed_at is not null
  or c.capture_revision<>s.processed_capture_revision+1 or s.review_reason is distinct from 'source_requires_review'
  or c.job_id!~'^[A-Za-z0-9_.:-]{1,128}$' then raise exception 'review_conflict';end if;
 -- Historical changes, corrections, refunds, deleted receipts and unsupported
 -- currency cannot be released through this initial paid-source workflow.
 if c.source_kind='stripe_attempt' then
  if coalesce(c.before_data->>'status','') in ('recorded','succeeded','reconciliation_required')
   or c.after_data->>'status' is distinct from 'recorded' or c.after_data->>'stripe_status' is distinct from 'succeeded'
   or lower(coalesce(c.after_data->>'currency',''))<>'usd'
   or coalesce(c.after_data->>'intent_id','')!~'^pi_[A-Za-z0-9]{1,100}$'
   or coalesce(c.after_data->>'charge_cents','')!~'^[1-9][0-9]{0,15}$'
   or coalesce(c.after_data->>'fee_cents','')!~'^(0|[1-9][0-9]{0,15})$'
   or coalesce(c.after_data->>'net_cents','')!~'^(0|[1-9][0-9]{0,15})$' then raise exception 'unsupported_source_review';end if;
  amount:=(c.after_data->>'charge_cents')::bigint;fee:=(c.after_data->>'fee_cents')::bigint;
  if amount>9007199254740991 or fee>amount or amount-fee<>(c.after_data->>'net_cents')::bigint then raise exception 'unsupported_source_review';end if;
  fact:='stripe:'||(c.after_data->>'intent_id');event_kind:='job.payment_recorded';
 elsif c.source_kind='parts_receipt' then
  if coalesce(c.before_data->>'status','')='confirmed' or c.after_data->>'status' is distinct from 'confirmed'
   or c.after_data->>'deleted_at' is not null or c.after_data->>'currency' is distinct from 'USD'
   or coalesce(c.after_data->>'hash','')!~'^[a-f0-9]{64}$'
   or c.source_id!~'^[A-Za-z0-9_.:-]{1,100}$'
   or coalesce(c.after_data->>'expense_cents','')!~'^[1-9][0-9]{0,15}$' then raise exception 'unsupported_source_review';end if;
  amount:=(c.after_data->>'expense_cents')::bigint;
  if amount>9007199254740991 then raise exception 'unsupported_source_review';end if;
  fee:=0;fact:='receipt:'||c.source_id;event_kind:='job.part_cost_recorded';
 else raise exception 'unsupported_source_review';end if;
 perform pg_advisory_xact_lock(hashtextextended(fact,0));
 if exists(select 1 from outbox o where o.body::jsonb->>'source_fact_id'=fact) then raise exception 'review_conflict';end if;
 revision:=s.emitted_revision+1;event_id:=gen_random_uuid();
 body:=(jsonb_build_object('schema_version',1,'source_event_id',event_id,'source_order_id',c.job_id,
  'source_fact_id',fact,'order_revision',revision,'type',event_kind,'currency','USD',
  'occurred_at',to_char(c.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'paid_at',to_char(p_paid,'YYYY-MM-DD')||'T00:00:00.000Z','amount_cents',amount)
  ||case when event_kind='job.part_cost_recorded' then '{"settlement":"paid"}'::jsonb else '{}'::jsonb end)::text;
 insert into outbox(id,job_id,order_revision,change_id,body,body_hash)
  values(event_id,c.job_id,revision,c.id,body,encode(sha256(convert_to(body,'UTF8')),'hex'));
 if fee>0 then
  revision:=revision+1;event_id:=gen_random_uuid();
  body:=jsonb_build_object('schema_version',1,'source_event_id',event_id,'source_order_id',c.job_id,
   'source_fact_id',fact||':fee','order_revision',revision,'type','job.processor_fee_recorded','currency','USD',
   'occurred_at',to_char(c.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   'paid_at',to_char(p_paid,'YYYY-MM-DD')||'T00:00:00.000Z','amount_cents',fee)::text;
  insert into outbox(id,job_id,order_revision,change_id,body,body_hash)
   values(event_id,c.job_id,revision,c.id,body,encode(sha256(convert_to(body,'UTF8')),'hex'));
 end if;
 insert into source_reviews(id,change_id,actor,paid_on,evidence) values(p_command,p_change,p_actor,p_paid,trim(p_evidence));
 update changes set processed_at=clock_timestamp() where id=c.id;
 update order_streams set processed_capture_revision=c.capture_revision,emitted_revision=revision,review_reason=null where job_id=c.job_id;
 return p_command;
exception when unique_violation then raise exception 'review_conflict';
end $$;
revoke all on nestwise_integration.source_reviews from public;
revoke all on function nestwise_integration.review_source(text),nestwise_integration.confirm_source(uuid,uuid,text,date,text) from public;
create or replace function nestwise_integration.process_changes(p_limit integer default 20) returns integer
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
     if not exists(
       select 1 from outbox o where o.job_id=item.job_id and ((payment->>'source'='offline' and o.body::jsonb->>'source_fact_id'='offline:'||(payment->>'id')) or (payment->>'source'='stripe_terminal' and o.body::jsonb->>'source_fact_id'='stripe:'||(payment->>'payment_intent_id'))) and o.body::jsonb->>'type'='job.payment_recorded'
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
commit;
