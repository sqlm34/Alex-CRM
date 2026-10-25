-- Additive only. Apply after the existing booking and receptionist migrations.
begin;
alter table jobs drop constraint if exists jobs_booking_source_detail_check;
alter table jobs add constraint jobs_booking_source_detail_check
  check (booking_source_detail is null or booking_source_detail in ('actions_center','voice_assistant','phone_assistant','mcp_assistant'));
create table if not exists mcp_intents (
  token_hash text primary key,
  principal text not null,
  action text not null check(action in ('createBooking','cancelBooking')),
  details jsonb not null,
  expires_at timestamptz not null
);
create table if not exists mcp_approvals (
  token_hash text primary key,
  principal text not null,
  action text not null check (action in ('createBooking','cancelBooking')),
  payload_hash text not null,
  session_id text not null references booking_sessions(id),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create table if not exists mcp_operations (
  principal text not null,
  idempotency_key text not null,
  action text not null check (action in ('createBooking','cancelBooking')),
  payload_hash text not null,
  job_id text references jobs(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key(principal,idempotency_key)
);
create index if not exists mcp_operations_owner on mcp_operations(principal,job_id);
create table if not exists mcp_rate_limits (
  key_hash text not null,
  minute bigint not null,
  requests integer not null,
  primary key(key_hash,minute)
);
create table if not exists mcp_audit (
  id bigint generated always as identity primary key,
  tool text not null,
  principal text,
  outcome text not null,
  created_at timestamptz not null default now()
);
revoke all on mcp_intents,mcp_approvals,mcp_operations,mcp_rate_limits,mcp_audit from public;
commit;
