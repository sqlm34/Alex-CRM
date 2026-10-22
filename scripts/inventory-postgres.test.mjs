import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import pg from 'pg'

const port=Number(process.env.GOOGLE_ACTIONS_TEST_PORT||0)
test('independent PostgreSQL connections cannot consume the same last inventory unit',{skip:!port},async()=>{
  const schema=`inventory_concurrency_${crypto.randomUUID().replaceAll('-','')}`
  const pool=new pg.Pool({host:'127.0.0.1',port,user:'webhook_test',password:'local-test-only',database:'webhook_test',max:4,options:`-c search_path=${schema}`})
  try{
    await pool.query(`create schema ${schema}`)
    await pool.query("create table jobs(id text primary key,status text); insert into jobs values('one','scheduled'),('two','scheduled')")
    await pool.query('create table parts_receipts(id text primary key,job_id text,attachment_id text,content_hash text,status text,data jsonb,created_by text,confirmed_by text,confirmed_at timestamptz,voided_by text,updated_at timestamptz)')
    await pool.query(readFileSync(new URL('../migrations/2026-10-22_parts_inventory.sql',import.meta.url),'utf8'))
    const partId=crypto.randomUUID()
    await pool.query("insert into inventory_parts(id,name,part_number,brand) values($1,'Pump','TEST','Test')",[partId])
    const move=p=>pool.query('select inventory_move($1::jsonb,$2)',[JSON.stringify({partId,...p}),'owner'])
    await move({requestId:crypto.randomUUID(),action:'stock_in',quantity:1,totalCents:4500,date:'2026-10-22',supplier:'Test'})
    const results=await Promise.allSettled(['one','two'].map(jobId=>move({requestId:crypto.randomUUID(),action:'stock_out',quantity:1,jobId})))
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1)
    assert.match(results.find(r=>r.status==='rejected').reason.message,/Not enough stock/)
    assert.equal((await pool.query('select remaining from inventory_batches')).rows[0].remaining,0)
    assert.equal((await pool.query('select count(*)::int as count from inventory_job_usage')).rows[0].count,1)
    assert.equal((await pool.query('select count(*)::int as count from parts_receipts')).rows[0].count,1)
    const replay={requestId:crypto.randomUUID(),action:'stock_in',quantity:2,totalCents:2138,date:'2026-10-22',supplier:'Test'}
    await Promise.all([move(replay),move(replay)])
    assert.equal(Number((await pool.query('select sum(remaining) as quantity from inventory_batches')).rows[0].quantity),2)
  }finally{
    await pool.query(`drop schema if exists ${schema} cascade`)
    await pool.end()
  }
})
