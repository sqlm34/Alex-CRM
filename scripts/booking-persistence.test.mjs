import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'
import pg from 'pg'

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')
const exports = {}
new Function('exports', ts.transpileModule(read('../worker/googleActionsConfig.ts') + '\n' +
  read('../worker/bookingPersistence.ts').replace(/^import .*$/m, ''), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText)(exports)
const { bookingPersistenceStatements: statements, bookingPayloadHash: hash } = exports
const env = { GOOGLE_ACTIONS_CENTER_ENABLED: 'true', GOOGLE_ACTIONS_CENTER_ENV: 'sandbox',
  GOOGLE_ACTIONS_CENTER_DEPLOYMENT_ENV: 'test', GOOGLE_ACTIONS_CENTER_PARTNER_ID: '123456789',
  GOOGLE_ACTIONS_CENTER_MERCHANT_ID: 'synthetic-merchant' }

test('booking hash is stable, ignores transport noise and includes business fields/photo content', async () => {
  const payload = { customer: 'Synthetic', issue: 'test', phone: '555', service_date: '2026-09-20' }
  assert.equal(await hash(payload, []), await hash({ started_at: 123, ...payload }, []))
  assert.notEqual(await hash(payload, []), await hash({ ...payload, issue: 'different' }, []))
  assert.notEqual(await hash(payload, [{ content: 'YQ==' }]), await hash(payload, [{ content: 'Yg==' }]))
})

test('real PostgreSQL booking transaction: concurrency, receipt conflict, atomic outbox and rollback', async () => {
  const schema = `booking_test_${Date.now()}`
  const pool = new pg.Pool({ host: '127.0.0.1', port: Number(process.env.GOOGLE_ACTIONS_TEST_PORT || 5432),
    user: 'webhook_test', password: 'local-test-only', database: 'webhook_test', max: 8,
    options: `-c search_path=${schema}` })
  const query = async (text, values) => (await pool.query(text, values)).rows
  let created = false
  try {
    assert.deepEqual((await query('select current_database() as db,current_user as username'))[0], { db:'webhook_test',username:'webhook_test' })
    await query(`create schema ${schema}`); created = true
    await query(`create table jobs(id text primary key,customer text,phone text,email text,address text,appliance text,issue text,
      details text,job_text text,service_date date,service_window text,status text,invoice numeric,paid boolean,finance_items jsonb,
      payments jsonb,model_photo_attachments jsonb,lat numeric,lng numeric,created_by_user_id text,booking_source text);
      create table booking_sessions(id text primary key,job_id text,created_at timestamptz default now(),updated_at timestamptz default now());
      create table booking_risk_events(id text primary key,session_id text,job_id text,event text,risk_score int,decision text,reasons jsonb);
      create table availability_blocks(blocked_date date,all_day boolean,service_window text)`)
    for (const path of ['../migrations/2026-09-09_add_google_actions_center.sql','../migrations/2026-09-09_add_booking_requests.sql']) {
      const sql = read(path).replaceAll('public.', `${schema}.`)
      await query(sql); await query(sql)
    }
    const attribution = crypto.randomUUID()
    await query(`insert into google_actions_attributions(id,capture_key,environment,deployment,partner_id,merchant_id,rwg_token,captured_at,expires_at)
      values($1,$1,'sandbox','test','123456789','synthetic-merchant','SYNTHETIC',now(),now()+interval '2592000 seconds')`,[attribution])
    const session = async () => { const id=crypto.randomUUID(); await query('insert into booking_sessions(id) values($1)',[id]); return id }
    const receipt = async () => { const sessionId=await session(); return {requestId:sessionId,sessionId,payloadHash:await hash({customer:'Synthetic'},[])} }
    let next = 0
    const job = (date='2026-09-20') => ({id:`J-SYNTHETIC-${++next}`,customer:'Synthetic',phone:'555',service_date:date,
      service_window:'9:00 AM - 11:00 AM',status:'scheduled',invoice:0,paid:false,finance_items:[],payments:[],model_photo_attachments:[],booking_source:'website'})
    const run = async (r,j,options={}) => {
      for(let attempt=1;attempt<=3;attempt++) {
        const client=await pool.connect()
        try {
          await client.query('begin isolation level serializable')
          const results=[]
          for(const [i,s] of statements(r,j,options.env || env,options.token === undefined ? attribution : options.token).entries()) {
            results.push((await client.query(s.text,s.values)).rows)
            if(options.failAfter === i) throw Error('controlled test failure')
          }
          await client.query('commit')
          return results
        } catch(error) {
          await client.query('rollback')
          if(!['40001','40P01'].includes(error.code)||attempt===3) throw error
        } finally { client.release() }
      }
    }
    const r=await receipt()
    const concurrent=await Promise.all([run(r,job()),run(r,job())])
    assert.equal(concurrent.reduce((n,result)=>n+result[2].length,0),1)
    const original=concurrent[0].at(-1)[0].job
    assert.equal(concurrent[1].at(-1)[0].job.id,original.id)
    assert.equal((await query('select count(*)::int as n from jobs'))[0].n,1)
    assert.equal((await query('select count(*)::int as n from google_actions_conversions'))[0].n,1)
    assert.equal(original.booking_source_detail,'actions_center')
    assert.equal((await run(r,job()))[2].length,0)
    const changed=await run({...r,payloadHash:'b'.repeat(64)},job())
    assert.notEqual(changed.at(-1)[0].payload_hash,'b'.repeat(64))
    assert.equal(changed[2].length,0)
    const foreign=await run({...r,sessionId:await session()},job())
    assert.equal(foreign[2].length,0)
    const count=async table=>(await query(`select count(*)::int as n from ${table}`))[0].n
    for(const failAfter of [1,2,3,4,5]) {
      const failing=await receipt(), before=await count('booking_requests')
      await assert.rejects(run(failing,job('2026-09-21'),{failAfter}),/controlled test failure/)
      assert.equal(await count('booking_requests'),before)
      assert.equal(await count('jobs'),1)
      assert.equal(await count('google_actions_conversions'),1)
    }
    const competing=await Promise.all([run(await receipt(),job('2026-09-22')),run(await receipt(),job('2026-09-22'))])
    assert.equal(competing.reduce((n,result)=>n+result[2].length,0),1)
    const ordinary=await run(await receipt(),job('2026-09-23'),{env:{...env,GOOGLE_ACTIONS_CENTER_ENABLED:'false'}})
    assert.equal(ordinary.at(-1)[0].job.booking_source,'website')
    assert.equal(await count('google_actions_conversions'),2)
    const noToken=await run(await receipt(),job('2026-09-24'),{token:null})
    assert.equal(noToken.at(-1)[0].job.booking_source_detail,null)
    await query(`update google_actions_attributions set captured_at=now()-interval '744 hours',expires_at=now()-interval '24 hours'`)
    const expired=await run(await receipt(),job('2026-09-25'))
    assert.equal(expired.at(-1)[0].job.booking_source_detail,null)
    assert.equal(await count('google_actions_conversions'),2)
  } finally {
    try { if(created) await query(`drop schema ${schema} cascade`) } finally { await pool.end() }
  }
})
