import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const { createDefaultCwdDirectory, defaultCwdPath, localDateStamp } =
  await createJiti(import.meta.url).import("./default-cwd.ts");

test("stamps the local calendar date, not the UTC one", () => {
  // 00:30 local time on Jan 2 — still Jan 1 in UTC for any zone east of UTC.
  const justAfterMidnight = new Date(2026, 0, 2, 0, 30);
  assert.equal(localDateStamp(justAfterMidnight), "20260102");
  // 23:30 local time on Dec 31 — already Jan 1 in UTC for any zone west of UTC.
  assert.equal(localDateStamp(new Date(2025, 11, 31, 23, 30)), "20251231");
});

test("places the dated folder under ~/pi-cwd", () => {
  const home = path.join(os.tmpdir(), "pi-web-home");
  assert.equal(
    defaultCwdPath(new Date(2026, 8, 29, 7), home),
    path.join(home, "pi-cwd", "20260929"),
  );
});


test("creates a regular daily directory and reuses it without changing existing data", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-default-cwd-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const today = new Date(2026, 9, 8);
  const dir = createDefaultCwdDirectory(today, home);
  fs.writeFileSync(path.join(dir, "keep.txt"), "preserved");
  assert.equal(createDefaultCwdDirectory(today, home), dir);
  assert.equal(fs.readFileSync(path.join(dir, "keep.txt"), "utf8"), "preserved");
});

for (const level of ["parent", "daily"]) {
  test(`refuses a ${level} symlink without creating a directory at its target`, (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-default-link-"));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const outside = path.join(home, "outside");
    fs.mkdirSync(outside);
    const parent = path.join(home, "pi-cwd");
    const today = new Date(2026, 9, 8);
    if (level === "daily") fs.mkdirSync(parent);
    fs.symlinkSync(outside, level === "parent" ? parent : defaultCwdPath(today, home), process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => createDefaultCwdDirectory(today, home), /regular directory/);
    assert.deepEqual(fs.readdirSync(outside), []);
  });
}
