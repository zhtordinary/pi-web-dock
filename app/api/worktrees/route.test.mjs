import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createJiti } from "jiti";

const execFileAsync = promisify(execFile);
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { GET, POST, PATCH, DELETE } = await jiti.import("./route.ts");
const { allowFileRoot } = await jiti.import("@/lib/file-access");

async function git(cwd, args) {
  await execFileAsync("git", ["-C", cwd, ...args]);
}

test("GET /api/worktrees supports basic, graph, and inspect queries", async (t) => {
  const tempRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-web-wt-route-")));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const repo = path.join(tempRoot, "repo");
  const linked = path.join(tempRoot, "linked");
  await execFileAsync("git", ["init", "-b", "main", repo]);
  await git(repo, ["config", "user.name", "Route Test"]);
  await git(repo, ["config", "user.email", "route-test@example.invalid"]);
  await git(repo, ["config", "commit.gpgsign", "false"]);
  await writeFile(path.join(repo, "README.md"), "# main\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial commit on main"]);
  await git(repo, ["worktree", "add", "-b", "feature/branch", linked]);
  await writeFile(path.join(linked, "feature.txt"), "hello worktree\n");
  await git(linked, ["add", "feature.txt"]);
  await git(linked, ["commit", "-m", "feature commit 1"]);
  // Keep a tracked unstaged entry first in porcelain output. This guards the
  // leading-space status columns and the first-character path redaction bug.
  await writeFile(path.join(linked, "feature.txt"), "changed after commit\n");

  // Keep several representative sensitive filenames in the synthetic fixture;
  // the inspect API must redact them without hiding an ordinary note.
  for (const file of [".env", "credentials.json", "id_rsa", "authorized_keys", "server.pem", ".npmrc", "config.env", "credentials-prod.json", "notes.txt"]) {
    await writeFile(path.join(linked, file), "synthetic fixture only\n");
  }
  await mkdir(path.join(linked, "secrets"));
  await writeFile(path.join(linked, "secrets", "secret.txt"), "synthetic fixture only\n");

  // Allow tempRoot so security gate passes
  allowFileRoot(tempRoot);
  allowFileRoot(repo);
  allowFileRoot(linked);

  // 1. Basic query without graph=1
  const req1 = new Request(`http://localhost/api/worktrees?cwd=${encodeURIComponent(repo)}`);
  const res1 = await GET(req1);
  assert.equal(res1.status, 200);
  const data1 = await res1.json();
  assert.equal(data1.isGit, true);
  assert.equal(data1.isTopLevel, true);
  assert.equal(data1.worktrees.length, 2);
  assert.equal(data1.graph, undefined);

  // 2. Query with graph=1
  const req2 = new Request(`http://localhost/api/worktrees?cwd=${encodeURIComponent(repo)}&graph=1&refresh=1`);
  const res2 = await GET(req2);
  assert.equal(res2.status, 200);
  const data2 = await res2.json();
  assert.ok(data2.graph);
  assert.equal(data2.graph.totalWorktrees, 2);
  assert.equal(data2.graph.targetBranch, "main");
  assert.equal(data2.graph.counts.main, 1);
  assert.equal(data2.graph.counts.active, 1);
  assert.equal(data2.graph.counts.wip, 1);
  assert.equal(data2.graph.deltaBasis, "topology-fork-base-first-parent");
  assert.ok(data2.graph.nodes.length >= 1);

  const activeWt = data2.graph.worktrees.find((w) => w.path === linked);
  assert.ok(activeWt);
  assert.equal(activeWt.status, "active");
  assert.equal(activeWt.ahead, 1);
  assert.equal(activeWt.branch, "feature/branch");
  assert.equal(activeWt.dirtySummary?.dirtyCount, 11);
  assert.equal(activeWt.dirtySummary?.unstagedCount, 1);
  assert.equal(activeWt.dirtySummary?.untrackedCount, 10);

  // Keep inspection read-only and do not surface sensitive-looking filenames.

  // 3. Inspect query for linked worktree
  const req3 = new Request(`http://localhost/api/worktrees?cwd=${encodeURIComponent(repo)}&inspect=${encodeURIComponent(linked)}`);
  const res3 = await GET(req3);
  assert.equal(res3.status, 200);
  const data3 = await res3.json();
  assert.ok(data3.inspection);
  assert.equal(data3.inspection.path, linked);
  assert.equal(data3.inspection.dirtyCount, 11);
  assert.equal(data3.inspection.commitMode, "since-base");
  assert.deepEqual(data3.inspection.commits.map((commit) => commit.subject), ["feature commit 1"]);
  const dirtyPaths = data3.inspection.dirtyFiles.map((file) => file.path);
  assert.equal(dirtyPaths.filter((file) => file === "[sensitive path omitted]").length, 9);
  assert.ok(dirtyPaths.includes("notes.txt"));
  assert.ok(dirtyPaths.includes("feature.txt"));
  assert.equal(dirtyPaths.some((file) => /\.env|credentials(?:-prod)?\.json|id_rsa|authorized_keys|server\.pem|\.npmrc|secrets\//.test(file)), false);

  const reqMain = new Request(`http://localhost/api/worktrees?cwd=${encodeURIComponent(repo)}&inspect=${encodeURIComponent(repo)}`);
  const resMain = await GET(reqMain);
  assert.equal(resMain.status, 200);
  const dataMain = await resMain.json();
  assert.equal(dataMain.inspection.commitMode, "head-history");
  assert.deepEqual(dataMain.inspection.commits.map((commit) => commit.subject), ["initial commit on main"]);

  // A path outside the registered worktree set must never be passed to git.
  const outside = path.join(tempRoot, "outside");
  const req4 = new Request(`http://localhost/api/worktrees?cwd=${encodeURIComponent(repo)}&inspect=${encodeURIComponent(outside)}`);
  const res4 = await GET(req4);
  assert.equal(res4.status, 400);
});

function jsonRequest(method, body) {
  return new Request("http://localhost/api/worktrees", { method, headers: { Host: "localhost", "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

test("POST, PATCH and DELETE /api/worktrees manage plain Git worktrees and keep their branches", async (t) => {
  const tempRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-web-wt-mutate-")));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const repo = path.join(tempRoot, "repo");
  await execFileAsync("git", ["init", "-b", "main", repo]);
  await git(repo, ["config", "user.name", "Route Test"]);
  await git(repo, ["config", "user.email", "route-test@example.invalid"]);
  await git(repo, ["config", "commit.gpgsign", "false"]);
  await writeFile(path.join(repo, "README.md"), "# main\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial commit on main"]);
  allowFileRoot(tempRoot);
  allowFileRoot(repo);

  const unconfigured = await POST(jsonRequest("POST", { cwd: repo, branch: "not-created" }));
  assert.equal(unconfigured.status, 400);
  assert.match((await unconfigured.json()).error, /Add \/.worktrees\/ to the project root .gitignore/);
  await writeFile(path.join(repo, ".gitignore"), "/.worktrees/\n");
  await git(repo, ["add", ".gitignore"]);
  await git(repo, ["commit", "-m", "ignore task checkouts"]);

  const created = await POST(jsonRequest("POST", { cwd: repo, branch: "侧边提问" }));
  assert.equal(created.status, 200);
  const worktree = await created.json();
  assert.equal(worktree.branch, "侧边提问");
  assert.equal(worktree.path, path.join(repo, ".worktrees", "侧边提问"));

  const renamed = await PATCH(jsonRequest("PATCH", { cwd: repo, path: worktree.path, branch: "side-ask" }));
  assert.equal(renamed.status, 200);
  assert.deepEqual(await renamed.json(), { path: worktree.path, branch: "side-ask" });
  const listed = await (await GET(new Request(`http://localhost/api/worktrees?cwd=${encodeURIComponent(repo)}`))).json();
  assert.deepEqual(listed.worktrees.find((row) => row.path === worktree.path), { path: worktree.path, branch: "side-ask", isMain: false });

  const mainRename = await PATCH(jsonRequest("PATCH", { cwd: repo, path: repo, branch: "trunk" }));
  assert.equal(mainRename.status, 400);

  await writeFile(path.join(worktree.path, "draft.txt"), "uncommitted\n");
  const refused = await DELETE(jsonRequest("DELETE", { cwd: repo, path: worktree.path }));
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).dirty, true);
  const forced = await DELETE(jsonRequest("DELETE", { cwd: repo, path: worktree.path, force: true }));
  assert.equal(forced.status, 200);
  const after = await (await GET(new Request(`http://localhost/api/worktrees?cwd=${encodeURIComponent(repo)}`))).json();
  assert.equal(after.worktrees.length, 1);
  const { stdout } = await execFileAsync("git", ["-C", repo, "branch", "--list", "side-ask"]);
  assert.match(stdout, /side-ask/);
});

test("worktree mutations require a JSON request for an allowed directory", async () => {
  const plain = new Request("http://localhost/api/worktrees", { method: "POST", headers: { Host: "localhost" }, body: "{}" });
  assert.equal((await POST(plain)).status, 415);
  assert.equal((await DELETE(jsonRequest("DELETE", { path: "/tmp/x" }))).status, 400);
  assert.equal((await PATCH(jsonRequest("PATCH", { cwd: "/definitely/not/allowed", path: "/x", branch: "y" }))).status, 403);
});
