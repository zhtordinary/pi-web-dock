import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { localDeviceId } from "./activity-peers.ts";
import { dirname, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { writePrivateFileAtomicSync } from "./atomic-file.ts";
import {
  TALK_MAP_SCHEMA_VERSION,
  defaultTalkMapCamera,
  defaultTalkMapLayout,
  type TalkMapBoard,
  type TalkMapCamera,
  type TalkMapCardState,
  type TalkMapDigestState,
  type TalkMapEdge,
  type TalkMapFrame,
  type TalkMapGhostCardState,
  type TalkMapLayoutState,
  type TalkMapMutation,
  type TalkMapRelationQuery,
} from "./talk-map-types.ts";

const MAX_COORDINATE = 1_000_000;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2.5;
const TALK_MAP_DIR = process.env.PI_WEB_TALK_MAP_DIR
  ?? join(process.env.XDG_DATA_HOME || join(process.env.HOME ?? ".", ".local", "share"), "pi-web-reader", "talk-map");

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function finiteNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) ? clamp(value, min, max) : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeCamera(value: unknown): TalkMapCamera {
  const camera = isRecord(value) ? value : {};
  return {
    x: finiteNumber(camera.x, 0, -MAX_COORDINATE, MAX_COORDINATE),
    y: finiteNumber(camera.y, 0, -MAX_COORDINATE, MAX_COORDINATE),
    zoom: finiteNumber(camera.zoom, 1, MIN_ZOOM, MAX_ZOOM),
  };
}

function normalizeTalkMapLayout(value: unknown): TalkMapLayoutState {
  const layout = isRecord(value) ? value : {};
  // 合法持久化模式原样保留（老 board 的 free 不被改写），仅缺失/非法时才回退到共享默认。
  const mode: TalkMapLayoutState["mode"] = layout.mode === "subprojects" || layout.mode === "free"
    ? layout.mode
    : defaultTalkMapLayout().mode;
  const sort = layout.sort === "status" || layout.sort === "asked" || layout.sort === "manual" ? layout.sort : "manual";
  const manualOrder = Array.isArray(layout.manualOrder)
    ? layout.manualOrder.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    : [];
  return { mode, sort, manualOrder: [...new Set(manualOrder)] };
}

function normalizeCard(value: unknown): TalkMapCardState | null {
  if (!isRecord(value)) return null;
  const x = finiteNumber(value.x, NaN, -MAX_COORDINATE, MAX_COORDINATE);
  const y = finiteNumber(value.y, NaN, -MAX_COORDINATE, MAX_COORDINATE);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    x,
    y,
    ...(value.hidden === true ? { hidden: true } : {}),
  };
}

function normalizeGhost(value: unknown): TalkMapGhostCardState | null {
  if (!isRecord(value) || typeof value.label !== "string") return null;
  const label = value.label.trim();
  const x = finiteNumber(value.x, NaN, -MAX_COORDINATE, MAX_COORDINATE);
  const y = finiteNumber(value.y, NaN, -MAX_COORDINATE, MAX_COORDINATE);
  if (!label || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    label,
    ...(typeof value.body === "string" && value.body.trim() ? { body: value.body.trim() } : {}),
    x,
    y,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString(),
  };
}

function normalizeDigest(value: unknown): TalkMapDigestState | null {
  if (!isRecord(value) || value.source !== "session-recap") return null;
  const status = value.status === "derived" || value.status === "unavailable" ? value.status : null;
  if (!status) return null;
  return {
    source: "session-recap",
    status,
    ...(typeof value.updatedAt === "string" ? { updatedAt: value.updatedAt } : {}),
  };
}

function normalizeEdge(value: unknown): TalkMapEdge | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || !value.id || typeof value.source !== "string" || typeof value.target !== "string") return null;
  const source = value.source.trim();
  const target = value.target.trim();
  if (!source || !target || source === target) return null;
  if (value.type !== "related" && value.type !== "lineage") return null;
  return {
    id: value.id,
    source,
    target,
    type: value.type,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString(),
  };
}

function normalizeFrame(value: unknown): TalkMapFrame | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || !value.id || typeof value.label !== "string" || value.kind !== "worktree") return null;
  const x = finiteNumber(value.x, NaN, -MAX_COORDINATE, MAX_COORDINATE);
  const y = finiteNumber(value.y, NaN, -MAX_COORDINATE, MAX_COORDINATE);
  const width = finiteNumber(value.width, NaN, 160, MAX_COORDINATE);
  const height = finiteNumber(value.height, NaN, 120, MAX_COORDINATE);
  if (![x, y, width, height].every(Number.isFinite)) return null;
  return { id: value.id, label: value.label, kind: "worktree", x, y, width, height };
}

export function normalizeTalkMapProjectRoot(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("projectRoot is required");
  const root = value.trim();
  if (!root.startsWith("/")) throw new Error("projectRoot must be absolute");
  return resolve(root);
}

