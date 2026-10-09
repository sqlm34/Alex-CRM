export const serviceWindows = ['9:00 AM - 11:00 AM', '11:00 AM - 1:00 PM', '1:00 PM - 3:00 PM', '3:00 PM - 5:00 PM']

export function parseServiceWindows(value: unknown): string[] {
  const parts = String(value || '').split(';').map(part => part.trim())
  if (!parts.length || parts.length > 32) return []
  const intervals = parts.map(part => {
    const pair = part.split(/\s*-\s*/)
    const start = timeMinutes(pair[0]), end = timeMinutes(pair[1])
    return pair.length === 2 && start !== null && end !== null && end > start ? { start, end } : null
  })
  if (intervals.some(interval => !interval)) return []
  return [...new Set(intervals.sort((a, b) => a!.start - b!.start).map(interval => `${formatTime(interval!.start)} - ${formatTime(interval!.end)}`))]
}

export function timeMinutes(value: unknown): number | null {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i)
  if (!match || Number(match[1]) < 1 || Number(match[1]) > 12 || Number(match[2]) > 59) return null
  return (Number(match[1]) % 12 + (match[3].toUpperCase() === 'PM' ? 12 : 0)) * 60 + Number(match[2])
}

export function formatTime(minutes: number) {
  return `${Math.floor(minutes / 60) % 12 || 12}:${String(minutes % 60).padStart(2, '0')} ${minutes >= 720 ? 'PM' : 'AM'}`
}

export function serviceWindowsOverlap(left: string, right: string) {
  return parseServiceWindows(left).some(a => parseServiceWindows(right).some(b => {
    const [startA, endA] = a.split(' - ').map(timeMinutes)
    const [startB, endB] = b.split(' - ').map(timeMinutes)
    return startA! < endB! && startB! < endA!
  }))
}

export function toggleServiceWindow(value: string, window: string) {
  const selected = parseServiceWindows(value)
  return serviceWindows.filter(item => item === window ? !selected.includes(item) : selected.includes(item)).join('; ')
}
