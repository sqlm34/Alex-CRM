export const createJobsTableSql = `
create table if not exists jobs (
  id text primary key,
  customer text not null,
  phone text not null,
  address text not null,
  appliance text not null,
  issue text not null default '',
  service_date date not null,
  service_window text not null,
  status text not null check (status in ('new', 'scheduled', 'in_progress', 'complete')),
  invoice numeric(10, 2) not null default 0,
  paid boolean not null default false,
  lat double precision not null,
  lng double precision not null,
  created_at timestamptz not null default now()
);

create index if not exists jobs_service_date_idx on jobs (service_date);
create index if not exists jobs_customer_idx on jobs (customer);
`
