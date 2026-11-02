import test from "node:test";
import assert from "node:assert/strict";
import { canRefreshPreview, hasRefreshRisk } from "./preview-refresh.ts";

const doc = (nodes = [], dialog = null, activeElement = null) => ({
  activeElement,
  querySelector: () => dialog,
  querySelectorAll: () => nodes,
});
const idle = { hidden: true, sessionOpen: false, pending: false, dirtyFileTabs: false };

test("automatic refresh requires a hidden page with no open session or unsaved work", () => {
  assert.equal(canRefreshPreview(doc(), idle), true);
  assert.equal(canRefreshPreview(doc(), { ...idle, hidden: false }), false);
  assert.equal(canRefreshPreview(doc(), { ...idle, sessionOpen: true }), false);
  assert.equal(canRefreshPreview(doc(), { ...idle, pending: true }), false);
  assert.equal(canRefreshPreview(doc(), { ...idle, dirtyFileTabs: true }), false);
});

test("manual refresh identifies data and interaction risks without blocking an empty focused editor", () => {
  assert.equal(hasRefreshRisk(doc(), idle), false);
  assert.equal(hasRefreshRisk(doc(), { ...idle, pending: true }), true);
  assert.equal(hasRefreshRisk(doc(), { ...idle, dirtyFileTabs: true }), true);
  for (const nodes of [
    [{ tagName: "TEXTAREA", value: "unsent" }],
    [{ tagName: "INPUT", type: "file", files: [{}] }],
    [{ tagName: "INPUT", type: "password" }],
    [{ tagName: "DIV", textContent: "draft" }],
  ]) {
    assert.equal(hasRefreshRisk(doc(nodes), idle), true);
    assert.equal(canRefreshPreview(doc(nodes), idle), false);
  }
  assert.equal(hasRefreshRisk(doc([], {}), idle), true);
  const focused = doc([], null, { matches: () => true });
  assert.equal(hasRefreshRisk(focused, idle), false);
  assert.equal(canRefreshPreview(focused, idle), false);
});
