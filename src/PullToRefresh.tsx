import { useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'

export function PullToRefresh({ onRefresh, onError }: { onRefresh: () => Promise<void>; onError: (error: unknown) => void }) {
  const callbacks = useRef({ onRefresh, onError })
  callbacks.current = { onRefresh, onError }
  const [distance, setDistance] = useState(0)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    let start: { x: number; y: number } | null = null
    let pull = 0
    let busy = false
    let disposed = false
    const reset = () => {
      start = null
      pull = 0
      setDistance(0)
      document.documentElement.style.removeProperty('--pull-refresh-offset')
    }
    const onStart = (event: TouchEvent) => {
      if (busy || event.touches.length !== 1 || window.scrollY > 1) return
      const target = event.target as HTMLElement
      if (target.closest('input, textarea, select, iframe, [data-disable-swipe-back], .sidebar, .modal-backdrop')) return
      for (let node: HTMLElement | null = target; node; node = node.parentElement) {
        if (node.scrollTop > 1) return
      }
      start = { x: event.touches[0].clientX, y: event.touches[0].clientY }
    }
    const onMove = (event: TouchEvent) => {
      if (!start || busy) return
      if (event.touches.length !== 1) { reset(); return }
      const dx = event.touches[0].clientX - start.x
      const dy = event.touches[0].clientY - start.y
      if (dy < 0 || Math.abs(dx) > Math.max(20, dy)) { reset(); return }
      if (dy < 8) return
      if (!event.cancelable) { reset(); return }
      event.preventDefault()
      pull = Math.min(90, dy * 0.45)
      setDistance(pull)
      document.documentElement.style.setProperty('--pull-refresh-offset', `${pull}px`)
    }
    const onEnd = () => {
      if (!start || busy) return
      const ready = pull >= 60
      reset()
      if (!ready) return
      busy = true
      setRefreshing(true)
      void callbacks.current.onRefresh().catch(error => {
        if (!disposed) callbacks.current.onError(error)
      }).finally(() => {
        busy = false
        if (!disposed) setRefreshing(false)
      })
    }
    document.documentElement.classList.add('pull-refresh-enabled')
    document.addEventListener('touchstart', onStart, { passive: true })
    document.addEventListener('touchmove', onMove, { passive: false })
    document.addEventListener('touchend', onEnd)
    document.addEventListener('touchcancel', reset)
    return () => {
      disposed = true
      document.documentElement.classList.remove('pull-refresh-enabled')
      document.documentElement.style.removeProperty('--pull-refresh-offset')
      document.removeEventListener('touchstart', onStart)
      document.removeEventListener('touchmove', onMove)
      document.removeEventListener('touchend', onEnd)
      document.removeEventListener('touchcancel', reset)
    }
  }, [])

  return distance > 0 || refreshing ? <div className="pull-refresh-indicator" role="status" aria-label={refreshing ? 'Refreshing' : distance >= 60 ? 'Release to refresh' : 'Pull to refresh'}>
    <RefreshCw size={22} className={refreshing ? 'pull-refresh-spinning' : ''} style={refreshing ? undefined : { transform: `rotate(${distance * 3}deg)` }} />
  </div> : null
}
