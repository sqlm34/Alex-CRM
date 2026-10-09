import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Clock3, Plus, Trash2 } from 'lucide-react'
import { formatTime, parseServiceWindows, timeMinutes } from '../shared/serviceWindows'
import './ServiceTimePicker.css'

function TimeDialog({ value, onClose, onConfirm }: { value: number; onClose: () => void; onConfirm: (value: number) => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [hour, setHour] = useState(String(Math.floor(value / 60) % 12 || 12))
  const [minute, setMinute] = useState(String(value % 60).padStart(2, '0'))
  const [period, setPeriod] = useState(value >= 720 ? 'PM' : 'AM')
  const [mode, setMode] = useState<'hour' | 'minute'>('hour')
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close() }, [])
  const valid = /^\d{1,2}$/.test(hour) && +hour >= 1 && +hour <= 12 && /^\d{1,2}$/.test(minute) && +minute <= 59
  const angle = (mode === 'hour' ? +hour % 12 * 30 : +minute * 6)
  return createPortal(<dialog ref={dialog} className="crm-time-dialog" aria-label="Select time" data-disable-swipe-back onCancel={e => { e.preventDefault(); onClose() }}>
    <h3>Select time</h3>
    <div className="crm-time-fields">
      <input autoFocus aria-label="Hour" inputMode="numeric" maxLength={2} value={hour} onFocus={() => setMode('hour')} onChange={e => setHour(e.target.value.replace(/\D/g, ''))} />
      <span>:</span>
      <input aria-label="Minute" inputMode="numeric" maxLength={2} value={minute} onFocus={() => setMode('minute')} onChange={e => setMinute(e.target.value.replace(/\D/g, ''))} onBlur={() => { if (minute) setMinute(minute.padStart(2, '0')) }} />
      <div className="crm-time-period" role="group" aria-label="AM or PM">{['AM', 'PM'].map(p => <button type="button" key={p} aria-pressed={period === p} onClick={() => setPeriod(p)}>{p}</button>)}</div>
    </div>
    <div className="crm-time-dial" role="group" aria-label={mode === 'hour' ? 'Choose hour' : 'Choose minute'}>
      <span className="crm-time-hand" style={{ transform: `rotate(${angle}deg)` }} />
      {Array.from({ length: 12 }, (_, index) => {
        const number = mode === 'hour' ? index || 12 : index * 5
        const label = mode === 'hour' ? String(number) : String(number).padStart(2, '0')
        return <button type="button" key={index} aria-label={`${mode} ${label}`} aria-pressed={number === (mode === 'hour' ? +hour : +minute)} style={{ left: `${50 + 39 * Math.sin(index * Math.PI / 6)}%`, top: `${50 - 39 * Math.cos(index * Math.PI / 6)}%` }} onClick={() => {
          if (mode === 'hour') { setHour(label); setMode('minute') } else setMinute(label)
        }}>{label}</button>
      })}
    </div>
    <div className="crm-time-actions"><button type="button" data-time-cancel onClick={onClose}>Cancel</button><button type="button" disabled={!valid} onClick={() => onConfirm((+hour % 12 + (period === 'PM' ? 12 : 0)) * 60 + +minute)}>OK</button></div>
  </dialog>, document.body)
}

export function ServiceTimePicker({ value, onChange, disabled = false }: { value: string; onChange: (value: string) => void; disabled?: boolean }) {
  const selected = parseServiceWindows(value)
  const [editing, setEditing] = useState<{ index: number; side: number; value: number } | null>(null)
  const [error, setError] = useState('')
  return <fieldset className="crm-service-times" disabled={disabled}>
    <legend>Time</legend>
    {selected.map((interval, index) => <div className="crm-time-range" key={index}>
      {interval.split(' - ').map((time, side) => <label key={side}>{side === 0 ? 'Start' : 'End'}<button type="button" aria-label={`${side === 0 ? 'Start' : 'End'} time ${index + 1}: ${time}`} onClick={() => { setError(''); setEditing({ index, side, value: timeMinutes(time)! }) }}><Clock3 size={17} />{time}</button></label>)}
      <button type="button" className="crm-time-remove" aria-label={`Remove time ${index + 1}`} title="Remove time" onClick={() => { onChange(selected.filter((_, i) => i !== index).join('; ')); setError('') }}><Trash2 size={18} /></button>
    </div>)}
    <button type="button" className="crm-time-add" disabled={selected.length >= 8} onClick={() => { setError(''); setEditing({ index: selected.length, side: 0, value: 540 }) }}><Plus size={18} />Add time</button>
    {error ? <p role="alert">{error}</p> : null}
    {editing ? <TimeDialog value={editing.value} onClose={() => setEditing(null)} onConfirm={minutes => {
      const next = [...selected]
      const pair = next[editing.index]?.split(' - ') || [formatTime(minutes), formatTime(Math.min(minutes + 60, 1439))]
      pair[editing.side] = formatTime(minutes)
      if (timeMinutes(pair[1])! <= timeMinutes(pair[0])!) { setError('End time must be later than start time on the same day.'); setEditing(null); return }
      next[editing.index] = pair.join(' - ')
      onChange(parseServiceWindows(next.join('; ')).join('; ')); setError(''); setEditing(null)
    }} /> : null}
  </fieldset>
}
