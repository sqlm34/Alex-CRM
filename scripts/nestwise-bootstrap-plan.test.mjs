import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {bootstrapPlan} from './nestwise-bootstrap-plan.mjs';

test('atomic bootstrap builds actual schemas owned only by isolated CRM role',async()=>{
  const plan=await bootstrapPlan(),db=new PGlite();
  try{
    await assert.rejects(db.exec(plan),/Wrong database/);
    await db.exec('ROLLBACK');
    await db.exec('CREATE ROLE alex_crm_nestwise_worker NOINHERIT; GRANT CREATE ON SCHEMA public TO alex_crm_nestwise_worker');
    // PGlite database name only; the emitted deployment plan retains its guard.
    const local=plan.replaceAll('alex_crm_nestwise_staging','postgres');
    await db.exec(local);
    assert.equal((await db.query('SELECT count(*)::int n FROM crm_staging_migrations')).rows[0].n,11);
    assert.equal((await db.query('SELECT capture_enabled FROM nestwise_integration.configuration')).rows[0].capture_enabled,false);
    assert.equal((await db.query("SELECT count(*)::int n FROM pg_tables WHERE schemaname IN ('public','nestwise_integration') AND tableowner<>'alex_crm_nestwise_worker'")).rows[0].n,0);
    assert.equal((await db.query("SELECT count(*)::int n FROM pg_auth_members WHERE roleid=(SELECT oid FROM pg_roles WHERE rolname='alex_crm_nestwise_worker')")).rows[0].n,0);
    assert.equal((await db.query("SELECT has_database_privilege('alex_crm_nestwise_worker','postgres','CREATE') AS allowed")).rows[0].allowed,false);
    await assert.rejects(db.exec(local),/Database is not empty/);
    await db.exec('ROLLBACK');
    assert.equal((await db.query('SELECT count(*)::int n FROM crm_staging_migrations')).rows[0].n,11);
  }finally{await db.close();}
});
