import { useState } from 'react'
import { Save, X } from 'lucide-react'
import { maxBasePriceCents } from './itemPricing'

export function ItemBasePriceEditor({ baseCents, saleCents, disabled, onSave }: {
  baseCents?: number
  saleCents: number
  disabled: boolean
  onSave: (baseCents: number) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const value = draft ?? (baseCents === undefined ? '' : (baseCents / 100).toFixed(2))
  const cents = Math.round(Number(value) * 100)
  const valid = /^\d+(?:\.\d{0,2})?$/.test(value) && Number.isSafeInteger(cents) && cents <= maxBasePriceCents
  return <div className="item-base-price-editor">
    <label>
      Base price
      <input aria-label="Item base unit price" inputMode="decimal" value={value}
        disabled={disabled} onChange={(event) => setDraft(event.target.value)} />
    </label>
    <span>Sale price: ${(saleCents / 100).toFixed(2)}</span>
    {draft !== null && <div className="item-base-price-actions">
      <button type="button" title="Save base price" aria-label="Save base price" disabled={disabled || !valid || cents === baseCents}
        onClick={() => { onSave(cents); setDraft(null) }}><Save size={16} /></button>
      <button type="button" title="Cancel base price" aria-label="Cancel base price"
        onClick={() => setDraft(null)}><X size={16} /></button>
    </div>}
  </div>
}
