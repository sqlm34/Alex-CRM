import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'
import { PGlite } from '@electric-sql/pglite'

const source = readFileSync(new URL('../worker/statisticsStorage.ts', import.meta.url), 'utf8')
const exported = {}
new Function('exports', ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(exported)

test('missing receipt orders match statistics month/count and follow confirmation/deletion', async () => {
  const db = new PGlite()
  try {
    await db.exec(`create table jobs(id text primary key, customer text, appliance text, service_date date, status text, invoice numeric, finance_items jsonb default '[]', payments jsonb default '[]', booking_source text, booking_source_detail text);
      create table parts_receipts(id text primary key,job_id text references jobs(id),status text,data jsonb,deleted_at timestamptz);
      insert into jobs(id,customer,appliance,service_date,status,invoice) values
      ('missing','One','Washer','2026-10-01','complete',200),('draft','Two','Dryer','2026-10-31','scheduled',300),
      ('confirmed','Three','Range','2026-10-15','complete',100),('deleted','Four','Fridge','2026-10-20','complete',400),
      ('canceled','Five','Washer','2026-10-21','canceled',100),('previous','Six','Dryer','2026-09-30','complete',100),
      ('next','Seven','Dryer','2026-11-01','complete',100);
      insert into parts_receipts values('r1','draft','draft','{}',null),('r2','confirmed','confirmed','{}',null),('r3','deleted','confirmed','{}',now());`)
    await db.exec('BEGIN')
    for (const statement of exported.statisticsSchemaStatements) await db.exec(statement)
    await db.exec('COMMIT')
    const sql = { query: async (q,p) => (await db.query(q,p)).rows }
    const list = await exported.readOrdersWithoutReceipts(sql,'2026-10')
    assert.deepEqual(list.orders.map(o=>o.id),['draft','deleted','missing'])
    assert.equal(list.orders[0].service_date,'2026-10-31')
    const report = (await db.query("select report from crm_monthly_statistics where month='2026-10-01'")).rows[0].report
    assert.equal(list.orders.length,report.withoutReceipts)
    await db.query("update parts_receipts set status='confirmed' where id='r1'")
    assert.deepEqual((await exported.readOrdersWithoutReceipts(sql,'2026-10')).orders.map(o=>o.id),['deleted','missing'])
    await assert.rejects(exported.readOrdersWithoutReceipts(sql,'2026-13'),/Invalid statistics month/)
    await assert.rejects(exported.readOrdersWithoutReceipts(sql,"2026-10' OR true"),/Invalid statistics month/)
  } finally { await db.close() }
})
