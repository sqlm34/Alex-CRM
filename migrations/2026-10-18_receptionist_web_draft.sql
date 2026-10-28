alter table receptionist_web_sessions add column if not exists draft jsonb not null default '{}'::jsonb;
