-- Apply separately after review. Legacy rows have no verified callback consent.
begin;
alter table receptionist_callbacks add column if not exists support_category text
  check (support_category in ('estimate_copy','missed_visit','customer_callback','business_solicitation'));
alter table receptionist_callbacks add column if not exists consent_source text
  check (consent_source = 'confirmed_callback_tool');
alter table receptionist_callbacks add column if not exists consent_call_id text;
alter table receptionist_callbacks add column if not exists open_issue_key text;
alter table receptionist_callbacks add column if not exists merged_into_call_id text;
create table if not exists receptionist_callback_context (
  source_call_id text primary key references receptionist_calls(id) on delete cascade,
  issue_call_id text not null references receptionist_callbacks(call_id) on delete cascade,
  customer text not null,
  phone text not null,
  reason text not null,
  support_category text not null,
  review_snapshot jsonb,
  created_at timestamptz not null default now()
);
alter table receptionist_callback_context enable row level security;
create unique index if not exists receptionist_callback_open_issue
  on receptionist_callbacks(open_issue_key) where status='pending' and open_issue_key is not null;
create or replace function receptionist_record_callback(cid text, cname text, cphone text, creason text, category text, issue_key text)
returns setof receptionist_callbacks language plpgsql as $$
declare existing receptionist_callbacks;
declare context receptionist_callback_context;
declare target_id text;
declare review jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended(cid,1));
  perform pg_advisory_xact_lock(hashtextextended(issue_key,0));
  select * into context from receptionist_callback_context where source_call_id=cid;
  if found then
    if context.customer <> cname or context.phone <> cphone or context.reason <> creason
      or context.support_category <> category then
      raise exception 'Callback details conflict' using errcode='23505';
    end if;
    return query select * from receptionist_callbacks where call_id=context.issue_call_id;
    return;
  end if;
  select * into existing from receptionist_callbacks where call_id=cid;
  if found and existing.kind <> 'abandoned' then
    if existing.customer <> cname or existing.phone <> cphone or existing.reason <> creason
      or existing.support_category is distinct from category then
      raise exception 'Callback details conflict' using errcode='23505';
    end if;
    return next existing; return;
  end if;
  if found then review := to_jsonb(existing); end if;
  -- Retain the original review row and its pre-upgrade snapshot, never delete it.
  select * into existing from receptionist_callbacks where open_issue_key=issue_key and status='pending';
  if found then
    target_id := existing.call_id;
    update receptionist_callbacks set status='resolved',merged_into_call_id=target_id
      where call_id=cid and kind='abandoned';
    update receptionist_callbacks set reason=creason where call_id=target_id;
  else
    insert into receptionist_callbacks(call_id,customer,phone,reason,support_category,consent_source,consent_call_id,open_issue_key)
    values(cid,cname,cphone,creason,category,'confirmed_callback_tool',cid,issue_key)
    on conflict (call_id) do update set customer=excluded.customer,phone=excluded.phone,reason=excluded.reason,
      kind='requested',support_category=excluded.support_category,consent_source=excluded.consent_source,
      consent_call_id=excluded.consent_call_id,open_issue_key=excluded.open_issue_key,push_status='pending'
    where receptionist_callbacks.kind='abandoned'
    returning call_id into target_id;
  end if;
  if target_id is null then return; end if;
  insert into receptionist_callback_context(source_call_id,issue_call_id,customer,phone,reason,support_category,review_snapshot)
    values(cid,target_id,cname,cphone,creason,category,review);
  return query select * from receptionist_callbacks where call_id=target_id;
end;
$$;
commit;
