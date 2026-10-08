import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'
const exports = {}
new Function('exports', ts.transpileModule(readFileSync(new URL('../src/modelDiagramLinks.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText)(exports)
const { searsModelSearchUrl } = exports
test('Kenmore label models preserve all digits and normalize only the dot', () => {
  for (const model of ['111.61205713', '110.62332511', '11020362811', '001.01234500']) {
    assert.equal(new URL(searsModelSearchUrl('Kenmore', model)).searchParams.get('q'), model.replace('.', ''))
  }
})
test('other models preserve full suffixes and punctuation', () => {
  assert.equal(new URL(searsModelSearchUrl('Samsung', ' RF260BEAESG/AA-01 ')).searchParams.get('q'), 'RF260BEAESG/AA-01')
  assert.equal(new URL(searsModelSearchUrl('Maytag', 'MVWB835DW1')).searchParams.get('q'), 'MVWB835DW1')
})
test('invalid or incomplete input never creates a link', () => {
  for (const model of ['', '123', 'a'.repeat(101), '<script>', '1234&query=other']) assert.equal(searsModelSearchUrl('Kenmore', model), null)
})
