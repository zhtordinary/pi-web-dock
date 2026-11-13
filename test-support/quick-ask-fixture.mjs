import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import vm from "node:vm";
import { createJiti } from "jiti";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createInitialSystemMessage } from "@earendil-works/pi-ai/utils/transcript";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
export const storage = await jiti.import("../lib/quick-ask-storage.ts");
export const log = await jiti.import("../lib/quick-ask-log.ts");
export const context = await jiti.import("../lib/quick-ask-context.ts");
export const observers = await jiti.import("../lib/quick-ask-observer.ts");
const zhCNLocale = await jiti.import("../lib/i18n/messages/zh-CN.ts");
const { QuickAskRuntime, getClosingQuickAsk } = await jiti.import("../lib/quick-ask-runtime.ts");
const { acquireSessionRuntimeOwnership } = await jiti.import("../lib/session-runtime-ownership.ts");
const eventStream = await jiti.import("../lib/quick-ask-event-stream.ts");
const routeSource = await readFile(new URL("../app/api/sessions/[id]/quick-ask/route.ts", import.meta.url), "utf8");
const rpcSource = await readFile(new URL("../lib/rpc-manager.ts", import.meta.url), "utf8");
const compile = (source) => ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
} }).outputText;

function loadScoped(source, globals) {
  const exports = {};
  vm.runInNewContext(compile(source), { exports, console, ...globals }, { timeout: 1000 });
  return exports;
}

