import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("offers selection quoting toolbar with current chat and sidekick actions", async () => {
  const chatSource = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
  const shellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

  assert.match(chatSource, /export function SelectionToolbarButtons/);
  assert.match(chatSource, /askCurrent/);
  assert.match(chatSource, /askSidekick/);
  assert.match(chatSource, /handleQuoteSelection/);
  assert.match(chatSource, /handleQuoteToSidekick/);
  assert.ok((shellSource.match(/<ChatWindow\b/g) ?? []).length >= 1);
});

test("defers quote-toolbar updates until native pointer selection ends", async () => {
  const chatSource = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
  const selectionEffect = chatSource.match(
    /let activePointerId: number \| null = null;[\s\S]*?\}, \[effectiveQuoteSelection, checkSelection\]\);/,
  )?.[0];

  assert.ok(selectionEffect, "pointer-selection effect not found");
  assert.match(selectionEffect, /if \(activePointerId !== null\) return;\s*scheduleSelectionCheck\(\);/);
  assert.match(selectionEffect, /if \(activePointerId === null\) checkSelection\(\);/);
  assert.match(selectionEffect, /activePointerId = event\.pointerId/);
  assert.match(selectionEffect, /activePointerId !== event\.pointerId/);
  assert.match(selectionEffect, /window\.addEventListener\(\"pointerup\", finishPointerSelection\)/);
  assert.match(selectionEffect, /window\.addEventListener\(\"pointercancel\", finishPointerSelection\)/);
  assert.match(selectionEffect, /document\.addEventListener\(\"selectionchange\", onSelectionChange\)/);
  assert.match(selectionEffect, /document\.addEventListener\(\"keydown\", onKeyDown\)/);
  assert.doesNotMatch(selectionEffect, /preventDefault|removeAllRanges/);
});

test("keeps the selection toolbar floating with appropriate z-index", async () => {
  const chatSource = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
  const toolbar = chatSource.match(/role="toolbar"[\s\S]*?zIndex:\s*(\d+)/);
  assert.ok(toolbar, "expected quote toolbar z-index");
  assert.ok(Number(toolbar[1]) >= 1000, `quote toolbar z-index ${toolbar[1]} should be >= 1000`);
});
