import assert from "node:assert/strict";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
import { localizeQuickAskError } from "../lib/quick-ask-observer.ts";
import { isQuickAskRunActive } from "../lib/quick-ask-status.ts";

/** Load production state transitions and callbacks, without mounting React or substituting their decisions. */
export function loadSidekickHelpers(source, context) {
  context.localizeQuickAskError = localizeQuickAskError;
  context.isQuickAskRunActive = isQuickAskRunActive;
  const pure = source.indexOf("export function restoreSidekickDraft(");
  if (pure >= 0) {
    const end = source.indexOf("\nconst sidekickActionButtonStyle", pure);
    assert.ok(end > pure);
    context.restoreSidekickDraft = vm.runInNewContext(stripTypeScriptTypes(
      source.slice(pure, end).replace("export function", "function") + "\nrestoreSidekickDraft"), context);
  }
  const local = source.indexOf("  const restoreDraft =");
  if (local >= 0) {
    const end = source.indexOf("  observeRunRef.current =", local);
    assert.ok(end > local);
    Object.assign(context, vm.runInNewContext(stripTypeScriptTypes(source.slice(local, end))
      + "\n({ restoreDraft, forgetDeletedRun, recoverRun })", context));
  }
}

/** Flush the real committed-reply cleanup after the harness's queued state updates. */
export function runSidekickReplyLayout(source, context) {
  const start = source.indexOf("  useLayoutEffect(() => {\n    for (const [key, request] of streamRequestsRef.current)");
  if (start < 0) return;
  const ending = "  }, [replies]);";
  const end = source.indexOf(ending, start);
  assert.ok(end > start);
  vm.runInNewContext(stripTypeScriptTypes(source.slice(start, end + ending.length)), {
    ...context, useLayoutEffect: (callback) => callback(),
  });
}
