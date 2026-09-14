import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { PaymentAmountFields } from './PaymentAmountFields'
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
  const submitted = useRef(false)
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
        <PaymentAmountFields totalCents={totalCents} paidCents={paidCents} balanceCents={balanceCents} items={items} amount={amount} onAmountChange={setAmount} />
        {!valid ? <p role="alert" className="form-error">Enter $0.50 or more, up to {money(balanceCents)}.</p> : null}
        <div className="modal-actions"><button type="button" className="back-button" onClick={onCancel}>Cancel</button><button type="submit" className="primary-action" disabled={!valid}>Tap to Pay {valid ? money(cents) : ''}</button></div>
      </form>
    </div>, document.body,
  )
}
