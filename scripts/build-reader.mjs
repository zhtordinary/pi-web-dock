import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
// Next evaluates config in multiple processes. Seed once before spawning Next
// so BUILD_ID, browser env and server env all inherit the same immutable ID.
const result = spawnSync(process.execPath, [require.resolve("next/dist/bin/next"), "build", "--webpack", ...process.argv.slice(2)], {
  stdio: "inherit", env: { ...process.env, PI_WEB_READER_BUILD_ID: randomUUID() },
});
if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
else if (result.status !== 0) process.exitCode = result.status ?? 1;
else {
  const verify = spawnSync(process.execPath, [fileURLToPath(new URL("./verify-reader-build-identity.mjs", import.meta.url))], { stdio: "inherit" });
  if (verify.error) throw verify.error;
  process.exitCode = verify.status ?? 1;
}
