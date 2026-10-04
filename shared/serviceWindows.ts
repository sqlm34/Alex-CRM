export const serviceWindows = ['9:00 AM - 11:00 AM', '11:00 AM - 1:00 PM', '1:00 PM - 3:00 PM', '3:00 PM - 5:00 PM']

export function parseServiceWindows(value: unknown): string[] {
  const parts = String(value || '').split(';').map(part => part.trim())
  if (!parts.length || parts.some(part => !serviceWindows.includes(part))) return []
  return serviceWindows.filter(window => parts.includes(window))
}

export function toggleServiceWindow(value: string, window: string) {
  const selected = parseServiceWindows(value)
  return serviceWindows.filter(item => item === window ? !selected.includes(item) : selected.includes(item)).join('; ')
}
