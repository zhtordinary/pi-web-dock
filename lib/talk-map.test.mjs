import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createSealedPublicInputEnvironment } from "../test-support/sealed-public-inputs.mjs";
import {
  applyTalkMapMutation,
  createEmptyTalkMap,
  normalizeTalkMapDocument,
  normalizeTalkMapProjectRoot,
  queryTalkMapRelations,
  talkMapBoardKey,
} from "./talk-map.ts";
import { buildTalkMapInjectPrompt, buildTalkMapSourceInfo, defaultTalkMapPosition } from "./talk-map-types.ts";

const projectRoot = join(tmpdir(), "pi-reader-talk-map-project");
const otherRoot = join(tmpdir(), "pi-reader-talk-map-other");

test("board key is stable for same absolute project root and isolates roots", () => {
  assert.equal(talkMapBoardKey(projectRoot), talkMapBoardKey(`${projectRoot}${sep}`));
  assert.notEqual(talkMapBoardKey(projectRoot), talkMapBoardKey(otherRoot));
});

test("requires a fully qualified native project root", () => {
  assert.equal(normalizeTalkMapProjectRoot(projectRoot), resolve(projectRoot));
  assert.throws(() => normalizeTalkMapProjectRoot("relative/project"), /projectRoot must be absolute/);
  if (process.platform === "win32") {
    const unc = String.raw`\\server\share\project`;
    assert.equal(createEmptyTalkMap(unc).projectRoot, resolve(unc));
    for (const ambiguous of [String.raw`C:project`, String.raw`\project`, String.raw`\\server`, String.raw`\\?\C:\project`, String.raw`\\.\COM1`]) {
      assert.throws(() => normalizeTalkMapProjectRoot(ambiguous), /projectRoot must be absolute/);
    }
  }
});

test("fully qualified roots persist separate boards", async (t) => {
  const sealed = await createSealedPublicInputEnvironment("talk-map");
  const previousDir = process.env.PI_WEB_TALK_MAP_DIR;
  const previousActivity = process.env.PI_WEB_SESSION_ACTIVITY_CONFIG;
  t.after(async () => {
    if (previousDir === undefined) delete process.env.PI_WEB_TALK_MAP_DIR; else process.env.PI_WEB_TALK_MAP_DIR = previousDir;
    if (previousActivity === undefined) delete process.env.PI_WEB_SESSION_ACTIVITY_CONFIG; else process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = previousActivity;
    await sealed.restore();
  });
  process.env.PI_WEB_TALK_MAP_DIR = join(sealed.root, "boards");
  process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = JSON.stringify({ device: { id: "synthetic" } });
  const { mutateTalkMap, readTalkMap } = await import(`./talk-map.ts?fixture=${Date.now()}`);
  const saved = await mutateTalkMap(projectRoot, { op: "upsert-card", sessionId: "fixture", x: 12, y: 34 });
  assert.deepEqual(readTalkMap(projectRoot).cards, saved.cards);
  assert.deepEqual(readTalkMap(otherRoot).cards, {});
});

test("invalid persisted state falls back without leaking another board", () => {
  const board = createEmptyTalkMap(projectRoot);
  const other = normalizeTalkMapDocument({ ...board, projectRoot: otherRoot }, projectRoot);
  assert.equal(other.projectRoot, projectRoot);
  assert.deepEqual(other.cards, {});
  assert.deepEqual(other.camera, { x: 0, y: 0, zoom: 1 });
});

test("normalizes coordinates and rejects malformed cards", () => {
  const board = normalizeTalkMapDocument({
    schemaVersion: 1,
    projectRoot,
    boardKey: talkMapBoardKey(projectRoot),
    cards: {
      good: { x: 12, y: -4 },
      bad: { x: "nope", y: 2 },
    },
    camera: { x: 4, y: 5, zoom: 99 },
  }, projectRoot);
  assert.deepEqual(board.cards, { good: { x: 12, y: -4 } });
  assert.equal(board.camera.zoom, 2.5);
});

test("default card layout is deterministic", () => {
  assert.deepEqual(defaultTalkMapPosition(0), { x: 64, y: 64 });
  assert.deepEqual(defaultTalkMapPosition(3), { x: 64, y: 288 });
});

test("source session info keeps the five-line reference block shared by copy and injection", () => {
  const input = { sourceDevice: "Mac mini", sourceSessionId: "01a1002a-afc9-739b-a361-58ed9a86a9fe", sourceTitle: "评估并升级会话控制插件", sourcePath: "/private/session.jsonl", sourceProject: "/private/project" };
  const expected = [
    "来源设备：Mac mini",
    "来源 Session ID：01a1002a-afc9-739b-a361-58ed9a86a9fe",
    "来源会话文件（仅供定位）：/private/session.jsonl",
    "来源会话标题：评估并升级会话控制插件",
    "来源项目：/private/project",
  ].join("\n");
  assert.equal(buildTalkMapSourceInfo(input), expected);
  assert.equal(buildTalkMapInjectPrompt(input), `请基于来源会话继续处理。\n\n${expected}\n\n本次具体要求：`);
});

