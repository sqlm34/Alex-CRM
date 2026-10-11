export type ReceiptData = {
  supplier: string
  date: string
  currency: string
  items: { description: string; partNumber: string; amountCents: number | null; quantity?: number | null; usedQuantity?: number }[]
  expenseCents?: number | null
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
  for (const item of r.items) {
    if (item.quantity != null && (!Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 100000)) throw new Error('Purchased quantity must be a positive whole number')
    if (item.usedQuantity !== undefined && (!Number.isSafeInteger(item.usedQuantity) || item.usedQuantity < 0 || item.usedQuantity > (item.quantity ?? 1))) throw new Error('Used quantity must be between zero and purchased quantity')
  }
  if (r.expenseCents !== undefined && !money(r.expenseCents)) throw new Error('Invalid job expense')
  const expense = receiptExpense(r)
  if (r.expenseCents != null && r.totalCents !== null && r.expenseCents > r.totalCents) throw new Error('Job expense cannot exceed total paid')
  if (confirmed && (!r.supplier.trim() || !r.date || r.currency !== 'USD' || r.totalCents === null || r.totalCents <= 0)) throw new Error('Enter supplier, date and a positive USD total before confirming')
  if (confirmed && (expense === null || expense <= 0)) throw new Error('Enter a positive job expense or check item amounts and quantities')
  return { supplier: r.supplier.trim(), date: r.date, currency: r.currency, items: r.items.map(i => ({ description: i.description, partNumber: i.partNumber, amountCents: i.amountCents, ...(i.quantity !== undefined ? { quantity: i.quantity } : {}), ...(i.usedQuantity !== undefined ? { usedQuantity: i.usedQuantity } : {}) })), subtotalCents: r.subtotalCents, taxCents: r.taxCents, shippingCents: r.shippingCents, totalCents: r.totalCents, ...(confirmed ? { expenseCents: expense } : r.expenseCents !== undefined ? { expenseCents: r.expenseCents } : {}) }
}

// Allocate the final purchase total, including tax, shipping and discounts, by line value.
// Legacy receipts without an allocation continue to count their original total.
export function receiptExpense(r: ReceiptData): number | null {
  if (r.expenseCents !== undefined) return r.expenseCents
  const partial = r.items.some(i => i.usedQuantity !== undefined && i.usedQuantity !== (i.quantity ?? 1))
  if (!partial) return r.totalCents
  if (r.totalCents === null || r.items.some(i => i.amountCents === null)) return null
  const sum = r.items.reduce((s, i) => s + (i.amountCents || 0), 0)
  if (!sum) return null
  const used = r.items.reduce((s, i) => s + (i.amountCents || 0) * (i.usedQuantity ?? i.quantity ?? 1) / (i.quantity ?? 1), 0)
  return Math.round(r.totalCents * used / sum)
}

export function receiptMismatch(r: ReceiptData) {
  return r.subtotalCents !== null && r.taxCents !== null && r.shippingCents !== null && r.totalCents !== null
    && r.subtotalCents + r.taxCents + r.shippingCents !== r.totalCents
}

export function receiptCosts(records: ReceiptRecord[]) {
  return records.filter(r => r.status === 'confirmed').reduce((sum, r) => sum + (r.data ? receiptExpense(r.data) || 0 : 0), 0)
}
