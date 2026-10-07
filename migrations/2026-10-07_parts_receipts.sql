begin;
create table if not exists public.parts_receipts (
  id text primary key,
  job_id text not null references public.jobs(id),
  attachment_id text not null,
  content_hash text not null,
  status text not null check (status in ('processing','draft','confirmed','voided','failed')),
  data jsonb,
  created_by text not null,
  confirmed_by text,
  voided_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  confirmed_at timestamptz,
  unique(job_id, content_hash)
);
create index if not exists parts_receipts_job_idx on public.parts_receipts(job_id, created_at);
create table if not exists public.receipt_ai_usage (
  user_id text not null,
  day date not null,
  calls integer not null default 0,
  primary key(user_id, day)
);
commit;
