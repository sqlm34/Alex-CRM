-- Apply only to an explicitly selected non-production database during review.
alter table public.jobs add column if not exists booking_source_detail text
  check (booking_source_detail is null or booking_source_detail = 'actions_center');

-- Protected storage: never join these records into ordinary jobs API responses.
create table if not exists public.google_actions_attributions (
  id text primary key,
  capture_key text not null unique,
  environment text not null check (environment in ('sandbox', 'production')),
  deployment text not null,
  partner_id text not null,
  merchant_id text not null,
  rwg_token text,
  captured_at timestamptz not null,
  expires_at timestamptz not null,
  check (expires_at = captured_at + interval '2592000 seconds')
);

create table if not exists public.google_actions_conversions (
  job_id text primary key references public.jobs(id) on delete cascade,
  session_id text not null unique,
  attribution_id text not null references public.google_actions_attributions(id),
  environment text not null check (environment in ('sandbox', 'production')),
  deployment text not null,
  partner_id text not null,
  merchant_id text not null,
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'ambiguous', 'failed_terminal')),
  attempts integer not null default 0 check (attempts between 0 and 5),
  next_attempt_at timestamptz not null default now(),
  last_attempt_at timestamptz,
  sent_at timestamptz,
  lease_id text,
  lease_until timestamptz,
  last_error text check (last_error in ('rate_limited', 'delivery_unknown', 'request_rejected', 'lease_expired', 'attribution_expired')),
  created_at timestamptz not null default now()
);
create index if not exists google_actions_due_idx on public.google_actions_conversions
  (environment, deployment, partner_id, next_attempt_at) where status = 'pending';
create index if not exists google_actions_expiry_idx on public.google_actions_attributions (expires_at);
revoke all on public.google_actions_attributions, public.google_actions_conversions from public;
