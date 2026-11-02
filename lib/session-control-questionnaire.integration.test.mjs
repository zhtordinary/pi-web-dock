import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// Supply the unmodified, externally materialized npm package explicitly. The
// normal repository test suite must not download/install a third-party package.
// READER_QUESTIONNAIRE_SOURCE=/path/to/package node --test lib/session-control-questionnaire.integration.test.mjs
const configuredSource = process.env.READER_QUESTIONNAIRE_SOURCE?.trim();
const source = configuredSource ? resolve(configuredSource) : undefined;
const skipReason = !source
  ? "Set READER_QUESTIONNAIRE_SOURCE to the original rpiv-ask-user-question npm package; no substituted implementation is tested."
  : !existsSync(join(source, "rpc-fallback.ts")) || !existsSync(join(source, "ask-user-question.ts"))
    ? "READER_QUESTIONNAIRE_SOURCE does not contain the original questionnaire sources."
    : false;

function sourceFingerprint(root) {
  const hash = createHash("sha256");
  const walk = (relative = "") => {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      // Dependency symlinks are host setup, not files from the original tarball.
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const path = join(relative, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) { hash.update(path); hash.update("\0"); hash.update(readFileSync(join(root, path))); hash.update("\0"); }
    }
  };
  walk();
  return hash.digest("hex");
}

const options = [
  { label: "Reuse", description: "Use the existing implementation" },
  { label: "Repair", description: "Repair the current implementation" },
  { label: "Review", description: "Review the existing change" },
];
const question = (extra = {}) => ({ header: "Approach", question: "Which approach should be used?", options, ...extra });

