import { useCallback, useEffect, useRef, useState } from 'react'
import { Bell, Check, Headset, RefreshCw, Save } from 'lucide-react'
import { configuredApiUrl } from './api'
import { defaultReceptionistSettings, type ReceptionistSettings } from '../shared/receptionist'
import './ReceptionistPage.css'

type Call = { id: string; provider: string; started_at: string; outcome: string; summary: string; phone_last_four: string; customer: string | null; reason: string | null; callback_status: string | null; cost_cents: number | string | null; latency_ms: number | string | null }
type Stats = { total_calls: number; booked_calls: number; pending_callbacks: number; priced_calls: number; recorded_cost_cents: number | string | null; mean_call_median_latency_ms: number | string | null }
const cost = (cents: number | string | null | undefined) => cents == null ? 'Not reported' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 3 }).format(Number(cents) / 100)
type Diagnostics = { schemaReady: boolean; environmentEnabled: boolean; retellConfigured: boolean; bookingEnabled: boolean; smsEnabled: boolean; recordingsEnabled: boolean; providerRecordingVerified: boolean; liveVerification: string; lastSignedCallAt: string | null }
type Tab = 'Dashboard' | 'Calls' | 'Settings' | 'Diagnostics'
export function ReceptionistPage({ token }: { token: string }) {
  const [tab, setTab] = useState<Tab>('Dashboard')
  const [calls, setCalls] = useState<Call[]>([])
  const [stats, setStats] = useState<Stats | null>(null)
  const [settings, setSettings] = useState<ReceptionistSettings>(defaultReceptionistSettings)
  const [zipDraft, setZipDraft] = useState('')
  const callbackRequest = useRef<AbortController | null>(null)
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [pushResult, setPushResult] = useState('')
  const [selected, setSelected] = useState<Call | null>(null)
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
        setCalls(await request<Call[]>('/calls', { signal }))
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
  async function save() {
    setBusy(true); setError('')
    try {
      const saved = await request<ReceptionistSettings>('/settings', { method: 'PUT', body: JSON.stringify({ ...settings, serviceZips: zipDraft.split(',').map(zip => zip.trim()).filter(Boolean) }) })
      setSettings(saved)
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
    if (!call.callback_status) return
    try {
      const details = await request<{ phone: string }>(`/callbacks/${encodeURIComponent(call.id)}`, { signal: controller.signal })
      if (!controller.signal.aborted) setCallbackPhone(details.phone)
    } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Unable to load callback') }
  }
  return <section className="receptionist-page" aria-label="AI Receptionist">
    <header><h1><Headset aria-hidden="true" /> AI Receptionist</h1><button type="button" title="Refresh" aria-label="Refresh" disabled={busy} onClick={() => void load()}><RefreshCw size={20} /></button></header>
    <nav aria-label="Receptionist views">{(['Dashboard', 'Calls', 'Settings', 'Diagnostics'] as Tab[]).map(value => <button type="button" key={value} aria-current={tab === value ? 'page' : undefined} onClick={() => { setTab(value); setSelected(null); setCallbackPhone('') }}>{value}</button>)}</nav>
    {error && <p role="alert">{error}</p>}
    {busy && <p role="status">Loading…</p>}
    {diagnostics && !diagnostics.schemaReady && <p role="status">Setup pending · Database migration not applied</p>}
    {tab === 'Dashboard' && <><p className="receptionist-state">{diagnostics?.environmentEnabled && settings.enabled ? (settings.testMode ? 'Test mode' : 'Live mode') : 'Disabled'}</p>
      <dl className="receptionist-metrics"><div><dt>Total calls</dt><dd>{stats?.total_calls ?? '...'}</dd></div><div><dt>Booked calls</dt><dd>{stats?.booked_calls ?? '...'}</dd></div><div><dt>Pending callbacks</dt><dd>{stats?.pending_callbacks ?? '...'}</dd></div><div><dt>Recorded call cost</dt><dd>{cost(stats?.recorded_cost_cents)}</dd><small>{stats ? `${stats.priced_calls} of ${stats.total_calls} calls priced` : ''}</small></div><div><dt>Retell connection</dt><dd>{diagnostics?.lastSignedCallAt ? 'Call received' : 'Not verified'}</dd></div><div><dt>Mean call median latency</dt><dd>{stats?.mean_call_median_latency_ms == null ? 'Not reported' : `${Math.round(Number(stats.mean_call_median_latency_ms))} ms`}</dd></div></dl></>}
    {tab === 'Calls' && <div className="receptionist-calls">{!calls.length && !busy && <p>No calls</p>}{calls.map(call => <article key={call.id}><button type="button" onClick={() => void view(call)}><strong>{call.customer || `Caller · ${call.phone_last_four}`}</strong><span>{new Date(call.started_at).toLocaleString()}</span><span>{call.outcome.replaceAll('_', ' ')}</span></button></article>)}
      {selected && <section className="receptionist-call-detail" aria-label="Call details"><h2>{selected.customer || 'Call details'}</h2><p>{selected.summary || 'No summary'}</p><p>{selected.reason}</p><dl><dt>Call cost</dt><dd>{cost(selected.cost_cents)}</dd><dt>Median response latency</dt><dd>{selected.latency_ms == null ? 'Not reported' : `${Math.round(Number(selected.latency_ms))} ms`}</dd></dl>{callbackPhone && <a href={`tel:${callbackPhone}`}>{callbackPhone}</a>}{selected.callback_status === 'pending' && <button type="button" disabled={busy} onClick={() => void resolve(selected)}><Check size={18} /> Resolve callback</button>}</section>}</div>}
    {tab === 'Settings' && <form onSubmit={e => { e.preventDefault(); void save() }}>
      <label className="receptionist-toggle"><input type="checkbox" checked={settings.enabled} onChange={e => setSettings({ ...settings, enabled: e.target.checked })} /> {settings.testMode ? 'Enable test agent' : 'Enable agent'}</label>
      <label>Service ZIP codes<input value={zipDraft} onChange={e => setZipDraft(e.target.value)} /></label>
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
