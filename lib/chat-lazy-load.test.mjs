import assert from "node:assert/strict";
import test from "node:test";
import * as subject from "./chat-lazy-load.ts";

test("keeps the scroll head tolerance stable for adjacent history pages", () => {
  assert.equal(subject.isScrollAtHead(0), true);
  assert.equal(subject.isScrollAtHead(7), true);
  assert.equal(subject.isScrollAtHead(9), false);
});

test("preserves live-follow attachment only at the actual tail", () => {
  assert.equal(subject.getLiveFollowAttached(false, 0, 100, 100, 500), false);
  assert.equal(subject.getLiveFollowAttached(false, 0, 100, 100, 200), true);
  assert.equal(subject.getLiveFollowAttached(false, 0, 100, 100, 196, 96), true);
  assert.equal(subject.getLiveFollowAttached(true, 100, 50, 100, 200), false);
  assert.equal(subject.shouldShowScrollToLatest(0, 100, 200), true);
});
