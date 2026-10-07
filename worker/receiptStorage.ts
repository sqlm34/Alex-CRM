import type { neon } from '@neondatabase/serverless'

export const receiptSchemaStatements = [
  `create table if not exists parts_receipts (
    id text primary key,
    job_id text not null references jobs(id),
    attachment_id text not null,
    content_hash text not null,
    status text not null check (status in ('processing','draft','confirmed','voided','failed')),
    data jsonb,
    created_by text not null,
    confirmed_by text,
    voided_by text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    confirmed_at timestamptz,
    unique(job_id, content_hash)
  )`,
  `alter table parts_receipts add column if not exists deleted_at timestamptz`,
  `alter table parts_receipts add column if not exists deleted_by text`,
  `create index if not exists parts_receipts_job_idx on parts_receipts(job_id, created_at)`,
  `create table if not exists receipt_ai_usage (
    user_id text not null, day date not null, calls integer not null default 0,
    primary key(user_id, day)
  )`,
]

// Match the application's existing additive schema initialization pattern.
let ready: Promise<void> | undefined
export async function ensureReceiptTables(sql: ReturnType<typeof neon>) {
  ready ??= (async () => { for (const statement of receiptSchemaStatements) await sql.query(statement) })().catch(error => {
    ready = undefined
    throw error
  })
  await ready
}
