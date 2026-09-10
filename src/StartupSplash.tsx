import { useEffect, useLayoutEffect, useState, type ReactNode } from 'react'
import { Capacitor } from '@capacitor/core'
import './StartupSplash.css'

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
              <div className="startup-logo-enter"><img className="startup-logo" src="/pwa-512.png" alt="" width="512" height="512" fetchPriority="high" /></div>
              <div className="startup-ring" />
              <div className="startup-orbit"><span /></div>
            </div>
            <p className="startup-values"><span>FAST</span><i /><span>RELIABLE</span><i /><span>LOCAL</span></p>
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
