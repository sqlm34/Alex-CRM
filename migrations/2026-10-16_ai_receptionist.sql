-- Apply only after owner approval. No existing job/customer data is rewritten.
begin;
create table if not exists receptionist_settings (
  singleton boolean primary key default true check (singleton),
  revision integer not null default 0,
  settings jsonb not null,
  updated_at timestamptz not null default now()
);
insert into receptionist_settings(singleton,settings) values(true,
 '{"enabled":false,"testMode":true,"serviceZips":[],"appliances":["Washer repair","Dryer repair","Dishwasher repair","Oven repair","Refrigerator repair"],"suspectedSealedSystemDiagnostic":false,"diagnosticFee":"","transferPhone":"","publicPhone":"","revision":0}') on conflict do nothing;
create table if not exists receptionist_calls (
  id text primary key,
  provider text not null check (provider in ('retell','openai','elevenlabs')),
  provider_call_id text not null,
  caller_phone text not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  outcome text not null default 'in_progress',
  summary text not null default '',
  job_id text references jobs(id) on delete set null,
  tool_count integer not null default 0,
  cost_cents numeric,
  latency_ms numeric,
  unique(provider,provider_call_id)
);
create index if not exists receptionist_calls_started on receptionist_calls(started_at desc);
create table if not exists receptionist_events (
  event_key text primary key,
  call_id text not null references receptionist_calls(id),
  event_type text not null,
  created_at timestamptz not null default now()
);
create table if not exists receptionist_callbacks (
  call_id text primary key references receptionist_calls(id),
  customer text not null,
  phone text not null,
  reason text not null,
  status text not null default 'pending' check(status in ('pending','resolved')),
  created_at timestamptz not null default now()
);
create table if not exists receptionist_audit (
  id bigint generated always as identity primary key,
  action text not null,
  actor_id text not null,
  created_at timestamptz not null default now()
);
create table if not exists receptionist_notifications (
  id bigint generated always as identity primary key,
  call_id text not null references receptionist_calls(id),
  job_id text not null references jobs(id) on delete cascade,
  kind text not null check(kind='owner_push'),
  status text not null default 'pending' check(status in ('pending','sending','sent','unknown')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(call_id,kind)
);
alter table receptionist_settings enable row level security;
alter table receptionist_calls enable row level security;
alter table receptionist_events enable row level security;
alter table receptionist_callbacks enable row level security;
alter table receptionist_audit enable row level security;
alter table receptionist_notifications enable row level security;
create table if not exists receptionist_push_checks (
  id text primary key,
  actor_id text not null,
  status text not null check(status in ('sending','accepted','unknown')),
  created_at timestamptz not null default now()
);
alter table receptionist_push_checks enable row level security;
commit;
