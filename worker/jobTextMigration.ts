import type { neon } from '@neondatabase/serverless'

export const jobTextMigrationSql = `
  do $$ begin
    perform pg_advisory_xact_lock(731026110);
    create table if not exists job_details_text_backup (
      job_id text primary key, original_details text, original_job_text text,
      merged_job_text text not null, migrated_at timestamptz not null default now()
    );
    with candidates as materialized (
      select j.id, j.details, j.job_text,
        case when coalesce(btrim(j.job_text),'') = '' then j.details
          when btrim(j.job_text) = btrim(j.details) then j.job_text
          else j.job_text || E'\\n\\n' || j.details end as merged
      from jobs j where coalesce(btrim(j.details),'') <> ''
        and not exists (select 1 from job_details_text_backup b where b.job_id=j.id)
      for update of j
    ), backed_up as (
      insert into job_details_text_backup(job_id,original_details,original_job_text,merged_job_text)
      select id,details,job_text,merged from candidates returning job_id,merged_job_text
    )
    update jobs j set job_text=b.merged_job_text from backed_up b where j.id=b.job_id;
  end $$;
`

export async function migrateJobDetails(sql: ReturnType<typeof neon>) {
  await sql.query(jobTextMigrationSql)
}
