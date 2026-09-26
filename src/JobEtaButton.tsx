import { useEffect, useRef, useState } from 'react'
import { Capacitor, registerPlugin } from '@capacitor/core'
import { Copy, MessageSquare, Star } from 'lucide-react'
import { reviewSms } from './reviewSms'
import { drivingDuration, etaMessage, etaRecipient } from './jobEta'
import './JobEtaButton.css'

const SmsComposer = registerPlugin<{ open(options: { phone: string; body: string }): Promise<void> }>('SmsComposer')

export function JobEtaButton({ customer, phone, address, disabled }: {
  customer: string; phone: string; address: string; disabled?: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [notice, setNotice] = useState('')
  const running = useRef(false)
  const active = useRef(false)
  useEffect(() => {
    active.current = true
    return () => { active.current = false }
  }, [])

  async function prepare(review = false) {
    if (running.current || disabled) return
    running.current = true
    setBusy(true)
    setMessage('')
    setNotice('')
    try {
      const recipient = review ? reviewSms(customer, phone) : etaRecipient(customer, phone, address)
      if (Capacitor.isNativePlatform() && !Capacitor.isPluginAvailable('SmsComposer')) {
        throw new Error('Update the Android app to open the SMS composer.')
      }
      const result = review
        ? { text: reviewSms(customer, phone).text, fromMinutes: 0, toMinutes: 0 }
        : etaMessage(recipient.firstName, await drivingDuration(address.trim()))
      if (!active.current) return
      if (Capacitor.isNativePlatform()) {
        await SmsComposer.open({ phone: recipient.phone, body: result.text })
        if (active.current) setNotice('SMS composer opened. Review the message and press Send yourself.')
      } else {
        setMessage(result.text)
        setNotice(review ? 'Review request prepared, not sent.' : `ETA: ${result.fromMinutes}-${result.toMinutes} minutes. Message prepared, not sent.`)
      }
    } catch (error) {
      if (active.current) setNotice(error instanceof Error ? error.message : 'Cannot prepare ETA.')
    } finally {
      running.current = false
      if (active.current) setBusy(false)
    }
  }

  return <div className="job-eta">
    <div className="job-message-actions">
    <button type="button" className="job-eta-button" disabled={busy || disabled} onClick={() => void prepare()}>
      <MessageSquare size={20} />{busy ? 'Preparing...' : 'TEXT ETA'}
    </button>
    <button type="button" className="job-eta-button" disabled={busy || disabled} onClick={() => void prepare(true)}>
      <Star size={20} />Reviews
    </button>
    </div>
    {notice && <p role="status">{notice}</p>}
    {message && <>
      <p className="job-eta-message">{message}</p>
      <button type="button" className="job-eta-button" onClick={() => {
        if (!navigator.clipboard) { setNotice('Unable to copy. Select and copy the message.'); return }
        void navigator.clipboard.writeText(message).then(() => setNotice('Message copied, not sent.')).catch(() => setNotice('Unable to copy. Select and copy the message.'))
      }}><Copy size={18} />Copy</button>
    </>}
  </div>
}
