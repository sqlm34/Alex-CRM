begin;
create table if not exists receptionist_phone_blocks (
  phone text primary key check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  blocked boolean not null,
  reason text not null default '' check (length(reason)<=500),
  updated_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists receptionist_phone_block_history (
  id bigint generated always as identity primary key,
  request_id uuid not null unique,
  phone text not null references receptionist_phone_blocks(phone),
  blocked boolean not null,
  reason text not null,
  actor_id text not null,
  created_at timestamptz not null default now()
);
create index if not exists receptionist_phone_block_history_phone on receptionist_phone_block_history(phone,created_at desc);
alter table receptionist_phone_blocks enable row level security;
alter table receptionist_phone_block_history enable row level security;
commit;
