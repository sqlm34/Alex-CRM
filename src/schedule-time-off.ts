import type { AvailabilityBlock } from './api'

export function withTimeOffDates<T extends { date: string; jobs: unknown[] }>(groups: T[], blocks: AvailabilityBlock[]) {
  const result = new Map<string, { date: string; jobs: T['jobs']; blocks: AvailabilityBlock[] }>()
  for (const group of groups) result.set(group.date, { ...group, blocks: [] })
  for (const block of blocks) {
    const date = block.blocked_date.slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    const group = result.get(date) || { date, jobs: [] as unknown as T['jobs'], blocks: [] }
    group.blocks.push(block)
    result.set(date, group)
  }
  return [...result.values()].sort((a, b) => a.date.localeCompare(b.date))
}
