/** Read-only branch previews and acknowledged runtime navigation are separate operations. */
export const BRANCH_POSITION_CHANGED = "Conversation position changed; return to the current conversation before sending";
export const BRANCH_NAVIGATION_PENDING = "Branch navigation is pending";

export function isBranchPositionError(error: unknown): boolean {
  return error instanceof Error && (error.message === BRANCH_POSITION_CHANGED || error.message === BRANCH_NAVIGATION_PENDING);
}

export type BranchPhase = "current" | "preview" | "loading" | "switching" | "unknown";
export interface BranchPosition {
  phase: BranchPhase;
  runtimeLeafId: string | null;
  viewedLeafId: string | null;
  ready: boolean;
  error: string | null;
}
export interface NavigationResult {
  cancelled: boolean;
  leafId: string | null;
  expectedLeafId?: string | null;
  metadataLeaf?: boolean;
  editorText?: string;
}

export function isNavigationResult(value: unknown): value is NavigationResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  return typeof result.cancelled === "boolean" && Object.hasOwn(result, "leafId")
    && (result.leafId === null || typeof result.leafId === "string")
    && (!Object.hasOwn(result, "expectedLeafId")
      || result.expectedLeafId === null || typeof result.expectedLeafId === "string")
    && (!Object.hasOwn(result, "metadataLeaf") || typeof result.metadataLeaf === "boolean");
}

export function canWriteBranch(state: BranchPosition): boolean {
  return state.ready && state.phase === "current" && state.viewedLeafId === state.runtimeLeafId;
}

type Load = (id: string | null, isCurrent: () => boolean) => Promise<boolean>;

/** One controller per mounted session/peer. Generations discard stale async responses. */
export class BranchNavigation {
  state: BranchPosition = { phase: "current", runtimeLeafId: null, viewedLeafId: null, ready: false, error: null };
  private scope = "";
  private generation = 0;
  private readonly changed: () => void;

  constructor(changed: () => void = () => {}) { this.changed = changed; }

  reset(scope: string, ready = false): void {
    if (scope === this.scope) return;
    this.scope = scope;
    this.generation += 1;
    this.publish({ phase: "current", runtimeLeafId: null, viewedLeafId: null, ready, error: null });
  }

  invalidate(): void {
    this.generation += 1;
    this.publish({ ...this.state, ready: false });
  }

  markUnconfirmed(error: unknown): void {
    this.generation += 1;
    this.publish({ ...this.state, phase: "unknown", error: String(error) });
  }

  private publish(next: BranchPosition): void {
    this.state = next;
    this.changed();
  }

  observeRuntime(id: string | null): void {
    if (this.state.phase === "switching" || this.state.phase === "unknown") return;
    const follows = this.state.phase === "current" || !this.state.ready;
    this.publish({
      ...this.state,
      runtimeLeafId: id,
      ...(follows ? { viewedLeafId: id, phase: "current" as const, ready: true } : {}),
    });
  }

  async preview(id: string | null, load: Load): Promise<boolean> {
    if (!this.state.ready || ["switching", "loading", "unknown"].includes(this.state.phase)) return false;
    const previous = this.state;
    const generation = ++this.generation;
    const isCurrent = () => generation === this.generation;
    this.publish({ ...previous, phase: "loading", error: null });
    try {
      const loaded = await load(id, isCurrent);
      if (!isCurrent()) return false;
      if (!loaded) throw new Error("History preview could not be loaded");
      this.publish({
        ...this.state,
        viewedLeafId: id,
        phase: id === this.state.runtimeLeafId ? "current" : "preview",
        error: null,
      });
      return true;
    } catch (error) {
      if (isCurrent()) {
        this.publish({
          ...previous,
          phase: previous.viewedLeafId === previous.runtimeLeafId ? "current" : "preview",
          error: String(error),
        });
      }
      return false;
    }
  }

  async navigate(expectedLeafId: string | null | undefined, send: () => Promise<unknown>, load: Load): Promise<NavigationResult | null> {
    if (!this.state.ready || ["switching", "loading", "unknown"].includes(this.state.phase)) return null;
    const previous = this.state;
    const generation = ++this.generation;
    const isCurrent = () => generation === this.generation;
    this.publish({ ...previous, phase: "switching", error: null });
    try {
      const result = await send();
      if (!isCurrent()) return null;
      if (!isNavigationResult(result)) throw new Error("Invalid navigation acknowledgement");
      if (result.cancelled) {
        if (result.leafId !== previous.runtimeLeafId) throw new Error("Cancelled navigation reported a different runtime leaf");
        this.publish({
          ...previous,
          phase: previous.viewedLeafId === previous.runtimeLeafId ? "current" : "preview",
          error: "Navigation cancelled",
        });
        return result;
      }
      const expected = expectedLeafId === undefined ? result.expectedLeafId : expectedLeafId;
      const acknowledgedMetadata = result.metadataLeaf === true
        && result.expectedLeafId !== undefined
        && result.expectedLeafId === expected;
      if (expected === undefined || (result.leafId !== expected && !acknowledgedMetadata)) {
        throw new Error("Navigation acknowledgement did not match the requested leaf");
      }
      if (!await load(result.leafId, isCurrent)) throw new Error("Navigation context could not be loaded");
      if (!isCurrent()) return null;
      this.publish({ phase: "current", runtimeLeafId: result.leafId, viewedLeafId: result.leafId, ready: true, error: null });
      return result;
    } catch (error) {
      if (isCurrent()) this.publish({ ...previous, phase: "unknown", error: String(error) });
      return null;
    }
  }

  async recover(read: () => Promise<{ leafId: string | null; pending: boolean }>, load: Load): Promise<boolean> {
    if (this.state.phase === "switching") return false;
    const previous = this.state;
    const generation = ++this.generation;
    const isCurrent = () => generation === this.generation;
    this.publish({ ...previous, phase: "loading", error: null });
    try {
      const result = await read();
      if (!isCurrent()) return false;
      if (result.pending || !(result.leafId === null || typeof result.leafId === "string")) throw new Error("Navigation still pending");
      if (!await load(result.leafId, isCurrent)) throw new Error("Current context could not be loaded");
      if (!isCurrent()) return false;
      this.publish({ phase: "current", runtimeLeafId: result.leafId, viewedLeafId: result.leafId, ready: true, error: null });
      return true;
    } catch (error) {
      if (isCurrent()) this.publish({ ...previous, phase: "unknown", error: String(error) });
      return false;
    }
  }
}

/** Appended metadata may follow the confirmed cursor; user/tool entries may not. */
export function matchesExpectedLeaf(manager: {
  getLeafId?: () => string | null;
  getEntry?: (id: string) => { type: string; parentId: string | null } | undefined;
} | null | undefined, expected: unknown): boolean {
  if (expected !== null && typeof expected !== "string") return false;
  if (!manager || typeof manager.getLeafId !== "function") return true;
  let id = manager.getLeafId();
  const seen = new Set<string>();
  while (id !== expected) {
    if (id === null || seen.has(id) || typeof manager.getEntry !== "function") return false;
    seen.add(id);
    const entry = manager.getEntry(id);
    if (!entry || !["custom", "session_info", "label", "model_change", "thinking_level_change"].includes(entry.type)) return false;
    id = entry.parentId;
  }
  return true;
}
