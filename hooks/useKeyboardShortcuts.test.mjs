import assert from "node:assert/strict";
import test from "node:test";
import { handleGlobalEscape, isNewSessionShortcut, registerAbortHandler } from "./useKeyboardShortcuts.ts";

function keydown(key, { tagName = "BUTTON", defaultPrevented = false } = {}) {
  return {
    key,
    target: { tagName },
    defaultPrevented,
    preventDefault() { this.defaultPrevented = true; },
  };
}

test("Escape stops a running agent when nothing else took the key", (t) => {
  let stopped = 0;
  registerAbortHandler(() => { stopped += 1; });
  t.after(() => registerAbortHandler(null));

  const event = keydown("Escape");
  assert.equal(handleGlobalEscape(event), true);
  assert.equal(stopped, 1);
  assert.equal(event.defaultPrevented, true);
  // Focus on the page itself, as after a click on nothing in particular.
  assert.equal(handleGlobalEscape(keydown("Escape", { tagName: "BODY" })), true);
  assert.equal(stopped, 2);
  assert.equal(handleGlobalEscape(keydown("Enter")), false);
  assert.equal(stopped, 2);
});

test("an Escape something nearer already handled does not stop the agent too", (t) => {
  let stopped = 0;
  registerAbortHandler(() => { stopped += 1; });
  t.after(() => registerAbortHandler(null));

  // Settings, the Mermaid viewer or a menu closed on it and marked it handled.
  assert.equal(handleGlobalEscape(keydown("Escape", { defaultPrevented: true })), false);
  // ChatInput and other fields keep their own Escape.
  assert.equal(handleGlobalEscape(keydown("Escape", { tagName: "TEXTAREA" })), false);
  assert.equal(handleGlobalEscape(keydown("Escape", { tagName: "INPUT" })), false);
  assert.equal(stopped, 0);
});

test("with no run to stop, Escape is left alone", () => {
  registerAbortHandler(null);
  const event = keydown("Escape");
  assert.equal(handleGlobalEscape(event), false);
  assert.equal(event.defaultPrevented, false);
});


test("new session shortcut handles macOS dead keys without swallowing IME or AltGr", () => {
  const key = { key: "n", code: "KeyN", ctrlKey: true, altKey: true };
  assert.equal(isNewSessionShortcut(key), true);
  assert.equal(isNewSessionShortcut({ ...key, key: "N", code: "KeyL" }), true);
  assert.equal(isNewSessionShortcut({ ...key, key: "Dead" }), true);
  for (const change of [{ key: "Dead", code: "KeyM" }, { key: "ń" }, { key: "}" }, { isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }, { ctrlKey: false }, { altKey: false }]) {
    assert.equal(isNewSessionShortcut({ ...key, ...change }), false);
  }
});

test("an IME cancellation Escape does not stop the running agent", () => {
  let aborted = 0;
  registerAbortHandler(() => { aborted += 1; });
  for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
    const event = { key: "Escape", defaultPrevented: false, target: null, preventDefault() {}, ...composition };
    assert.equal(handleGlobalEscape(event), false);
  }
  assert.equal(aborted, 0);
  registerAbortHandler(null);
});
