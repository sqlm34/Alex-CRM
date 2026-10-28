begin;
create table if not exists receptionist_web_sessions (
  id text primary key,
  provider_call_id text unique,
  agent_id text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ended_at timestamptz
);
create table if not exists receptionist_web_limits (
  bucket text primary key,
  used integer not null default 0,
  expires_at timestamptz not null
);
create table if not exists receptionist_web_capacity (
  singleton boolean primary key default true check (singleton),
  session_id text,
  lease_until timestamptz not null default now()
);
insert into receptionist_web_capacity(singleton) values(true) on conflict do nothing;
alter table receptionist_web_sessions enable row level security;
alter table receptionist_web_limits enable row level security;
alter table receptionist_web_capacity enable row level security;
alter table jobs drop constraint if exists jobs_booking_source_detail_check;
alter table jobs add constraint jobs_booking_source_detail_check
  check (booking_source_detail is null or booking_source_detail in ('actions_center','voice_assistant'));
commit;
