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
  `alter table parts_receipts add column if not exists history jsonb not null default '[]'::jsonb`,
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

export async function restoreReceipt(sql: ReturnType<typeof neon>, jobId: string, id: string, userId: string, attachmentId?: string) {
  const rows = await sql.query(`update parts_receipts set
    history=history || jsonb_build_array(jsonb_build_object('status',status,'data',data,'attachment_id',attachment_id,
      'confirmed_at',confirmed_at,'confirmed_by',confirmed_by,'voided_by',voided_by,'deleted_at',deleted_at,
      'restored_at',now(),'restored_by',$3::text)),
    status='draft', deleted_at=null, deleted_by=null, confirmed_at=null, confirmed_by=null, voided_by=null,
    attachment_id=coalesce($4::text,attachment_id), updated_at=now()
    where id=$1 and job_id=$2 and status='voided' and data is not null
    returning id,attachment_id,status,data,created_at,confirmed_at,history`, [id,jobId,userId,attachmentId || null])
  if (rows.length) return rows[0]
  const existing = await sql.query(`select id,attachment_id,status,data,created_at,confirmed_at,history from parts_receipts where id=$1 and job_id=$2 and status='draft' and deleted_at is null`, [id,jobId])
  return existing[0] || null
}
