import { useRef, useState } from 'react'
import { Camera, ScanLine, Trash2 } from 'lucide-react'
import { inventoryCents, type InventoryPart, type InventoryInvoiceData } from '../shared/inventory'
import { inventoryRequest } from './inventoryApi'
import { inventoryPhoto } from './prepareInventoryPhoto'
import { hasNativePartsPhoto, pickPartsPhoto } from './partsPhoto'
type Line={name:string;partNumber:string;brand:string;quantity:number;amount:string}
export function InventoryInvoice({token,onImported,parts}:{token:string;onImported:()=>Promise<void>;parts:InventoryPart[]}) {
  const picker=useRef<HTMLInputElement>(null),camera=useRef<HTMLInputElement>(null),lock=useRef(false)
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[id,setId]=useState('')
  const [duplicate,setDuplicate]=useState<{name:string;partNumber:string;quantity:number;totalCents:number}[]|null>(null)
  const [lines,setLines]=useState<Line[]>([]),[supplier,setSupplier]=useState(''),[date,setDate]=useState(''),[invoice,setInvoice]=useState(''),[total,setTotal]=useState(''),[confirmed,setConfirmed]=useState(false)
  async function scan(file:File){
    if(lock.current)return;lock.current=true;setBusy(true);setError('')
    try{
      const blob=await inventoryPhoto(file,2400)
      const data=await inventoryRequest<{id:string;status:string;data:InventoryInvoiceData}>(token,'/scan',{method:'POST',headers:{'Content-Type':blob.type},body:blob})
      if(data.status==='imported')throw new Error('This invoice has already been imported. No stock was added.')
      if(data.data.currency!=='USD')throw new Error('Invoice currency must be verified as USD. No stock was added; enter the purchase manually in USD.')
      setId(data.id);setDuplicate(null);setSupplier(data.data.supplier);setDate(data.data.date);setTotal(data.data.totalCents===null?'':(data.data.totalCents/100).toFixed(2));setConfirmed(false)
      setInvoice(data.data.invoiceNumber||'')
      const sum=data.data.items.reduce((n,l)=>n+(l.amountCents||0),0)
      let cumulative=0,allocated=0
      setLines(data.data.items.map(l=>{
        cumulative+=l.amountCents||0
        const target=sum&&data.data.totalCents!==null?Math.round(cumulative/sum*data.data.totalCents):0
        const cents=target-allocated;allocated=target
        return {name:l.description,partNumber:l.partNumber,brand:l.brand||'',quantity:l.quantity||0,amount:sum?(cents/100).toFixed(2):''}
      }))
    }catch(e){setError(e instanceof Error?e.message:'Invoice scan failed')}
    finally{lock.current=false;setBusy(false);if(picker.current)picker.current.value='';if(camera.current)camera.current.value=''}
  }
  async function choose(source:'camera'|'gallery'){
    if(!hasNativePartsPhoto()){(source==='camera'?camera:picker).current?.click();return}
    try{const file=await pickPartsPhoto(source);if(file)await scan(file)}catch(e){setError(e instanceof Error?e.message:'Photo unavailable')}
  }
  async function save(allowDuplicate=false){
    if(lock.current||!confirmed)return;lock.current=true;setBusy(true);setError('')
    try{const result=await inventoryRequest<{duplicate?:boolean;reviewedLines?:NonNullable<typeof duplicate>}>(token,`/imports/${id}/confirm`,{method:'POST',body:JSON.stringify({confirmed:true,allowDuplicate,totalCents:inventoryCents(total),lines:lines.map(l=>({...l,totalCents:inventoryCents(l.amount),supplier,date,invoiceNumber:invoice}))})});if(result.duplicate){setDuplicate(result.reviewedLines||[]);return}setId('');setDuplicate(null);await onImported()}
    catch(e){setError(e instanceof Error?e.message:'Unable to import')}
    finally{lock.current=false;setBusy(false)}
  }
  const duplicateNotice=duplicate&&<aside role="alert"><h3>Possible Duplicate Invoice</h3><details><summary>View previous purchase</summary>{duplicate.map((line,index)=><p key={index}>{line.name} · {line.partNumber} · {line.quantity} units · ${(line.totalCents/100).toFixed(2)}</p>)}</details><button type="button" disabled={busy||!confirmed} onClick={()=>{if(window.confirm('This appears to be an existing invoice. Confirm that this is a separate new purchase?'))void save(true)}}>Confirm Separate New Purchase</button></aside>
  return <section className="inventory-invoice"><div className="inventory-filters"><button type="button" disabled={busy} onClick={()=>void choose('gallery')}><ScanLine size={18}/>{busy?'Processing...':'AI Scan Invoice'}</button><button type="button" disabled={busy} title="Photograph invoice" aria-label="Photograph invoice" onClick={()=>void choose('camera')}><Camera size={18}/></button></div><input ref={picker} type="file" hidden accept="image/jpeg,image/png,image/webp,image/heic,image/heif" onChange={e=>{const file=e.target.files?.[0];if(file)void scan(file)}}/><input ref={camera} type="file" capture="environment" hidden accept="image/*" onChange={e=>{const file=e.target.files?.[0];if(file)void scan(file)}}/>{error&&<p role="alert">{error}</p>}
    {duplicateNotice}{id&&<form onChange={()=>{setConfirmed(false);setDuplicate(null)}} onSubmit={e=>{e.preventDefault();void save()}}><h2>Review Scanned Invoice</h2><label>Supplier<input required list="inventory-supplier-options" value={supplier} maxLength={200} onChange={e=>setSupplier(e.target.value)}/></label><label>Purchase date<input required type="date" value={date} onChange={e=>setDate(e.target.value)}/></label><label>Invoice number<input value={invoice} maxLength={100} onChange={e=>setInvoice(e.target.value)}/></label><label>Total allocated to inventory, including tax / shipping ($)<input required inputMode="decimal" value={total} onChange={e=>setTotal(e.target.value)}/></label>
      {lines.map((line,index)=><fieldset key={index}><legend>Item {index+1}</legend><label>Match existing part<select value="" onChange={e=>{const part=parts.find(p=>p.id===e.target.value);if(part)setLines(current=>current.map((item,i)=>i===index?{...item,name:part.name,partNumber:part.part_number,brand:part.brand}:item))}}><option value="">Select existing part</option>{parts.map(p=><option key={p.id} value={p.id}>{p.part_number} · {p.brand} · {p.name}</option>)}</select></label>{(['name','partNumber','brand','quantity','amount'] as const).map(key=><label key={key}>{({name:'Part name',partNumber:'Part number',brand:'Brand',quantity:'Physical units (check pack size)',amount:'Allocated total incl. tax / shipping ($)'})[key]}<input required={key!=='brand'} type={key==='quantity'?'number':'text'} min={key==='quantity'?1:undefined} value={line[key]} onChange={e=>setLines(current=>current.map((item,i)=>i===index?{...item,[key]:key==='quantity'?Number(e.target.value):e.target.value}:item))}/></label>)}<button type="button" title="Exclude item" aria-label={`Exclude item ${index+1}`} disabled={busy} onClick={()=>{setLines(current=>current.filter((_,i)=>i!==index));setConfirmed(false);try{setTotal((Math.max(0,inventoryCents(total)-inventoryCents(line.amount))/100).toFixed(2))}catch{setTotal('')}}}><Trash2 size={18}/></button></fieldset>)}
      <label className="inventory-review-check"><input type="checkbox" checked={confirmed} onChange={e=>{e.stopPropagation();setConfirmed(e.target.checked)}}/>I verified all part numbers, physical quantities, package sizes and allocated totals.</label><div className="inventory-filters"><button type="submit" disabled={busy||!confirmed||!lines.length}>Confirm Import</button><button type="button" disabled={busy} onClick={()=>setId('')}>Close Review</button></div></form>}
  </section>
}
