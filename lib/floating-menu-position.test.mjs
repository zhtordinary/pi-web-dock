import assert from "node:assert/strict";
import test from "node:test";
import { clampFloatingMenuPosition } from "./floating-menu-position.ts";

test("keeps a tall context menu inside the viewport", () => {
  assert.deepEqual(
    clampFloatingMenuPosition(
      { x: 300, y: 700 },
      { width: 230, height: 180 },
      { width: 684, height: 720 },
    ),
    { left: 300, top: 532 },
  );
});

test("clamps context menu against left and right edges", () => {
  assert.deepEqual(
    clampFloatingMenuPosition(
      { x: -20, y: 20 },
      { width: 400, height: 100 },
      { width: 500, height: 400 },
    ),
    { left: 8, top: 20 },
  );
  assert.deepEqual(
    clampFloatingMenuPosition(
      { x: 490, y: 390 },
      { width: 400, height: 100 },
      { width: 500, height: 400 },
    ),
    { left: 92, top: 292 },
  );
});
