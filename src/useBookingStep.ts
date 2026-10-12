import { useEffect, useRef, useState } from 'react'
import type { SetStateAction } from 'react'

export function useBookingStep() {
  const [step, commitStep] = useState(0)
  const [progress, setProgress] = useState(0)
  const [running, setRunning] = useState(false)
  const frame = useRef(0)
  const locked = useRef(false)
  useEffect(() => () => cancelAnimationFrame(frame.current), [])

  const setStep = (action: SetStateAction<number>) => {
    if (locked.current) return
    const target = typeof action === 'function' ? action(step) : action
    if (target !== step + 1 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      commitStep(target)
      setProgress(target)
      return
    }
    locked.current = true
    setRunning(true)
    document.querySelector('.booking-stepper')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    let start: number | undefined
    const tick = (now: number) => {
      start ??= now
      const portion = Math.min((now - start) / 1800, 1)
      setProgress(step + portion)
      if (portion < 1) frame.current = requestAnimationFrame(tick)
      else {
        locked.current = false
        setRunning(false)
        commitStep(target)
      }
    }
    frame.current = requestAnimationFrame(tick)
  }
  return { step, setStep, progress, running }
}
