import type { neon } from '@neondatabase/serverless'

// Installed atomically once. Triggers keep reports consistent with the write transaction.
export const statisticsSchemaStatements = [
  `set local lock_timeout='5s'`,
  `set local statement_timeout='30s'`,
  `select pg_advisory_xact_lock(810082026)`,
  `lock table jobs, parts_receipts in share row exclusive mode`,
  `create table if not exists crm_monthly_statistics (
    month date primary key, report jsonb not null, updated_at timestamptz not null default now()
  )`,
  `create table if not exists crm_statistics_schema (version integer primary key)`,
  `create or replace function crm_stat_number(value text, fallback numeric default 0) returns numeric
    language plpgsql immutable as $$ begin
      if value is null or value !~ '^-?[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$' then return fallback; end if;
      return value::numeric;
    exception when numeric_value_out_of_range or invalid_text_representation then return fallback; end $$`,
  `create or replace function crm_stat_cents(value numeric) returns numeric language sql immutable as $$
    select least(99999999, greatest(0, round(coalesce(value,0)))) $$`,
  `create or replace function crm_stat_diagnostic_only(items jsonb) returns boolean language sql immutable as $$
    select case when jsonb_typeof(items)='array' then jsonb_array_length(items)>0 and not exists(
      select 1 from jsonb_array_elements(items) item
      where lower(regexp_replace(trim(coalesce(item->>'label','')), '\\s+', ' ', 'g')) <> 'service call'
    ) else false end $$`,
  `create or replace function crm_stat_invoice(items jsonb, invoice numeric) returns bigint
    language plpgsql immutable as $$ declare item jsonb; unit numeric; subtotal numeric; discounted numeric;
    line numeric; total numeric := 0; base numeric; quantity numeric; tax numeric;
    begin
      for item in select value from jsonb_array_elements(case when jsonb_typeof(items)='array' then items else '[]'::jsonb end) loop
        base := crm_stat_number(item->>'baseUnitPriceCents');
        unit := case
          when item->>'baseUnitPriceCents' is not null and item->>'pricingVersion'='base-plus-5-percent-30c-v1' then floor((base*105+50)/100)+30
          when item->>'baseUnitPriceCents' is not null and item->>'pricingVersion' in ('service-call-base-v1','base-only-v1') then base
          else crm_stat_number(item->>'unitPriceCents', crm_stat_cents(crm_stat_number(item->>'amount')*100)) end;
        quantity := least(9999.999, greatest(0, round(crm_stat_number(item->>'quantity',1),3)));
        subtotal := crm_stat_cents(crm_stat_cents(unit)*quantity);
        discounted := greatest(0,subtotal-crm_stat_cents(crm_stat_number(item->>'discountCents')));
        tax := case when item->>'taxable'='true' then crm_stat_cents(discounted*least(10000,greatest(0,round(crm_stat_number(item->>'taxRateBps'))))/10000) else 0 end;
        line := crm_stat_cents(discounted+tax);
        total := total+line;
      end loop;
      return case when total>0 then crm_stat_cents(total)::bigint else crm_stat_cents(invoice*100)::bigint end;
    end $$`,
  `create or replace function crm_stat_payment_date(payment jsonb, job text) returns date language plpgsql stable as $$
    declare received timestamptz; paid_on date; raw text := payment->>'createdAt'; begin
      if payment->>'source'='offline' and to_regclass('offline_payments') is not null then
        execute 'select payment_date,created_at from offline_payments where id::text=$1 and job_id=$2'
          into paid_on,received using payment->>'id',job;
        if paid_on is not null then return paid_on; end if;
      end if;
      if received is null then
        if raw is null or raw !~ '^\\d{4}-\\d{2}-\\d{2}T.*(Z|[+-]\\d{2}:\\d{2})$' then return null; end if;
        received := raw::timestamptz;
      end if;
      return (received at time zone 'America/Indiana/Indianapolis')::date;
    exception when invalid_datetime_format or datetime_field_overflow then return null; end $$`,
  `create or replace function crm_stat_payment_already_posted(job text,payment jsonb) returns boolean language plpgsql stable as $$
    declare posted boolean; fact text; begin
      if to_regclass('nestwise_integration.outbox') is null then return false;end if;
      fact:=case when payment->>'source'='offline' then 'offline:'||(payment->>'id')
        when payment->>'source'='stripe_terminal' then 'stripe:'||(payment->>'paymentIntentId') end;
      if fact is null then return false;end if;
      execute 'select exists(select 1 from nestwise_integration.outbox where job_id=$1 and status=''acked''
        and body::jsonb->>''type''=''job.payment_recorded'' and body::jsonb->>''source_fact_id''=$2)'
        into posted using job,fact;
      return posted;
    end $$`,
  `create or replace function crm_stat_receipt_date(value text) returns date language plpgsql immutable as $$
    declare d date; begin
      if value is null or value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then return null;end if;
      d:=value::date;if to_char(d,'YYYY-MM-DD')<>value then return null;end if;return d;
    exception when invalid_datetime_format or datetime_field_overflow then return null;end $$`,
  `create or replace function crm_refresh_statistics(target date) returns void language plpgsql as $$
    begin
      if target is null then return; end if;
      target := date_trunc('month',target)::date;
      perform pg_advisory_xact_lock(810082026);
      insert into crm_monthly_statistics(month,report,updated_at)
      with eligible as (
        select j.id, extract(day from j.service_date)::integer as day,
          case when j.booking_source in ('google','google_maps') or j.booking_source_detail='actions_center' then 'Google'
            when j.booking_source='website' then 'Website' when coalesce(j.booking_source,'')='' then 'Phone' else 'Other' end as source,
          crm_stat_invoice(j.finance_items,j.invoice) as gross,
          coalesce((select sum(crm_stat_number(coalesce(r.data->>'expenseCents',r.data->>'totalCents'))) from parts_receipts r where r.job_id=j.id and r.status='confirmed' and r.deleted_at is null),0) as parts,
          case when crm_stat_diagnostic_only(j.finance_items) or exists(select 1 from parts_receipts r where r.job_id=j.id and r.status='confirmed' and r.deleted_at is null) then 0 else 1 end as missing,
          coalesce((select sum(greatest(0,round(crm_stat_number(p->>'processingFeeCents')))) from jsonb_array_elements(case when jsonb_typeof(j.payments)='array' then j.payments else '[]'::jsonb end) p
            where coalesce(p->>'voidedAt','')='' and lower(coalesce(p->>'status','')) in ('','succeeded','completed','paid','refunded')),0) as fees
        from jobs j where j.service_date>=target and j.service_date<(target+interval '1 month') and j.status<>'canceled'
      ), cash_parts as (
        select coalesce(sum(crm_stat_number(coalesce(r.data->>'expenseCents',r.data->>'totalCents'))),0) as paid
        from parts_receipts r where r.status='confirmed' and r.deleted_at is null
         and nullif(to_jsonb(r)->>'inventory_usage_id','') is null and r.data->>'currency'='USD'
         and crm_stat_receipt_date(r.data->>'date')>=target and crm_stat_receipt_date(r.data->>'date')<target+interval '1 month'
      ), daily as (select day,source,count(*) as count from eligible group by day,source),
      payments as (
        select p,crm_stat_payment_date(p,j.id) as received_date,
          true as recognized
        from jobs j
        cross join lateral jsonb_array_elements(case when jsonb_typeof(j.payments)='array' then j.payments else '[]'::jsonb end) p
        where coalesce(p->>'voidedAt','')='' and lower(coalesce(p->>'status','')) in ('','succeeded','completed','paid')
      ), cash as (
        select coalesce(sum(crm_stat_cents(crm_stat_number(p->>'amount')*100)) filter(where recognized),0) as received,
          coalesce(sum(crm_stat_cents(crm_stat_number(p->>'amount')*100)) filter(where not recognized),0) as awaiting,
          coalesce(sum(crm_stat_cents(crm_stat_number(p->>'processingFeeCents'))) filter(where recognized),0) as fees
        from payments where received_date>=target and received_date<target+interval '1 month'
      )
      select target,jsonb_build_object('month',to_char(target,'YYYY-MM'),'orders',count(*),
        'gross',coalesce(sum(gross),0),'parts',coalesce(sum(parts),0),'fees',coalesce(sum(fees),0),
        'net',coalesce(sum(gross-parts-fees),0),'withoutReceipts',coalesce(sum(missing),0),
        'received',(select received from cash),'receivedFees',(select fees from cash),
        'receivedNet',(select received-fees from cash)-(select paid from cash_parts),
        'receivedParts',(select paid from cash_parts),
        'awaitingCompletion',(select awaiting from cash),
        'undatedPayments',(select count(*) from payments where received_date is null),
        'days',coalesce((select jsonb_agg(to_jsonb(daily) order by day,source) from daily),'[]'::jsonb)),clock_timestamp()
      from eligible
      on conflict(month) do update set report=excluded.report,updated_at=excluded.updated_at;
    end $$`,
  `create or replace function crm_jobs_statistics_trigger() returns trigger language plpgsql as $$ declare payment_month date; begin
    if TG_OP='UPDATE' and row(OLD.service_date,OLD.status,OLD.invoice,OLD.finance_items,OLD.payments,OLD.booking_source,OLD.booking_source_detail)
      is not distinct from row(NEW.service_date,NEW.status,NEW.invoice,NEW.finance_items,NEW.payments,NEW.booking_source,NEW.booking_source_detail) then return NEW; end if;
    if TG_OP<>'INSERT' then perform crm_refresh_statistics(OLD.service_date); end if;
    if TG_OP='INSERT' or (TG_OP='UPDATE' and date_trunc('month',NEW.service_date) is distinct from date_trunc('month',OLD.service_date)) then
      perform crm_refresh_statistics(NEW.service_date);
    end if;
    for payment_month in
      select distinct date_trunc('month',crm_stat_payment_date(p,coalesce(NEW.id,OLD.id)))::date
      from jsonb_array_elements(
        (case when TG_OP<>'INSERT' and jsonb_typeof(OLD.payments)='array' then OLD.payments else '[]'::jsonb end) ||
        (case when TG_OP<>'DELETE' and jsonb_typeof(NEW.payments)='array' then NEW.payments else '[]'::jsonb end)) p
    loop perform crm_refresh_statistics(payment_month); end loop;
    return null;
  end $$`,
  `create or replace function crm_receipts_statistics_trigger() returns trigger language plpgsql as $$ declare target date; payment_month date; begin
    if TG_OP='UPDATE' and row(OLD.job_id,OLD.status,OLD.data,OLD.deleted_at) is not distinct from row(NEW.job_id,NEW.status,NEW.data,NEW.deleted_at) then return NEW; end if;
    if TG_OP<>'INSERT' then select service_date into target from jobs where id=OLD.job_id; perform crm_refresh_statistics(target); end if;
    if TG_OP='INSERT' or (TG_OP='UPDATE' and NEW.job_id is distinct from OLD.job_id) then
      select service_date into target from jobs where id=NEW.job_id; perform crm_refresh_statistics(target);
    end if;
    if TG_OP<>'INSERT' then perform crm_refresh_statistics(crm_stat_receipt_date(OLD.data->>'date'));end if;
    if TG_OP<>'DELETE' then perform crm_refresh_statistics(crm_stat_receipt_date(NEW.data->>'date'));end if;
    for payment_month in select distinct date_trunc('month',crm_stat_payment_date(p,j.id))::date from jobs j
      cross join lateral jsonb_array_elements(case when jsonb_typeof(j.payments)='array' then j.payments else '[]'::jsonb end) p
      where j.id in (case when TG_OP<>'INSERT' then OLD.job_id end,case when TG_OP<>'DELETE' then NEW.job_id end)
    loop perform crm_refresh_statistics(payment_month);end loop;
    return null;
  end $$`,
  `create or replace trigger crm_jobs_statistics after insert or update or delete on jobs for each row execute function crm_jobs_statistics_trigger()`,
  `create or replace trigger crm_receipts_statistics after insert or update or delete on parts_receipts for each row execute function crm_receipts_statistics_trigger()`,
  `select crm_refresh_statistics(month) from (select distinct date_trunc('month',service_date)::date as month from jobs where service_date is not null) months`,
  `select crm_refresh_statistics(month) from (
    select distinct date_trunc('month',crm_stat_payment_date(p,j.id))::date as month from jobs j
    cross join lateral jsonb_array_elements(case when jsonb_typeof(j.payments)='array' then j.payments else '[]'::jsonb end) p
    union select date_trunc('month',crm_stat_receipt_date(data->>'date'))::date from parts_receipts
    union select month from crm_monthly_statistics
  ) months where month is not null`,
  `insert into crm_statistics_schema(version) values(6) on conflict do nothing`,
]

