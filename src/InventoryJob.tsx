import { useCallback, useEffect, useRef, useState } from 'react'
import { Calculator, PackagePlus, X } from 'lucide-react'
import { fifoPreview, inventoryNumber, type InventoryPart, type InventoryUsage } from '../shared/inventory'
import { inventoryRequest } from './inventoryApi'
import { inventoryMoney } from '../shared/inventory'
import { ExpenseCalculator } from './ExpenseCalculator'
import { InventoryPhoto } from './InventoryPhoto'
import './InventoryPage.css'

export function InventoryJob({jobId,token,onChange}:{jobId:string;token:string;onChange:()=>Promise<void>}) {
  const [usage,setUsage]=useState<InventoryUsage[]>([]),[parts,setParts]=useState<InventoryPart[]>([])
  const [open,setOpen]=useState(false),[search,setSearch]=useState(''),[selected,setSelected]=useState<InventoryPart|null>(null)
  const [lots,setLots]=useState<{remaining:number;remaining_cents:string}[]>([]),[quantity,setQuantity]=useState(1)
  const [error,setError]=useState(''),[busy,setBusy]=useState(false)
  const [calculator,setCalculator]=useState<InventoryUsage|null>(null)
  const dialog=useRef<HTMLDialogElement>(null),lock=useRef(false),requestId=useRef(crypto.randomUUID())
  const reload=useCallback(async(signal?:AbortSignal)=>{
    const data=await inventoryRequest<{usage:InventoryUsage[]}>(token,`/usage?jobId=${encodeURIComponent(jobId)}`,{signal})
    if(!signal?.aborted)setUsage(data.usage)
  },[jobId,token])
  useEffect(()=>{
    const c=new AbortController()
    // reload updates state only after its fetch completes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload(c.signal).catch(e=>{if(!c.signal.aborted)setError(e.message)})
    return()=>c.abort()
  },[reload])
  useEffect(()=>{if(!open)return;const d=dialog.current;d?.showModal();const c=new AbortController();void inventoryRequest<{parts:InventoryPart[]}>(token,'/parts',{signal:c.signal}).then(data=>{if(!c.signal.aborted)setParts(data.parts)}).catch(e=>{if(!c.signal.aborted)setError(e.message)});return()=>{d?.close();c.abort()}},[open,token])
  useEffect(()=>{if(!selected)return;const c=new AbortController();void inventoryRequest<{batches:typeof lots}>(token,`/parts/${selected.id}`,{signal:c.signal}).then(data=>{if(!c.signal.aborted)setLots(data.batches)}).catch(e=>{if(!c.signal.aborted)setError(e.message)});return()=>c.abort()},[selected,token])
  let estimate:number|null=null
  try{estimate=fifoPreview(lots,quantity)}catch{/* The confirmation stays disabled until lots are loaded and sufficient. */}
  async function mutate(payload:Record<string,unknown>){
    if(lock.current)return
    lock.current=true;setBusy(true);setError('')
    try{await inventoryRequest(token,'/movements',{method:'POST',body:JSON.stringify({...payload,confirmed:true})});await reload();await onChange();setOpen(false);setSelected(null);requestId.current=crypto.randomUUID()}
    catch(e){setError(e instanceof Error?e.message:'Unable to update inventory')}
    finally{lock.current=false;setBusy(false)}
  }
  return <section className="inventory-job">
    <button type="button" className="secondary-action" disabled={busy} onClick={()=>{setOpen(true);setError('');setSelected(null);setSearch('');setQuantity(1);setLots([]);requestId.current=crypto.randomUUID()}}><PackagePlus size={20}/> Add from Inventory</button>
    {error&&<p role="alert">{error}</p>}
    {usage.map(item=><article className="receipt-entry" key={item.id}><strong>{item.name}</strong><p>{item.part_number} · {item.quantity} units · {inventoryMoney(item.expense_cents)}</p><small>Purchase cost: {inventoryMoney(item.purchase_cents)}</small>{item.returned_at?<p>Returned to stock</p>:<div className="receipt-actions"><button className="secondary-action" type="button" disabled={busy} onClick={()=>{if(window.confirm(`Return all ${item.quantity} units to stock and cancel this job expense?`))void mutate({requestId:crypto.randomUUID(),partId:item.part_id,quantity:item.quantity,usageId:item.id,action:'return',reason:'Unused parts returned from job'})}}>Return to Stock</button><button type="button" className="secondary-action" title="Adjust job expense" aria-label="Adjust job expense" disabled={busy} onClick={()=>setCalculator(item)}><Calculator size={20}/></button></div>}</article>)}
    {calculator&&<ExpenseCalculator value={Number(calculator.expense_cents)} maximum={null} onClose={()=>setCalculator(null)} onApply={expenseCents=>{
      if(lock.current)return
      lock.current=true
      const id=calculator.id;setCalculator(null);setBusy(true);setError('')
      void inventoryRequest(token,`/usage/${id}/expense`,{method:'PUT',body:JSON.stringify({confirmed:true,expenseCents})}).then(async()=>{await reload();await onChange()}).catch(e=>setError(e.message)).finally(()=>{lock.current=false;setBusy(false)})
    }}/>}
    {open&&<dialog ref={dialog} className="inventory-dialog" onCancel={e=>{if(busy)e.preventDefault();else setOpen(false)}}><header><h2>Add from Inventory</h2><button type="button" aria-label="Close inventory" disabled={busy} onClick={()=>setOpen(false)}><X size={20}/></button></header>{error&&<p role="alert">{error}</p>}
      <input className="inventory-job-search" type="search" aria-label="Search inventory parts" placeholder="Part number, name or brand" value={search} onChange={e=>setSearch(e.target.value)}/>
      <div className="inventory-list">{parts.filter(p=>Number(p.quantity)>0&&(`${p.name} ${p.part_number} ${p.brand} ${p.suppliers}`.toLowerCase().includes(search.toLowerCase())||!!inventoryNumber(search)&&inventoryNumber(p.part_number).includes(inventoryNumber(search)))).map(p=><button className="inventory-part" type="button" key={p.id} aria-pressed={selected?.id===p.id} disabled={busy} onClick={()=>{setSelected(p);setLots([]);setQuantity(1);requestId.current=crypto.randomUUID()}}><InventoryPhoto key={p.photo_key||p.id} token={token} id={p.id} photoKey={p.photo_key} name={p.name}/><span><strong>{p.name}</strong><small>{p.brand} · {p.part_number}</small></span><span><strong>{p.quantity} available</strong></span></button>)}</div>
      {selected&&<form onSubmit={e=>{e.preventDefault();if(estimate!==null)void mutate({requestId:requestId.current,partId:selected.id,action:'stock_out',quantity,jobId,reason:'Installation confirmed by owner'})}}><h3>{selected.name}</h3>{usage.some(u=>u.part_id===selected.id&&!u.returned_at)&&<p>Already used on this job. This adds more units.</p>}<label>Quantity installed<input type="number" min="1" max={Number(selected.quantity)} required value={quantity} disabled={busy} onChange={e=>setQuantity(Number(e.target.value))}/></label><p>Purchase cost: {estimate===null?'Checking stock...':inventoryMoney(estimate)}</p><button type="submit" disabled={busy||estimate===null}>{busy?'Saving...':'Confirm installed / Add to Job'}</button></form>}
    </dialog>}
  </section>
}
