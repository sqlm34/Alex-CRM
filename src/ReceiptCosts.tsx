import { useCallback, useEffect, useRef, useState } from 'react'
import { Camera, FileImage, Plus, Trash2, Upload } from 'lucide-react'
import { completeAttachmentUpload, createAttachmentUploadSession, deleteJobAttachment, fetchJobAttachments, receiptRequest, uploadAttachmentFile } from './api'
import type { JobAttachmentMetadata } from './api'
import { compatibleImageFile } from './heicImages'
import { resolveGalleryFileMimeType } from './attachmentUtils'
import { receiptCosts, receiptMismatch, validateReceipt } from '../shared/receipts'
import type { ReceiptData, ReceiptRecord } from '../shared/receipts'
import './ReceiptCosts.css'

const money = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100)
const amountKeys = ['subtotalCents', 'taxCents', 'shippingCents', 'totalCents'] as const
const labels = { subtotalCents: 'Subtotal', taxCents: 'Tax', shippingCents: 'Shipping', totalCents: 'Total paid' }

function MoneyInput({ value, label, onChange }: { value: number | null; label: string; onChange: (value: number | null) => void }) {
  const [text, setText] = useState(value === null ? '' : (value / 100).toFixed(2))
  return <input aria-label={label} inputMode="decimal" value={text} maxLength={10} onChange={e => {
    const next = e.target.value
    if (!/^\d{0,7}(\.\d{0,2})?$/.test(next)) return
    setText(next)
    const [whole, fraction = ''] = next.split('.')
    onChange(next === '' || next === '.' ? null : Number(whole || 0) * 100 + Number(fraction.padEnd(2, '0')))
  }} />
}

