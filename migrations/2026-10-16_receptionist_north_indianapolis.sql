-- STAGED ONLY: owner approval required before production application.
-- Merge ZIPs without replacing existing areas, routing, fees or enable flags.
-- Screenshot approval supersedes the earlier unverified 75th Street draft.
begin;
with proposed as (
  select singleton, (settings - 'indianapolisBoundary') || jsonb_build_object(
    'northIndianapolis', '{"primaryZips":["46240","46250","46260","46268"],"candidateZips":["46220","46278","46280","46290"]}'::jsonb,
    'serviceZips', (select jsonb_agg(zip order by zip) from (
      select distinct jsonb_array_elements_text(coalesce(settings->'serviceZips','[]'::jsonb) ||
        '["46032","46033","46037","46038","46040","46074","46060","46062","46055","46077","46240","46250","46260","46268","46220","46278","46280","46290"]'::jsonb) as zip
    ) z)
  ) as updated
  from receptionist_settings
  where singleton=true and settings->'northIndianapolis' is distinct from
    '{"primaryZips":["46240","46250","46260","46268"],"candidateZips":["46220","46278","46280","46290"]}'::jsonb
)
update receptionist_settings s set settings=p.updated,revision=s.revision+1,updated_at=now()
from proposed p where s.singleton=p.singleton;
commit;
