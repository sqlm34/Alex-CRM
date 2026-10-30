import {previewHistory} from './nestwise-history.mjs';
import {dispatchNestwise,dispatchAllowed} from './nestwise-delivery.mjs';
export async function nestwiseAdmin(request, sql, user, env={}) {
  if (user?.role !== 'owner' || typeof user.id !== 'string') return {status:403,body:{error:'Owner access is required'}};
  const url=new URL(request.url),uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  try {
    if(request.method==='POST'&&url.pathname==='/api/nestwise/dispatch'){
      if(url.search)return {status:400,body:{error:'Dispatch accepts no parameters or body'}};
      // Some HTTP clients represent an empty POST as a zero-byte stream.
      if(request.body){
        const reader=request.body.getReader();
        try{while(true){const part=await reader.read();if(part.done)break;if(part.value.byteLength){await reader.cancel();return {status:400,body:{error:'Dispatch accepts no parameters or body'}};}}}
        finally{reader.releaseLock();}
      }
      if(!dispatchAllowed(env))
        return {status:409,body:{error:'Delivery window is closed'}};
      if(!env.NESTWISE_ENDPOINT||!env.NESTWISE_CONNECTION||!env.NESTWISE_KEY_ID||!env.NESTWISE_SIGNING_SECRET)
        return {status:409,body:{error:'Delivery is not configured'}};
      await dispatchNestwise(sql,env);
      const rows=await sql.query('select nestwise_integration.sync_status($1) as result',[null]);
      return {status:200,body:rows[0].result};
    }
    if(request.method==='GET'&&url.pathname==='/api/nestwise/source-review'){
      const job=url.searchParams.get('job');
      if(url.searchParams.size!==1||!job||!/^[A-Za-z0-9_.:-]{1,128}$/.test(job))return {status:400,body:{error:'Invalid order'}};
      const rows=await sql.query('select nestwise_integration.review_source($1) as result',[job]);
      return {status:rows[0]?.result?200:404,body:rows[0]?.result??{error:'Order not found'}};
    }
    if(request.method==='GET'&&['/api/nestwise/sync','/api/nestwise/history-preview'].includes(url.pathname)){
      const before=url.searchParams.get('after');
      if([...url.searchParams.keys()].some(k=>k!=='after')||url.searchParams.getAll('after').length>1||before!==null&&!/^[A-Za-z0-9_.:-]{1,128}$/.test(before))return {status:400,body:{error:'Invalid cursor'}};
      if(url.pathname==='/api/nestwise/history-preview')return {status:200,body:await previewHistory(sql,before)};
      const rows=await sql.query('select nestwise_integration.sync_status($1) as result',[before]);
      return {status:200,body:rows[0].result};
    }
    if(request.method==='POST'&&['/api/nestwise/retry','/api/nestwise/source-review','/api/nestwise/source-correction','/api/nestwise/customer-refund','/api/nestwise/lifecycle-review'].includes(url.pathname)&&!url.search){
      const refund=url.pathname.endsWith('/customer-refund');
      const lifecycle=url.pathname.endsWith('/lifecycle-review');
      const correction=url.pathname.endsWith('/source-correction');
      const review=url.pathname.endsWith('/source-review')||correction||lifecycle||refund;
      if(request.headers.get('content-type')?.split(';')[0]!=='application/json')return {status:415,body:{error:'JSON required'}};
      const reader=request.body?.getReader();if(!reader)return {status:400,body:{error:'Invalid retry'}};
      const chunks=[];let size=0;
      try {while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>(review?8192:1024)){await reader.cancel();return {status:413,body:{error:'Request too large'}};}chunks.push(part.value);}}
      finally {reader.releaseLock();}
      let input;
      try{const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}input=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{return {status:400,body:{error:'Invalid retry'}};}
      if(review){
        if(lifecycle){
          if(!input||Array.isArray(input)||Object.keys(input).sort().join(',')!=='action,change_id,command_id,evidence'
            ||!uuid.test(input.change_id??'')||!uuid.test(input.command_id??'')||!['finalize','reopen','void'].includes(input.action)
            ||typeof input.evidence!=='string'||input.evidence.trim().length<10||input.evidence.length>1000||/[\u0000-\u001f\u007f]/.test(input.evidence))return {status:400,body:{error:'Invalid lifecycle review'}};
          const rows=await sql.query('select nestwise_integration.confirm_lifecycle($1,$2,$3,$4,$5) as result',[input.command_id,input.change_id,user.id,input.action,input.evidence]);
          return {status:200,body:{id:rows[0].result}};
        }
        const date=typeof input?.paid_on==='string'?new Date(input.paid_on+'T00:00:00.000Z'):null;
        if(!input||Array.isArray(input)||Object.keys(input).sort().join(',')!=='change_id,command_id,evidence,paid_on'
          ||!uuid.test(input.change_id??'')||!uuid.test(input.command_id??'')||!date||!Number.isFinite(+date)
          ||date.toISOString().slice(0,10)!==input.paid_on||input.paid_on<'1900-01-01'||input.paid_on>'2199-12-31'
          ||typeof input.evidence!=='string'||input.evidence.trim().length<10||input.evidence.length>1000||/[\u0000-\u001f\u007f]/.test(input.evidence))return {status:400,body:{error:'Invalid source review'}};
        const query=refund?'select nestwise_integration.confirm_customer_refund($1,$2,$3,$4,$5) as result':correction?'select nestwise_integration.confirm_cost_correction($1,$2,$3,$4,$5) as result':'select nestwise_integration.confirm_source($1,$2,$3,$4,$5) as result';
        const rows=await sql.query(query,[input.command_id,input.change_id,user.id,input.paid_on,input.evidence]);
        return {status:200,body:{id:rows[0].result}};
      }
      if(!input||Array.isArray(input)||Object.keys(input).length!==2||!uuid.test(input.event_id??'')||!uuid.test(input.command_id??''))return {status:400,body:{error:'Invalid retry'}};
      await sql.query('select nestwise_integration.retry_delivery($1,$2,$3)',[input.event_id,input.command_id,user.id]);
      return {status:200,body:{ok:true}};
    }
    return {status:404,body:{error:'Not found'}};
  }catch(error){
    if(error?.message==='inventory_usage_is_not_cash_purchase')
      return {status:409,body:{error:'Stock usage is not a new payment. Link the original purchase in Nestwise; do not record a second cash expense.'}};
    const conflict=['retry_conflict','review_required','unknown_event','review_conflict','invalid_source_review','unsupported_source_review','invalid_customer_refund','unsupported_customer_refund','refund_command_conflict'].includes(error?.message);
    return {status:conflict?409:503,body:{error:conflict?'Event requires review or is not eligible for retry':'Sync status temporarily unavailable'}};
  }
}
