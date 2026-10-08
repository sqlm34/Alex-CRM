import type { neon } from '@neondatabase/serverless'

// Installed atomically once. Triggers keep reports consistent with the write transaction.
export const statisticsSchemaStatements = [
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
  `create or replace function crm_stat_invoice(items jsonb, invoice numeric) returns bigint
    language plpgsql immutable as $$ declare item jsonb; unit numeric; subtotal numeric; discounted numeric;
    line numeric; total numeric := 0; base numeric; quantity numeric; tax numeric;
    begin
      for item in select value from jsonb_array_elements(case when jsonb_typeof(items)='array' then items else '[]'::jsonb end) loop
        base := crm_stat_number(item->>'baseUnitPriceCents');
        unit := case
          when item->>'baseUnitPriceCents' is not null and item->>'pricingVersion'='base-plus-5-percent-30c-v1' then floor((base*105+50)/100)+30
          when item->>'baseUnitPriceCents' is not null and item->>'pricingVersion'='service-call-base-v1' then base
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
          coalesce((select sum(crm_stat_number(r.data->>'totalCents')) from parts_receipts r where r.job_id=j.id and r.status='confirmed' and r.deleted_at is null),0) as parts,
          case when exists(select 1 from parts_receipts r where r.job_id=j.id and r.status='confirmed' and r.deleted_at is null) then 0 else 1 end as missing,
          coalesce((select sum(greatest(0,round(crm_stat_number(p->>'processingFeeCents')))) from jsonb_array_elements(case when jsonb_typeof(j.payments)='array' then j.payments else '[]'::jsonb end) p
            where coalesce(p->>'voidedAt','')='' and lower(coalesce(p->>'status','')) in ('','succeeded','completed','paid','refunded')),0) as fees
        from jobs j where j.service_date>=target and j.service_date<(target+interval '1 month') and j.status<>'canceled'
      ), daily as (select day,source,count(*) as count from eligible group by day,source)
      select target,jsonb_build_object('month',to_char(target,'YYYY-MM'),'orders',count(*),
        'gross',coalesce(sum(gross),0),'parts',coalesce(sum(parts),0),'fees',coalesce(sum(fees),0),
        'net',coalesce(sum(gross-parts-fees),0),'withoutReceipts',coalesce(sum(missing),0),
        'days',coalesce((select jsonb_agg(to_jsonb(daily) order by day,source) from daily),'[]'::jsonb)),clock_timestamp()
      from eligible
      on conflict(month) do update set report=excluded.report,updated_at=excluded.updated_at;
    end $$`,
  `create or replace function crm_jobs_statistics_trigger() returns trigger language plpgsql as $$ begin
    if TG_OP='UPDATE' and row(OLD.service_date,OLD.status,OLD.invoice,OLD.finance_items,OLD.payments,OLD.booking_source,OLD.booking_source_detail)
      is not distinct from row(NEW.service_date,NEW.status,NEW.invoice,NEW.finance_items,NEW.payments,NEW.booking_source,NEW.booking_source_detail) then return NEW; end if;
    if TG_OP<>'INSERT' then perform crm_refresh_statistics(OLD.service_date); end if;
    if TG_OP='INSERT' or (TG_OP='UPDATE' and date_trunc('month',NEW.service_date) is distinct from date_trunc('month',OLD.service_date)) then
      perform crm_refresh_statistics(NEW.service_date);
    end if;
    return null;
  end $$`,
  `create or replace function crm_receipts_statistics_trigger() returns trigger language plpgsql as $$ declare target date; begin
    if TG_OP='UPDATE' and row(OLD.job_id,OLD.status,OLD.data,OLD.deleted_at) is not distinct from row(NEW.job_id,NEW.status,NEW.data,NEW.deleted_at) then return NEW; end if;
    if TG_OP<>'INSERT' then select service_date into target from jobs where id=OLD.job_id; perform crm_refresh_statistics(target); end if;
    if TG_OP='INSERT' or (TG_OP='UPDATE' and NEW.job_id is distinct from OLD.job_id) then
      select service_date into target from jobs where id=NEW.job_id; perform crm_refresh_statistics(target);
    end if;
    return null;
  end $$`,
  `create or replace trigger crm_jobs_statistics after insert or update or delete on jobs for each row execute function crm_jobs_statistics_trigger()`,
  `create or replace trigger crm_receipts_statistics after insert or update or delete on parts_receipts for each row execute function crm_receipts_statistics_trigger()`,
  `select crm_refresh_statistics(month) from (select distinct date_trunc('month',service_date)::date as month from jobs where service_date is not null) months`,
  `insert into crm_statistics_schema(version) values(1) on conflict do nothing`,
]

let ready: Promise<void> | undefined
export async function ensureStatistics(sql: ReturnType<typeof neon>) {
  ready ??= (async () => {
    const tables = await sql.query(`select to_regclass('crm_statistics_schema') as name`) as { name: string | null }[]
    if (tables[0]?.name) {
      const version = await sql.query('select version from crm_statistics_schema where version=1') as { version: number }[]
      if (version.length) return
    }
    await sql.transaction(statisticsSchemaStatements.map(statement => sql.query(statement)))
  })().catch(error => { ready = undefined; throw error })
  await ready
}

export async function readStatistics(sql: ReturnType<typeof neon>) {
  await ensureStatistics(sql)
  const rows = await sql.query('select report, updated_at from crm_monthly_statistics order by month desc') as { report: Record<string, unknown>; updated_at: string }[]
  return { reports: rows.map(row => ({ ...row.report, updatedAt: row.updated_at })) }
}
