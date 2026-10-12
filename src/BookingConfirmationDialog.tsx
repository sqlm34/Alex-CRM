import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, CalendarPlus, Download, Mail, Phone } from 'lucide-react'
import { bookingArrivalMessage, googleBookingCalendarUrl, type CalendarBooking } from '../shared/bookingCalendar'

export function BookingConfirmationDialog({ job, emailEnabled, calendarEnabled, onDownload }: {
  job: CalendarBooking; emailEnabled: boolean; calendarEnabled: boolean; onDownload: () => void
}) {
  const [stage, setStage] = useState<'summary' | 'message' | 'calendar'>('summary')
  const [review, setReview] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const panel = useRef<HTMLDivElement>(null)
  const pending = job.status === 'new'
  useEffect(() => {
    if (stage === 'calendar' || review || (stage === 'message' && pending)) return
    const fade = window.setTimeout(() => setLeaving(true), 2000)
    const next = window.setTimeout(() => { setStage(stage === 'summary' ? 'message' : 'calendar'); setLeaving(false) }, stage === 'summary' ? 2000 : 2250)
    return () => { window.clearTimeout(fade); window.clearTimeout(next) }
  }, [stage, review, pending])
  useEffect(() => {
    if (stage === 'summary') return
    const previous = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    panel.current?.focus()
    return () => { document.body.style.overflow = overflow; previous?.focus() }
  }, [stage])
  if (stage === 'summary') return null
  return <div className="booking-dialog-backdrop">
    <div ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="booking-dialog-title"
      className={`booking-dialog ${leaving ? 'is-leaving' : ''}`} key={stage}
      onKeyDown={event => {
        if (event.key !== 'Tab') return
        const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('a[href],button'))
        const first = controls[0], last = controls[controls.length - 1]
        if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel.current)) { event.preventDefault(); first?.focus() }
      }}>
      {stage === 'message' ? <>
        <h2 id="booking-dialog-title">Thank you for your trust</h2>
        <div className="booking-dialog-copy">
          <p>{pending ? 'We will contact you to confirm your appointment.' : 'We appreciate your trust and look forward to helping you.'}</p>
          <p>{bookingArrivalMessage}</p>
          {emailEnabled && <p>Your booking details will be emailed to {job.email}. For appointments booked more than 24 hours ahead, we will also send an email reminder about a day before your visit.</p>}
          {emailEnabled && calendarEnabled && !pending && <p>A calendar invitation will also be emailed to you. Accept that invitation to receive appointment updates and cancellations in your calendar.</p>}
        </div>
        <div className="booking-dialog-contact">
          <strong>CONTACT US:</strong>
          <a href="mailto:alexeasyrepair@gmail.com"><Mail size={16} />alexeasyrepair@gmail.com</a>
          <a href="tel:4632488429"><Phone size={16} />(463) 248-8429</a>
        </div>
        {review && !pending && <button className="booking-secondary" onClick={() => setStage('calendar')}>Calendar options <ArrowRight size={18} /></button>}
      </> : <>
        <h2 id="booking-dialog-title">Save your appointment</h2>
        <div className="booking-dialog-actions">
          <a className="booking-primary" href={googleBookingCalendarUrl(job)} target="_blank" rel="noopener noreferrer"><CalendarPlus size={20} />Save to Google Calendar</a>
          <button className="booking-secondary" onClick={onDownload}><Download size={20} />Download Calendar Event</button>
        </div>
        <p className="booking-dialog-note">A saved calendar copy does not update automatically. Update or remove it if your appointment changes. Calendar alerts depend on your settings.</p>
        <button className="booking-dialog-back" onClick={() => { setReview(true); setLeaving(false); setStage('message') }}><ArrowLeft size={16} />Message and contact details</button>
      </>}
    </div>
  </div>
}
