alter table parts_receipts add column if not exists history jsonb not null default '[]'::jsonb;
