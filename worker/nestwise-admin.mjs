import {previewHistory} from './nestwise-history.mjs';
export async function nestwiseAdmin(request, sql, user) {
  if (user?.role !== 'owner' || typeof user.id !== 'string') return {status:403,body:{error:'Owner access is required'}};
  const url=new URL(request.url),uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  try {
    if(request.method==='GET'&&['/api/nestwise/sync','/api/nestwise/history-preview'].includes(url.pathname)){
      const before=url.searchParams.get('after');
      if([...url.searchParams.keys()].some(k=>k!=='after')||url.searchParams.getAll('after').length>1||before!==null&&!/^[A-Za-z0-9_.:-]{1,128}$/.test(before))return {status:400,body:{error:'Invalid cursor'}};
      if(url.pathname==='/api/nestwise/history-preview')return {status:200,body:await previewHistory(sql,before)};
      const rows=await sql.query('select nestwise_integration.sync_status($1) as result',[before]);
      return {status:200,body:rows[0].result};
    }
    if(request.method==='POST'&&url.pathname==='/api/nestwise/retry'&&!url.search){
      if(request.headers.get('content-type')?.split(';')[0]!=='application/json')return {status:415,body:{error:'JSON required'}};
      const reader=request.body?.getReader();if(!reader)return {status:400,body:{error:'Invalid retry'}};
      const chunks=[];let size=0;
      try {while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>1024){await reader.cancel();return {status:413,body:{error:'Request too large'}};}chunks.push(part.value);}}
      finally {reader.releaseLock();}
      let input;
      try{const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}input=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{return {status:400,body:{error:'Invalid retry'}};}
      if(!input||Array.isArray(input)||Object.keys(input).length!==2||!uuid.test(input.event_id??'')||!uuid.test(input.command_id??''))return {status:400,body:{error:'Invalid retry'}};
      await sql.query('select nestwise_integration.retry_delivery($1,$2,$3)',[input.event_id,input.command_id,user.id]);
      return {status:200,body:{ok:true}};
    }
    return {status:404,body:{error:'Not found'}};
  }catch(error){
    const conflict=['retry_conflict','review_required','unknown_event'].includes(error?.message);
    return {status:conflict?409:503,body:{error:conflict?'Event requires review or is not eligible for retry':'Sync status temporarily unavailable'}};
  }
}
