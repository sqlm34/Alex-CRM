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
    {loading&&<p role="status">Loading…</p>}
    {!loading&&result?.error&&<p role="alert">{result.error}</p>}
    {data&&<>
      <p>Capture: {data.capture_enabled?'enabled':'disabled'} · Pending: {data.pending} · Failed: {data.failed} · Orders requiring review: {data.review}</p>
      {data.orders.map(order=><article className="owner-user-row" key={order.job_id}>
        <div className="owner-user-meta"><strong>Order {order.job_id}</strong>
          {order.review_reason&&<span>Financial review required ({order.review_reason}). Automatic delivery is paused for this order.</span>}
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
