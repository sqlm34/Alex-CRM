begin;
alter table jobs drop constraint if exists jobs_booking_source_detail_check;
alter table jobs add constraint jobs_booking_source_detail_check
  check (booking_source_detail is null or booking_source_detail in ('actions_center','voice_assistant','phone_assistant'));
update jobs set booking_source_detail='phone_assistant'
where booking_source is null and booking_source_detail is null
and exists (select 1 from booking_sessions s where s.job_id=jobs.id and s.source='ai_phone');
commit;
