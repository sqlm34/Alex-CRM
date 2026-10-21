import {useEffect,useRef,useState} from 'react'
import {nestwiseRequest} from './api'

type Event={id:string;revision:number;status:'pending'|'leased'|'acked'|'dlq';attempts:number;receiver_status:string|null}
type Order={job_id:string;review_reason:string|null;events:Event[]}
type Status={capture_enabled:boolean;pending:number;failed:number;review:number;orders:Order[]}
function parseStatus(value:unknown):Status{
  if(!value||typeof value!=='object')throw Error('Invalid status')
  const s=value as Status
  if(typeof s.capture_enabled!=='boolean'||![s.pending,s.failed,s.review].every(n=>Number.isSafeInteger(n)&&n>=0)||!Array.isArray(s.orders)||s.orders.length>50)throw Error('Invalid status')
  for(const order of s.orders){
    if(typeof order.job_id!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(order.job_id)||order.review_reason!==null&&typeof order.review_reason!=='string'||!Array.isArray(order.events)||order.events.length>10)throw Error('Invalid order')
    for(const event of order.events)if(typeof event.id!=='string'||!/^[0-9a-f-]{36}$/i.test(event.id)||!['pending','leased','acked','dlq'].includes(event.status)||!Number.isSafeInteger(event.revision)||event.revision<1||!Number.isSafeInteger(event.attempts)||event.attempts<0)throw Error('Invalid event')
  }
  return s
}
const labels={pending:'Pending',leased:'Sending',acked:'Received by Nestwise',dlq:'Failed'}
export function NestwiseSync({token}:{token:string}){
  const [reviewJob,setReviewJob]=useState<string|null>(null)
  const [history,setHistory]=useState(false)
  const [request,setRequest]=useState<{after:string|null;version:number}|null>(null)
  const [result,setResult]=useState<{request:typeof request;data:Status|null;error:string}|null>(null)
  const [retry,setRetry]=useState<{event_id:string;command_id:string}|null>(null),[sending,setSending]=useState(false),[retryError,setRetryError]=useState('')
  const alive=useRef(true),inFlight=useRef(false)
  useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[])
  useEffect(()=>{
    if(!request)return
    const controller=new AbortController();let active=true
    void nestwiseRequest(token,'sync'+(request.after?'?after='+encodeURIComponent(request.after):''),undefined,controller.signal)
      .then(value=>{if(active)setResult({request,data:parseStatus(value),error:''})})
      .catch(()=>{if(active)setResult({request,data:null,error:'Could not load synchronization. Check that the staging integration is configured.'})})
    return()=>{active=false;controller.abort()}
  },[token,request])
  const loading=!!request&&result?.request!==request,data=loading?null:result?.data
  const refresh=(after:string|null=null)=>setRequest(current=>({after,version:(current?.version??0)+1}))
  async function confirmRetry(){
    if(!retry||inFlight.current)return
    inFlight.current=true;setSending(true);setRetryError('')
    try{await nestwiseRequest(token,'retry',retry);if(alive.current){setRetry(null);refresh(request?.after)}}
    catch{if(alive.current)setRetryError('Retry was not confirmed. Check status or repeat this same request.')}
    finally{inFlight.current=false;if(alive.current)setSending(false)}
  }
  return <section className="owner-panel" aria-label="Nestwise synchronization">
    <h3>Nestwise synchronization</h3>
    <p>Delivery confirmation means Nestwise received the event. An event may still require accounting review.</p>
    <button className="secondary-action" type="button" disabled={loading||sending} onClick={()=>refresh()}>Refresh synchronization</button>
    <button className="secondary-action" type="button" onClick={()=>setHistory(v=>!v)}>{history?'Hide history preview':'Preview historical import'}</button>
    {history&&<HistoryPreview token={token}/>}
    {reviewJob&&<SourceReview key={reviewJob} token={token} job={reviewJob} onDone={()=>{setReviewJob(null);refresh()}}/>}
    {loading&&<p role="status">Loading…</p>}
    {!loading&&result?.error&&<p role="alert">{result.error}</p>}
    {data&&<>
      <p>Capture: {data.capture_enabled?'enabled':'disabled'} · Pending: {data.pending} · Failed: {data.failed} · Orders requiring review: {data.review}</p>
      {data.orders.map(order=><article className="owner-user-row" key={order.job_id}>
        <div className="owner-user-meta"><strong>Order {order.job_id}</strong>
          {order.review_reason&&<span>Financial review required ({order.review_reason}). Automatic delivery is paused for this order.</span>}
          {order.review_reason&&<button className="mini-action" type="button" disabled={!!reviewJob} onClick={()=>setReviewJob(order.job_id)}>Inspect source evidence</button>}
          {order.events.map(event=><div key={event.id}><span>Revision {event.revision}: {labels[event.status]} · Attempts: {event.attempts}{event.receiver_status==='needs_review'?' · Review required in Nestwise':''}</span>
            {event.status==='dlq'&&!order.review_reason&&<button className="mini-action" type="button" disabled={sending||!!retry} onClick={()=>{setRetry({event_id:event.id,command_id:crypto.randomUUID()});setRetryError('')}}>Retry delivery</button>}
          </div>)}
        </div>
      </article>)}
      {data.orders.length===50&&<button className="secondary-action" type="button" disabled={loading||sending} onClick={()=>refresh(data.orders.at(-1)!.job_id)}>More orders</button>}
    </>}
    {retry&&<div role="group" aria-label="Confirm retry"><p>Retry delivery of the same event? Its identity and financial data will remain unchanged.</p>
      {!!retryError&&<p role="alert">{retryError}</p>}
      <button className="primary-action" type="button" disabled={sending} onClick={()=>void confirmRetry()}>Confirm retry</button>
      <button className="secondary-action" type="button" disabled={sending||!!retryError} onClick={()=>setRetry(null)}>Cancel</button>
    </div>}
  </section>
}

