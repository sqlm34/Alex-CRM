-- Additive schema for private Cloudflare R2-backed job attachments.
-- Do not run until after a fresh Neon backup and release approval.

begin;

select to_regclass('public.jobs') as jobs_table;
select to_regclass('public.users') as users_table;

create table if not exists public.job_attachments (
  id uuid primary key default gen_random_uuid(),
  job_id text not null references public.jobs(id) on delete cascade,
  object_key text not null unique,
  thumbnail_key text unique,
  original_filename text,
  display_name text,
  mime_type text not null,
  kind text not null check (kind in ('image', 'video', 'document')),
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 104857600),
  width integer check (width is null or width > 0),
  height integer check (height is null or height > 0),
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  uploaded_by text references public.users(id) on delete set null,
  upload_status text not null default 'pending' check (upload_status in ('pending', 'ready', 'failed', 'deleted')),
  checksum text,
  idempotency_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (job_id, idempotency_key)
);

create index if not exists job_attachments_job_active_idx
  on public.job_attachments(job_id, created_at desc)
  where deleted_at is null and upload_status <> 'deleted';

create index if not exists job_attachments_pending_cleanup_idx
  on public.job_attachments(created_at)
  where upload_status = 'pending';

create index if not exists job_attachments_uploaded_by_idx
  on public.job_attachments(uploaded_by);

select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name = 'job_attachments'
order by ordinal_position;

commit;

-- Rollback plan:
-- 1. Roll back Worker/frontend to versions that do not create R2 attachments.
-- 2. Keep this additive table in place while investigating; it is harmless to old code.
-- 3. Only after confirming no production dependency remains, optionally:
--    drop table if exists public.job_attachments;
