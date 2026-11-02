import { createHash, randomUUID } from "node:crypto";
import { zhCNLocale } from "./i18n/messages/zh-CN.ts";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { buildSessionProjection, type ModelRuntime, type SessionEntry, type SessionManager } from "@earendil-works/pi-coding-agent";
import type { Api, AssistantMessage, Model, SystemMessage } from "@earendil-works/pi-ai";
import { createModelRuntimeWithExtensions, disposeModelRuntime } from "./model-runtime";
import { registerSessionLivenessProvider } from "./session-liveness";
import { matchesExpectedLeaf } from "./branch-navigation";
import { createQuickAskProviderSessionId, withQuickAskCacheAffinity } from "./quick-ask-session";
import {
  createQuickAskUserMessage, prepareQuickAskContext, QuickAskError, quickAskErrorText, resolveQuickAskOutputBudget,
} from "./quick-ask-context";
import {
  createQuickAskBranch, findQuickAskBranch, materializeQuickAskBranch, materializeQuickAskTransfer, quickAskItems, quickAskRequestManager,
  quickAskDeletedRuns, quickAskPromotedBranches, quickAskRunSnapshots, quickAskScopeKey, quickAskTransferResult, quickAskTransferState, rebaseQuickAskBranch, sameQuickAskScope,
  QUICK_ASK_BRANCH, QUICK_ASK_PROMOTED_BRANCH, QUICK_ASK_RUN,
  QUICK_ASK_TRANSFER_PENDING, QUICK_ASK_TRANSFER,
  type QuickAskBranch, type QuickAskForkResult, type QuickAskRunSnapshot, type QuickAskScope,
} from "./quick-ask-log";
import {
  createQuickAskDerivativeUsageEvent, createQuickAskOriginUsageEvent, normalizeSessionUsage, projectSessionQuickAsks,
  type QuickAskEntry, type QuickAskUsageEvent,
} from "./quick-ask-storage";
import type { Base64ImageAttachment } from "./image-attachments";

export interface QuickAskHost {
  sessionId: string;
  sessionFile: string;
  manager: SessionManager;
  assertWritable(): void;
  isMainRunning(): boolean;
  currentModel(): { provider: string; id: string } | undefined;
  sourceSystem(): SystemMessage | undefined;
  transformContext(messages: AgentMessage[]): Promise<AgentMessage[]>;
  append(customType: string, data: unknown): SessionEntry;
  associateProvider?(sessionId: string, model: Model<Api>): { dispose(): void } | undefined;
  materialized?(result: QuickAskForkResult): Promise<{ subprojectAssignmentFailed?: boolean }>;
}
export interface QuickAskSubmission extends QuickAskScope {
  question: string;
  images: Base64ImageAttachment[];
  threadTitle?: string;
  requestId?: string;
  expectedParentId?: string | null;
  model?: { provider: string; id: string };
  thinkingLevel?: ThinkingLevel;
}
export type QuickAskLiveEvent =
  | { type: "snapshot"; run: QuickAskRunSnapshot }
  | { type: "chunk" | "thinking"; runId: string; revision: number; delta: string }
  | { type: "done"; run: QuickAskRunSnapshot; entry: QuickAskEntry }
  | { type: "error"; run: QuickAskRunSnapshot; error: string };
interface Run {
  view: QuickAskRunSnapshot;
  input: QuickAskSubmission;
  branch: QuickAskBranch;
  memory: SessionManager;
  controller: AbortController;
  ready: Promise<void>;
  readyResolve(): void;
  readyReject(error: unknown): void;
  settled: Promise<void>;
  settle(): void;
  resolveOutcome(): void;
  outcomePending: boolean;
  runtime?: ModelRuntime;
  providerLease?: { dispose(): void };
  closeIterator?: () => void;
  requestDigest: string;
  usageEvent: QuickAskUsageEvent;
  final?: AssistantMessage;
  outcomeRecorded?: boolean;
}

/** Run records leave attachments to the admitted user message; copying them again per state change only grows the file. */
function runRecord(view: QuickAskRunSnapshot): Omit<QuickAskRunSnapshot, "images"> {
  const { images: _images, ...record } = view;
  return record;
}

