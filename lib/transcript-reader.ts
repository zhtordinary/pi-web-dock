import type { AgentMessage } from "./types";
import type { HistoryContentOptions, HistoryContentPage, HistoryIndexPage, HistoryPage, HistoryProcessRange, HistoryRequest, HistoryScope, HistorySearchMatch, HistorySearchOptions, HistorySearchPage, HistoryWindowPage } from "./session-history-types";
import { fetchSessionHistory, HistoryTransportError, type HistoryFetcher } from "./session-history-controller";
import { emptyTranscript, mergeTranscriptPage, appendPersisted, newestPersistedEntryId, type Transcript, type TranscriptMessages, type TranscriptDelivery } from "./transcript-store";
import { compareOrderKeys } from "./transcript-order";
import { getSessionViewSnapshot, setSessionViewSnapshot, type TranscriptScope } from "./session-view-cache";
import { apiPathForPeer } from "./file-api";

export interface TranscriptReaderState {
  transcript: Transcript;
  unseenEntryIds: ReadonlySet<string>;
  requestedScope: TranscriptScope | null;
  physicalScope: HistoryScope | null;
  phase: "idle" | "loading" | "ready" | "error";
  error: { message: string; retryable: boolean } | null;
  index: { pages: HistoryIndexPage[]; current: HistoryIndexPage | null };
  search: { current: HistorySearchPage | null };
  content: { page: HistoryContentPage | null };
}
export class TranscriptReader {
  private state: TranscriptReaderState;
  private listeners = new Set<() => void>();
  private generation = 0;
  private requests = new Map<string, AbortController>();
  private reads = new Map<string, Promise<unknown>>();
  private tailAfterRead: Promise<unknown> | null = null;
  private commit: (publish: () => void) => void = publish => publish();
  constructor(scope: TranscriptScope | null, private fetcher: HistoryFetcher = fetchSessionHistory) {
    this.state = { unseenEntryIds: new Set(), transcript: scope ? getSessionViewSnapshot(scope) ?? emptyTranscript() : emptyTranscript(), requestedScope: scope, physicalScope: null,
      phase: "idle", error: null, index: { pages: [], current: null }, search: { current: null }, content: { page: null } };
  }
  getState = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  setCommit(commit: (publish: () => void) => void): void { this.commit = commit; }
  private patch(patch: Partial<TranscriptReaderState>, layout = true): void {
    const publish = () => { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(); };
    if (patch.transcript && patch.transcript !== this.state.transcript && layout) this.commit(publish); else publish();
  }
  updateMessages(update: (state: TranscriptMessages) => TranscriptMessages): void {
    if (this.state.transcript.after !== null) return;
    this.patch({ transcript: { ...this.state.transcript, ...update(this.state.transcript) } });
  }
  append(message: AgentMessage, entryId = "", delivery: TranscriptDelivery = {}): void {
    this.patch({ transcript: appendPersisted(this.state.transcript, message, entryId, delivery) });
  }
  recordUnseenEntry(entryId: string): void {
    if (this.state.transcript.after === null || this.state.transcript.entryIds.includes(entryId) || this.state.unseenEntryIds.has(entryId)) return;
    this.patch({ unseenEntryIds: new Set([...this.state.unseenEntryIds, entryId]) });
  }
  /** Promotion preserves the optimistic tail; changing branches is an explicit reset. */
  setScope(scope: TranscriptScope | null, preserve = false): void {
    if (JSON.stringify(scope) === JSON.stringify(this.state.requestedScope)) return;
    const promoteDraft = preserve && this.state.requestedScope === null;
    this.cancel();
    this.patch({ requestedScope: scope, physicalScope: null, unseenEntryIds: new Set(), transcript: promoteDraft ? this.state.transcript : emptyTranscript(), index: { pages: [], current: null }, search: { current: null }, content: { page: null }, error: null }, false);
  }
  /** A persisted runtime message advances the selected branch to the file tail. */
  followPersistedTail(): boolean {
    const scope = this.state.requestedScope;
    if (!scope || scope.leafId === undefined) return false;
    this.cancel();
    this.patch({ requestedScope: { sessionId: scope.sessionId, peer: scope.peer }, physicalScope: null,
      phase: this.state.transcript.loaded ? "ready" : "idle", index: { pages: [], current: null },
      search: { current: null }, content: { page: null }, error: null }, false);
    return true;
  }
  cancel(): void { this.generation++; for (const controller of this.requests.values()) controller.abort(); this.requests.clear(); this.reads.clear(); this.tailAfterRead = null; }
  dispose(): void {
    const scope = this.state.requestedScope;
    if (scope) setSessionViewSnapshot(scope, this.state.transcript);
    this.cancel(); this.commit = publish => publish();
  }
  private async read(request: HistoryRequest, signal: AbortSignal, generation: number): Promise<HistoryPage> {
    const scope = this.state.requestedScope;
    if (!scope) throw new Error("No transcript session");
    const page = await this.fetcher(scope, request, signal);
    if (signal.aborted || generation !== this.generation) throw new DOMException("Stale transcript read", "AbortError");
    if (page.sessionId !== scope.sessionId || (scope.leafId !== undefined && page.leafId !== scope.leafId) || page.kind !== request.mode) throw new Error("History response belongs to a different scope");
    return page;
  }
  private task<T>(lane: string, operation: (signal: AbortSignal, generation: number) => Promise<T>): Promise<T | null> {
    const pending = this.reads.get(lane);
    if (pending) return pending as Promise<T | null>;
    if (!this.state.requestedScope) return Promise.resolve(null);
    const controller = new AbortController(), generation = this.generation;
    this.requests.set(lane, controller);
    if (lane === "window") this.patch({ phase: "loading", error: null });
    const promise = operation(controller.signal, generation).catch(error => {
      if (controller.signal.aborted || generation !== this.generation) return null;
      if (error instanceof HistoryTransportError && error.failure.code === "history_entry_not_on_branch") {
        // The file's branch changed; no old-scope response may write after reset.
        this.cancel();
        void this.reset();
      } else this.patch({ phase: "error", error: { message: error instanceof Error ? error.message : String(error), retryable: true } });
      return null;
    }).finally(() => {
      if (this.requests.get(lane) === controller) { this.requests.delete(lane); this.reads.delete(lane); if (lane === "window" && this.state.phase === "loading") this.patch({ phase: "ready" }); }
    });
    this.reads.set(lane, promise);
    return promise;
  }
  private async completeMessage(page: HistoryWindowPage, signal: AbortSignal, generation: number): Promise<HistoryWindowPage> {
    const items = [];
    for (const item of page.items) {
      if (!item.deferred.length) { items.push(item); continue; }
      const surface = item.deferred[0].surface ?? "message";
      let offset = 0, total: number | undefined;
      const parts: string[] = [];
      for (;;) {
        const part = await this.read({ mode: "content", entryId: item.entryId, surface, path: "", offset }, signal, generation) as HistoryContentPage;
        if (part.entryId !== item.entryId || part.surface !== surface || part.path !== "" || part.format !== "json" || part.offset !== offset || (total !== undefined && part.totalChars !== total)) throw new Error("Incomplete history message");
        total = part.totalChars; parts.push(part.text);
        const end = offset + part.text.length;
        if (part.nextOffset === null) { if (end !== total) throw new Error("Incomplete history message"); break; }
        if (part.nextOffset !== end || end <= offset) throw new Error("Invalid history continuation");
        offset = end;
      }
      let message: AgentMessage;
      try { message = JSON.parse(parts.join("")) as AgentMessage; }
      catch { throw new Error("Malformed history message"); }
      if (!message || typeof message !== "object" || typeof message.role !== "string" || message.role !== item.role) throw new Error("Malformed history message");
      if ("content" in message && Array.isArray(message.content)) for (const block of message.content) {
        if (block.type === "image" && block.source.type === "url" && typeof block.source.url === "string" && block.source.url.startsWith("/api/sessions/")) block.source.url = apiPathForPeer(this.state.requestedScope?.peer ?? undefined, block.source.url.slice(5));
      }
      items.push({ ...item, message, deferred: [] });
    }
    return { ...page, items };
  }
  private async window(request: HistoryRequest, operation: "reset" | "prepend" | "append" | "expand" | "reconcile", signal: AbortSignal, generation: number): Promise<HistoryWindowPage> {
    const initialIds = new Set(this.state.transcript.entryIds.filter(Boolean));
    const page = await this.completeMessage(await this.read(request, signal, generation) as HistoryWindowPage, signal, generation);
    if (signal.aborted || generation !== this.generation) throw new DOMException("Stale transcript read", "AbortError");
    let transcript: Transcript;
    if (operation === "reset" && request.mode === "window" && !request.around && !page.after) {
      // A latest snapshot may predate optimistic/SSE deliveries accepted while
      // it was in flight; seed only that pending tail, never the old interval.
      const current = this.state.transcript;
      const pending = current.entryIds.map((id, index) => ({ id, index })).filter(({ id }) => !id || !initialIds.has(id));
      transcript = mergeTranscriptPage({ ...emptyTranscript(), messages: pending.map(({ index }) => current.messages[index]), entryIds: pending.map(({ id }) => id),
        items: new Map(pending.flatMap(({ id }) => { const item = current.items.get(id); return item ? [[id, item] as const] : []; })) }, page, "append");
    } else transcript = mergeTranscriptPage(this.state.transcript, page, operation);
    this.patch({ transcript,
      ...((operation === "reset" || operation === "append") && !page.after ? { unseenEntryIds: new Set<string>() } : {}), physicalScope: { sessionId: page.sessionId, leafId: page.leafId, revision: page.revision } });
    return page;
  }
  reset(around?: string): Promise<HistoryWindowPage | null> {
    this.cancel();
    return this.task("window", (signal, generation) => this.window({ mode: "window", ...(around ? { around } : {}) }, "reset", signal, generation));
  }
  previousPage = () => this.state.transcript.before ? this.task("window", (signal, generation) => this.window({ mode: "window", before: this.state.transcript.before! }, "prepend", signal, generation)) : Promise.resolve(null);
  nextPage = () => this.state.transcript.after ? this.task("window", (signal, generation) => this.window({ mode: "window", after: this.state.transcript.after! }, "append", signal, generation)) : Promise.resolve(null);
  reconcileTail = (options: { reconcileLoaded?: boolean } = {}): Promise<unknown> => {
    if (options.reconcileLoaded) return this.reconcileLoadedWindow();
    if (this.state.transcript.after !== null) return Promise.resolve(null);
    const pending = this.reads.get("window");
    if (pending) {
      if (this.tailAfterRead) return this.tailAfterRead;
      const generation = this.generation;
      const next = pending.then(() => {
        if (this.tailAfterRead === next) this.tailAfterRead = null;
        return generation === this.generation ? this.reconcileTail() : null;
      });
      this.tailAfterRead = next;
      return next;
    }
    const initial = this.state.transcript;
    const generation = this.generation;
    const newNodes = new Set<string>();
    return this.task("window", async (signal, owner) => {
      let cursor = newestPersistedEntryId(this.state.transcript);
      for (;;) {
        const page = await this.window({ mode: "window", ...(cursor ? { after: cursor } : {}) }, "append", signal, owner);
        for (const item of page.items) if (!initial.items.has(item.entryId) && (item.turnAnchor?.entryId === item.entryId
          || item.sourceType === "compaction" || item.sourceType === "branch_summary")) newNodes.add(item.entryId);
        if (!page.after) return page;
        if (page.after === cursor) throw new Error("History cursor did not advance");
        cursor = page.after;
      }
    }).then(page => {
      // A compaction/control node can be physically appended but displayed
      // before the tail cursor. Structural growth exposes that missed insert.
      if (page && initial.loaded && generation === this.generation && page.nodeCount > initial.nodeCount + newNodes.size) return this.reconcileLoadedWindow();
      return page;
    });
  };
  private async reconcileLoadedWindow(): Promise<unknown> {
    const generation = this.generation;
    await this.reads.get("window");
    if (generation !== this.generation) return null;
    const current = this.state.transcript;
    const boundaries = [...current.items.values()].sort((a, b) => compareOrderKeys(a.orderKey, b.orderKey))
      .map(item => ({ id: item.entryId, orderKey: item.orderKey, turn: item.turnAnchor?.entryId }));
    const first = boundaries[0], last = boundaries.at(-1);
    if (!first || !last) return this.reconcileTail();
    const wasLive = current.after === null;
    return this.task("window", async (signal, owner) => {
      let after: string | undefined;
      const floor = first.orderKey;
      let page: HistoryWindowPage;
      for (;;) {
        page = await this.completeMessage(await this.read({ mode: "window", turns: 1, ...(after ? { after } : { around: first.id }) }, signal, owner) as HistoryWindowPage, signal, owner);
        if (signal.aborted || owner !== this.generation) return null;
        const bounded = { ...page, items: page.items.filter(item => compareOrderKeys(item.orderKey, floor) >= 0) };
        this.patch({ transcript: mergeTranscriptPage(this.state.transcript, bounded, "reconcile") });
        const reached = page.items.some(item => item.entryId === last.id || (last.turn && item.turnAnchor?.entryId === last.turn));
        if (reached || !page.after) break;
        if (page.after === after) throw new Error("History cursor did not advance");
        after = page.after;
      }
      this.patch({ transcript: { ...this.state.transcript, after: page.after } });
      while (wasLive && page.after) {
        const cursor = page.after;
        page = await this.window({ mode: "window", after: cursor }, "append", signal, owner);
        if (page.after === cursor) throw new Error("History cursor did not advance");
      }
      return page;
    });
  }
  expandProcess = (summary: HistoryProcessRange): Promise<unknown> => this.task(`process:${summary.firstEntryId}`, async (signal, generation) => {
    if (this.state.phase === "error") this.patch({ phase: "ready", error: null });
    const ids = this.state.transcript.entryIds;
    const first = ids.indexOf(summary.firstEntryId), last = ids.indexOf(summary.lastEntryId);
    const expected = first >= 0 && last >= first ? ids.slice(first, last + 1) : [summary.firstEntryId, summary.lastEntryId];
    let after: string | undefined;
    for (;;) {
      const page = await this.window({ mode: "window", from: summary.firstEntryId, to: summary.lastEntryId, ...(after ? { after } : {}) }, "expand", signal, generation);
      if (!page.after) break;
      if (page.after === after) throw new Error("Process cursor did not advance");
      after = page.after;
    }
    if (expected.some(id => this.state.transcript.items.get(id)?.contentState !== "full")) {
      throw new Error("Process content was not fully loaded");
    }
  });
  goToEntry = async (entryId: string): Promise<void> => {
    const pending = !this.state.transcript.entryIds.includes(entryId) ? this.reset(entryId) : null;
    const generation = this.generation;
    await pending;
    if (generation !== this.generation) return;
    if (this.state.transcript.items.get(entryId)?.contentState === "placeholder") await this.expandProcess({ firstEntryId: entryId, lastEntryId: entryId });
  };
  loadIndex = (options: { offset?: number; cursor?: string } = {}): Promise<HistoryIndexPage | null> => {
    this.requests.get("index")?.abort(); this.reads.delete("index");
    return this.task("index", async (signal, generation) => {
    const previous = this.state.index.current;
    let page: HistoryIndexPage;
    try { page = await this.read({ mode: "index", ...options, ...(options.cursor && previous ? { revision: previous.revision } : {}) }, signal, generation) as HistoryIndexPage; }
    catch (error) { if (!(error instanceof HistoryTransportError) || error.failure.status !== 409) throw error; page = await this.read({ mode: "index", offset: options.offset ?? 0 }, signal, generation) as HistoryIndexPage; }
    const pages = this.state.index.pages.filter(old => old.offset !== page.offset);
    this.patch({ index: { pages: [...pages, page], current: page } }); return page;
    });
  };
  loadFullIndex = (): Promise<HistoryIndexPage | null> => this.task("index-all", async (signal, generation) => {
    let offset = 0;
    let restarted = false;
    let pages: HistoryIndexPage[] = [];
    for (;;) {
      const page = await this.read({ mode: "index", offset }, signal, generation) as HistoryIndexPage;
      const previous = pages.at(-1)?.nodes.at(-1);
      const first = page.nodes[0];
      if (previous && first && compareOrderKeys(first.orderKey, previous.orderKey) <= 0) {
        if (restarted) return null;
        restarted = true; pages = []; offset = 0; continue;
      }
      pages.push(page);
      if (!page.after) { this.patch({ index: { pages, current: page } }); return page; }
      const next = page.offset + page.nodes.length;
      if (next <= offset) throw new Error("History index did not advance");
      offset = next;
    }
  });
  goToNodeIndex = async (index: number) => { const generation = this.generation; const page = await this.loadIndex({ offset: index }); if (generation !== this.generation) return; const node = page?.nodes.find(node => node.nodeIndex === index); if (node) await this.goToEntry(node.entryId); };
  searchHistory = (options: HistorySearchOptions): Promise<HistorySearchPage | null> => {
    this.requests.get("search")?.abort(); this.reads.delete("search");
    return this.task("search", async (signal, generation) => {
      let page: HistorySearchPage;
      try { page = await this.read({ mode: "search", ...options, ...(options.cursor ? { revision: this.state.search.current?.revision } : {}) }, signal, generation) as HistorySearchPage; }
      catch (error) { if (!(error instanceof HistoryTransportError) || error.failure.status !== 409) throw error; page = await this.read({ mode: "search", q: options.q }, signal, generation) as HistorySearchPage; }
      this.patch({ search: { current: page } }); return page;
    });
  };
  previousSearchPage = () => { const page = this.state.search.current; return page?.before ? this.searchHistory({ q: page.query, cursor: page.before }) : Promise.resolve(null); };
  nextSearchPage = () => { const page = this.state.search.current; return page?.after ? this.searchHistory({ q: page.query, cursor: page.after }) : Promise.resolve(null); };
  loadContent = (options: HistoryContentOptions): Promise<HistoryContentPage | null> => this.task("content", async (signal, generation) => { const page = await this.read({ mode: "content", ...options }, signal, generation) as HistoryContentPage; this.patch({ content: { page } }); return page; });
  locateSearchMatch = async (match: HistorySearchMatch) => { const pending = this.goToEntry(match.entryId); const generation = this.generation; await pending; if (generation !== this.generation) return null; return this.loadContent({ entryId: match.entryId, surface: "visible", blockIndex: match.blockIndex, offset: match.offset }); };
  retry = () => Promise.all([this.state.transcript.after !== null ? this.nextPage() : this.reconcileTail(), this.loadFullIndex()]);
}
