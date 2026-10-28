export type InventoryPart = {
  id: string; name: string; part_number: string; brand: string; location: string; notes: string; models: string;
  low_stock: number; photo_key?: string | null; quantity: number | string; value_cents: number | string; suppliers: string; last_purchase?: string; purchase_dates?: string[]; created_at?: string
}
export type InventoryUsage = { id: string; part_id: string; name: string; part_number: string; quantity: number; purchase_cents: number | string; expense_cents: number | string; returned_at: string | null }
export type InventoryInvoiceData = Omit<import('./receipts').ReceiptData, 'items'> & { invoiceNumber?: string; items: (import('./receipts').ReceiptData['items'][number] & { brand?: string; unitPriceCents?: number | null })[] }
export const inventoryMoney = (cents: number | string) => new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(Number(cents)/100)
export function inventoryNumber(value: string) { return value.toUpperCase().replace(/[^A-Z0-9]/g, '') }
export function inventoryCents(value: string) {
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(value)) throw new Error('Enter a valid dollar amount')
  const [whole, fraction = ''] = value.split('.')
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  if (result > 100000000) throw new Error('Amount exceeds the supported limit')
  return result
}
export function fifoPreview(lots: { remaining: number; remaining_cents: number | string }[], quantity: number) {
  if (!Number.isSafeInteger(quantity) || quantity < 1) throw new Error('Enter a positive whole quantity')
  let left = quantity, cost = 0
  for (const lot of lots) {
    const take = Math.min(left, lot.remaining)
    if (take) cost += Math.floor(Number(lot.remaining_cents) * take / lot.remaining)
    left -= take
    if (!left) return cost
  }
  throw new Error('Not enough stock')
}
