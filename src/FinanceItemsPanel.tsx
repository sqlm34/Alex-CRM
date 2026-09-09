import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, Archive, BookOpen, ChevronDown, Minus, MoreVertical, Pencil, Plus, Search, X } from 'lucide-react'
import type { FinanceItem, PriceBookItem } from './App'
import { pricingVersionForLabel, maxBasePriceCents, salePriceFromBase } from './itemPricing'
import './FinanceItemsPanel.css'

const money = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100)
const id = () => `item-${crypto.randomUUID()}`
type Props = {
  items: FinanceItem[]
  catalog: PriceBookItem[]
  loading: boolean
  error: string
  isOwner: boolean
  disabled: boolean
  catalogEditorOpen: boolean
  backRef: RefObject<(() => boolean) | null>
  normalizeItem: (item: Partial<FinanceItem>) => FinanceItem
  onCommit: (items: FinanceItem[]) => Promise<boolean>
  onManageCatalog: (item: PriceBookItem | null, opener: HTMLElement) => void
  onArchiveCatalog: (item: PriceBookItem) => void
  summary: { subtotal: number; discount: number; tax: number; total: number; due: number }
}

export function FinanceItemsPanel(props: Props) {
  const { items, catalog, isOwner, disabled, normalizeItem, backRef, catalogEditorOpen } = props
  const [view, setView] = useState<'book' | 'detail' | 'edit' | null>(null)
  const [draft, setDraft] = useState<FinanceItem | null>(null)
  const [existing, setExisting] = useState(false)
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState(true)
  const [menu, setMenu] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const busyRef = useRef(false)
  const alive = useRef(true)
  const dialog = useRef<HTMLDivElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  const backAction = useRef<() => boolean>(() => false)
  const editorBack = useRef<(() => boolean) | null>(null)
  const editReturn = useRef<'book' | 'detail' | null>('detail')
  const open = view !== null

  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const close = () => {
    if (busyRef.current) return
    setView(null); setDraft(null); setError(''); setMenu(null)
    requestAnimationFrame(() => opener.current?.focus())
  }
  const back = () => {
    if (!view) return false
    if (busyRef.current) return true
    if (view === 'edit') { editorBack.current?.(); return true }
    if (view === 'detail' && !existing) { setView('book'); setError(''); return true }
    close(); return true
  }
  useEffect(() => {
    backAction.current = back
    backRef.current = back
    return () => { backRef.current = null }
  })
  useEffect(() => {
    if (!open) return
    const previous = document.body.style.overflow
    const background = document.getElementById('root')
    const wasInert = background?.inert ?? false
    document.body.style.overflow = 'hidden'
    if (background) background.inert = true
    const viewport = window.visualViewport
    const resize = () => {
      const overlay = dialog.current?.parentElement
      if (!overlay) return
      overlay.style.height = `${viewport?.height ?? window.innerHeight}px`
      overlay.style.top = `${viewport?.offsetTop ?? 0}px`
    }
    resize(); viewport?.addEventListener('resize', resize); viewport?.addEventListener('scroll', resize)
    const frame = requestAnimationFrame(() => {
      if (!dialog.current?.contains(document.activeElement)) dialog.current?.focus()
    })
    return () => {
      document.body.style.overflow = previous
      if (background) background.inert = wasInert
      viewport?.removeEventListener('resize', resize); viewport?.removeEventListener('scroll', resize)
      cancelAnimationFrame(frame)
    }
  }, [open])
  useEffect(() => {
    if (!open || catalogEditorOpen) return
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); backAction.current() }
      if (event.key !== 'Tab') return
      const nodes = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),[tabindex="0"]') ?? [])].filter(n => n.getClientRects().length)
      const first = nodes[0], last = nodes.at(-1)
      if (!first || !last) return
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [open, catalogEditorOpen])

  const choose = (item?: PriceBookItem) => {
    const base = item?.unitPriceCents ?? 0
    if (base > maxBasePriceCents) { setError('Base price is outside the supported range'); return }
    setDraft(normalizeItem({ id: id(), label: item?.name ?? '', description: item?.description ?? '',
      baseUnitPriceCents: base, pricingVersion: pricingVersionForLabel(item?.name), quantity: 1, discountCents: 0,
      taxable: item?.taxable ?? false, taxRateBps: 0, priceBookItemId: item?.id ?? null }))
    editReturn.current = 'book'
    setExisting(false); setError(''); setView(item ? 'detail' : 'edit')
  }
  const commit = async (next: FinanceItem[]) => {
    if (busyRef.current || disabled) return false
    busyRef.current = true; setBusy(true); setError('')
    try {
      const saved = await props.onCommit(next)
      if (alive.current && !saved) setError('Unable to save. Your item is still here. Try again.')
      return saved
    } catch {
      if (alive.current) setError('Unable to save. Your item is still here. Try again.')
      return false
    } finally {
      busyRef.current = false
      if (alive.current) setBusy(false)
    }
  }
  const save = async () => {
    if (!draft || busyRef.current) return
    // Reuse the draft ID on retry, including a response lost after commit.
    const next = items.some(item => item.id === draft.id)
      ? items.map(item => item.id === draft.id ? normalizeItem(draft) : item)
      : [...items, normalizeItem(draft)]
    if (await commit(next) && alive.current) close()
  }
  const remove = async (item: FinanceItem) => {
    if (!window.confirm(`Delete ${item.label || 'item'}?`)) return
    if (await commit(items.filter(row => row.id !== item.id)) && alive.current) setMenu(null)
  }
  const visible = catalog.filter(item => (item.active || isOwner) && `${item.name} ${item.category} ${item.description}`.toLowerCase().includes(search.toLowerCase()))
  const rates = [...new Set(items.filter(item => item.taxable).map(item => item.taxRateBps ?? 0))]
  const sale = draft?.unitPriceCents ?? Math.round((draft?.amount ?? 0) * 100)

  return <>
    <section className="fi-items">
      <header className="fi-section-head">
        <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}><ChevronDown size={20} />Items ({items.length})</button>
        <button type="button" aria-label="Add item" title="Add item" disabled={disabled || busy} onClick={event => { opener.current = event.currentTarget; setView('book'); setError('') }}><Plus size={23} /></button>
      </header>
      {expanded && <>
        {items.map(item => <article className="fi-row" key={item.id}>
          <div className="fi-row-copy"><strong>{item.label || 'Item'}</strong><b>{money(item.lineTotalCents ?? Math.round(item.amount * 100))}</b>
            <span>{item.quantity ?? 1} × {money(item.unitPriceCents ?? Math.round(item.amount * 100))}</span>
            {item.taxable && <small className="fi-taxable">Taxable</small>}
          </div>
          <div className="fi-actions"><button type="button" title="Item actions" aria-label={`Actions for ${item.label || 'item'}`} aria-expanded={menu === item.id} onClick={() => setMenu(menu === item.id ? null : item.id)}><MoreVertical size={21} /></button>
            {menu === item.id && <div className="fi-menu"><button type="button" disabled={busy || disabled} onClick={event => { opener.current = event.currentTarget.closest('.fi-actions')?.querySelector('button') ?? event.currentTarget; editReturn.current = null; setDraft({ ...item }); setExisting(true); setView('edit'); setMenu(null); setError('') }}>Edit</button><button type="button" disabled={busy || disabled} onClick={() => void remove(item)}>Delete</button></div>}
          </div>
        </article>)}
        {!items.length && <p className="fi-empty">No items</p>}
        <dl className="fi-totals">
          <div><dt>Subtotal</dt><dd>{money(props.summary.subtotal)}</dd></div>
          <div><dt>Tax rate {rates.length > 1 ? 'Multiple' : `${((rates[0] ?? 0) / 100).toFixed(2)}%`}</dt><dd>{money(props.summary.tax)}</dd></div>
          <div><dt>Discount</dt><dd>{money(props.summary.discount)}</dd></div>
          <div className="fi-total"><dt>Total</dt><dd>{money(props.summary.total)}</dd></div>
          <div><dt>Due</dt><dd>{money(props.summary.due)}</dd></div>
        </dl>
      </>}
      {!view && error && <p role="alert">{error}</p>}
    </section>
    {view && createPortal(<div className="fi-overlay" onClick={event => { if (event.target === event.currentTarget && !catalogEditorOpen) back() }}>
      <div className="fi-dialog" role="dialog" aria-modal="true" aria-label={view === 'book' ? 'Price Book' : view === 'edit' ? 'Edit job item' : 'Selected item'} tabIndex={-1} ref={dialog}>
        {view === 'book' ? <>
          <header className="fi-header"><button type="button" aria-label="Close Price Book" onClick={close}><X /></button><h3><BookOpen size={22} />Price Book</h3>{isOwner && <button type="button" onClick={e => props.onManageCatalog(null, e.currentTarget)}><Plus size={18} />Add new</button>}</header>
          <div className="fi-scroll"><label className="fi-search"><Search size={20} /><input aria-label="Search Price Book" placeholder="Search" value={search} onChange={e => setSearch(e.target.value)} /></label>
            <button className="fi-custom" type="button" onClick={() => choose()}><Plus size={18} />Custom item</button>
            {props.loading && <p>Loading...</p>}{props.error && <p role="alert">{props.error}</p>}
            {visible.map(item => <article className="fi-catalog-row" key={item.id}>
              <button className="fi-catalog-select" type="button" disabled={!item.active || item.unitPriceCents > maxBasePriceCents} onClick={() => choose(item)}><strong>{item.name}</strong><span>{item.unitPriceCents <= maxBasePriceCents ? money(salePriceFromBase(item.unitPriceCents, pricingVersionForLabel(item.name))) : 'Price unavailable'}</span>{!item.active && <small>Archived</small>}</button>
              {isOwner && <div className="fi-catalog-actions"><button aria-label={`Edit catalog ${item.name}`} title="Edit catalog item" type="button" onClick={e => props.onManageCatalog(item, e.currentTarget)}><Pencil size={19} /></button>{item.active && <button aria-label={`Archive catalog ${item.name}`} title="Archive catalog item" type="button" onClick={() => { if (window.confirm(`Archive ${item.name}?`)) props.onArchiveCatalog(item) }}><Archive size={19} /></button>}</div>}
            </article>)}
            {!visible.length && !props.loading && <p>No price book items</p>}
          </div>
        </> : view === 'edit' && draft ? <ItemEditor key={draft.id} item={draft} isNew={!existing} isOwner={isOwner} backRef={editorBack} onCancel={() => editReturn.current ? setView(editReturn.current) : close()} onSave={item => { setDraft(normalizeItem(item)); setView('detail') }} /> : draft && <>
          <header className="fi-header"><button aria-label="Back" type="button" disabled={busy} onClick={back}><ArrowLeft /></button><span /><button type="button" disabled={busy} onClick={() => { editReturn.current = 'detail'; setView('edit') }}><Pencil size={18} />Edit</button></header>
          <div className="fi-scroll fi-selected"><h3>{draft.label || 'Item'}</h3>{draft.description && <p>{draft.description}</p>}<div className="fi-price-quantity"><strong>{money(sale)}</strong><div className="fi-stepper"><button aria-label="Decrease quantity" type="button" disabled={busy || (draft.quantity ?? 1) <= 1} onClick={() => setDraft(normalizeItem({ ...draft, quantity: Math.max(1, (draft.quantity ?? 1) - 1) }))}><Minus size={19} /></button><output aria-label="Quantity">{draft.quantity ?? 1}</output><button aria-label="Increase quantity" type="button" disabled={busy || (draft.quantity ?? 1) >= 9999.999} onClick={() => setDraft(normalizeItem({ ...draft, quantity: (draft.quantity ?? 1) + 1 }))}><Plus size={19} /></button></div></div>{draft.taxable && <small className="fi-taxable">Taxable</small>}</div>
          <footer className="fi-footer"><button className="primary-action" type="button" disabled={busy || disabled || !draft.label.trim()} onClick={() => void save()}>{busy ? 'Saving...' : `${existing ? 'Save to job' : 'Add to job'} (${money(draft.lineTotalCents ?? Math.round(draft.amount * 100))})`}</button></footer>
        </>}
        {error && <p className="fi-error" role="alert">{error}</p>}
      </div>
    </div>, document.body)}
  </>
}

