import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveAgentExecutionContext,
  resolveFileReferencePath,
  resolveMainlineFileContext,
  retainFileTabContext,
  sameFileContext,
} from "./file-context.ts";

test("manual file and terminal context use projectRoot while Agent keeps session cwd", () => {
  const session = { projectRoot: "/repo", cwd: "/repo/.worktrees/agent-a" };
  assert.deepEqual(resolveMainlineFileContext({ deviceId: "debian", ...session }), {
    deviceId: "debian",
    projectRoot: "/repo",
    cwd: "/repo",
  });
  assert.deepEqual(resolveAgentExecutionContext({ deviceId: "debian", ...session }), {
    deviceId: "debian",
    projectRoot: "/repo",
    cwd: "/repo/.worktrees/agent-a",
  });
});

test("a selected session switch does not replace an existing manual context", () => {
  const manual = resolveMainlineFileContext({ deviceId: "debian", projectRoot: "/repo" });
  const sessionB = resolveAgentExecutionContext({ deviceId: "debian", projectRoot: "/repo", cwd: "/repo/.worktrees/agent-b" });
  assert.ok(manual && sessionB);
  assert.equal(manual.cwd, "/repo");
  assert.equal(sessionB.cwd, "/repo/.worktrees/agent-b");
  assert.equal(sameFileContext(manual, sessionB), false);
});

test("remote context never falls back to a local path when its cwd is absent", () => {
  assert.equal(resolveMainlineFileContext({ deviceId: "debian", projectRoot: null, cwd: null }), null);
  assert.equal(resolveAgentExecutionContext({ deviceId: "debian", projectRoot: null, cwd: null }), null);
});

test("file tabs retain their explicit device and path context", () => {
  const tab = retainFileTabContext({ deviceId: "device-a", projectRoot: "/repo", cwd: "/repo/docs" });
  const afterPeerSwitch = retainFileTabContext({ deviceId: tab?.deviceId, projectRoot: tab?.projectRoot, cwd: tab?.cwd });
  assert.deepEqual(afterPeerSwitch, tab);
  assert.equal(sameFileContext(tab, retainFileTabContext({ deviceId: "device-b", projectRoot: "/repo", cwd: "/repo/docs" })), false);
});

test("mainline @ references keep the full source path", () => {
  const context = resolveMainlineFileContext({ deviceId: "debian", projectRoot: "/repo" });
  assert.equal(resolveFileReferencePath("docs/readme.md", context), "/repo/docs/readme.md");
  assert.equal(resolveFileReferencePath("/repo/docs/readme.md", context), "/repo/docs/readme.md");
});
