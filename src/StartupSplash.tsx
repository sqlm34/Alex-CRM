import { useEffect, useLayoutEffect, useState, type ReactNode } from 'react'
import { Capacitor } from '@capacitor/core'
import { Microwave, Refrigerator, WashingMachine } from 'lucide-react'
import './StartupSplash.css'

const appliances = ['refrigerator', 'washer', 'dryer', 'dishwasher', 'oven', 'microwave'] as const
// Fixed irregular timing avoids restarting the effect with a different pattern on render.
const rayDelays = [.52, 1.31, .83, 1.58, .69, 1.12, .94, 1.43, .61, 1.24, 1.02, .76, 1.49, .89, 1.17, 1.37]

function ApplianceIcon({ kind }: { kind: typeof appliances[number] }) {
  if (kind === 'refrigerator') return <Refrigerator strokeWidth={1.25} />
  if (kind === 'washer') return <WashingMachine strokeWidth={1.25} />
  if (kind === 'microwave') return <Microwave strokeWidth={1.25} />
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="2" width="18" height="20" rx="1.5" />
      <path d="M3 7h18M6 4.5h3M16 4.5h2" />
      {kind === 'dryer' ? <><circle cx="12" cy="14" r="5" /><path d="M10 11c-2 2 2 3 0 6m4-6c-2 2 2 3 0 6" /></>
        : kind === 'dishwasher' ? <><path d="M7 10h10M7 14v4m3-5v5m4-5v5m3-4v4M6 19h12" /></>
          : <><rect x="6" y="10" width="12" height="9" rx="1" /><path d="M7 1h3m4 0h3M8 12h8" /></>}
    </svg>
  )
}

export function StartupSplash({ children }: { children: ReactNode }) {
  const [startedAt] = useState(() => performance.now())
  const [visible, setVisible] = useState(() => Capacitor.getPlatform() === 'android' && !window.location.pathname.startsWith('/booking'))

  useLayoutEffect(() => {
    document.documentElement.classList.toggle('android-startup', visible)
    return () => document.documentElement.classList.remove('android-startup')
  }, [visible])

  useEffect(() => {
    if (!visible) return
    const finish = () => {
      if (performance.now() - startedAt >= 10_000) setVisible(false)
    }
    const timer = window.setTimeout(() => setVisible(false), Math.max(0, 10_000 - (performance.now() - startedAt)))
    // A suspended WebView may delay its timeout; resume must not replay the intro.
    document.addEventListener('visibilitychange', finish)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', finish)
    }
  }, [visible, startedAt])

  return (
    <>
      <div className="startup-app" inert={visible} aria-hidden={visible ? true : undefined}>{children}</div>
      {visible && (
        <div className="startup-splash" role="status" aria-label="Alex Appliance Repair is loading" data-disable-swipe-back>
          <div className="startup-scene" aria-hidden="true">
            <div className="startup-emblem">
              <div className="startup-starburst">
                {[0, 24, 43, 67, 90, 116, 139, 158, 180, 203, 227, 249, 270, 294, 317, 341].map((angle, index) => (
                  <span key={angle} style={{ transform: `rotate(${angle}deg)` }}>
                    <i style={{
                      animationDelay: `${rayDelays[index]}s`,
                      animationDuration: `${.7 + (index * 5 % 7) * .06}s`,
                      filter: `blur(${index % 3 === 0 ? 8 : 5}px) brightness(${1.2 + index % 4 * .15})`,
                    }} />
                  </span>
                ))}
              </div>
              <div className="startup-birth"><span /></div>
              <div className="startup-ripples">{[0, 1, 2, 3].map(wave => <span key={wave} style={{ animationDelay: `${1.6 + wave * .6}s` }} />)}</div>
              <div className="startup-logo-enter"><img className="startup-logo" src="/pwa-512.png" alt="" width="512" height="512" fetchPriority="high" /></div>
              <div className="startup-ring" />
              <div className="startup-orbit"><span /></div>
            </div>
            <p className="startup-values"><span>FAST</span><i /><span>RELIABLE</span><i /><span>LOCAL</span></p>
            <div className="startup-appliances">
              {appliances.map((kind, index) => (
                <div key={kind} className="startup-appliance" data-appliance={kind} style={{ animationDelay: `${-index * 1.5}s` }}>
                  <ApplianceIcon kind={kind} />
                </div>
              ))}
            </div>
            <div className="startup-loading">
              <p>Loading...</p>
              <div className="startup-dots">{[0, 1, 2, 3, 4].map((dot) => <span key={dot} style={{ animationDelay: `${dot * 0.27}s` }} />)}</div>
            </div>
          </div>
          <div className="startup-waves" aria-hidden="true">
            {[0, 1, 2].map((wave) => (
              <svg key={wave} className={`startup-wave startup-wave-${wave}`} viewBox="0 0 1200 160" preserveAspectRatio="none">
                <path d="M-400 65 C-200 -10 0 -10 200 65 S600 140 800 65 S1200 -10 1400 65 S1800 140 2000 65" />
                <path d="M-400 72 C-200 0 0 0 200 72 S600 150 800 72 S1200 0 1400 72 S1800 150 2000 72" />
              </svg>
            ))}
          </div>
          <p className="startup-tagline" aria-hidden="true">APPLIANCES KEEP LIFE GOING</p>
        </div>
      )}
    </>
  )
}
