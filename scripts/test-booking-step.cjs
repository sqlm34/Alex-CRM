const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
let value;
const react = {
  useState(initial) {
    value ??= initial;
    return [value, action => { value = typeof action === 'function' ? action(value) : action; }];
  },
};
// Step changes must not depend on browser timers or animation frames.
const context = { exports: {}, require: () => react };
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/useBookingStep.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText, context);
const render = () => context.exports.useBookingStep();
assert.equal(render().step, 0);
for (let step = 1; step <= 3; step++) {
  render().setStep(step);
  assert.equal(render().step, step);
}
render().setStep(previous => previous - 1);
assert.equal(render().step, 2);
render().setStep(0);
assert.equal(render().step, 0);
assert.doesNotMatch(fs.readFileSync('src/App.tsx', 'utf8'), /booking-runner|booking-running-tech|with-runner|inert=\{running\}/);
console.log('PASS: immediate forward/back/reset transitions; no runner UI or animation lock');
