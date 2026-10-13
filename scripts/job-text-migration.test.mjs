import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import ts from 'typescript'
import pg from 'pg'

test('Details migration preserves both originals, appends once and does not alter Description', async () => {
  const exports={}
  const source=readFileSync(new URL('../worker/jobTextMigration.ts',import.meta.url),'utf8').replace(/^import .*$/gm,'')
  new Function('exports',ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(exports)
  const schema=`text_test_${Date.now()}`
  const pool=new pg.Pool({host:'127.0.0.1',port:55439,user:'webhook_test',password:'local-test-only',database:'webhook_test',options:`-c search_path=${schema}`})
  try {
    await pool.query(`create schema ${schema}`)
    await pool.query('create table jobs(id text primary key,details text,job_text text,issue text)')
    await pool.query("insert into jobs values ('empty','Repair notes',null,'Customer issue'),('both','Replaced pump','Diagnosed fault','Customer issue'),('same','Same','Same','Customer issue'),('none',null,'Keep','Customer issue')")
    await pool.query(exports.jobTextMigrationSql)
    await pool.query(exports.jobTextMigrationSql)
    const rows=(await pool.query('select * from jobs order by id')).rows
    assert.equal(rows.find(r=>r.id==='both').job_text,'Diagnosed fault\n\nReplaced pump')
    assert.equal(rows.find(r=>r.id==='empty').job_text,'Repair notes')
    assert.equal(rows.find(r=>r.id==='same').job_text,'Same')
    assert.equal(rows.find(r=>r.id==='none').job_text,'Keep')
    assert.ok(rows.every(r=>r.issue==='Customer issue'))
    assert.equal((await pool.query('select * from job_details_text_backup')).rowCount,3)
    assert.equal(rows.find(r=>r.id==='both').details,'Replaced pump')
    await pool.query("update jobs set job_text='Edited after migration' where id='both'")
    await pool.query(exports.jobTextMigrationSql)
    assert.equal((await pool.query("select job_text from jobs where id='both'")).rows[0].job_text,'Edited after migration')
    await pool.query("insert into jobs values ('duplicate',null,'Customer description','Customer description'),('edited',null,'Customer description plus repair notes','Customer description'),('blank',null,null,'Customer description')")
    await pool.query(exports.duplicateJobTextCleanupSql)
    assert.equal((await pool.query("select job_text from jobs where id='duplicate'")).rows[0].job_text,'')
    assert.equal((await pool.query("select job_text from jobs where id='edited'")).rows[0].job_text,'Customer description plus repair notes')
    assert.equal((await pool.query("select original_job_text from job_description_duplicate_backup where job_id='duplicate'")).rows[0].original_job_text,'Customer description')
    await pool.query("update jobs set job_text='Customer description' where id='duplicate'")
    await pool.query(exports.duplicateJobTextCleanupSql)
    assert.equal((await pool.query("select job_text from jobs where id='duplicate'")).rows[0].job_text,'Customer description')
    assert.equal((await pool.query("select issue from jobs where id='duplicate'")).rows[0].issue,'Customer description')
    await pool.query("alter table jobs add column appliance text default 'Washer'")
    await pool.query("insert into jobs(id,details,job_text,issue) values ('autofill','Washer','Customer issue','Customer issue'),('realnotes','Replaced pump','Customer issue','Customer issue'),('lateredit','Washer','Customer issue','Customer issue')")
    await pool.query(exports.jobTextMigrationSql)
    await pool.query("update jobs set job_text=job_text || ' Technician notes' where id='lateredit'")
    await pool.query(exports.migratedDescriptionCleanupSql)
    await pool.query(exports.migratedDescriptionCleanupSql)
    assert.equal((await pool.query("select job_text from jobs where id='autofill'")).rows[0].job_text,'')
    assert.equal((await pool.query("select job_text from jobs where id='realnotes'")).rows[0].job_text,'Replaced pump')
    assert.match((await pool.query("select job_text from jobs where id='lateredit'")).rows[0].job_text,/Technician notes/)
    assert.equal((await pool.query('select * from job_migrated_description_backup')).rowCount,2)
  } finally {await pool.query(`drop schema if exists ${schema} cascade`);await pool.end()}
})
