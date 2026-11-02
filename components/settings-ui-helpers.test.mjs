import assert from "node:assert/strict";
import test from "node:test";
import { projectTrustReloadKey } from "./settings-ui-helpers.ts";

test("the page's trust status reloads a settings panel only when its decision changes", () => {
  const untrusted = { requiresTrust: true, trusted: false, decision: null, inherited: false };
  const trusted = { requiresTrust: true, trusted: true, decision: true, decisionPath: "/repo", inherited: false };
  assert.equal(projectTrustReloadKey(null), "");
  assert.equal(projectTrustReloadKey(undefined), "");
  // A new object with the same decision (the dialog re-reading an unchanged folder) keeps the key.
  assert.equal(projectTrustReloadKey(untrusted), projectTrustReloadKey({ ...untrusted }));
  assert.equal(projectTrustReloadKey(trusted), projectTrustReloadKey({ ...trusted, decisionError: "ignored" }));
  const keys = new Set([
    untrusted,
    trusted,
    { ...trusted, inherited: true, decisionPath: "/" },
    { ...untrusted, decision: false, decisionPath: "/repo" },
    { requiresTrust: false, trusted: true, decision: null, inherited: false },
  ].map(projectTrustReloadKey));
  assert.equal(keys.size, 5);
  assert.ok(![...keys].includes(""));
});
