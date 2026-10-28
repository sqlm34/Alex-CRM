import { useEffect, useState } from 'react'
import { ShieldCheck, ShieldOff } from 'lucide-react'

export function CallNumberBlock({ phone, request }: { phone: string; request: <T>(path: string, init?: RequestInit) => Promise<T> }) {
  const [blocked, setBlocked] = useState<boolean | null>(null)
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    void request<{rows:{blocked:boolean}[]}>(`/blocked-numbers?phone=${encodeURIComponent(phone)}`,{signal:controller.signal})
      .then(result => { if (!controller.signal.aborted) setBlocked(result.rows[0]?.blocked ?? false) })
      .catch(e => { if (!controller.signal.aborted) setError(e.message) })
    return () => controller.abort()
  },[phone,request])
  async function save() {
    setBusy(true); setError('')
    try {
      await request('/blocked-numbers',{method:'POST',body:JSON.stringify({phone,blocked:!blocked,reason,confirmed:true,requestId:crypto.randomUUID()})})
      setBlocked(!blocked); setOpen(false)
    } catch(e) { setError(e instanceof Error ? e.message : 'Unable to update number') }
    finally { setBusy(false) }
  }
  return <section aria-label="Phone blocking">
    {blocked && <p className="receptionist-state">Blocked</p>}
    <button type="button" disabled={blocked===null || busy} onClick={() => setOpen(true)}>{blocked ? <ShieldCheck size={18}/> : <ShieldOff size={18}/>} {blocked ? 'Unblock Number' : 'Block Number'}</button>
    {open && <div role="group" aria-label="Confirm number status"><p>{blocked ? 'Unblock' : 'Block'} {phone}?</p><label>Reason (optional)<input value={reason} maxLength={500} onChange={e => setReason(e.target.value)}/></label><div className="receptionist-date-controls"><button type="button" disabled={busy} onClick={() => void save()}>{busy ? 'Saving...' : 'Confirm'}</button><button type="button" disabled={busy} onClick={() => setOpen(false)}>Cancel</button></div></div>}
    {error && <p role="alert">{error}</p>}
  </section>
}
