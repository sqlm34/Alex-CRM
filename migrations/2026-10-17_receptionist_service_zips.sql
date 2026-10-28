-- STAGED ONLY. Apply after owner approves production publication.
begin;
lock table receptionist_settings in exclusive mode;
create table if not exists receptionist_area_backups (
  release text primary key,
  settings jsonb not null,
  revision bigint not null,
  saved_at timestamptz not null default now()
);
insert into receptionist_area_backups(release,settings,revision)
select 'service-zips-23',settings,revision from receptionist_settings where singleton=true
on conflict(release) do nothing;
with proposed as (
 select singleton, settings || jsonb_build_object(
  'serviceZips', (select jsonb_agg(zip order by zip) from (
    select distinct jsonb_array_elements_text(coalesce(settings->'serviceZips','[]'::jsonb) ||
    '["46032","46033","46037","46038","46040","46052","46055","46060","46062","46069","46074","46075","46077","46220","46236","46240","46250","46256","46260","46268","46278","46280","46290"]'::jsonb) zip
  ) z),
  'zipCoverage', '{"46032":"full","46033":"full","46037":"full","46038":"full","46040":"full","46052":"manual","46055":"full","46060":"full","46062":"full","46069":"manual","46074":"full","46075":"manual","46077":"full","46220":"partial","46236":"partial","46240":"partial","46250":"partial","46256":"partial","46260":"partial","46268":"partial","46278":"partial","46280":"partial","46290":"partial"}'::jsonb || coalesce(settings->'zipCoverage','{}'::jsonb),
  'northIndianapolis', jsonb_build_object(
    'primaryZips', coalesce(settings#>'{northIndianapolis,primaryZips}','["46240","46250","46260","46268"]'::jsonb),
    'candidateZips', (select jsonb_agg(zip order by zip) from (
      select distinct jsonb_array_elements_text(coalesce(settings#>'{northIndianapolis,candidateZips}','[]'::jsonb) || '["46220","46236","46256","46278","46280","46290"]'::jsonb) zip
    ) c where not coalesce(settings#>'{northIndianapolis,primaryZips}','["46240","46250","46260","46268"]'::jsonb) ? zip)
  )
 ) updated from receptionist_settings where singleton=true
)
update receptionist_settings s set settings=p.updated,revision=s.revision+1,updated_at=now()
from proposed p where s.singleton=p.singleton and s.settings is distinct from p.updated;
commit;
