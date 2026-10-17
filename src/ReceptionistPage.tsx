import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, Bell, Check, Headset, RefreshCw, Save } from 'lucide-react'
import { onPushSync } from './notifications'
import { configuredApiUrl } from './api'
import { defaultReceptionistSettings, type ReceptionistSettings } from '../shared/receptionist'
import { boundaryFingerprint, validateAreaBoundary, zipCoverageStatus, type ZipCoverage } from '../shared/receptionist-area'
import './ReceptionistPage.css'
import { ReceptionistVip } from './ReceptionistVip'

type Call = { id: string; provider: string; started_at: string; outcome: string; summary: string; phone_last_four: string; caller_phone?: string; duration_ms?: number | string | null; callback_kind?: string; customer: string | null; reason: string | null; callback_status: string | null; cost_cents: number | string | null; latency_ms: number | string | null }
type Stats = { total_calls: number; booked_calls: number; pending_callbacks: number; priced_calls: number; recorded_cost_cents: number | string | null; mean_call_median_latency_ms: number | string | null }
const cost = (cents: number | string | null | undefined) => cents == null ? 'Not reported' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 3 }).format(Number(cents) / 100)
type Diagnostics = { schemaReady: boolean; environmentEnabled: boolean; retellConfigured: boolean; bookingEnabled: boolean; smsEnabled: boolean; recordingsEnabled: boolean; providerRecordingVerified: boolean; liveVerification: string; lastSignedCallAt: string | null }
type Tab = 'Callbacks' | 'Abandoned calls' | 'Dashboard' | 'Calls' | 'Settings' | 'Diagnostics' | 'VIP Call Transfer'
export function ReceptionistPage({ token, callId = '' }: { token: string; callId?: string }) {
  const [tab, setTab] = useState<Tab>('Callbacks')
  const [calls, setCalls] = useState<Call[]>([])
  const [abandoned, setAbandoned] = useState<Call[]>([])
  const [audio, setAudio] = useState<{ id: string; url?: string; reason?: string }>({ id: '' })
  const [stats, setStats] = useState<Stats | null>(null)
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
  const detailDialog = useRef<HTMLDialogElement>(null)
  const audioRequest = useRef(0)
  const swipeStart = useRef<{ x: number; y: number; time: number } | null>(null)
  useEffect(() => {
    if (!selected) return
    const dialog = detailDialog.current
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialog?.showModal()
    return () => { dialog?.close(); document.body.style.overflow = overflow }
  }, [selected])
  const [callbackPhone, setCallbackPhone] = useState('')
  const request = useCallback(async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
    const result = await fetch(`${configuredApiUrl}/api/receptionist${path}`, { ...init,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } })
    const data = await result.json()
    if (!result.ok) throw new Error(data.error || 'Unable to load receptionist')
    return data as T
  }, [token])
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
        setCalls(await request<Call[]>('/calls', { signal }))
        setAbandoned(await request<Call[]>('/abandoned', { signal }))
        setStats(await request<Stats>('/stats', { signal }))
      }
    } catch (e) { if (!signal?.aborted) setError(e instanceof Error ? e.message : 'Unable to load receptionist') }
    finally { if (!signal?.aborted) setBusy(false) }
  }, [request])
  useEffect(() => {
    const controller = new AbortController()
    // load only updates state after the asynchronous network request settles.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(controller.signal)
    return () => controller.abort()
  }, [load])
  useEffect(() => () => callbackRequest.current?.abort(), [])
  useEffect(() => { callbackRequest.current?.abort() }, [tab])
  useEffect(() => {
    const controller = new AbortController()
    const refresh = () => { if (document.visibilityState !== 'hidden') void load(controller.signal) }
    const unsubscribe = onPushSync(detail => { if (detail?.event === 'receptionist_callback') refresh() })
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => { controller.abort(); unsubscribe(); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh) }
  }, [load])
  useEffect(() => {
    if (!callId) return
    const controller = new AbortController()
    void request<{ customer: string; phone: string; reason: string; status: string; kind?: string }>(`/callbacks/${encodeURIComponent(callId)}`, { signal: controller.signal }).then(details => {
      if (controller.signal.aborted) return
      setTab(details.kind === 'abandoned' ? 'Abandoned calls' : 'Callbacks')
      setSelected({ id: callId, customer: details.customer, reason: details.reason, callback_status: details.status, summary: '', provider: 'retell', started_at: '', outcome: 'callback_requested', phone_last_four: '', cost_cents: null, latency_ms: null })
      setCallbackPhone(details.phone)
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
  return <section className="receptionist-page" aria-label="AI Receptionist">
    <header><h1><Headset aria-hidden="true" /> AI Receptionist</h1><button type="button" title="Refresh" aria-label="Refresh" disabled={busy} onClick={() => void load()}><RefreshCw size={20} /></button></header>
    <nav aria-label="Receptionist views">{(['Callbacks', 'Abandoned calls', 'Dashboard', 'Calls', 'Settings', 'Diagnostics'] as Tab[]).map(value => <button type="button" key={value} aria-current={tab === value ? 'page' : undefined} onClick={() => { setTab(value); setSelected(null); setCallbackPhone('') }}>{value}{value === 'Callbacks' && stats ? ` (${stats.pending_callbacks})` : ''}</button>)}</nav>
    {tab === 'VIP Call Transfer' && <ReceptionistVip request={request} />}
    {error && <p role="alert">{error}</p>}
    {busy && <p role="status">Loading…</p>}
    {diagnostics && !diagnostics.schemaReady && <p role="status">Setup pending · Database migration not applied</p>}
    {tab === 'Dashboard' && <><p className="receptionist-state">{diagnostics?.environmentEnabled && settings.enabled ? (settings.testMode ? 'Test mode' : 'Live mode') : 'Disabled'}</p>
      <dl className="receptionist-metrics"><div><dt>Total calls</dt><dd>{stats?.total_calls ?? '...'}</dd></div><div><dt>Booked calls</dt><dd>{stats?.booked_calls ?? '...'}</dd></div><div><dt>Pending callbacks</dt><dd>{stats?.pending_callbacks ?? '...'}</dd></div><div><dt>Recorded call cost</dt><dd>{cost(stats?.recorded_cost_cents)}</dd><small>{stats ? `${stats.priced_calls} of ${stats.total_calls} calls priced` : ''}</small></div><div><dt>Retell connection</dt><dd>{diagnostics?.lastSignedCallAt ? 'Call received' : 'Not verified'}</dd></div><div><dt>Mean call median latency</dt><dd>{stats?.mean_call_median_latency_ms == null ? 'Not reported' : `${Math.round(Number(stats.mean_call_median_latency_ms))} ms`}</dd></div></dl></>}
    {(tab === 'Calls' || tab === 'Callbacks' || tab === 'Abandoned calls') && <div className="receptionist-calls">{!busy && !(tab === 'Abandoned calls' ? abandoned.length : tab === 'Callbacks' ? calls.some(call => call.callback_status === 'pending') : calls.length) && <p>{tab === 'Callbacks' ? 'No pending callbacks' : 'No calls'}</p>}{(tab === 'Abandoned calls' ? abandoned : calls.filter(call => tab !== 'Callbacks' || call.callback_status === 'pending')).map(call => <article key={call.id}><button type="button" onClick={() => void view(call)}><strong>{call.caller_phone || call.customer || `Caller · ${call.phone_last_four}`}</strong><span>{new Date(call.started_at).toLocaleString()}</span><span>Duration: {call.duration_ms == null ? 'Not reported' : `${Math.floor(Number(call.duration_ms) / 60000)}:${String(Math.floor(Number(call.duration_ms) / 1000) % 60).padStart(2, '0')}`}</span><span>{call.callback_kind === 'abandoned' ? 'Caller disconnected - no booking' : call.callback_status === 'pending' ? 'Callback needed - appointment not confirmed' : call.outcome.replaceAll('_', ' ')}</span>{tab !== 'Calls' && <span>{call.reason}</span>}</button></article>)}
      {selected && <dialog ref={detailDialog} className="receptionist-detail-screen" aria-labelledby="receptionist-detail-title" data-disable-swipe-back
        onCancel={() => setSelected(null)}
        onTouchStart={event => {
          if (event.touches.length !== 1 || (event.target as HTMLElement).closest('audio, button, a, input')) { swipeStart.current = null; return }
          const touch = event.touches[0]
          swipeStart.current = { x: touch.clientX, y: touch.clientY, time: Date.now() }
        }}
        onTouchCancel={() => { swipeStart.current = null }}
        onTouchEnd={event => {
          const start = swipeStart.current
          swipeStart.current = null
          const touch = event.changedTouches[0]
          if (start && touch && touch.clientX - start.x >= 80 && Math.abs(touch.clientY - start.y) < 50 && Date.now() - start.time < 800) setSelected(null)
        }}>
        <header><button type="button" autoFocus aria-label="Back to calls" title="Back to calls" onClick={() => setSelected(null)}><ArrowLeft size={22} /></button><h2 id="receptionist-detail-title">{selected.customer || selected.caller_phone || 'Call details'}</h2></header>
        <section className="receptionist-detail-content">
          {selected.started_at && <p>{new Date(selected.started_at).toLocaleString()}</p>}
          <p>{selected.summary || 'No summary'}</p>{selected.reason && <p>{selected.reason}</p>}
          <dl><dt>Call cost</dt><dd>{cost(selected.cost_cents)}</dd><dt>Median response latency</dt><dd>{selected.latency_ms == null ? 'Not reported' : `${Math.round(Number(selected.latency_ms))} ms`}</dd></dl>
          <div className="receptionist-recording">
            {audio.id === selected.id && audio.url ? <audio key={selected.id} controls preload="metadata" src={audio.url} aria-label="Call recording" onError={() => setAudio({ id: selected.id, reason: 'Unable to play recording. Please retry.' })} /> : <><p role="status">{audio.id === selected.id ? audio.reason : 'Recording'}</p><button type="button" onClick={() => void listen(selected)}><Headset size={18} /> Listen to recording</button></>}
          </div>
          {(callbackPhone || selected.caller_phone) && <a href={`tel:${callbackPhone || selected.caller_phone}`}>{callbackPhone || selected.caller_phone}</a>}
          {error && <p role="alert">{error}</p>}
          {selected.callback_status === 'pending' && <button type="button" disabled={busy} onClick={() => void resolve(selected)}><Check size={18} /> Resolve callback</button>}
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
  </section>
}
