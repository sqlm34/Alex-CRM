import { useState } from 'react'

export function useBookingStep() {
  const [step, setStep] = useState(0)
  return { step, setStep }
}
