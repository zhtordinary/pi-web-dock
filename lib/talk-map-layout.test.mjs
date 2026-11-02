import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTalkMapSubprojectLayout,
  filterTalkMapSessions,
  reorderTalkMapSessionOrder,
  talkMapSubprojectContentYForClient,
  talkMapSubprojectDropIndex,
  talkMapSubprojectPointInRect,
  TALK_MAP_SUBPROJECT_CARD_GAP,
  TALK_MAP_SUBPROJECT_FRAME_HEIGHT,
  TALK_MAP_SUBPROJECT_HEADER_HEIGHT,
  TALK_MAP_SUBPROJECT_STAGE_PADDING,
  TALK_MAP_SUBPROJECT_VERTICAL_PADDING,
} from "./talk-map-layout.ts";

const projectKey = "path:/tmp/project";
const definitions = [
  { id: "alpha", projectKey, label: "Alpha", createdAt: "2026-01-01", updatedAt: "2026-01-01" },
  { id: "beta", projectKey, label: "Beta", createdAt: "2026-01-01", updatedAt: "2026-01-01" },
];
const sessions = [
  { id: "a1", subprojectId: "alpha" },
  { id: "archived-a1", subprojectId: "alpha", archived: true },
  { id: "b1", subprojectId: "beta" },
  { id: "b2", subprojectId: "beta" },
  { id: "u1" },
];
const activities = [
  { session: { id: "a1" }, status: "idle", lastAskedAt: "2026-08-26T10:00:00Z", lastActivityAt: "2026-08-26T10:00:00Z" },
  { session: { id: "b1" }, status: "waiting_user", lastAskedAt: "2026-08-26T09:00:00Z", lastActivityAt: "2026-08-26T09:00:00Z" },
  { session: { id: "b2" }, status: "running", lastAskedAt: "2026-08-26T11:00:00Z", lastActivityAt: "2026-08-26T11:00:00Z" },
  { session: { id: "u1" }, status: "failed", lastAskedAt: "2026-08-26T12:00:00Z", lastActivityAt: "2026-08-26T12:00:00Z" },
];

function build(sort, manualOrder = [], cardHeights) {
  return buildTalkMapSubprojectLayout({
    sessions,
    activities,
    subprojects: definitions,
    projectKey,
    sort,
    manualOrder,
    subprojectSortMode: "custom",
    subprojectOrder: ["beta", "alpha"],
    unclassifiedLabel: "Unclassified",
    cardWidth: 300,
    cardHeight: 170,
    cardHeights,
  });
}

test("hidden subproject sessions stay hidden instead of becoming unclassified", () => {
  const visible = filterTalkMapSessions(sessions, new Set(["beta"]));
  assert.deepEqual(visible.map((session) => session.id), ["a1", "u1"]);
});
test("subproject layout creates left-to-right modules and excludes archived cards", () => {
  const layout = build("status");
  assert.deepEqual(layout.modules.map((module) => module.id), ["beta", "alpha", "__unclassified__"]);
  assert.deepEqual(layout.modules[0].sessionIds, ["b1", "b2"]);
  assert.deepEqual(layout.modules[1].sessionIds, ["a1"]);
  assert.equal(layout.positions["archived-a1"], undefined);
  assert.equal(layout.positions.b1.x, 88);
  assert.equal(layout.modules[0].y, TALK_MAP_SUBPROJECT_VERTICAL_PADDING);
  assert.equal(layout.positions.b1.y, layout.modules[0].y + TALK_MAP_SUBPROJECT_HEADER_HEIGHT + TALK_MAP_SUBPROJECT_CARD_GAP);
  assert.equal(layout.positions.b2.x, 88);
  assert.ok(layout.modules[1].x > layout.modules[0].x + layout.modules[0].width);
  assert.equal(layout.modules[1].y, layout.modules[0].y);
  assert.ok((layout.bounds?.width ?? 0) > (layout.bounds?.height ?? 0));
});

