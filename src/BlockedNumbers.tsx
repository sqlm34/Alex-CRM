import { useEffect, useState } from 'react'
import { ShieldOff, ShieldCheck } from 'lucide-react'

type Entry = { phone: string; blocked: boolean; reason: string; updated_at: string }
type History = { blocked: boolean; reason: string; created_at: string }
type Request = <T>(path: string, init?: RequestInit) => Promise<T>
export function BlockedNumbers({ request, initialPhone = '' }: { request: Request; initialPhone?: string }) {
  const [rows, setRows] = useState<Entry[]>([])
  const [phone, setPhone] = useState(initialPhone)
  const [reason, setReason] = useState('')
  const [search, setSearch] = useState('')
  const [history, setHistory] = useState<History[]>([])
  const [historyPhone, setHistoryPhone] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [pending, setPending] = useState<{number: string; blocked: boolean; note: string} | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    void request<{ rows: Entry[] }>('/blocked-numbers', { signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) setRows(data.rows) })
      .catch(e => { if (!controller.signal.aborted) setError(e.message) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [request])
  async function change(number: string, blocked: boolean, note: string) {
    if (busy) return
    setBusy(true); setError('')
    try {
      await request('/blocked-numbers', { method: 'POST', body: JSON.stringify({ phone: number, blocked, reason: note, confirmed: true, requestId: crypto.randomUUID() }) })
      const data = await request<{ rows: Entry[] }>('/blocked-numbers')
      setRows(data.rows); setHistory([]); setHistoryPhone(''); setReason(''); setPending(null)
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to save number') }
    finally { setBusy(false) }
  }
  async function showHistory(number: string) {
    setError('')
    try {
      const data = await request<{ history: History[] }>(`/blocked-numbers?phone=${encodeURIComponent(number)}`)
      setHistory(data.history); setHistoryPhone(number)
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to load history') }
  }
  return <section aria-label="Blocked Numbers">
    <h2>Blocked Numbers</h2>
    {error && <p role="alert">{error}</p>}
    <form onSubmit={e => { e.preventDefault(); setPending({number: phone, blocked: true, note: reason}) }}>
      <label>Phone number<input type="tel" autoComplete="tel" required value={phone} onChange={e => setPhone(e.target.value)} /></label>
      <label>Reason (optional)<input maxLength={500} value={reason} onChange={e => setReason(e.target.value)} /></label>
      <button disabled={busy || loading || pending !== null} type="submit"><ShieldOff size={18} />{busy ? 'Saving...' : 'Block Number'}</button>
    </form>
    {pending && <div role="group" aria-label="Confirm number status">
      <p>{pending.blocked ? 'Block' : 'Unblock'} <strong>{pending.number}</strong>?</p>
      <p>{pending.blocked ? 'Future calls from this number will be rejected by the inbound filter.' : 'Allow future calls from this number.'}</p>
      <div className="receptionist-date-controls">
        <button type="button" disabled={busy} onClick={() => void change(pending.number,pending.blocked,pending.note)}>{busy ? 'Saving...' : 'Confirm'}</button>
        <button type="button" disabled={busy} onClick={() => setPending(null)}>Cancel</button>
      </div>
    </div>}
    <label>Search numbers<input type="search" value={search} onChange={e => setSearch(e.target.value)} /></label>
    {loading ? <p role="status">Loading...</p> : rows.filter(row => `${row.phone} ${row.reason}`.toLowerCase().includes(search.toLowerCase())).map(row => <article className="receptionist-call-card" key={row.phone}>
      <p><strong>{row.phone}</strong> · {row.blocked ? 'Blocked' : 'Allowed'}</p>
      <p>{row.reason}</p><p>{new Date(row.updated_at).toLocaleString()}</p>
      <button disabled={busy || pending !== null} type="button" onClick={() => setPending({number:row.phone,blocked:!row.blocked,note:row.reason})}>{row.blocked ? <ShieldCheck size={18} /> : <ShieldOff size={18} />}{row.blocked ? 'Unblock Number' : 'Block Number'}</button>
      <button type="button" disabled={busy} onClick={() => void showHistory(row.phone)}>History</button>
    </article>)}
    {!loading && !rows.length && <p>No blocked numbers</p>}
    {historyPhone && <section aria-label="Block history"><h3>{historyPhone}</h3>{history.map((entry, index) => <p key={index}>{new Date(entry.created_at).toLocaleString()} · {entry.blocked ? 'Blocked' : 'Unblocked'} · {entry.reason}</p>)}</section>}
  </section>
}
