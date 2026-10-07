-- Additive only. Supplier selections are quotes, not parts_receipts expenses.
create table if not exists appliance_scans (
  id text primary key, job_id text not null references jobs(id) on delete cascade, attachment_id text not null,
  identity jsonb, status text not null default 'processing', created_by text not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(job_id,attachment_id)
);
create table if not exists part_searches (
  id text primary key, job_id text not null references jobs(id) on delete cascade, request_key text not null,
  request_hash text not null, status text not null default 'processing', data jsonb,
  created_by text not null, created_at timestamptz not null default now(), unique(job_id,request_key)
);
create table if not exists job_parts (
  id text primary key, job_id text not null references jobs(id) on delete cascade,
  search_id text not null references part_searches(id) on delete cascade,
  result_id text not null, supplier text not null, part_number text not null, description text not null,
  quantity integer not null check(quantity between 1 and 100), unit_cost_cents integer not null check(unit_cost_cents>=0),
  total_cost_cents bigint not null, product_url text not null, status text not null default 'selected',
  created_by text not null, created_at timestamptz not null default now(), unique(job_id,search_id,result_id)
);
create table if not exists parts_request_usage (
  user_id text not null, day date not null, calls integer not null default 0, primary key(user_id,day)
);