test("source session info normalizes line breaks and missing labels", () => {
  assert.equal(buildTalkMapSourceInfo({ sourceDevice: " Mac\nmini ", sourceSessionId: " id\r\n1 ", sourceTitle: " Topic\nname ", sourcePath: " /private\nsession.jsonl ", sourceProject: " /private\nproject " }), [
    "来源设备：Mac mini",
    "来源 Session ID：id 1",
    "来源会话文件（仅供定位）：/private session.jsonl",
    "来源会话标题：Topic name",
    "来源项目：/private project",
  ].join("\n"));
  assert.equal(buildTalkMapSourceInfo({ sourceDevice: "", sourceSessionId: "", sourceTitle: "", sourcePath: "", sourceProject: "" }), [
    "来源设备：本机",
    "来源 Session ID：未知",
    "来源会话文件（仅供定位）：（路径不可用）",
    "来源会话标题：未命名会话",
    "来源项目：（路径不可用）",
  ].join("\n"));
});

test("related edges are added idempotently and can be removed", () => {
  const board = createEmptyTalkMap(projectRoot);
  const withEdge = applyTalkMapMutation(board, { op: "upsert-edge", source: "a", target: "b", type: "related" });
  assert.equal(withEdge.edges.length, 1);
  assert.match(withEdge.edges[0].id, /^edge-/);
  assert.deepEqual(withEdge.edges[0].source, "a");
  const duplicate = applyTalkMapMutation(withEdge, { op: "upsert-edge", source: "b", target: "a", type: "related" });
  assert.equal(duplicate.edges.length, 1);
  const removed = applyTalkMapMutation(duplicate, { op: "delete-edge", edgeId: withEdge.edges[0].id });
  assert.deepEqual(removed.edges, []);
  assert.throws(() => applyTalkMapMutation(board, { op: "upsert-edge", source: "a", target: "a", type: "related" }), /must differ/);
});

test("worktree frames round-trip through board mutations", () => {
  const board = createEmptyTalkMap(projectRoot);
  const frame = { id: "worktree:feature/x", label: "feature/x", kind: "worktree", x: 10, y: 20, width: 360, height: 250 };
  const saved = applyTalkMapMutation(board, { op: "upsert-frame", frame });
  assert.deepEqual(saved.frames, [frame]);
  const moved = applyTalkMapMutation(saved, { op: "upsert-frame", frame: { ...frame, x: 30 } });
  assert.equal(moved.frames[0].x, 30);
  const removed = applyTalkMapMutation(moved, { op: "delete-frame", frameId: frame.id });
  assert.deepEqual(removed.frames, []);
});


test("ghost cards are created, updated, and removed without session data", () => {
  const board = createEmptyTalkMap(projectRoot);
  const ghost = { label: "Plan API migration", body: "Create endpoint and tests", x: 20, y: 30, createdAt: "2026-08-25T00:00:00.000Z" };
  const created = applyTalkMapMutation(board, { op: "upsert-ghost", ghostId: "ghost-1", ghost });
  assert.deepEqual(created.ghosts["ghost-1"], ghost);
  const moved = applyTalkMapMutation(created, { op: "upsert-ghost", ghostId: "ghost-1", ghost: { ...ghost, x: 90 } });
  assert.equal(moved.ghosts["ghost-1"].x, 90);
  const removed = applyTalkMapMutation(moved, { op: "delete-ghost", ghostId: "ghost-1" });
  assert.deepEqual(removed.ghosts, {});
});


test("relation query filters by session and type", () => {
  const board = createEmptyTalkMap(projectRoot);
  const related = applyTalkMapMutation(board, { op: "upsert-edge", source: "a", target: "b", type: "related" });
  const lineage = { ...related, edges: [...related.edges, { id: "edge-lineage", source: "b", target: "c", type: "lineage", createdAt: "2026-08-25T00:00:00.000Z" }] };
  assert.equal(queryTalkMapRelations(lineage).length, 2);
  assert.equal(queryTalkMapRelations(lineage, { sessionId: "b" }).length, 2);
  assert.equal(queryTalkMapRelations(lineage, { type: "related" }).length, 1);
  assert.equal(queryTalkMapRelations(lineage, { sessionId: "c", type: "related" }).length, 0);
});

test("layout state is additive and normalized", () => {
  const board = createEmptyTalkMap(projectRoot);
  assert.deepEqual(board.layout, { mode: "subprojects", sort: "manual", manualOrder: [] });
  const saved = applyTalkMapMutation(board, {
    op: "set-layout",
    layout: { mode: "subprojects", sort: "status", manualOrder: ["a", "a", "", "b"] },
  });
  assert.deepEqual(saved.layout, { mode: "subprojects", sort: "status", manualOrder: ["a", "b"] });
  const { layout: _ignored, ...legacy } = board;
  assert.deepEqual(normalizeTalkMapDocument(legacy, projectRoot).layout, { mode: "subprojects", sort: "manual", manualOrder: [] });
});

test("converted sessions append to the map manual order atomically", () => {
  const board = {
    ...createEmptyTalkMap(projectRoot),
    layout: { mode: "subprojects", sort: "manual", manualOrder: ["first", "second"] },
  };
  const appended = applyTalkMapMutation(board, { op: "append-session", sessionId: "new-session" });
  assert.deepEqual(appended.layout.manualOrder, ["first", "second", "new-session"]);
  const movedToEnd = applyTalkMapMutation(appended, { op: "append-session", sessionId: "first" });
  assert.deepEqual(movedToEnd.layout.manualOrder, ["second", "new-session", "first"]);
  assert.throws(() => applyTalkMapMutation(board, { op: "append-session", sessionId: "  " }), /sessionId is required/);
});
