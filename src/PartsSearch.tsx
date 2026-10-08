import { useEffect, useRef, useState } from 'react'
import { Camera, Upload, Search, ExternalLink, Plus, ChevronDown } from 'lucide-react'
import { partsRequest, scanPartsLabel } from './api'
import { compatibleImageFile } from './heicImages'
import { resolveGalleryFileMimeType } from './attachmentUtils'
import type { ApplianceIdentity, PartResult, PartSearch, SupplierResponse, ModelLookup, CatalogModel } from '../shared/parts'
import './PartsSearch.css'
import { searsModelSearchUrl } from './modelDiagramLinks'
import { isOemPartNumber } from '../shared/parts'
import { readLabelFile } from './readLabelFile'

const emptyIdentity: ApplianceIdentity = { brand: '', model: '', serial: '', applianceType: '', confidence: 0, alternatives: [] }
const money = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100)
const names = { reliable: 'Reliable Parts', marcone: 'Marcone' }
const statusLabels = { CONNECTED: 'Connected', CATALOG_ONLY: 'Catalog available; account price and stock require sign-in', NOT_CONFIGURED: 'Server connection not configured', LOGIN_REQUIRED: 'Supplier sign-in required', SUPPLIER_UNAVAILABLE: 'Supplier unavailable', SEARCH_TIMEOUT: 'Search timed out', MODEL_NOT_FOUND: 'Model not found', PART_NOT_FOUND: 'Part not found' }
type SavedPart = { id: string; part_number: string; description: string; quantity: number; total_cost_cents: number | string; supplier: 'reliable' | 'marcone' }
type State = { scan: { identity: ApplianceIdentity } | null; parts: SavedPart[]; aiEnabled: boolean; suppliers: SupplierResponse[] }

export function PartsSearch({ jobId, token }: { jobId: string; token?: string }) {
  const [open, setOpen] = useState(false)
  return <section className="parts-search">
    <button type="button" className="parts-heading" aria-expanded={open} onClick={() => setOpen(!open)}><Search size={18} />AI Parts Search<ChevronDown size={18} /></button>
    {open ? <PartsWorkspace key={jobId} jobId={jobId} token={token} /> : null}
  </section>
}

