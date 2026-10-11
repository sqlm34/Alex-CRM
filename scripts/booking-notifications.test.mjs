import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'
import { PGlite } from '@electric-sql/pglite'

const files=['shared/serviceWindows.ts','shared/bookingCalendar.ts','worker/bookingNotificationSchema.ts','worker/bookingNotifications.ts','worker/googleActionsConfig.ts','worker/bookingPersistence.ts']
const source=files.map(f=>readFileSync(new URL(`../${f}`,import.meta.url),'utf8').replace(/^import .*$/gm,'')).join('\n')
const mod={}
new Function('exports',ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText)(mod)
const {bookingNotificationSchema:schema,deliverBookingNotification:deliver,customerBookingEmail:email,bookingTimes,googleBookingCalendarUrl,bookingCalendarFile}=mod
const env={RESEND_API_KEY:'synthetic',INVOICE_FROM_EMAIL:'Alex <service@example.com>'}
const makeJob=(id='synthetic')=>({id,customer:'Test <Customer>',email:'test@example.com',address:'100 Test St, Carmel, IN',appliance:'Washer repair',service_date:'2099-10-15',service_window:'9:00 AM - 11:00 AM',status:'scheduled'})

test('calendar links, actual service windows, timezone and safe ICS text',()=>{
  const j={...makeJob(),service_window:'11:00 AM - 1:00 PM; 1:00 PM - 3:00 PM',address:'A,B;C\nBEGIN:VEVENT'}
  assert.deepEqual(bookingTimes(j),{start:'2099-10-15T11:00:00',end:'2099-10-15T15:00:00'})
  const url=new URL(googleBookingCalendarUrl(j))
  assert.equal(url.searchParams.get('ctz'),'America/Indiana/Indianapolis')
  assert.equal(url.searchParams.get('dates'),'20991015T110000/20991015T150000')
  const ics=bookingCalendarFile(j)
  assert.match(ics,/TRIGGER:-PT24H/)
  assert.match(ics,/LOCATION:A\\,B\\;C\\nBEGIN:VEVENT/)
  assert.equal(ics.match(/\r\nBEGIN:VEVENT/g).length,1)
  assert.match(email(j,'confirmation',env.INVOICE_FROM_EMAIL).html,/Test &lt;Customer&gt;/)
  assert.match(email(j,'confirmation',env.INVOICE_FROM_EMAIL).text,/before heading/)
  assert.doesNotMatch(email({...j,status:'new'},'confirmation',env.INVOICE_FROM_EMAIL).text,/Save to Google Calendar/)
})

test('PostgreSQL outbox: only enrolled bookings, reminders, retries, cancellation, deletion, rescheduling and DST',async()=>{
  const db=new PGlite()
  const query=(s,v)=>db.query(s,v)
  const client={query}
  const sent=[]
  const request=async(url,options)=>{ assert.equal(url,'https://api.resend.com/emails');sent.push(JSON.parse(options.body));return Response.json({id:'test-provider-id'}) }
  try {
    await db.exec(`create table jobs(id text primary key,customer text,email text,address text,appliance text,service_date date,service_window text,status text);
      insert into jobs values ('old','Old','old@example.com','old','Washer','2099-01-01','9:00 AM - 11:00 AM','scheduled')`)
    for(const s of schema) await query(s)
    assert.equal((await query('select count(*)::int n from booking_notification_subscriptions')).rows[0].n,0)
    await query("update jobs set status='canceled' where id='old'")
    assert.equal((await query('select count(*)::int n from booking_notification_outbox')).rows[0].n,0)
    const enroll=async(j)=>{
      await query('insert into jobs select * from jsonb_populate_record(null::jobs,$1::jsonb)',[JSON.stringify(j)])
      await query('insert into booking_notification_subscriptions(job_id) values($1)',[j.id])
      await query("select queue_booking_notifications(to_jsonb(j),'confirmation') from jobs j where id=$1",[j.id])
    }
    const pending=async(id,kind)=>(await query('select * from booking_notification_outbox where job_id=$1 and kind=$2 and suppressed_at is null order by id desc',[id,kind])).rows[0]
    await enroll(makeJob())
    const c=await pending('synthetic','confirmation')
    assert.equal(await deliver(client,env,c.id,request),true)
    assert.equal(await deliver(client,env,c.id,request),false)
    assert.equal(sent.length,1)
    const r=await pending('synthetic','reminder')
    assert.equal(new Date(r.due_at).toISOString(),'2099-10-14T13:00:00.000Z')
    await query("update jobs set service_date='2099-12-15' where id='synthetic'")
    assert.equal(await deliver(client,env,r.id,request),false)
    assert.equal(new Date((await pending('synthetic','reminder')).due_at).toISOString(),'2099-12-14T14:00:00.000Z')
    await query("update jobs set status='canceled' where id='synthetic'")
    assert.equal(await pending('synthetic','reminder'),undefined)
    assert.equal(await deliver(client,env,(await pending('synthetic','cancellation')).id,request),true)
    await enroll(makeJob('deleted'))
    const beforeDelete=await pending('deleted','confirmation')
    await query("delete from jobs where id='deleted'")
    assert.equal(await deliver(client,env,beforeDelete.id,request),false)
    assert.equal(await deliver(client,env,(await pending('deleted','cancellation')).id,request),true)
    await enroll(makeJob('retry'))
    const retry=await pending('retry','confirmation')
    assert.equal(await deliver(client,env,retry.id,async()=>new Response('',{status:429})),false)
    const failed=await pending('retry','confirmation')
    assert.equal(failed.attempts,1)
    assert.equal(failed.sent_at,null)
    await query("update booking_notification_outbox set next_attempt_at=now()-interval '1 minute' where id=$1",[retry.id])
    assert.equal(await deliver(client,env,retry.id,request),true)
    await enroll({...makeJob('review'),status:'new'})
    assert.equal(await pending('review','reminder'),undefined)
    assert.equal(await pending('review','calendar'),undefined)
    await query("update jobs set status='scheduled' where id='review'")
    assert.ok(await pending('review','reminder'))
    await query("update jobs set status='complete' where id='review'")
    assert.equal(await pending('review','reminder'),undefined)
    await enroll(makeJob('soon'))
    // A schedule within 24h produces an update, not an immediate duplicate reminder.
    await query("update jobs set service_date=(now() at time zone 'America/Indiana/Indianapolis')::date,service_window='11:00 PM - 11:30 PM' where id='soon'")
    assert.equal(await pending('soon','reminder'),undefined)
    await enroll(makeJob('due'))
    const due=await pending('due','reminder')
    await query("update booking_notification_outbox set due_at=now()-interval '1 minute' where id=$1",[due.id])
    assert.equal(await deliver(client,env,due.id,request),true)
    assert.match(sent.at(-1).subject,/Reminder/)
    // A late worker never sends a visit reminder for an already past appointment.
    await enroll(makeJob('past'))
    await query("update jobs set service_date='2020-01-01' where id='past'")
    assert.equal(await pending('past','reminder'),undefined)
  } finally {await db.close()}
})