test("original questionnaire RPC source integrates with real Reader UI resolvers and session_control", { skip: skipReason }, async (t) => {
  const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  assert.equal(manifest.name, "@juicesharp/rpiv-ask-user-question");
  const beforeSource = sourceFingerprint(source);
  const fallbackSha256 = createHash("sha256").update(readFileSync(join(source, "rpc-fallback.ts"))).digest("hex");
  const executeSha256 = createHash("sha256").update(readFileSync(join(source, "ask-user-question.ts"))).digest("hex");
  t.diagnostic(`Original package ${manifest.name}@${manifest.version}; rpc-fallback.ts sha256=${fallbackSha256}; ask-user-question.ts sha256=${executeSha256}`);

  const root = mkdtempSync(join(tmpdir(), "reader-original-questionnaire-"));
  const environment = {
    HOME: root,
    XDG_CONFIG_HOME: join(root, "config"),
    PI_CODING_AGENT_DIR: join(root, "agent"),
    PI_WEB_SESSION_WAIT_STATE_ROOT: join(root, "waits"),
    PI_WEB_SESSION_ACTIVITY_FILE: join(root, "activity.json"),
    PI_WEB_SESSION_ACTIVITY_CONFIG: JSON.stringify({ device: { id: "original-questionnaire-device", name: "Original questionnaire test" } }),
  };
  const previousEnvironment = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  const priorSessions = globalThis.__piSessions;
  Object.assign(process.env, environment);
  t.after(() => {
    assert.equal(sourceFingerprint(source), beforeSource, "original package source bytes must remain unchanged");
    globalThis.__piSessions = priorSessions;
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
  // Deliberately resolve the package's .js specifier to its original .ts source
  // through the same jiti convention used by Pi. No extracted function or fake.
  const { runRpcQuestionnaire } = await jiti.import(join(source, "rpc-fallback.js"));
  const { registerAskUserQuestionTool } = await jiti.import(join(source, "ask-user-question.js"));
  const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
  const { createSessionControlExtension } = await jiti.import("./session-control.ts");
  assert.equal(typeof runRpcQuestionnaire, "function");
  assert.equal(typeof registerAskUserQuestionTool, "function");
  let sequence = 0;

  function harness(context) {
    const sessionId = `questionnaire-target-${++sequence}`;
    const sessionFile = join(root, `${sessionId}.jsonl`);
    writeFileSync(sessionFile, "");
    const manager = {
      getSessionId: () => sessionId, getSessionFile: () => sessionFile, getCwd: () => root,
      getHeader: () => ({ id: sessionId, cwd: root }), getSessionName: () => sessionId,
      getEntries: () => [], getLeafId: () => null, buildSessionContext: () => ({ messages: [] }),
    };
    const wrapper = new AgentSessionWrapper({
      sessionId, sessionFile, sessionManager: manager,
      isStreaming: false, isCompacting: false, isBashRunning: false, isIdle: true,
      pendingMessageCount: 0, autoRetryEnabled: false, autoCompactionEnabled: false,
      agent: { state: { messages: [] }, abort() {} }, extensionRunner: {},
      abortRetry() {}, abortCompaction() {}, abortBranchSummary() {}, dispose() {},
      getContextUsage: () => null, getSteeringMessages: () => [], getFollowUpMessages: () => [],
      settingsManager: { getDefaultThinkingLevel: () => "off" },
    });
    globalThis.__piSessions = new Map([[sessionId, wrapper]]);
    context.after(async () => { wrapper.destroy(); await wrapper.waitUntilDisposed(); });
    let controlDefinition;
    createSessionControlExtension().factory({ registerTool(value) { controlDefinition = value; } });
    const callerContext = { cwd: root, sessionManager: { getSessionId: () => "questionnaire-supervisor", getSessionFile: () => join(root, "supervisor.jsonl") } };
    const control = async (params) => {
      const result = await controlDefinition.execute(`control-${sequence}`, { target: sessionId, ...params }, undefined, undefined, callerContext);
      const value = JSON.parse(result.content[0].text);
      assert.equal(value.error, undefined, JSON.stringify(value));
      return value;
    };
    const pending = async (method) => {
      const result = await control({ action: "wait_for", until: "ui_request", timeoutMs: 1000 });
      assert.equal(result.timedOut, false);
      assert.equal(result.event.method, method);
      const snapshot = (await control({ action: "pending_ui" })).pendingUi;
      assert.equal(snapshot.requests.length, 1);
      assert.equal(snapshot.requests[0].id, result.event.id);
      assert.equal(snapshot.runtimeGeneration, result.event.runtimeGeneration);
      return snapshot.requests[0];
    };
    const answer = async (request, value) => {
      const receipt = await control({ action: "answer_ui", requestId: request.id, runtimeGeneration: request.runtimeGeneration, ...value });
      assert.equal(receipt.status, "accepted");
      return receipt;
    };
    const ui = wrapper.createExtensionUiContext();
    return { wrapper, ui, control, pending, answer };
  }

  for (const mode of ["original runRpcQuestionnaire", "original registered execute ctx.mode=rpc"]) {
    await t.test(mode, async (suite) => {
      const executeOriginal = (ui, params) => {
        if (mode === "original runRpcQuestionnaire") return runRpcQuestionnaire(ui, params).then((details) => ({ details }));
        let definition;
        const events = [];
        registerAskUserQuestionTool({ registerTool(value) { definition = value; }, events: { emit(name, payload) { events.push({ name, payload }); } } });
        assert.equal(definition.name, "ask_user_question");
        return definition.execute("original-ask", params, undefined, undefined, { mode: "rpc", hasUI: true, ui }).then((result) => {
          const blocked = events.filter((event) => typeof event.payload?.active === "boolean");
          assert.deepEqual(blocked.map((event) => event.payload.active), [true, false], "original RPC path must bracket the wait with blocked notifications");
          return result;
        });
      };

      await suite.test("single-select exact Type something. sentinel opens a new input and preserves custom text", async (context) => {
        const host = harness(context);
        const params = { questions: [question()] };
        const running = executeOriginal(host.ui, params);
        const select = await host.pending("select");
        assert.deepEqual(select.options, ["1. Reuse — Use the existing implementation", "2. Repair — Repair the current implementation", "3. Review — Review the existing change", "4. Type something."]);
        await host.answer(select, { value: select.options.at(-1) });
        const input = await host.pending("input");
        assert.notEqual(input.id, select.id);
        assert.match(input.title, /Type your answer:/);
        assert.match(input.title, /1\. Reuse/);
        assert.equal(input.placeholder, "");
        const custom = "  仅复用原审查，不新增模型调用。\n保留第二行。  ";
        await host.answer(input, { value: custom });
        const result = await running;
        assert.equal(result.details.cancelled, false);
        assert.deepEqual(result.details.answers, [{ questionIndex: 0, question: params.questions[0].question, kind: "custom", answer: custom }]);
        assert.equal(host.wrapper.getPendingUiRequestsSnapshot().requests.length, 0);
      });

      await suite.test("cancelling custom input returns to a fresh select without cancelling the questionnaire", async (context) => {
        const host = harness(context);
        const params = { questions: [question()] };
        const running = executeOriginal(host.ui, params);
        const first = await host.pending("select");
        await host.answer(first, { value: first.options.at(-1) });
        const input = await host.pending("input");
        await host.answer(input, { cancelled: true });
        const retry = await host.pending("select");
        assert.notEqual(retry.id, first.id);
        assert.notEqual(retry.id, input.id);
        assert.deepEqual(retry.options, first.options);
        await host.answer(retry, { value: retry.options[1] });
        const result = await running;
        assert.equal(result.details.cancelled, false);
        assert.equal(result.details.answers[0].kind, "option");
        assert.equal(result.details.answers[0].answer, "Repair");
      });

      await suite.test("multi-select native input parses 1,3;自填 into selected options and custom text", async (context) => {
        const host = harness(context);
        const params = { questions: [question({ multiSelect: true })] };
        const running = executeOriginal(host.ui, params);
        const input = await host.pending("input");
        assert.equal(input.placeholder, "1,3; custom answer");
        assert.match(input.title, /comma-separated/);
        await host.answer(input, { value: "1,3;自填" });
        const result = await running;
        assert.deepEqual(result.details, { cancelled: false, answers: [{ questionIndex: 0, question: params.questions[0].question, kind: "multi", answer: "自填", selected: ["Reuse", "Review"] }] });
      });

      await suite.test("cancelling the next select cancels the whole questionnaire while retaining prior answers", async (context) => {
        const host = harness(context);
        const params = { questions: [question(), question({ header: "Release", question: "What should happen next?" })] };
        const running = executeOriginal(host.ui, params);
        const first = await host.pending("select");
        await host.answer(first, { value: first.options[0] });
        const second = await host.pending("select");
        assert.notEqual(second.id, first.id);
        await host.answer(second, { cancelled: true });
        const result = await running;
        assert.equal(result.details.cancelled, true);
        assert.equal(result.details.answers.length, 1);
        assert.equal(result.details.answers[0].answer, "Reuse");
        if (mode !== "original runRpcQuestionnaire") assert.equal(result.content[0].text, "User declined to answer questions");
        assert.equal(host.wrapper.getPendingUiRequestsSnapshot().requests.length, 0);
      });
    });
  }
  t.diagnostic(`Original package source tree unchanged: sha256=${beforeSource}. Fixture AgentSession state only; no model execution, terminal rendering, browser or deployment validation.`);
});
