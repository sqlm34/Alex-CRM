begin;
alter table receptionist_calls add column if not exists location_zip text;
alter table receptionist_calls add column if not exists location_city text;
commit;
