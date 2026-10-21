// Read-only preview. It never enables capture, approves a baseline or emits events.
export async function previewHistory(sql, after=null) {
  const jobs=await sql.query("select id,payments from public.jobs where status='complete' and ($1::text is null or id>$1) order by id limit 51",[after]);
  const page=jobs.slice(0,50),ids=page.map(j=>j.id);
  const offline=ids.length?await sql.query('select id::text,job_id,amount_cents::text,payment_date::text,status from public.offline_payments where job_id=any($1::text[]) order by job_id,id',[ids]):[];
  const receiptTable=(await sql.query("select to_regclass('public.parts_receipts') is not null as available",[]))[0]?.available===true;
  const receipts=ids.length&&receiptTable?await sql.query("select job_id,data->>'expenseCents' as expense_cents,data->>'totalCents' as total_cents,data->>'currency' as currency from public.parts_receipts where job_id=any($1::text[]) and status='confirmed' and deleted_at is null",[ids]):[];
  const money=v=>typeof v==='string'&&/^(0|[1-9][0-9]{0,15})$/.test(v)&&BigInt(v)<=9007199254740991n?BigInt(v):null;
  const orders=page.map(job=>{
    const issues=[],seen=new Set();let payments=0n,parts=0n;
    if(!Array.isArray(job.payments))issues.push('invalid_payment_list');
    for(const payment of Array.isArray(job.payments)?job.payments:[]){
      if(!payment||typeof payment.id!=='string'||seen.has(payment.id)){issues.push('invalid_or_duplicate_payment');continue;}seen.add(payment.id);
      if(payment.source!=='offline'){issues.push('payment_source_requires_review');continue;}
      const source=offline.find(p=>p.job_id===job.id&&p.id===payment.id),amount=source?money(source.amount_cents):null;
      if(!source||amount===null){issues.push('missing_payment_source');continue;}
      if(source.status!=='succeeded'||payment.status!=='succeeded'){issues.push('void_or_refund_requires_review');continue;}
      // Check materialization exactly without floating-point rounding.
      const decimal=String(payment.amount),match=/^(0|[1-9][0-9]*)(?:\.([0-9]{1,2}))?$/.exec(decimal);
      if(!match||BigInt(match[1])*100n+BigInt((match[2]||'').padEnd(2,'0'))!==amount){issues.push('payment_amount_mismatch');continue;}
      payments+=amount;
    }
    for(const source of offline.filter(p=>p.job_id===job.id&&p.status==='succeeded'))if(!seen.has(source.id))issues.push('unmaterialized_payment');
    for(const receipt of receipts.filter(r=>r.job_id===job.id)){
      const amount=money(receipt.expense_cents??receipt.total_cents);
      if(amount===null||receipt.currency!=='USD')issues.push('invalid_parts_cost');else parts+=amount;
      issues.push('parts_payment_date_requires_review');
    }
    if(!receiptTable)issues.push('parts_source_unavailable');
    // Old source data does not reliably distinguish voids from cash refunds.
    return {job_id:job.id,verified_offline_payments_cents:payments.toString(),confirmed_parts_evidence_cents:parts.toString(),refunds_cents:null,issues:[...new Set(issues)],imported:false};
  });
  const snapshot={orders,next:jobs.length>50?page.at(-1).id:null,scope:'page',dry_run:true,
    totals:{orders:orders.length,verified_offline_payments_cents:orders.reduce((s,o)=>s+BigInt(o.verified_offline_payments_cents),0n).toString(),confirmed_parts_evidence_cents:orders.reduce((s,o)=>s+BigInt(o.confirmed_parts_evidence_cents),0n).toString()},
    approval_required:true};
  const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(snapshot)));
  return {...snapshot,sha256:Array.from(new Uint8Array(hash),n=>n.toString(16).padStart(2,'0')).join('')};
}
