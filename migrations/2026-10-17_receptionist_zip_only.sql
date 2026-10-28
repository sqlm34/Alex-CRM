-- Apply after the 23 ZIP import and approved coordinated API/agent rollout.
begin;
lock table receptionist_settings in exclusive mode;
insert into receptionist_area_backups(release,settings,revision)
select 'zip-only-23',settings,revision from receptionist_settings where singleton=true
on conflict(release) do nothing;
update receptionist_settings set settings=settings || jsonb_build_object('zipOnlyZips',
 '["46032","46033","46037","46038","46040","46052","46055","46060","46062","46069","46074","46075","46077","46220","46236","46240","46250","46256","46260","46268","46278","46280","46290"]'::jsonb),
 revision=revision+1,updated_at=now()
where singleton=true and settings->'zipOnlyZips' is distinct from
 '["46032","46033","46037","46038","46040","46052","46055","46060","46062","46069","46074","46075","46077","46220","46236","46240","46250","46256","46260","46268","46278","46280","46290"]'::jsonb;
commit;
