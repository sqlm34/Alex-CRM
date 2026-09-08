import { useEffect, useRef, useState } from 'react'
import { Smartphone } from 'lucide-react'
import { checkStripeCapabilities } from './stripeCapabilitiesCheck'
import type { CapabilitiesDiagnostic } from './stripeCapabilitiesCheck'
import { StripeAccountDiagnosticPanel } from './StripeAccountDiagnosticPanel'
import type { StripeAccountDiagnostic } from './api'

export function StripeCapabilitiesDiagnostic({ available, getCapabilities, getAccountDiagnostic }: {
  available: boolean
  getCapabilities: () => Promise<unknown>
  getAccountDiagnostic: (signal: AbortSignal) => Promise<StripeAccountDiagnostic>
}) {
  const [result, setResult] = useState<CapabilitiesDiagnostic | null>(null)
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const check = async () => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setResult(null)
    const next = await checkStripeCapabilities(available, getCapabilities)
    inFlight.current = false
    if (!mounted.current) return
    setResult(next)
    setBusy(false)
  }

  return (
    <section className="stripe-capabilities-diagnostic" aria-label="Tap to Pay diagnostics">
      <button className="secondary-action" type="button" disabled={busy} onClick={() => void check()}>
        <Smartphone size={18} aria-hidden="true" />
        {busy ? 'Проверка…' : 'Проверить поддержку Tap to Pay'}
      </button>
      <div role="status" aria-live="polite" aria-busy={busy}>
        {result ? <>
          <p>{result.status === 'supported' ? 'Поддерживается новый протокол' : result.status === 'update-required' ? 'Требуется обновление приложения' : 'Проверка недоступна. Откройте актуальное Android-приложение и повторите проверку.'}</p>
          <dl>
            <dt>stripePaymentProtocolVersion</dt>
            <dd>{result.protocolVersion ?? 'Недоступно'}</dd>
            <dt>supportsExternalClientSecret</dt>
            <dd>{result.externalClientSecret === null ? 'Недоступно' : String(result.externalClientSecret)}</dd>
          </dl>
        </> : null}
      </div>
      <StripeAccountDiagnosticPanel getDiagnostic={getAccountDiagnostic} />
    </section>
  )
}
