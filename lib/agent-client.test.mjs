import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});
const { AgentCommandError, isPromptRejectedError, isSessionMissingError, sendAgentCommand } = await jiti.import("./agent-client.ts");

test("agent command HTTP rejections are distinguishable from transport failures", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => new Response(
    JSON.stringify({
      error: "Authentication failed",
      code: "prompt_rejected",
      accepted: false,
    }),
    { status: 500, headers: { "Content-Type": "application/json" } },
  );

  await assert.rejects(
    sendAgentCommand("session-id", { type: "prompt", message: "hello" }),
    (error) => {
      assert.equal(error instanceof AgentCommandError, true);
      assert.equal(error.status, 500);
      assert.equal(error.message, "Authentication failed");
      assert.equal(error.code, "prompt_rejected");
      assert.equal(error.accepted, false);
      assert.equal(isPromptRejectedError(error), true);
      return true;
    },
  );

  const transportError = new TypeError("connection reset");
  globalThis.fetch = async () => {
    throw transportError;
  };

  await assert.rejects(
    sendAgentCommand("session-id", { type: "prompt", message: "hello" }),
    (error) => {
      assert.equal(error, transportError);
      assert.equal(error instanceof AgentCommandError, false);
      assert.equal(isPromptRejectedError(error), false);
      return true;
    },
  );
});

for (const [code, status] of [["session_runtime_owned", 409], ["session_archived", 409], ["session_missing", 404], ["request_denied", 403]]) {
  test(`a ${code} acknowledgement is a definitive rejection of the prompt`, async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = async () => Response.json({ error: "Prompt was not admitted", code, accepted: false }, { status });
    await assert.rejects(sendAgentCommand("session-id", { type: "prompt", message: "hello" }), (error) => {
      assert.equal(error instanceof AgentCommandError, true);
      assert.equal(error.accepted, false);
      assert.equal(isPromptRejectedError(error), true);
      return true;
    });
    assert.equal(isPromptRejectedError(new AgentCommandError("Not confirmed", status, code)), false);
    assert.equal(isPromptRejectedError(new AgentCommandError("Already accepted", status, code, true)), false);
  });
}

test("state inspection has a bounded abort signal without imposing a deadline on prompts", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ success: true, data: { autoCompactionEnabled: false } }),
      { headers: { "Content-Type": "application/json" } });
  };
  assert.equal((await sendAgentCommand("one", { type: "get_state" }, "peer")).autoCompactionEnabled, false);
  assert.equal(requests[0].url, "/api/remote/agent/one?peer=peer");
  assert.equal(requests[0].options.signal instanceof AbortSignal, true);
  assert.equal(requests[0].options.signal.aborted, false);
  await sendAgentCommand("one", { type: "prompt", message: "hello" });
  assert.equal(requests[1].options.signal, undefined);
});

test("only a definitive session-missing acknowledgement enables transient recovery", () => {
  assert.equal(
    isSessionMissingError(new AgentCommandError("Session not found", 404, "session_missing", false)),
    true,
  );
  assert.equal(
    isSessionMissingError(new AgentCommandError("Authentication failed", 500, "session_missing", false)),
    false,
  );
  assert.equal(
    isSessionMissingError(new AgentCommandError("Session not found", 404, "prompt_rejected", false)),
    false,
  );
  assert.equal(
    isSessionMissingError(new TypeError("connection reset")),
    false,
  );
});

test("only an explicit negative prompt acknowledgement is definitive", () => {
  assert.equal(
    isPromptRejectedError(new AgentCommandError("proxy failure", 502)),
    false,
  );
  assert.equal(
    isPromptRejectedError(new AgentCommandError("generic API failure", 500, "internal_error", false)),
    false,
  );
});
