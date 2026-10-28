type Sql = { query: (text:string, values?:unknown[]) => Promise<Record<string,unknown>[]> }

// Keep users and job foreign keys intact; removal only revokes access and selection.
export async function removeTechnician(sql:Sql,email:string,ownerId:string) {
  return sql.query(`with target as (
    select email from approved_users where email=$1 and role <> 'owner'
    union select email from users where email=$1 and role <> 'owner' and id <> $2
  ), eligible as (
    select email from target where not exists(select 1 from users where email=$1 and (role='owner' or id=$2))
      and not exists(select 1 from approved_users where email=$1 and role='owner')
  ), approval as (
    insert into approved_users(email,role,invited_by_user_id)
    select email,'removed',$2 from eligible
    on conflict(email) do update set role='removed' returning email
  ), retired as (
    update users set role='removed',updated_at=now() where email in(select email from approval) returning id
  ), sessions as (
    delete from auth_sessions where user_id in(select id from retired)
  ) select email from approval`,[email,ownerId])
}
