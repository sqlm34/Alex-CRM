export type ReceiptData = {
  supplier: string
  date: string
  currency: string
  items: { description: string; partNumber: string; amountCents: number | null }[]
  subtotalCents: number | null
  taxCents: number | null
  shippingCents: number | null
  totalCents: number | null
}

export type ReceiptRecord = {
  id: string
  attachment_id: string
  status: 'processing' | 'draft' | 'confirmed' | 'voided' | 'failed'
  data: ReceiptData | null
  created_at: string
  confirmed_at: string | null
}

export function validateReceipt(value: unknown, confirmed = false): ReceiptData {
  if (!value || typeof value !== 'object') throw new Error('Invalid receipt data')
  const r = value as ReceiptData
  if (typeof r.supplier !== 'string' || r.supplier.length > 200 || typeof r.currency !== 'string' || r.currency.length > 3) throw new Error('Invalid supplier or currency')
  if (typeof r.date !== 'string' || (r.date !== '' && (!/^\d{4}-\d{2}-\d{2}$/.test(r.date) || !Number.isFinite(Date.parse(r.date)) || new Date(r.date).toISOString().slice(0, 10) !== r.date))) throw new Error('Invalid receipt date')
  const money = (n: unknown) => n === null || (Number.isSafeInteger(n) && Number(n) >= 0 && Number(n) <= 100000000)
  if (![r.subtotalCents, r.taxCents, r.shippingCents, r.totalCents].every(money)) throw new Error('Amounts must be valid cents')
  if (!Array.isArray(r.items) || r.items.length > 100 || r.items.some(i => !i || typeof i.description !== 'string' || i.description.length > 500 || typeof i.partNumber !== 'string' || i.partNumber.length > 100 || !money(i.amountCents))) throw new Error('Invalid receipt items')
  if (confirmed && (!r.supplier.trim() || !r.date || r.currency !== 'USD' || r.totalCents === null || r.totalCents <= 0)) throw new Error('Enter supplier, date and a positive USD total before confirming')
  return { supplier: r.supplier.trim(), date: r.date, currency: r.currency, items: r.items.map(i => ({ description: i.description, partNumber: i.partNumber, amountCents: i.amountCents })), subtotalCents: r.subtotalCents, taxCents: r.taxCents, shippingCents: r.shippingCents, totalCents: r.totalCents }
}

export function receiptMismatch(r: ReceiptData) {
  return r.subtotalCents !== null && r.taxCents !== null && r.shippingCents !== null && r.totalCents !== null
    && r.subtotalCents + r.taxCents + r.shippingCents !== r.totalCents
}

export function receiptCosts(records: ReceiptRecord[]) {
  return records.filter(r => r.status === 'confirmed').reduce((sum, r) => sum + (r.data?.totalCents || 0), 0)
}