function submissionDigest(input: QuickAskSubmission): string {
  return createHash("sha256").update(JSON.stringify({
    threadId: input.threadId, branchId: input.branchId, question: input.question,
    images: input.images.map(({ data, mimeType }) => ({ data, mimeType })),
    model: input.model ? [input.model.provider, input.model.id] : null,
    thinkingLevel: input.thinkingLevel ?? null,
  })).digest("hex");
}

/** Two topics may share one context only when they were fixed to the same origin. */
function sameFixedOrigin(a: QuickAskBranch, b: QuickAskBranch): boolean {
  return a.contextAnchorId === b.contextAnchorId && JSON.stringify(a.sourceSystem) === JSON.stringify(b.sourceSystem);
}

/** Owns model work, not HTTP responses. All durable writes go through the live host. */
export class QuickAskRuntime {
  private readonly runs = new Map<string, Run>();
  private readonly active = new Map<string, Run>();
  private readonly listeners = new Map<string, Set<(event: QuickAskLiveEvent) => void>>();
  private readonly conversions = new Map<string, Promise<QuickAskForkResult>>();
  private readonly pendingOutcomes = new Map<string, Set<Promise<void>>>();
  private readonly transferring = new Set<string>();
  private readonly releaseLiveness: () => void;
  private closed = false;
  private closing = false;

  constructor(
    private readonly host: QuickAskHost,
    private readonly createRuntime: () => Promise<ModelRuntime> = createModelRuntimeWithExtensions,
    private readonly disposeRuntime: (runtime: ModelRuntime) => void = disposeModelRuntime,
  ) {
    this.host = { ...host, append: (customType, data) => { this.assertWritable(); return host.append(customType, data); } };
    this.releaseLiveness = registerSessionLivenessProvider({ name: "reader-side-asks", sessionId: host.sessionId,
      sessionFile: host.sessionFile, isActive: () => this.active.size > 0 || this.conversions.size > 0 || this.pendingOutcomes.size > 0 });
  }

