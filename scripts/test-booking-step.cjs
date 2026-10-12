const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const values = []; let cursor = 0, frame, cleanup, reduced = false;
const react = {
  useState(initial) { const i = cursor++; if (!(i in values)) values[i] = initial; return [values[i], v => { values[i] = v; }]; },
  useRef(initial) { const i = cursor++; return values[i] ??= { current: initial }; },
  useEffect(fn) { cleanup = fn(); },
};
const context = { exports: {}, require: () => react, window: { matchMedia: () => ({matches:reduced}) }, document: { querySelector: () => null }, requestAnimationFrame: fn => {frame=fn;return 1;}, cancelAnimationFrame: () => {frame=null;} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/useBookingStep.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,context);
const render = () => {cursor=0;return context.exports.useBookingStep();};
for (let step=0;step<3;step++) {
  let hook=render(); assert.equal(hook.step,step); hook.setStep(step+1);
  hook=render();assert.equal(hook.running,true);hook.setStep(0);
  frame(0);frame(900);assert.equal(render().progress,step+.5);
  frame(1800);hook=render();assert.equal(hook.step,step+1);assert.equal(hook.running,false);
}
render().setStep(1);assert.equal(render().step,1);assert.equal(render().progress,1);
reduced=true;render().setStep(2);assert.equal(render().step,2);assert.equal(render().running,false);
reduced=false;render().setStep(3);cleanup();assert.equal(frame,null);
console.log('PASS: all three forward transitions, double-click guard, backward navigation, reduced motion, unmount cleanup');
