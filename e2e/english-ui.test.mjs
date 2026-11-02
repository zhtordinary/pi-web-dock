import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("desktop and mobile browser checks use the English interface", { timeout: 300_000 }, () => {
  const result = spawnSync(process.execPath, [join(root, "e2e/run.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      E2E_SERVER_MODE: "dev",
      E2E_ONLY_I18N: "1",
      PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(userInfo().homedir,
        process.platform === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright"),
    },
    stdio: "inherit",
    timeout: 290_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `browser check exited with ${result.signal ?? result.status}`);
});
