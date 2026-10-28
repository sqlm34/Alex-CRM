begin;
create or replace function assign_default_job_owner() returns trigger language plpgsql as $$
begin
  if new.created_by_user_id is null then
    select u.id into new.created_by_user_id from users u
      join approved_users a on a.email=u.email and a.role='owner'
      where u.role='owner' order by u.created_at,u.id limit 1;
  end if;
  return new;
end;
$$;
drop trigger if exists jobs_default_owner on jobs;
create trigger jobs_default_owner before insert on jobs
for each row execute function assign_default_job_owner();
commit;
