begin;

create table if not exists public.offline_payments (
  id uuid primary key,
  job_id text not null references public.jobs(id) on delete restrict,
  amount_cents integer not null,
  method text not null,
  status text not null default 'succeeded',
  payment_date date not null,
  reference text,
  note text,
  received_by text references public.users(id) on delete set null,
  created_by text references public.users(id) on delete set null,
  idempotency_key text not null,
  processing_fee_cents integer not null default 0,
  source text not null default 'offline',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  voided_at timestamptz,
  voided_by text references public.users(id) on delete set null,
  void_reason text,
  constraint offline_payments_amount_positive check (amount_cents > 0),
  constraint offline_payments_fee_zero check (source <> 'offline' or processing_fee_cents = 0),
  constraint offline_payments_source_valid check (source in ('offline')),
  constraint offline_payments_method_valid check (
    method in (
      'cash',
      'check',
      'zelle',
      'venmo',
      'cash_app',
      'bank_transfer',
      'credit_offline',
      'debit_offline',
      'other'
    )
  ),
  constraint offline_payments_status_valid check (status in ('succeeded', 'voided')),
  constraint offline_payments_void_reason_required check (status <> 'voided' or nullif(btrim(coalesce(void_reason, '')), '') is not null),
  constraint offline_payments_void_metadata_required check (status <> 'voided' or (voided_at is not null and voided_by is not null)),
  constraint offline_payments_reference_length check (char_length(coalesce(reference, '')) <= 120),
  constraint offline_payments_note_length check (char_length(coalesce(note, '')) <= 1000),
  constraint offline_payments_idempotency_key_length check (char_length(idempotency_key) between 12 and 120),
  unique (job_id, idempotency_key)
);

create index if not exists offline_payments_job_created_idx
  on public.offline_payments (job_id, created_at desc);

create index if not exists offline_payments_job_active_idx
  on public.offline_payments (job_id, status)
  where status = 'succeeded';

commit;
