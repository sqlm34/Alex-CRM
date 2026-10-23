import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Mic, CalendarDays } from 'lucide-react'
import './BookingMethod.css'

export type BookingMethod = 'online' | 'voice' | null
let widgetLoad: Promise<void> | undefined
function loadVoice() {
  if (!widgetLoad) {
    const css = document.createElement('link')
    css.rel = 'stylesheet'
    css.href = '/voice-booking/voice-booking.css'
    document.head.append(css)
    const script = document.createElement('script')
    script.type = 'module'
    script.src = '/voice-booking/booking-entry.js'
    widgetLoad = new Promise<void>((resolve, reject) => {
      script.onload = () => document.querySelector('.voice-booking') ? resolve() : reject(new Error('Voice widget unavailable'))
      script.onerror = () => reject(new Error('Voice widget failed to load'))
      document.head.append(script)
    }).catch(error => { widgetLoad = undefined; css.remove(); script.remove(); throw error })
  }
  return widgetLoad
}

export function BookingMethodChooser({ method, onChange, locked }: {
  method: BookingMethod; onChange: (method: BookingMethod) => void; locked: boolean
}) {
  const [loading, setLoading] = useState(false)
  const [active, setActive] = useState(false)
  const [error, setError] = useState('')
  const voiceHost = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const panel = voiceHost.current?.querySelector<HTMLElement>('.voice-panel')
    if (method === 'voice' && !active && panel) panel.hidden = false
  }, [method, active, loading])
  useEffect(() => {
    const onlineLink = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest('.voice-panel a[href="https://aleksappliancerepair.com/booking"]')) return
      event.preventDefault()
      if (locked || document.querySelector('.voice-booking.voice-active')) return
      document.querySelector<HTMLButtonElement>('.voice-minimize')?.click()
      const root = document.querySelector<HTMLElement>('.voice-booking')
      if (root) root.hidden = true
      onChange('online')
    }
    document.addEventListener('click', onlineLink)
    return () => document.removeEventListener('click', onlineLink)
  }, [locked, onChange])
  useEffect(() => {
    const sync = () => setActive(!!document.querySelector('.voice-booking.voice-active'))
    const observer = new MutationObserver(sync)
    observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] })
    sync()
    return () => observer.disconnect()
  }, [])
  async function chooseVoice() {
    if (loading || locked) return
    setError(''); setLoading(true)
    try {
      await loadVoice()
      const root = document.querySelector<HTMLElement>('.voice-booking')
      // Place the widget once, before its Turnstile iframe is created.
      if (root && voiceHost.current && root.parentElement !== voiceHost.current) voiceHost.current.append(root)
      onChange('voice')
      if (root) root.hidden = false
      document.querySelector<HTMLButtonElement>('.voice-launch')?.click()
    } catch { setError('Voice booking could not load. Please try again or book online.') }
    finally { setLoading(false) }
  }
  function back() {
    // Recheck the widget synchronously, including the connection phase.
    if (locked || document.querySelector('.voice-booking.voice-active')) return
    document.querySelector<HTMLButtonElement>('.voice-minimize')?.click()
    const root = document.querySelector<HTMLElement>('.voice-booking')
    if (root) root.hidden = true
    onChange(null)
  }
  return <>
    {method ? <nav className="booking-method-nav" data-method={method} aria-label="Booking method">
      <button type="button" onClick={back} disabled={locked || active || loading}><ArrowLeft size={18} />Booking options</button>
      {method === 'online' && <span>Book Online</span>}
    </nav> : <section className="booking-methods" aria-label="Choose a booking method">
      <div className="booking-method-grid">
        <button type="button" className="booking-method-card" onClick={() => void chooseVoice()} disabled={loading || locked}>
          <span className="booking-method-icon"><Mic size={48} strokeWidth={1.6} aria-hidden="true" /></span>
          <strong>Book by Voice</strong>
          <span className="booking-method-description">Just speak to our assistant. No typing required.</span>
          <span className="booking-method-cta">{loading ? 'Opening…' : 'Start Voice Booking'}<ArrowRight size={19} aria-hidden="true" /></span>
        </button>
        <button type="button" className="booking-method-card" onClick={() => onChange('online')} disabled={loading || locked}>
          <span className="booking-method-icon"><CalendarDays size={48} strokeWidth={1.6} aria-hidden="true" /></span>
          <strong>Book Online</strong>
          <span className="booking-method-description">Choose your appliance and fill out a quick form.</span>
          <span className="booking-method-cta">Continue Online<ArrowRight size={19} aria-hidden="true" /></span>
        </button>
      </div>
    </section>}
    <section className="booking-voice-stage" hidden={method !== 'voice'}><h1>Book by Voice</h1>{active && <button type="button" className="booking-view-order" onClick={() => document.querySelector<HTMLButtonElement>('.voice-launch')?.click()}>View booking order</button>}<div ref={voiceHost} className="booking-voice-host" /></section>
    {error && <p role="alert">{error}</p>}
  </>
}
