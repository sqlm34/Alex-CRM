import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { StartupSplash } from '../src/StartupSplash'

// Local visual harness only: this is NOT an Android runtime/capability verification.
if (import.meta.env.DEV) {
  Object.assign(window, { androidBridge: {} })
  const Fixture = () => {
    const [polls, setPolls] = useState(0)
    useEffect(() => {
      const timer = window.setInterval(() => setPolls(value => value + 1), 500)
      return () => window.clearInterval(timer)
    }, [])
    return <main style={{ minHeight: '100dvh', background: '#f4f8f9', padding: 24, boxSizing: 'border-box', fontFamily: 'sans-serif' }}>
      <h1>Schedule preview</h1><p>No customer data. No API requests.</p>
      <output data-testid="polls">{polls}</output>
      <input aria-label="Retained draft" defaultValue="Draft preserved" />
      <button onClick={() => window.history.pushState({}, '', '#job')}>Open job</button>
    </main>
  }
  createRoot(document.getElementById('root')!).render(<StrictMode><StartupSplash><Fixture /></StartupSplash></StrictMode>)
}
