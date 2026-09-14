import { mkdirSync, writeFileSync } from 'node:fs'
import { createInvoicePdf } from '../worker/index.ts'

const job: Parameters<typeof createInvoicePdf>[0] = {
  id: '23', customer: 'Leslie Mansard', phone: '317-555-0123', email: 'customer@example.com',
  address: '123 Test Street, Indianapolis, IN 46250', appliance: 'Washer', issue: 'Parts and labor',
  service_date: '2026-09-14', service_window: '1:00 PM - 3:00 PM', status: 'scheduled',
  invoice: 389.10, paid: false, lat: 0, lng: 0,
  finance_items: [{ id: 'parts', label: 'Parts', amount: 231.30 }, { id: 'labor', label: 'Labor', amount: 157.80 }],
  payments: [{ id: 'pi_test1', paymentIntentId: 'pi_test1', amount: 231.30, method: 'Tap to Pay', status: 'succeeded', createdAt: '2026-09-14T17:00:00Z' }],
}
mkdirSync('test-results', { recursive: true })
writeFileSync('test-results/invoice-partial.pdf', Buffer.from(createInvoicePdf(job, '23'), 'base64'))
job.payments!.push({ id: 'pi_test2', paymentIntentId: 'pi_test2', amount: 157.80, method: 'Tap to Pay', status: 'succeeded', createdAt: '2026-09-15T17:00:00Z' })
writeFileSync('test-results/invoice-paid.pdf', Buffer.from(createInvoicePdf(job, '23'), 'base64'))
