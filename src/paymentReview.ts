/** Missing ledger records are a reminder to verify, never a demand to charge again. */
export function paymentReview(status:string,invoice:number,recordedCents:string|undefined,refunded=false){
 if(status!=='complete'||!Number.isFinite(invoice)||invoice<=0)return null;
 if(refunded)return {kind:'refund',label:'Refund recorded — review payment',detail:'Проверьте возврат и оплату в Finance → Payments.'};
 if(recordedCents===undefined||!/^\d+$/.test(recordedCents))return null;
 const recorded=BigInt(recordedCents),due=BigInt(Math.round(invoice*100));
 if(recorded===0n)return {kind:'missing',label:'Payment not recorded — check',detail:'Оплата не внесена — проверить. Если клиент уже заплатил, внесите платёж в Finance → Payments.'};
 if(recorded<due)return {kind:'partial',label:'Partial payment — check balance',detail:'Частичная оплата — проверьте остаток в Finance → Payments.'};
 return null;
}
