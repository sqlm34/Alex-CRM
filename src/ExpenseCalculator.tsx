import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Delete, Divide, Equal, Minus, Percent, Plus, Diff, X } from 'lucide-react'
import Decimal from 'decimal.js'
import './ExpenseCalculator.css'

type Operator = '+' | '-' | '*' | '/'
const operate = (left: string, right: string, op: Operator) => {
  const a = new Decimal(left), b = new Decimal(right)
  if (op === '/' && b.isZero()) throw new Error('Cannot divide by zero')
  return (op === '+' ? a.plus(b) : op === '-' ? a.minus(b) : op === '*' ? a.times(b) : a.div(b)).toString()
}

export function ExpenseCalculator({ value, maximum, onApply, onClose }: {
  value: number | null; maximum: number | null; onApply: (cents: number) => void; onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [display, setDisplay] = useState(new Decimal(value ?? 0).div(100).toString())
  const [left, setLeft] = useState<string | null>(null)
  const [operator, setOperator] = useState<Operator | null>(null)
  const [replace, setReplace] = useState(true)
  const [error, setError] = useState('')
  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => element?.close()
  }, [])

  function press(key: string) {
    setError('')
    try {
      if (/^[0-9.]$/.test(key)) {
        const next = replace ? (key === '.' ? '0.' : key) : key === '.' && display.includes('.') ? display : display === '0' && key !== '.' ? key : display + key
        if (next.length <= 16) setDisplay(next)
        setReplace(false)
      } else if (key === 'AC') {
        setDisplay('0'); setLeft(null); setOperator(null); setReplace(true)
      } else if (key === 'Backspace') {
        setDisplay(replace ? '0' : display.length > 1 ? display.slice(0, -1).replace(/^-$/, '0') : '0'); setReplace(false)
      } else if (key === 'sign') {
        setDisplay(new Decimal(display).negated().toString())
      } else if (key === '%') {
        const fraction = new Decimal(display).div(100)
        setDisplay(left !== null && (operator === '+' || operator === '-') ? new Decimal(left).times(fraction).toString() : fraction.toString())
      } else if (['+', '-', '*', '/'].includes(key)) {
        const result = left !== null && operator && !replace ? operate(left, display, operator) : display
        setDisplay(result); setLeft(result); setOperator(key as Operator); setReplace(true)
      } else if (key === '=') {
        if (operator && replace) throw new Error('Enter the second amount')
        const result = new Decimal(left !== null && operator ? operate(left, display, operator) : display)
        const cents = result.times(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
        if (!cents.isFinite() || cents.lte(0) || cents.gt(maximum ?? 100000000)) throw new Error('Result must be positive and no greater than the purchase total')
        onApply(cents.toNumber())
      }
    } catch (e) { setError(e instanceof Error ? e.message : 'Invalid calculation') }
  }
  const keys = [
    ['AC', 'Clear', 'AC'], ['sign', 'Change sign', <Diff />], ['%', 'Percent', <Percent />], ['/', 'Divide', <Divide />],
    ['7', '7', '7'], ['8', '8', '8'], ['9', '9', '9'], ['*', 'Multiply', <X />],
    ['4', '4', '4'], ['5', '5', '5'], ['6', '6', '6'], ['-', 'Subtract', <Minus />],
    ['1', '1', '1'], ['2', '2', '2'], ['3', '3', '3'], ['+', 'Add', <Plus />],
    ['Backspace', 'Delete digit', <Delete />], ['0', '0', '0'], ['.', 'Decimal point', '.'], ['=', 'Equals', <Equal />],
  ] as const
  return createPortal(<dialog ref={dialog} className="expense-calculator" aria-label="Expense calculator" data-disable-swipe-back onCancel={e => { e.preventDefault(); onClose() }} onKeyDown={e => {
    if (/^[0-9.+*/%=-]$/.test(e.key) || e.key === 'Backspace' || e.key === 'Enter' || e.key === ',') {
      e.preventDefault(); press(e.key === 'Enter' ? '=' : e.key === ',' ? '.' : e.key)
    }
  }}>
    <header><span>Expense calculator</span><button type="button" data-expense-calculator-close aria-label="Close calculator" onClick={onClose}><X size={22} /></button></header>
    <div className="expense-calculator-expression">{left !== null ? `${left} ${operator === '*' ? '\u00d7' : operator === '/' ? '\u00f7' : operator}` : '\u00a0'}</div>
    <output aria-label="Calculator display" className={display.length > 10 ? 'small' : ''}>{display}</output>
    <div className="expense-calculator-error" role="status">{error}</div>
    <div className="expense-calculator-keys">{keys.map(([key, label, content]) => <button key={key} type="button" aria-label={label} className={`${['+', '-', '*', '/', '='].includes(key) ? 'operation' : ['AC', 'sign', '%'].includes(key) ? 'utility' : ''}${operator === key ? ' selected' : ''}`} onClick={() => press(key)}>{content}</button>)}</div>
  </dialog>, document.body)
}
