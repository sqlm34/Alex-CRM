begin;
-- VIP is optional and was never enabled in production.
create or replace function receptionist_delete_conversation(target text, owner_actor text)
returns boolean language plpgsql as $$
declare saved receptionist_calls%rowtype;
begin
  select * into saved from receptionist_calls where id=target for update;
  if not found then return exists(select 1 from receptionist_deleted_calls where call_id=target); end if;
  if saved.ended_at is null then raise exception 'Call is still active'; end if;
  insert into receptionist_deleted_calls(call_id) values(target) on conflict do nothing;
  delete from receptionist_notifications where call_id=target;
  delete from receptionist_events where call_id=target;
  delete from receptionist_callbacks where call_id=target;
  if to_regclass('receptionist_vip_attempts') is not null then
    delete from receptionist_vip_attempts where call_id=target;
  end if;
  update receptionist_web_capacity set session_id=null,lease_until=now()
    where session_id in (select id from receptionist_web_sessions where provider_call_id=saved.provider_call_id);
  delete from receptionist_web_sessions where provider_call_id=saved.provider_call_id;
  delete from receptionist_calls where id=target;
  insert into receptionist_audit(action,actor_id) values('conversation_deleted',owner_actor);
  return true;
end $$;
revoke execute on function receptionist_delete_conversation(text,text) from public;
commit;
