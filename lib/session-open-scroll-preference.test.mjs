import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SESSION_OPEN_SCROLL,
  isSessionOpenScroll,
  loadSessionOpenScroll,
  normalizeSessionOpenScroll,
  resolveSessionOpenScrollLanding,
  SESSION_OPEN_SCROLL_CHANGED_EVENT,
  SESSION_OPEN_SCROLL_STORAGE_KEY,
  setSessionOpenScroll,
} from "./session-open-scroll-preference.ts";

function installWindow() {
  const store = new Map();
  const listeners = new Set();
  globalThis.window = {
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
    },
    addEventListener: (_type, handler) => listeners.add(handler),
    removeEventListener: (_type, handler) => listeners.delete(handler),
    dispatchEvent: (event) => {
      for (const handler of listeners) handler(event);
      return true;
    },
  };
  return store;
}

test("defaults to starting at the last question", () => {
  installWindow();
  assert.equal(DEFAULT_SESSION_OPEN_SCROLL, "last-question");
  assert.equal(loadSessionOpenScroll(), "last-question");
});

test("normalizes unknown or corrupted values to the default", () => {
  const store = installWindow();
  assert.equal(normalizeSessionOpenScroll("answer-bottom"), "answer-bottom");
  assert.equal(normalizeSessionOpenScroll("bogus"), "last-question");
  assert.equal(isSessionOpenScroll("answer-bottom"), true);
  assert.equal(isSessionOpenScroll("bogus"), false);

  store.set(SESSION_OPEN_SCROLL_STORAGE_KEY, "bogus");
  assert.equal(loadSessionOpenScroll(), "last-question");
});

test("resolves every opened-session landing as detached from live follow", () => {
  assert.deepEqual(resolveSessionOpenScrollLanding("last-question", true), {
    target: "last-question",
    follow: false,
  });
  assert.deepEqual(resolveSessionOpenScrollLanding("last-question", false), {
    target: "answer-bottom",
    follow: false,
  });
  assert.deepEqual(resolveSessionOpenScrollLanding("answer-bottom", false), {
    target: "answer-bottom",
    follow: false,
  });
});

test("persists the preference and notifies listeners on change", () => {
  installWindow();
  let notified = 0;
  globalThis.window.addEventListener(SESSION_OPEN_SCROLL_CHANGED_EVENT, () => notified++);

  setSessionOpenScroll("answer-bottom");
  assert.equal(loadSessionOpenScroll(), "answer-bottom");
  assert.equal(notified, 1);

  setSessionOpenScroll("last-question");
  assert.equal(loadSessionOpenScroll(), "last-question");
  assert.equal(notified, 2);
});

test("falls back to the default when window is unavailable (SSR)", () => {
  const original = globalThis.window;
  delete globalThis.window;
  try {
    assert.equal(loadSessionOpenScroll(), "last-question");
  } finally {
    if (original !== undefined) globalThis.window = original;
  }
});

test("setter is safe when window is unavailable (SSR)", () => {
  const original = globalThis.window;
  delete globalThis.window;
  try {
    assert.doesNotThrow(() => setSessionOpenScroll("answer-bottom"));
  } finally {
    if (original !== undefined) globalThis.window = original;
  }
});

test("dispatches the change event even when storage is unavailable", () => {
  let notified = 0;
  const original = globalThis.window;
  globalThis.window = {
    localStorage: {
      setItem: () => { throw new Error("quota"); },
    },
    dispatchEvent: () => {
      notified += 1;
      return true;
    },
  };
  try {
    assert.doesNotThrow(() => setSessionOpenScroll("answer-bottom"));
    assert.equal(notified, 1);
  } finally {
    if (original === undefined) delete globalThis.window;
    else globalThis.window = original;
  }
});