  snapshots(latestOnly = true): QuickAskRunSnapshot[] {
    return quickAskRunSnapshots(this.host.manager.getEntries(), [...this.runs.values()].map((run) => this.view(run)), latestOnly);
  }
  snapshot(id: string): QuickAskRunSnapshot | undefined {
    const live = this.runs.get(id);
    return live ? this.view(live) : quickAskRunSnapshots(this.host.manager.getEntries(), [], false).find((run) => run.id === id);
  }
  /** Some topic has a model call in flight; answered without projecting the session log like `snapshots()`. */
  hasActiveRun(): boolean { return this.active.size > 0; }
  subscribe(id: string, listener: (event: QuickAskLiveEvent) => void): () => void {
    const listeners = this.listeners.get(id) ?? new Set();
    listeners.add(listener);
    this.listeners.set(id, listeners);
    return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(id); };
  }

  async start(input: QuickAskSubmission): Promise<QuickAskRunSnapshot> {
    this.assertWritable();
    const key = quickAskScopeKey(input);
    const digest = submissionDigest(input);
    const entries = this.host.manager.getEntries();
    if (input.requestId) {
      const deleted = quickAskDeletedRuns(entries).get(input.requestId);
      if (deleted) {
        if (!sameQuickAskScope(deleted, input)) throw new QuickAskError("Side Ask request identity conflicts with another topic", 409);
        throw new QuickAskError(zhCNLocale.messages["sidekick.hostDeletedRequest"], 410);
      }
      const admission = entries.find((entry) => entry.type === "custom" && entry.customType === QUICK_ASK_RUN
        && (entry.data as { id?: string })?.id === input.requestId);
      if (admission?.type === "custom") {
        const previous = this.snapshot(input.requestId);
        if (!previous) throw new QuickAskError(zhCNLocale.messages["sidekick.hostDeletedRequest"], 410);
        const recorded = admission.data as { requestDigest?: string };
        if (!sameQuickAskScope(previous, input) || previous.question !== input.question
          || (recorded.requestDigest && recorded.requestDigest !== digest)) {
          throw new QuickAskError("Side Ask request identity conflicts with an existing turn", 409);
        }
        return previous;
      }
    }
    if (this.transferring.has(key) || quickAskTransferResult(entries, input)) throw new QuickAskError(zhCNLocale.messages["sidekick.hostTransferInProgress"], 409);
    if (this.active.has(key)) throw new QuickAskError(zhCNLocale.messages["sidekick.hostTopicBusy"], 409);
    const recordedBranch = findQuickAskBranch(entries, input);
    let branch = recordedBranch;
    if (!branch) {
      if (input.expectedParentId !== undefined && !this.host.isMainRunning()
        && !matchesExpectedLeaf(this.host.manager, input.expectedParentId)) {
        throw new QuickAskError("Quick Ask origin branch changed; retry from the active branch", 409);
      }
      branch = createQuickAskBranch(entries, input, this.host.manager.getLeafId());
    }
    const rebased = rebaseQuickAskBranch(this.host.manager, branch);
    if (rebased) branch = rebased;
    if (!recordedBranch || rebased) {
      const projected = buildSessionProjection(entries, branch.contextAnchorId).messages;
      delete branch.sourceSystem;
      if (projected[0]?.role !== "system") branch.sourceSystem = this.host.sourceSystem();
    }
    const memory = quickAskRequestManager(this.host.manager, branch);
    const settings = memory.buildSessionContext();
    const selectedModel = input.model ?? (settings.model ? { provider: settings.model.provider, id: settings.model.modelId } : this.host.currentModel());
    if (!selectedModel) throw new QuickAskError("No model configured for this Side Ask", 400);
    const baseline = memory.getEntryCount();
    if (settings.model?.provider !== selectedModel.provider || settings.model?.modelId !== selectedModel.id) {
      memory.appendModelChange(selectedModel.provider, selectedModel.id);
    }
    if (input.thinkingLevel && input.thinkingLevel !== settings.thinkingLevel) memory.appendThinkingLevelChange(input.thinkingLevel);
    memory.appendMessage(createQuickAskUserMessage(input.question, input.images));
    const nativeEntries = memory.getEntries().slice(baseline);
    const view: QuickAskRunSnapshot = { id: input.requestId ?? randomUUID(), threadId: input.threadId, branchId: input.branchId,
      status: "running", question: input.question, images: input.images, answer: "", thinking: "", createdAt: Date.now(), revision: 0 };
    let readyResolve = () => {};
    let readyReject = (_error: unknown) => {};
    const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    // JSON admission and reconnect observers need not await model preparation.
    void ready.catch(() => undefined);
    let settle = () => {};
    const settled = new Promise<void>((resolve) => { settle = resolve; });
    let resolveOutcome = () => {};
    const outcomeReady = new Promise<void>((resolve) => { resolveOutcome = resolve; });
    const run: Run = { view, input: { ...input, model: selectedModel }, branch, memory,
      controller: new AbortController(), ready, readyResolve, readyReject, settled, settle,
      resolveOutcome, outcomePending: false,
      requestDigest: digest, usageEvent: createQuickAskOriginUsageEvent() };
    if (!recordedBranch || rebased) this.host.append(QUICK_ASK_BRANCH, branch);
    this.host.append(QUICK_ASK_RUN, { ...runRecord(view), requestDigest: run.requestDigest, contextAnchorId: branch.contextAnchorId, nativeEntries });
    this.runs.set(view.id, run);
    this.active.set(key, run);
    const outcomeSet = this.pendingOutcomes.get(key) ?? new Set<Promise<void>>();
    outcomeSet.add(outcomeReady);
    this.pendingOutcomes.set(key, outcomeSet);
    void outcomeReady.then(() => {
      const current = this.pendingOutcomes.get(key);
      if (!current) return;
      current.delete(outcomeReady);
      if (!current.size) this.pendingOutcomes.delete(key);
    });
    // The host retains this task after the admitting request and every observer disconnect.
    void this.execute(run).catch((error) => console.error("[pi-web] Side Ask cleanup failed:", quickAskErrorText(error)));
    return this.view(run);
  }

  async whenReady(id: string): Promise<QuickAskRunSnapshot> {
    const live = this.runs.get(id);
    if (live) await live.ready;
    const snapshot = live ? this.view(live) : this.snapshot(id);
    if (!snapshot) throw new QuickAskError("Side Ask run was not found", 404);
    if (snapshot.status === "failed" || snapshot.status === "cancelled") {
      throw new QuickAskError(snapshot.error ?? "Side Ask failed", snapshot.errorStatus ?? (snapshot.status === "cancelled" ? 499 : 500));
    }
    return snapshot;
  }

  stop(id: string, reason = zhCNLocale.messages["sidekick.stopped"]): QuickAskRunSnapshot | undefined {
    this.assertWritable();
    const run = this.runs.get(id);
    if (!run || run.view.status !== "running") return this.snapshot(id);
    run.view = { ...run.view, status: "cancelled", error: reason, errorStatus: 499, revision: run.view.revision + 1 };
    let saved = false;
    try { this.host.append(QUICK_ASK_RUN, runRecord(this.view(run))); saved = true; }
    finally {
      if (!saved) run.view = { ...run.view, status: "interrupted",
        error: zhCNLocale.messages["sidekick.hostStopSaveUnconfirmed"], errorStatus: 500, revision: run.view.revision + 1 };
      run.controller.abort(reason);
      run.closeIterator?.();
      run.readyReject(new QuickAskError(run.view.error ?? reason, run.view.errorStatus ?? 499));
      this.finish(run);
      this.emit(id, { type: "error", run: this.view(run), error: run.view.error ?? reason });
    }
    return this.view(run);
  }

  delete(scope: QuickAskScope, targetId?: string, requestId?: string): void {
    this.assertWritable();
    if (requestId) {
      const recorded = this.snapshot(requestId) ?? quickAskDeletedRuns(this.host.manager.getEntries()).get(requestId);
      if (recorded && !sameQuickAskScope(recorded, scope)) throw new QuickAskError("Side Ask request identity belongs to another topic", 409);
    }
    const run = this.active.get(quickAskScopeKey(scope));
    if (run && !targetId) this.stop(run.view.id, zhCNLocale.messages["sidekick.runDeleted"]);
    if (targetId) {
      if (!quickAskItems(this.host.manager.getEntries(), scope).some((entry) => entry.id === targetId)) throw new QuickAskError("Question not found on this branch", 404);
      this.host.append("quick_ask_delete", { targetId });
    } else this.host.append("quick_ask_thread_delete", { ...scope, ...(requestId ? { requestId } : {}) });
  }

  promote(fromBranchId: string): number {
    this.assertWritable();
    if (fromBranchId === "main") return 0;
    const records = this.host.manager.getEntries();
    if (!quickAskPromotedBranches(records).includes(fromBranchId)) {
      this.host.append(QUICK_ASK_PROMOTED_BRANCH, { branchId: fromBranchId });
    }
    if (this.snapshots(false).some((run) => run.branchId === fromBranchId && run.status !== "completed")) {
      throw new QuickAskError(zhCNLocale.messages["sidekick.hostMoveBusy"], 409);
    }
    const entries = projectSessionQuickAsks(records).filter((entry) =>
      (entry.data.branchId ?? entry.branchId ?? "main") === fromBranchId);
    const groups = new Map<string, QuickAskEntry[]>();
    for (const item of entries) {
      const threadId = item.data.threadId ?? item.threadId ?? "default";
      groups.set(threadId, [...(groups.get(threadId) ?? []), item]);
    }
    const plans = [...groups].map(([threadId, items]) => {
      const sourceScope = { threadId, branchId: fromBranchId };
      const source = findQuickAskBranch(records, sourceScope) ?? createQuickAskBranch(records, sourceScope, this.host.manager.getLeafId());
      // Topics with the same id but a different fixed origin cannot share one context: the moved topic keeps its own id on main.
      let destination: QuickAskScope = { threadId, branchId: "main" };
      let target = findQuickAskBranch(records, destination);
      if (target && !sameFixedOrigin(target, source)) {
        destination = { threadId: `${threadId}@${fromBranchId}`, branchId: "main" };
        target = findQuickAskBranch(records, destination);
        if (target && !sameFixedOrigin(target, source)) {
          throw new QuickAskError(zhCNLocale.messages["sidekick.hostDifferentAnchors"], 409);
        }
      }
      if (this.active.has(quickAskScopeKey(destination))) {
        throw new QuickAskError(zhCNLocale.messages["sidekick.hostMovePending"], 409);
      }
      return { sourceScope, destination, source, target, items };
    });
    for (const { sourceScope, destination, source, target, items } of plans) {
      if (!target) this.host.append(QUICK_ASK_BRANCH, { ...source, ...destination });
      const existing = quickAskItems(this.host.manager.getEntries(), destination);
      for (const item of items) {
        if (existing.some((entry) => entry.usageEvent?.sourceSessionId === this.host.sessionId
          && entry.usageEvent.sourceEntryId === item.id && entry.usageEvent.relation === "replace")) continue;
        const usageEvent = createQuickAskDerivativeUsageEvent(this.host.sessionId, item.id, item.usageEvent, "replace");
        const data = structuredClone(item.data);
        for (const native of data.nativeEntries ?? []) {
          if (native.type === "message" && native.message.role === "assistant") {
            Object.assign(native.message, { usageEvent });
          }
        }
        this.host.append("quick_ask", { ...data, runId: undefined, ...destination, contextAnchorId: source.contextAnchorId,
          usageEvent });
      }
      this.host.append("quick_ask_thread_delete", sourceScope);
    }
    return entries.length;
  }

  fork(scope: QuickAskScope, targetId?: string): Promise<QuickAskForkResult> {
    this.assertWritable();
    const key = JSON.stringify([quickAskScopeKey(scope), targetId ?? null]);
    const previous = this.conversions.get(key);
    if (previous) return previous;
    const completed = !targetId ? quickAskTransferState(this.host.manager.getEntries(), scope) : undefined;
    if (completed?.status === "completed") return Promise.resolve(completed.result);
    if (!targetId) this.transferring.add(quickAskScopeKey(scope));
    const operation = this.materialize(scope, targetId).finally(() => {
      this.conversions.delete(key);
      this.transferring.delete(quickAskScopeKey(scope));
    });
    this.conversions.set(key, operation);
    return operation;
  }

  close(): void {
    if (this.closed || this.closing) return;
    this.closing = true;
    try {
      for (const run of [...this.active.values()]) {
        try {
          if (run.view.status === "completed" && run.view.entry) {
            this.finish(run);
            this.emit(run.view.id, { type: "done", run: this.view(run), entry: run.view.entry });
          } else {
            this.host.assertWritable();
            if (run.view.status === "running") this.stop(run.view.id, zhCNLocale.messages["sidekick.hostSessionClosed"]);
            else {
              run.controller.abort();
              this.finish(run);
              this.emit(run.view.id, { type: "error", run: this.view(run), error: run.view.error ?? zhCNLocale.messages["sidekick.hostSessionClosed"] });
            }
          }
        } catch (error) {
          if (!this.runs.has(run.view.id)) continue;
          run.view = { ...run.view, status: "interrupted", error: quickAskErrorText(error), revision: run.view.revision + 1 };
          run.controller.abort();
          run.readyReject(error);
          this.finish(run);
          this.emit(run.view.id, { type: "error", run: this.view(run), error: run.view.error! });
        }
      }
    } finally {
      this.closed = true;
      this.releaseLiveness();
      this.listeners.clear();
    }
  }

  private assertWritable(): void {
    if (this.closed) throw new QuickAskError("Side Ask runtime is closed", 409);
    this.host.assertWritable();
    if (this.host.manager.getSessionId() !== this.host.sessionId || this.host.manager.getSessionFile() !== this.host.sessionFile) {
      throw new QuickAskError("Side Ask source runtime identity changed; reload the source session", 409);
    }
  }
  private view(run: Run): QuickAskRunSnapshot { return { ...run.view, images: [...run.view.images] }; }
  private emit(id: string, event: QuickAskLiveEvent): void {
    for (const listener of this.listeners.get(id) ?? []) {
      try { listener(event); } catch { /* A disconnected observer never owns or cancels model work. */ }
    }
  }
  private delta(run: Run, type: "chunk" | "thinking", value: string): void {
    if (!value || run.view.status !== "running") return;
    if (type === "chunk") run.view.answer += value; else run.view.thinking += value;
    this.emit(run.view.id, { type, runId: run.view.id, revision: ++run.view.revision, delta: value });
  }
  private finish(run: Run): void {
    const lease = run.providerLease;
    const runtime = run.runtime;
    run.providerLease = undefined;
    run.runtime = undefined;
    run.closeIterator = undefined;
    try { lease?.dispose(); }
    catch (error) { console.error("[pi-web] Side Ask provider cleanup failed:", quickAskErrorText(error)); }
    try { if (runtime) this.disposeRuntime(runtime); }
    catch (error) { console.error("[pi-web] Side Ask runtime cleanup failed:", quickAskErrorText(error)); }
    if (this.active.get(quickAskScopeKey(run.input)) === run) this.active.delete(quickAskScopeKey(run.input));
    this.runs.delete(run.view.id);
    run.settle();
  }

  private persistOutcome(run: Run, final: AssistantMessage): void {
    if (run.outcomeRecorded || run.view.status === "running" || run.view.status === "completed") return;
    if (final.role !== "assistant" || !Array.isArray(final.content)) return;
    try { this.assertWritable(); } catch { return; }
    run.outcomeRecorded = true;
    try {
      const id = run.memory.appendMessage(Object.assign(structuredClone(final), { usageEvent: run.usageEvent }));
      const native = run.memory.getEntry(id);
      if (!native) throw new Error("Side Ask SDK did not retain its terminal native message");
      this.host.append("quick_ask_outcome", { version: 1, runId: run.view.id,
        threadId: run.input.threadId, branchId: run.input.branchId, status: run.view.status,
        nativeEntries: [native], model: final.model, provider: final.provider,
        usage: normalizeSessionUsage(final.usage), usageEvent: run.usageEvent });
    } catch (error) {
      console.warn("[pi-web] Side Ask native outcome could not be saved:", quickAskErrorText(error));
    }
  }

  private async execute(run: Run): Promise<void> {
    try {
      const runtime = await this.createRuntime();
      run.runtime = runtime;
      if (run.view.status !== "running") return;
      this.assertWritable();
      const selected = run.input.model;
      if (!selected) throw new QuickAskError("Side Ask model is unavailable", 400);
      const model = runtime.getModel(selected.provider, selected.id);
      if (!model) throw new QuickAskError("Model not found for this Side Ask", 404);
      const context = await prepareQuickAskContext(run.memory.buildSessionContext().messages, (messages) => this.host.transformContext(messages));
      if (run.view.status !== "running") return;
      this.assertWritable();
      const thinking = run.input.thinkingLevel ?? run.memory.buildSessionContext().thinkingLevel;
      const reasoning = thinking && thinking !== "off" && thinking !== "auto" ? thinking as Exclude<ThinkingLevel, "off" | "auto"> : undefined;
      const maxTokens = resolveQuickAskOutputBudget(model, context, reasoning);
      const providerSessionId = createQuickAskProviderSessionId({ parentSessionId: this.host.sessionId,
        threadId: run.input.threadId, branchId: run.branch.id, provider: model.provider, model: model.id });
      run.providerLease = this.host.associateProvider?.(providerSessionId, model);
      const stream = runtime.streamSimple(model, context, {
        sessionId: providerSessionId, signal: run.controller.signal, toolChoice: "none", maxTokens,
        onPayload: (payload, requestModel) => withQuickAskCacheAffinity(payload, this.host.sessionId, providerSessionId, requestModel),
        ...(reasoning ? { reasoning } : {}),
      });
      let result: Promise<AssistantMessage>;
      try {
        result = stream.result();
        run.outcomePending = true;
      } catch (error) {
        run.resolveOutcome();
        throw error;
      }
      void result.then((final) => {
        try {
          if (run.view.status !== "running") this.persistOutcome(run, final);
        } finally {
          run.outcomePending = false;
          run.resolveOutcome();
        }
      }).catch(() => {
        run.outcomePending = false;
        run.resolveOutcome();
      });
      const iterator = stream[Symbol.asyncIterator]();
      run.closeIterator = () => {
        try { void Promise.resolve(iterator.return?.()).catch(() => undefined); }
        catch { /* Iterator teardown cannot strand the task or another topic. */ }
      };
      run.readyResolve();
      while (run.view.status === "running") {
        const next = await iterator.next();
        if (next.done || run.view.status !== "running") break;
        const event = next.value;
        if (event.type === "text_delta") this.delta(run, "chunk", event.delta);
        else if (event.type === "thinking_delta") this.delta(run, "thinking", event.delta);
        else if (event.type === "error") {
          run.final = event.error;
          throw new Error(quickAskErrorText(event.error));
        }
      }
      if (run.view.status !== "running") return;
      const final = await result;
      run.final = final;
      if (run.view.status !== "running") return;
      this.assertWritable();
      if (final.stopReason === "error" || final.stopReason === "aborted") throw new Error(final.errorMessage ?? "Side Ask did not finish");
      if (final.stopReason === "toolUse") throw new QuickAskError("Side Ask provider requested a tool despite toolChoice: none", 502);
      if (final.role !== "assistant" || !Array.isArray(final.content) || !final.api || !final.provider || !final.model) {
        throw new QuickAskError("Side Ask provider returned an invalid native assistant message");
      }
      const usageEvent = run.usageEvent;
      const message = Object.assign(structuredClone(final), { usageEvent });
      const baseline = run.memory.getEntryCount();
      run.memory.appendMessage(message);
      if (final.provider !== selected.provider || final.model !== selected.id) {
        run.memory.appendModelChange(selected.provider, selected.id);
      }
      const stored = this.host.append("quick_ask", {
        version: 2, runId: run.view.id, revision: run.view.revision + 1, threadId: run.input.threadId, threadTitle: run.input.threadTitle,
        branchId: run.input.branchId, contextAnchorId: run.branch.contextAnchorId, nativeEntries: run.memory.getEntries().slice(baseline),
        model: final.model, provider: final.provider, usage: normalizeSessionUsage(final.usage), usageEvent, createdAt: run.view.createdAt,
      });
      run.outcomeRecorded = true;
      const entry = projectSessionQuickAsks(this.host.manager.getEntries()).find((item) => item.id === stored.id);
      if (!entry) throw new Error("Committed Side Ask could not be projected");
      run.view = { ...run.view, status: "completed", answer: entry.data.answer, thinking: entry.data.thinking ?? "", entry,
        revision: run.view.revision + 1 };
      this.emit(run.view.id, { type: "done", run: this.view(run), entry });
    } catch (error) {
      run.controller.abort(error);
      run.closeIterator?.();
      if (run.view.status === "running") {
        run.view = { ...run.view, status: "failed", error: quickAskErrorText(error),
          errorStatus: error instanceof QuickAskError ? error.status : 500, revision: run.view.revision + 1 };
        if (run.final) this.persistOutcome(run, run.final);
        try { this.host.append(QUICK_ASK_RUN, runRecord(this.view(run))); }
        catch (writeError) { run.view.error += zhCNLocale.messages["sidekick.hostSaveFailurePrefix"] + quickAskErrorText(writeError); }
        this.emit(run.view.id, { type: "error", run: this.view(run), error: run.view.error ?? "Side Ask failed" });
      }
      run.readyReject(error);
    } finally {
      if (!run.outcomePending) run.resolveOutcome();
      this.finish(run);
    }
  }

  private async materialize(scope: QuickAskScope, targetId?: string): Promise<QuickAskForkResult> {
    if (!targetId) {
      const key = quickAskScopeKey(scope);
      await Promise.all([...(this.pendingOutcomes.get(key) ?? [])].map((pending) => pending));
      await this.active.get(key)?.settled;
    }
    this.assertWritable();
    let created: QuickAskForkResult;
    if (!targetId) created = materializeQuickAskTransfer(this.host.manager, scope, (type, data) => this.host.append(type, data));
    else {
      const entries = this.host.manager.getEntries();
      const branch = findQuickAskBranch(entries, scope) ?? createQuickAskBranch(entries, scope, this.host.manager.getLeafId());
      const items = quickAskItems(entries, scope);
      const index = items.findIndex((item) => item.id === targetId);
      if (index < 0) throw new QuickAskError("Quick Ask fork point was not found", 404);
      created = materializeQuickAskBranch(this.host.manager, branch, items.slice(0, index + 1), targetId);
    }
    let result: QuickAskForkResult;
    try { result = { ...created, ...await this.host.materialized?.(created) }; }
    catch (error) {
      console.warn("[pi-web] Side Ask fork metadata could not be confirmed:", quickAskErrorText(error));
      result = { ...created, subprojectAssignmentFailed: true };
    }
    if (!targetId) {
      this.host.append(QUICK_ASK_TRANSFER_PENDING, { ...scope, result });
      this.host.append(QUICK_ASK_TRANSFER, { ...scope, result });
    }
    return result;
  }
}
