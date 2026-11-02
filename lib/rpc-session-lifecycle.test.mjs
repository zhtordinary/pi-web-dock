import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");
const { persistSessionFile } = await jiti.import("./rpc-manager.ts");

async function readTypes(filePath) {
  const lines = (await readFile(filePath, "utf8")).trim().split("\n").filter(Boolean);
  const entries = lines.map((line) => JSON.parse(line));
  return {
    count: entries.length,
    types: entries.map((entry) => entry.type),
    messageRoles: entries
      .filter((entry) => entry.type === "message")
      .map((entry) => entry.message?.role),
  };
}

test("metadata preflight stays transient until the SDK has appended a user message", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-session-lifecycle-"));
  const manager = SessionManager.create(join(root, "project"), join(root, "sessions"));
  const filePath = manager.getSessionFile();
  t.after(() => rm(root, { recursive: true, force: true }));

  manager.appendModelChange("fixture", "model");
  manager.appendThinkingLevelChange("high");
  manager.appendCustomEntry("reader-tool-selection", { names: ["read"] });
  assert.equal(existsSync(filePath), false);

  manager.appendMessage({ role: "user", content: "first", timestamp: Date.now() });
  // SDK 1.0 persists the first user conversation message; Reader only needs
  // persistSessionFile() for explicit names and completed bash-only sessions.
  assert.equal(existsSync(filePath), true);

  await new Promise((resolve) => queueMicrotask(resolve));
  assert.equal(persistSessionFile(manager), false);
  assert.deepEqual(await readTypes(filePath), {
    count: 5,
    types: ["session", "model_change", "thinking_level_change", "custom", "message"],
    messageRoles: ["user"],
  });
});

test("an explicit session name remains an intentional empty-session promotion", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-session-name-"));
  const manager = SessionManager.create(join(root, "project"), join(root, "sessions"));
  const filePath = manager.getSessionFile();
  t.after(() => rm(root, { recursive: true, force: true }));

  manager.appendSessionInfo("named draft");
  assert.equal(existsSync(filePath), false);
  assert.equal(persistSessionFile(manager), true);
  assert.deepEqual(await readTypes(filePath), {
    count: 2,
    types: ["session", "session_info"],
    messageRoles: [],
  });
});
