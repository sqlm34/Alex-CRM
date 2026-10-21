begin;
-- Historical callbacks must not unexpectedly ring after deployment.
alter table receptionist_callbacks add column if not exists push_status text not null default 'unknown'
  check (push_status in ('pending','sending','sent','unknown'));
alter table receptionist_callbacks add column if not exists push_updated_at timestamptz not null default now();
alter table receptionist_callbacks alter column push_status set default 'pending';
commit;
