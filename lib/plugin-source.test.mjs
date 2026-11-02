import assert from "node:assert/strict";
import test from "node:test";
import { extensionDisplayName, pluginNameFromSource, pluginSourceKind } from "./plugin-source.ts";

test("classifies plugin sources and keeps display names compact", () => {
  assert.equal(pluginSourceKind("npm:@scope/example@1.2.3"), "npm");
  assert.equal(pluginSourceKind("git:https://github.com/user/example@abc123"), "git");
  assert.equal(pluginSourceKind("~/.pi/agent/packages/example"), "local");
  assert.equal(pluginNameFromSource("npm:@scope/example@1.2.3"), "example");
  assert.equal(pluginNameFromSource("git:https://github.com/user/example.git#abc123"), "example");
  assert.equal(pluginNameFromSource("~/.pi/agent/packages/example"), "example");
  assert.equal(extensionDisplayName("/home/test/extensions/execution-supervisor/index.ts", {
    source: "local",
    origin: "top-level",
    baseDir: "/home/test/extensions",
  }), "execution-supervisor");
  assert.equal(extensionDisplayName("/home/test/.pi/agent/extensions/execution-supervisor/index.ts", {
    source: "local",
    origin: "top-level",
    baseDir: "/home/test/.pi/agent",
  }), "execution-supervisor");
  assert.equal(extensionDisplayName("/home/test/extensions/tokentracker-notify.ts", {
    source: "local",
    origin: "top-level",
    baseDir: "/home/test/extensions",
  }), "tokentracker-notify");
  assert.equal(extensionDisplayName("/home/test/pkg/index.ts", {
    source: "npm:@scope/example@1.2.3",
    origin: "package",
  }), "example");
});
