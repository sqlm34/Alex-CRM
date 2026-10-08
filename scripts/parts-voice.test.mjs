import { test } from 'node:test'
import assert from 'node:assert/strict'
import { partsVoiceText } from '../src/partsVoiceText.ts'

test('spoken model digits are deterministic, letters remain unchanged', () => {
  assert.equal(partsVoiceText(' WTW 5057 LW zero ', 'model'), 'WTW5057LW0')
  assert.equal(partsVoiceText('WTW 5057 LW O', 'model'), 'WTW5057LWO')
  assert.equal(partsVoiceText('I L one', 'model'), 'IL1')
  assert.equal(partsVoiceText('110. 62332511', 'model'), '110.62332511')
  assert.equal(partsVoiceText('RF260BEAESG / AA-01', 'model'), 'RF260BEAESG/AA-01')
})
test('part numbers support explicit digits, not guessed phrases', () => {
  assert.equal(partsVoiceText('W one one three nine nine four three seven', 'part_number'), 'W11399437')
  assert.equal(partsVoiceText('4681 EA 2001 T', 'part_number'), '4681EA2001T')
  assert.equal(partsVoiceText('maybe double u oh', 'part_number'), 'MAYBE DOUBLE U OH')
  assert.equal(partsVoiceText('W один два ноль', 'part_number'), 'W120')
})
test('names retain Russian and English without identifier normalization', () => {
  assert.equal(partsVoiceText(' сливная помпа ', 'name'), 'сливная помпа')
  assert.equal(partsVoiceText(' drain pump ', 'name'), 'drain pump')
  assert.equal(partsVoiceText('one way valve', 'name'), 'one way valve')
})
