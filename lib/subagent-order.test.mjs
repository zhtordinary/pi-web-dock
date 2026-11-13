import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { moveSubagentProfile, orderSubagentProfiles, subagentProfileKey } = await createJiti(import.meta.url).import("./subagent-order.ts");

const profile = (scope, name, displayName = name) => ({ scope, name, displayName });

test("orders known profiles first and keeps newly discovered profiles in source order", () => {
  const profiles = [profile("global", "z"), profile("global", "a"), profile("builtin", "plan"), profile("global", "new")];
  assert.deepEqual(
    orderSubagentProfiles(profiles, ["global:a", "builtin:plan"])
      .map((item) => subagentProfileKey(item)),
    ["global:a", "builtin:plan", "global:z", "global:new"],
  );
});

test("moves a profile before or after a target without changing profile objects", () => {
  const profiles = [profile("global", "a"), profile("global", "b"), profile("global", "c")];
  const moved = moveSubagentProfile(profiles, "global:a", "global:c", true);
  assert.deepEqual(moved.map((item) => item.name), ["b", "c", "a"]);
  assert.equal(moved[2], profiles[0]);
  assert.deepEqual(moveSubagentProfile(profiles, "global:a", "global:b", false).map((item) => item.name), ["a", "b", "c"]);
  assert.equal(moveSubagentProfile(profiles, "global:a", "global:missing", true), null);
});
