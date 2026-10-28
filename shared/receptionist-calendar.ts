export const callTimeZone = 'America/Indiana/Indianapolis'
export function callDate(value: string | Date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: callTimeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value))
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value).join('-')
}
export function shiftCallDate(date: string, days: number) {
  const value = new Date(`${date}T12:00:00Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}
export function validCallDate(date: string) {
  return /^20\d{2}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(`${date}T12:00:00Z`)) && new Date(`${date}T12:00:00Z`).toISOString().slice(0,10) === date
}
export function groupCallsByDate<T extends { started_at: string }>(calls: T[]) {
  const groups = new Map<string, T[]>()
  for (const call of calls) {
    if (!Number.isFinite(new Date(call.started_at).getTime())) continue
    const date = callDate(call.started_at)
    groups.set(date, [...(groups.get(date) || []), call])
  }
  return [...groups].sort(([a], [b]) => b.localeCompare(a)).map(([date, items]) => ({ date, calls: items.sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime()) }))
}
