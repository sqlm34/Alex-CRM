-- Staged only. Apply after owner release approval.
begin;
create table if not exists receptionist_vip_settings (
  singleton boolean primary key default true check(singleton),
  revision integer not null default 0,
  enabled boolean not null default false,
  encrypted_config text not null default '',
  updated_at timestamptz not null default now()
);
insert into receptionist_vip_settings(singleton) values(true) on conflict do nothing;
create table if not exists receptionist_vip_attempts (
  call_id text primary key references receptionist_calls(id),
  attempts integer not null default 1,
  status text not null check(status in ('checking','denied','authorizing','authorized','unknown','started','bridged','failed','ended')),
  updated_at timestamptz not null default now()
);
create table if not exists receptionist_vip_limits (
  bucket text primary key,
  attempts integer not null,
  expires_at timestamptz not null
);
create index if not exists receptionist_vip_limits_expiry on receptionist_vip_limits(expires_at);
alter table receptionist_vip_settings enable row level security;
alter table receptionist_vip_attempts enable row level security;
alter table receptionist_vip_limits enable row level security;
commit;
