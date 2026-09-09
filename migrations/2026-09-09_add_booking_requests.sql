-- Durable idempotency receipts; preserve the key even if its job is later deleted.
create table if not exists public.booking_requests (
  request_id text primary key check (length(request_id) between 16 and 100),
  session_id text not null unique,
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  job_id text unique references public.jobs(id) on delete set null deferrable initially deferred,
  created_at timestamptz not null default now()
);
revoke all on public.booking_requests from public;
