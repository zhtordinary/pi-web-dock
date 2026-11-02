import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("./useViewportHeight.ts", import.meta.url), "utf8");

function mountViewport({ innerHeight = 900, height = 810, scale = 1 } = {}) {
  const frames = new Map();
  const timers = new Map();
  const properties = new Map();
  let id = 0;
  let cleanup;
  class HTMLElement {
    isConnected = true;
    tagName = "TEXTAREA";
  }
  const root = { dataset: {}, scrollTop: 0, style: {
    setProperty: (key, value) => properties.set(key, value),
    removeProperty: (key) => properties.delete(key),
  } };
  const viewport = Object.assign(new EventTarget(), { height, scale });
  const window = Object.assign(new EventTarget(), {
    innerHeight, visualViewport: viewport, scrollX: 0, scrollY: 0,
    requestAnimationFrame: (callback) => { frames.set(++id, callback); return id; },
    cancelAnimationFrame: (id) => frames.delete(id),
    setTimeout: (callback) => { timers.set(++id, callback); return id; },
    clearTimeout: (id) => timers.delete(id),
  });
  const document = Object.assign(new EventTarget(), { documentElement: root, activeElement: null, body: { scrollTop: 0 } });
  const context = { exports: {}, window, document, HTMLElement, useEffect: (effect) => { cleanup = effect(); } };
  vm.runInNewContext(ts.transpileModule(source.replace('import { useEffect } from "react";', ""), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  context.exports.useViewportHeight();
  const flush = () => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback());
  };
  flush();
  return {
    root, viewport, window, properties, timers,
    focus() { document.activeElement = new HTMLElement(); window.dispatchEvent(new Event("focusin")); flush(); },
    blur() { document.activeElement = null; window.dispatchEvent(new Event("focusout")); flush(); },
    resize(height, innerHeight = window.innerHeight, scale = viewport.scale) {
      Object.assign(viewport, { height, scale });
      window.innerHeight = innerHeight;
      viewport.dispatchEvent(new Event("resize"));
      flush();
    },
    unmount() { cleanup(); },
  };
}

test("keyboard dismissal restores controls even when iOS retains focus and layout chrome", () => {
  const h = mountViewport();
  h.focus();
  assert.equal(h.root.dataset.keyboardOpen, undefined, "focusing without a viewport shrink is not a keyboard");
  h.resize(450, 450);
  assert.equal(h.root.dataset.keyboardOpen, "true");
  assert.equal(h.properties.get("--app-viewport-height"), "450px");
  h.resize(810, 900);
  assert.equal(h.root.dataset.keyboardOpen, undefined, "the full visual viewport is restored despite the 90px layout difference");
  assert.equal(h.properties.has("--app-viewport-height"), false);
  h.resize(450, 450);
  assert.equal(h.root.dataset.keyboardOpen, "true", "a second keyboard cycle still works");
  h.blur();
  assert.equal(h.root.dataset.keyboardOpen, undefined);
  h.unmount();
  assert.equal(h.timers.size, 0);
});

test("zoom while typing normalizes the saved full visual viewport", () => {
  const h = mountViewport({ innerHeight: 844, height: 844 });
  h.focus();
  h.resize(510);
  assert.equal(h.root.dataset.keyboardOpen, "true");
  h.resize(350, 844, 1.3);
  assert.equal(h.root.dataset.keyboardOpen, "true");
  h.resize(844 / 1.3, 844, 1.3);
  assert.equal(h.root.dataset.keyboardOpen, undefined);
  h.unmount();
});