export function talkMapBoardKey(projectRoot: string): string {
  const normalized = normalizeTalkMapProjectRoot(projectRoot);
  return `board:${createHash("sha256").update(normalized).digest("hex").slice(0, 24)}`;
}

export function createEmptyTalkMap(projectRoot: string): TalkMapBoard {
  const normalizedRoot = normalizeTalkMapProjectRoot(projectRoot);
  return {
    schemaVersion: TALK_MAP_SCHEMA_VERSION,
    boardKey: talkMapBoardKey(normalizedRoot),
    projectRoot: normalizedRoot,
    deviceId: localDeviceId(),
    revision: 0,
    updatedAt: new Date(0).toISOString(),
    camera: defaultTalkMapCamera(),
    layout: defaultTalkMapLayout(),
    cards: {},
    ghosts: {},
    digests: {},
    edges: [],
    frames: [],
  };
}

/** Parse persisted state without ever trusting its board identity or coordinates. */
export function normalizeTalkMapDocument(value: unknown, projectRoot: string): TalkMapBoard {
  const empty = createEmptyTalkMap(projectRoot);
  if (!isRecord(value) || value.schemaVersion !== TALK_MAP_SCHEMA_VERSION) return empty;
  if (value.projectRoot !== empty.projectRoot || value.boardKey !== empty.boardKey) return empty;

  const cards: Record<string, TalkMapCardState> = {};
  if (isRecord(value.cards)) {
    for (const [sessionId, candidate] of Object.entries(value.cards)) {
      if (!sessionId) continue;
      const card = normalizeCard(candidate);
      if (card) cards[sessionId] = card;
    }
  }
  const ghosts: Record<string, TalkMapGhostCardState> = {};
  if (isRecord(value.ghosts)) {
    for (const [ghostId, candidate] of Object.entries(value.ghosts)) {
      if (!ghostId) continue;
      const ghost = normalizeGhost(candidate);
      if (ghost) ghosts[ghostId] = ghost;
    }
  }
  const digests: Record<string, TalkMapDigestState> = {};
  if (isRecord(value.digests)) {
    for (const [sessionId, candidate] of Object.entries(value.digests)) {
      const digest = normalizeDigest(candidate);
      if (digest) digests[sessionId] = digest;
    }
  }
  const edges = Array.isArray(value.edges)
    ? value.edges.map(normalizeEdge).filter((edge): edge is TalkMapEdge => Boolean(edge))
    : [];
  const frames = Array.isArray(value.frames)
    ? value.frames.map(normalizeFrame).filter((frame): frame is TalkMapFrame => Boolean(frame))
    : [];
  const revision = typeof value.revision === "number" && Number.isInteger(value.revision) && value.revision >= 0
    ? value.revision
    : 0;

  return {
    ...empty,
    deviceId: typeof value.deviceId === "string" && value.deviceId ? value.deviceId : empty.deviceId,
    revision,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : empty.updatedAt,
    camera: normalizeCamera(value.camera),
    layout: normalizeTalkMapLayout(value.layout),
    cards,
    ghosts,
    digests,
    edges,
    frames,
  };
}

function boardFile(projectRoot: string): string {
  return join(TALK_MAP_DIR, `${talkMapBoardKey(projectRoot).slice("board:".length)}.json`);
}

function ensureBoardFile(projectRoot: string): string {
  const path = boardFile(projectRoot);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!existsSync(path)) writePrivateFileAtomicSync(path, `${JSON.stringify(createEmptyTalkMap(projectRoot), null, 2)}\n`);
  return path;
}

function readStoredBoard(projectRoot: string, path = boardFile(projectRoot)): TalkMapBoard {
  try {
    return normalizeTalkMapDocument(JSON.parse(readFileSync(path, "utf8")), projectRoot);
  } catch {
    return createEmptyTalkMap(projectRoot);
  }
}

export function readTalkMap(projectRoot: string): TalkMapBoard {
  const normalizedRoot = normalizeTalkMapProjectRoot(projectRoot);
  return readStoredBoard(normalizedRoot);
}

export function queryTalkMapRelations(board: TalkMapBoard, query: TalkMapRelationQuery = {}): TalkMapEdge[] {
  const sessionId = query.sessionId?.trim();
  return board.edges.filter((edge) => (
    (!query.type || edge.type === query.type)
    && (!sessionId || edge.source === sessionId || edge.target === sessionId)
  ));
}

