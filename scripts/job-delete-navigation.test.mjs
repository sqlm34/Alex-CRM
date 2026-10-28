import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'
const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function initializer(name) {
  let found
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name) found = node.initializer.getText(ast)
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.ok(found)
  return found
}
for (const [page, origin, expected] of [['schedule','schedule','schedule'], ['dashboard','schedule','dashboard'], ['job','schedule','schedule'], ['job','dashboard','dashboard']]) {
  test(`delete from ${page}, origin ${origin} returns to ${expected}`, async () => {
    const pages = [], scroll = { current: false }
    const args = { jobs: [{ id:'test',customer:'Test' }], orderNumbers:new Map([['test','53']]), formatOrderNumber:()=> '53', window:{ confirm:()=>true }, pageRef:{current:page}, jobReturnPageRef:{current:origin}, restoreJobsScrollRef:scroll, setJobs:()=>{},setActiveId:()=>{},setPage:value=>pages.push(value),deleteJob:async()=>{},authToken:'test',activeOrderNumber:'53',showToast:()=>{},errorMessage:String }
    const code = ts.transpileModule(`const run=${initializer('deleteOrder')};`, {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText
    new Function(...Object.keys(args),code+'return run;')(...Object.values(args))('test')
    await new Promise(resolve=>queueMicrotask(resolve))
    assert.deepEqual(pages,[expected]); assert.equal(scroll.current,expected==='dashboard')
    args.window.confirm=()=>false; pages.length=0
    new Function(...Object.keys(args),code+'return run;')(...Object.values(args))('test')
    assert.deepEqual(pages,[])
  })
}
test('canceling a job status does not force navigation to Jobs',()=>{
  assert.doesNotMatch(initializer('updateStatus'), /setPage\(/)
})
test('native back consumes receptionist details before navigating away', () => {
  let clicks=0
  const code=ts.transpileModule(`const run=${initializer('handleAppBack')};`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText
  const cooldown={current:0}
  const run=new Function('useCallback','document','pageRef','callDetailBackUntilRef',code+'return run;')(fn=>fn,{querySelector:selector=>{
    assert.match(selector,/data-receptionist-detail-back/)
    return {click:()=>clicks++}
  }},{current:'receptionist'},cooldown)
  assert.equal(run(),true); assert.equal(clicks,1)
  // A second Android callback after the dialog disappeared must not navigate.
  assert.equal(run(),true); assert.equal(clicks,1)
})
