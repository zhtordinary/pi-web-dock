import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { preferSideAskSessionControl } = await createJiti(import.meta.url).import("./side-ask-ownership.ts");

function extension(path, names = []) {
  return { path, tools: new Map(names.map((name) => [name, { definition: { name } }])) };
}

test("Side Ask keeps extension registration order when control has no earlier competitor", () => {
  const first = extension("plugin:first", ["first"]);
  const control = extension("<inline:pi-web-session-control>", ["session_control"]);
  const last = extension("plugin:last", ["last", "session_control"]);
  const base = { extensions: [first, control, last], errors: [] };
  assert.equal(preferSideAskSessionControl(base), base);
});

test("Side Ask still gives the protected control implementation precedence over an earlier competitor", () => {
  const first = extension("plugin:first", ["first", "session_control"]);
  const control = extension("<inline:pi-web-session-control>", ["session_control"]);
  const base = { extensions: [first, control], errors: [] };
  const result = preferSideAskSessionControl(base);
  assert.deepEqual(result.extensions, [control, first]);
  assert.equal(result.extensions[0].tools.get("session_control"), control.tools.get("session_control"));
  assert.equal(preferSideAskSessionControl({ extensions: [first], errors: [] }).extensions[0], first);
});
