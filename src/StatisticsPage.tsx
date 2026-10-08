import { useEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { fetchJobFromApi, fetchJobsFromApi, receiptRequest } from './api'
import type { JobListRow, JobRow } from './supabase'
import { receiptCosts, type ReceiptRecord } from '../shared/receipts'
import { monthJobs, sourceSeries } from './statistics'
import './StatisticsPage.css'

const colors = ['#1671bf', '#17845c', '#a35b08', '#8056a5']
const money = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100)
type Totals = { gross: number; parts: number; fees: number; withoutReceipts: number }

function StatisticsChart({ series, max, label }: { series: ReturnType<typeof sourceSeries>; max: number; label: string }) {
  const container = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(320)
  useEffect(() => {
    const observer = new ResizeObserver(entries => {
      const measured = entries[0]?.contentRect.width
      if (measured) setWidth(measured)
    })
    if (container.current) observer.observe(container.current)
    return () => observer.disconnect()
  }, [])
  const days = series[0].values.length
  const x = (day: number) => 44 + (day - 1) * (width - 64) / (days - 1)
  const ticks = width < 480 ? [1, 7, 14, 21, days] : [1, 5, 10, 15, 20, 25, days]
  return <div ref={container} className="statistics-chart-container">
    <svg className="statistics-chart" viewBox={`0 0 ${width} 320`} role="img" aria-label={label}>
      {[0, 1, 2, 3, 4].map(tick => <g key={tick}><line x1="44" x2={width - 20} y1={270 - tick * 60} y2={270 - tick * 60} stroke="#dce5e5" /><text x="34" y={275 - tick * 60} textAnchor="end">{max * tick / 4}</text></g>)}
      {series.filter(s => s.source !== 'Other' || s.total).map(s => <polyline key={s.source} fill="none" stroke={colors[series.indexOf(s)]} strokeWidth="3" strokeLinejoin="round" points={s.values.map((value, day) => `${x(day + 1)},${270 - value * 240 / max}`).join(' ')} />)}
      {ticks.map(day => <text key={day} x={x(day)} y="294" textAnchor="middle">{day}</text>)}
      <text x="44" y="18">Orders</text><text x={width - 20} y="316" textAnchor="end">Day</text>
    </svg>
  </div>
}

export function StatisticsPage({ token, invoiceTotal }: { token?: string; invoiceTotal: (job: JobRow) => number }) {
  const [month, setMonth] = useState(() => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Indiana/Indianapolis', year: 'numeric', month: '2-digit' }).formatToParts(new Date())
    return `${parts.find(p => p.type === 'year')!.value}-${parts.find(p => p.type === 'month')!.value}`
  })
  const [jobs, setJobs] = useState<JobListRow[] | null>(null)
  const [totals, setTotals] = useState<Totals | null>(null)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const [progress, setProgress] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    fetchJobsFromApi(token, controller.signal).then(rows => {
      if (!controller.signal.aborted) { if (!rows) throw new Error('Statistics requires a server connection'); setJobs(rows); setError('') }
    }).catch(e => { if (!controller.signal.aborted) setError(e.message) })
    return () => controller.abort()
  }, [token, revision])
  const selected = useMemo(() => monthJobs(jobs || [], month), [jobs, month])
  useEffect(() => {
    if (!jobs) return
    const controller = new AbortController()
    const total: Totals = { gross: 0, parts: 0, fees: 0, withoutReceipts: 0 }
    let next = 0, completed = 0
    // Bound concurrent reads; never show partial financial totals as a complete result.
    async function load() {
      while (next < selected.length && !controller.signal.aborted) {
        const job = selected[next++]
        const detail = await fetchJobFromApi(job.id, token, controller.signal)
        const { receipts } = await receiptRequest<{ receipts: ReceiptRecord[] }>(job.id, token, '', undefined, controller.signal)
        if (!detail) throw new Error('Unable to load financial data')
        total.gross += invoiceTotal(detail)
        total.parts += receiptCosts(receipts)
        total.withoutReceipts += receipts.some(r => r.status === 'confirmed') ? 0 : 1
        total.fees += (detail.payments || []).filter(p => !p.voidedAt && ['', 'succeeded', 'completed', 'paid', 'refunded'].includes((p.status || '').toLowerCase())).reduce((sum, p) => sum + Math.max(0, Math.round(p.processingFeeCents || 0)), 0)
        completed++
        if (!controller.signal.aborted) setProgress(completed)
      }
    }
    void Promise.all(Array.from({ length: Math.min(3, selected.length) }, load)).then(() => {
      if (!controller.signal.aborted) setTotals(total)
    }).catch(e => { if (!controller.signal.aborted) { setError(e.message); controller.abort() } })
    return () => controller.abort()
  }, [jobs, selected, token, invoiceTotal])
  const series = sourceSeries(jobs || [], month)
  const max = Math.ceil(Math.max(1, ...series.flatMap(s => s.values)) / 4) * 4
  const months = [...new Set([month, ...(jobs || []).map(j => j.service_date?.slice(0, 7)).filter(Boolean)])].sort().reverse()
  const monthLabel = (value: string) => new Date(`${value}-15T12:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
  return <main className="statistics-page">
    <header><h2>Statistics</h2><button type="button" aria-label="Refresh statistics" title="Refresh statistics" onClick={() => { setJobs(null); setTotals(null); setProgress(0); setError(''); setRevision(v => v + 1) }}><RefreshCw size={20} /></button></header>
    <label className="statistics-month">Month<select value={month} onChange={e => { setTotals(null); setProgress(0); setError(''); setMonth(e.target.value) }}>{months.map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}</select></label>
    <p className="statistics-basis">By service date · Canceled orders excluded</p>
    {error ? <p role="alert">{error}. Refresh to retry. Financial totals are unavailable.</p> : null}
    {!jobs && !error ? <p role="status">Loading statistics...</p> : null}
    {jobs ? <>
      <section aria-label="Orders by source"><h3>Orders by source <span>{selected.length} orders</span></h3>
        <StatisticsChart series={series} max={max} label={`Daily orders for ${monthLabel(month)}. Website ${series[0].total}, Phone ${series[1].total}, Google ${series[2].total}.`} />
        <dl className="statistics-legend">{series.filter(s => s.source !== 'Other' || s.total).map(s => <div key={s.source}><dt><i style={{ background: colors[series.indexOf(s)] }} />{s.source}</dt><dd>{s.total} orders</dd></div>)}</dl>
        {!selected.length ? <p>No orders for this month.</p> : null}
      </section>
      <section aria-label="Income"><h3>Income</h3>{!totals && !error ? <p role="status">Loading costs: {progress} / {selected.length} orders</p> : null}
        {totals ? <><dl className="statistics-income">
          <div><dt>Gross billed<small>Invoice totals, including invoice tax</small></dt><dd>{money(totals.gross)}</dd></div>
          <div><dt>Parts expenses</dt><dd>{money(totals.parts)}</dd></div>
          <div><dt>Recorded payment fees</dt><dd>{money(totals.fees)}</dd></div>
          <div className="statistics-net"><dt>Net Income<small>Gross billed minus recorded parts and fees</small></dt><dd>{money(totals.gross - totals.parts - totals.fees)}</dd></div>
        </dl><p className="statistics-basis">Invoice-based, not cash received. Unrecorded expenses and tax remittances are not deducted.</p>{totals.withoutReceipts ? <p className="statistics-warning">{totals.withoutReceipts} orders have no confirmed parts receipts. Net Income is provisional until all costs are recorded.</p> : null}</> : null}
      </section>
    </> : null}
  </main>
}