function PartsWorkspace({ jobId, token }: { jobId: string; token?: string }) {
  const [state, setState] = useState<State | null>(null)
  const [identity, setIdentity] = useState<ApplianceIdentity>(emptyIdentity)
  const [confirmed, setConfirmed] = useState(false)
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<PartSearch | null>(null)
  const [models, setModels] = useState<ModelLookup | null>(null)
  const [selectedModel, setSelectedModel] = useState<CatalogModel | null>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const camera = useRef<HTMLInputElement>(null)
  const gallery = useRef<HTMLInputElement>(null)
  const lock = useRef(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    const controller = new AbortController()
    void partsRequest<State>(jobId, token, '', undefined, controller.signal).then(data => {
      if (!alive.current) return
      setState(data); setIdentity(data.scan?.identity || emptyIdentity); setError('')
    }).catch(e => { if (!controller.signal.aborted) setError(e.message) })
    return () => { alive.current = false; controller.abort() }
  }, [jobId, token, retry])

  async function action(message: string, fn: () => Promise<void>) {
    if (lock.current) return
    lock.current = true; setBusy(message); setError('')
    try { await fn() } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : 'Please retry') }
    finally { lock.current = false; if (alive.current) setBusy('') }
  }
  function picked(input: HTMLInputElement) {
    const original = input.files?.[0]
    if (!original) return
    void action('Uploading and reading label...', async () => {
      try {
        if (original.size > 10000000) throw new Error('Choose a label photo under 10 MB')
        const local = await readLabelFile(original)
        const file = await compatibleImageFile(new File([local], local.name, { type: resolveGalleryFileMimeType(local) || local.type }))
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 10000000) throw new Error('Choose a JPG, PNG, HEIC or WebP label photo under 10 MB')
        const scan = await scanPartsLabel<{ identity: ApplianceIdentity }>(jobId, token, file)
        if (alive.current) { setIdentity(scan.identity); setConfirmed(false); setResult(null); setModels(null); setSelectedModel(null) }
        if (scan.identity.model.length >= 4 && scan.identity.brand) {
          try {
            const found = await partsRequest<ModelLookup>(jobId, token, '/models', { model: scan.identity.model, brand: scan.identity.brand })
            if (alive.current) setModels(found)
          } catch {
            if (alive.current) setError('Label read successfully. Model catalog unavailable; retry Find model / diagrams or use Sears PartsDirect.')
          }
        }
      } finally { input.value = '' }
    })
  }
  function edit(key: keyof Pick<ApplianceIdentity, 'brand' | 'model' | 'serial' | 'applianceType'>, value: string) {
    setIdentity(current => ({ ...current, [key]: value })); setConfirmed(false); setResult(null); setSelectedModel(null)
    if (key === 'brand' || key === 'model') { setModels(null); setSelectedModel(null) }
  }
  const connected = state?.suppliers.some(s => s.status === 'CONNECTED' || s.status === 'CATALOG_ONLY')
  const searsSearchUrl = searsModelSearchUrl(identity.brand, identity.model)
  const canSearch = confirmed || isOemPartNumber(query)
  return <div className="parts-workspace" aria-busy={!!busy}>
    {error ? <p role="alert" className="parts-error">{error}</p> : null}
    {!state ? <button type="button" onClick={() => setRetry(n => n + 1)}>{error ? 'Retry' : 'Loading parts...'}</button> : <>
      <div className="parts-actions">
        <button type="button" disabled={!!busy || !state.aiEnabled} onClick={() => camera.current?.click()}><Camera size={18} />Scan label</button>
        <button type="button" disabled={!!busy || !state.aiEnabled} onClick={() => gallery.current?.click()}><Upload size={18} />Gallery</button>
      </div>
      <input hidden ref={camera} type="file" accept="image/*" capture="environment" onChange={e => picked(e.currentTarget)} />
      <input hidden ref={gallery} type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif" onChange={e => picked(e.currentTarget)} />
      {busy ? <p role="status">{busy}</p> : null}
      <fieldset disabled={!!busy} className="parts-identity">
        {(['brand', 'model', 'serial', 'applianceType'] as const).map(key => <label key={key}>{({ brand: 'Brand', model: 'Model', serial: 'Serial', applianceType: 'Appliance type' })[key]}<input value={identity[key]} maxLength={100} onChange={e => edit(key, e.target.value)} /></label>)}
        {identity.model && identity.confidence < 0.8 ? <p>Check the model against the original label.</p> : null}
        {identity.alternatives.length ? <p>Possible readings: {identity.alternatives.join(', ')}</p> : null}
      </fieldset>
      <button type="button" disabled={!!busy || identity.model.trim().length < 4 || !identity.brand.trim()} onClick={() => void action('Finding model diagrams...', async () => {
        setModels(null); setSelectedModel(null); setConfirmed(false); setResult(null)
        const found = await partsRequest<ModelLookup>(jobId, token, '/models', { model: identity.model, brand: identity.brand })
        if (alive.current) setModels(found)
      })}><Search size={18} />Find model / diagrams</button>
      {models ? <section className="parts-models" aria-label="Catalog models">
        <h4><img className="parts-supplier-logo" src="/supplier-logos/reliable.svg" alt="Reliable Parts models" /></h4>
        {!models.models.length ? <p>No matching models returned by the catalog.</p> : null}
        {models.truncated ? <p>More models available. Enter more model characters.</p> : null}
        <fieldset disabled={!!busy}>
          {models.models.map(model => <label className="parts-model-choice" key={`${model.brand}:${model.model}`}>
            <input type="radio" name={`catalog-model-${jobId}`} checked={selectedModel?.model === model.model} onChange={() => {
              setSelectedModel(model); setIdentity(current => ({ ...current, model: model.model, brand: model.brand })); setConfirmed(true); setResult(null)
            }} />
            <span>{model.brand} <strong>{model.model}</strong></span>
          </label>)}
        </fieldset>
        {selectedModel ? <a href={selectedModel.diagramUrl} target="_blank" rel="noreferrer"><ExternalLink size={16} />View diagrams</a> : null}
      </section> : null}
      {searsSearchUrl ? <a className="parts-diagram-fallback" href={searsSearchUrl} target="_blank" rel="noopener noreferrer" aria-label="Search model diagrams on Sears PartsDirect" title="Search model diagrams on Sears PartsDirect"><Search size={20} /><img src="/supplier-logos/sears.svg" alt="" /></a> : null}
      <form onSubmit={e => { e.preventDefault(); if (!canSearch || !connected || !query.trim()) return; void action('Searching suppliers...', async () => {
        const data = await partsRequest<PartSearch>(jobId, token, '/search', { identity, query, confirmed, requestKey: crypto.randomUUID() })
        if (alive.current) setResult(data)
      }) }}>
        <label>Part needed<input value={query} maxLength={200} disabled={!!busy} onChange={e => { setQuery(e.target.value); setResult(null) }} /></label>
        <button type="submit" disabled={!!busy || !canSearch || !connected || (!state.aiEnabled && !isOemPartNumber(query)) || !query.trim()}><Search size={18} />Search suppliers</button>
      </form>
      <div className="parts-suppliers">{(result?.suppliers || state.suppliers).map(s => <section key={s.supplier}>
        <h4><img className="parts-supplier-logo" src={`/supplier-logos/${s.supplier === 'reliable' ? 'reliable.svg' : 'marcone.png'}`} alt={names[s.supplier]} /></h4><p role="status">{busy === 'Searching suppliers...' ? 'Searching...' : statusLabels[s.status]}</p>
        {result && s.status === 'CONNECTED' && !s.results.length ? <p>No verified parts found.</p> : null}
        {s.results.map(part => <PartCard key={`${result?.id}:${part.id}`} part={part} disabled={!!busy || state.parts.some(p => p.supplier === part.supplier && p.part_number === part.partNumber)} lowest={result?.suppliers.flatMap(x => x.results).filter(p => p.partNumber === part.partNumber && p.compatibility === 'confirmed' && p.unitCostCents !== null).every(p => p.unitCostCents! >= (part.unitCostCents ?? Infinity)) || false} onAdd={(quantity, compatibilityReviewed) => void action('Adding part...', async () => {
          const data = await partsRequest<{ part: SavedPart }>(jobId, token, '', { searchId: result!.id, resultId: part.id, quantity, compatibilityReviewed })
          if (alive.current) setState(current => current ? { ...current, parts: [...current.parts.filter(p => p.id !== data.part.id), data.part] } : current)
        })} />)}
      </section>)}</div>
      {state.parts.length ? <section className="parts-selected"><h4>Selected parts</h4>{state.parts.map(p => <article key={p.id}><strong>{p.part_number}</strong><span>{names[p.supplier]} · Qty {p.quantity} · {money(Number(p.total_cost_cents))}</span><p>{p.description}</p><small>Supplier quote; not a recorded expense</small></article>)}</section> : null}
    </>}
  </div>
}

