import { useCallback, useEffect, useRef, useState } from 'react'
import { Capacitor } from '@capacitor/core'
import { ArrowLeft, Bell, Check, ChevronDown, Headset, MapPin, RefreshCw, Save, Trash2 } from 'lucide-react'
import { callDate, callTimeZone, groupCallsByDate } from '../shared/receptionist-calendar'
import { callLocationMap, type CallLocation, type summarizeCallLocations } from '../shared/receptionist-location'
import { onPushSync } from './notifications'
import { configuredApiUrl } from './api'
import { defaultReceptionistSettings, type ReceptionistSettings } from '../shared/receptionist'
import { boundaryFingerprint, validateAreaBoundary, zipCoverageStatus, type ZipCoverage } from '../shared/receptionist-area'
import './ReceptionistPage.css'
import { ReceptionistVip } from './ReceptionistVip'
import { BlockedNumbers } from './BlockedNumbers'
import { CallNumberBlock } from './CallNumberBlock'

type Call = { job_id?: string | null; channel?: 'web' | 'phone'; location?: CallLocation; id: string; provider: string; started_at: string; outcome: string; summary: string; phone_last_four: string; caller_phone?: string; duration_ms?: number | string | null; callback_kind?: string; customer: string | null; reason: string | null; callback_status: string | null; cost_cents: number | string | null; latency_ms: number | string | null }
type Stats = { total_calls: number; booked_calls: number; pending_callbacks: number; priced_calls: number; recorded_cost_cents: number | string | null; mean_call_median_latency_ms: number | string | null }
const cost = (cents: number | string | null | undefined) => cents == null ? 'Not reported' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 3 }).format(Number(cents) / 100)
type Diagnostics = { schemaReady: boolean; environmentEnabled: boolean; retellConfigured: boolean; bookingEnabled: boolean; smsEnabled: boolean; recordingsEnabled: boolean; providerRecordingVerified: boolean; liveVerification: string; lastSignedCallAt: string | null }
type Tab = 'Callbacks' | 'Abandoned calls' | 'Dashboard' | 'Calls' | 'Call locations' | 'Settings' | 'Diagnostics' | 'VIP Call Transfer' | 'Blocked Numbers'
export function ReceptionistPage({ token, callId = '', onDetailClosed, onOpenJob, onOpenCustomer }: { token: string; callId?: string; onDetailClosed?: () => void; onOpenJob?: (id: string) => void; onOpenCustomer?: (id: string) => void }) {
  const [tab, setTab] = useState<Tab>('Callbacks')
  const [viewsOpen,setViewsOpen]=useState(false)
  const viewsToggle=useRef<HTMLButtonElement>(null)
  const [calls, setCalls] = useState<Call[]>([])
  const [abandoned, setAbandoned] = useState<Call[]>([])
  const [audio, setAudio] = useState<{ id: string; url?: string; reason?: string }>({ id: '' })
  const [stats, setStats] = useState<Stats | null>(null)
  const [month, setMonth] = useState(() => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Indiana/Indianapolis', year: 'numeric', month: '2-digit' }).formatToParts(new Date())
    return `${parts.find(part => part.type === 'year')!.value}-${parts.find(part => part.type === 'month')!.value}`
  })
  const [locations, setLocations] = useState<(ReturnType<typeof summarizeCallLocations> & { month: string }) | null>(null)
  const [locationError, setLocationError] = useState('')
  const [settings, setSettings] = useState<ReceptionistSettings>(defaultReceptionistSettings)
  const [zipDraft, setZipDraft] = useState('')
  const [primaryZipDraft, setPrimaryZipDraft] = useState('')
  const [candidateZipDraft, setCandidateZipDraft] = useState('')
  const [boundaryDraft, setBoundaryDraft] = useState('')
  const [boundaryHash, setBoundaryHash] = useState('')
  const callbackRequest = useRef<AbortController | null>(null)
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [pushResult, setPushResult] = useState('')
  const [selected, setSelected] = useState<Call | null>(null)
  const [blockPhone, setBlockPhone] = useState('')
  const [dateFilter, setDateFilter] = useState('')
  const timeline = useRef<HTMLDivElement>(null)
  const [deleting, setDeleting] = useState(false)
  const deletedIds = useRef(new Set<string>())
  const detailDialog = useRef<HTMLDialogElement>(null)
  const audioRequest = useRef(0)
  const swipeStart = useRef<{ x: number; y: number; time: number } | null>(null)
  const selectedId = selected?.id
  useEffect(() => {
    if (!selectedId) return
    const dialog = detailDialog.current
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialog?.showModal()
    return () => { onDetailClosed?.(); dialog?.close(); document.body.style.overflow = overflow }
  }, [selectedId, onDetailClosed])
  const [callbackPhone, setCallbackPhone] = useState('')
  const request = useCallback(async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
    const result = await fetch(`${configuredApiUrl}/api/receptionist${path}`, { ...init,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } })
    const data = await result.json()
    if (!result.ok) throw new Error(data.error || 'Unable to load receptionist')
    return data as T
  }, [token])
  useEffect(() => {
    if (tab !== 'Call locations') return
    const controller = new AbortController()
    void request<ReturnType<typeof summarizeCallLocations> & { month: string }>(`/location-stats?month=${encodeURIComponent(month)}`, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) { setLocations(result); setLocationError('') } })
      .catch(error => { if (!controller.signal.aborted) setLocationError(error instanceof Error ? error.message : 'Unable to load call locations') })
    return () => controller.abort()
  }, [request, month, tab, stats])
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const health = await request<Diagnostics>('/diagnostics', { signal })
      setError('')
      setDiagnostics(health)
      if (health.schemaReady) {
        const loadedSettings = await request<ReceptionistSettings>('/settings', { signal })
        setSettings(loadedSettings)
        setZipDraft(loadedSettings.serviceZips.join(', '))
        setPrimaryZipDraft(loadedSettings.northIndianapolis?.primaryZips.join(', ') || '')
        setCandidateZipDraft(loadedSettings.northIndianapolis?.candidateZips.join(', ') || '')
        setBoundaryDraft(loadedSettings.indianapolisBoundary ? JSON.stringify(loadedSettings.indianapolisBoundary, null, 2) : '')
        setBoundaryHash(loadedSettings.indianapolisBoundary ? await boundaryFingerprint(loadedSettings.indianapolisBoundary) : '')
        setCalls((await request<Call[]>('/calls?timeline=true', { signal })).filter(call => !deletedIds.current.has(call.id)))
        setAbandoned((await request<Call[]>('/abandoned?timeline=true', { signal })).filter(call => !deletedIds.current.has(call.id)))
        setStats(await request<Stats>('/stats', { signal }))
      }
    } catch (e) { if (!signal?.aborted) setError(e instanceof Error ? e.message : 'Unable to load receptionist') }
    finally { if (!signal?.aborted) setBusy(false) }
  }, [request])
  useEffect(() => {
    const controller = new AbortController()
    // Clear the previous authenticated user's history when the request identity changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBusy(true)
    setCalls([]); setAbandoned([])
    void load(controller.signal)
    return () => controller.abort()
  }, [load])
  useEffect(() => () => callbackRequest.current?.abort(), [])
  useEffect(() => {
    if (!diagnostics?.schemaReady) return
    const controller = new AbortController()
    let pending = false
    const timer = window.setInterval(async () => {
      if (pending || document.visibilityState === 'hidden') return
      pending = true
      try {
        const rows = await request<Call[]>('/calls?timeline=true', { signal: controller.signal })
        if (!controller.signal.aborted) {
          setCalls(rows.filter(call => !deletedIds.current.has(call.id)))
          setSelected(current => current ? rows.find(row => row.id === current.id) || current : null)
        }
      } catch { /* Keep the loaded history during a temporary network failure. */ }
      finally { pending = false }
    }, 15000)
    return () => { window.clearInterval(timer); controller.abort() }
  }, [request, diagnostics?.schemaReady])
  useEffect(() => { callbackRequest.current?.abort() }, [tab])
  useEffect(() => {
    const controller = new AbortController()
    const refresh = () => { if (document.visibilityState !== 'hidden') void load(controller.signal) }
    const unsubscribe = onPushSync(detail => { if (detail?.event === 'receptionist_callback' || detail?.event === 'receptionist_call') refresh() })
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => { controller.abort(); unsubscribe(); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh) }
  }, [load])
  useEffect(() => {
    if (!callId) return
    const controller = new AbortController()
    void request<Call>(`/calls/${encodeURIComponent(callId)}`, { signal: controller.signal }).then(details => {
      if (controller.signal.aborted) return
      setTab('Calls')
      setSelected(details)
      setCallbackPhone(details.caller_phone || '')
    }).catch(e => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Unable to load callback') })
    return () => controller.abort()
  }, [callId, request])
  async function save() {
    setBusy(true); setError('')
    try {
      const indianapolisBoundary = validateAreaBoundary(boundaryDraft.trim() ? JSON.parse(boundaryDraft) : null)
      const parseZips = (draft: string) => draft.split(',').map(zip => zip.trim()).filter(Boolean)
      const northIndianapolis = { primaryZips: parseZips(primaryZipDraft), candidateZips: parseZips(candidateZipDraft) }
      const serviceZips = [...new Set([...parseZips(zipDraft), ...northIndianapolis.primaryZips, ...northIndianapolis.candidateZips])]
      const zipCoverage = Object.fromEntries(serviceZips.map(zip => [zip, zipCoverageStatus(settings, zip)]))
      const zipOnlyZips = settings.zipOnlyZips?.filter(zip => serviceZips.includes(zip))
      const saved = await request<ReceptionistSettings>('/settings', { method: 'PUT', body: JSON.stringify({ ...settings, zipOnlyZips, zipCoverage, northIndianapolis, indianapolisBoundary: indianapolisBoundary ?? null, serviceZips }) })
      setSettings(saved)
      setBoundaryHash(saved.indianapolisBoundary ? await boundaryFingerprint(saved.indianapolisBoundary) : '')
      setZipDraft(saved.serviceZips.join(', '))
    }
    catch (e) { setError(e instanceof Error ? e.message : 'Unable to save') }
    finally { setBusy(false) }
  }
  async function testPush() {
    if (!window.confirm('Send one test notification to your Android phone? No appointment will be created.')) return
    setBusy(true); setError('')
    try {
      const result = await request<{ status: string }>('/test-push', { method: 'POST', body: JSON.stringify({ confirmed: true }) })
      setPushResult(result.status === 'accepted' ? 'Accepted by Firebase. Check your phone.' : 'Delivery not confirmed. No automatic resend.')
    } catch (e) { setError(e instanceof Error ? e.message : 'Notification check failed') }
    finally { setBusy(false) }
  }
  async function resolve(call: Call) {
    setBusy(true); setError('')
    try { await request(`/callbacks/${encodeURIComponent(call.id)}`, { method: 'PATCH', body: JSON.stringify({ status: 'resolved' }) }); setSelected(null); await load() }
    catch (e) { setError(e instanceof Error ? e.message : 'Unable to resolve callback') }
    finally { setBusy(false) }
  }
  async function view(call: Call) {
    callbackRequest.current?.abort()
    const controller = new AbortController()
    callbackRequest.current = controller
    setSelected(call); setCallbackPhone(''); setError('')
    void listen(call)
    if (!call.callback_status) return
    try {
      const details = await request<{ phone: string }>(`/callbacks/${encodeURIComponent(call.id)}`, { signal: controller.signal })
      if (!controller.signal.aborted) setCallbackPhone(details.phone)
    } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Unable to load callback') }
  }
  async function listen(call: Call) {
    const sequence = ++audioRequest.current
    setAudio({ id: call.id, reason: 'Loading recording...' })
    try {
      const result = await request<{ available: boolean; url?: string; reason?: string }>(`/calls/${encodeURIComponent(call.id)}/recording`)
      if (sequence === audioRequest.current) setAudio({ id: call.id, url: result.available ? result.url : undefined, reason: result.reason })
    } catch { if (sequence === audioRequest.current) setAudio({ id: call.id, reason: 'Recording unavailable. Please try again.' }) }
  }
  async function removeConversation(call: Call) {
    if (deleting || !window.confirm('Delete this conversation and its recording permanently? Any related job and customer will be kept. This cannot be undone.')) return
    setDeleting(true); setError('')
    try {
      const result = await request<{ deleted: boolean }>(`/calls/${encodeURIComponent(call.id)}`, { method: 'DELETE', body: JSON.stringify({ confirmed: true }) })
      if (!result.deleted) throw new Error('Deletion was not confirmed. Please try again.')
      deletedIds.current.add(call.id)
      callbackRequest.current?.abort()
      ++audioRequest.current
      setAudio({ id: '' }); setCallbackPhone(''); setSelected(null)
      setCalls(items => items.filter(item => item.id !== call.id))
      setAbandoned(items => items.filter(item => item.id !== call.id))
      await load()
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to delete conversation') }
    finally { setDeleting(false) }
  }
  const isCallTab = tab === 'Calls' || tab === 'Callbacks' || tab === 'Abandoned calls'
  const callGroups = groupCallsByDate((tab === 'Abandoned calls' ? abandoned : calls.filter(call => tab !== 'Callbacks' || call.callback_status === 'pending')).filter(call => !dateFilter || callDate(call.started_at) === dateFilter))
  if (!dateFilter && !callGroups.some(group => group.date === callDate())) callGroups.unshift({ date: callDate(), calls: [] })
  const dayLabel = (date: string, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`))
  return <section className="receptionist-page" aria-label="AI Receptionist">
    <div className="receptionist-controls">
    <header><h1><Headset aria-hidden="true" /> AI Receptionist</h1><button type="button" title="Refresh" aria-label="Refresh" disabled={busy} onClick={() => void load()}><RefreshCw size={20} /></button></header>
    <div className="receptionist-view-picker" onKeyDown={event=>{if(event.key==='Escape'){setViewsOpen(false);viewsToggle.current?.focus()}}}>
      <button ref={viewsToggle} className="receptionist-view-toggle" type="button" aria-label={`Receptionist sections: ${tab}`} aria-expanded={viewsOpen} aria-controls="receptionist-views" onClick={()=>setViewsOpen(open=>!open)}><span>{tab}{tab==='Callbacks'&&stats?.pending_callbacks!=null?` (${stats.pending_callbacks})`:''}</span><ChevronDown size={20} aria-hidden="true"/></button>
      {viewsOpen&&<nav id="receptionist-views" aria-label="Receptionist views">{(['Callbacks', 'Abandoned calls', 'Dashboard', 'Calls', 'Call locations', 'Blocked Numbers', 'Settings', 'Diagnostics'] as Tab[]).map(value => <button type="button" key={value} aria-current={tab === value ? 'page' : undefined} onClick={() => { setTab(value);setViewsOpen(false);viewsToggle.current?.focus(); setSelected(null); setCallbackPhone(''); timeline.current?.scrollTo({ top: 0 }) }}><span>{value}{value === 'Callbacks' && stats?.pending_callbacks != null ? ` (${stats.pending_callbacks})` : ''}</span>{tab===value&&<Check size={18} aria-hidden="true"/>}</button>)}</nav>}
    </div>
    {isCallTab && <div className="receptionist-date-controls"><button type="button" onClick={() => { setDateFilter(''); timeline.current?.scrollTo({ top: 0, behavior: 'smooth' }) }}>Today</button><input type="date" aria-label="Filter call date" value={dateFilter} onChange={e => { setDateFilter(e.target.value); timeline.current?.scrollTo({ top: 0 }) }} /><button type="button" onClick={() => setDateFilter('')}>All calls</button></div>}
    </div>
    <div className="receptionist-scroll" ref={timeline}>
    {tab === 'Blocked Numbers' && <BlockedNumbers request={request} initialPhone={blockPhone} />}
    {isCallTab && <h2 className="receptionist-timeline-title">{tab}</h2>}
    {tab === 'Call locations' && <section className="receptionist-locations" aria-label="Monthly call locations">
      <label>Month<input type="month" value={month} min="2000-01" max="2099-12" onChange={event => { if (event.target.value) { setMonth(event.target.value); setLocationError('') } }} /></label>
      {locationError ? <p role="alert">{locationError}</p> : locations?.month !== month ? <p role="status">Loading call locations...</p> : <>
        <h2>{locations.total} calls</h2>
        {!locations.total && <p>No calls this month</p>}
        <ul>{locations.cities.map(group => <li key={group.city}><div><strong>{group.city}</strong><strong>{group.calls}</strong></div>
          <ul>{group.zips.map(item => <li key={item.zip}><span>{item.zip}</span><span>{item.calls}</span></li>)}</ul>
        </li>)}</ul>
      </>}
    </section>}
    {tab === 'VIP Call Transfer' && <ReceptionistVip request={request} />}
    {error && <p role="alert">{error}</p>}
    {busy && <p role="status">Loading…</p>}
    {diagnostics && !diagnostics.schemaReady && <p role="status">Setup pending · Database migration not applied</p>}
    {tab === 'Dashboard' && <><p className="receptionist-state">{diagnostics?.environmentEnabled && settings.enabled ? (settings.testMode ? 'Test mode' : 'Live mode') : 'Disabled'}</p>
      <dl className="receptionist-metrics"><div><dt>Total calls</dt><dd>{stats?.total_calls ?? '...'}</dd></div><div><dt>Booked calls</dt><dd>{stats?.booked_calls ?? '...'}</dd></div><div><dt>Pending callbacks</dt><dd>{stats?.pending_callbacks ?? '...'}</dd></div><div><dt>Recorded call cost</dt><dd>{cost(stats?.recorded_cost_cents)}</dd><small>{stats ? `${stats.priced_calls} of ${stats.total_calls} calls priced` : ''}</small></div><div><dt>Retell connection</dt><dd>{diagnostics?.lastSignedCallAt ? 'Call received' : 'Not verified'}</dd></div><div><dt>Mean call median latency</dt><dd>{stats?.mean_call_median_latency_ms == null ? 'Not reported' : `${Math.round(Number(stats.mean_call_median_latency_ms))} ms`}</dd></div></dl></>}
{isCallTab && <div className="receptionist-calls schedule-timeline">
      {!busy && !callGroups.length && <p>{tab === 'Callbacks' ? 'No pending callbacks' : 'No calls'}</p>}
      {callGroups.map((group, index) => <div className="schedule-day-group" key={group.date}>
        {(index === 0 || group.date.slice(0, 7) !== callGroups[index - 1].date.slice(0, 7)) && <div className="schedule-month-divider">{dayLabel(group.date, { month: 'long', year: 'numeric' })}</div>}
        <div className="schedule-day-row">
          <div className={`schedule-date-rail${group.date === callDate() ? ' today' : ''}`} aria-label={dayLabel(group.date, { dateStyle: 'full' })}>
            <span>{dayLabel(group.date, { weekday: 'short' })}</span><strong>{dayLabel(group.date, { day: 'numeric' })}</strong>
          </div>
          <div className="schedule-job-stack">
            {!group.calls.length && <p>No calls today</p>}
            {group.calls.map(call => <article className="receptionist-call-card" key={call.id}>
              <button type="button" onClick={() => void view(call)}>
                {call.channel === 'web' && <span>Book by Voice</span>}
                <strong>{call.customer || 'Unknown Caller'}</strong>
                <span>{call.caller_phone || (call.phone_last_four ? `Ending in ${call.phone_last_four}` : 'Number not provided')}</span>
                <span>{new Date(call.started_at).toLocaleTimeString('en-US', { timeZone: callTimeZone, hour: 'numeric', minute: '2-digit' })}</span>
                <span>Duration: {call.duration_ms == null ? 'Not reported' : `${Math.floor(Number(call.duration_ms) / 60000)}:${String(Math.floor(Number(call.duration_ms) / 1000) % 60).padStart(2, '0')}`}</span>
                <span>{call.callback_kind === 'abandoned' ? 'Caller disconnected - no booking' : call.callback_status === 'pending' ? 'Callback needed - appointment not confirmed' : call.outcome.replaceAll('_', ' ')}</span>
                {tab !== 'Calls' && <span>{call.reason}</span>}
              </button>
            </article>)}
          </div>
        </div>
      </div>)}
      {selected && <dialog ref={detailDialog} className="receptionist-detail-screen" aria-labelledby="receptionist-detail-title" data-disable-swipe-back
        onCancel={event => { if (deleting) event.preventDefault(); else setSelected(null) }}
        onTouchStart={event => {
          // Android emits alexNativeBackSwipe; don't also close from touchend.
          if (Capacitor.isNativePlatform() || deleting || event.touches.length !== 1 || (event.target as HTMLElement).closest('audio, button, a, input')) { swipeStart.current = null; return }
          const touch = event.touches[0]
          swipeStart.current = { x: touch.clientX, y: touch.clientY, time: Date.now() }
        }}
        onTouchCancel={() => { swipeStart.current = null }}
        onTouchEnd={event => {
          const start = swipeStart.current
          swipeStart.current = null
          const touch = event.changedTouches[0]
          if (!deleting && start && touch && touch.clientX - start.x >= 80 && Math.abs(touch.clientY - start.y) < 50 && Date.now() - start.time < 1200) setSelected(null)
        }}>
        <header><button type="button" autoFocus disabled={deleting} data-receptionist-detail-back aria-label="Back to calls" title="Back to calls" onClick={() => setSelected(null)}><ArrowLeft size={22} /></button><h2 id="receptionist-detail-title">{selected.customer || selected.caller_phone || 'Call details'}</h2></header>
        <section className="receptionist-detail-content">
          {selected.channel === 'web' && <p className="receptionist-state">Book by Voice</p>}
          {selected.started_at && <p>{new Date(selected.started_at).toLocaleString()}</p>}
          {selected.location && <div className="receptionist-location"><p>{[selected.location.city, selected.location.zip].filter(Boolean).join(' · ') || 'Location not provided'}</p>
            {callLocationMap(selected.location) && <a href={callLocationMap(selected.location)!} target="_blank" rel="noopener noreferrer"><MapPin size={20} aria-hidden="true" /> View ZIP area on map</a>}
          </div>}
          <p>{selected.summary || 'No summary'}</p>{selected.reason && <p>{selected.reason}</p>}
          {selected.job_id && <div className="receptionist-date-controls">
            {onOpenJob && <button type="button" onClick={() => { setSelected(null); onOpenJob(selected.job_id!) }}>Open Job</button>}
            {onOpenCustomer && <button type="button" onClick={() => { setSelected(null); onOpenCustomer(selected.job_id!) }}>Open Customer</button>}
          </div>}
          {selected.channel !== 'web' && selected.caller_phone && <><CallNumberBlock key={selected.caller_phone} phone={selected.caller_phone} request={request}/><button type="button" onClick={() => { setBlockPhone(selected.caller_phone || ''); setSelected(null); setTab('Blocked Numbers') }}>Number history</button></>}
          <dl><dt>Call cost</dt><dd>{cost(selected.cost_cents)}</dd><dt>Median response latency</dt><dd>{selected.latency_ms == null ? 'Not reported' : `${Math.round(Number(selected.latency_ms))} ms`}</dd></dl>
          <div className="receptionist-recording">
            {audio.id === selected.id && audio.url ? <audio key={selected.id} controls preload="metadata" src={audio.url} aria-label="Call recording" onError={() => setAudio({ id: selected.id, reason: 'Unable to play recording. Please retry.' })} /> : <><p role="status">{audio.id === selected.id ? audio.reason : 'Recording'}</p><button type="button" onClick={() => void listen(selected)}><Headset size={18} /> Listen to recording</button></>}
          </div>
          {(callbackPhone || selected.caller_phone) && <a href={`tel:${callbackPhone || selected.caller_phone}`}>{callbackPhone || selected.caller_phone}</a>}
          {error && <p role="alert">{error}</p>}
          {selected.callback_status === 'pending' && <button type="button" disabled={busy} onClick={() => void resolve(selected)}><Check size={18} /> Resolve callback</button>}
          <footer className="receptionist-delete-footer"><button type="button" className="receptionist-delete-button" disabled={deleting || busy} onClick={() => void removeConversation(selected)}><Trash2 size={20} aria-hidden="true" />{deleting ? 'Deleting...' : 'Delete conversation'}</button></footer>
        </section>
      </dialog>}</div>}
    {tab === 'Settings' && <form onSubmit={e => { e.preventDefault(); void save() }}>
      <label className="receptionist-toggle"><input type="checkbox" checked={settings.enabled} onChange={e => setSettings({ ...settings, enabled: e.target.checked })} /> {settings.testMode ? 'Enable test agent' : 'Enable agent'}</label>
      <label>Service ZIP codes<input value={zipDraft} onChange={e => setZipDraft(e.target.value)} /></label>
      {!!settings.zipOnlyZips?.length && <p>ZIP-only approval: {settings.zipOnlyZips.join(', ')}. No geographic verification.</p>}
      <fieldset><legend>ZIP coverage</legend>{[...new Set([...zipDraft.split(','), ...primaryZipDraft.split(','), ...candidateZipDraft.split(',')].map(zip => zip.trim()).filter(zip => /^\d{5}$/.test(zip)))].sort().map(zip => <label key={zip}>{zip}<select aria-label={`Coverage ${zip}`} value={zipCoverageStatus(settings, zip)} onChange={e => setSettings({ ...settings, zipCoverage: { ...settings.zipCoverage, [zip]: e.target.value as ZipCoverage } })}><option value="full">Full coverage</option><option value="partial">Partial - verify boundary</option><option value="manual">Owner review</option></select></label>)}</fieldset>
      <fieldset><legend>Indianapolis service boundary</legend>
        <label>North Indianapolis primary ZIP codes<input value={primaryZipDraft} onChange={e => setPrimaryZipDraft(e.target.value)} /></label>
        <label>North Indianapolis candidate ZIP codes<input value={candidateZipDraft} onChange={e => setCandidateZipDraft(e.target.value)} /></label>
        <p>Geographic authority: owner-approved North Indianapolis screenshot</p>
        <p>{boundaryDraft.trim() ? 'Boundary draft saved separately from release approval' : 'Boundary pending confirmation. North Indianapolis: manual address review.'}</p>
        <label>Reviewed boundary geometry (WGS84 JSON)<textarea rows={8} value={boundaryDraft} onChange={e => setBoundaryDraft(e.target.value)} spellCheck={false} /></label>
        <label>Import boundary<input type="file" accept=".json,.geojson,application/json" onChange={async e => {
          const file = e.target.files?.[0]
          if (!file) return
          try {
            if (file.size > 60000) throw new Error('Boundary file exceeds 60 KB')
            const boundary = validateAreaBoundary(JSON.parse(await file.text()))
            if (!boundary) throw new Error('Boundary is empty')
            setBoundaryDraft(JSON.stringify(boundary, null, 2)); setError('')
          } catch (error) { setError(error instanceof Error ? error.message : 'Invalid boundary') }
          e.target.value = ''
        }} /></label>
        <p>Automatic booking requires a separately approved boundary release.</p>
        {boundaryHash && <output style={{ overflowWrap: 'anywhere' }}>Saved boundary SHA-256: {boundaryHash}</output>}
      </fieldset>
      <fieldset><legend>Appliances</legend>{defaultReceptionistSettings.appliances.map(appliance => <label className="receptionist-toggle" key={appliance}><input type="checkbox" checked={settings.appliances.includes(appliance)} onChange={e => setSettings({ ...settings, appliances: e.target.checked ? [...settings.appliances, appliance] : settings.appliances.filter(a => a !== appliance) })} />{appliance}</label>)}</fieldset>
      <label>Public phone<input type="tel" value={settings.publicPhone} onChange={e => setSettings({ ...settings, publicPhone: e.target.value })} /></label>
      <label>Separate transfer phone<input type="tel" value={settings.transferPhone} onChange={e => setSettings({ ...settings, transferPhone: e.target.value })} /></label>
      <label>Approved diagnostic fee<input maxLength={120} value={settings.diagnosticFee} onChange={e => setSettings({ ...settings, diagnosticFee: e.target.value })} /></label>
      <label className="receptionist-toggle"><input type="checkbox" checked={settings.suspectedSealedSystemDiagnostic} onChange={e => setSettings({ ...settings, suspectedSealedSystemDiagnostic: e.target.checked })} /> Allow diagnostic for suspected sealed-system issue</label>
      <button type="submit" disabled={busy || !diagnostics?.schemaReady}><Save size={18} /> Save settings</button>
    </form>}
    {tab === 'Diagnostics' && diagnostics && <dl className="receptionist-diagnostics">{[['Database', diagnostics.schemaReady ? 'Ready' : 'Not ready'], ['Environment gate', diagnostics.environmentEnabled ? 'Enabled' : 'Disabled'], ['Retell configuration', diagnostics.lastSignedCallAt ? 'Signed call verified' : diagnostics.retellConfigured ? 'Configured; connection not verified' : 'Incomplete'], ['Automatic booking', diagnostics.bookingEnabled ? 'Enabled' : 'Disabled'], ['SMS', diagnostics.smsEnabled ? 'Enabled' : 'Disabled'], ['Provider recording', diagnostics.providerRecordingVerified ? (diagnostics.recordingsEnabled ? 'Enabled' : 'Disabled') : 'Not verified'], ['Live verification', diagnostics.liveVerification]].map(([label, status]) => <div key={label}><dt>{label}</dt><dd>{status}</dd></div>)}</dl>}
    {tab === 'Diagnostics' && diagnostics?.schemaReady && <div><button type="button" disabled={busy || Boolean(pushResult)} onClick={() => void testPush()}><Bell size={18} /> Test notification</button>{pushResult && <p role="status">{pushResult}</p>}</div>}
    </div>
  </section>
}
