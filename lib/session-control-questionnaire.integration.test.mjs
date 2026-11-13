import assert from "node:assert/strict";
import { realpathSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { currentPiPackage } from "../test-support/current-pi-package.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

test("original questionnaire integrates with Reader in an isolated network namespace", {
  skip: process.platform !== "linux" ? "requires the Linux network-isolated test sandbox" : false,
}, (t) => {
  const sandbox = "/usr/bin/bwrap";
  const binary = statSync(sandbox);
  assert.ok(binary.isFile() && binary.uid === 0 && (binary.mode & 0o022) === 0, "bubblewrap must be a system-owned executable");
  assert.equal(realpathSync(join(root, "node_modules")), join(realpathSync(root), "node_modules"), "dependencies must belong to the test checkout");
  const current = currentPiPackage("@juicesharp/rpiv-ask-user-question");
  const state = spawnSync("/usr/bin/git", ["-C", root, "status", "--porcelain=v1", "--ignored", "--untracked-files=all", "--", "lib", "bin", "packages/pi-web-session-control"], {
    encoding: "utf8", timeout: 15_000, env: { HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0" },
  });
  assert.equal(state.status, 0, "cannot verify isolated source directories");
  assert.ok(!state.stdout.split("\n").some((line) => line.startsWith("?? ") || line.startsWith("!! ")), "isolated source directories contain untracked or ignored files");
  const result = spawnSync(sandbox, [
    "--unshare-all", "--die-with-parent", "--clearenv",
    "--dir", "/usr", "--ro-bind", "/usr/lib", "/usr/lib",
    "--ro-bind-try", "/lib", "/lib", "--ro-bind-try", "/lib64", "/lib64",
    "--ro-bind", realpathSync(process.execPath), "/node", "--dir", "/work",
    "--ro-bind", join(root, "lib"), "/work/lib", "--ro-bind", join(root, "bin"), "/work/bin",
    "--ro-bind", join(root, "node_modules"), "/work/node_modules", "--dir", "/pi-runtime",
    "--ro-bind", current.nodeModules, "/pi-runtime/node_modules", "--dir", "/work/packages",
    "--ro-bind", join(root, "packages/pi-web-session-control"), "/work/packages/pi-web-session-control",
    "--ro-bind", join(root, "package.json"), "/work/package.json", "--ro-bind", join(root, "tsconfig.json"), "/work/tsconfig.json",
    "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp",
    "--chdir", "/work", "--setenv", "HOME", "/tmp", "--setenv", "TMPDIR", "/tmp",
    "--setenv", "READER_QUESTIONNAIRE_SANDBOXED", "1",
    "--setenv", "READER_QUESTIONNAIRE_VERSION", current.version,
    "--setenv", "READER_HOST_NETNS", String(statSync("/proc/self/ns/net").ino),
    "--", "/node", "--experimental-strip-types", "--test", "/work/lib/session-control-questionnaire.integration-worker.mjs",
  ], { encoding: "utf8", timeout: 90_000, maxBuffer: 1_000_000, env: {} });
  assert.equal(result.error?.code, undefined, "the isolated questionnaire worker could not start or timed out");
  const output = `${result.stdout}\n${result.stderr}`;
  const errors = [...new Set(output.match(/\b(?:ERR_[A-Z_]+|AssertionError|TypeError|SyntaxError|ReferenceError)\b/g) ?? [])];
  const cases = ["single-select exact Type something.", "cancelling custom input", "multi-select native input", "cancelling the next select"]
    .filter((name) => output.includes(`✖ ${name}`) || new RegExp(`not ok \\d+ - ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(output));
  assert.equal(result.status, 0, `isolated questionnaire worker failed (exit ${result.status ?? "unknown"}); error categories: ${errors.join(", ") || "unknown"}; cases: ${cases.join(", ") || "unknown"}`);
  const passed = /^(?:#|ℹ) pass (\d+)$/m.exec(result.stdout);
  assert.ok(passed && Number(passed[1]) >= 9, "the original questionnaire cases must actually execute");
  assert.match(result.stdout, /^(?:#|ℹ) skipped 0$/m);
  const source = /Original package @juicesharp\/rpiv-ask-user-question@([^;\s]+); rpc-fallback\.ts sha256=([a-f0-9]{64}); ask-user-question\.ts sha256=([a-f0-9]{64})/.exec(result.stdout);
  const tree = /Original package source tree unchanged: sha256=([a-f0-9]{64})/.exec(result.stdout);
  assert.ok(source && tree, "the original package identity and unchanged source tree must be verified");
  assert.equal(source[1], current.version, "the sandbox must execute the current installed package");
  assert.deepEqual(currentPiPackage(current.name), current, "the package must remain current throughout the test");
  t.diagnostic(`Original package ${current.version}: ${passed[1]} cases; rpc=${source[2]}; tool=${source[3]}; unchanged tree=${tree[1]}`);
});
