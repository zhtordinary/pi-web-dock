import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { testTranslator } from "./test-locale.mjs";

const source = await readFile(new URL("./ModelRoutingConfig.tsx", import.meta.url), "utf8");
const rpcSource = await readFile(new URL("../lib/rpc-manager.ts", import.meta.url), "utf8");
const en = testTranslator("en");

test("ModelRoutingConfig provides one-click manual switch for all non-idle sessions on each route", () => {
  // Contains action button on each route item
  assert.match(source, /handleSwitchNonIdleSessions\(route\)/);
  assert.match(source, /t\("modelRouting\.applyToNonIdle"\)/);
  assert.match(source, /t\("modelRouting\.applyToNonIdleHint"\)/);
  assert.match(source, /t\("modelRouting\.attempts"\)/);
  assert.match(source, /maxAttempts/);
  assert.match(source, /DEFAULT_ROUTE_MAX_ATTEMPTS/);

  // Queries all sessions across devices
  assert.match(source, /fetch\("\/api\/session-runs\?scope=all", \{ cache: "no-store" \}\)/);

  // Filters sessions whose status is NOT idle
  assert.match(source, /filter\(\(s\)\s*=>\s*s\.status\s*&&\s*s\.status\s*!==\s*"idle"\)/);

  // Dispatches set_model and thinkingLevel
  assert.match(source, /sendAgentCommand\(\s*item\.session\.id,\s*\{[\s\S]*?type:\s*"set_model"/);
  assert.match(source, /thinkingLevel:\s*route\.thinkingLevel/);
  assert.match(source, /type:\s*"set_thinking_level",\s*level:\s*route\.thinkingLevel/);

  // Exposes non-idle count in header
  assert.match(source, /t\("modelRouting\.nonIdleCount", \{ count: nonIdleCount \}\)/);
});

test("explains route attempts and exponential retry backoff", () => {
  assert.match(source, /title=\{t\("modelRouting\.attemptsHint"\)\}/);
  assert.match(en("modelRouting.attemptsHint"), /exponential backoff/);
  assert.match(source, /max=\{MAX_ROUTE_MAX_ATTEMPTS\}/);
  assert.match(rpcSource, /getModelRoutingRetryDelayMs/);
  assert.match(rpcSource, /this\.routingCurrentProviderRetries >= maxAttempts/);
});

test("rpc-manager set_model applies optional requestedThinkingLevel", () => {
  const setModelSource = rpcSource.slice(
    rpcSource.indexOf('case "set_model":'),
    rpcSource.indexOf('case "fork":'),
  );
  assert.match(setModelSource, /thinkingLevel:\s*requestedThinkingLevel/);
  assert.match(setModelSource, /const targetThinkingLevel = requestedThinkingLevel \|\| level;/);
  assert.match(setModelSource, /this\.inner\.setThinkingLevel\(targetThinkingLevel\)/);
});


const reorderSource = source.slice(source.indexOf("export function reorderModelRoutes("), source.indexOf("export function ModelRoutingConfig("));
const moveSource = source.slice(source.indexOf("  const handleMoveRoute = useCallback"), source.indexOf("  const isDirty = useCallback"));
const dirtySource = source.slice(source.indexOf("  const isDirty = useCallback"), source.indexOf("  const discard = useCallback"));
const saveSource = source.slice(source.indexOf("  const handleSave = useCallback"), source.indexOf("  useEffect(() => {\n    if (!controllerRef)"));

function routeHarness() {
  const original = [
    { id: "a", provider: "one", model: "model-a", thinkingLevel: "high", maxAttempts: 3 },
    { id: "b", provider: "two", model: "model-b", thinkingLevel: "max", maxAttempts: 4 },
    { id: "c", provider: "three", model: "model-c", thinkingLevel: "low", maxAttempts: 2 },
  ];
  const ctx = {
    useCallback: (fn) => fn, routes: original, original,
    draggedRouteRef: { current: null }, setRouteDropTarget() {},
    savedSnapshotRef: { current: { enabled: true, routes: original } }, enabled: true,
    remotePeer: "debian", loading: false, saving: false,
    ROUTE_DRAG_TYPE: "application/x-reader-model-route",
    setRoutes: (update) => { ctx.routes = typeof update === "function" ? update(ctx.routes) : update; },
  };
  vm.runInNewContext(stripTypeScriptTypes(reorderSource.replace("export ", "") + moveSource + dirtySource
    + "\nglobalThis.move = handleMoveRoute; globalThis.drop = handleRouteDrop; globalThis.dirty = isDirty; globalThis.reorder = reorderModelRoutes;"), ctx);
  return ctx;
}

function routeDropEvent(id, clientY) {
  return {
    clientY, prevented: false,
    preventDefault() { this.prevented = true; },
    dataTransfer: { getData: (type) => type === "application/x-reader-model-route" ? id : "" },
    currentTarget: { getBoundingClientRect: () => ({ top: 100, height: 80 }) },
  };
}

test("route drops insert before or after their target and preserve the complete route payload", () => {
  const ctx = routeHarness();
  const { original } = ctx;
  ctx.draggedRouteRef.current = { id: "a", peer: "debian" };
  const event = routeDropEvent("a", 179);
  ctx.drop(event, "c");
  assert.equal(event.prevented, true);
  assert.deepEqual(Array.from(ctx.routes, (route) => route.id), ["b", "c", "a"]);
  assert.equal(ctx.routes[2], original[0]);
  assert.equal(ctx.routes[2].maxAttempts, 3);
  assert.equal(ctx.dirty(), true);
  assert.deepEqual(original.map((route) => route.id), ["a", "b", "c"]);
  ctx.draggedRouteRef.current = { id: "c", peer: "debian" };
  ctx.drop(routeDropEvent("c", 100), "b");
  assert.deepEqual(Array.from(ctx.routes, (route) => route.id), ["c", "b", "a"]);
});

test("route drag rejects outside payloads, stale peers, saving and missing routes", () => {
  for (const scenario of ["outside", "stale-peer", "saving", "deleted"]) {
    const ctx = routeHarness();
    ctx.draggedRouteRef.current = { id: scenario === "deleted" ? "removed" : "a", peer: scenario === "stale-peer" ? "mini" : "debian" };
    if (scenario === "saving") ctx.saving = true;
    ctx.drop(routeDropEvent(scenario === "outside" ? "other" : ctx.draggedRouteRef.current.id, 179), "c");
    assert.equal(ctx.routes, ctx.original, scenario);
    assert.equal(ctx.draggedRouteRef.current, null);
    assert.equal(ctx.dirty(), false);
  }
  const ctx = routeHarness();
  assert.equal(ctx.reorder(ctx.original, "a", "missing", true), ctx.original);
  assert.equal(ctx.reorder(ctx.original, "b", "b", false), ctx.original);
  assert.equal(ctx.reorder(ctx.original, "a", "b", true), ctx.original);
});

test("route arrows and dragging share the same order with bounded movement", () => {
  const ctx = routeHarness();
  ctx.move(0, -1);
  ctx.move(2, 1);
  assert.equal(ctx.routes, ctx.original);
  ctx.move(0, 1);
  assert.deepEqual(Array.from(ctx.routes, (route) => route.id), ["b", "a", "c"]);
  ctx.move(2, -1);
  assert.deepEqual(Array.from(ctx.routes, (route) => route.id), ["b", "c", "a"]);
});

test("the existing save request persists dragged order and all preset fields", async () => {
  const ctx = routeHarness();
  ctx.draggedRouteRef.current = { id: "c", peer: "debian" };
  ctx.drop(routeDropEvent("c", 100), "a");
  let saved;
  Object.assign(ctx, {
    setSaving() {}, setSaveError() {}, setSavedOk() {}, setTimeout() {}, onSaved: undefined,
    normalizeRouteMaxAttempts: (value) => value,
    apiFor: (peer, path) => `/api/remote/${path}?peer=${peer}`,
    fetch: async (path, request) => {
      saved = { path, request };
      return { ok: true, json: async () => ({ success: true }) };
    },
  });
  vm.runInNewContext(stripTypeScriptTypes(saveSource + "\nglobalThis.save = handleSave;"), ctx);
  assert.equal(await ctx.save(), true);
  assert.equal(saved.path, "/api/remote/model-routing?peer=debian");
  assert.equal(saved.request.method, "PUT");
  const payload = JSON.parse(saved.request.body);
  assert.deepEqual(payload.routes, [ctx.original[2], ctx.original[0], ctx.original[1]]);
  assert.equal(payload.enabled, true);
  assert.equal(ctx.dirty(), false);
});
