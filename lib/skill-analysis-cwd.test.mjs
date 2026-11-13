import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const { resolveAnalysisCwd } = await jiti.import("@/lib/skill-analysis-cwd.ts");

test("global analysis accepts existing directories without a permission list", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-install-cwd-"));
  try {
    const rejected = resolveAnalysisCwd(join(root, "missing"));
    assert.equal(rejected.rejected, true);
    assert.equal(rejected.cwd, homedir());
    assert.equal(resolveAnalysisCwd(`${root}/../${root.split("/").pop()}`).rejected, true);

    const accepted = resolveAnalysisCwd(root);
    assert.equal(accepted.rejected, false);
    assert.equal(accepted.cwd, root);

    const missing = resolveAnalysisCwd(undefined);
    assert.equal(missing.rejected, false);
    assert.equal(missing.cwd, homedir());

    const empty = resolveAnalysisCwd("");
    assert.equal(empty.rejected, false);
    assert.equal(empty.cwd, homedir());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
