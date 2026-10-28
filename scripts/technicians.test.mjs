import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import ts from 'typescript'
import {PGlite} from '@electric-sql/pglite'
const mod={exports:{}}
new Function('exports',ts.transpileModule(readFileSync('worker/technicians.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText)(mod.exports)
test('technician removal preserves jobs, revokes sessions, hides account, protects owner; defaults only new unassigned jobs',async()=>{
  const db=new PGlite()
  try{
    await db.exec(`create table users(id text primary key,email text unique,name text,role text,created_at timestamptz default now(),updated_at timestamptz default now());
      create table approved_users(email text primary key,role text,invited_by_user_id text);
      create table auth_sessions(id text,user_id text references users(id));
      create table jobs(id text primary key,created_by_user_id text references users(id));
      insert into users(id,email,name,role) values('owner','owner@example.test','Owner','owner'),('tech','tech@example.test','Test Tech','technician');
      insert into approved_users values('owner@example.test','owner',null),('tech@example.test','technician','owner');
      insert into auth_sessions values('session','tech');insert into jobs values('old','tech'),('old-unassigned',null);`)
    const sql={query:async(text,values)=>(await db.query(text,values)).rows}
    assert.equal((await mod.exports.removeTechnician(sql,'owner@example.test','owner')).length,0)
    assert.equal((await mod.exports.removeTechnician(sql,'tech@example.test','owner')).length,1)
    assert.equal((await db.query('select * from auth_sessions')).rows.length,0)
    assert.equal((await db.query("select name,role from users where id='tech'")).rows[0].role,'removed')
    assert.equal((await db.query("select created_by_user_id from jobs where id='old'")).rows[0].created_by_user_id,'tech')
    const migration=readFileSync('migrations/2026-10-22_default_job_owner.sql','utf8')
    await db.exec(migration);await db.exec(migration)
    await db.exec("insert into jobs values('web',null),('phone',null),('explicit','tech')")
    const rows=(await db.query('select * from jobs order by id')).rows
    assert.equal(rows.find(r=>r.id==='web').created_by_user_id,'owner')
    assert.equal(rows.find(r=>r.id==='phone').created_by_user_id,'owner')
    assert.equal(rows.find(r=>r.id==='explicit').created_by_user_id,'tech')
    assert.equal(rows.find(r=>r.id==='old-unassigned').created_by_user_id,null)
  }finally{await db.close()}
})