test("subproject layout uses measured card heights inside a fixed frame", () => {
  const layout = build("status", [], { b1: 240, b2: 120 });
  assert.equal(layout.positions.b2.y, layout.positions.b1.y + 240 + TALK_MAP_SUBPROJECT_CARD_GAP);
  assert.equal(layout.modules[0].height, TALK_MAP_SUBPROJECT_FRAME_HEIGHT);
  assert.equal(layout.modules[0].contentHeight, 240 + TALK_MAP_SUBPROJECT_CARD_GAP + 120 + TALK_MAP_SUBPROJECT_CARD_GAP + 16);
});

test("subproject layout accepts the viewport frame height", () => {
  const layout = buildTalkMapSubprojectLayout({
    sessions,
    activities,
    subprojects: definitions,
    projectKey,
    sort: "status",
    manualOrder: [],
    subprojectSortMode: "custom",
    subprojectOrder: ["beta", "alpha"],
    unclassifiedLabel: "Unclassified",
    cardWidth: 300,
    cardHeight: 170,
    frameHeight: 420,
  });
  assert.equal(layout.modules[0].height, 420);
  assert.equal(layout.bounds?.height, 420);
});

test("fixed subproject panels translate client coordinates and drop order", () => {
  assert.equal(talkMapSubprojectContentYForClient(400, 100, 240), 540);
  assert.equal(talkMapSubprojectPointInRect({ left: 10, right: 100, top: 20, bottom: 120 }, 50, 80), true);
  assert.equal(talkMapSubprojectPointInRect({ left: 10, right: 100, top: 20, bottom: 120 }, 101, 80), false);
  assert.equal(talkMapSubprojectDropIndex(["b1", "b2"], 10, 170, { b1: 120, b2: 120 }), 0);
  assert.equal(talkMapSubprojectDropIndex(["b1", "b2"], 100, 170, { b1: 120, b2: 120 }), 1);
  assert.equal(talkMapSubprojectDropIndex(["b1", "b2"], 300, 170, { b1: 120, b2: 120 }), 2);
});

test("layout sorts by question time and preserves manual order", () => {
  const asked = build("asked");
  assert.deepEqual(asked.modules[0].sessionIds, ["b2", "b1"]);
  const manual = build("manual", ["b1", "a1", "b2", "u1"]);
  assert.deepEqual(manual.modules[0].sessionIds, ["b1", "b2"]);
  assert.deepEqual(manual.modules[1].sessionIds, ["a1"]);
});

test("layout accepts resolved session-list order independently of card sort", () => {
  const layout = buildTalkMapSubprojectLayout({
    sessions,
    activities,
    subprojects: definitions,
    projectKey,
    sort: "status",
    manualOrder: [],
    subprojectSortMode: "inherit",
    subprojectDisplayOrder: ["alpha", "beta"],
    unclassifiedLabel: "Unclassified",
    cardWidth: 300,
    cardHeight: 170,
  });
  assert.deepEqual(layout.modules.map((module) => module.id), ["alpha", "beta", "__unclassified__"]);
});

test("subproject layout keeps unclassified sessions sortable without definitions", () => {
  const layout = buildTalkMapSubprojectLayout({
    sessions: [{ id: "first" }, { id: "second" }],
    activities: [],
    subprojects: [],
    projectKey,
    sort: "manual",
    manualOrder: ["second", "first"],
    unclassifiedLabel: "Unclassified",
    cardWidth: 300,
    cardHeight: 170,
  });
  assert.deepEqual(layout.modules.map((module) => module.id), ["__unclassified__"]);
  assert.deepEqual(layout.modules[0].sessionIds, ["second", "first"]);
});

test("manual drop order inserts before target index", () => {
  assert.deepEqual(reorderTalkMapSessionOrder(["a", "b", "c"], ["b", "c"], "a", 1), ["b", "a", "c"]);
  assert.deepEqual(reorderTalkMapSessionOrder(["a", "b"], [], "a", 0), ["b", "a"]);
});
