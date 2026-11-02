import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPOSITION_END_ENTER_GRACE_MS,
  getExtensionDialogInputCompositionEndAtOnBlur,
  handleExtensionDialogEscape,
  handleExtensionDialogInputKeyDown,
  isForeignNativeModalOwner,
} from "./extension-dialog-keyboard.ts";

function makeEscapeEvent(overrides = {}) {
  let prevented = 0;
  let stopped = 0;
  return {
    event: {
      key: "Escape",
      defaultPrevented: false,
      isComposing: false,
      keyCode: 27,
      preventDefault: () => { prevented += 1; },
      stopPropagation: () => { stopped += 1; },
      ...overrides,
    },
    counts: () => ({ prevented, stopped }),
  };
}

function targetWithModal(owner) {
  return { closest: () => owner };
}

function makeInputEvent(overrides = {}) {
  let prevented = 0;
  return {
    event: {
      key: "Enter",
      isComposing: false,
      keyCode: 13,
      preventDefault: () => { prevented += 1; },
      ...overrides,
    },
    counts: () => ({ prevented }),
  };
}

test("IME confirmation Enter commits text without submitting the extension input", () => {
  const now = 1_000;
  const composingCases = [
    { event: { isComposing: true }, active: false, endedAt: 0, prevented: 0 },
    { event: { keyCode: 229 }, active: false, endedAt: 0, prevented: 0 },
    { event: {}, active: true, endedAt: 0, prevented: 0 },
    { event: {}, active: false, endedAt: now - COMPOSITION_END_ENTER_GRACE_MS + 1, prevented: 1 },
  ];
  for (const { event: overrides, active, endedAt, prevented } of composingCases) {
    const { event, counts } = makeInputEvent(overrides);
    let submitted = 0;
    assert.equal(handleExtensionDialogInputKeyDown(event, active, endedAt, () => { submitted += 1; }, now), true);
    assert.equal(submitted, 0);
    assert.deepEqual(counts(), { prevented });
  }

  const normal = makeInputEvent();
  let submitted = 0;
  assert.equal(handleExtensionDialogInputKeyDown(normal.event, false, 0, () => { submitted += 1; }, now), true);
  assert.equal(submitted, 1);
  assert.deepEqual(normal.counts(), { prevented: 1 });

  const other = makeInputEvent({ key: "ArrowLeft" });
  assert.equal(handleExtensionDialogInputKeyDown(other.event, false, 0, () => { submitted += 1; }, now), false);
  assert.equal(submitted, 1);
  assert.deepEqual(other.counts(), { prevented: 0 });
});

test("blur keeps a pending IME confirmation inside the submit guard", () => {
  assert.equal(getExtensionDialogInputCompositionEndAtOnBlur(true, 0, 1_000), 1_000);
  assert.equal(getExtensionDialogInputCompositionEndAtOnBlur(false, 950, 1_000), 950);
  assert.equal(getExtensionDialogInputCompositionEndAtOnBlur(false, 0, 1_000), 0);
});

test("cancels confirm/select/input/editor from external focus through the production handler", () => {
  for (const method of ["confirm", "select", "input", "editor"]) {
    const { event, counts } = makeEscapeEvent();
    const cancelled = [];
    const handled = handleExtensionDialogEscape(event, () => cancelled.push(method));
    assert.equal(handled, true, method);
    assert.deepEqual(cancelled, [method]);
    assert.deepEqual(counts(), { prevented: 1, stopped: 1 });
  }
});

test("does not steal composition, already-prevented, or foreign-modal Escape", () => {
  for (const overrides of [
    { isComposing: true },
    { keyCode: 229 },
    { defaultPrevented: true },
  ]) {
    const { event, counts } = makeEscapeEvent(overrides);
    let cancelled = 0;
    assert.equal(handleExtensionDialogEscape(event, () => { cancelled += 1; }), false);
    assert.equal(cancelled, 0);
    assert.deepEqual(counts(), { prevented: 0, stopped: 0 });
  }

  const foreignModal = {};
  const { event, counts } = makeEscapeEvent();
  let cancelled = 0;
  assert.equal(
    handleExtensionDialogEscape(event, () => { cancelled += 1; }, { nativeModalOwned: true }),
    false,
  );
  assert.equal(cancelled, 0);
  assert.deepEqual(counts(), { prevented: 0, stopped: 0 });
  assert.equal(
    isForeignNativeModalOwner(targetWithModal(foreignModal), null, { contains: () => false }),
    true,
  );
});

test("recognizes the extension dialog as the owning native modal", () => {
  const surface = {};
  assert.equal(
    isForeignNativeModalOwner(targetWithModal(surface), null, { ...surface, contains: () => true }),
    false,
  );
  assert.equal(isForeignNativeModalOwner({ closest: () => null }, null, null), false);
});