export const model = { api: "openai-responses", provider: "fixture", id: "model", baseUrl: "https://invalid.example/v1",
  reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
export const usage = { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, totalTokens: 100,
  reasoning: 5, cost: { input: 0.001, output: 0.002, cacheRead: 0.003, cacheWrite: 0.004, total: 0.01 } };
export const image = { data: "AAAA", mimeType: "image/png" };
export function assistant(text, selected = model, extra = {}) {
  return { role: "assistant", content: [{ type: "text", text }], api: selected.api, provider: selected.provider,
    model: selected.id, usage: structuredClone(usage), stopReason: "stop", timestamp: Date.now(), ...extra };
}
export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Real SDK manager, event stream and Reader persistence methods; only inference is synthetic. */
export async function quickAskFixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "reader-side-branch-"));
  const manager = SessionManager.create(root, root);
  const selectedModel = options.model ?? model;
  if (!options.empty) manager.appendMessage({ role: "user", content: "ancestor question", timestamp: 1 });
  manager.appendModelChange(selectedModel.provider, selectedModel.id);
  manager.appendThinkingLevelChange("medium");
  const file = manager.getSessionFile();
  const state = { visible: true, closed: false, mainRunning: false, creates: 0, starts: 0, disposes: 0, aborts: 0, shutdowns: 0 };
  const runs = [];
  const tools = [{ name: "fixture-tool", description: "Declared by a fixture host without an execution session", parameters: { type: "object", properties: {} } }];
  const system = options.system ?? createInitialSystemMessage("Stable synthetic instructions", tools);
  const methods = rpcSource.slice(rpcSource.indexOf("  private appendSideAskRecord("), rpcSource.indexOf("  private currentSystemPrompt("))
    + rpcSource.slice(rpcSource.indexOf("  persistSessionFileNow("), rpcSource.indexOf("  onEvent("));
  const { Persistence } = loadScoped(`export class Persistence {
    constructor(inner) { this.inner = inner; this.sideAskWriteFailed = false; }
    get sessionFile() { return this.inner.sessionManager.getSessionFile(); }
    assertSessionWriteAllowed() { if (state.closed || this.sideAskWriteFailed) throw new Error("Session is closed"); }
    emitShutdownEvent() { state.shutdowns++; }
    disposeNow() { state.closed = true; }
    async shutdown() { this.disposeNow(); }
    ${methods}
  }`, { existsSync: (await import("node:fs")).existsSync, writeFileSync: (await import("node:fs")).writeFileSync,
    cacheSessionPath() {}, invalidateSessionReadCache() {}, invalidateSessionListCache() {}, state });
  const inner = { sessionManager: manager, get sessionId() { return manager.getSessionId(); }, async abort() { state.aborts++; } };
  const persistence = new Persistence(inner);
  const host = { sessionId: manager.getSessionId(), sessionFile: file, manager,
    assertWritable: () => persistence.assertSessionWriteAllowed(),
    isMainRunning: () => state.mainRunning, currentModel: () => selectedModel,
    sourceSystem: () => system, transformContext: options.transform ?? (async (messages) => messages),
    append: (type, data) => persistence.appendSideAskRecord(type, data),
    associateProvider: options.associateProvider,
    materialized: options.materialized ?? (async () => ({})),
  };
  const createRuntime = async () => {
    state.creates++;
    if (options.createRuntime) return options.createRuntime();
    const runtime = { getModel: (provider, id) => options.getModel ? options.getModel(provider, id) : { ...selectedModel, provider, id },
      streamSimple: (activeModel, transcript, streamOptions) => {
        const stream = new AssistantMessageEventStream();
        const run = { runtime, model: activeModel, transcript: structuredClone(transcript), options: streamOptions, stream,
          text: "", thinking: "",
          emit(text) { this.text += text; stream.push({ type: "text_delta", delta: text }); },
          think(text) { this.thinking += text; stream.push({ type: "thinking_delta", delta: text }); },
          complete(text = "side answer", extra = {}) {
            if (text) this.emit(text);
            const message = assistant(this.text, activeModel, { content: [
              ...(this.thinking ? [{ type: "thinking", thinking: this.thinking, thinkingSignature: "synthetic-signature" }] : []),
              { type: "text", text: this.text, textSignature: "synthetic-text-signature" },
            ], ...extra });
            this.final = message;
            stream.push({ type: "done", reason: message.stopReason, message });
            stream.end();
          },
          fail(message = "synthetic provider error") {
            stream.push({ type: "error", reason: "error", error: assistant("", activeModel, { stopReason: "error", errorMessage: message }) });
            stream.end();
          },
        };
        streamOptions.signal.addEventListener("abort", () => {
          const finishAbort = () => stream.end(assistant(run.text, activeModel, { stopReason: "aborted" }));
          if (options.deferAbort) setImmediate(finishAbort);
          else finishAbort();
        }, { once: true });
        runs.push(run);
        options.onStream?.(run);
        return stream;
      },
    };
    return runtime;
  };
  const side = new QuickAskRuntime(host, createRuntime, () => { state.disposes++; options.disposeRuntime?.(); });
  persistence.sideAskRuntime = side;
  const owner = { inner, sessionFile: file, isAlive: () => !state.closed, isShuttingDown: () => state.closed,
    assertSessionWriteAllowed: () => persistence.assertSessionWriteAllowed(),
    peekQuickAskRuntime: () => side, getQuickAskRuntime: () => side };
  const getRpcSession = () => state.visible ? owner : undefined;
  const startLocks = new Map();
  const coldGlobals = { getLocks: () => startLocks, getRpcSession, SessionManager, acquireSessionRuntimeOwnership, ...context, ...log,
    projectSessionQuickAsksForFork: storage.projectSessionQuickAsks,
    invalidateSessionReadCache() {}, cacheSessionPath() {}, invalidateSessionListCache() {},
    inheritSubprojectAssignment: async () => true };
  const forkCode = rpcSource.slice(rpcSource.indexOf("export async function forkQuickAskSession("), rpcSource.indexOf("export async function inheritSubprojectAssignment("));
  const { forkQuickAskSession } = loadScoped(forkCode, coldGlobals);
  const mocks = {
    "next/server": { NextResponse: { json: Response.json } },
    "@/lib/session-reader": { resolveSessionPath: async () => file },
    "@/lib/rpc-manager": { getRpcSession, forkQuickAskSession,
      startRpcSession: async () => { state.starts++; state.visible = true; return { session: owner }; } },
    "@/lib/quick-ask-context": context, "@/lib/quick-ask-log": log,
    "@/lib/quick-ask-storage": storage, "@/lib/quick-ask-event-stream": eventStream,
    "@/lib/quick-ask-runtime": { getClosingQuickAsk },
    "@/lib/i18n/messages/zh-CN": zhCNLocale,
  };
  const mod = { exports: {} };
  vm.runInNewContext(compile(routeSource), { require: (name) => mocks[name] ?? require(name), module: mod, exports: mod.exports,
    console, URL, Request, Response, AbortController, AbortSignal, ReadableStream, TextEncoder, setInterval, clearInterval,
  }, { timeout: 1000 });
  const request = (method, body, init = {}) => mod.exports[method](new Request(`http://synthetic/api/sessions/${manager.getSessionId()}/quick-ask${init.query ?? ""}`, {
    method, ...(method === "GET" ? {} : { body: JSON.stringify(body) }), ...(init.signal ? { signal: init.signal } : {}),
  }), { params: init.params ?? Promise.resolve({ id: manager.getSessionId() }) });
  const waitTerminal = (id) => new Promise((resolve) => {
    const current = side.snapshot(id);
    if (current?.status !== "running") { resolve(current); return; }
    const detach = side.subscribe(id, (event) => {
      if (event.type === "done" || event.type === "error") { detach(); resolve(event.run); }
    });
  });
  return { root, manager, file, host, side, owner, state, runs, system, persistence, startLocks, request,
    post: (body, init) => request("POST", body, init), get: (query = "") => request("GET", undefined, { query }),
    async start(body = {}) {
      const response = await request("POST", { action: "start", question: "side question", threadId: "a", branchId: "main", ...body });
      if (response.status !== 202) throw new Error(`Admission failed: ${response.status} ${await response.text()}`);
      const { run } = await response.json();
      await side.whenReady(run.id);
      return run;
    }, waitTerminal,
    async cleanup() { side.close(); await tick(); await rm(root, { recursive: true, force: true }); },
  };
}