function PartCard({ part, lowest, disabled, onAdd }: { part: PartResult; lowest: boolean; disabled: boolean; onAdd: (quantity: number, reviewed: boolean) => void }) {
  const [quantity, setQuantity] = useState(1)
  const [reviewed, setReviewed] = useState(false)
  return <article className="parts-result">
    <strong>{part.partNumber}</strong><p>{part.description}</p>
    {part.replacedPartNumber ? <small>Replaces {part.replacedPartNumber}</small> : null}
    <b>{part.unitCostCents === null ? 'Price unavailable' : money(part.unitCostCents)}</b>
    {lowest && part.unitCostCents !== null && part.compatibility === 'confirmed' ? <small className="parts-best">Lowest returned price</small> : null}
    <p>{part.availability.replaceAll('_', ' ')}{part.quantity !== null ? ` · ${part.quantity} available` : ''}</p><p>{part.warehouse}</p>
    <small>{part.compatibility === 'confirmed' ? 'Exact model match' : part.compatibility === 'requires_review' ? 'Compatibility requires review' : 'Compatibility not verified'} · {new Date(part.retrievedAt).toLocaleString()}</small>
    {part.evidenceSupplier ? <small>Model evidence: {names[part.evidenceSupplier]}</small> : null}
    {part.compatibility === 'requires_review' ? <label className="parts-confirm"><input type="checkbox" checked={reviewed} onChange={e=>setReviewed(e.target.checked)} />I verified this OEM part fits the model</label> : null}
    <div className="parts-actions"><a href={part.productUrl} target="_blank" rel="noreferrer"><ExternalLink size={16} />Supplier</a>{part.evidenceUrl ? <a href={part.evidenceUrl} target="_blank" rel="noreferrer">Model evidence</a> : null}</div>
    <label>Quantity<input type="number" min={1} max={100} value={quantity} onChange={e => setQuantity(Number(e.target.value))} /></label>
    <button type="button" disabled={disabled || part.compatibility === 'not_verified' || (part.compatibility === 'requires_review' && !reviewed) || part.unitCostCents === null || !Number.isInteger(quantity) || quantity < 1 || quantity > 100} onClick={() => onAdd(quantity, reviewed)}><Plus size={16} />Add to job</button>
  </article>
}
