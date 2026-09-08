import { useEffect, useRef, useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import type { StripeAccountDiagnostic } from './api'

export function StripeAccountDiagnosticPanel({ getDiagnostic }: {
  getDiagnostic: (signal: AbortSignal) => Promise<StripeAccountDiagnostic>
}) {
  const [result, setResult] = useState<StripeAccountDiagnostic | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const active = useRef<AbortController | null>(null)
  useEffect(() => () => { active.current?.abort(); active.current = null }, [])

  const check = async () => {
    if (active.current) return
    const controller = new AbortController()
    active.current = controller
    setBusy(true)
    setResult(null)
    setError('')
    try {
      const next = await getDiagnostic(controller.signal)
      if (!controller.signal.aborted) setResult(next)
    } catch (failure) {
      if (controller.signal.aborted) return
      const allowed = ['Session expired. Please sign in again.', 'Only the owner can check the Stripe account.']
      setError(failure instanceof Error && allowed.includes(failure.message) ? failure.message : 'Stripe account check is unavailable. Please try again.')
    } finally {
      if (active.current === controller) { active.current = null; setBusy(false) }
    }
  }

  return <div className="stripe-capabilities-diagnostic" aria-label="Stripe account diagnostics">
    <button className="secondary-action" type="button" disabled={busy} onClick={() => void check()}>
      <ShieldCheck size={18} aria-hidden="true" />
      {busy ? 'Проверка Stripe account…' : 'Проверить Stripe account'}
    </button>
    <div role="status" aria-live="polite" aria-busy={busy}>
      {error ? <p>{error}</p> : null}
      {result ? <dl>
        <dt>Account ID</dt><dd>{result.accountId}</dd>
        <dt>Mode</dt><dd>{result.livemode ? 'Live' : 'Test'}</dd>
        <dt>API version</dt><dd>{result.apiVersion}</dd>
      </dl> : null}
    </div>
  </div>
}
