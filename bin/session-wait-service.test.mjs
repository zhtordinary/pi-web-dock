import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
const entry = new URL("./session-wait-service.cjs", import.meta.url).pathname;
test("service entry renders a bound lifecycle plan without invoking a manager", () => {
  const root = mkdtempSync(join(tmpdir(), "session-service-entry-")); const oldHome = process.env.HOME; process.env.HOME = join(root, "home"); try {
    const dry = spawnSync(process.execPath, [entry, "--dry-run", "--platform=linux", "--state-root", join(root, "space root"), "--health-file", join(root, "health.json")], { encoding: "utf8" });
    assert.equal(dry.status, 0, dry.stderr); const payload = JSON.parse(dry.stdout); assert.equal(payload.template.kind, "systemd-user"); assert.deepEqual(payload.managerCalls, []); assert.deepEqual(payload.managerPlan.slice(0, 3), ["systemctl", "--user", "enable"]); assert.match(payload.template.content, /--health-file/);
    const apply = spawnSync(process.execPath, [entry, "--apply", "--platform=darwin", "--state-root", root], { encoding: "utf8" }); assert.equal(apply.status, 0, apply.stderr); const applied = JSON.parse(apply.stdout); assert.equal(applied.managerCalls.length, 0); assert.ok(applied.managerPlan.includes("launchctl")); assert.match(readFileSync(applied.lifecycle, "utf8"), /--execute-manager/);
  } finally { if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; rmSync(root, { recursive: true, force: true }); }
});
