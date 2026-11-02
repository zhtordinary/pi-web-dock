import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});
const { getRpcSessionInfos } = await jiti.import("./rpc-manager.ts");

function makeRuntimeSession({ id, filePath, running, entries, contextSourceSessionId, headerCwd = "/tmp/runtime-cwd" }) {
  const timestamp = "2026-08-12T01:02:03.000Z";
  const manager = {
    getHeader: () => ({ type: "session", id, cwd: headerCwd, timestamp, ...(contextSourceSessionId ? { contextSourceSessionId } : {}) }),
    getEntries: () => entries,
    getSessionFile: () => filePath,
    getSessionName: () => undefined,
  };
  return {
    isAlive: () => true,
    isRunning: () => running,
    inner: { sessionManager: manager },
    get sessionId() { return id; },
    get sessionFile() { return filePath; },
    get cwd() { return "/tmp/runtime-cwd"; },
  };
}

test("lists live draft runtimes before their session file exists", (t) => {
  const previousRegistry = globalThis.__piSessions;
  const timestamp = "2026-08-12T01:02:04.000Z";
  const visible = makeRuntimeSession({
    id: "visible-runtime",
    filePath: join(tmpdir(), "pi-web-missing-runtime-session.jsonl"),
    running: true,
    contextSourceSessionId: "source-session",
    entries: [{
      type: "message",
      id: "u1",
      parentId: null,
      timestamp,
      message: {
        role: "user",
        content: [{ type: "text", text: "first" }, { type: "text", text: "prompt" }],
      },
    }],
  });
  const emptyEnsureSession = makeRuntimeSession({
    id: "empty-runtime",
    filePath: join(tmpdir(), "pi-web-missing-empty-session.jsonl"),
    running: false,
    entries: [],
  });
  globalThis.__piSessions = new Map([
    ["visible-runtime", visible],
    ["empty-runtime", emptyEnsureSession],
  ]);
  t.after(() => {
    globalThis.__piSessions = previousRegistry;
  });

  const infos = getRpcSessionInfos();

  assert.equal(infos.length, 2);
  const visibleInfo = infos.find((info) => info.id === "visible-runtime");
  const emptyInfo = infos.find((info) => info.id === "empty-runtime");
  assert.equal(visibleInfo?.firstMessage, "first prompt");
  assert.equal(visibleInfo?.contextSourceSessionId, "source-session");
  assert.equal(visibleInfo?.messageCount, 1);
  assert.equal(visibleInfo?.transient, true);
  assert.equal(emptyInfo?.firstMessage, "(no messages)");
  assert.equal(emptyInfo?.messageCount, 0);
  assert.equal(emptyInfo?.transient, true);
});

test("keeps an idle runtime visible once its JSONL file exists", (t) => {
  const previousRegistry = globalThis.__piSessions;
  const dir = mkdtempSync(join(tmpdir(), "pi-web-runtime-session-"));
  const filePath = join(dir, "session.jsonl");
  writeFileSync(filePath, "persisted\n");
  globalThis.__piSessions = new Map([["persisted-runtime", makeRuntimeSession({
    id: "persisted-runtime",
    filePath,
    running: false,
    entries: [{
      type: "message",
      id: "m1",
      parentId: null,
      timestamp: "2026-08-12T01:02:04.000Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "saved" }],
      },
    }],
  })]]);
  t.after(() => {
    globalThis.__piSessions = previousRegistry;
    rmSync(dir, { recursive: true, force: true });
  });

  const infos = getRpcSessionInfos();

  assert.equal(infos.length, 1);
  assert.equal(infos[0].transient, false);
});


test("projects the validated runtime cwd instead of the historical header cwd", (t) => {
  const previousRegistry = globalThis.__piSessions;
  globalThis.__piSessions = new Map([["runtime-cwd", makeRuntimeSession({
    id: "runtime-cwd",
    filePath: join(tmpdir(), "pi-web-runtime-cwd.jsonl"),
    running: true,
    headerCwd: "/tmp/historical-cwd",
    entries: [],
  })]]);
  t.after(() => { globalThis.__piSessions = previousRegistry; });
  assert.equal(getRpcSessionInfos()[0].cwd, "/tmp/runtime-cwd");
});
