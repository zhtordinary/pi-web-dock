import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const { preferSideAskSessionControl, sideAskChildReference } = await createJiti(import.meta.url).import("./side-ask-ownership.ts");

test("Side Ask child references stay inside the native session root", () => {
  const root = resolve(getAgentDir(), "sessions");
  const child = resolve(root, "fixture", "child.jsonl");
  assert.deepEqual(sideAskChildReference("child-id", child, "source-path"), {
    version: 1, sessionId: "child-id", childPath: join("fixture", "child.jsonl"), parentSessionPath: "source-path",
  });
  for (const [id, path] of [["", child], ["child-id", root], ["child-id", resolve(root, "..", "outside.jsonl")], ["child-id", `${root}-sibling/child.jsonl`]]) {
    assert.throws(() => sideAskChildReference(id, path, "source-path"), /outside the native session root/);
  }
});

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
