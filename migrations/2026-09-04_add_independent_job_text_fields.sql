-- Add independent editable job text fields for Alex CRM.
-- Run against Neon only after taking a backup and before deploying the Worker that writes these columns.

-- Preflight read-only checks.
select to_regclass('public.jobs') as jobs_table;

select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name = 'jobs'
  and column_name in ('appliance', 'issue', 'details', 'job_text')
order by column_name;

select
  count(*) as total_jobs,
  count(*) filter (where appliance is null) as appliance_null_count,
  count(*) filter (where issue is null) as issue_null_count
from public.jobs;

begin;

alter table public.jobs
  add column if not exists details text,
  add column if not exists job_text text;

update public.jobs
set
  details = coalesce(details, appliance),
  job_text = coalesce(job_text, issue)
where details is null
   or job_text is null;

-- Control checks before commit.
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name = 'jobs'
  and column_name in ('details', 'job_text')
order by column_name;

select
  count(*) as total_jobs,
  count(*) filter (where details is null) as details_null_count,
  count(*) filter (where job_text is null) as job_text_null_count
from public.jobs;

commit;

-- Rollback plan if the application deployment is stopped before users edit these fields:
-- begin;
-- update public.jobs
-- set details = null,
--     job_text = null;
-- commit;
--
-- Prefer leaving the additive nullable columns in place. Drop them only after confirming
-- no deployed Worker/frontend reads or writes them:
-- alter table public.jobs
--   drop column if exists details,
--   drop column if exists job_text;
