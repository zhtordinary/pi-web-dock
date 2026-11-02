import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";
const source = await readFile(new URL("./useContinueController.ts", import.meta.url), "utf8");
const logic = await createJiti(import.meta.url).import("../lib/continue-logic.ts");
function fixture(messages, stored = "1") {
  const slots = [], intervals = new Map(); let cursor = 0, effects = [], dirty = false, current, timer = 0;
  const react = {
    useRef(value) { const i = cursor++; return slots[i] ??= { current: value }; },
    useState(value) { const i = cursor++; if (!(i in slots)) slots[i] = typeof value === "function" ? value() : value;
      return [slots[i], next => { slots[i] = typeof next === "function" ? next(slots[i]) : next; dirty = true; }]; },
    useCallback(fn) { return fn; },
    useEffect(fn, deps) { const i = cursor++, old = slots[i]; if (!old || deps.some((v, n) => !Object.is(v, old.deps[n]))) {
      slots[i] = { deps, cleanup: old?.cleanup }; effects.push(() => { slots[i].cleanup?.(); slots[i].cleanup = fn(); });
    } },
  };
  // Stable callback identities preserve React's effect dependency behavior.
  react.useCallback = (fn, deps) => { const i = cursor++, old = slots[i]; if (!old || deps.some((v,n)=>!Object.is(v,old.deps[n]))) slots[i]={fn,deps}; return slots[i].fn; };
  const mod = { exports: {} };
  new Function("require", "module", "exports", "setInterval", "clearInterval", "localStorage", ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(
    name => name === "react" ? react : logic, mod, mod.exports,
    fn => { const id=++timer; intervals.set(id,fn); return id; }, id => intervals.delete(id), {getItem:()=>stored,setItem(){}});
  let options = { scopeKey: "a", messages, agentRunning: false, isCompacting: false, onSendContinue(){}, onRetryContinue(){}, onCompact(){} };
  const flush = () => { let attempts = 0; do { assert.ok(++attempts < 12, "effects must settle"); dirty=false; cursor=0; effects=[]; current=mod.exports.useContinueController(options); for(const effect of effects) effect(); } while(dirty); return current; };
  return { flush, change: patch => { options={...options,...patch}; return flush(); }, intervals,
    dispose: () => slots.forEach(slot => slot?.cleanup?.()) };
}
const scheduler = { active: true, reason: "error", attempt: 3, nextRetryAt: Date.now()+60000, nextDelayMs: 60000, errorMessage: "503", key: "turn" };
test("fresh drafts default on independently of another session's browser flag", () => {
  const f = fixture([], "0");
  try {
    assert.equal(f.flush().unattended, true);
    f.flush().syncUnattendedEnabled(false);
    assert.equal(f.flush().unattended, false, "an explicit server preference still wins");
  } finally { f.dispose(); }
});
test("fresh server retry snapshot wins over an old completed transcript", () => {
  const f=fixture([{role:"assistant",stopReason:"stop",content:[{type:"text",text:"old answer"}]}]);
  try { f.flush().syncUnattendedState(scheduler); assert.equal(f.flush().continueUi.kind,"running"); assert.equal(f.intervals.size,1); }
  finally {f.dispose();}
});
test("stripped manual user tail cannot erase an actual server countdown", () => {
  const f=fixture([{role:"user",content:"original question",timestamp:1}]);
  try { f.flush().syncUnattendedState(scheduler); assert.equal(f.flush().continueUi.kind,"running"); f.flush().syncUnattendedState(null); assert.equal(f.flush().continueUi.kind,"idle"); assert.equal(f.intervals.size,0); }
  finally {f.dispose();}
});
test("a historical error alone cannot invent an unattended countdown", () => {
  const f=fixture([{role:"assistant",stopReason:"error",errorMessage:"503",content:[]}]);
  try { assert.notEqual(f.flush().continueUi.kind,"running"); assert.equal(f.intervals.size,0); }
  finally {f.dispose();}
});
test("opening a historical context overflow cannot start compaction before explicit recovery", () => {
  const f=fixture([{role:"assistant",stopReason:"error",errorMessage:"maximum context length exceeded",content:[]}]);
  let compact=0, submitted=0;
  try {
    f.change({onCompact(){compact++;},onRetryContinue(){submitted++;},onSendContinue(){submitted++;}});
    assert.equal(compact,0); assert.equal(submitted,0); assert.equal(f.intervals.size,0);
    f.flush().triggerContinue(); assert.equal(submitted,1);
  } finally {f.dispose();}
});
