import { useState } from 'react'

export function InventorySupplierInput({value,onChange,suppliers=[]}:{value:string;onChange:(value:string)=>void;suppliers?:string[]}) {
  const [open,setOpen]=useState(false)
  const matches=[...new Set(suppliers.filter(Boolean))].sort().filter(s=>s.toLowerCase().includes(value.trim().toLowerCase())).slice(0,5)
  return <div className="inventory-supplier" onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget))setOpen(false)}}>
    <label>Supplier<input required autoComplete="off" maxLength={200} value={value}
      onFocus={()=>setOpen(true)} onChange={e=>{onChange(e.target.value);setOpen(true)}}
      onKeyDown={e=>{if(e.key==='Escape'&&open){e.preventDefault();e.stopPropagation();setOpen(false)}}}/></label>
    {open&&matches.length>0&&<div className="inventory-supplier-options" role="group" aria-label="Supplier suggestions">
      {matches.map(s=><button type="button" key={s} onMouseDown={e=>e.preventDefault()} onClick={()=>{onChange(s);setOpen(false)}}>{s}</button>)}
    </div>}
  </div>
}
