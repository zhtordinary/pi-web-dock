import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// A tree-matched source fixture runs offline without user configuration or real
// requests. Installed-package compatibility is verified separately on each device.
test("the image package snapshot passes its offline model, protocol and billing regressions", { timeout: 180_000 }, async (t) => {
  const fixture = JSON.parse(await readFile(new URL("../test-fixtures/image-generation-package.json", import.meta.url), "utf8"));
  const bytes = Buffer.from(fixture.bundleBase64, "base64");
  assert.match(fixture.commit, /^[a-f0-9]{40}$/);
  assert.match(fixture.sourceTree, /^[a-f0-9]{40}$/);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), fixture.sha256);
  const root = await mkdtemp(join(tmpdir(), "reader-image-catalog-"));
  const repo = join(root, "source.git"), tree = join(root, "tree"), home = join(root, "home");
  const env = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: join(home, ".pi/agent"), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  delete env.PI_IMAGE_GEN_API_KEY;
  delete env.PI_IMAGE_GEN_LAOZHANG_ACCESS_TOKEN;
  // A nested test process must not inherit the parent's internal reporter protocol.
  delete env.NODE_TEST_CONTEXT;
  const run = (binary, args, cwd = root) => spawnSync(binary, args, { cwd, env, encoding: "utf8", timeout: 150_000, maxBuffer: 8 * 1024 * 1024 });
  let checkedOut = false;
  t.after(async () => {
    if (checkedOut) {
      const removal = run("git", ["--git-dir=" + repo, "worktree", "remove", tree]);
      assert.equal(removal.status, 0, `Preserved package regression worktree at ${tree}: ${removal.stderr}`);
    }
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(home, ".pi/agent/npm"), { recursive: true });
  const project = resolve(fileURLToPath(new URL("..", import.meta.url)));
  await symlink(join(project, "node_modules"), join(home, ".pi/agent/npm/node_modules"), "dir");
  const sharpProbe = run(process.execPath, ["-e", "require.resolve('sharp')"], join(home, ".pi/agent/npm"));
  if (sharpProbe.status !== 0) {
    t.skip(`installed Pi image package dependency sharp is unavailable on ${process.platform}-${process.arch}`);
    await rm(root, { recursive: true, force: true });
    return;
  }
  const bundle = join(root, "source.bundle");
  await writeFile(bundle, bytes);
  let result = run("git", ["clone", "--bare", bundle, repo]);
  assert.equal(result.status, 0, result.stderr);
  result = run("git", ["--git-dir=" + repo, "rev-parse", `${fixture.commit}^{tree}`]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), fixture.sourceTree);
  result = run("git", ["--git-dir=" + repo, "worktree", "add", "--detach", tree, fixture.commit]);
  assert.equal(result.status, 0, result.stderr);
  checkedOut = true;
  result = run(process.execPath, ["--test", "--test-reporter=tap", "--test-concurrency=1", ...[
    "image-gen.test.ts", "tasks.test.ts", "generation-routing.test.ts", "billing.test.ts", "network-proxy.test.ts", "model-catalog.test.ts", "reference-decisions.test.ts",
  ].map((name) => join(tree, "extensions/__tests__", name))], tree);
  assert.equal(result.status, 0, `Package snapshot ${fixture.commit}:\n${result.stdout}\n${result.stderr}`);
  const counts = Object.fromEntries([...result.stdout.matchAll(/^# (tests|pass|fail|cancelled|skipped|todo) (\d+)\r?$/gm)].map(([, name, value]) => [name, Number(value)]));
  assert.ok(counts.tests > 0);
  assert.equal(counts.pass, counts.tests);
  for (const name of ["fail", "cancelled", "skipped", "todo"]) assert.equal(counts[name], 0, name);
  assert.match(result.stdout, /LaoZhang Gemini uses native generation/);
});
