import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Pencil } from 'lucide-react'
import './TapPaymentDialog.css'

export function TapPaymentDialog({ totalCents, paidCents, balanceCents, items, onCancel, onCollect }: {
  totalCents: number
  paidCents: number
  balanceCents: number
  items: { id: string; label: string; cents: number }[]
  onCancel: () => void
  onCollect: (amount: number) => void
}) {
  const [amount, setAmount] = useState((balanceCents / 100).toFixed(2))
  const [editing, setEditing] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const submitted = useRef(false)
  const input = useRef<HTMLInputElement>(null)
  const cents = /^\d+(\.\d{1,2})?$/.test(amount) ? Math.round(Number(amount) * 100) : NaN
  const valid = Number.isSafeInteger(cents) && cents >= 50 && cents <= balanceCents
  const money = (value: number) => `$${(value / 100).toFixed(2)}`
  return createPortal(
    <div className="modal-backdrop" data-disable-swipe-back>
      <form className="payment-modal tap-payment-dialog" role="dialog" aria-modal="true" aria-labelledby="tap-payment-title" onSubmit={event => {
        event.preventDefault()
        if (!valid || submitted.current) return
        submitted.current = true
        onCollect(cents / 100)
      }}>
        <h3 id="tap-payment-title">Tap to Pay</h3>
        <dl className="tap-payment-summary">
          <div><dt>Order total</dt><dd>{money(totalCents)}</dd></div>
          <div><dt>Paid</dt><dd>{money(paidCents)}</dd></div>
          <div><dt>Remaining</dt><dd>{money(balanceCents)}</dd></div>
        </dl>
        <div className="tap-payment-amount-heading">
          <label htmlFor="tap-charge-amount">Payment amount</label>
          <button type="button" aria-label="Edit payment amount" title="Edit payment amount" onClick={() => { setEditing(true); input.current?.focus() }}><Pencil size={18} /></button>
        </div>
        <input id="tap-charge-amount" ref={input} inputMode="decimal" value={amount} readOnly={!editing} onChange={event => { setAmount(event.target.value); setSelected([]) }} />
        <button type="button" className="back-button" onClick={() => { setAmount((balanceCents / 100).toFixed(2)); setSelected([]) }}>Remaining balance</button>
        <fieldset><legend>Items</legend>{items.map(item => <label key={item.id} className="tap-payment-item">
          <input type="checkbox" checked={selected.includes(item.id)} onChange={event => {
            const next = event.target.checked ? [...selected, item.id] : selected.filter(id => id !== item.id)
            setSelected(next)
            setAmount((items.filter(row => next.includes(row.id)).reduce((sum, row) => sum + row.cents, 0) / 100).toFixed(2))
          }} />
          <span>{item.label}</span><strong>{money(item.cents)}</strong>
        </label>)}</fieldset>
        {!valid ? <p role="alert" className="form-error">Enter $0.50 or more, up to {money(balanceCents)}.</p> : null}
        <div className="modal-actions"><button type="button" className="back-button" onClick={onCancel}>Cancel</button><button type="submit" className="primary-action" disabled={!valid}>Tap to Pay {valid ? money(cents) : ''}</button></div>
      </form>
    </div>, document.body,
  )
}