test('Google Calendar uses a stable event ID, sends updates/cancellation and never runs without credentials',async()=>{
  const configured={...env,BOOKING_CALENDAR_ID:'test@example.com',BOOKING_CALENDAR_CLIENT_ID:'test',BOOKING_CALENDAR_CLIENT_SECRET:'test',BOOKING_CALENDAR_REFRESH_TOKEN:'test'}
  const calls=[]
  const mock=async(url,options={})=>{calls.push({url,...options});if(url.includes('oauth2'))return Response.json({access_token:'synthetic'});if(!options.method)return new Response('',{status:404});return Response.json({id:'synthetic'})}
  await assert.rejects(mod.syncBookingCalendar(env,makeJob(),mock),/connection required/)
  assert.equal(calls.length,0)
  const id=await mod.syncBookingCalendar(configured,makeJob(),mock)
  assert.match(id,/^[a-f0-9]{64}$/)
  assert.ok(calls.at(-1).url.endsWith('sendUpdates=all'))
  assert.equal(JSON.parse(calls.at(-1).body).start.timeZone,'America/Indiana/Indianapolis')
  const savedEvent=JSON.parse(calls.at(-1).body)
  let writes=0
  const retryMock=async(url,options={})=>{
    if(url.includes('oauth2'))return Response.json({access_token:'synthetic'})
    if(!options.method)return Response.json(savedEvent)
    writes++
    return Response.json({id})
  }
  await mod.syncBookingCalendar(configured,makeJob(),retryMock)
  assert.equal(writes,0,'retry must not send a duplicate calendar invitation')
  await mod.syncBookingCalendar(configured,{...makeJob(),address:'200 Changed St'},retryMock)
  assert.equal(writes,1,'changed appointments must update the invitation')
  await mod.syncBookingCalendar(configured,{...makeJob(),status:'canceled'},mock)
  assert.equal(calls.at(-1).method,'DELETE')
  assert.ok(calls.at(-1).url.includes(id))
})

test('actual booking statements atomically enroll once and roll back with the booking',async()=>{
  const db=new PGlite()
  try {
    await db.exec(`create table jobs(id text primary key,customer text,phone text,email text,address text,appliance text,issue text,
      details text,job_text text,service_date date,service_window text,status text,invoice numeric,paid boolean,finance_items jsonb,
      payments jsonb,model_photo_attachments jsonb,lat numeric,lng numeric,created_by_user_id text,booking_source text);
      create table booking_sessions(id text primary key,job_id text,created_at timestamptz default now(),updated_at timestamptz default now());
      create table booking_requests(request_id text primary key,session_id text unique,payload_hash text,job_id text);
      create table booking_risk_events(id text primary key,session_id text,job_id text,event text,risk_score int,decision text,reasons jsonb);
      create table availability_blocks(blocked_date date,all_day boolean,service_window text)`)
    for(const s of schema) await db.query(s)
    const enabled={CUSTOMER_BOOKING_EMAIL_ENABLED:'true'}
    const r={requestId:'r',sessionId:'s',payloadHash:'hash'}
    await db.query("insert into booking_sessions(id) values('s'),('rollback')")
    const run=async(receipt,job,fail=false)=>{
      await db.exec('begin')
      try {
        for(const s of mod.bookingPersistenceStatements(receipt,job,enabled,null)) await db.query(s.text,s.values)
        if(fail) throw Error('rollback test')
        await db.exec('commit')
      } catch(e) {await db.exec('rollback');throw e}
    }
    await run(r,makeJob('atomic'))
    await run(r,makeJob('atomic'))
    assert.equal((await db.query('select count(*)::int n from booking_notification_subscriptions')).rows[0].n,1)
    assert.equal((await db.query('select count(*)::int n from booking_notification_outbox')).rows[0].n,3)
    await assert.rejects(run({requestId:'rollback',sessionId:'rollback',payloadHash:'hash'},
      {...makeJob('rollback'),service_date:'2099-10-16'},true),/rollback test/)
    assert.equal((await db.query('select count(*)::int n from jobs')).rows[0].n,1)
    assert.equal((await db.query('select count(*)::int n from booking_notification_outbox')).rows[0].n,3)
  } finally {await db.close()}
})
