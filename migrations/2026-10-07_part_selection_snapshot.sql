-- Additive quote provenance; existing rows and accounting are unchanged.
alter table job_parts add column if not exists snapshot jsonb;
