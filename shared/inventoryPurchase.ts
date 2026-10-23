import { inventoryCents } from './inventory'
import { callDate } from './receptionist-calendar'

export const newPurchase = () => ({supplier:'',invoiceNumber:'',date:callDate(),quantity:1,amount:'',extras:'0.00',extrasIncluded:true})
export type PurchaseForm=ReturnType<typeof newPurchase>
export function purchasePayload(value:PurchaseForm) {
  const base=inventoryCents(value.amount),extras=inventoryCents(value.extras.trim()||'0')
  if(!Number.isSafeInteger(value.quantity)||value.quantity<1||value.quantity>100000)throw new Error('Enter a positive whole quantity')
  const totalCents=base+(value.extrasIncluded?0:extras)
  if(totalCents>100000000)throw new Error('Purchase total exceeds the limit')
  return {supplier:value.supplier,invoiceNumber:value.invoiceNumber,date:value.date,quantity:value.quantity,totalCents,costBreakdown:{enteredCents:base,additionalCents:extras,alreadyIncluded:value.extrasIncluded}}
}
