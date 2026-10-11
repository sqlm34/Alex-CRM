// No backfill: only a successful new public booking explicitly enrolls a job.
export const bookingNotificationSchema = [
  `create table if not exists booking_notification_subscriptions (
    job_id text primary key, revision integer not null default 0, created_at timestamptz not null default now()
  )`,
  `create table if not exists booking_notification_outbox (
    id bigserial primary key, job_id text not null references booking_notification_subscriptions(job_id),
    revision integer not null, kind text not null, payload jsonb not null, due_at timestamptz not null,
    created_at timestamptz not null default now(), sent_at timestamptz, suppressed_at timestamptz,
    attempts integer not null default 0, first_attempt_at timestamptz, next_attempt_at timestamptz not null default now(),
    provider_id text, last_error text, unique(job_id,revision,kind)
  )`,
  `create index if not exists booking_notification_due on booking_notification_outbox(due_at,next_attempt_at)
    where sent_at is null and suppressed_at is null`,
  `create or replace function queue_booking_notifications(p_job jsonb, p_kind text) returns void language plpgsql as $$
  declare v_revision integer; v_start timestamptz; v_status text := p_job->>'status';
  begin
    p_job := jsonb_build_object('id',p_job->>'id','customer',p_job->>'customer','email',p_job->>'email',
      'address',p_job->>'address','appliance',p_job->>'appliance','service_date',left(p_job->>'service_date',10),
      'service_window',p_job->>'service_window','status',p_job->>'status');
    update booking_notification_subscriptions set revision=revision+1 where job_id=p_job->>'id' returning revision into v_revision;
    if not found then return; end if;
    update booking_notification_outbox set suppressed_at=now() where job_id=p_job->>'id' and sent_at is null and suppressed_at is null;
    if v_status='complete' then return; end if;
    if coalesce(p_job->>'email','') !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' then return; end if;
    insert into booking_notification_outbox(job_id,revision,kind,payload,due_at)
      values(p_job->>'id',v_revision,p_kind,p_job,now());
    if v_status='canceled' or v_status in ('scheduled','in_progress') then
      insert into booking_notification_outbox(job_id,revision,kind,payload,due_at)
        values(p_job->>'id',v_revision,'calendar',p_job,now());
    end if;
    if v_status <> 'scheduled' then return; end if;
    v_start := ((left(p_job->>'service_date',10))::date + split_part(split_part(p_job->>'service_window','; ',1),' - ',1)::time)
      at time zone 'America/Indiana/Indianapolis';
    if v_start - interval '24 hours' > now() then
      insert into booking_notification_outbox(job_id,revision,kind,payload,due_at)
        values(p_job->>'id',v_revision,'reminder',p_job,v_start-interval '24 hours');
    end if;
  end $$`,
  `create or replace function booking_notification_job_changed() returns trigger language plpgsql as $$
  begin
    if TG_OP='DELETE' then
      perform queue_booking_notifications(to_jsonb(OLD)||'{"status":"canceled"}'::jsonb,'cancellation');
      return OLD;
    end if;
    if (OLD.customer,OLD.email,OLD.address,OLD.appliance,OLD.service_date,OLD.service_window,OLD.status)
      is distinct from (NEW.customer,NEW.email,NEW.address,NEW.appliance,NEW.service_date,NEW.service_window,NEW.status) then
      perform queue_booking_notifications(to_jsonb(NEW),case when NEW.status='canceled' then 'cancellation' else 'update' end);
    end if;
    return NEW;
  end $$`,
  `create or replace trigger booking_notification_changes after update or delete on jobs
    for each row execute function booking_notification_job_changed()`,
]

let ready = false
export async function ensureBookingNotificationTables(sql: { query: (text: string, values?: unknown[]) => Promise<unknown> }) {
  if (ready) return
  for (const text of bookingNotificationSchema) await sql.query(text)
  ready = true
}
