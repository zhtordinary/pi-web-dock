import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const { createOpenAIProviderChildExtension } = await createJiti(import.meta.url).import("./openai-provider-child-extension.ts");

function fakePi() {
  const handlers = new Map();
  return {
    handlers,
    on(name, handler) {
      handlers.set(name, handler);
    },
  };
}


test("uses the parent session only for subscription cache affinity", async (t) => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-web-child-provider-affinity-"));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const parentSession = join(agentDir, "parent.jsonl");
  await writeFile(parentSession, `${JSON.stringify({ type: "session", id: "parent-session" })}\n`);

  const pi = fakePi();
  createOpenAIProviderChildExtension().factory(pi);
  const headers = {
    "session-id": "child-session",
    "thread-id": "child-session",
    "x-client-request-id": "child-session",
  };
  pi.handlers.get("before_provider_headers")(
    { headers },
    {
      model: { provider: "openai-subscription" },
      sessionManager: { getHeader: () => ({ id: "child-session", parentSession }) },
    },
  );

  assert.equal(headers["session-id"], "parent-session");
  assert.equal(headers["thread-id"], "child-session");
  assert.equal(headers["x-client-request-id"], "child-session");

  const apiHeaders = { "session-id": "child-session" };
  pi.handlers.get("before_provider_headers")(
    { headers: apiHeaders },
    {
      model: { provider: "openai-api" },
      sessionManager: { getHeader: () => ({ id: "child-session", parentSession }) },
    },
  );
  assert.equal(apiHeaders["session-id"], "child-session");
});
