begin;

create table if not exists public.price_book_items (
  id text primary key,
  name text not null,
  description text,
  category text,
  unit_price_cents integer not null default 0,
  taxable boolean not null default false,
  active boolean not null default true,
  created_by text references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint price_book_items_unit_price_cents_nonnegative check (unit_price_cents >= 0)
);

create index if not exists price_book_items_active_category_name_idx
  on public.price_book_items (active, category, name);

create index if not exists price_book_items_created_by_idx
  on public.price_book_items (created_by);

commit;

/*
Pre-migration read-only checks:

select to_regclass('public.price_book_items') as price_book_table;
select count(*) as jobs_count from public.jobs;
select count(*) as users_count from public.users;

Post-migration checks:

select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public' and table_name = 'price_book_items'
order by ordinal_position;

select count(*) as price_book_items_count from public.price_book_items;

Rollback plan:

The migration is additive. If the Worker/frontend release is stopped, leave the empty
table in place. If a full rollback is explicitly approved before real Price Book data
is entered, run:

begin;
drop table if exists public.price_book_items;
commit;
*/