function ItemEditor({ item, isNew, isOwner, backRef, onSave, onCancel }: {
  item: FinanceItem; isNew: boolean; isOwner: boolean; backRef: RefObject<(() => boolean) | null>
  onSave: (item: FinanceItem) => void; onCancel: () => void
}) {
  const base = isOwner ? item.baseUnitPriceCents ?? (!item.pricingVersion ? item.unitPriceCents ?? Math.round(item.amount * 100) : undefined) : item.baseUnitPriceCents
  const initial = { name: item.label, description: item.description ?? '', price: base === undefined ? '' : (base / 100).toFixed(2), taxable: Boolean(item.taxable), discount: ((item.discountCents ?? 0) / 100).toFixed(2), tax: ((item.taxRateBps ?? 0) / 100).toFixed(2) }
  const [fields, setFields] = useState(initial)
  const [error, setError] = useState('')
  const nameRef = useRef<HTMLInputElement>(null)
  const cancel = () => { if (JSON.stringify(fields) === JSON.stringify(initial) || window.confirm('Discard changes?')) onCancel(); return true }
  useEffect(() => { backRef.current = cancel; return () => { backRef.current = null } })
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (!nameRef.current?.form?.contains(document.activeElement)) nameRef.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [])
  const updateField = <K extends keyof typeof initial>(key: K, value: (typeof initial)[K]) => {
    setFields(current => ({ ...current, [key]: value }))
  }
  const parse = (value: string) => /^\d+(\.\d{0,2})?$/.test(value) ? Math.round(Number(value) * 100) : NaN
  return <form className="fi-editor" onSubmit={e => {
    e.preventDefault()
    const price = parse(fields.price), discount = parse(fields.discount), tax = parse(fields.tax)
    const changedBase = (fields.price !== initial.price && price !== base) ||
      (isNew && pricingVersionForLabel(fields.name) !== item.pricingVersion)
    if (!fields.name.trim() || (changedBase && (!Number.isSafeInteger(price) || price > maxBasePriceCents)) || !Number.isSafeInteger(discount) || discount > 99999999 || !Number.isSafeInteger(tax) || tax > 10000) { setError('Enter a name and valid non-negative prices and tax rate.'); return }
    onSave({ ...item, label: fields.name.trim(), description: fields.description, taxable: fields.taxable, discountCents: discount, taxRateBps: tax,
      ...(changedBase ? { baseUnitPriceCents: price, pricingVersion: pricingVersionForLabel(fields.name) } : {}) })
  }}>
    <header className="fi-header"><button type="button" aria-label="Cancel item edit" onClick={cancel}><ArrowLeft /></button><h3>Edit item</h3><span /></header>
    <div className="fi-scroll"><label>Name<input ref={nameRef} required maxLength={240} value={fields.name} onChange={e => updateField('name', e.target.value)} /></label>
      <label>Base price<input inputMode="decimal" aria-label="Base price" value={fields.price} onChange={e => updateField('price', e.target.value)} /></label>
      <label>Description<textarea aria-label="Description" rows={4} maxLength={4000} value={fields.description} onChange={e => updateField('description', e.target.value)} /></label>
      <label className="fi-check"><input type="checkbox" checked={fields.taxable} onChange={e => updateField('taxable', e.target.checked)} />Taxable</label>
      <div className="fi-adjustments"><label>Discount<input inputMode="decimal" value={fields.discount} onChange={e => updateField('discount', e.target.value)} /></label><label>Tax rate (%)<input inputMode="decimal" value={fields.tax} onChange={e => updateField('tax', e.target.value)} /></label></div>
      {error && <p role="alert">{error}</p>}
    </div>
    <footer className="fi-footer"><button type="button" onClick={cancel}>Cancel</button><button className="primary-action" type="submit">Save</button></footer>
  </form>
}
