import assert from "node:assert/strict";
import test from "node:test";
import { resolveSafeHistorySource } from "./reader-safe-history-source.ts";

test("live safe history chooses the manager-owned path when the wrapper field is empty", () => {
  assert.deepEqual(resolveSafeHistorySource({
    runtimeAlive: true,
    liveSessionFile: "",
    managerSessionFile: "/tmp/live-session.jsonl",
    persistedSessionFile: "/tmp/indexed-session.jsonl",
  }), {
    runtimeStatus: "live",
    coverageSource: "live-memory",
    sessionFilePath: "/tmp/live-session.jsonl",
  });
});

test("persisted safe history exposes its indexed JSONL path and durable labels", () => {
  assert.deepEqual(resolveSafeHistorySource({
    runtimeAlive: false,
    persistedSessionFile: "/tmp/stopped-session.jsonl",
  }), {
    runtimeStatus: "not_live",
    coverageSource: "persisted-jsonl",
    sessionFilePath: "/tmp/stopped-session.jsonl",
  });
});

test("live memory remains readable when no physical path is available", () => {
  assert.deepEqual(resolveSafeHistorySource({ runtimeAlive: true }), {
    runtimeStatus: "live",
    coverageSource: "live-memory",
    sessionFilePath: null,
  });
});

test("a non-live read without a path is unavailable, never a null-path snapshot", () => {
  assert.equal(resolveSafeHistorySource({ runtimeAlive: false, persistedSessionFile: null }), null);
});
