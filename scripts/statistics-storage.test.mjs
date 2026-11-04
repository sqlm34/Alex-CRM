import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'
import pg from 'pg'

const source = readFileSync(new URL('../worker/statisticsStorage.ts', import.meta.url), 'utf8')
const exports = {}
new Function('exports', ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(exports)

test('monthly call conversion counts each ended call once and uses Indianapolis date', async () => {
  const schema = `acquisition_test_${Date.now()}`
  const pool = new pg.Pool({ host: '127.0.0.1', port: Number(process.env.GOOGLE_ACTIONS_TEST_PORT || 55439), user: 'webhook_test', password: 'local-test-only', database: 'webhook_test', options: `-c search_path=${schema}` })
  try {
    await pool.query(`create schema ${schema}`)
    await pool.query(`create table receptionist_calls(provider_call_id text,started_at timestamptz,ended_at timestamptz,job_id text,outcome text);
      create table receptionist_web_sessions(provider_call_id text);
      create table jobs(created_at timestamptz,booking_source text,booking_source_detail text,status text);
      insert into receptionist_calls values
      ('a','2026-11-01T03:59:59Z',now(),'job','booked'),
      ('b','2026-11-01T04:00:00Z',now(),null,'ended'),
      ('c','2026-11-02T15:00:00Z',null,null,'in_progress'),
      ('d','2026-11-02T15:00:00Z',now(),null,'booked');
      insert into receptionist_web_sessions values ('b'),('b');
      insert into jobs values ('2026-11-01T03:59:59Z','website',null,'scheduled'),
      ('2026-11-01T04:00:00Z','website','voice_assistant','scheduled'),
      ('2026-11-01T04:00:00Z',null,null,'canceled')`)
    const result = await exports.readAcquisitionStatistics({query: async (text,args) => (await pool.query(text,args)).rows})
    assert.deepEqual(result.calls, [
      {month:'2026-11',source:'Phone Emily',total:1,booked:1,unbooked:0},
      {month:'2026-11',source:'Website voice',total:1,booked:0,unbooked:1},
      {month:'2026-10',source:'Phone Emily',total:1,booked:1,unbooked:0},
    ])
    assert.deepEqual(result.orders, [
      {month:'2026-11',source:'Website voice',orders:1},
      {month:'2026-10',source:'Website form',orders:1},
    ])
  } finally { await pool.query(`drop schema if exists ${schema} cascade`); await pool.end() }
})

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
    await query(`update parts_receipts set data='{"totalCents":4060,"expenseCents":1015}',status='confirmed',deleted_at=null where id='r'`)
    assert.equal((await report('2026-10')).parts, 1015)
    await query(`update parts_receipts set status='voided' where id='r'`)
    assert.equal((await report('2026-10')).parts, 0)
    const before = (await query('select updated_at from crm_monthly_statistics order by month')).rows
    await report('2026-09'); await report('2026-10')
    assert.deepEqual((await query('select updated_at from crm_monthly_statistics order by month')).rows, before)
    // One November visit, two payments in different Indianapolis calendar months.
    await query(`insert into jobs(id,service_date,status,invoice,payments) values
      ('cash','2026-11-02','complete',300,'[
        {"id":"oct","amount":100,"createdAt":"2026-10-30T16:00:00Z","status":"paid"},
        {"id":"nov","amount":200,"createdAt":"2026-11-02T16:00:00Z","status":"succeeded","processingFeeCents":500},
        {"amount":999,"createdAt":"2026-11-02T16:00:00Z","status":"pending"},
        {"amount":999,"createdAt":"2026-11-02T16:00:00Z","voidedAt":"2026-11-03T16:00:00Z"}
      ]')`)
    assert.equal((await report('2026-10')).received,10000)
    assert.equal((await report('2026-11')).received,20000)
    assert.equal((await report('2026-11')).receivedNet,19500)
    await query("update jobs set service_date='2026-12-03',status='canceled' where id='cash'")
    assert.equal((await report('2026-10')).received,0)
    assert.equal((await report('2026-11')).received,0)
    assert.equal((await report('2026-11')).awaitingCompletion,20000)
    await query("update jobs set status='complete' where id='cash'")
    assert.equal((await report('2026-11')).received,20000)
    assert.equal((await report('2026-12')).received,0)
    const dates = (await query(`select
      crm_stat_payment_date('{"createdAt":"2026-11-01T03:59:59Z"}','cash')::text as october,
      crm_stat_payment_date('{"createdAt":"2026-11-01T04:00:00Z"}','cash')::text as november,
      crm_stat_payment_date('{"createdAt":"bad"}','cash') as invalid`)).rows[0]
    assert.deepEqual(dates,{october:'2026-10-31',november:'2026-11-01',invalid:null})
    await query(`create table offline_payments(id text,job_id text,created_at timestamptz,payment_date date);
      insert into offline_payments values ('audit','cash','2026-11-04T16:00:00Z','2026-10-30')`)
    assert.equal((await query(`select crm_stat_payment_date('{"id":"audit","source":"offline","createdAt":"2026-11-02T16:00:00Z"}','cash')::text as date`)).rows[0].date,'2026-10-30')
    await query(`update jobs set payments='[]' where id='cash'`)
    assert.equal((await report('2026-10')).received,0)
    assert.equal((await report('2026-11')).received,0)
    await query('alter table jobs add column customer text, add column appliance text')
    for (const [id, items] of [
      ['diagnostic', [{label:' Service   Call ',amount:89}]],
      ['mixed', [{label:'Service call',amount:89},{label:'Parts',amount:200}]],
      ['same-price', [{label:'Parts',amount:89}]],
      ['empty', []], ['unknown', null], ['malformed', [null]],
    ]) await query(`insert into jobs(id,service_date,status,invoice,finance_items)
      values($1,'2027-01-04','complete',89,$2)`,[id,JSON.stringify(items)])
    const sql = {query: async (text,args) => (await query(text,args)).rows}
    let missing = await exports.readOrdersWithoutReceipts(sql,'2027-01')
    assert.deepEqual(missing.orders.map(row=>row.id).sort(),['empty','malformed','mixed','same-price','unknown'])
    assert.equal((await report('2027-01')).withoutReceipts,missing.orders.length)
    await query(`update jobs set finance_items=finance_items || '[{"label":"Parts","amount":200}]'::jsonb where id='diagnostic'`)
    assert.equal((await report('2027-01')).withoutReceipts,6)
    missing = await exports.readOrdersWithoutReceipts(sql,'2027-01')
    assert.equal(missing.orders.length,6)
    await query(`update jobs set finance_items='[{"label":"Service call","amount":89}]' where id='diagnostic'`)
    assert.equal((await report('2027-01')).withoutReceipts,5)
    assert.equal((await query(`select crm_stat_invoice('[{"label":"Parts","baseUnitPriceCents":20000,"pricingVersion":"base-only-v1"}]',0) as value`)).rows[0].value,'20000')
  } finally { await query(`drop schema if exists ${schema} cascade`); await pool.end() }
})

test('statistics endpoint requires authenticated owner before reading reports', () => {
  const worker = readFileSync(new URL('../worker/index.ts', import.meta.url), 'utf8')
  const route = worker.slice(worker.indexOf("if (['/api/statistics', '/api/statistics/missing-receipts']"), worker.indexOf("if (url.pathname === '/api/jobs' && request.method === 'GET')"))
  assert.match(route, /requireAuth\(request, sql\)/)
  assert.ok(route.indexOf('requireOwner(user)') >= 0)
  assert.ok(route.indexOf('requireOwner(user)') < route.indexOf('readStatistics(sql)'))
  assert.ok(route.indexOf('requireOwner(user)') < route.indexOf('readOrdersWithoutReceipts(sql, month)'))
})
