import type { JobListRow } from './supabase'

export const statisticsSources = ['Website', 'Phone', 'Google', 'Other'] as const
export type StatisticsSource = typeof statisticsSources[number]
export type MonthlyStatistics = {
  month: string; orders: number; gross: number; parts: number; fees: number; net: number
  withoutReceipts: number; updatedAt?: string
  days: { day: number; source: StatisticsSource; count: number }[]
}
export function savedSourceSeries(report: MonthlyStatistics) {
  const series = sourceSeries([], report.month)
  for (const day of report.days) {
    const source = series.find(s => s.source === day.source)
    if (source && day.day > 0 && day.day <= source.values.length) {
      source.values[day.day - 1] += day.count
      source.total += day.count
    }
  }
  return series
}
export function statisticsSource(job: JobListRow): StatisticsSource {
  if (job.booking_source === 'google' || job.booking_source === 'google_maps' || job.booking_source_detail === 'actions_center') return 'Google'
  if (job.booking_source === 'website') return 'Website'
  return !job.booking_source ? 'Phone' : 'Other'
}
export function monthJobs(jobs: JobListRow[], month: string) {
  return jobs.filter(job => job.status !== 'canceled' && job.service_date?.slice(0, 7) === month)
}
export function sourceSeries(jobs: JobListRow[], month: string) {
  const [year, number] = month.split('-').map(Number)
  const days = new Date(year, number, 0).getDate()
  return statisticsSources.map(source => {
    const values = Array<number>(days).fill(0)
    for (const job of monthJobs(jobs, month)) {
      const day = Number(job.service_date.slice(8, 10))
      if (statisticsSource(job) === source && day >= 1 && day <= days) values[day - 1]++
    }
    return { source, values, total: values.reduce((sum, value) => sum + value, 0) }
  })
}