type SourceEvidence={job_id:string;reason:string|null;change:null|{id:string;kind:string;source_id:string;before:Record<string,unknown>;after:Record<string,unknown>;captured_at:string};reviews:{id:string;actor:string;paid_on:string;evidence:string;created_at:string}[];corrections?:{id:string;actor:string;paid_on:string;evidence:string;created_at:string}[];lifecycle_reviews?:{id:string;actor:string;action:string;evidence:string;created_at:string}[]}
function SourceReview({token,job,onDone}:{token:string;job:string;onDone:()=>void}){
  const [data,setData]=useState<SourceEvidence|null>(null),[error,setError]=useState('')
  const [paid,setPaid]=useState(''),[evidence,setEvidence]=useState(''),[confirmed,setConfirmed]=useState(false)
  const [command,setCommand]=useState<{command_id:string;change_id:string;paid_on:string;evidence:string}|null>(null)
  const [busy,setBusy]=useState(false),[saved,setSaved]=useState(false)
  const [lifecyclePending,setLifecyclePending]=useState(false)
  const active=useRef(true),lock=useRef(false)
  useEffect(()=>{
    active.current=true;const controller=new AbortController()
    void nestwiseRequest(token,'source-review?job='+encodeURIComponent(job),undefined,controller.signal).then(value=>{
      const v=value as SourceEvidence
      if(!v||v.job_id!==job||!Array.isArray(v.reviews)||v.reviews.length>50||v.change&&(!/^[0-9a-f-]{36}$/i.test(v.change.id)||!v.change.after||!v.change.before))throw Error('Invalid source')
      if(active.current)setData(v)
    }).catch(()=>{if(active.current)setError('Could not load captured source evidence.')})
    return()=>{active.current=false;controller.abort()}
  },[token,job])
  const eligible=data?.reason==='source_requires_review'&&['stripe_attempt','parts_receipt'].includes(data.change?.kind??'')
  const correction=data?.change?.kind==='parts_receipt'&&data.change.before.status==='confirmed'
  async function submit(){
    if(lock.current||!data?.change||!confirmed)return
    const payload=command??{command_id:crypto.randomUUID(),change_id:data.change.id,paid_on:paid,evidence}
    setCommand(payload);lock.current=true;setBusy(true);setError('')
    try{
      const result=await nestwiseRequest(token,correction?'source-correction':'source-review',payload) as {id?:string}
      if(result.id!==payload.command_id)throw Error('Unconfirmed result')
      if(active.current)setSaved(true)
    }catch(cause){if(active.current){
      const status=typeof cause==='object'&&cause!==null&&'status' in cause?cause.status:null
      if([400,403,404,409].includes(Number(status))){setCommand(null);setConfirmed(false);setError('Source confirmation was rejected. Close this review and inspect the current evidence before trying again.')}
      else setError('Response not confirmed. Retry this same command; it cannot create a second posting.')
    }}
    finally{lock.current=false;if(active.current)setBusy(false)}
  }
  return <section aria-label="Review captured source"><h4>Order {job}: source evidence</h4>
    {!!error&&<p role="alert">{error}</p>}
    {!data&&!error&&<p role="status">Loading evidence…</p>}
    {data?.change&&<><p>{data.change.kind} · {data.change.source_id} · Captured {data.change.captured_at}</p>
      <details><summary>Captured data before and after the change</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify({before:data.change.before,after:data.change.after},null,2)}</pre></details></>}
    {eligible&&!saved&&<>
      <p>{correction?'Correct a previously recorded parts amount only when the original payment was recorded incorrectly. This preserves the original payment date and appends the difference; it is not a new purchase or supplier refund. Changed originals and unsupported changes remain blocked.':'Only an initial confirmed source can be released here. Review the original payment or receipt first. This records a financial event; it does not charge a customer or transfer money.'}</p>
      <label>{correction?'Original payment date (UTC)':'Actual payment date (UTC)'}<input type="date" min="1900-01-01" max="2199-12-31" value={paid} disabled={!!command} onChange={e=>setPaid(e.target.value)}/></label>
      <label>Evidence reference and reason (no card or customer details)<textarea value={evidence} maxLength={1000} disabled={!!command} onChange={e=>setEvidence(e.target.value)}/></label>
      <label><input type="checkbox" checked={confirmed} disabled={!!command} onChange={e=>setConfirmed(e.target.checked)}/>{correction?'I verified the corrected total against the same original receipt and payment. No new payment or refund occurred; the original amount was entered incorrectly.':'I verified the captured amount and actual payment date. For Stripe, the captured processing fee was also paid on this date. This source has not been separately entered in Nestwise.'}</label>
      <button className="primary-action" type="button" disabled={busy||!confirmed||!paid||evidence.trim().length<10} onClick={()=>void submit()}>{command?'Retry same confirmation':correction?'Confirm corrected amount':'Confirm source and queue financial events'}</button>
    </>}
    {data?.reason==='order_lifecycle_requires_review'&&data.change&&<LifecycleReview key={data.change.id} token={token} change={data.change} onPending={setLifecyclePending} onDone={onDone}/>}
    {data&&!eligible&&data.reason!=='order_lifecycle_requires_review'&&<p>This source needs a correction or historical review workflow. It cannot be released by supplying a payment date.</p>}
    {saved&&<p role="status">Confirmation saved. Events are queued with stable identities; delivery still depends on the configured dispatcher.</p>}
    {data?.reviews.map(review=><p key={review.id}>Confirmed {review.created_at} by {review.actor} · Paid {review.paid_on} · {review.evidence}</p>)}
    {data?.corrections?.map(review=><p key={review.id}>Amount corrected {review.created_at} by {review.actor} · Original payment {review.paid_on} · {review.evidence}</p>)}
    {data?.lifecycle_reviews?.map(review=><p key={review.id}>Order {review.action} · {review.created_at} by {review.actor} · {review.evidence}</p>)}
    <button className="secondary-action" type="button" disabled={busy||lifecyclePending||!!command&&!saved} onClick={onDone}>Close source review</button>
  </section>
}

