import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'

const source = readFileSync(new URL('../src/jobMerge.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText

const moduleUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent(compiled)}`
const { canUseJobDetails, mergeJobListRows } = await import(moduleUrl)

function rowToJob(row) {
  return {
    id: row.id,
    customer: row.customer,
    phone: row.phone,
    email: row.email || '',
    address: row.address,
    appliance: row.appliance,
    issue: row.issue,
    details: 'details' in row ? row.details : row.appliance,
    jobText: 'job_text' in row ? row.job_text : row.issue,
    date: row.service_date,
    window: row.service_window,
    status: row.status,
    invoice: row.invoice,
    paid: row.paid,
    financeItems: 'finance_items' in row ? row.finance_items : [{ id: 'default', label: 'Service', amount: row.invoice }],
    payments: 'payments' in row ? row.payments : [],
    modelPhotoAttachments: 'model_photo_attachments' in row ? row.model_photo_attachments : [],
    detailsLoaded: 'finance_items' in row && 'payments' in row && 'model_photo_attachments' in row,
    detailsLoading: false,
    detailsError: '',
  }
}

const fullJob = {
  id: 'job-1',
  customer: 'Old Customer',
  phone: '317-555-0101',
  email: 'old@example.com',
  address: 'Old address',
  appliance: 'Washer',
  issue: 'Old issue',
  details: 'Confirmed details',
  jobText: 'Confirmed job text',
  date: '2026-09-01',
  window: '9:00 AM - 11:00 AM',
  status: 'scheduled',
  invoice: 300,
  paid: false,
  financeItems: [
    { id: 'labor', label: 'Labor', amount: 200 },
    { id: 'parts', label: 'Parts', amount: 100 },
  ],
  payments: [
    { id: 'payment-1', amount: 100, createdAt: '2026-09-01T12:00:00.000Z', method: 'Manual' },
    { id: 'payment-2', amount: 50, createdAt: '2026-09-01T13:00:00.000Z', method: 'Card' },
  ],
  modelPhotoAttachments: [{ filename: 'model.jpg', contentType: 'image/jpeg', content: 'base64-data', size: 1234 }],
  detailsLoaded: true,
  detailsLoading: false,
  detailsError: '',
}

test('polling merge preserves hydrated finance, payments, and attachments', () => {
  const [merged] = mergeJobListRows(
    [fullJob],
    [{
      id: 'job-1',
      customer: 'New Customer',
      phone: '317-555-0202',
      email: 'new@example.com',
      address: 'New address',
      appliance: 'Dryer',
      issue: 'Updated issue',
      service_date: '2026-09-02',
      service_window: '1:00 PM - 3:00 PM',
      status: 'in_progress',
      invoice: 350,
      paid: false,
    }],
    rowToJob,
    new Set(),
  )

  assert.equal(merged.status, 'in_progress')
  assert.equal(merged.customer, 'New Customer')
  assert.equal(merged.address, 'New address')
  assert.equal(merged.financeItems.length, 2)
  assert.equal(merged.financeItems[0].label, 'Labor')
  assert.equal(merged.payments.length, 2)
  assert.equal(merged.modelPhotoAttachments.length, 1)
  assert.equal(merged.details, 'Confirmed details')
  assert.equal(merged.jobText, 'Confirmed job text')
  assert.equal(merged.detailsLoaded, true)
})

test('lightweight polling does not overwrite hydrated job text with list fallback', () => {
  const hydrated = { ...fullJob, issue: '', details: 'Server confirmed details', jobText: 'SERVER MARKER' }
  const [merged] = mergeJobListRows(
    [hydrated],
    [{
      id: 'job-1',
      customer: 'New Customer',
      phone: '317-555-0202',
      email: 'new@example.com',
      address: 'New address',
      appliance: 'Dryer',
      issue: '',
      service_date: '2026-09-02',
      service_window: '1:00 PM - 3:00 PM',
      status: 'in_progress',
      invoice: 350,
      paid: false,
    }],
    rowToJob,
    new Set(),
  )

  assert.equal(merged.detailsLoaded, true)
  assert.equal(merged.details, 'Server confirmed details')
  assert.equal(merged.jobText, 'SERVER MARKER')
  assert.equal(merged.status, 'in_progress')
})

test('full detail response can replace hydrated job text with a real empty value', () => {
  const [merged] = mergeJobListRows(
    [{ ...fullJob, jobText: 'SERVER MARKER' }],
    [{
      id: 'job-1',
      customer: 'Old worker row',
      phone: '',
      email: '',
      address: '',
      appliance: 'Washer',
      issue: 'Issue remains',
      details: 'Details remain',
      job_text: '',
      service_date: '2026-09-02',
      service_window: '1:00 PM - 3:00 PM',
      status: 'scheduled',
      invoice: 300,
      paid: true,
      finance_items: [{ id: 'labor', label: 'Labor', amount: 300 }],
      payments: [{ id: 'payment-3', amount: 300, createdAt: '2026-09-01T14:00:00.000Z' }],
      model_photo_attachments: [],
    }],
    rowToJob,
    new Set(),
  )

  assert.equal(merged.detailsLoaded, true)
  assert.equal(merged.details, 'Details remain')
  assert.equal(merged.jobText, '')
})

test('new lightweight job is added as not hydrated', () => {
  const [merged] = mergeJobListRows(
    [],
    [{ id: 'job-2', customer: 'New', phone: '', email: '', address: '', appliance: 'Oven', issue: '', service_date: '2026-09-02', service_window: '9:00 AM - 11:00 AM', status: 'new', invoice: 0, paid: false }],
    rowToJob,
    new Set(),
  )

  assert.equal(merged.detailsLoaded, false)
  assert.equal(canUseJobDetails(merged), false)
})

test('full details with real empty arrays are marked hydrated', () => {
  const [merged] = mergeJobListRows(
    [],
    [{ id: 'job-3', customer: 'Empty', phone: '', email: '', address: '', appliance: 'Oven', issue: '', service_date: '2026-09-02', service_window: '9:00 AM - 11:00 AM', status: 'new', invoice: 0, paid: false, finance_items: [], payments: [], model_photo_attachments: [] }],
    rowToJob,
    new Set(),
  )

  assert.equal(merged.detailsLoaded, true)
  assert.equal(canUseJobDetails(merged), true)
})

test('dirty job keeps local edits while deleted jobs are removed', () => {
  const dirtyJob = { ...fullJob, id: 'dirty-job', customer: 'Local edit' }
  const deletedJob = { ...fullJob, id: 'deleted-job' }
  const merged = mergeJobListRows(
    [dirtyJob, deletedJob],
    [{ id: 'dirty-job', customer: 'Remote edit', phone: '', email: '', address: '', appliance: 'Dryer', issue: '', service_date: '2026-09-02', service_window: '1:00 PM - 3:00 PM', status: 'new', invoice: 0, paid: false }],
    rowToJob,
    new Set(['dirty-job']),
  )

  assert.equal(merged.length, 1)
  assert.equal(merged[0].customer, 'Local edit')
})

test('detail load error keeps finance actions unavailable until retry succeeds', () => {
  const failed = { ...fullJob, detailsLoaded: false, detailsLoading: false, detailsError: 'Network error' }
  assert.equal(canUseJobDetails(failed), false)

  const retried = { ...failed, detailsLoaded: true, detailsError: '', payments: [] }
  assert.equal(canUseJobDetails(retried), true)
})

test('partial payment stays visible after lightweight polling merge', () => {
  const partial = { ...fullJob, invoice: 300, paid: false, payments: [{ id: 'payment-1', amount: 125, createdAt: '2026-09-01T12:00:00.000Z' }] }
  const [merged] = mergeJobListRows(
    [partial],
    [{ id: 'job-1', customer: 'Partial', phone: '', email: '', address: '', appliance: 'Washer', issue: '', service_date: '2026-09-02', service_window: '1:00 PM - 3:00 PM', status: 'scheduled', invoice: 300, paid: false }],
    rowToJob,
    new Set(),
  )

  assert.equal(merged.payments.length, 1)
  assert.equal(merged.payments[0].amount, 125)
  assert.equal(merged.paid, false)
})

test('full rows from an older worker can update hydrated arrays', () => {
  const [merged] = mergeJobListRows(
    [fullJob],
    [{
      id: 'job-1',
      customer: 'Old worker row',
      phone: '',
      email: '',
      address: '',
      appliance: 'Washer',
      issue: '',
      service_date: '2026-09-02',
      service_window: '1:00 PM - 3:00 PM',
      status: 'scheduled',
      invoice: 300,
      paid: true,
      finance_items: [{ id: 'labor', label: 'Labor', amount: 300 }],
      payments: [{ id: 'payment-3', amount: 300, createdAt: '2026-09-01T14:00:00.000Z' }],
      model_photo_attachments: [],
    }],
    rowToJob,
    new Set(),
  )

  assert.equal(merged.detailsLoaded, true)
  assert.equal(merged.payments.length, 1)
  assert.equal(merged.payments[0].id, 'payment-3')
  assert.equal(merged.financeItems[0].amount, 300)
})
