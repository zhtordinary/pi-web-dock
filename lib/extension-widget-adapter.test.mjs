import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

async function loadSubject() {
  return jiti.import("./extension-widget-adapter.ts");
}

function createAdapter(Adapter) {
  const changes = [];
  const errors = [];
  const adapter = new Adapter(
    {},
    (key, widget) => changes.push({ key, widget }),
    (key, error) => errors.push({ key, error }),
  );
  return { adapter, changes, errors };
}

test("keeps array widgets compatible with the RPC path", async () => {
  const { ExtensionWidgetAdapter } = await loadSubject();
  const { adapter, changes, errors } = createAdapter(ExtensionWidgetAdapter);

  adapter.setWidget("plan", ["one", "two"], { placement: "belowEditor" });

  assert.deepEqual(adapter.getWidgets(), [{
    key: "plan",
    lines: ["one", "two"],
    placement: "belowEditor",
  }]);
  assert.equal(errors.length, 0);
  assert.equal(changes.at(-1).widget.lines.length, 2);
});

test("renders factory widgets and re-renders on the headless TUI callback", async () => {
  const { ExtensionWidgetAdapter } = await loadSubject();
  const { adapter, changes, errors } = createAdapter(ExtensionWidgetAdapter);
  let requestRender;
  let renderCount = 0;
  let disposeCount = 0;

  adapter.setWidget("todo", (tui) => {
    requestRender = tui.requestRender;
    return {
      render: (width) => [`${width}:${++renderCount}`],
      dispose: () => { disposeCount += 1; },
    };
  });

  assert.equal(errors.length, 0);
  assert.deepEqual(adapter.getWidgets()[0].lines, ["92:1"]);
  requestRender();
  assert.deepEqual(adapter.getWidgets()[0].lines, ["92:2"]);
  assert.equal(changes.filter((change) => change.widget).length, 2);

  adapter.setWidget("todo", undefined);
  assert.deepEqual(adapter.getWidgets(), []);
  assert.equal(disposeCount, 1);
});

test("clears invalid factory output and reports the adapter error", async () => {
  const { ExtensionWidgetAdapter } = await loadSubject();
  const { adapter, errors } = createAdapter(ExtensionWidgetAdapter);

  adapter.setWidget("broken", () => ({ render: () => ["ok", 42] }));

  assert.deepEqual(adapter.getWidgets(), []);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].key, "broken");
});
