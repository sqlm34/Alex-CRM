import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'

export type SpeechStatus = 'listening' | 'recognizing'
interface NativeSpeech {
  available(): Promise<{ available: boolean }>
  start(options: { language: string; session: string }): Promise<{ text: string }>
  cancel(options: { session: string }): Promise<void>
  addListener(event: 'state', listener: (event: { session: string; status: SpeechStatus }) => void): Promise<PluginListenerHandle>
}
const nativeSpeech = registerPlugin<NativeSpeech>('PartsSpeech')

interface WebSpeech {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  onstart: (() => void) | null
  onspeechend: (() => void) | null
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
  start(): void
  abort(): void
}
function webConstructor(): (new () => WebSpeech) | undefined {
  const host = window as unknown as { SpeechRecognition?: new () => WebSpeech; webkitSpeechRecognition?: new () => WebSpeech }
  return window.isSecureContext ? host.SpeechRecognition || host.webkitSpeechRecognition : undefined
}

export async function speechAvailability(): Promise<string> {
  if (Capacitor.isNativePlatform()) {
    if (!Capacitor.isPluginAvailable('PartsSpeech')) return 'Update the Android app to enable voice input.'
    try { return (await nativeSpeech.available()).available ? '' : 'Speech recognition is unavailable on this device.' }
    catch { return 'Speech recognition is unavailable on this device.' }
  }
  return webConstructor() ? '' : 'Voice input is unavailable in this browser.'
}

export function startSpeech(language: string, onStatus: (status: SpeechStatus) => void) {
  const session = crypto.randomUUID()
  let cancelled = false
  let listener: PluginListenerHandle | undefined
  let web: WebSpeech | undefined
  let rejectWeb: ((error: Error) => void) | undefined
  const cancel = () => {
    cancelled = true
    if (Capacitor.isNativePlatform()) void nativeSpeech.cancel({ session }).catch(() => {})
    web?.abort()
    rejectWeb?.(new Error('CANCELLED'))
  }
  const result = (async () => {
    try {
      if (Capacitor.isNativePlatform()) {
        listener = await nativeSpeech.addListener('state', event => {
          if (!cancelled && event.session === session) onStatus(event.status)
        })
        if (cancelled) throw new Error('CANCELLED')
        return (await nativeSpeech.start({ session, language })).text
      }
      const Constructor = webConstructor()
      if (!Constructor) throw new Error('SPEECH_RECOGNITION_UNAVAILABLE')
      web = new Constructor()
      web.lang = language; web.continuous = false; web.interimResults = false; web.maxAlternatives = 1
      return await new Promise<string>((resolve, reject) => {
        rejectWeb = reject
        web!.onstart = () => { if (!cancelled) onStatus('listening') }
        web!.onspeechend = () => { if (!cancelled) onStatus('recognizing') }
        web!.onresult = event => {
          const text = event.results[0]?.[0]?.transcript?.trim()
          if (cancelled) reject(new Error('CANCELLED'))
          else if (text) resolve(text)
          else reject(new Error('NO_SPEECH_DETECTED'))
        }
        web!.onerror = event => reject(new Error(
          event.error === 'not-allowed' || event.error === 'service-not-allowed' ? 'MICROPHONE_PERMISSION_DENIED'
            : event.error === 'no-speech' ? 'NO_SPEECH_DETECTED'
              : event.error === 'aborted' ? 'CANCELLED' : 'RECOGNITION_FAILED'))
        web!.onend = () => reject(new Error('NO_SPEECH_DETECTED'))
        web!.start()
      })
    } finally {
      await listener?.remove()
      if (web) {
        web.onstart = web.onspeechend = web.onresult = web.onerror = web.onend = null
        web.abort()
      }
    }
  })()
  return { result, cancel }
}
