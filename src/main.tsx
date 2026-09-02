import { Component, StrictMode, type ErrorInfo, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

type RootErrorBoundaryState = {
  message: string
}

class RootErrorBoundary extends Component<{ children: ReactNode }, RootErrorBoundaryState> {
  state: RootErrorBoundaryState = { message: '' }

  static getDerivedStateFromError(error: unknown) {
    return { message: error instanceof Error && error.message ? error.message : 'The app could not render this screen.' }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('Alex CRM render error', error, info.componentStack)
  }

  render() {
    if (this.state.message) {
      return (
        <main className="root-error-screen">
          <section>
            <img src="/favicon.png" alt="Alex Appliance Repair" />
            <h1>Unable to load jobs</h1>
            <p>{this.state.message}</p>
            <button type="button" onClick={() => window.location.reload()}>
              Reload
            </button>
          </section>
        </main>
      )
    }

    return this.props.children
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </StrictMode>,
)
