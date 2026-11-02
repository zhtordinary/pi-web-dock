import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: true,
});
const {
  applyRuntimeCompactionOverride,
  buildTransientSessionRecreationOptions,
  sendTransientSessionCommand,
} = await jiti.import("./session-runtime.ts");
const { AgentCommandError } = await jiti.import("./agent-client.ts");
const { FAST_MODE_CUSTOM_TYPE } = await jiti.import("./fast-mode.ts");
const { SettingsManager } = await jiti.import("@earendil-works/pi-coding-agent");

test("runtime compaction override does not dirty global settings", async () => {
  const settings = SettingsManager.inMemory({ compaction: { enabled: true } });

  applyRuntimeCompactionOverride(settings, false);

  assert.equal(settings.getCompactionEnabled(), false);
  assert.equal(settings.getGlobalSettings().compaction.enabled, true);
  await settings.flush();
  assert.equal(settings.getGlobalSettings().compaction.enabled, true);
});

test("recreates an evicted transient runtime only for session-missing", async () => {
  const sent = [];
  let resets = 0;
  let ensures = 0;
  const result = await sendTransientSessionCommand({
    sessionId: "stale-draft",
    isNew: true,
    promoted: false,
    ensureSession: async () => {
      ensures += 1;
      return "fresh-draft";
    },
    resetSession: () => { resets += 1; },
    send: async (sessionId) => {
      sent.push(sessionId);
      if (sessionId === "stale-draft") {
        throw new AgentCommandError("Session not found", 404, "session_missing", false);
      }
      return { enabled: true };
    },
  });

  assert.deepEqual(result, { sessionId: "fresh-draft", result: { enabled: true } });
  assert.deepEqual(sent, ["stale-draft", "fresh-draft"]);
  assert.equal(resets, 1);
  assert.equal(ensures, 1);
});

test("recreation options preserve draft context lineage and Fast mode", () => {
  const options = buildTransientSessionRecreationOptions(
    {
      getHeader: () => ({ contextSourceSessionId: "source-session" }),
      getEntries: () => [{
        type: "custom",
        customType: FAST_MODE_CUSTOM_TYPE,
        data: { version: 1, mode: "fast" },
      }],
    },
    {
      toolNames: [],
      initialModel: { provider: "openai", modelId: "gpt-5" },
      thinkingLevel: "high",
    },
  );

  assert.deepEqual(options, {
    toolNames: [],
    initialModel: { provider: "openai", modelId: "gpt-5" },
    thinkingLevel: "high",
    fastMode: "fast",
    contextSourceSessionId: "source-session",
  });
});
