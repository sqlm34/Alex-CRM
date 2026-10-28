import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {PGlite} from '@electric-sql/pglite'

test('invoice guard: historical invoices, formatting, atomic multiline imports and rollback',async()=>{
  const db=new PGlite()
  try{
    await db.exec('create table inventory_batches(supplier text,invoice_number text); insert into inventory_batches values (\'Amazon\',\'111-222-333\')')
    const migration=readFileSync('migrations/2026-10-23_inventory_invoice_guard.sql','utf8')
    await db.exec(migration)
    await db.exec(migration)
    const insert=(supplier,number)=>db.query('insert into inventory_batches values($1,$2)',[supplier,number])
    await assert.rejects(insert(' amazon ','111222333'),/already been added/)
    await insert('Amazon','123-4567890-1234567')
    await assert.rejects(insert('AMAZON','123 4567890 1234567'),/already been added/)
    await insert('Reliable','123-4567890-1234567')
    await insert('Amazon','')
    await insert('Amazon','')
    await db.transaction(async tx=>{
      await tx.query("insert into inventory_batches values('Amazon','MULTI-1')")
      await tx.query("insert into inventory_batches values('Amazon','MULTI-1')")
    })
    await assert.rejects(insert('Amazon','MULTI-1'),/already been added/)
    await assert.rejects(db.transaction(async tx=>{
      await tx.query("insert into inventory_batches values('Amazon','ROLLBACK-1')")
      await tx.query("insert into inventory_batches values('Amazon','MULTI-1')")
    }),/already been added/)
    await insert('Amazon','ROLLBACK-1')
    assert.equal((await db.query("select count(*)::int as n from inventory_batches where invoice_number='MULTI-1'")).rows[0].n,2)
  }finally{await db.close()}
})
