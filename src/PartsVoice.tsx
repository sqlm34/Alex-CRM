import { useEffect, useRef, useState } from 'react'
import { Mic, X } from 'lucide-react'
import { partsVoiceText, type VoiceMode } from './partsVoiceText'
import { speechAvailability, startSpeech, type SpeechStatus } from './partsSpeech'

const messages: Record<string, string> = {
  MICROPHONE_PERMISSION_DENIED: 'Microphone permission denied. Allow microphone access in app settings, then try again.',
  SPEECH_RECOGNITION_UNAVAILABLE: 'Speech recognition is unavailable for this language or device.',
  NO_SPEECH_DETECTED: 'No speech detected. Please try again.',
  RECOGNITION_FAILED: 'Could not recognize speech. Check your connection and try again.',
}

export function PartsVoice({ mode, disabled, language, onLanguageChange, onResult }: { mode: VoiceMode; disabled: boolean; language: string; onLanguageChange: (language: string) => void; onResult: (text: string) => void }) {
  const [unavailable, setUnavailable] = useState('Checking voice input...')
  const [status, setStatus] = useState<SpeechStatus | ''>('')
  const [error, setError] = useState('')
  const active = useRef<{ cancel: () => void; timer: ReturnType<typeof setTimeout> } | null>(null)
  const cancel = () => {
    const session = active.current
    active.current = null
    if (session) { clearTimeout(session.timer); session.cancel() }
  }
  useEffect(() => {
    let mounted = true
    void speechAvailability().then(message => { if (mounted) setUnavailable(message) })
    const background = () => { if (document.hidden) { cancel(); setStatus('') } }
    document.addEventListener('visibilitychange', background)
    return () => { mounted = false; cancel(); document.removeEventListener('visibilitychange', background) }
  }, [])

  async function start() {
    if (active.current || unavailable || disabled) return
    setError(''); setStatus('listening')
    const speech = startSpeech(language, value => { queueMicrotask(() => { if (active.current === session) setStatus(value) }) })
    const session = {
      cancel: speech.cancel,
      timer: setTimeout(() => {
        if (active.current !== session) return
        cancel(); setStatus(''); setError(messages.NO_SPEECH_DETECTED)
      }, 35000),
    }
    active.current = session
    try {
      const text = await speech.result
      if (active.current === session) onResult(partsVoiceText(text, mode))
    } catch (failure) {
      if (active.current === session && (!(failure instanceof Error) || failure.message !== 'CANCELLED')) {
        setError(messages[failure instanceof Error ? failure.message : ''] || messages.RECOGNITION_FAILED)
      }
    } finally {
      clearTimeout(session.timer)
      if (active.current === session) { active.current = null; setStatus('') }
    }
  }
  const label = mode === 'model' ? 'Dictate model number' : mode === 'part_number' ? 'Dictate part number' : 'Dictate part name'
  return <div className="parts-voice">
    <div className="parts-voice-controls">
      <button type="button" aria-label={label} title={unavailable || label} disabled={!!unavailable || disabled || !!status} className={status ? 'parts-mic active' : 'parts-mic'} onClick={() => void start()}><Mic size={20} /></button>
      <select aria-label="Voice language" value={language} disabled={!!status || disabled} onChange={event => onLanguageChange(event.target.value)}><option value="en-US">EN</option><option value="ru-RU">RU</option></select>
      {status ? <button type="button" aria-label="Cancel voice input" title="Cancel voice input" onClick={() => { cancel(); setStatus('') }}><X size={18} /></button> : null}
    </div>
    {status ? <p role="status">{status === 'listening' ? 'Listening...' : 'Recognizing...'}</p> : null}
    {unavailable ? <p className="parts-voice-unavailable">{unavailable}</p> : null}
    {error ? <p role="alert" className="parts-error">{error}</p> : null}
  </div>
}
