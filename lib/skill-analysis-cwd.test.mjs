import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const { resolveAnalysisCwd } = await jiti.import("@/lib/skill-analysis-cwd.ts");

test("global analysis accepts only a path already inside an allowed root", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-install-cwd-"));
  try {
    // The reviewer's regression: a caller-supplied cwd outside the allowed
    // roots must never reach settings/resource/model loading.
    const rejected = resolveAnalysisCwd(root, new Set([join(root, "allowed")]));
    assert.equal(rejected.rejected, true);
    assert.equal(rejected.cwd, homedir());

    const accepted = resolveAnalysisCwd(root, new Set([root]));
    assert.equal(accepted.rejected, false);
    assert.equal(accepted.cwd, root);

    const missing = resolveAnalysisCwd(undefined, new Set([root]));
    assert.equal(missing.rejected, false);
    assert.equal(missing.cwd, homedir());

    const empty = resolveAnalysisCwd("", new Set([root]));
    assert.equal(empty.rejected, false);
    assert.equal(empty.cwd, homedir());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
