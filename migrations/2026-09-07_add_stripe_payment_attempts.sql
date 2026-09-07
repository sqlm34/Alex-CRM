begin;

create table if not exists public.stripe_payment_attempts (
  id uuid primary key,
  job_id text not null references public.jobs(id) on delete restrict,
  created_by text references public.users(id) on delete set null,
  idempotency_key text not null,
  stripe_payment_intent_id text unique,
  internal_status text not null default 'reserved',
  stripe_status text,
  desired_net_cents integer not null,
  charge_amount_cents integer not null,
  expected_fee_cents integer,
  actual_fee_cents integer,
  actual_net_cents integer,
  currency text not null default 'usd',
  card_funding text,
  card_type text,
  card_brand text,
  charge_id text,
  balance_transaction_id text,
  failure_code text,
  failure_message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  canceled_at timestamptz,
  constraint stripe_payment_attempts_idempotency_key_length check (char_length(idempotency_key) between 12 and 255),
  constraint stripe_payment_attempts_amount_positive check (desired_net_cents > 0 and charge_amount_cents > 0),
  constraint stripe_payment_attempts_fee_nonnegative check (
    expected_fee_cents is null or expected_fee_cents >= 0
  ),
  constraint stripe_payment_attempts_actual_fee_nonnegative check (
    actual_fee_cents is null or actual_fee_cents >= 0
  ),
  constraint stripe_payment_attempts_actual_net_nonnegative check (
    actual_net_cents is null or actual_net_cents >= 0
  ),
  constraint stripe_payment_attempts_currency_valid check (currency ~ '^[a-z]{3}$'),
  constraint stripe_payment_attempts_internal_status_valid check (
    internal_status in (
      'reserved',
      'requires_payment_method',
      'requires_confirmation',
      'requires_capture',
      'processing',
      'succeeded',
      'failed',
      'canceled',
      'abandoned',
      'recorded'
    )
  ),
  constraint stripe_payment_attempts_card_funding_valid check (
    card_funding is null or card_funding in ('credit', 'debit', 'prepaid', 'unknown')
  ),
  constraint stripe_payment_attempts_failure_code_length check (char_length(coalesce(failure_code, '')) <= 120),
  constraint stripe_payment_attempts_failure_message_length check (char_length(coalesce(failure_message, '')) <= 1000),
  unique (job_id, idempotency_key)
);

create unique index if not exists stripe_payment_attempts_idempotency_key_unique
  on public.stripe_payment_attempts (idempotency_key);

create unique index if not exists stripe_payment_attempts_job_one_active_idx
  on public.stripe_payment_attempts (job_id)
  where internal_status in (
    'reserved',
    'requires_payment_method',
    'requires_confirmation',
    'requires_capture',
    'processing'
  );

create index if not exists stripe_payment_attempts_job_created_idx
  on public.stripe_payment_attempts (job_id, created_at desc);

create index if not exists stripe_payment_attempts_intent_idx
  on public.stripe_payment_attempts (stripe_payment_intent_id)
  where stripe_payment_intent_id is not null;

create or replace function public.prevent_stripe_payment_attempts_delete()
returns trigger
language plpgsql
as $$
begin
  raise exception 'stripe payment attempts are audit records and cannot be deleted';
end;
$$;

drop trigger if exists prevent_stripe_payment_attempts_delete on public.stripe_payment_attempts;

create trigger prevent_stripe_payment_attempts_delete
before delete on public.stripe_payment_attempts
for each row
execute function public.prevent_stripe_payment_attempts_delete();

commit;
