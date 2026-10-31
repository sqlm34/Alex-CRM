import { useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { fetchStatistics, fetchOrdersWithoutReceipts, type MissingReceiptOrder } from './api'
import { savedSourceSeries, type MonthlyStatistics } from './statistics'
import './StatisticsPage.css'

const colors = ['#1671bf', '#17845c', '#a35b08', '#8056a5']
const money = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100)

function StatisticsChart({ series, max, label }: { series: ReturnType<typeof savedSourceSeries>; max: number; label: string }) {
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

export function StatisticsPage({ token, view, onViewChange, orderNumbers, onOpenJob }: { token?: string; view: { month: string; expanded: boolean }; onViewChange: (view: { month: string; expanded: boolean }) => void; orderNumbers: Map<string,string>; onOpenJob: (id: string) => Promise<void> }) {
  const [defaultMonth] = useState(() => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Indiana/Indianapolis', year: 'numeric', month: '2-digit' }).formatToParts(new Date())
    return `${parts.find(p => p.type === 'year')!.value}-${parts.find(p => p.type === 'month')!.value}`
  })
  const month = view.month || defaultMonth
  const [missing, setMissing] = useState<{ key: string; orders?: MissingReceiptOrder[]; error?: string } | null>(null)
  const [opening, setOpening] = useState('')
  const [reports, setReports] = useState<MonthlyStatistics[] | null>(null)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const missingKey = `${month}:${revision}`
  useEffect(() => {
    if (!view.expanded) return
    const controller = new AbortController()
    fetchOrdersWithoutReceipts(month, token, controller.signal).then(data => {
      if (!controller.signal.aborted) setMissing({ key: missingKey, orders: data.orders })
    }).catch(e => { if (!controller.signal.aborted) setMissing({ key: missingKey, error: e.message }) })
    return () => controller.abort()
  }, [month, token, missingKey, view.expanded])
  useEffect(() => {
    const controller = new AbortController()
    fetchStatistics(token, controller.signal).then(data => {
      if (!controller.signal.aborted) { setReports(data.reports); setError('') }
    }).catch(e => { if (!controller.signal.aborted) setError(e.message) })
    return () => controller.abort()
  }, [token, revision])
  const totals: MonthlyStatistics = reports?.find(r => r.month === month) || { month, orders: 0, gross: 0, parts: 0, fees: 0, net: 0, withoutReceipts: 0, days: [] }
  const series = savedSourceSeries(totals)
  const max = Math.ceil(Math.max(1, ...series.flatMap(s => s.values)) / 4) * 4
  const months = [...new Set([month, ...(reports || []).map(r => r.month)])].sort().reverse()
  const monthLabel = (value: string) => new Date(`${value}-15T12:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
  return <main className="statistics-page">
    <header><h2>Statistics</h2><button type="button" aria-label="Refresh statistics" title="Refresh statistics" onClick={() => { setReports(null); setError(''); setRevision(v => v + 1) }}><RefreshCw size={20} /></button></header>
    <label className="statistics-month">Month<select value={month} onChange={e => onViewChange({ month: e.target.value, expanded: false })}>{months.map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}</select></label>
    <p className="statistics-basis">By service date · Canceled orders excluded</p>
    {error ? <p role="alert">{error}. Refresh to retry. Financial totals are unavailable.</p> : null}
    {!reports && !error ? <p role="status">Loading statistics...</p> : null}
    {reports ? <>
      <section aria-label="Orders by source"><h3>Orders by source <span>{totals.orders} orders</span></h3>
        <StatisticsChart series={series} max={max} label={`Daily orders for ${monthLabel(month)}. Website ${series[0].total}, Phone ${series[1].total}, Google ${series[2].total}.`} />
        <dl className="statistics-legend">{series.filter(s => s.source !== 'Other' || s.total).map(s => <div key={s.source}><dt><i style={{ background: colors[series.indexOf(s)] }} />{s.source}</dt><dd>{s.total} orders</dd></div>)}</dl>
        {!totals.orders ? <p>No orders for this month.</p> : null}
      </section>
      <section aria-label="Income"><h3>Income</h3>
        {totals ? <><dl className="statistics-income">
          <div><dt>Gross billed<small>Invoice totals, including invoice tax</small></dt><dd>{money(totals.gross)}</dd></div>
          <div><dt>Parts expenses</dt><dd>{money(totals.parts)}</dd></div>
          <div><dt>Recorded payment fees</dt><dd>{money(totals.fees)}</dd></div>
          <div className="statistics-net"><dt>Net Income<small>Gross billed minus recorded parts and fees</small></dt><dd>{money(totals.net)}</dd></div>
        </dl><p className="statistics-basis">Invoice-based, not cash received. Unrecorded expenses and tax remittances are not deducted.</p>{totals.withoutReceipts || view.expanded ? <>
          <button type="button" className="statistics-warning statistics-warning-button" aria-expanded={view.expanded} aria-controls="statistics-missing-receipts" onClick={() => onViewChange({ month, expanded: !view.expanded })}>
            {missing?.key === missingKey && missing.orders ? missing.orders.length : totals.withoutReceipts} orders have no confirmed parts receipts. {view.expanded ? 'Hide orders' : 'View orders'}
          </button>
          <p className="statistics-basis">Net Income is provisional until all costs are recorded.</p>
          {view.expanded && <div id="statistics-missing-receipts" className="statistics-missing-orders">
            <h3>Orders to check · {monthLabel(month)}</h3>
            <p className="statistics-basis">No active confirmed parts receipt. Some orders may not require parts.</p>
            {missing?.key !== missingKey ? <p role="status">Loading orders...</p> : missing.error ? <p role="alert">{missing.error} <button type="button" onClick={() => setRevision(v => v + 1)}>Retry</button></p> : <>
              {missing.orders?.map(order => <button type="button" className="statistics-missing-order" key={order.id} disabled={!!opening} onClick={() => { setOpening(order.id); void onOpenJob(order.id).finally(() => setOpening('')) }}>
                <strong>ORDER# {orderNumbers.get(order.id) || order.id} · {order.customer}</strong>
                <span>{order.service_date} · {order.appliance} · {order.status.replaceAll('_', ' ')}</span>
                <span>{opening === order.id ? 'Opening...' : 'Open order →'}</span>
              </button>)}
              {!missing.orders?.length && <p>No orders need a receipt check for this month.</p>}
            </>}
          </div>}
        </> : null}</> : null}
      </section>
    </> : null}
  </main>
}
