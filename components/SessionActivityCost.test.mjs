import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";
import * as details from "../lib/session-details-client.ts";
import { sessionCacheHitRate, sessionCostPresentation } from "../lib/session-cost.ts";

const detailsSource = await readFile(new URL("../hooks/useSessionDetails.ts", import.meta.url), "utf8");
const detailsHook = detailsSource.slice(detailsSource.indexOf("export function useSessionDetails")).replace("export function", "function");

for (const file of ["SessionActivityMeta.tsx", "SessionActivityPanel.tsx"]) {
  const source = await readFile(new URL(file, import.meta.url), "utf8");
  const start = source.indexOf("function useLazySessionCost(");
  const hook = source.slice(start, source.indexOf("\nfunction MetaSeparator", start));
  test(`${file}: cost follows current intersection, not list refresh or past visibility`, async () => {
    details.clearSessionDetailsCache();
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      const summary = { amount: 1, status: "partial", pendingUsageCount: 1, missingPriceModels: [] };
      return { ok: true, json: async () => ({ ...summary, totalCost: summary,
        extensionCosts: [{ ...summary, id: "pi-prompt-suggester" }] }) };
    };
    let cursor = 0;
    const slots = [];
    let effects = [];
    let observer;
    const context = {
      ...details,
      sessionCacheHitRate,
      sessionCostPresentation,
      useState(initial) {
        const index = cursor++;
        slots[index] ??= { value: initial };
        return [slots[index].value, (value) => { slots[index].value = value; }];
      },
      useRef() {
        const index = cursor++;
        slots[index] ??= { current: {} };
        return slots[index];
      },
      useMemo(fn) { return fn(); },
      useSyncExternalStore(_subscribe, read) { return read(); },
      useEffect(fn, deps) {
        const index = cursor++;
        if (slots[index] && deps.every((dep, i) => Object.is(dep, slots[index].deps[i]))) return;
        effects.push(() => {
          slots[index]?.cleanup?.();
          slots[index] = { deps, cleanup: fn() };
        });
      },
      IntersectionObserver: class {
        connected = false;
        // eslint-disable-next-line @typescript-eslint/no-this-alias -- the test captures the observer the component constructs
        constructor(callback) { this.callback = callback; observer = this; }
        observe() { this.connected = true; }
        disconnect() { this.connected = false; }
        intersect(value) { if (this.connected) this.callback([{ isIntersecting: value }]); }
      },
    };
    vm.runInNewContext(stripTypeScriptTypes(`${detailsHook}\n${hook}\nglobalThis.renderCost = useLazySessionCost;`), context);
    const rootRef = { current: {} };
    let version = "v1";
    async function render() {
      cursor = 0;
      effects = [];
      const projection = context.renderCost("session-1", version, undefined, rootRef);
      for (const effect of effects) effect();
      await new Promise((resolve) => setImmediate(resolve));
      return projection;
    }
    try {
      await render();
      assert.equal(calls.length, 0, "offscreen mount does not request");
      observer.intersect(true);
      await render();
      assert.equal(calls.length, 1);
      const projection = await render(); // cache notification / ordinary list refresh
      assert.equal(calls.length, 1);
      assert.equal(projection.cost, 1);
      assert.equal(projection.costStatus, "calculated");
      assert.equal(projection.pendingUsageCount, 0);
      assert.equal(projection.recordedOnly, true);
      observer.intersect(false);
      await render();
      version = "v2";
      await render();
      assert.equal(calls.length, 1, "offscreen version changes must not request");
      observer.intersect(true);
      await render();
      assert.equal(calls.length, 2, "re-enter loads the latest version once");
      await render();
      assert.equal(calls.length, 2);
      assert.ok(calls.every((url) => url === "/api/sessions/session-1/cost?view=summary"));
      observer.intersect(false);
      await render();
      details.invalidateSessionDetails({ sessionId: "session-1", version });
      await render();
      assert.equal(calls.length, 2, "explicit model/config invalidation stays lazy offscreen");
      observer.intersect(true);
      await render();
      assert.equal(calls.length, 3, "explicit invalidation also clears summary cost");
    } finally {
      for (const slot of slots) slot?.cleanup?.();
      globalThis.fetch = originalFetch;
      details.clearSessionDetailsCache();
    }
  });
}
