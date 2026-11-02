import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const github = await jiti.import("./git-github.ts");
const { getGitHead, getGitRemoteUrls } = await jiti.import("./git-changes.ts");

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

test("parses only github.com remotes and never exposes credentials", () => {
  assert.deepEqual(github.parseGitHubRemote({ name: "origin", url: "https://token:secret@github.com/agegr/pi-web.git" }), {
    owner: "agegr",
    repo: "pi-web",
    remoteName: "origin",
  });
  assert.deepEqual(github.parseGitHubRemote({ name: "upstream", url: "git@github.com:owner/repo.git" }), {
    owner: "owner",
    repo: "repo",
    remoteName: "upstream",
  });
  assert.equal(github.parseGitHubRemote({ name: "origin", url: "https://gitlab.com/owner/repo.git" }), null);
  assert.equal(github.parseGitHubRemote({ name: "origin", url: "https://github.com/owner/repo.git?token=secret" }), null);
});

test("prefers origin over upstream and reads remotes with Git only", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-web-github-"));
  try {
    git(cwd, ["init", "-q"]);
    git(cwd, ["remote", "add", "upstream", "git@github.com:upstream/repo.git"]);
    git(cwd, ["remote", "add", "origin", "https://github.com/owner/repo.git"]);
    const remotes = await getGitRemoteUrls(cwd);
    assert.deepEqual(github.selectGitHubRepository(remotes), { owner: "owner", repo: "repo", remoteName: "origin" });
    assert.equal(await getGitHead(cwd), null);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("fetches bounded read-only PR, issue, and checks data with server auth", async () => {
  const repository = { owner: "owner", repo: "repo", remoteName: "origin" };
  const urls = [];
  const snapshot = await github.fetchGitHubReadOnlySnapshot(repository, "main", "deadbeef", "secret-token", async (url, init) => {
    urls.push(url);
    assert.equal(init.headers.Authorization, "Bearer secret-token");
    if (url.endsWith("/owner/repo/")) return jsonResponse({ full_name: "owner/repo", default_branch: "main" });
    if (url.includes("/pulls?")) return jsonResponse([{ number: 1, title: "Fix UI", user: { login: "ada" }, draft: true, base: { ref: "main" }, head: { ref: "feature" }, updated_at: "2026-09-01T00:00:00Z", html_url: "https://github.com/owner/repo/pull/1" }]);
    if (url.includes("/issues?")) return jsonResponse([
      { number: 2, title: "Bug", user: { login: "lin" }, updated_at: "2026-09-01T00:00:00Z", html_url: "https://github.com/owner/repo/issues/2" },
      { number: 3, title: "PR duplicate", pull_request: {}, user: { login: "skip" } },
    ]);
    assert.match(url, /commits\/main\/check-runs/);
    return jsonResponse({ check_runs: [{ name: "CI", status: "completed", conclusion: "success", html_url: "https://github.com/owner/repo/actions/runs/1" }] });
  });
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.defaultBranch, "main");
  assert.equal(snapshot.pullRequests[0].draft, true);
  assert.deepEqual(snapshot.issues.map((item) => item.number), [2]);
  assert.equal(snapshot.checks[0].conclusion, "success");
  assert.equal(snapshot.warnings.length, 0);
  assert.equal(urls.length, 4);
});

test("creates a pull request only through the server fetcher", async () => {
  const repository = { owner: "owner", repo: "repo", remoteName: "origin" };
  let seen;
  const result = await github.createGitHubPullRequest(repository, {
    title: "Improve explorer",
    body: "Details",
    head: "feature/explorer",
    base: "main",
  }, "secret-token", async (url, init) => {
    seen = { url, init };
    return jsonResponse({ number: 42, html_url: "https://github.com/owner/repo/pull/42" });
  });
  assert.equal(result.number, 42);
  assert.equal(seen.init.method, "POST");
  assert.equal(seen.init.headers.Authorization, "Bearer secret-token");
  assert.deepEqual(JSON.parse(seen.init.body), { title: "Improve explorer", body: "Details", head: "feature/explorer", base: "main" });
});

test("keeps partial GitHub panels available when one endpoint fails", async () => {
  const repository = { owner: "owner", repo: "repo", remoteName: "origin" };
  const snapshot = await github.fetchGitHubReadOnlySnapshot(repository, null, "deadbeef", "secret-token", async (url) => {
    if (url.endsWith("/owner/repo/")) return jsonResponse({ default_branch: "main" });
    if (url.includes("/pulls?")) return jsonResponse([], 500);
    return jsonResponse({ check_runs: [] });
  });
  assert.equal(snapshot.available, true);
  assert.deepEqual(snapshot.warnings, ["pullRequests"]);
  assert.deepEqual(snapshot.issues, []);
  assert.deepEqual(snapshot.checks, []);
});