export function ReceiptCosts({ jobId, token, invoiceTotalCents, paymentsCents, feesCents, onViewReceipt }: { jobId: string; token?: string; invoiceTotalCents: number; paymentsCents: number; feesCents: number; onViewReceipt: (attachment: JobAttachmentMetadata) => void }) {
  const [records, setRecords] = useState<ReceiptRecord[]>([])
  const [addOpen, setAddOpen] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [draft, setDraft] = useState<ReceiptRecord | null>(null)
  const [voidId, setVoidId] = useState('')
  const [removeRecord, setRemoveRecord] = useState<ReceiptRecord | null>(null)
  const [removePhoto, setRemovePhoto] = useState(true)
  const [acknowledged, setAcknowledged] = useState(false)
  const [confirmError, setConfirmError] = useState('')
  const picker = useRef<HTMLInputElement>(null)
  const camera = useRef<HTMLInputElement>(null)
  const lock = useRef(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const refresh = useCallback(async () => {
    const data = await receiptRequest<{ receipts: ReceiptRecord[]; aiEnabled: boolean }>(jobId, token)
    if (!alive.current) return
    setRecords(data.receipts); setEnabled(data.aiEnabled); setLoaded(true); setError('')
  }, [jobId, token])
  useEffect(() => {
    const reload = () => { if (!lock.current) void refresh().catch(e => { if (alive.current) setError(e.message) }) }
    reload(); window.addEventListener('focus', reload)
    return () => window.removeEventListener('focus', reload)
  }, [refresh])

  async function action(label: string, fn: () => Promise<void>) {
    if (lock.current) return
    lock.current = true; setBusy(label); setError('')
    try { await fn() } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : 'Unable to process receipt') }
    finally { lock.current = false; if (alive.current) setBusy('') }
  }
  async function scan(attachmentId: string) {
    const result = await receiptRequest<{ receipt: ReceiptRecord }>(jobId, token, '', { attachmentId })
    if (!alive.current) return
    setDraft(result.receipt.status === 'draft' ? result.receipt : null); setAcknowledged(false); setConfirmError('')
    await refresh()
  }
  async function upload(original: File) {
    if (original.size > 10000000) throw new Error('Choose a receipt photo under 10 MB')
    // Materialize Android content-provider files before releasing the picker.
    const bytes = await original.arrayBuffer()
    const file = await compatibleImageFile(new File([bytes], original.name || 'receipt.jpg', {
      type: resolveGalleryFileMimeType(original) || original.type,
      lastModified: original.lastModified,
    }))
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 10000000) throw new Error('Choose a JPG, PNG, HEIC or WebP photo under 10 MB')
    const session = await createAttachmentUploadSession(jobId, { filename: file.name, mimeType: file.type, sizeBytes: file.size, idempotencyKey: crypto.randomUUID() }, token)
    await uploadAttachmentFile(session.upload.url, file, { headers: session.upload.headers })
    await completeAttachmentUpload(jobId, session.attachment.id, token)
    await refresh()
    await scan(session.attachment.id)
  }
  function picked(input: HTMLInputElement) {
    const file = input.files?.[0]
    if (!file) return
    void action('Uploading and reading receipt...', async () => {
      try { await upload(file) } finally { input.value = '' }
    })
  }
  function edit(data: ReceiptData) { if (draft) setDraft({ ...draft, data }); setAcknowledged(false); setConfirmError('') }
  const costs = receiptCosts(records)
  return <div className="receipt-costs">
    {loaded ? <dl className="receipt-summary">
      <div><dt>Parts expenses</dt><dd>{money(costs)}</dd></div>
      <div><dt>Recorded payment fees</dt><dd>{money(feesCents)}</dd></div>
      <div><dt>Payments less recorded costs</dt><dd>{money(paymentsCents - costs - feesCents)}</dd></div>
      <div className="receipt-net-income"><dt>Net Income<small>Invoice total minus parts expenses</small></dt><dd>{money(invoiceTotalCents - costs)}</dd></div>
    </dl> : null}
    {!loaded && !error ? <p role="status">Loading receipts...</p> : null}
    {loaded && !enabled ? <p role="status">AI scanning is not connected yet. OpenAI API configuration is required.</p> : null}
    {error ? <div><p className="receipt-error" role="alert">{error}</p><button className="secondary-action" disabled={!!busy} onClick={() => void action('Loading receipts...', refresh)}>Reload receipts</button></div> : null}
    <div className="receipt-add-controls">
      <button type="button" className="receipt-add-button" aria-label="Add receipt" title="Add receipt" aria-expanded={addOpen} disabled={!enabled || !!busy} onClick={() => setAddOpen(value => !value)}><Plus size={26} /></button>
      {addOpen ? <div className="receipt-add-menu" role="group" aria-label="Add receipt options">
        <button type="button" disabled={!!busy} onClick={() => { setAddOpen(false); camera.current?.click() }}><Camera size={18} />Take photo</button>
        <button type="button" disabled={!!busy} onClick={() => { setAddOpen(false); picker.current?.click() }}><Upload size={18} />Choose file</button>
      </div> : null}
    </div>
    <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={e => picked(e.currentTarget)} />
    <input ref={picker} type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif" hidden onChange={e => picked(e.currentTarget)} />
    {busy ? <p role="status">{busy}</p> : null}
    {draft?.data ? <form key={draft.id} className="receipt-review" noValidate onSubmit={e => {
      e.preventDefault()
      const missing = []
      if (!draft.data!.supplier.trim()) missing.push('supplier')
      if (!draft.data!.date) missing.push('receipt date')
      if (draft.data!.currency !== 'USD') missing.push('currency (USD)')
      if (draft.data!.totalCents === null || draft.data!.totalCents <= 0) missing.push('total paid greater than $0.00')
      if (missing.length) { setConfirmError(`Complete these fields: ${missing.join(', ')}.`); return }
      try { validateReceipt(draft.data, true) } catch (error) { setConfirmError((error as Error).message); return }
      if (!acknowledged) { setConfirmError('Check "I checked the receipt and total paid" before confirming.'); return }
      setConfirmError('')
      void action('Saving expense...', async () => {
        await receiptRequest(jobId, token, `/${encodeURIComponent(draft.id)}/confirm`, { data: draft.data })
        if (alive.current) setDraft(null)
        await refresh()
      })
    }}>
      <h4>Review receipt</h4>
      <fieldset disabled={!!busy}>
        <label>Supplier<input required maxLength={200} value={draft.data.supplier} onChange={e => edit({ ...draft.data!, supplier: e.target.value })} /></label>
        <label>Receipt date<input required type="date" value={draft.data.date} onChange={e => edit({ ...draft.data!, date: e.target.value })} /></label>
        <label>Currency<select value={draft.data.currency} onChange={e => edit({ ...draft.data!, currency: e.target.value })}><option value={draft.data.currency}>{draft.data.currency || 'Unknown'}</option>{draft.data.currency !== 'USD' ? <option value="USD">USD</option> : null}</select></label>
        {draft.data.items.map((item, index) => <div className="receipt-item" key={index}>
          <label>Item {index + 1}<input value={item.description} maxLength={500} onChange={e => edit({ ...draft.data!, items: draft.data!.items.map((i, n) => n === index ? { ...i, description: e.target.value } : i) })} /></label>
          <label>Part number<input value={item.partNumber} maxLength={100} onChange={e => edit({ ...draft.data!, items: draft.data!.items.map((i, n) => n === index ? { ...i, partNumber: e.target.value } : i) })} /></label>
          <label>Line amount<MoneyInput label={`Item ${index + 1} amount`} value={item.amountCents} onChange={amountCents => edit({ ...draft.data!, items: draft.data!.items.map((i, n) => n === index ? { ...i, amountCents } : i) })} /></label>
        </div>)}
        <div className="receipt-amounts">{amountKeys.map(key => <label key={key}>{labels[key]}<MoneyInput label={labels[key]} value={draft.data![key]} onChange={value => edit({ ...draft.data!, [key]: value })} /></label>)}</div>
        {receiptMismatch(draft.data) ? <p role="alert">Subtotal, tax and shipping do not match the total. Check discounts and the original receipt.</p> : null}
        <label className="receipt-check"><input type="checkbox" checked={acknowledged} onChange={e => { setAcknowledged(e.target.checked); setConfirmError('') }} />I checked the receipt and total paid.</label>
        {confirmError ? <p className="receipt-error" role="alert">{confirmError}</p> : null}
        <div className="receipt-actions"><button className="primary-action" type="submit" disabled={!!busy}>Confirm expense</button><button className="secondary-action" type="button" onClick={() => setDraft(null)}>Close</button></div>
      </fieldset>
    </form> : null}
    <div className="receipt-list">{records.map(r => <article key={r.id} className="receipt-entry">
      <div><strong>{r.data?.supplier || 'Receipt'}</strong><strong>{r.data?.totalCents != null ? r.data.currency === 'USD' ? money(r.data.totalCents) : `${(r.data.totalCents / 100).toFixed(2)} ${r.data.currency || '(unknown currency)'}` : ''}</strong></div>
      <small>{r.data?.date || ''} · {r.status}</small>
      <div className="receipt-actions">
        <button type="button" className="secondary-action" disabled={!!busy} onClick={() => void action('Opening receipt...', async () => {
          const result = await fetchJobAttachments(jobId, token)
          const photo = [...result.attachments, ...(result.archivedAttachments || [])].find(a => a.id === r.attachment_id && a.upload_status === 'ready')
          if (!photo) throw new Error('Receipt photo is unavailable. Reload receipts and try again.')
          if (alive.current) onViewReceipt(photo)
        })}><FileImage size={16} />View receipt</button>
        {r.status === 'draft' ? <button type="button" className="secondary-action" disabled={!!busy} onClick={() => { setDraft(structuredClone(r)); setAcknowledged(false); setConfirmError('') }}>Review</button> : null}
        {r.status === 'confirmed' ? <button type="button" className="secondary-action" disabled={!!busy} onClick={() => setVoidId(r.id)}>Void expense</button> : null}
        {['draft', 'failed', 'voided', 'confirmed'].includes(r.status) ? <button type="button" className="secondary-action" disabled={!!busy} onClick={() => { setRemoveRecord(r); setRemovePhoto(!r.confirmed_at && r.status !== 'confirmed') }}><Trash2 size={16} />Delete receipt</button> : null}
      </div>
      {voidId === r.id ? <div><p>Void this expense? The receipt will remain in history.</p><button className="secondary-action" disabled={!!busy} onClick={() => void action('Voiding expense...', async () => { await receiptRequest(jobId, token, `/${r.id}/void`, {}); setVoidId(''); await refresh() })}>Confirm void</button><button className="secondary-action" onClick={() => setVoidId('')}>Keep expense</button></div> : null}
      {removeRecord?.id === r.id ? <div className="receipt-delete-confirmation">
        <p>{r.status === 'confirmed' ? 'Delete this receipt and cancel its parts expense? Net Income will be recalculated. The expense history and original photo will be retained.' : r.confirmed_at ? 'Remove this voided receipt from the list? The expense history and original photo will be retained.' : 'Delete this incorrect receipt scan?'}</p>
        {!r.confirmed_at && r.status !== 'confirmed' ? <label className="receipt-check"><input type="checkbox" checked={removePhoto} disabled={!!busy} onChange={e => setRemovePhoto(e.target.checked)} />Also hide the photo from Attachments (kept in history)</label> : null}
        <div className="receipt-actions"><button type="button" className="secondary-action" disabled={!!busy} onClick={() => void action('Deleting receipt...', async () => {
          try {
            if (r.status === 'confirmed') await receiptRequest(jobId, token, `/${encodeURIComponent(r.id)}/void`, {})
            await receiptRequest(jobId, token, `/${encodeURIComponent(r.id)}/discard`, {})
          } catch (error) {
            await refresh()
            throw error
          }
          setRemoveRecord(null)
          if (draft?.id === r.id) setDraft(null)
          let photoError = false
          if (removePhoto && !r.confirmed_at && r.status !== 'confirmed') {
            try { await deleteJobAttachment(jobId, r.attachment_id, token) } catch { photoError = true }
          }
          await refresh()
          if (photoError) throw new Error('Receipt scan removed. The photo could not be removed; you can retry from Attachments.')
        })}>Confirm delete</button><button type="button" className="secondary-action" disabled={!!busy} onClick={() => setRemoveRecord(null)}>Keep receipt</button></div>
      </div> : null}
    </article>)}</div>
  </div>
}
