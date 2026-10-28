begin;
-- Jobs remain the canonical client records in this CRM. Derive name parts without
-- discarding the supplied full name or introducing a competing customer table.
alter table jobs add column if not exists customer_first_name text generated always as
  (split_part(regexp_replace(trim(customer),'\s+',' ','g'),' ',1)) stored;
alter table jobs add column if not exists customer_last_name text generated always as
  (regexp_replace(regexp_replace(trim(customer),'\s+',' ','g'),'^\S+\s*','')) stored;
commit;
