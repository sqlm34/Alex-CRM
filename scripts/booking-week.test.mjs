import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'

const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const names = ['createBookingWeek', 'addDaysToBookingDate', 'bookingDateToBusinessDate', 'normalizeBookingDateValue']
const functions = names.map(name => {
  const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)
  assert.ok(fn, `Missing ${name}`)
  return fn.getText(ast)
}).join('\n')
const compiled = ts.transpileModule(functions, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
const weekFor = (today, offset = 0) => new Function('formatLocalDate', `${compiled}; return createBookingWeek`)(() => today)(offset)

test('Sunday opens next Monday through Sunday, with Sunday still unavailable', () => {
  const week = weekFor('2026-10-11')
  assert.deepEqual(week.map(day => day.value), ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18'])
  assert.deepEqual(week.map(day => day.disabled), [false, false, false, false, false, false, true])
  assert.equal(week[0].weekday, 'Mon')
  assert.equal(week[6].weekday, 'Sun')
})

test('Monday through Saturday retain the current week and disable past dates', () => {
  for (let day = 5; day <= 10; day++) {
    const today = `2026-10-${String(day).padStart(2, '0')}`
    const week = weekFor(today)
    assert.equal(week[0].value, '2026-10-05')
    assert.equal(week[6].value, '2026-10-11')
    assert.deepEqual(week.map(item => item.disabled), week.map(item => item.value < today || item.weekday === 'Sun'))
  }
})

test('week navigation and reset use the same Sunday base week', () => {
  assert.equal(weekFor('2026-10-11', 1)[0].value, '2026-10-19')
  assert.equal(weekFor('2026-10-11', 2)[0].value, '2026-10-26')
  assert.equal(weekFor('2026-10-11', 0)[0].value, '2026-10-12')
})

test('Sunday advances correctly across month and year boundaries', () => {
  assert.equal(weekFor('2026-05-31')[0].value, '2026-06-01')
  assert.equal(weekFor('2023-12-31')[0].value, '2024-01-01')
})