export function applyTalkMapMutation(board: TalkMapBoard, mutation: TalkMapMutation): TalkMapBoard {
  if (mutation.op === "set-layout") {
    return { ...board, layout: normalizeTalkMapLayout(mutation.layout) };
  }

  if (mutation.op === "upsert-card") {
    if (!mutation.sessionId.trim()) throw new Error("sessionId is required");
    const x = finiteNumber(mutation.x, NaN, -MAX_COORDINATE, MAX_COORDINATE);
    const y = finiteNumber(mutation.y, NaN, -MAX_COORDINATE, MAX_COORDINATE);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("card position must be finite");
    return {
      ...board,
      cards: { ...board.cards, [mutation.sessionId]: { ...(board.cards[mutation.sessionId] ?? {}), x, y } },
    };
  }

  if (mutation.op === "append-session") {
    const sessionId = mutation.sessionId.trim();
    if (!sessionId) throw new Error("sessionId is required");
    return {
      ...board,
      layout: {
        ...board.layout,
        manualOrder: [...board.layout.manualOrder.filter((id) => id !== sessionId), sessionId],
      },
    };
  }

  if (mutation.op === "upsert-edge") {
    const source = mutation.source.trim();
    const target = mutation.target.trim();
    if (!source || !target) throw new Error("edge endpoints are required");
    if (source === target) throw new Error("edge endpoints must differ");
    const duplicate = board.edges.some((edge) => edge.type === "related"
      && ((edge.source === source && edge.target === target) || (edge.source === target && edge.target === source)));
    if (duplicate) return board;
    return {
      ...board,
      edges: [...board.edges, {
        id: newTalkMapEdgeId(),
        source,
        target,
        type: "related",
        createdAt: new Date().toISOString(),
      }],
    };
  }

  if (mutation.op === "delete-edge") {
    const edgeId = mutation.edgeId.trim();
    if (!edgeId) throw new Error("edgeId is required");
    return { ...board, edges: board.edges.filter((edge) => edge.id !== edgeId) };
  }

  if (mutation.op === "upsert-frame") {
    const frame = normalizeFrame(mutation.frame);
    if (!frame) throw new Error("frame is invalid");
    const frames = board.frames.some((candidate) => candidate.id === frame.id)
      ? board.frames.map((candidate) => candidate.id === frame.id ? frame : candidate)
      : [...board.frames, frame];
    return { ...board, frames };
  }

  if (mutation.op === "delete-frame") {
    const frameId = mutation.frameId.trim();
    if (!frameId) throw new Error("frameId is required");
    return { ...board, frames: board.frames.filter((frame) => frame.id !== frameId) };
  }

  if (mutation.op === "upsert-ghost") {
    const ghost = normalizeGhost(mutation.ghost);
    if (!ghost) throw new Error("ghost card is invalid");
    const ghostId = mutation.ghostId?.trim() || newTalkMapGhostId();
    return { ...board, ghosts: { ...board.ghosts, [ghostId]: ghost } };
  }

  if (mutation.op === "delete-ghost") {
    const ghostId = mutation.ghostId.trim();
    if (!ghostId) throw new Error("ghostId is required");
    const ghosts = { ...board.ghosts };
    delete ghosts[ghostId];
    return { ...board, ghosts };
  }

  if (mutation.op === "set-camera") {
    return { ...board, camera: normalizeCamera(mutation.camera) };
  }

  if (mutation.op === "reset-view") {
    const cards = { ...board.cards };
    for (const [sessionId, position] of Object.entries(mutation.cards)) {
      if (!sessionId.trim() || !isRecord(position)) throw new Error("reset card position is invalid");
      const x = finiteNumber(position.x, NaN, -MAX_COORDINATE, MAX_COORDINATE);
      const y = finiteNumber(position.y, NaN, -MAX_COORDINATE, MAX_COORDINATE);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("reset card position must be finite");
      cards[sessionId] = { ...(cards[sessionId] ?? {}), x, y };
    }
    return { ...board, camera: normalizeCamera(mutation.camera), cards };
  }

  throw new Error("unsupported Talk Map mutation");
}

export async function mutateTalkMap(projectRoot: string, mutation: TalkMapMutation): Promise<TalkMapBoard> {
  const normalizedRoot = normalizeTalkMapProjectRoot(projectRoot);
  const path = ensureBoardFile(normalizedRoot);
  const release = await lockfile.lock(path, {
    stale: 30_000,
    retries: { retries: 8, factor: 2, minTimeout: 50, maxTimeout: 1_000, randomize: true },
  });
  try {
    const current = readStoredBoard(normalizedRoot, path);
    const next = applyTalkMapMutation(current, mutation);
    const saved = {
      ...next,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    writePrivateFileAtomicSync(path, `${JSON.stringify(saved, null, 2)}\n`);
    return saved;
  } finally {
    try { await release(); } catch { /* preserve mutation result */ }
  }
}

/** Reserved for future map-edge actions; keeps ID generation out of the UI. */
export function newTalkMapEdgeId(): string {
  return `edge-${randomUUID()}`;
}

export function newTalkMapGhostId(): string {
  return `ghost-${randomUUID()}`;
}
