import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

// Mac contract: no React/DOM mount is attempted here. The author worktree only
// performs static parse/diff checks; Debian runs the real test with the locked
// React/SDK closure. The behavioral seam below uses the production audio claim
// helper and the actual ChatWindow/useAgentSession source contracts.
const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const hookSource = await readFile(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");
const completionBlock = source.slice(
  source.indexOf("const wrappedOnAgentEnd"),
  source.indexOf("// 失败轮次可能同时经", source.indexOf("const wrappedOnAgentEnd")),
);
const errorBlock = source.slice(
  source.indexOf("const wrappedOnAgentError"),
  source.indexOf("const scrollAnchorCaptureRef", source.indexOf("const wrappedOnAgentError")),
);


test("labels the npm release link as upstream rather than the installed Reader version", async () => {
  assert.match(source, /text=\{\(version\) => t\("appUpdate\.upstreamVersion", \{ version \}\)\}/);
  assert.match(source, /\{text\(update\.latestVersion\)\}/);
  for (const [file, label] of [["en.ts", "Upstream v{version}"], ["zh-CN.ts", "上游 v{version}"], ["zh-TW.ts", "上游 v{version}"]]) {
    const locale = await readFile(new URL(`../lib/i18n/messages/${file}`, import.meta.url), "utf8");
    assert.ok(locale.includes(`"appUpdate.upstreamVersion": "${label}"`), file);
  }
});

test("shows unconfirmed delivery as a persistent in-page warning", () => {
  assert.match(source, /hasUnconfirmedPrompt && \([\s\S]*?role="alert"[\s\S]*?chat\.promptDeliveryUnconfirmed/);
  assert.match(hookSource, /hasUnconfirmedPrompt: unconfirmedPrompts\.some/);
});

test("does not play a success sound for stopped, SDK-aborted, or failed tails", () => {
  assert.match(completionBlock, /last\.stopReason === "error" \|\| Boolean\(last\.errorMessage\)/);
  assert.match(completionBlock, /const lastAborted = last\?\.role === "assistant" && last\.stopReason === "aborted"/);
  assert.match(completionBlock, /if \(!lastFailed\) \{[\s\S]*?if \(!lastAborted\) \{[\s\S]*?statusSoundRequestId\(session\?\.id, "done", serverRunId\)/);
  assert.match(completionBlock, /onAgentEnd\?\.\(serverRunId\)/);
});

test("routes SDK 1.1 aborted state through agent_settled and suppresses success notification", () => {
  const agentEndStart = hookSource.indexOf('case "agent_end"');
  const settledStart = hookSource.indexOf('case "agent_settled"');
  const promptDoneStart = hookSource.indexOf('case "prompt_done"', settledStart);
  assert.ok(agentEndStart >= 0 && settledStart > agentEndStart && promptDoneStart > settledStart);
  const agentEndBlock = hookSource.slice(agentEndStart, settledStart);
  const settledBlock = hookSource.slice(settledStart, promptDoneStart);
  assert.match(agentEndBlock, /if \(agentEndWasAborted\(event\)\) lastAgentAbortedRef\.current = true/);
  assert.match(settledBlock, /if \(event\.aborted === true\) lastAgentAbortedRef\.current = true/);
  assert.match(settledBlock, /if \(wasRunning && !lastAgentErrorRef\.current && !lastAgentAbortedRef\.current\) notifyPromptStage/);
  assert.match(settledBlock, /if \(wasRunning && \(lastAgentErrorRef\.current \|\| lastAgentAbortedRef\.current\)\)/);
});

test("deduplicates error and success claims by session plus server run, without crossing sessions", async () => {
  const store = new Map();
  const previousWindow = globalThis.window;
  globalThis.window = {
    localStorage: {
      getItem(key) { return store.has(key) ? store.get(key) : null; },
      setItem(key, value) { store.set(key, String(value)); },
    },
    parent: undefined,
  };
  try {
    const audio = await createJiti(import.meta.url, { moduleCache: false }).import("../hooks/useAudio.ts");
    const oldDone = audio.statusSoundRequestId("session-old", "done", "run-1");
    const newDone = audio.statusSoundRequestId("session-new", "done", "run-1");
    const oldError = audio.statusSoundRequestId("session-old", "error", "run-1");
    assert.equal(oldDone, "status:done:session-old:run-1");
    assert.equal(oldError, "status:error:session-old:run-1");
    assert.notEqual(oldDone, newDone, "an old terminal event cannot claim a new session");

    let plays = 0;
    assert.equal(audio.tryPlaySoundRequest(oldDone, async () => { plays += 1; return true; }), true);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(plays, 1);
    assert.equal(audio.tryPlaySoundRequest(oldDone, async () => { plays += 1; return true; }), false);
    assert.equal(audio.tryPlaySoundRequest(newDone, async () => { plays += 1; return true; }), true);
    assert.equal(audio.tryPlaySoundRequest(oldError, async () => { plays += 1; return true; }), true);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("keeps error callbacks on the same dedup chain and preserves server identity", () => {
  assert.match(errorBlock, /onAgentError\?\.\(serverUnattended, serverRunId\)/);
  assert.match(errorBlock, /const soundKey = statusSoundRequestId\(session\?\.id, "error", serverRunId\)/);
  assert.match(errorBlock, /tryPlaySoundRequest\(soundKey, playErrorSoundRef\.current/);
  assert.match(source, /statusSoundRequestId\(session\?\.id, "done", serverRunId\)/);
  assert.match(source, /statusSoundRequestId\(session\?\.id, "error", serverRunId\)/);
});
