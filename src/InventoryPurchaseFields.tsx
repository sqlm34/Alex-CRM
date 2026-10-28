import { inventoryCents, inventoryMoney } from '../shared/inventory'
import { purchasePayload, type PurchaseForm } from '../shared/inventoryPurchase'
import { InventorySupplierInput } from './InventorySupplierInput'
export function InventoryPurchaseFields({value,onChange,suppliers=[]}:{value:PurchaseForm;onChange:(value:PurchaseForm)=>void;suppliers?:string[]}) {
  let base:number|null=null,total:number|null=null
  try{base=inventoryCents(value.amount);total=purchasePayload(value).totalCents}catch{/* Incomplete input is validated on submit. */}
  return <fieldset className="inventory-purchase" onFocusCapture={e=>{
    const input=e.target
    if(!(input instanceof HTMLInputElement)||!(input.type==='number'||input.inputMode==='decimal'))return
    input.select()
    if(input.value.trim()&&Number(input.value)===0){
      if(input.name==='purchaseAmount')onChange({...value,amount:''})
      else if(input.name==='purchaseExtras')onChange({...value,extras:''})
      else if(input.type!=='number')input.value=''
    }
  }}><legend>Purchase</legend>
    <InventorySupplierInput value={value.supplier} suppliers={suppliers} onChange={supplier=>onChange({...value,supplier})}/>
    <label>Invoice number<input value={value.invoiceNumber} maxLength={100} onChange={e=>onChange({...value,invoiceNumber:e.target.value})}/></label>
    <label>Purchase date<input type="date" required value={value.date} onChange={e=>onChange({...value,date:e.target.value})}/></label>
    <label>Quantity purchased<input type="number" inputMode="numeric" required min="1" max="100000" value={value.quantity===0?'':value.quantity} onChange={e=>onChange({...value,quantity:Number(e.target.value)})} onBlur={e=>{if(value.quantity!==0)e.currentTarget.value=String(value.quantity)}}/></label>
    <label>Unit cost ($)<input inputMode="decimal" aria-label="Unit purchase cost" key={`${value.amount}-${value.quantity}`} defaultValue={base!==null&&value.quantity>0?(base/value.quantity/100).toFixed(2):''} onChange={e=>e.currentTarget.setCustomValidity('')} onBlur={e=>{if(!e.target.value)return;try{const cents=inventoryCents(e.target.value);if(base!==null&&e.target.value===(base/value.quantity/100).toFixed(2))return;onChange({...value,amount:(cents*value.quantity/100).toFixed(2)})}catch{e.target.setCustomValidity('Enter a dollar amount with at most two decimal places')}}}/></label>
    <label>{value.extrasIncluded?'Total purchase cost, all charges included ($)':'Parts subtotal before additional charges ($)'}<input name="purchaseAmount" required inputMode="decimal" value={value.amount} onChange={e=>onChange({...value,amount:e.target.value})}/></label>
    <label>Additional tax, shipping and supplier fees ($)<input name="purchaseExtras" inputMode="decimal" value={value.extras} onChange={e=>onChange({...value,extras:e.target.value})}/></label>
    <label className="inventory-review-check"><input type="checkbox" checked={value.extrasIncluded} onChange={e=>onChange({...value,extrasIncluded:e.target.checked})}/>Additional charges are already included in the total</label>
    <output>Batch cost: {total===null?'—':inventoryMoney(total)}</output>
  </fieldset>
}