let ready: Promise<void> | undefined
export async function ensureStatistics(sql: ReturnType<typeof neon>) {
  ready ??= (async () => {
    const tables = await sql.query(`select to_regclass('crm_statistics_schema') as name`) as { name: string | null }[]
    if (tables[0]?.name) {
      const version = await sql.query('select version from crm_statistics_schema where version=6') as { version: number }[]
      if (version.length) return
    }
    await sql.transaction(statisticsSchemaStatements.map(statement => sql.query(statement)))
  })().catch(error => { ready = undefined; throw error })
  await ready
}

export async function readStatistics(sql: ReturnType<typeof neon>) {
  await ensureStatistics(sql)
  const rows = await sql.query('select report, updated_at from crm_monthly_statistics order by month desc') as { report: Record<string, unknown>; updated_at: string }[]
  const acquisition = await readAcquisitionStatistics(sql)
  return { paymentDateReporting: true, acquisition, reports: rows.map(row => ({ ...row.report, updatedAt: row.updated_at })) }
}

export async function readAcquisitionStatistics(sql: ReturnType<typeof neon>) {
  const [schema] = await sql.query(`select to_regclass('receptionist_calls') is not null
    and to_regclass('receptionist_web_sessions') is not null as ready`)
  if (!schema?.ready) return null
  // Aggregate calls before joining any one-to-many records to avoid double counting.
  const calls = await sql.query(`select to_char(started_at at time zone 'America/Indiana/Indianapolis','YYYY-MM') as month,
    case when exists(select 1 from receptionist_web_sessions w where w.provider_call_id=c.provider_call_id)
      then 'Website voice' else 'Phone Emily' end as source,
    count(*)::int as total,
    count(*) filter(where job_id is not null or outcome='booked')::int as booked,
    count(*) filter(where job_id is null and outcome<>'booked')::int as unbooked
    from receptionist_calls c where ended_at is not null
    group by 1,2 order by 1 desc,2`)
  const orders = await sql.query(`select to_char(created_at at time zone 'America/Indiana/Indianapolis','YYYY-MM') as month,
    case when booking_source_detail='phone_assistant' then 'Phone Emily'
      when booking_source_detail='voice_assistant' then 'Website voice'
      when booking_source_detail='actions_center' or booking_source in ('google','google_maps') then 'Google'
      when booking_source='website' then 'Website form'
      when coalesce(booking_source,'')='' then 'Phone / manual' else 'Other' end as source,
    count(*)::int as orders from jobs where created_at is not null and status<>'canceled'
    group by 1,2 order by 1 desc,2`)
  return { calls, orders }
}

export async function readOrdersWithoutReceipts(sql: ReturnType<typeof neon>, month: string) {
  if (!/^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('Invalid statistics month')
  await ensureStatistics(sql)
  const orders = await sql.query(`select j.id,j.customer,j.appliance,to_char(j.service_date,'YYYY-MM-DD') as service_date,j.status
    from jobs j where j.service_date >= $1::date and j.service_date < ($1::date + interval '1 month')
    and j.status <> 'canceled'
    and not crm_stat_diagnostic_only(j.finance_items)
    and not exists(select 1 from parts_receipts r where r.job_id=j.id and r.status='confirmed' and r.deleted_at is null)
    order by j.service_date desc,j.id`, [month + '-01'])
  return { month, orders }
}
