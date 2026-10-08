import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'
import pg from 'pg'

const source = readFileSync(new URL('../worker/statisticsStorage.ts', import.meta.url), 'utf8')
const exports = {}
new Function('exports', ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(exports)

test('persisted statistics: backfill, invoice math, expense lifecycle, edits, concurrency and rollback', async () => {
  const schema = `statistics_test_${Date.now()}`
  const pool = new pg.Pool({ host: '127.0.0.1', port: Number(process.env.GOOGLE_ACTIONS_TEST_PORT || 55439), user: 'webhook_test', password: 'local-test-only', database: 'webhook_test', max: 6, options: `-c search_path=${schema}` })
  const query = (q, p) => pool.query(q, p)
  const report = async month => (await query('select report from crm_monthly_statistics where month=$1', [month + '-01'])).rows[0].report
  try {
    await query(`create schema ${schema}`)
    await query(`create table jobs(id text primary key, service_date date, status text, invoice numeric, finance_items jsonb default '[]', payments jsonb default '[]', booking_source text, booking_source_detail text);
      create table parts_receipts(id text primary key,job_id text references jobs(id),status text,data jsonb,deleted_at timestamptz)`)
    await query(`insert into jobs(id,service_date,status,invoice) values ('a','2026-09-04','complete',325),('b','2026-10-08','scheduled',100)`)
    const migrate = async () => {
      const client = await pool.connect()
      try { await client.query('begin'); for (const statement of exports.statisticsSchemaStatements) await client.query(statement); await client.query('commit') }
      catch(e) { await client.query('rollback'); throw e } finally { client.release() }
    }
    await migrate(); await migrate()
    assert.equal((await report('2026-09')).gross, 32500)
    await query(`insert into parts_receipts values ('r','a','draft','{"totalCents":1548}',null)`)
    assert.equal((await report('2026-09')).net, 32500)
    await query("update parts_receipts set status='confirmed' where id='r'")
    assert.equal((await report('2026-09')).net, 30952)
    assert.equal((await report('2026-09')).withoutReceipts, 0)
    await query("update parts_receipts set status='voided' where id='r'")
    assert.equal((await report('2026-09')).net, 32500)
    await query("update parts_receipts set status='confirmed',deleted_at=now() where id='r'")
    assert.equal((await report('2026-09')).parts, 0)
    await query("update parts_receipts set deleted_at=null where id='r'")
    await query(`update jobs set payments='[{"processingFeeCents":123,"status":"paid"},{"processingFeeCents":999,"status":"voided"}]',booking_source='google_maps' where id='a'`)
    assert.equal((await report('2026-09')).net, 30829)
    assert.deepEqual((await report('2026-09')).days, [{ day: 4, source: 'Google', count: 1 }])
    await query("update jobs set service_date='2026-10-04' where id='a'")
    assert.equal((await report('2026-09')).orders, 0)
    assert.equal((await report('2026-10')).net, 40829)
    await query("update jobs set status='canceled' where id='a'")
    assert.equal((await report('2026-10')).gross, 10000)
    await query("update jobs set status='complete' where id='a'")
    await Promise.all([query("update jobs set invoice=400 where id='a'"), query("update jobs set invoice=200 where id='b'")])
    assert.equal((await report('2026-10')).gross, 60000)
    await query(`update jobs set finance_items='[{"label":"Part","unitPriceCents":10000,"quantity":2,"discountCents":1000,"taxable":true,"taxRateBps":700}]' where id='b'`)
    assert.equal((await report('2026-10')).gross, 60330)
    const client = await pool.connect()
    try { await client.query('begin'); await client.query("update jobs set invoice=900 where id='a'"); await client.query('rollback') } finally { client.release() }
    assert.equal((await report('2026-10')).gross, 60330)
    await query("delete from jobs where id='b'")
    assert.equal((await report('2026-10')).gross, 40000)
    assert.equal((await query(`select crm_stat_invoice('[{"label":"Part","baseUnitPriceCents":10000,"pricingVersion":"base-plus-5-percent-30c-v1"}]',0) as value`)).rows[0].value, '10530')
    assert.equal((await query(`select crm_stat_invoice('[{"label":"Legacy","amount":50}]',0) as value`)).rows[0].value, '5000')
    const before = (await query('select updated_at from crm_monthly_statistics order by month')).rows
    await report('2026-09'); await report('2026-10')
    assert.deepEqual((await query('select updated_at from crm_monthly_statistics order by month')).rows, before)
  } finally { await query(`drop schema if exists ${schema} cascade`); await pool.end() }
})

test('statistics endpoint requires authenticated owner before reading reports', () => {
  const worker = readFileSync(new URL('../worker/index.ts', import.meta.url), 'utf8')
  const route = worker.slice(worker.indexOf("if (url.pathname === '/api/statistics'"), worker.indexOf("if (url.pathname === '/api/jobs' && request.method === 'GET')"))
  assert.match(route, /requireAuth\(request, sql\)/)
  assert.ok(route.indexOf('requireOwner(user)') < route.indexOf('readStatistics(sql)'))
})
