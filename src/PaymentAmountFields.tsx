import { useId, useRef, useState } from 'react'
import { Pencil } from 'lucide-react'
import './TapPaymentDialog.css'

export type PaymentAmountFieldsProps = {
  totalCents: number
  paidCents: number
  balanceCents: number
  items: { id: string; label: string; cents: number }[]
  amount: string
  onAmountChange: (value: string) => void
  disabled?: boolean
}

export function PaymentAmountFields({ totalCents, paidCents, balanceCents, items, amount, onAmountChange, disabled = false }: PaymentAmountFieldsProps) {
  const [editing, setEditing] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const input = useRef<HTMLInputElement>(null)
  const id = useId()
  const money = (value: number) => `$${(value / 100).toFixed(2)}`
  return <>
    <dl className="tap-payment-summary">
      <div><dt>Order total</dt><dd>{money(totalCents)}</dd></div>
      <div><dt>Paid</dt><dd>{money(paidCents)}</dd></div>
      <div><dt>Remaining</dt><dd>{money(balanceCents)}</dd></div>
    </dl>
    <div className="tap-payment-amount-heading">
      <label htmlFor={id}>Payment amount</label>
      <button type="button" disabled={disabled} aria-label="Edit payment amount" title="Edit payment amount" onClick={() => { setEditing(true); input.current?.focus() }}><Pencil size={18} /></button>
    </div>
    <input id={id} ref={input} inputMode="decimal" value={amount} readOnly={!editing} disabled={disabled} onChange={event => { onAmountChange(event.target.value); setSelected([]) }} />
    <button type="button" className="back-button" disabled={disabled} onClick={() => { onAmountChange((balanceCents / 100).toFixed(2)); setSelected([]) }}>Remaining balance</button>
    <fieldset className="payment-item-options" disabled={disabled}><legend>Items</legend>{items.map(item => <label key={item.id} className="tap-payment-item">
      <input type="checkbox" checked={selected.includes(item.id)} onChange={event => {
        const next = event.target.checked ? [...selected, item.id] : selected.filter(id => id !== item.id)
        setSelected(next)
        onAmountChange((items.filter(row => next.includes(row.id)).reduce((sum, row) => sum + row.cents, 0) / 100).toFixed(2))
      }} />
      <span>{item.label}</span><strong>{money(item.cents)}</strong>
    </label>)}</fieldset>
  </>
}
