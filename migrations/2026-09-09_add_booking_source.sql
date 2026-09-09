begin;
alter table public.jobs add column if not exists booking_source text;
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.jobs'::regclass and conname = 'jobs_booking_source_valid') then
    alter table public.jobs add constraint jobs_booking_source_valid
      check (booking_source is null or booking_source in ('google_maps', 'google', 'website'));
  end if;
end $$;
commit;
