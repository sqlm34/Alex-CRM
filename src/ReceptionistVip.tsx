import { useEffect, useState } from 'react'
import { Save, ShieldOff } from 'lucide-react'

type Settings = { ready: boolean; enabled: boolean; configured: boolean; revision: number; trustedCount: number; response: string; releaseEnabled?: boolean; configurationUnavailable?: boolean }
type Request = <T>(path: string, init?: RequestInit) => Promise<T>
export function ReceptionistVip({ request }: { request: Request }) {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [destination, setDestination] = useState('')
  const [trusted, setTrusted] = useState('')
  const [phrases, setPhrases] = useState('')
  const [enabled, setEnabled] = useState(false)
  const [response, setResponse] = useState('Одну секунду, соединяю')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    void request<Settings>('/vip', { signal: controller.signal }).then(value => {
      if (controller.signal.aborted) return
      setSettings(value); setEnabled(value.enabled)
      if (value.response) setResponse(value.response)
    }).catch(() => { if (!controller.signal.aborted) setError('VIP settings unavailable') })
    return () => controller.abort()
  }, [request])
  async function save(disableOnly = false) {
    if (!settings) return
    setBusy(true); setError(''); setSaved(false)
    try {
      const input = disableOnly ? { revision: settings.revision } : {
        revision: settings.revision, enabled, destination, response,
        ...(trusted.trim() ? { trustedCallers: trusted.split(/[\n,]+/).map(x => x.trim()).filter(Boolean) } : {}),
        ...(phrases.trim() ? { passphrases: phrases.split(';').map(x => x.trim()).filter(Boolean) } : {}),
      }
      await request(disableOnly ? '/vip/disable' : '/vip', { method: disableOnly ? 'POST' : 'PUT', body: JSON.stringify(input) })
      setDestination(''); setTrusted(''); setPhrases('')
      const value = await request<Settings>('/vip')
      setSettings(value); setEnabled(value.enabled); setSaved(true)
    } catch { setError('Unable to save VIP settings. Check configuration or reload if it changed.') }
    finally { setBusy(false) }
  }
  return <section aria-label="VIP Call Transfer">
    <h2>VIP Call Transfer</h2>
    {error && <p role="alert">{error}</p>}
    {saved && <p role="status">Saved</p>}
    {!settings ? <p role="status">Loading...</p> : <>
      <p>{!settings.ready ? 'Setup pending' : settings.releaseEnabled ? 'Release enabled' : 'Release approval pending'}</p>
      <p>{settings.configured ? `Private configuration saved. Trusted callers: ${settings.trustedCount}` : 'Private configuration not set'}</p>
      {settings.configurationUnavailable && <p role="alert">Private configuration unavailable. Transfers can still be disabled.</p>}
      <form onSubmit={e => { e.preventDefault(); void save() }} autoComplete="off">
        <label className="receptionist-toggle"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />Enable VIP transfers</label>
        <label>Private destination<input type="tel" value={destination} onChange={e => setDestination(e.target.value)} autoComplete="off" placeholder={settings.configured ? 'Unchanged' : '+1...'} /></label>
        <label>Trusted caller numbers<textarea rows={3} value={trusted} onChange={e => setTrusted(e.target.value)} placeholder={settings.configured ? 'Unchanged' : '+1...'} /></label>
        <label>New passphrase / alternate spelling (semicolon-separated)<input type="password" autoComplete="new-password" value={phrases} onChange={e => setPhrases(e.target.value)} placeholder={settings.configured ? 'Unchanged' : ''} maxLength={403} /></label>
        <label>Transfer response<input value={response} onChange={e => setResponse(e.target.value)} maxLength={160} /></label>
        <button type="submit" disabled={busy || !settings.ready || settings.configurationUnavailable}><Save size={18} />Save VIP settings</button>
        <button type="button" disabled={busy || !settings.ready || !settings.enabled} onClick={() => void save(true)}><ShieldOff size={18} />Disable VIP transfers</button>
      </form>
    </>}
  </section>
}
