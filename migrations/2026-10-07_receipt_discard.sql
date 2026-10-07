begin;
alter table public.parts_receipts add column if not exists deleted_at timestamptz;
alter table public.parts_receipts add column if not exists deleted_by text;
commit;
