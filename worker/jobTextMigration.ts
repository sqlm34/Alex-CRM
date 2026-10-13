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
  await sql.query(duplicateJobTextCleanupSql)
  await sql.query(migratedDescriptionCleanupSql)
}

export const duplicateJobTextCleanupSql = `
  do $$ begin
    perform pg_advisory_xact_lock(731026111);
    create table if not exists job_description_duplicate_backup (
      job_id text primary key, original_job_text text not null,
      original_issue text not null, cleaned_at timestamptz not null default now()
    );
    with candidates as materialized (
      select j.id, j.job_text, j.issue from jobs j
      where coalesce(btrim(j.issue),'') <> '' and btrim(j.job_text) = btrim(j.issue)
        and not exists (select 1 from job_description_duplicate_backup b where b.job_id = j.id)
      for update of j
    ), backed_up as (
      insert into job_description_duplicate_backup(job_id, original_job_text, original_issue)
      select id, job_text, issue from candidates returning job_id
    )
    update jobs j set job_text = '' from backed_up b where j.id = b.job_id;
  end $$;
`

// Only rewrite the exact historical merge, never technician edits made afterwards.
export const migratedDescriptionCleanupSql = `
  do $$ begin
    perform pg_advisory_xact_lock(731026112);
    create table if not exists job_migrated_description_backup (
      job_id text primary key, original_job_text text not null,
      replacement_job_text text not null, cleaned_at timestamptz not null default now()
    );
    with candidates as materialized (
      select j.id, j.job_text,
        case when btrim(coalesce(b.original_details,'')) in ('', btrim(j.appliance), btrim(j.issue))
          then '' else b.original_details end as replacement
      from jobs j join job_details_text_backup b on b.job_id = j.id
      where coalesce(btrim(j.issue),'') <> ''
        and btrim(b.original_job_text) = btrim(j.issue)
        and j.job_text = b.merged_job_text
        and not exists (select 1 from job_migrated_description_backup c where c.job_id = j.id)
      for update of j
    ), backed_up as (
      insert into job_migrated_description_backup(job_id, original_job_text, replacement_job_text)
      select id, job_text, replacement from candidates returning job_id, replacement_job_text
    )
    update jobs j set job_text = b.replacement_job_text from backed_up b where j.id = b.job_id;
  end $$;
`