function LifecycleReview({token,change,onPending,onDone}:{token:string;change:NonNullable<SourceEvidence['change']>;onPending:(pending:boolean)=>void;onDone:()=>void}){
  const action=change.after.status==='complete'?'finalize':change.after.status==='canceled'?'void':change.before.status==='complete'?'reopen':null
  const [evidence,setEvidence]=useState(''),[confirmed,setConfirmed]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false),[saved,setSaved]=useState(false)
  const [command,setCommand]=useState<{command_id:string;change_id:string;action:string;evidence:string}|null>(null)
  const active=useRef(true),lock=useRef(false)
  useEffect(()=>{active.current=true;return()=>{active.current=false}},[])
  async function submit(){
    if(!action||!confirmed||lock.current)return
    const payload=command??{command_id:crypto.randomUUID(),change_id:change.id,action,evidence}
    setCommand(payload);lock.current=true;setBusy(true);setError('');onPending(true)
    try{
      const result=await nestwiseRequest(token,'lifecycle-review',payload) as {id?:string}
      if(result.id!==payload.command_id)throw Error('Unconfirmed response')
      if(active.current){setSaved(true);onPending(false)}
    }catch(cause){if(active.current){
      const status=typeof cause==='object'&&cause!==null&&'status' in cause?Number(cause.status):0
      if([400,403,404,409].includes(status)){setCommand(null);setConfirmed(false);onPending(false);setError('Transition rejected. Reload the source evidence; combined payment changes and cancellation with financial balances remain blocked.')}
      else setError('Response not confirmed. Retry the same command to avoid duplicate events.')
    }}finally{lock.current=false;if(active.current)setBusy(false)}
  }
  if(!action)return <p>This status change cannot be confirmed through the lifecycle workflow.</p>
  return <section aria-label="Review financial order status">
    <p>Confirm order action: {action}. This appends a status assertion without posting income or expenses. Completion checks existing journal totals; it does not approve tax treatment. Cancellation requires every financial balance to be zero.</p>
    {!!error&&<p role="alert">{error}</p>}
    {saved?<><p role="status">Status assertion queued. Receiver validation remains required.</p><button type="button" onClick={onDone}>Refresh sync status</button></>:<>
      <label>Evidence and reason<textarea value={evidence} maxLength={1000} disabled={!!command} onChange={e=>setEvidence(e.target.value)}/></label>
      <label><input type="checkbox" checked={confirmed} disabled={!!command} onChange={e=>setConfirmed(e.target.checked)}/>I reviewed the captured transition and financial sources for this order.</label>
      <button type="button" disabled={busy||!confirmed||evidence.trim().length<10} onClick={()=>void submit()}>{command?'Retry same status confirmation':'Confirm order status'}</button>
    </>}
  </section>
}

