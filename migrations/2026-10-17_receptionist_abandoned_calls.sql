begin;
alter table receptionist_calls add column if not exists disconnect_reason text;
alter table receptionist_calls add column if not exists duration_ms bigint;
alter table receptionist_callbacks add column if not exists kind text not null default 'requested'
  check (kind in ('requested','abandoned'));
create index if not exists receptionist_incomplete_calls on receptionist_calls(ended_at)
  where job_id is null and disconnect_reason='user_hangup';
commit;
