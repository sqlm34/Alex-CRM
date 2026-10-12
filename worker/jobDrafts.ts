type DraftSql = { query: (query: string, params?: any[]) => Promise<any> }

export async function ensureJobDrafts(sql: DraftSql) {
  await sql.query(`create table if not exists crm_job_drafts (
    id text not null, user_id text not null, payload jsonb not null,
    updated_at timestamptz not null default now(), primary key (user_id, id)
  )`)
}

export async function saveJobDraft(sql: DraftSql, userId: string, job: { id: string }) {
  await ensureJobDrafts(sql)
  await sql.query(`insert into crm_job_drafts (id, user_id, payload) values ($1, $2, $3::jsonb)
    on conflict (user_id, id) do update set payload = excluded.payload, updated_at = now()`,
  [job.id, userId, JSON.stringify(job)])
}

export async function listJobDrafts(sql: DraftSql, userId: string) {
  await ensureJobDrafts(sql)
  const rows = await sql.query('select payload from crm_job_drafts where user_id = $1 order by updated_at desc', [userId])
  return rows.map((row: { payload: unknown }) => row.payload)
}

export async function removeJobDraft(sql: DraftSql, userId: string, id: string) {
  await ensureJobDrafts(sql)
  await sql.query('delete from crm_job_drafts where user_id = $1 and id = $2', [userId, id])
}
