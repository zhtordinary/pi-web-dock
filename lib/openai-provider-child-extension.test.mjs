import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
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

test("registers and disposes the child Provider extension with the parent session", async (t) => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-web-child-provider-"));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const apiDir = join(agentDir, "npm", "node_modules", "pi-subagents", "src", "api");
  await mkdir(apiDir, { recursive: true });
  await writeFile(join(apiDir, "required-child-extensions.js"), `
    globalThis.__readerChildExtensionRegistration = undefined;
    export function registerRequiredChildExtensions(input) {
      globalThis.__readerChildExtensionRegistration = { input, disposed: false };
      return { dispose() { globalThis.__readerChildExtensionRegistration.disposed = true; } };
    }
  `);

  const pi = fakePi();
  createOpenAIProviderChildExtension(agentDir).factory(pi);
  await pi.handlers.get("session_start")({}, { sessionManager: { getSessionId: () => "parent-session" } });

  const registration = globalThis.__readerChildExtensionRegistration;
  assert.equal(registration.input.sessionId, "parent-session");
  assert.equal(registration.input.extensions.length, 1);
  assert.equal(registration.input.extensions[0].id, "reader-openai-provider-aliases");
  assert.match(registration.input.extensions[0].path, /packages[\\/]reader-openai-subscription[\\/]index\.ts$/);
  assert.equal(registration.disposed, false);

  await pi.handlers.get("session_shutdown")();
  assert.equal(registration.disposed, true);
  delete globalThis.__readerChildExtensionRegistration;
});

test("uses the parent session only for subscription cache affinity", async (t) => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-web-child-provider-affinity-"));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const parentSession = join(agentDir, "parent.jsonl");
  await writeFile(parentSession, `${JSON.stringify({ type: "session", id: "parent-session" })}\n`);

  const pi = fakePi();
  createOpenAIProviderChildExtension(agentDir).factory(pi);
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
