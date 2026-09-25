import { useEffect, useRef, useState } from 'react'
import { Capacitor, registerPlugin } from '@capacitor/core'
import { Copy, MessageSquare } from 'lucide-react'
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

  async function prepare() {
    if (running.current || disabled) return
    running.current = true
    setBusy(true)
    setMessage('')
    setNotice('')
    try {
      const recipient = etaRecipient(customer, phone, address)
      if (Capacitor.isNativePlatform() && !Capacitor.isPluginAvailable('SmsComposer')) {
        throw new Error('Update the Android app to open the ETA SMS composer.')
      }
      const duration = await drivingDuration(recipient.address)
      if (!active.current) return
      const result = etaMessage(recipient.firstName, duration)
      if (Capacitor.isNativePlatform()) {
        await SmsComposer.open({ phone: recipient.phone, body: result.text })
        if (active.current) setNotice('SMS composer opened. Review the message and press Send yourself.')
      } else {
        setMessage(result.text)
        setNotice(`ETA: ${result.fromMinutes}-${result.toMinutes} minutes. Message prepared, not sent.`)
      }
    } catch (error) {
      if (active.current) setNotice(error instanceof Error ? error.message : 'Cannot prepare ETA.')
    } finally {
      running.current = false
      if (active.current) setBusy(false)
    }
  }

  return <div className="job-eta">
    <button type="button" className="job-eta-button" disabled={busy || disabled} onClick={() => void prepare()}>
      <MessageSquare size={20} />{busy ? 'Preparing ETA...' : 'TEXT ETA'}
    </button>
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
