import { useCallback, useEffect, useRef, useState } from 'react'
import { Camera, Package, Plus, RefreshCw, Upload, X } from 'lucide-react'
import { inventoryNumber, inventoryMoney, type InventoryPart } from '../shared/inventory'
import { inventoryRequest } from './inventoryApi'
import { InventoryInvoice, type InventoryInvoiceHandle } from './InventoryInvoice'
import { InventoryPhoto } from './InventoryPhoto'
import { inventoryPhoto } from './prepareInventoryPhoto'
import { hasNativePartsPhoto, pickPartsPhoto } from './partsPhoto'
import { InventoryPurchaseFields } from './InventoryPurchaseFields'
import { newPurchase, purchasePayload } from '../shared/inventoryPurchase'
import './InventoryPage.css'

const blank = () => ({id:crypto.randomUUID() as string,name:'',part_number:'',brand:'',location:'',models:'',notes:'',low_stock:1})
type PartForm = ReturnType<typeof blank>
export function InventoryPage({token}: {token:string}) {
  const [parts,setParts] = useState<InventoryPart[]>([])
  const [search,setSearch] = useState(''), [stock,setStock] = useState('all'), [sort,setSort] = useState('name')
  const [brandFilter,setBrandFilter]=useState(''),[supplierFilter,setSupplierFilter]=useState(''),[purchaseDate,setPurchaseDate]=useState('')
  const [error,setError] = useState(''), [busy,setBusy] = useState(false), [loading,setLoading] = useState(true)
  const [form,setForm] = useState<PartForm | null>(null), [editing,setEditing] = useState(false)
  const [pendingPhoto,setPendingPhoto]=useState<Blob|null>(null)
  const invoiceScan=useRef<InventoryInvoiceHandle>(null)
  const [invoiceReview,setInvoiceReview]=useState(false)
  const [selected,setSelected] = useState<InventoryPart | null>(null)
  const [detail,setDetail] = useState<{batches:{id:string;supplier:string;purchase_date:string;quantity:number;remaining:number;total_cents:string}[];movements:{id:string;kind:string;quantity:number;reason:string;created_at:string}[]} | null>(null)
  const [movement,setMovement] = useState('stock_in'), [quantity,setQuantity] = useState(1), [reason,setReason] = useState('')
  const [purchase,setPurchase]=useState(newPurchase),[initialStock,setInitialStock]=useState(true)
  const dialog = useRef<HTMLDialogElement>(null)
  const photoPicker=useRef<HTMLInputElement>(null),cameraPicker=useRef<HTMLInputElement>(null)
  const requestId = useRef(crypto.randomUUID())
  const locked = useRef(false)
  const reload = useCallback(async (signal?:AbortSignal) => {
    const data = await inventoryRequest<{parts:InventoryPart[]}>(token,'/parts',{signal})
    if (!signal?.aborted) { setParts(data.parts); setLoading(false) }
  },[token])
  useEffect(() => {
    const controller=new AbortController()
    // reload updates state only after its fetch completes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload(controller.signal).catch(e => { if (!controller.signal.aborted) { setError(e.message);setLoading(false) } })
    return () => controller.abort()
  },[reload])
  const modalOpen=!!form || !!selected
  useEffect(() => {
    if (!modalOpen) return
    const element=dialog.current; element?.showModal()
    return () => element?.close()
  },[modalOpen])
  useEffect(() => {
    if (!selected) return
    const controller=new AbortController()
    void inventoryRequest<NonNullable<typeof detail>>(token,`/parts/${selected.id}`,{signal:controller.signal}).then(data => { if (!controller.signal.aborted) setDetail(data) }).catch(e => {if(!controller.signal.aborted)setError(e.message)})
    return () => controller.abort()
  },[selected,token])
  async function action(fn:()=>Promise<void>) {
    if(locked.current)return
    locked.current=true;setBusy(true);setError('')
    try {await fn();await reload()} catch(e){setError(e instanceof Error?e.message:'Unable to save')}
    finally{locked.current=false;setBusy(false)}
  }
  function close(){if(busy)return;setForm(null);setSelected(null);setDetail(null);setError('');setInvoiceReview(false)}
  async function uploadPhoto(file:File){
    if(!selected&&!form)return
    if(form&&!editing){
      await invoiceScan.current?.scan(file)
      if(photoPicker.current)photoPicker.current.value=''
      if(cameraPicker.current)cameraPicker.current.value=''
      return
    }
    const image=await inventoryPhoto(file)
    if(form){setPendingPhoto(image);return}
    if(!selected)return
    await inventoryRequest(token,`/parts/${selected.id}/photo`,{method:'POST',body:image,headers:{'Content-Type':image.type}})
    setSelected(null)
  }
  function choosePhoto(source:'camera'|'gallery'){
    if(!hasNativePartsPhoto()){(source==='camera'?cameraPicker:photoPicker).current?.click();return}
    void action(async()=>{const file=await pickPartsPhoto(source);if(file)await uploadPhoto(file)})
  }
  const visible=parts.filter(p => (`${p.name} ${p.part_number} ${p.brand} ${p.suppliers}`.toLowerCase().includes(search.toLowerCase()) || !!inventoryNumber(search) && inventoryNumber(p.part_number).includes(inventoryNumber(search))) && (!brandFilter||p.brand===brandFilter) && (!supplierFilter||p.suppliers.split(', ').includes(supplierFilter)) && (!purchaseDate||p.purchase_dates?.includes(purchaseDate)) && (stock==='all' || stock==='low' && Number(p.quantity)<=p.low_stock || stock==='in' && Number(p.quantity)>0 || stock==='out' && !Number(p.quantity)))
    .sort((a,b)=>sort==='value'?Number(b.value_cents)-Number(a.value_cents):sort==='quantity'?Number(b.quantity)-Number(a.quantity):sort==='date'?(b.last_purchase||'').localeCompare(a.last_purchase||''):sort==='recent'?(b.created_at||'').localeCompare(a.created_at||''):sort==='number'?a.part_number.localeCompare(b.part_number):a.name.localeCompare(b.name))
  return <section className="inventory-page">
    <header><h1><Package size={24}/> Parts Inventory</h1><div><button type="button" aria-label="Refresh inventory" title="Refresh" disabled={busy} onClick={()=>void action(async()=>{})}><RefreshCw size={20}/></button><button type="button" onClick={()=>{setEditing(false);setForm(blank());setPendingPhoto(null);setError('');setPurchase(newPurchase());setInitialStock(true);requestId.current=crypto.randomUUID()}}><Plus size={18}/> Add Part</button></div></header>
    <dl className="inventory-summary"><div><dt>Unique parts</dt><dd>{parts.length}</dd></div><div><dt>Units</dt><dd>{parts.reduce((n,p)=>n+Number(p.quantity),0)}</dd></div><div><dt>Stock value</dt><dd>{inventoryMoney(parts.reduce((n,p)=>n+Number(p.value_cents),0))}</dd></div><div><dt>Low stock</dt><dd>{parts.filter(p=>Number(p.quantity)<=p.low_stock).length}</dd></div></dl>
    <InventoryInvoice token={token} onImported={reload} parts={parts}/>
    <div className="inventory-filters"><input type="search" aria-label="Search inventory" placeholder="Part number, name, brand or supplier" value={search} onChange={e=>setSearch(e.target.value)}/><select aria-label="Stock filter" value={stock} onChange={e=>setStock(e.target.value)}><option value="all">All stock</option><option value="in">In stock</option><option value="low">Low stock</option><option value="out">Out of stock</option></select><select aria-label="Sort parts" value={sort} onChange={e=>setSort(e.target.value)}><option value="name">Name</option><option value="number">Part number</option><option value="recent">Recently added</option><option value="quantity">Quantity</option><option value="value">Value</option><option value="date">Latest purchase</option></select>
      <select aria-label="Filter brand" value={brandFilter} onChange={e=>setBrandFilter(e.target.value)}><option value="">All brands</option>{[...new Set(parts.map(p=>p.brand).filter(Boolean))].sort().map(b=><option key={b}>{b}</option>)}</select><select aria-label="Filter supplier" value={supplierFilter} onChange={e=>setSupplierFilter(e.target.value)}><option value="">All suppliers</option>{[...new Set(parts.flatMap(p=>p.suppliers.split(', ')).filter(Boolean))].sort().map(s=><option key={s}>{s}</option>)}</select><label>Purchase date<input type="date" value={purchaseDate} onChange={e=>setPurchaseDate(e.target.value)}/></label></div>
    <datalist id="inventory-supplier-options">{[...new Set(parts.flatMap(p=>p.suppliers.split(', ')).filter(Boolean))].sort().map(s=><option key={s} value={s}/>)}</datalist>
    {error && !modalOpen && <p role="alert">{error}</p>}{loading && <p role="status">Loading...</p>}
    <div className="inventory-list">{visible.map(part=><button className="inventory-part" type="button" key={part.id} onClick={()=>{setSelected(part);setDetail(null);setMovement('stock_in');setQuantity(1);setPurchase(newPurchase());setReason('');requestId.current=crypto.randomUUID()}}><InventoryPhoto key={part.photo_key||part.id} token={token} id={part.id} photoKey={part.photo_key} name={part.name}/><span><strong>{part.name}</strong><small>{part.brand} · {part.part_number}</small><small>{part.suppliers}</small></span><span><strong>{part.quantity} units</strong><small>{inventoryMoney(part.value_cents)}</small>{Number(part.quantity)<=part.low_stock && <small className="inventory-low">{Number(part.quantity)?'Low stock':'Out of stock'}</small>}</span></button>)}</div>
    {!loading&&!visible.length&&<p>No Parts Found</p>}
    {modalOpen&&<dialog ref={dialog} className="inventory-dialog" onCancel={e=>{if(busy)e.preventDefault();else close()}}><header><h2>{form?(editing?'Edit Part':'Add Part'):selected?.name}</h2><button type="button" aria-label="Close" title="Close" disabled={busy} onClick={close}><X size={20}/></button></header>
      {error&&<p role="alert">{error}</p>}
      <input ref={photoPicker} type="file" hidden accept="image/*" onChange={e=>{const file=e.target.files?.[0];if(file)void action(()=>uploadPhoto(file))}}/><input ref={cameraPicker} type="file" hidden accept="image/*" capture="environment" onChange={e=>{const file=e.target.files?.[0];if(file)void action(()=>uploadPhoto(file))}}/>
      {form&&<div className="inventory-filters"><button type="button" disabled={busy} onClick={()=>choosePhoto('camera')}><Camera size={18}/> Camera</button><button type="button" disabled={busy} onClick={()=>choosePhoto('gallery')}><Upload size={18}/>{editing?'Product Photo':busy?'Recognizing...':'Scan Photo / Screenshot'}</button>{pendingPhoto&&<span role="status">Photo ready</span>}</div>}
      {form&&!editing&&<InventoryInvoice token={token} parts={parts} scanRef={invoiceScan} onBusyChange={setBusy} onReviewChange={setInvoiceReview} onImported={async()=>{setForm(null);setInvoiceReview(false);await reload()}}/>}
      {form&&!invoiceReview&&<form onSubmit={e=>{e.preventDefault();void action(async()=>{await inventoryRequest(token,editing?`/parts/${form.id}`:'/parts',{method:editing?'PUT':'POST',body:JSON.stringify({...form,...(!editing&&initialStock?{purchase:purchasePayload(purchase),requestId:requestId.current}:{})})});if(pendingPhoto)await inventoryRequest(token,`/parts/${form.id}/photo`,{method:'POST',body:pendingPhoto,headers:{'Content-Type':pendingPhoto.type}});setPendingPhoto(null);setForm(null)})}}>
        {(['name','part_number','brand','location','models','notes'] as const).map(key=><label key={key}>{({name:'Part name',part_number:'Part number',brand:'Brand',location:'Storage location',models:'Compatible models',notes:'Notes'})[key]}<input required={key==='name'||key==='part_number'} value={form[key]} maxLength={key==='notes'?2000:key==='models'?1000:100} onChange={e=>setForm({...form,[key]:e.target.value})}/></label>)}
        <label>Low stock threshold<input type="number" min="0" max="100000" required value={form.low_stock} onChange={e=>setForm({...form,low_stock:Number(e.target.value)})}/></label>{!editing&&<><label className="inventory-review-check"><input type="checkbox" checked={initialStock} onChange={e=>setInitialStock(e.target.checked)}/>Add initial purchase</label>{initialStock&&<InventoryPurchaseFields value={purchase} onChange={setPurchase}/>}</>}<button type="submit" disabled={busy}>{busy?'Saving...':'Save Part'}</button>
      </form>}
      {selected&&<><div className="inventory-product-photo"><InventoryPhoto token={token} id={selected.id} photoKey={selected.photo_key} name={selected.name}/></div><p>{selected.brand} · {selected.part_number}</p><p>{selected.quantity} units · {inventoryMoney(selected.value_cents)}</p>{Number(selected.quantity)>0&&<p>Average unit cost: {inventoryMoney(Number(selected.value_cents)/Number(selected.quantity))}</p>}{selected.last_purchase&&<p>Last purchase: {selected.last_purchase.slice(0,10)}</p>}<p>{selected.location}</p>{selected.models&&<p>Compatible models: {selected.models}</p>}<p>{selected.notes}</p><button type="button" disabled={busy} onClick={()=>{setForm(selected);setPendingPhoto(null);setEditing(true);setSelected(null)}}>Edit Part</button>
        <div className="inventory-filters"><button type="button" disabled={busy} onClick={()=>choosePhoto('camera')}><Camera size={18}/> Camera</button><button type="button" disabled={busy} onClick={()=>choosePhoto('gallery')}><Upload size={18}/> Choose Photo</button></div>
        <form onSubmit={e=>{e.preventDefault();void action(async()=>{
          await inventoryRequest(token,'/movements',{method:'POST',body:JSON.stringify({requestId:requestId.current,partId:selected.id,action:movement,quantity,reason,confirmed:true,...(movement==='stock_in'?purchasePayload(purchase):{})})})
          setSelected(null);setDetail(null)
        })}}><h3>Stock movement</h3><label>Type<select value={movement} onChange={e=>{setMovement(e.target.value);requestId.current=crypto.randomUUID()}}><option value="stock_in">Stock In</option><option value="damaged">Damaged / Discarded</option><option value="adjustment">Adjustment - remove stock</option></select></label>
          {movement==='stock_in'?<InventoryPurchaseFields value={purchase} onChange={setPurchase}/>:<label>Quantity<input type="number" min="1" max="100000" required value={quantity} onChange={e=>setQuantity(Number(e.target.value))}/></label>}
          <label>Reason<input value={reason} maxLength={500} required={movement!=='stock_in'} onChange={e=>setReason(e.target.value)}/></label><button type="submit" disabled={busy}>{busy?'Saving...':'Confirm movement'}</button></form>
        <h3>Purchase batches</h3>{detail?.batches.map(b=><p key={b.id}>{b.purchase_date.slice(0,10)} · {b.supplier} · {b.remaining}/{b.quantity} remaining · {inventoryMoney(b.total_cents)}</p>)}
        <h3>History</h3>{detail?.movements.map(m=><p key={m.id}>{new Date(m.created_at).toLocaleString()} · {m.kind.replaceAll('_',' ')} · {m.quantity} · {m.reason}</p>)}
      </>}
    </dialog>}
  </section>
}
