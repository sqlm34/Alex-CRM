import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { transform } from 'esbuild'
const { code } = await transform(readFileSync('shared/serviceWindows.ts', 'utf8'), { loader: 'ts', format: 'esm' })
const { parseServiceWindows, toggleServiceWindow, serviceWindowsOverlap, timeMinutes, serviceWindows: slots } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
test('single, consecutive, nonconsecutive and all four slots round trip', () => {
  for (const selection of [[slots[0]], slots.slice(0, 2), [slots[0], slots[3]], slots]) {
    assert.deepEqual(parseServiceWindows(selection.join('; ')), selection)
  }
  assert.deepEqual(parseServiceWindows('invalid'), [])
  assert.deepEqual(parseServiceWindows(`${slots[0]}; invalid`), [])
  assert.deepEqual(parseServiceWindows(''), [])
  assert.equal(toggleServiceWindow(slots[0], slots[3]), `${slots[0]}; ${slots[3]}`)
  assert.equal(toggleServiceWindow(slots.join('; '), slots[1]), [slots[0], slots[2], slots[3]].join('; '))
})
test('availability expands job intervals and transactional public booking checks membership', () => {
  const worker = readFileSync('worker/index.ts', 'utf8')
  assert.match(worker, /flatMap\(\(row\) => parseServiceWindows/)
  assert.match(worker, /parseServiceWindows\(window\).some/)
  assert.match(readFileSync('worker/bookingPersistence.ts', 'utf8'), /split_part\(slot.value,' - ',1\)::time/)
})

test('custom CRM intervals validate AM/PM, minutes, same-day order and overlap', () => {
  assert.equal(timeMinutes('12:00 AM'), 0)
  assert.equal(timeMinutes('12:00 PM'), 720)
  assert.deepEqual(parseServiceWindows('1:17 pm - 2:42 pm'), ['1:17 PM - 2:42 PM'])
  for (const value of ['13:00 PM - 2:00 PM', '0:00 AM - 1:00 AM', '9:60 AM - 11:00 AM', '5:00 PM - 9:00 AM', '9:00 AM - 9:00 AM']) assert.deepEqual(parseServiceWindows(value), [])
  assert.equal(serviceWindowsOverlap('10:30 AM - 11:15 AM', slots[0]), true)
  assert.equal(serviceWindowsOverlap('10:30 AM - 11:15 AM', slots[1]), true)
  assert.equal(serviceWindowsOverlap('11:00 AM - 12:00 PM', slots[0]), false)
  assert.equal(serviceWindowsOverlap('7:00 AM - 8:00 AM', slots[0]), false)
})
