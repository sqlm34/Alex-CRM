export type FinanceLine = { id: string; label: string; amount: number }
export type Payment = {
  id: string
  amount: number
  createdAt: string
  method?: string
  paymentIntentId?: string
  status?: string
  processor?: string
  memo?: string
  itemAmounts?: Record<string, number>
}

// Dollar values stay compatible with existing JSON records; all arithmetic uses cents.
export function cents(value: unknown): number {
  const text = String(value ?? '').trim()
  if (!/^\d+(?:\.\d{0,2})?$/.test(text)) return NaN
  const [whole, fraction = ''] = text.split('.')
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  return Number.isSafeInteger(result) ? result : NaN
}

export function storedCents(value: unknown): number {
  const result = cents(value)
  return Number.isFinite(result) ? result : 0
}

export function successful(payment: Pick<Payment, 'status'>): boolean {
  // Older manual and Terminal records did not store a status.
  return !payment.status || ['succeeded', 'paid', 'completed'].includes(payment.status.toLowerCase())
}

export function paidCents(payments: Payment[] = []): number {
  const seen = new Set<string>()
  return payments.reduce((sum, payment) => {
    const key = payment.paymentIntentId || payment.id
    if (!successful(payment) || seen.has(key)) return sum
    seen.add(key)
    return sum + storedCents(payment.amount)
  }, 0)
}

export function financials(items: FinanceLine[] = [], payments: Payment[] = [], legacyInvoice: unknown = 0, legacyPaidAmount: unknown = 0) {
  const total = items.length
    ? items.reduce((sum, item) => sum + storedCents(item.amount), 0)
    : storedCents(legacyInvoice)
  const paid = paidCents(payments) + storedCents(legacyPaidAmount)
  const remaining = Math.max(total - paid, 0)
  return { total, paid, remaining, status: remaining === 0 && paid > 0 ? 'Paid' : paid > 0 ? 'Partially Paid' : 'Unpaid' }
}

export function itemRemaining(item: FinanceLine, payments: Payment[]) {
  const allocations = payments.filter(successful).reduce((sum, payment) => sum + (payment.itemAmounts?.[item.id] || 0), 0)
  return Math.max(0, storedCents(item.amount) - allocations)
}

export function validateAmount(amount: number, remaining: number, minimum = 1) {
  if (!Number.isSafeInteger(amount) || amount < minimum) throw new Error(`Payment amount must be at least $${(minimum / 100).toFixed(2)}.`)
  if (amount > remaining) throw new Error('Payment amount cannot exceed the remaining balance.')
}

export function paymentAllocation(items: FinanceLine[], payments: Payment[], selected: string[], amount: number) {
  const allocation: Record<string, number> = {}
  for (const id of new Set(selected)) {
    const item = items.find((entry) => entry.id === id)
    if (!item) throw new Error('Selected item no longer exists.')
    const remaining = itemRemaining(item, payments)
    if (!remaining) throw new Error('Selected item is already paid.')
    allocation[id] = remaining
  }
  if (selected.length && Object.values(allocation).reduce((sum, value) => sum + value, 0) !== amount) {
    throw new Error('Selected items changed. Review the payment amount.')
  }
  return allocation
}
