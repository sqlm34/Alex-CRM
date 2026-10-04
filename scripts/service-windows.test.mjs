import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { transform } from 'esbuild'
const { code } = await transform(readFileSync('shared/serviceWindows.ts', 'utf8'), { loader: 'ts', format: 'esm' })
const { parseServiceWindows, toggleServiceWindow, serviceWindows: slots } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
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
  assert.match(readFileSync('worker/bookingPersistence.ts', 'utf8'), /any\(string_to_array\(service_window, '; '\)\)/)
})