type History={orders:{job_id:string;verified_offline_payments_cents:string;confirmed_parts_evidence_cents:string;refunds_cents:null;issues:string[]}[];next:string|null;dry_run:true;sha256:string}
function HistoryPreview({token}:{token:string}){
  const [request,setRequest]=useState<{after:string|null;version:number}>({after:null,version:0})
  const [result,setResult]=useState<{request:typeof request;data:History|null;error:boolean}|null>(null)
  useEffect(()=>{
    const controller=new AbortController();let active=true
    void nestwiseRequest(token,'history-preview'+(request.after?'?after='+encodeURIComponent(request.after):''),undefined,controller.signal).then(value=>{
      const data=value as History
      if(!data||data.dry_run!==true||!Array.isArray(data.orders)||data.orders.length>50||!Array.isArray(data.orders[0]?.issues??[])||! /^[0-9a-f]{64}$/.test(data.sha256))throw Error('Invalid preview')
      if(active)setResult({request,data,error:false})
    }).catch(()=>{if(active)setResult({request,data:null,error:true})})
    return()=>{active=false;controller.abort()}
  },[token,request])
  const busy=result?.request!==request,data=busy?null:result?.data
  return <section aria-label="Historical import preview"><h4>Historical import — preview only</h4>
    <p>No orders are imported. Amounts below cover this page only. Parts evidence requires payment-date review; refunds are unknown until reviewed.</p>
    {busy&&<p role="status">Loading preview…</p>}
    {!busy&&result?.error&&<p role="alert">Could not load historical preview.</p>}
    {data&&<>{data.orders.map(order=><article key={order.job_id}><strong>Order {order.job_id}</strong>
      <p>Verified offline payments: {order.verified_offline_payments_cents} cents · Confirmed parts evidence: {order.confirmed_parts_evidence_cents} cents · Refunds: not verified</p>
      {order.issues.map(issue=><p key={issue}>{issue.replaceAll('_',' ')}</p>)}
    </article>)}<p style={{overflowWrap:'anywhere'}}>Preview SHA-256: {data.sha256}</p></>}
    <button className="secondary-action" type="button" disabled={busy} onClick={()=>setRequest(v=>({after:null,version:v.version+1}))}>Refresh from start</button>
    {data?.next&&<button className="secondary-action" type="button" disabled={busy} onClick={()=>setRequest(v=>({after:data.next,version:v.version+1}))}>Next page</button>}
  </section>
}
